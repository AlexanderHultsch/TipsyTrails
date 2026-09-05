import CoreLocation
import Foundation
import SwiftUI
import UIKit
import UserNotifications
import WebKit

// ios/SPEC.md Section 4.4/6.4. `@main` pairs a SwiftUI `App` (for the four
// native screens of Section 11, Screens/, F3's job) with a classic
// `UIApplicationDelegate` through `UIApplicationDelegateAdaptor` - because
// `launchOptions` arrives on `application(_:didFinishLaunchingWithOptions:)`
// and nowhere else, and that launch path, not SwiftUI's own `init`/`body`,
// is what Section 4.4 and 6.4 hand this app.
@main
struct TipsyTrailsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            // Section 4.1/11: the game is the existing web app, loaded into
            // a `WKWebView` (Web/, F2b) behind the four native screens of
            // Section 11 (`RootView`, below, F3). Every property this reads
            // off `appDelegate` is set, together, at the end of
            // `application(_:didFinishLaunchingWithOptions:)` - before
            // SwiftUI ever asks this `body` for content on a normal launch -
            // so the `else` branch below is dead code on that path and
            // exists only so this type-checks. A location-caused headless
            // launch (Section 6.4) never reaches this closure at all - see
            // `AppDelegate`'s own comment on why - so it never sees either
            // branch.
            if
                let rootState = appDelegate.rootState,
                let trackerStateObserver = appDelegate.trackerStateObserver,
                let webViewController = appDelegate.webViewController,
                let locationEngine = appDelegate.locationEngine,
                let notificationCentre = appDelegate.notificationCentre,
                let runtime = appDelegate.runtime,
                let diagnosticsStore = appDelegate.diagnosticsStore
            {
                RootView(
                    rootState: rootState,
                    trackerState: trackerStateObserver,
                    webViewController: webViewController,
                    locationEngine: locationEngine,
                    notificationCentre: notificationCentre,
                    trackerRuntime: runtime,
                    diagnosticsStore: diagnosticsStore,
                    onConsentChanged: appDelegate.restartTracker
                )
            } else {
                EmptyView()
            }
        }
    }
}

// ios/SPEC.md Section 4.4: owns the launch path of 4.4 and 6.4.
// `launchOptions[.location]` is present only when iOS relaunched the app
// FOR a location event (Section 6.4's significant-change relaunch) - that
// is the one signal this app has for "the player never touched the app
// switcher, a fix arrived instead." Every other launch (the player tapping
// the icon, a debugger attach with no location key) falls to `.user`;
// `.unknown` is for a launch this delegate cannot place in either bucket,
// which Section 7.3's own `startsByCause` counter is what would ever
// surface one - nothing in this file produces `.unknown` itself, because
// `launchOptions` always answers the one question that matters here with
// present-or-absent, never a third state.
final class AppDelegate: NSObject, UIApplicationDelegate {
    // `fileprivate`, not `private`: `TipsyTrailsApp`'s own `body` (above, in
    // this same file) reads these six directly to build `RootView` (Section
    // 11's four screens, F3) - Swift's `private` would confine them to this
    // class alone, and the two types are siblings in one file rather than
    // one nested in the other. `cookieProvider`, `eventReceiver` and
    // `webBridgeDelegate` below have no reader outside this class and stay
    // `private`.
    fileprivate var runtime: TrackerRuntime?
    fileprivate var locationEngine: LocationEngine?
    fileprivate var webViewController: WebViewController?
    fileprivate var notificationCentre: NotificationCentre?
    fileprivate var diagnosticsStore: DiagnosticsStore?
    // Section 11: `AppRootState` decides which of Section 11's screens (if
    // any) covers the web view; `TrackerStateObserver` is what Section
    // 7.8's own words ask for - "those live values reach the Diagnostics
    // screen from the tracking event... and from the tracker's own state."
    // Both are defined at the bottom of this file, beside `RootView`.
    fileprivate var rootState: AppRootState?
    fileprivate var trackerStateObserver: TrackerStateObserver?

