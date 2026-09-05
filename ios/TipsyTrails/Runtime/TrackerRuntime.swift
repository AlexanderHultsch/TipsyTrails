import Foundation
import JavaScriptCore

// ios/SPEC.md Section 4.4: the heart. One serial `DispatchQueue`, owned
// here - the `JSContext` is created on it, `tracker.js` is evaluated on it,
// and every call into the context happens on it, whichever queue the
// caller started on (`CLLocationManager`'s delegate is the main queue,
// `URLSession`'s completion is its own, a web view message - once Web/
// exists - is the main queue again). That single-threaded discipline is
// what lets `packages/tracker` be a plain state machine with no locks, and
// it is why the same bundle runs unchanged under Vitest (Section 2.3).
//
// This file also carries every Swift-side type that mirrors a
// `packages/tracker` wire shape this substep needs -
// `AppState`/`StartCause`/`Authorization`/`Sample`/`VisitSummary` - the
// same deliberate hand-kept-mirror choice `packages/tracker/src/events.ts`
// already makes for its own three (see that file's comment): this package
// cannot import `packages/tracker`, so Swift keeps its own copy in step by
// hand.
final class TrackerRuntime {
    private let queue: DispatchQueue
    private let locationEngine: LocationEngine
    private let sessionCookieProvider: SessionCookieProviding
    private let eventReceiver: TrackerEventReceiving

    private var context: JSContext?
    // Section 7.2's own words: "the runtime module's Swift is a
    // line-for-line implementation of [`Host`]" - `tracker` is the other
    // half, `globalThis.__tipsyTrails`, the surface Section 7.3's
    // `Tracker` interface names. Every method below is this file's typed
    // wrapper around one member of it, so no other file writes one of
    // these names as a string.
    private var tracker: JSValue?

    // Owns the `HostBridge` for the current context's life. Every block
    // `HostBridge` installs onto the context captures `self` `[weak]`
    // (that file's own comment on why), which means nothing about being
    // installed into the context keeps a `HostBridge` instance alive - if
    // this file did not hold one here, the local `let bridge = ...` in
    // `createContext` below would be deallocated the moment that function
    // returns, and every one of the ten installed functions would find a
    // `nil self` forever after. This property is that strong reference,
    // replaced (and the old one released) on every restart.
    private var hostBridge: HostBridge?

    // Section 4.4: "It does not retry more than once per
    // TRACKER_RESTART_MIN_INTERVAL_MS" - read from the tracker's own
    // `config` once the bundle has evaluated at least once (I1: this
    // number is never a Swift literal). Until then it is the floor's
    // identity value, 0, which never blocks the very first restart because
    // `lastRestartAt` below is `nil` until one has actually happened.
    private var restartMinIntervalMs: Double = 0
    private var lastRestartAt: Date?

    // Section 4.4: "the shell recreates the context and restarts the
    // tracker from its start state" - this is what a restart replays.
    // Section 7.3's own start sequence is idempotent by design (it is
    // exactly what a headless relaunch already does), so replaying the
    // last input is correct even though the in-memory queue behind it is
    // gone (I2 accepts that loss).
    private var lastStartInput: [String: Any]?

    init(
        locationEngine: LocationEngine,
        sessionCookieProvider: SessionCookieProviding,
        eventReceiver: TrackerEventReceiving
    ) {
        self.queue = DispatchQueue(label: "com.ahultsch.tipsytrails.tracker")
        self.locationEngine = locationEngine
        self.sessionCookieProvider = sessionCookieProvider
        self.eventReceiver = eventReceiver
        queue.async { [weak self] in
            self?.createContext()
        }
    }

    private static var serverOrigin: String {
        // Section 4.3: the build setting, read at runtime through
        // `Info.plist`'s `TTServerOrigin` - never a literal in Swift.
        Bundle.main.object(forInfoDictionaryKey: "TTServerOrigin") as? String ?? ""
    }

    // Creates the `JSContext` on the tracker queue, installs the host,
    // evaluates the bundle, and reads `globalThis.__tipsyTrails` back out -
    // Section 7.2's own ordering, exactly. Called once from `init`, and
    // again from `handleException` below whenever the restart floor
    // allows it; both callers are already running on `queue`.
    private func createContext() {
        let newContext = JSContext()
        guard let newContext else { return }

        // Section 4.4: log it, hand it to the event seam below (there is
        // no Diagnostics/ yet for a truer home, and `TrackerEventReceiving`
        // is the one seam this substep has), and recreate the context - no
        // sooner than `restartMinIntervalMs` after the last restart.
        newContext.exceptionHandler = { [weak self] _, exception in
            self?.handleException(exception)
        }

        let bridge = HostBridge(
            queue: queue,
            sessionCookieProvider: sessionCookieProvider,
            eventReceiver: eventReceiver,
            locationEngine: locationEngine,
            serverOrigin: Self.serverOrigin
        )
        bridge.install(into: newContext)
        hostBridge = bridge

        guard
            let bundleUrl = Bundle.main.url(forResource: "tracker", withExtension: "js"),
            let source = try? String(contentsOf: bundleUrl, encoding: .utf8)
        else {
            eventReceiver.receivedTrackerEvent([
                "type": "shellException",
                "message": "tracker.js is missing from the app bundle - the Xcode "
                    + "pre-build script that runs pnpm --filter @tipsytrails/tracker build "
                    + "did not run",
            ])
            return
        }

        newContext.evaluateScript(source)
        context = newContext
        tracker = newContext.objectForKeyedSubscript("__tipsyTrails")

        // Section 7.1: the one number this file reads rather than holds -
        // published on the bundle's own `config` object precisely so a
        // Swift literal never has to (I1).
        if
            let configValue = tracker?
                .objectForKeyedSubscript("config")?
                .objectForKeyedSubscript("TRACKER_RESTART_MIN_INTERVAL_MS"),
            configValue.isNumber
        {
            restartMinIntervalMs = configValue.toDouble()
        }

        if let lastStartInput {
            tracker?.invokeMethod("start", withArguments: [lastStartInput])
        }
    }

