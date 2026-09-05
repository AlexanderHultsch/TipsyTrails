import CryptoKit
import Foundation
import UIKit
import WebKit
import os

// ios/SPEC.md Section 8.5: the `WKWebView`, created once and kept for the
// process's life - App/ constructs exactly one of these and never a second
// (Section 8.5's own words: "Navigating away from the map does not destroy
// it, and the tracker does not care whether it exists"). This file is the
// whole of Web/'s Swift surface for this substep (F2b): the view's
// configuration (8.5), both directions of the bridge (8.2), and the seven
// message types of 8.2's table. Section 11's screens (F3) present this
// view; nothing here decides when.
final class WebViewController: NSObject {
    let webView: WKWebView
    let serverOrigin: URL

    weak var delegate: WebBridgeDelegate?

    private static let messageHandlerName = "tipsyTrails"
    private static let logger = Logger(subsystem: "com.ahultsch.tipsytrails", category: "webBridge")

    init(delegate: WebBridgeDelegate? = nil) {
        self.delegate = delegate
        self.serverOrigin = Self.readServerOrigin()

        let configuration = WKWebViewConfiguration()

        // Section 8.5: "App-Bound Domains... the configuration sets
        // limitsNavigationsToAppBoundDomains = true." This is what makes
        // Service Workers available inside WKWebView - packages/web's one
        // service worker registers here exactly as it does in Safari - and
        // it confines the web view to the one origin (project.yml's
        // WKAppBoundDomains, Section 4.3) it should ever load.
        configuration.limitsNavigationsToAppBoundDomains = true

        // Section 8.5/5.2: "Cookies are the default persistent store, so
        // the session survives an app restart exactly as in Safari."
        // Nothing here sets `configuration.websiteDataStore` to anything
        // else - the default already is `WKWebsiteDataStore.default()`,
        // the persistent one, and Section 5.2's four cookie rules depend on
        // this exact store being the one both this view and
        // Web/CookieProvider.swift read.
        let userContentController = configuration.userContentController
        userContentController.addUserScript(
            WKUserScript(
                source: Self.userScriptSource(
                    shellVersion: Self.shellVersion(),
                    trackerVersion: Self.trackerVersion()
                ),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self

        // Runtime/HostBridge.swift's own top-of-file rule, restated for a
        // different framework: `WKUserContentController.add(_:name:)`
        // retains its handler strongly, and this class is already retained
        // by `webView` through `navigationDelegate`/`uiDelegate` (both of
        // which WebKit itself declares `weak`, so that half is not the
        // problem) - a message handler added as `self` directly would
        // still close a cycle through `userContentController`, which the
        // configuration and therefore `webView` also keeps alive.
        // `WeakScriptMessageHandlerProxy` below holds this instance only
        // `weak`, so the strong link `userContentController` keeps is to
        // the proxy, never back to this class; `deinit` below removes the
        // handler too, as the belt to this proxy's suspenders.
        userContentController.add(
            WeakScriptMessageHandlerProxy(target: self),
            name: Self.messageHandlerName
        )

        // Section 8.5: "scrollView.bounces = false and
        // contentInsetAdjustmentBehavior = .never: the map screen is
        // `position: fixed` and pads its own safe areas, and a bouncing web
        // view under a map that is meant to be dragged is a map that
        // lurches."
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
    }

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.messageHandlerName)
    }

    // Section 4.3: "the web view's initial URL" - the only URL this view
    // ever loads directly, derived from the same build setting the one
    // `WKAppBoundDomains` entry and every native request's `Origin` (Section
    // 5.3) also come from, so the three cannot disagree. Screens/ (F3)
    // calls this once the Primer has run its course (Section 11.1); this
    // substep only defines it.
    func loadServerOrigin() {
        webView.load(URLRequest(url: serverOrigin))
    }