    private var cookieProvider: CookieProvider?
    private var eventReceiver: BridgedEventReceiver?
    private var webBridgeDelegate: AppWebBridgeDelegate?
    // Section 11.4: the web view's navigation delegate, reassigned from
    // Web/WebViewController.swift's own `self` (F2b's own init) to this
    // instead - see this type's own comment, at the bottom of this file,
    // for why that file is not where Section 11.4's detection could be
    // added under this substep's write scope (I7).
    private var webLoadDelegate: WebLoadDelegate?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let cause: StartCause
        let appState: AppState
        if launchOptions?[.location] != nil {
            // Section 6.4: THE case the whole background design exists
            // for, and the one a reader will assume is impossible - iOS
            // woke this process with no icon tap, no app switcher, nothing
            // on screen, because a significant location change arrived
            // for a service that survives termination.
            //
            // There is no API here to refuse a `UIWindowScene`, and this
            // branch does not look for one: when iOS launches an app in the
            // background for a location event, it does not connect a scene
            // at all, so a SwiftUI `WindowGroup`'s content (`body` above)
            // is never instantiated - nothing asked for a window, so
            // nothing here creates one. "Do nothing SwiftUI-visible in this
            // branch" is not a workaround standing in for a missing API; it
            // is the whole of what this case requires. The tracker runs
            // headless until the player opens the app for real, at which
            // point the system connects a scene of its own accord and
            // `body` is asked for content for the first time.
            cause = .location
            appState = .launchedHeadless
        } else {
            cause = .user
            appState = .foreground
        }

        // Section 8.5/F2b: the one `WKWebView`, created once and kept for
        // the process's life - `RootView` (bottom of this file, F3)
        // presents it and calls `loadServerOrigin()` once the Primer (if
        // shown at all) has run its course.
        let webView = WebViewController()

        // Section 11.1's own last sentence: "A player who already has an
        // authorization state other than .notDetermined never sees this
        // screen." Read once, synchronously, before `RootView` is ever
        // asked for content - `CLLocationManager.authorizationStatus` is an
        // instance property answering for the app's own authorization
        // regardless of which manager instance reads it, so this fresh,
        // throwaway instance (never a delegate, never `configure`d) needs
        // no relationship to Location/LocationEngine.swift's own manager to
        // answer this one synchronous question correctly.
        let rootState = AppRootState(showPrimer: CLLocationManager().authorizationStatus == .notDetermined)

        // Section 7.7: the notification centre's delegate is set once,
        // here, so a notification Runtime/HostBridge.swift schedules while
        // the app is foregrounded still presents (that file's own
        // `scheduleLocalNotification`/`removePendingNotificationRequests`
        // are unchanged by this - see Notifications/NotificationCentre.swift's
        // own comment on where scheduling lives).
        let notifications = NotificationCentre()
        UNUserNotificationCenter.current().delegate = notifications

        let diagnostics = DiagnosticsStore()

        // Section 7.8's own words: "those live values reach the
        // Diagnostics screen from the tracking event of Section 7.5 and
        // from the tracker's own state" - `trackerStateObserver` is that
        // seam (bottom of this file), fed by `BridgedEventReceiver` below
        // on every `tracking` event, alongside its two existing readers.
        let trackerStateObserver = TrackerStateObserver()

        let receiver = BridgedEventReceiver(
            webViewController: webView,
            diagnosticsStore: diagnostics,
            trackerStateObserver: trackerStateObserver
        )

        // Section 5.2: the real `SessionCookieProviding` conformance,
        // reading `tt_session` out of the same `WKHTTPCookieStore` the web
        // view itself uses - the one authority Section 5.2's four rules
        // name.
        let cookies = CookieProvider(
            cookieStore: webView.webView.configuration.websiteDataStore.httpCookieStore,
            serverHost: webView.serverOrigin.host ?? ""
        )

        let engine = LocationEngine()
        let trackerRuntime = TrackerRuntime(
            locationEngine: engine,
            sessionCookieProvider: cookies,
            eventReceiver: receiver
        )