    // Section 7.1/7.8: the same read `createContext` above makes for
    // `TRACKER_RESTART_MIN_INTERVAL_MS`, generalised to any key on the
    // bundle's own `config` object - I1 forbids a Swift literal standing in
    // for one of these, and this is the one seam the shell has for reading
    // any of them. Diagnostics/DiagnosticsStore.swift's `retentionDays`
    // (`TRACKER_DIAGNOSTIC_DAYS`) is this method's only caller so far.
    // Asynchronous, like every other entry into the context (Section 4.4) -
    // App/'s composition root calls this once, right after construction,
    // and the bundle may still be mid-evaluation at that exact moment; a
    // synchronous answer would mean blocking whichever queue called this
    // until that finishes, and the main queue is what calls it. The
    // completion runs on the tracker queue, not the caller's - a caller
    // that stores the value on shared state hops it back itself.
    func configNumber(_ key: String, completion: @escaping (Double?) -> Void) {
        queue.async { [weak self] in
            guard
                let configValue = self?.tracker?
                    .objectForKeyedSubscript("config")?
                    .objectForKeyedSubscript(key),
                configValue.isNumber
            else {
                completion(nil)
                return
            }
            completion(configValue.toDouble())
        }
    }

    // A JavaScript exception JavaScriptCore could not otherwise report -
    // Section 4.4's own words: "the context's exceptionHandler logs it,
    // counts it, and the shell recreates the context and restarts the
    // tracker from its start state". Counting it durably across a
    // recreated (and therefore zeroed) `Counters` object is Diagnostics/'s
    // job, not this substep's; what this file owns is the floor that stops
    // a bundle that throws on start from spinning.
    private func handleException(_ exception: JSValue?) {
        let message = exception?.toString() ?? "unknown JavaScriptCore exception"
        eventReceiver.receivedTrackerEvent([
            "type": "shellException",
            "message": message,
        ])

        let now = Date()
        if
            let lastRestartAt,
            now.timeIntervalSince(lastRestartAt) * Date.millisecondsPerSecond < restartMinIntervalMs
        {
            return
        }
        lastRestartAt = now
        tracker = nil
        context = nil
        hostBridge = nil
        createContext()
    }
}

// ios/SPEC.md Section 7.3/host.ts: mirrored, by hand, from
// `packages/tracker/src/tracker.ts`'s own `AppState`/`StartCause` and
// `host.ts`'s `LocationProfile`'s authorization pair, widened by
// `servicesEnabled` (7.3's "the third field").
enum AppState: String {
    case foreground
    case background
    case launchedHeadless
}

enum StartCause: String {
    case user
    case location
    case unknown
}

enum AuthorizationStatus: String {
    case notDetermined
    case denied
    case restricted
    case authorizedWhenInUse
    case authorizedAlways
}

enum AccuracyAuthorization: String {
    case fullAccuracy
    case reducedAccuracy
}

struct Authorization {
    let status: AuthorizationStatus
    let accuracy: AccuracyAuthorization
    let servicesEnabled: Bool
}

// ios/SPEC.md Section 6.6: what a `CLLocation` becomes -
// Location/LocationEngine.swift is the only place one of these is built.
// `speed` is `nil` for "unknown" (a negative `CLLocation.speed`), never a
// sentinel number (I1).
struct Sample {
    let lat: Double
    let lon: Double
    let accuracy: Double
    let speed: Double?
    let timestamp: Double
}

// ios/SPEC.md Section 8.2's `visitStarted` message, mirrored from
// `packages/tracker/src/events.ts`'s `VisitSummary` - `Web/` (F2b) is this
// struct's only real source of values until it lands.
enum VisitStatus: String {
    case pending
    case completed
    case expired
    case cancelled
}

struct VisitSummary {
    let id: Int
    let barId: Int
    let barName: String
    let startedAt: Double
    let lastSampleAt: Double
    let onsiteSamples: Int
    let confirmedS: Double
    let remainingS: Double
    let status: VisitStatus
}

