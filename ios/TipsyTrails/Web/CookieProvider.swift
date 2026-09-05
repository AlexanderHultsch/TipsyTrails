import Foundation
import WebKit

// ios/SPEC.md Section 5.2: the real `SessionCookieProviding` conformance,
// replacing App/'s `NoSessionCookieProvider` stub. The web view's
// `WKHTTPCookieStore` is the only authority for `tt_session` - this class
// does not copy the cookie anywhere else, and Runtime/HostBridge.swift's own
// `URLSession` is already configured (its own comment) never to manage one
// of its own.
final class CookieProvider: NSObject {
    private let cookieStore: WKHTTPCookieStore
    private let serverHost: String

    // `WKHTTPCookieStore.getAllCookies` is asynchronous and
    // `SessionCookieProviding.currentSessionCookieValue()` has to answer
    // synchronously - Runtime/HostBridge.swift's `runFetch` calls it inline
    // while building a request, on the tracker's own serial queue (Section
    // 4.4), never idle waiting on a callback. So this file holds the last
    // observed value and keeps it current through the observer below,
    // rather than asking the store fresh on every read.
    //
    // The store's completion handlers and `cookiesDidChange` both arrive on
    // the main thread (WebKit's own documented behaviour for
    // `WKHTTPCookieStore`), while `currentSessionCookieValue()` is read from
    // the tracker's serial queue - two different threads touching the same
    // property, so access to it is guarded by a lock rather than assumed
    // thread-confined the way most of this app's state can be.
    private let lock = NSLock()
    private var latestValue: String?

    init(cookieStore: WKHTTPCookieStore, serverHost: String) {
        self.cookieStore = cookieStore
        self.serverHost = serverHost
        super.init()
        cookieStore.add(self)
        refresh()
    }

    deinit {
        cookieStore.remove(self)
    }

    // Section 5.2's second rule: "The shell observes the store with a
    // WKHTTPCookieStoreObserver and re-reads the cookie on every change, so
    // a refreshed value, a logout, or an account deletion is seen within the
    // same run loop turn." Called once from `init` too, to seed the first
    // value before any change has fired.
    private func refresh() {
        cookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            let sessionCookie = cookies.first { cookie in
                cookie.name == "tt_session" && self.matchesServerHost(cookie.domain)
            }
            self.lock.lock()
            self.latestValue = sessionCookie?.value
            self.lock.unlock()
        }
    }

    // A cookie's `domain` is sometimes the bare host and sometimes that
    // host prefixed with a leading dot (RFC 6265's own "Domain-Match"); both
    // forms name the same host, so both are accepted here rather than only
    // the exact string `serverHost`.
    private func matchesServerHost(_ domain: String) -> Bool {
        domain == serverHost || domain == ".\(serverHost)"
    }
}

extension CookieProvider: WKHTTPCookieStoreObserver {
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        refresh()
    }
}

// Section 5.2's third and fourth rules: "A missing cookie means signed out"
// and "nothing is persisted anywhere else." Returning `nil` for a cookie
// this class has not yet observed, or has observed to be gone, is exactly
// that first rule - Runtime/HostBridge.swift's `runFetch` already treats a
// `nil` here as "send the request with no Cookie header," and
// `packages/tracker`'s own host contract turns the server's resulting 401
// into `sessionLost` (Section 5.2's third bullet).
//
// The value returned here can be one change stale in the worst case - a
// refresh already in flight when a second change lands - and that is
// accepted rather than fought with more synchronization: Section 5.2's own
// fourth rule is what catches it ("A 401 from any tracker request is the
// same event... There is no retry loop on a 401"), which is exactly why the
// tracker treats a 401 as authoritative instead of retrying - a design this
// file's own staleness would otherwise be a reason to distrust.
extension CookieProvider: SessionCookieProviding {
    func currentSessionCookieValue() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return latestValue
    }
}