        // Section 7.1/7.8: `TRACKER_DIAGNOSTIC_DAYS` reaches
        // Diagnostics/DiagnosticsStore.swift the same way
        // `TRACKER_RESTART_MIN_INTERVAL_MS` reaches
        // Runtime/TrackerRuntime.swift itself - read off the bundle's own
        // `config` once it exists (I1), never a Swift literal standing in
        // for it. The completion runs on the tracker queue
        // (`configNumber`'s own comment); `diagnostics.retentionDays` is
        // otherwise only ever touched from that same queue too (every
        // `DiagnosticsStore` write arrives through `BridgedEventReceiver`,
        // below, which runs there), so no further hop is needed here.
        trackerRuntime.configNumber("TRACKER_DIAGNOSTIC_DAYS") { diagnosticDays in
            guard let diagnosticDays else { return }
            diagnostics.retentionDays = Int(diagnosticDays)
        }

        let bridgeDelegate = AppWebBridgeDelegate(
            trackerRuntime: trackerRuntime,
            rootState: rootState,
            onSignedIn: { [weak self] in self?.restartTracker() }
        )
        webView.delegate = bridgeDelegate

        // Section 11.4: `WebLoadDelegate` (bottom of this file) is set as
        // the web view's navigation delegate INSTEAD of `webView` itself -
        // its own comment says why (Web/WebViewController.swift, F2b, is
        // outside this substep's write scope) and how it keeps
        // `decidePolicyFor:` working (it forwards that one call straight to
        // `webView`).
        let webLoadDelegate = WebLoadDelegate(webViewController: webView, rootState: rootState)
        webView.webView.navigationDelegate = webLoadDelegate

        engine.onSample = { [weak trackerRuntime] sample in
            trackerRuntime?.submitFix(sample)
        }
        engine.onAuthorizationChange = { [weak trackerRuntime, weak trackerStateObserver] authorization in
            trackerRuntime?.setAuthorization(authorization)
            // Section 6.2's "third field": `TrackerStateObserver` needs
            // `servicesEnabled` too, and Section 7.5's own `tracking` event
            // does not carry it (only `authorization: { status, accuracy }`
            // does) - fed here, directly off the same closure, rather than
            // re-derived from an event that does not have it.
            trackerStateObserver?.apply(authorization: authorization)
        }

        webViewController = webView
        cookieProvider = cookies
        notificationCentre = notifications
        diagnosticsStore = diagnostics
        eventReceiver = receiver
        webBridgeDelegate = bridgeDelegate
        self.webLoadDelegate = webLoadDelegate
        locationEngine = engine
        runtime = trackerRuntime
        self.rootState = rootState
        self.trackerStateObserver = trackerStateObserver

        // Section 7.3: `start` needs a cookie and an authorization pair
        // before anything else. `cookies.currentSessionCookieValue()` is
        // the real read (Section 5.2) - `WKHTTPCookieStore.getAllCookies`
        // is asynchronous, though, and its first answer is unlikely to have
        // landed by this exact line, so this very first call can still read
        // `hasCookie: false` for a player who is in fact signed in; that is
        // the same "one change stale in the worst case" `CookieProvider`'s
        // own comment already accepts, and it self-corrects the moment
        // anything else calls `start` again (5.4).
        //
        // The authorization argument below is left at F2a's own
        // placeholder (`.notDetermined`/`.fullAccuracy`/`true`) rather than
        // read fresh here, deliberately: `engine.onAuthorizationChange`
        // (above) already fires within the same launch, before the
        // placeholder could mislead anything that reads live state (Apple
        // delivers `locationManagerDidChangeAuthorization` once, reporting
        // the CURRENT status, the first time a manager's delegate is set -
        // Location/LocationEngine.swift's own `init` does that a few lines
        // above this one), and reading the real pair here a second way
        // would mean duplicating Location/LocationEngine.swift's private
        // `mapStatus`/`mapAccuracy` (this substep's write scope does not
        // extend to that file) for a value that self-corrects within the
        // same run loop turn regardless. Flagged in this substep's own
        // report as a considered choice, not an oversight.
        //
        // `discoveryNotifications` DOES read live, real state: the same
        // `UserDefaults` key Screens/ConsentScreen.swift's own toggle
        // writes, so a preference set on a previous run is honoured on this
        // one rather than silently reset to the default every launch.
        trackerRuntime.start(
            appState: appState,
            cause: cause,
            hasCookie: cookies.currentSessionCookieValue() != nil,
            authorization: Authorization(
                status: .notDetermined,
                accuracy: .fullAccuracy,
                servicesEnabled: true
            ),
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
            discoveryNotifications: UserDefaults.standard.object(
                forKey: ConsentScreen.discoveryNotificationsDefaultsKey
            ) as? Bool ?? true
        )