// The typed Swift wrapper for every member of `Tracker`
// (packages/tracker/src/tracker.ts) - eleven methods, these names, this
// file only. Each hops onto the tracker queue before calling into the
// context, matching Section 4.4's rule for every other entry point.
extension TrackerRuntime {
    // tracker.ts: `start(input): Promise<void>`. Called by App/'s launch
    // path (headless or not, Section 6.4) and again whenever consent or
    // the web app's own Settings row changes it (Section 5.4) - the
    // tracker has no setter for consent, deliberately, and re-reads it only
    // through a fresh `start` (Section 5.4's own words).
    func start(
        appState: AppState,
        cause: StartCause,
        hasCookie: Bool,
        authorization: Authorization,
        lowPower: Bool,
        discoveryNotifications: Bool
    ) {
        let input: [String: Any] = [
            "appState": appState.rawValue,
            "cause": cause.rawValue,
            "hasCookie": hasCookie,
            "authorization": [
                "status": authorization.status.rawValue,
                "accuracy": authorization.accuracy.rawValue,
                "servicesEnabled": authorization.servicesEnabled,
            ],
            "lowPower": lowPower,
            "discoveryNotifications": discoveryNotifications,
        ]
        queue.async { [weak self] in
            guard let self else { return }
            self.lastStartInput = input
            self.tracker?.invokeMethod("start", withArguments: [input])
        }
    }

    // tracker.ts: `submitFix(sample): void` - Location/LocationEngine.swift
    // is this method's only intended caller (wired through App/'s
    // `LocationEngine.onSample`, Section 6.6).
    func submitFix(_ sample: Sample) {
        let dictionary: [String: Any] = [
            "lat": sample.lat,
            "lon": sample.lon,
            "accuracy": sample.accuracy,
            "speed": sample.speed ?? NSNull(),
            "timestamp": sample.timestamp,
        ]
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("submitFix", withArguments: [dictionary])
        }
    }

    // tracker.ts: `setAppState(appState): void` - App/'s lifecycle
    // callbacks and `scenePhase` are this method's callers (Section 4.4).
    func setAppState(_ appState: AppState) {
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("setAppState", withArguments: [appState.rawValue])
        }
    }

    // tracker.ts: `setAuthorization(auth): void` -
    // Location/LocationEngine.swift's `onAuthorizationChange` is this
    // method's only intended caller (Section 6.2).
    func setAuthorization(_ authorization: Authorization) {
        let dictionary: [String: Any] = [
            "status": authorization.status.rawValue,
            "accuracy": authorization.accuracy.rawValue,
            "servicesEnabled": authorization.servicesEnabled,
        ]
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("setAuthorization", withArguments: [dictionary])
        }
    }

    // tracker.ts: `setLowPower(on): void` - App/'s
    // `NSProcessInfoPowerStateDidChange` observer is this method's caller
    // (Section 6.5).
    func setLowPower(_ on: Bool) {
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("setLowPower", withArguments: [on])
        }
    }

    // tracker.ts: `visitStarted(visit): void` - the web app's own message
    // (Section 8.2), forwarded here once `Web/` (F2b) exists to receive
    // it.
    func visitStarted(_ visit: VisitSummary) {
        let dictionary: [String: Any] = [
            "id": visit.id,
            "barId": visit.barId,
            "barName": visit.barName,
            "startedAt": visit.startedAt,
            "lastSampleAt": visit.lastSampleAt,
            "onsiteSamples": visit.onsiteSamples,
            "confirmedS": visit.confirmedS,
            "remainingS": visit.remainingS,
            "status": visit.status.rawValue,
        ]
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("visitStarted", withArguments: [dictionary])
        }
    }

    // tracker.ts: `visitEnded(visitId): void` - the web app's cancel
    // message (Section 8.2), same caveat as `visitStarted` above.
    func visitEnded(_ visitId: Int) {
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("visitEnded", withArguments: [visitId])
        }
    }

    // tracker.ts: `signedOut(): void` - the web app's `signedOut` message,
    // sent before its own logout request completes (Section 8.2), so
    // nothing is posted against a cookie about to be deleted.
    func signedOut() {
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("signedOut", withArguments: [])
        }
    }

    // tracker.ts: `requestState(): void` - the web app's `ready` message
    // (Section 8.2), for a listener that mounted after the tracker already
    // has a state to report.
    func requestState() {
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("requestState", withArguments: [])
        }
    }

    // tracker.ts: `snapshotCounters(): Counters` - Diagnostics/'s only
    // intended caller, once it exists; returned as a plain dictionary for
    // the same reason `emit`'s event is (HostBridge's own comment).
    func snapshotCounters(_ completion: @escaping ([String: Any]) -> Void) {
        queue.async { [weak self] in
            let result = self?.tracker?.invokeMethod("snapshotCounters", withArguments: [])
            completion(result?.toDictionary() as? [String: Any] ?? [:])
        }
    }

    // tracker.ts: `setDiscoveryNotifications(on): void` - the shell's own
    // `UserDefaults` preference (Section 7.7's decision (a)), mirrored
    // here whenever it changes.
    func setDiscoveryNotifications(_ on: Bool) {
        queue.async { [weak self] in
            self?.tracker?.invokeMethod("setDiscoveryNotifications", withArguments: [on])
        }
    }
}
