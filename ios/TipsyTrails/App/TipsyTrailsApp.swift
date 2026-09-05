import Foundation
import SwiftUI
import UIKit

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
    private var eventReceiver: StoredLatestEventReceiver?

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

        let receiver = StoredLatestEventReceiver()
        let cookieProvider = NoSessionCookieProvider()
        let engine = LocationEngine()
        let trackerRuntime = TrackerRuntime(
            locationEngine: engine,
            sessionCookieProvider: cookieProvider,
            eventReceiver: receiver
        )

        engine.onSample = { [weak trackerRuntime] sample in
            trackerRuntime?.submitFix(sample)
        }
        engine.onAuthorizationChange = { [weak trackerRuntime] authorization in
            trackerRuntime?.setAuthorization(authorization)
        }

        eventReceiver = receiver
        locationEngine = engine
        runtime = trackerRuntime

        // Section 7.3: `start` needs a cookie and an authorization pair
        // before anything else. Reading the web view's cookie store is
        // `Web/`'s job (F2b) and reading `CLLocationManager`'s live
        // authorization at this exact moment is `Screens/`'s (F3, the
        // Primer that requests it in the first place) - neither exists
        // yet, so this call is wired with the values every `start`
        // implementation already treats as "nothing to track yet" (no
        // cookie, `.notDetermined`): the tracker goes `idle` and waits for
        // a real `start`, exactly as Section 7.3's own diagram has it do
        // with no session. F2b/F3 replace both arguments once they land.
        trackerRuntime.start(
            appState: appState,
            cause: cause,
            hasCookie: false,
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

// ios/SPEC.md 7.5/8.2: the seam Runtime/HostBridge.swift defines so this
// substep compiles without Web/ - stores only the latest event of each
// type, the same "latest" rule Section 8.2 gives the real bridge, so a
// screen that asks late (Diagnostics, a later substep) can still read
// current state once it exists. F2b replaces this with the bridge that
// actually forwards to the web view through `evaluateJavaScript`.
final class StoredLatestEventReceiver: TrackerEventReceiving {
    private(set) var latestEventsByType: [String: [String: Any]] = [:]

    func receivedTrackerEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        latestEventsByType[type] = event
    }
}

// ios/SPEC.md 5.2: the seam Runtime/HostBridge.swift defines so this
// substep compiles without Web/ - a real answer needs `WKHTTPCookieStore`,
// which is `Web/`'s (F2b). Returning `nil` here means every request goes
// out with no `Cookie` header, which `packages/tracker`'s own host
// contract already treats as "no session" the moment the server answers
// 401 (Section 5.2's third rule) - never a crash, and never a silently
// wrong cookie.
final class NoSessionCookieProvider: SessionCookieProviding {
    func currentSessionCookieValue() -> String? {
        nil
    }
}