        // Section 6.5: Low Power Mode reaches `setLowPower` through this
        // notification, exactly as the initial `start` call above reads
        // its starting value from the same `ProcessInfo` property.
        NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: nil
        ) { [weak trackerRuntime] _ in
            trackerRuntime?.setLowPower(ProcessInfo.processInfo.isLowPowerModeEnabled)
        }

        return true
    }

    // Section 4.4: app-state changes reach `tracker.setAppState`. Once
    // Screens/ (F3) exists these will read `scenePhase` from SwiftUI
    // instead; the delegate's own lifecycle callbacks are what this
    // substep has, and they answer the same two questions
    // (`foreground`/`background`) `AppState` needs.
    func applicationDidBecomeActive(_ application: UIApplication) {
        runtime?.setAppState(.foreground)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        runtime?.setAppState(.background)
    }

    // Section 5.4: "The shell does not call PATCH /api/settings itself...
    // so this screen asks the web view to do it, and the shell learns the
    // result back through the tracker's next start." Screens/ConsentScreen.swift
    // calls this (through `RootView`'s `onConsentChanged`) right after
    // asking the web view to write consent - reassembling `start`'s input
    // the way the launch call above does, except the authorization pair
    // and low-power flag are read from `trackerStateObserver`'s own live
    // values (real by now, unlike the launch call's placeholder - see that
    // call's own comment) rather than approximated again.
    fileprivate func restartTracker() {
        guard let runtime, let cookieProvider, let trackerStateObserver else { return }
        runtime.start(
            appState: .foreground,
            cause: .user,
            hasCookie: cookieProvider.currentSessionCookieValue() != nil,
            authorization: Authorization(
                status: trackerStateObserver.authorizationStatus,
                accuracy: trackerStateObserver.accuracyAuthorization,
                servicesEnabled: trackerStateObserver.servicesEnabled
            ),
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
            discoveryNotifications: UserDefaults.standard.object(
                forKey: ConsentScreen.discoveryNotificationsDefaultsKey
            ) as? Bool ?? true
        )
    }
}

// ios/SPEC.md 7.5/8.2: the real `TrackerEventReceiving` conformance,
// replacing F2a's `StoredLatestEventReceiver` stub - every event
// Runtime/HostBridge.swift's `installEmit` hands to the tracker queue is
// routed on from here to three readers: the web view's own `dispatch`
// (which holds the "latest" cache 8.2 asks for, so nothing here needs to
// any more), Diagnostics/DiagnosticsStore.swift, for the one event that
// store needs to react to as it happens rather than being handed later -
// `shellException` (Section 4.4), which is not itself part of Section 7.5's
// `TrackerEvent` union but is the same dictionary shape, built by
// Runtime/TrackerRuntime.swift's own `handleException` - and, added by this
// substep (F3), `TrackerStateObserver` (bottom of this file), for every
// `tracking` event, which is Section 7.8's own seam for a live value
// reaching Section 11's screens.
final class BridgedEventReceiver: TrackerEventReceiving {
    private weak var webViewController: WebViewController?
    private let diagnosticsStore: DiagnosticsStore
    private let trackerStateObserver: TrackerStateObserver

    init(
        webViewController: WebViewController,
        diagnosticsStore: DiagnosticsStore,
        trackerStateObserver: TrackerStateObserver
    ) {
        self.webViewController = webViewController
        self.diagnosticsStore = diagnosticsStore
        self.trackerStateObserver = trackerStateObserver
    }