    private static func readServerOrigin() -> URL {
        guard
            let originString = Bundle.main.object(forInfoDictionaryKey: "TTServerOrigin") as? String,
            let url = URL(string: originString)
        else {
            // project.yml's Info.plist always sets TTServerOrigin (Section
            // 4.3), and F1's own test parses it - this branch exists so a
            // malformed bundle fails by loading nothing rather than by
            // crashing.
            return URL(string: "about:blank") ?? URL(fileURLWithPath: "/")
        }
        return url
    }

    // Section 8.1: "shellVersion... from the bundle" - the app's own
    // `CFBundleShortVersionString`.
    private static func shellVersion() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    }

    // Section 8.1: "trackerVersion... from the bundle." `packages/tracker`
    // publishes no version string of its own (`index.ts` exposes only
    // `config`), so the tracker bundle's own SHA-256 digest is the only
    // per-build identifier this substep has for it - and Section 7.8's
    // diagnostic report needs the same identifier for the same reason (a
    // build that changes the bundle's bytes is what both places want to
    // see change). Diagnostics/DiagnosticsStore.swift computes this same
    // digest again independently rather than sharing this function: both
    // read the same `tracker.js` and SHA-256 is deterministic, so the two
    // cannot disagree without one of them being broken outright, which is a
    // far larger problem than the duplication.
    private static func trackerVersion() -> String {
        guard
            let url = Bundle.main.url(forResource: "tracker", withExtension: "js"),
            let data = try? Data(contentsOf: url)
        else { return "unknown" }
        return SHA256.hash(data: data).description
    }

    // Section 8.1/8.2: the injected object, as a Swift string constant.
    // `dispatch(json)` is the one call the shell makes into it (below);
    // `addListener` is this substep's own name for "listener registration"
    // (8.2 names the behaviour, not the call) and is also where the
    // latest-payload cache of 8.2 lives, keyed by the four replayable event
    // types 8.2 names: `tracking`, `position`, `queue`, `flush`.
    //
    // Section 8.3's counter rule is why a replayed payload cannot look like
    // a live one: "a replayed payload seeds the replaced-on-every-post
    // members and never advances a counter." A late-registering listener's
    // catch-up call is therefore marked with a second argument, `true`,
    // that a live `dispatch` call never passes - `packages/web`'s Step D
    // (built on `main`, not this branch) is what reads that flag to decide
    // whether a `flush` may advance `revealVersion`/`discoveryVersion`/
    // `newBarsVersion`/`visitVersion` or must not.
    private static func userScriptSource(shellVersion: String, trackerVersion: String) -> String {
        """
        (function () {
          var listeners = [];
          var latest = {};
          var replayable = { tracking: true, position: true, queue: true, flush: true };

          function notify(listener, event, isReplay) {
            listener(event, !!isReplay);
          }

          function dispatch(json) {
            var event;
            try {
              event = JSON.parse(json);
            } catch (parseError) {
              return;
            }
            if (replayable[event.type]) {
              latest[event.type] = event;
            }
            listeners.forEach(function (listener) {
              notify(listener, event, false);
            });
          }

          function addListener(listener) {
            listeners.push(listener);
            Object.keys(latest).forEach(function (type) {
              notify(listener, latest[type], true);
            });
          }

          window.__tipsyTrails = {
            platform: 'ios',
            shellVersion: '\(shellVersion)',
            trackerVersion: '\(trackerVersion)',
            dispatch: dispatch,
            addListener: addListener
          };
        })();
        """
    }

    // Section 8.2: "The shell calls window.__tipsyTrails.dispatch(json)
    // through evaluateJavaScript for every tracker event." `event` here is
    // exactly the dictionary Runtime/HostBridge.swift's `installEmit`
    // built - forwarded verbatim, never decoded into a typed Swift struct
    // (that file's own comment explains why a fourth hand-kept mirror is
    // not worth building). Marking a payload as a replay is the injected
    // script's own job (above, `addListener`'s catch-up call) - every call
    // this method makes is a live one.
    func dispatch(_ event: [String: Any]) {
        guard
            let payloadData = try? JSONSerialization.data(withJSONObject: event),
            let payloadText = String(data: payloadData, encoding: .utf8),
            let literal = Self.jsStringLiteral(for: payloadText)
        else { return }
        // Section 4.4: "the main queue for the web view" - every call out
        // of the tracker context is handed back to whichever queue its
        // consumer needs, and `evaluateJavaScript` needs the main queue.
        // `receivedTrackerEvent` (App/'s `BridgedEventReceiver`) calls this
        // from the tracker's own serial queue, so the hop happens here and
        // not at the caller.
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(
                "window.__tipsyTrails && window.__tipsyTrails.dispatch(\(literal));"
            )
        }
    }

    // A JSON string, valid JS string-literal syntax, safe to splice
    // straight into a `evaluateJavaScript` call - JSON string escaping is a
    // subset of JS string escaping, so serialising `[text]` and stripping
    // the surrounding `[`/`]` that `JSONSerialization` adds is a correct
    // escaper without this file writing one by hand.
    private static func jsStringLiteral(for text: String) -> String? {
        guard
            let data = try? JSONSerialization.data(withJSONObject: [text]),
            let arrayLiteral = String(data: data, encoding: .utf8)
        else { return nil }
        return String(arrayLiteral.dropFirst().dropLast())
    }

    // Section 8.5: "Links that leave the origin cannot be followed in the
    // web view, and there are three: 'Report a bug on GitHub' (SPEC.md
    // 8.4), the two outbound links on /privacy (SPEC.md 10.3), and the OSM
    // attribution (SPEC.md 10.5)." Used by both delegates below, and by the
    // `openExternal` message.
    private func openExternally(_ url: URL) {
        UIApplication.shared.open(url)
    }
}

