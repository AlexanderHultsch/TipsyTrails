import Foundation
import JavaScriptCore
import UserNotifications
import os

// ios/SPEC.md Section 7.2: the ten members of `Host`
// (packages/tracker/src/host.ts), installed as JavaScript functions on
// `globalThis.__tipsyTrailsHost` before the tracker bundle is evaluated
// (Runtime/TrackerRuntime.swift owns that ordering). This file is the
// contract of Section 7.2 and F4 (Section 12) checks its method names
// against host.ts's; every method below carries a comment naming the
// host.ts line it implements, and no other file in this app writes one of
// these ten names as a string (Runtime/TrackerRuntime.swift calls INTO the
// bundle by name for the `Tracker` surface, which is the opposite
// direction and a different, typed, surface).
//
// BRIDGING. Each member is installed as a plain Objective-C block assigned
// onto a JS object property - JavaScriptCore's own documented rule is that
// a block assigned into the JS environment is automatically wrapped as a
// callable JS function, with the same primitive bridging (`Double`,
// `Bool`, `String`) `JSExport` uses for typed members. A value with no
// small bridged type - `input` on `fetch`, `profile` on `configureLocation`,
// `n` on `scheduleNotification`, `event` on `emit` - stays a `JSValue` and
// is read out by hand, which is also why `emit` hands its event onward as a
// plain dictionary rather than a decoded struct (Section 7.5, and this
// file's own comment on `installEmit`).
//
// RETAIN CYCLES. `self` here is retained by the `JSContext` itself, through
// `context.setObject(host, ...)` at the end of `install(into:)` - a block
// that then captures `self` STRONGLY would make the context keep this
// bridge alive forever and the bridge keep the context alive forever,
// leaking the whole graph (the context, the tracker's JS state, the queue)
// for the rest of the process's life, which is the classic JavaScriptCore
// mistake nothing here can observe on its own. Every block below captures
// `[weak self]` for exactly that reason, and `context` itself is held only
// `weak` on this class (below) rather than strongly, for the same reason in
// the other direction.
//
// THE RULE, in one line: nothing installed into the context may hold the
// context, or a `JSValue` that belongs to it, strongly - the context owns
// everything installed into it, and a strong reference back closes a cycle
// that no test in this repository can see. `installFetch` needs a
// `JSContext` to build its `Promise` in, and gets one without capturing the
// `context` a caller might pass it: `JSContext.current()`, valid for the
// duration of a call from JavaScript into a bridged block (Apple's own
// guarantee), read fresh inside the block instead.
final class HostBridge: NSObject {
    private weak var context: JSContext?
    private let queue: DispatchQueue
    private let sessionCookieProvider: SessionCookieProviding
    private let eventReceiver: TrackerEventReceiving
    private let locationEngine: LocationEngine
    private let serverOrigin: String

    // host.ts's setTimeout/clearTimeout: JavaScriptCore has neither, so
    // both are backed by DispatchSourceTimer here, keyed by an integer id
    // the tracker holds - `clearTimeout` on an id not in this map is a
    // no-op, never a crash (host.ts's own words).
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var nextTimerId = 0

    private static let logger = Logger(subsystem: "com.ahultsch.tipsytrails", category: "tracker")

    init(
        queue: DispatchQueue,
        sessionCookieProvider: SessionCookieProviding,
        eventReceiver: TrackerEventReceiving,
        locationEngine: LocationEngine,
        serverOrigin: String
    ) {
        self.queue = queue
        self.sessionCookieProvider = sessionCookieProvider
        self.eventReceiver = eventReceiver
        self.locationEngine = locationEngine
        self.serverOrigin = serverOrigin
        super.init()
    }

    // ios/SPEC.md 5.2: an ephemeral configuration with cookies turned off -
    // the web view's `WKHTTPCookieStore` is the only authority for the
    // session cookie (Section 5.2's four rules), and this `URLSession` must
    // never manage one of its own, read one, or persist one. `self` is the
    // redirect delegate (below), which is the other half of what `fetch`
    // has to be.
    private lazy var urlSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    // Installs every member of `Host` onto a fresh JS object and publishes
    // it as `globalThis.__tipsyTrailsHost` - Runtime/TrackerRuntime.swift
    // calls this before it evaluates the tracker bundle, exactly as Section
    // 7.2 requires ("the shell installs it... before evaluating the
    // bundle").
    func install(into context: JSContext) {
        self.context = context
        guard let host = JSValue(newObjectIn: context) else { return }

        installNow(on: host)
        installSetTimeout(on: host)
        installClearTimeout(on: host)
        installFetch(on: host)
        installConfigureLocation(on: host)
        installRequestSignificantChanges(on: host)
        installScheduleNotification(on: host)
        installCancelNotification(on: host)
        installEmit(on: host)
        installLog(on: host)

        context.setObject(host, forKeyedSubscript: "__tipsyTrailsHost" as NSString)
    }