    func receivedTrackerEvent(_ event: [String: Any]) {
        webViewController?.dispatch(event)
        guard let type = event["type"] as? String else { return }
        if type == "shellException", let message = event["message"] as? String {
            diagnosticsStore.recordException(message)
        }
        if type == "tracking" {
            // Section 4.4: every call out of the tracker context is handed
            // back to whichever queue its consumer needs - `TrackerStateObserver`
            // is an `ObservableObject` SwiftUI reads, so it needs the main
            // queue, exactly like `webViewController?.dispatch` above (which
            // hops to main itself, inside `dispatch`).
            let trackerStateObserver = trackerStateObserver
            DispatchQueue.main.async {
                trackerStateObserver.apply(trackingEvent: event)
            }
        }
    }
}

// ios/SPEC.md 8.2: the real `WebBridgeDelegate` conformance, wired to
// Runtime/TrackerRuntime.swift for the five messages that are the
// tracker's business (`ready`/`signedOut`/`visitStarted`/`visitEnded`, each
// 1:1 with a `TrackerRuntime` method, and `signedIn`'s own comment below).
// `requestNotifications` and `openConsent` are both, in the end, the
// Consent screen (Section 11.2) - both now present it, through
// `AppRootState.showConsent` (bottom of this file), which is this
// substep's (F3's) own fill-in for the two documented no-ops F2b left.
final class AppWebBridgeDelegate: WebBridgeDelegate {
    private weak var trackerRuntime: TrackerRuntime?
    private weak var rootState: AppRootState?
    private let onSignedIn: () -> Void

    init(trackerRuntime: TrackerRuntime, rootState: AppRootState, onSignedIn: @escaping () -> Void) {
        self.rootState = rootState
        self.trackerRuntime = trackerRuntime
        self.onSignedIn = onSignedIn
    }

    // Section 8.2: "ready | the web app has mounted | replies with the
    // current state through dispatch" - `requestState` is `tracker.ts`'s
    // own call for exactly this (Runtime/TrackerRuntime.swift), and the
    // reply itself is the web view's own "latest" cache
    // (Web/WebViewController.swift's injected script), not something this
    // file has to build.
    func webBridgeReady() {
        trackerRuntime?.requestState()
    }

    // Section 8.2: "signedIn | after login or registration succeeds |
    // re-reads the cookie, starts the tracker if it was idle." The
    // re-read half already happens on its own -
    // Web/CookieProvider.swift's `WKHTTPCookieStoreObserver` fires the
    // moment login sets the cookie (Section 5.2's second rule), with no
    // action needed here. The "starts the tracker if it was idle" half is
    // `onSignedIn`, `AppDelegate.restartTracker()` (also 5.4's own call) -
    // a fresh `start` re-reads the now-present session and moves the
    // tracker out of `idle` on its own (Section 7.3's diagram), so this
    // does not need to know or check whether it actually was idle first.
    func webBridgeSignedIn() {
        onSignedIn()
    }

    // Section 8.2: "signedOut | before the web app's own logout request |
    // tells the tracker sessionLost('cookie') first."
    func webBridgeSignedOut() {
        trackerRuntime?.signedOut()
    }

    // Section 7.6/8.2: "visitStarted / visitEnded | POST /api/visits and
    // the cancel succeed | forwards to the tracker."
    func webBridgeVisitStarted(_ visit: VisitSummary) {
        trackerRuntime?.visitStarted(visit)
    }

    func webBridgeVisitEnded(_ visitId: Int) {
        trackerRuntime?.visitEnded(visitId)
    }

    // Section 8.2: "requestNotifications | the player asks for
    // notifications from the web app | shows the Consent screen's
    // notification step." That step is Screens/ConsentScreen.swift's own
    // notifications section (Section 11.2) - calling
    // `NotificationCentre.requestAuthorization` straight from this message,
    // with no explanation shown first, is exactly the uninformed prompt
    // Section 10.1 exists to avoid, so this shows the Consent screen rather
    // than the system prompt directly; the screen's own button is what
    // actually asks.
    func webBridgeRequestedNotifications() {
        rootState?.showConsent = true
    }

    // Section 8.2: "openConsent | the player opens background-tracking
    // settings from the web app | shows the Consent screen."
    func webBridgeRequestedConsent() {
        rootState?.showConsent = true
    }
}