extension WebViewController: WKNavigationDelegate {
    // Section 8.5: "The shell's WKNavigationDelegate cancels any navigation
    // whose host is not app-bound and opens the URL in Safari." A
    // navigation with no host (about:blank, a data: URL) is allowed rather
    // than judged, since it cannot be the server's and cannot be one of the
    // three outbound links either.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url, let host = url.host else {
            decisionHandler(.allow)
            return
        }
        if host == serverOrigin.host {
            decisionHandler(.allow)
        } else {
            openExternally(url)
            decisionHandler(.cancel)
        }
    }
}

extension WebViewController: WKUIDelegate {
    // Section 8.5: "WKUIDelegate's createWebViewWith does the same for
    // target="_blank" and returns nil" - WebKit calls this instead of
    // `decidePolicyFor:navigationAction:` for a new-window request, and
    // returning `nil` is what tells it not to open one.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }
}

extension WebViewController: WKScriptMessageHandler {
    // Section 8.2's table, exactly the seven rows: `visitStarted` and
    // `visitEnded` share one row there and share one case here, dispatching
    // internally on `type`. Section 8.2's own words license the default
    // case: "the page is loaded over the network and may be newer than the
    // shell" - an unknown `type` is logged and ignored, never a crash.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            message.name == Self.messageHandlerName,
            let body = message.body as? [String: Any],
            let type = body["type"] as? String
        else { return }