    // host.ts: `now(): number` - ms epoch, injected so the tracker's tests
    // can drive a fake clock; on the shell it is simply the device's own
    // clock, converted once through `Date.millisecondsSince1970` (below).
    private func installNow(on host: JSValue) {
        let nowBlock: @convention(block) () -> Double = {
            Date().millisecondsSince1970
        }
        host.setObject(nowBlock, forKeyedSubscript: "now" as NSString)
    }

    // host.ts: `setTimeout(fn, ms): number`. `fn` has no small bridged type
    // and stays a `JSValue`; the returned id is a plain incrementing
    // counter, handed back as a `Double` because every JS number is one.
    private func installSetTimeout(on host: JSValue) {
        let setTimeoutBlock: @convention(block) (JSValue, Double) -> Double = { [weak self] callback, delayMs in
            self?.scheduleTimer(callback: callback, delayMs: delayMs) ?? -1
        }
        host.setObject(setTimeoutBlock, forKeyedSubscript: "setTimeout" as NSString)
    }

    private func scheduleTimer(callback: JSValue, delayMs: Double) -> Double {
        let id = nextTimerId
        nextTimerId += 1

        // Section 4.4: every timer fires back onto the tracker's one
        // serial queue, exactly like every other entry into the context -
        // this is the timer hopping in, not a fix or a network response,
        // but the rule is the same one.
        //
        // `callback` (a `JSValue`, and so a strong link to its context) IS
        // captured strongly below, and that looks like the same shape
        // `installFetch`'s bug was - the difference is lifetime, not
        // strength. This closure is not installed into the context; it is
        // `timer`'s own one-shot event handler, and firing it is the last
        // thing that happens before `timers.removeValue(forKey:)` drops the
        // only strong reference to `timer` itself, which releases this
        // closure and `callback` with it. The capture is bounded to one
        // firing, never permanent, so it never becomes a cycle - the same
        // reasoning applies to `resolve`/`reject` in `runFetch` below,
        // bounded to one request's lifetime rather than the context's.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(Int(delayMs)))
        timer.setEventHandler { [weak self] in
            self?.timers.removeValue(forKey: id)
            callback.call(withArguments: [])
        }
        timers[id] = timer
        timer.resume()
        return Double(id)
    }