// ios/SPEC.md Section 7.8's own words: "those live values reach the
// Diagnostics screen from the tracking event of Section 7.5 and from the
// tracker's own state, which is where a live value belongs." This class is
// that seam for Section 11's screens - populated by `BridgedEventReceiver`
// above on every `tracking` event, and by `application(_:didFinishLaunchingWithOptions:)`'s
// own `engine.onAuthorizationChange` closure for `servicesEnabled`, which
// the `tracking` event does not carry (Section 7.5's own payload has only
// `authorization: { status, accuracy }` - Section 6.2's "third field" is
// this shell's own concern, not the tracker's). An `ObservableObject`
// rather than a delegate protocol, because Section 11's SwiftUI screens are
// this class's only readers and `@Published` is what lets them redraw on a
// change with no further plumbing.
final class TrackerStateObserver: ObservableObject {
    @Published private(set) var trackingState = "idle"
    @Published private(set) var profile: String?
    @Published private(set) var blockedReason: String?
    @Published private(set) var backgroundActive = false
    @Published private(set) var authorizationStatus: AuthorizationStatus = .notDetermined
    @Published private(set) var accuracyAuthorization: AccuracyAuthorization = .fullAccuracy
    @Published private(set) var lowPower = false
    @Published private(set) var servicesEnabled = true

    // Called on the main queue only - `BridgedEventReceiver`'s own hop,
    // above, is what guarantees that.
    func apply(trackingEvent event: [String: Any]) {
        if let state = event["state"] as? String {
            trackingState = state
        }
        profile = event["profile"] as? String
        blockedReason = event["reason"] as? String
        if let background = event["background"] as? Bool {
            backgroundActive = background
        }
        if let authorization = event["authorization"] as? [String: Any] {
            if
                let statusRaw = authorization["status"] as? String,
                let status = AuthorizationStatus(rawValue: statusRaw)
            {
                authorizationStatus = status
            }
            if
                let accuracyRaw = authorization["accuracy"] as? String,
                let accuracy = AccuracyAuthorization(rawValue: accuracyRaw)
            {
                accuracyAuthorization = accuracy
            }
        }
        if let lowPowerValue = event["lowPower"] as? Bool {
            lowPower = lowPowerValue
        }
    }

    // Section 6.2's "third field" - Location/LocationEngine.swift's own
    // `onAuthorizationChange` closure already carries it, and this substep's
    // own edit to that closure (above) fans it out to here too. That
    // closure fires off the main queue (Location/LocationEngine.swift's own
    // comment on `CLLocationManager.locationServicesEnabled()` possibly
    // blocking), so this hops to main itself rather than assuming its
    // caller already has.
    func apply(authorization: Authorization) {
        DispatchQueue.main.async {
            self.authorizationStatus = authorization.status
            self.accuracyAuthorization = authorization.accuracy
            self.servicesEnabled = authorization.servicesEnabled
        }
    }
}

// Section 11: drives which of Section 11's screens (if any) covers the web
// view. `showPrimer` is decided once, synchronously, before this object is
// ever constructed (see this file's own `application(_:didFinishLaunchingWithOptions:)`);
// `showUnreachable` and `hasLoadedOnce` are Section 11.4's own state,
// populated by `WebLoadDelegate` below; `showConsent` is Section 11.2's,
// set by `AppWebBridgeDelegate` above and by `RootView`'s own footer button
// on the web view's indicator panel (Section 8.3, `packages/web`'s Step D,
// not this branch) reaching the same `openConsent` message.
final class AppRootState: ObservableObject {
    @Published var showPrimer: Bool
    @Published var showUnreachable = false
    @Published var showConsent = false
    private(set) var hasLoadedOnce = false

    init(showPrimer: Bool) {
        self.showPrimer = showPrimer
    }

    func firstLoadSucceeded() {
        hasLoadedOnce = true
        showUnreachable = false
    }

    func firstLoadFailed() {
        // Section 11.4: "Once the web app has loaded once... this screen is
        // not shown [again]."
        guard !hasLoadedOnce else { return }
        showUnreachable = true
    }
}