        switch type {
        case "ready":
            delegate?.webBridgeReady()
        case "signedIn":
            delegate?.webBridgeSignedIn()
        case "signedOut":
            delegate?.webBridgeSignedOut()
        case "visitStarted", "visitEnded":
            handleVisitMessage(type: type, body: body)
        case "openExternal":
            handleOpenExternal(body: body)
        case "requestNotifications":
            delegate?.webBridgeRequestedNotifications()
        case "openConsent":
            delegate?.webBridgeRequestedConsent()
        default:
            Self.logger.info("unknown web bridge message type, ignored: \(type, privacy: .public)")
        }
    }

    // Section 7.6/8.2: `visitStarted` carries a full `VisitSummary` (the
    // dwelling profile needs every field to seed the tracker's pending
    // set); `visitEnded` carries only an id, exactly as `events.ts`'s own
    // comment says of the tracker's side of this same message: "an id is
    // all the tracker is given." Neither wire shape is fixed anywhere else
    // yet - `packages/web`'s Step D, built on `main` and not this branch,
    // is what actually sends these messages - so this is this substep's own
    // reading of Section 7.5's `VisitSummary` restated as JSON, flagged for
    // that session to match rather than silently assumed compatible.
    private func handleVisitMessage(type: String, body: [String: Any]) {
        if type == "visitStarted" {
            guard
                let visitDictionary = body["visit"] as? [String: Any],
                let visit = VisitSummary(bridgeDictionary: visitDictionary)
            else { return }
            delegate?.webBridgeVisitStarted(visit)
        } else {
            guard let visitId = body["id"] as? Int else { return }
            delegate?.webBridgeVisitEnded(visitId)
        }
    }

    // Section 8.2: "openExternal | a link leaves the app (8.5) | opens it
    // in Safari." Resolved right here rather than forwarded to
    // `WebBridgeDelegate`: opening a URL in Safari is exactly the
    // capability the navigation and UI delegates above already need in
    // this same file, and forwarding it to App/ would only have App/ call
    // straight back into a method this file already owns.
    private func handleOpenExternal(body: [String: Any]) {
        guard let urlString = body["url"] as? String, let url = URL(string: urlString) else { return }
        openExternally(url)
    }
}

// Section 8.2: the seven message types of the table above, minus
// `openExternal` (resolved locally, its own comment says why) - App/ wires
// a conformance that routes `ready`/`signedIn`/`signedOut`/`visitStarted`/
// `visitEnded` to Runtime/TrackerRuntime.swift and
// `requestNotifications`/`openConsent` to Screens/ (F3, not yet built).
protocol WebBridgeDelegate: AnyObject {
    func webBridgeReady()
    func webBridgeSignedIn()
    func webBridgeSignedOut()
    func webBridgeVisitStarted(_ visit: VisitSummary)
    func webBridgeVisitEnded(_ visitId: Int)
    func webBridgeRequestedNotifications()
    func webBridgeRequestedConsent()
}

// This file's own retain-cycle rule, stated once at the top: holds its
// target only `weak`, so `WKUserContentController.add(_:name:)`'s strong
// retain lands on this proxy and never closes a cycle back through
// `WebViewController` to the `webView`/`configuration` that outlives it.
private final class WeakScriptMessageHandlerProxy: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

// ios/SPEC.md Section 8.2's `visitStarted` message. Converts the flattened
// JSON dictionary above into the same struct
// Runtime/TrackerRuntime.swift's `visitStarted(_:)` already takes.
private extension VisitSummary {
    init?(bridgeDictionary dictionary: [String: Any]) {
        guard
            let id = dictionary["id"] as? Int,
            let barId = dictionary["barId"] as? Int,
            let barName = dictionary["barName"] as? String,
            let startedAt = dictionary["startedAt"] as? Double,
            let lastSampleAt = dictionary["lastSampleAt"] as? Double,
            let onsiteSamples = dictionary["onsiteSamples"] as? Int,
            let confirmedS = dictionary["confirmedS"] as? Double,
            let remainingS = dictionary["remainingS"] as? Double,
            let statusRaw = dictionary["status"] as? String,
            let status = VisitStatus(rawValue: statusRaw)
        else { return nil }
        self.init(
            id: id,
            barId: barId,
            barName: barName,
            startedAt: startedAt,
            lastSampleAt: lastSampleAt,
            onsiteSamples: onsiteSamples,
            confirmedS: confirmedS,
            remainingS: remainingS,
            status: status
        )
    }
}