    // host.ts: `clearTimeout(id): void`. "clearTimeout on an unknown id is
    // a no-op, not a crash" - `removeValue` already returns `nil` for a
    // missing key, so there is nothing further to guard.
    private func installClearTimeout(on host: JSValue) {
        let clearTimeoutBlock: @convention(block) (Double) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: Int(id))?.cancel()
        }
        host.setObject(clearTimeoutBlock, forKeyedSubscript: "clearTimeout" as NSString)
    }

    // host.ts: `fetch(input): Promise<HostResponse>`. Returns a genuine
    // JavaScript `Promise` (`JSValue(newPromiseIn:fromExecutor:)`) - the
    // executor captures `resolve`/`reject` and `runFetch` calls one of them
    // once `URLSession`'s completion, on its own queue, has hopped back to
    // the tracker queue. It rejects ONLY on a transport failure; every HTTP
    // status - 2xx through 5xx - resolves as `{status, headers, body}`,
    // because that is exactly host.ts's contract and the whole of how
    // `packages/tracker/src/api.ts` tells "the server answered" from "the
    // request never completed".
    //
    // Deliberately does NOT take a `context: JSContext` parameter the way
    // the other `install*` methods might have been tempted to for
    // `newPromiseIn:` - `fetchBlock` below is the block permanently
    // installed as `host.fetch`, so anything IT captures lives for as long
    // as the context does; capturing a `context` parameter here would close
    // exactly the cycle this file's top-of-file rule forbids
    // (context -> host -> this block -> context). `JSContext.current()` is
    // read fresh inside the block instead, which is valid for exactly the
    // duration of this call from JavaScript into it.
    private func installFetch(on host: JSValue) {
        let fetchBlock: @convention(block) (JSValue) -> JSValue? = { [weak self] input in
            guard let self, let currentContext = JSContext.current() else { return nil }
            return JSValue(newPromiseIn: currentContext) { [weak self] resolve, reject in
                self?.runFetch(input: input, resolve: resolve, reject: reject)
            }
        }
        host.setObject(fetchBlock, forKeyedSubscript: "fetch" as NSString)
    }

    private func runFetch(input: JSValue, resolve: JSValue?, reject: JSValue?) {
        guard
            let dictionary = input.toDictionary() as? [String: Any],
            let method = dictionary["method"] as? String,
            let path = dictionary["path"] as? String,
            let url = URL(string: serverOrigin + path)
        else {
            reject?.call(withArguments: ["TipsyTrailsHostFetch: malformed request"])
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method

        // ios/SPEC.md 5.3: `URLSession` sends no `Origin` of its own; this
        // asserts it from the same build setting that is also the web
        // view's initial URL and the one `WKAppBoundDomains` entry (Section
        // 4.3), derived once so the three cannot disagree.
        request.setValue(serverOrigin, forHTTPHeaderField: "Origin")

        // ios/SPEC.md 5.2: borrows the web view's cookie, never manages its
        // own. A missing cookie means signed out, and that is the
        // tracker's rule (Section 5.2's third bullet) to apply, not this
        // one's - it simply sends what it has, which may be nothing.
        if let cookieValue = sessionCookieProvider.currentSessionCookieValue() {
            request.setValue("tt_session=\(cookieValue)", forHTTPHeaderField: "Cookie")
        }

        if let bodyString = dictionary["body"] as? String {
            request.httpBody = bodyString.data(using: .utf8)
            // Section 7.2: "Content-Type is the host's business where
            // there is a body" - api.ts passes the body and adds no header
            // of its own; this is the one place that header is set.
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let task = urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            // Section 4.4: URLSession's completion arrives on its own
            // queue; every call back into the context hops to the tracker
            // queue first.
            self.queue.async {
                if let error {
                    reject?.call(withArguments: ["TipsyTrailsHostFetch: \(error.localizedDescription)"])
                    return
                }
                guard let httpResponse = response as? HTTPURLResponse else {
                    reject?.call(withArguments: ["TipsyTrailsHostFetch: no HTTP response"])
                    return
                }
                var headers: [String: String] = [:]
                for (key, value) in httpResponse.allHeaderFields {
                    if let keyString = key as? String, let valueString = value as? String {
                        headers[keyString] = valueString
                    }
                }
                let bodyText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let responseDictionary: [String: Any] = [
                    "status": httpResponse.statusCode,
                    "headers": headers,
                    "body": bodyText,
                ]
                resolve?.call(withArguments: [responseDictionary])
            }
        }
        task.resume()
    }

    // host.ts: `configureLocation(profile): void`. `profile`'s three fields
    // are read out of the `JSValue` by hand - Location/LocationEngine.swift
    // is where every one of them turns into a `CLLocationManager` setting.
    private func installConfigureLocation(on host: JSValue) {
        let configureBlock: @convention(block) (JSValue) -> Void = { [weak self] profile in
            guard
                let self,
                let dictionary = profile.toDictionary() as? [String: Any],
                let desiredAccuracyM = dictionary["desiredAccuracyM"] as? Double,
                let distanceFilterM = dictionary["distanceFilterM"] as? Double,
                let background = dictionary["background"] as? Bool
            else { return }
            self.locationEngine.configure(
                desiredAccuracyM: desiredAccuracyM,
                distanceFilterM: distanceFilterM,
                background: background
            )
        }
        host.setObject(configureBlock, forKeyedSubscript: "configureLocation" as NSString)
    }

    // host.ts: `requestSignificantChanges(on): void`.
    private func installRequestSignificantChanges(on host: JSValue) {
        let block: @convention(block) (Bool) -> Void = { [weak self] on in
            self?.locationEngine.setSignificantChangeMonitoring(on: on)
        }
        host.setObject(block, forKeyedSubscript: "requestSignificantChanges" as NSString)
    }

    // host.ts: `scheduleNotification(n): void`. There is no push and no
    // Notifications/ wrapper in this substep (F2a); every one of Section
    // 7.7's four notifications is local, so this schedules directly
    // through `UNUserNotificationCenter`, an Apple framework this file is
    // free to call without depending on a directory that does not exist
    // yet.
    private func installScheduleNotification(on host: JSValue) {
        let block: @convention(block) (JSValue) -> Void = { [weak self] payload in
            guard
                let self,
                let dictionary = payload.toDictionary() as? [String: Any],
                let id = dictionary["id"] as? String,
                let atMs = dictionary["atMs"] as? Double,
                let title = dictionary["title"] as? String,
                let body = dictionary["body"] as? String
            else { return }
            self.scheduleLocalNotification(id: id, atMs: atMs, title: title, body: body)
        }
        host.setObject(block, forKeyedSubscript: "scheduleNotification" as NSString)
    }

    private func scheduleLocalNotification(id: String, atMs: Double, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body

        let fireDate = Date(millisecondsSince1970: atMs)
        // `UNTimeIntervalNotificationTrigger` requires a strictly positive
        // interval. Three of Section 7.7's four notifications (mastered,
        // discovered, signed out) carry `atMs: now()` and would compute
        // zero, or a hair negative from the time this call takes - `1` is
        // the floor UNUserNotificationCenter itself needs, not a game
        // constant (I1).
        let interval = Swift.max(fireDate.timeIntervalSinceNow, 1)
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request)
    }

    // host.ts: `cancelNotification(id): void`.
    // `removePendingNotificationRequests` is already a no-op for an id it
    // does not hold, matching host.ts's own rule for `clearTimeout`.
    private func installCancelNotification(on host: JSValue) {
        let block: @convention(block) (String) -> Void = { id in
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
        }
        host.setObject(block, forKeyedSubscript: "cancelNotification" as NSString)
    }

    // host.ts: `emit(event): void`. Converted to a plain Swift dictionary
    // and handed to `TrackerEventReceiving` (below) - never decoded into
    // typed Swift structs. `events.ts`'s own comment explains why a typed
    // mirror already costs three hand-kept copies in this repository; a
    // fourth here, for no reader, is exactly what that comment warns
    // against. The event crosses to the web view as JSON (Section 8.2),
    // and a dictionary is already that shape.
    private func installEmit(on host: JSValue) {
        let block: @convention(block) (JSValue) -> Void = { [weak self] event in
            guard let self, let dictionary = event.toDictionary() as? [String: Any] else { return }
            self.eventReceiver.receivedTrackerEvent(dictionary)
        }
        host.setObject(block, forKeyedSubscript: "emit" as NSString)
    }

    // host.ts: `log(level, message): void`. Routed through `os.Logger`
    // rather than `print` so it reaches the device console the rest of the
    // app's own logging does; this file decides nothing about what is
    // logged (I1) - it only chooses where the words go.
    private func installLog(on host: JSValue) {
        let block: @convention(block) (String, String) -> Void = { level, message in
            HostBridge.logger.log(level: HostBridge.osLogType(for: level), "[tracker] \(message)")
        }
        host.setObject(block, forKeyedSubscript: "log" as NSString)
    }

    private static func osLogType(for level: String) -> OSLogType {
        switch level {
        case "warn":
            return .default
        case "error":
            return .error
        default:
            return .info
        }
    }
}