// ios/SPEC.md Section 11.4's own trigger: a failed initial load of
// SERVER_ORIGIN. Web/WebViewController.swift (F2b) already conforms to
// `WKNavigationDelegate` for Section 8.5's own reason (host confinement,
// `decidePolicyFor:`, and the `target="_blank"` handling on `WKUIDelegate`
// beside it) and is outside this substep's write scope (I7: this branch
// writes only to Screens/ and, here, App/TipsyTrailsApp.swift) - so rather
// than editing that file to add the two methods Section 11.4 needs, this
// class is set as the web view's navigation delegate INSTEAD (this file's
// own `application(_:didFinishLaunchingWithOptions:)`), forwarding the one
// method `WebViewController` still needs to keep working straight to it,
// and adding `didFinish`/`didFail`/`didFailProvisionalNavigation`, which it
// does not implement. Flagged in this substep's own report: the cleaner
// home for Section 11.4's detection is Web/WebViewController.swift itself,
// beside `decidePolicyFor:`, and that is not this substep's file to write.
final class WebLoadDelegate: NSObject, WKNavigationDelegate {
    private weak var webViewController: WebViewController?
    private weak var rootState: AppRootState?

    init(webViewController: WebViewController, rootState: AppRootState) {
        self.webViewController = webViewController
        self.rootState = rootState
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let webViewController else {
            decisionHandler(.allow)
            return
        }
        webViewController.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        rootState?.firstLoadSucceeded()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        rootState?.firstLoadFailed()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        rootState?.firstLoadFailed()
    }
}

// The one piece of glue Section 11 does not name as a screen but needs to
// embed Web/WebViewController.swift's `WKWebView` into a SwiftUI hierarchy
// at all - SwiftUI has no native `WKWebView` view, and this substep's write
// scope (Screens/ and this file) has nowhere better to put it than beside
// `RootView`, its only user.
struct WebViewRepresentable: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView {
        webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

// ios/SPEC.md Section 11: the composition root's own view, replacing the
// `EmptyView()` F2a and F2b left. Decides which of Section 11's screens (if
// any) covers the web view, and nothing else - every decision about WHAT a
// screen shows is that screen's own file, per Section 11.
struct RootView: View {
    @ObservedObject var rootState: AppRootState
    @ObservedObject var trackerState: TrackerStateObserver
    let webViewController: WebViewController
    let locationEngine: LocationEngine
    let notificationCentre: NotificationCentre
    let trackerRuntime: TrackerRuntime
    let diagnosticsStore: DiagnosticsStore
    let onConsentChanged: () -> Void

    var body: some View {
        ZStack {
            // Section 8.5: "The web view is created once and kept for the
            // process's life" - always in the hierarchy, covered by the
            // Primer or the Unreachable screen rather than replaced by
            // them, so it is never recreated by SwiftUI while either shows.
            WebViewRepresentable(webView: webViewController.webView)

            if rootState.showPrimer {
                // Section 11.1: "shown once, on first launch, before the
                // web view."
                PrimerScreen(onContinue: {
                    locationEngine.requestWhenInUseAuthorization()
                    rootState.showPrimer = false
                    webViewController.loadServerOrigin()
                })
            } else if rootState.showUnreachable {
                UnreachableScreen(onTryAgain: webViewController.loadServerOrigin)
            }
        }
        .sheet(isPresented: $rootState.showConsent) {
            ConsentScreen(
                locationEngine: locationEngine,
                notificationCentre: notificationCentre,
                trackerRuntime: trackerRuntime,
                diagnosticsStore: diagnosticsStore,
                webViewController: webViewController,
                trackerState: trackerState,
                onConsentChanged: onConsentChanged,
                onDismiss: { rootState.showConsent = false }
            )
        }
        .onAppear {
            // Section 11.1: a player who never sees the Primer (the launch
            // decision is `AppRootState.showPrimer`'s own, made once before
            // this view was constructed) loads the web view immediately;
            // one who does see it loads it from `onContinue` above instead,
            // once the Primer "has run its course" (Section 8.5's own
            // words for this same call).
            if !rootState.showPrimer {
                webViewController.loadServerOrigin()
            }
        }
    }
}
