import Foundation
import SwiftUI
import UIKit
import UserNotifications

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
            // Section 4.1/11: the game is the existing web app, loaded
            // into a `WKWebView` (Web/, F2b) behind the four native
            // screens of Section 11 (Screens/, F3). Neither exists yet -
            // this substep (F2a) is App/, Runtime/ and Location/ only, and
            // must compile against their absence. A location-caused
            // launch never reaches this closure in the case that matters -
            // see `AppDelegate`'s comment on why.
            EmptyView()
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
    private var runtime: TrackerRuntime?
    private var locationEngine: LocationEngine?
    private var webViewController: WebViewController?
    private var cookieProvider: CookieProvider?
    private var notificationCentre: NotificationCentre?
    private var diagnosticsStore: DiagnosticsStore?
    private var eventReceiver: BridgedEventReceiver?
    private var webBridgeDelegate: AppWebBridgeDelegate?

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
        // the process's life - nothing in Screens/ (F3) exists yet to
        // present it, so this substep only constructs it and wires the
        // bridge; `loadServerOrigin()` and presenting `webView.webView` are
        // F3's job.
        let webView = WebViewController()

        // Section 7.7: the notification centre's delegate is set once,
        // here, so a notification Runtime/HostBridge.swift schedules while
        // the app is foregrounded still presents (that file's own
        // `scheduleLocalNotification`/`removePendingNotificationRequests`
        // are unchanged by this - see Notifications/NotificationCentre.swift's
        // own comment on where scheduling lives).
        let notifications = NotificationCentre()
        UNUserNotificationCenter.current().delegate = notifications

        let diagnostics = DiagnosticsStore()

        let receiver = BridgedEventReceiver(webViewController: webView, diagnosticsStore: diagnostics)

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

        let bridgeDelegate = AppWebBridgeDelegate(trackerRuntime: trackerRuntime)
        webView.delegate = bridgeDelegate

        engine.onSample = { [weak trackerRuntime] sample in
            trackerRuntime?.submitFix(sample)
        }
        engine.onAuthorizationChange = { [weak trackerRuntime] authorization in
            trackerRuntime?.setAuthorization(authorization)
        }

        webViewController = webView
        cookieProvider = cookies
        notificationCentre = notifications
        diagnosticsStore = diagnostics
        eventReceiver = receiver
        webBridgeDelegate = bridgeDelegate
        locationEngine = engine
        runtime = trackerRuntime

        // Section 7.3: `start` needs a cookie and an authorization pair
        // before anything else. `cookies.currentSessionCookieValue()` is
        // the real read (Section 5.2) - `WKHTTPCookieStore.getAllCookies`
        // is asynchronous, though, and its first answer is unlikely to have
        // landed by this exact line, so this very first call can still read
        // `hasCookie: false` for a player who is in fact signed in; that is
        // the same "one change stale in the worst case" `CookieProvider`'s
        // own comment already accepts, and it self-corrects the moment
        // anything else calls `start` again (5.4). Reading
        // `CLLocationManager`'s live authorization is `Screens/`'s (F3, the
        // Primer that requests it in the first place) - it does not exist
        // yet, so this half of the call is still wired with the value
        // every `start` implementation already treats as "nothing to track
        // yet": the tracker goes `idle` and waits for a real `start`,
        // exactly as Section 7.3's own diagram has it do with no session.
        // F3 replaces this argument once it lands.
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
            discoveryNotifications: true
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
}

// ios/SPEC.md 7.5/8.2: the real `TrackerEventReceiving` conformance,
// replacing F2a's `StoredLatestEventReceiver` stub - every event
// Runtime/HostBridge.swift's `installEmit` hands to the tracker queue is
// routed on from here to both of this substep's readers: the web view's
// own `dispatch` (which holds the "latest" cache 8.2 asks for, so nothing
// here needs to any more) and Diagnostics/DiagnosticsStore.swift, for the
// one event that store needs to react to as it happens rather than being
// handed later - `shellException` (Section 4.4), which is not itself part
// of Section 7.5's `TrackerEvent` union but is the same dictionary shape,
// built by Runtime/TrackerRuntime.swift's own `handleException`.
final class BridgedEventReceiver: TrackerEventReceiving {
    private weak var webViewController: WebViewController?
    private let diagnosticsStore: DiagnosticsStore

    init(webViewController: WebViewController, diagnosticsStore: DiagnosticsStore) {
        self.webViewController = webViewController
        self.diagnosticsStore = diagnosticsStore
    }

    func receivedTrackerEvent(_ event: [String: Any]) {
        webViewController?.dispatch(event)
        if
            let type = event["type"] as? String,
            type == "shellException",
            let message = event["message"] as? String
        {
            diagnosticsStore.recordException(message)
        }
    }
}

// ios/SPEC.md 8.2: the real `WebBridgeDelegate` conformance, wired to
// Runtime/TrackerRuntime.swift for the five messages that are the
// tracker's business (`ready`/`signedOut`/`visitStarted`/`visitEnded`, each
// 1:1 with a `TrackerRuntime` method, and `signedIn`'s own comment below).
// `requestNotifications` and `openConsent` are both, in the end, the
// Consent screen (Section 11.2) - Screens/'s job (F3, not yet built) - so
// both stay documented no-ops here until it exists.
final class AppWebBridgeDelegate: WebBridgeDelegate {
    private weak var trackerRuntime: TrackerRuntime?

    init(trackerRuntime: TrackerRuntime) {
        self.trackerRuntime = trackerRuntime
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
    // action needed here. Restarting an idle tracker needs the live
    // authorization and discovery-notification preference only Screens/
    // (F3) holds, so that half is deferred there rather than guessed at
    // here.
    func webBridgeSignedIn() {}

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
    // notification step." That step is what actually asks
    // Notifications/NotificationCentre.swift for authorization, behind its
    // own button (Section 11.2) - calling `requestAuthorization` straight
    // from this message, with no explanation shown first, is exactly the
    // uninformed prompt Section 10.1 exists to avoid, so this stays a
    // documented no-op until Screens/'s Consent screen (F3) exists to show
    // that step first.
    func webBridgeRequestedNotifications() {}

    // Section 8.2: "openConsent | the player opens background-tracking
    // settings from the web app | shows the Consent screen." That screen
    // is Screens/'s (F3, not yet built) - nothing here can show it, so this
    // is a documented no-op until it exists, matching this substep's own
    // precedent for a screen that is not this substep's to build (App/'s
    // own comment on `WindowGroup`'s `EmptyView` above says the same of the
    // Primer).
    func webBridgeRequestedConsent() {}
}