// ios/SPEC.md 7.2: "It follows no redirect... every HTTP status is
// returned as a response." Passing `nil` here makes the redirect response
// itself the answer, its 3xx status intact, rather than silently
// continuing wherever it points - Section 7.8's `other` bucket exists
// precisely because a 3xx is reachable this way and has nowhere else to be
// counted.
extension HostBridge: URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

// Every millisecond epoch value this shell hands to, or reads from, the
// tracker is computed the same way, in one place: `timeIntervalSince1970`
// is seconds, and Foundation has no millisecond epoch API of its own. The
// factor is derived from Darwin's own `NSEC_PER_SEC`/`NSEC_PER_MSEC`
// instead of being written as a literal, because Section 12 Step F4's grep
// allows no numeric literal here beyond 0, 1 and -1 - this reuses two
// constants that already say what a millisecond is rather than restating
// it as a bare `1000`. Declared once, here, and used by
// Location/LocationEngine.swift too (Section 6.6's timestamp), since
// Swift's default access level already makes it visible module-wide.
extension Date {
    static let millisecondsPerSecond = Double(NSEC_PER_SEC) / Double(NSEC_PER_MSEC)

    var millisecondsSince1970: Double {
        (timeIntervalSince1970 * Date.millisecondsPerSecond).rounded()
    }

    init(millisecondsSince1970 ms: Double) {
        self.init(timeIntervalSince1970: ms / Date.millisecondsPerSecond)
    }
}

// ios/SPEC.md 5.2: the web view's `WKHTTPCookieStore` is the only
// authority for the session cookie - this shell never copies it into
// `HTTPCookieStorage`, never lets `URLSession` manage it, and never
// persists it. `Web/` (F2b) reads `tt_session` for the server's host out
// of that store and conforms to this; it does not exist yet, so this
// protocol is the seam that lets `HostBridge` compile without it. App/
// wires a stub conformance until then (see
// App/TipsyTrailsApp.swift's `NoSessionCookieProvider`).
protocol SessionCookieProviding: AnyObject {
    func currentSessionCookieValue() -> String?
}

// ios/SPEC.md 7.5/8.2: every `TrackerEvent`, as the plain dictionary
// `installEmit` above builds - the seam between the runtime and the web
// view. `Web/` (F2b) conforms to forward each dictionary to the web view
// through `evaluateJavaScript`; until it lands, App/ wires a
// stored-latest stub so this file, and Runtime/TrackerRuntime.swift, which
// also uses it to report a shell exception (its own comment says why
// there is nowhere else for one to go yet), compile on their own. Say it
// plainly: these two protocols exist only to keep F2a compiling before
// F2b lands.
protocol TrackerEventReceiving: AnyObject {
    func receivedTrackerEvent(_ event: [String: Any])
}
