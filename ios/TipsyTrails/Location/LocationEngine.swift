import CoreLocation
import Foundation

// ios/SPEC.md Section 6 in full: the `CLLocationManager` wrapper, and the
// one function in this app that turns a `CLLocation` into the tracker's
// sample (Section 6.6, "the only unit boundary in the shell"). Every
// setting on `manager` below traces to a specific subsection named beside
// it; nothing here is a literal this file invented (I1) - `configure`
// below is called only from Runtime/HostBridge.swift's `configureLocation`,
// itself called only with a `LocationProfile` the tracker built from
// `config.ts` (Section 7.2's own words), and the accuracy ladder further
// down is built entirely from Core Location's own named constants rather
// than from a threshold this file would otherwise have to write out.
final class LocationEngine: NSObject {
    private let manager: CLLocationManager

    // Section 6.6: every accepted fix, already turned into the tracker's
    // sample shape. Runtime/TrackerRuntime.swift's `submitFix(_:)` is this
    // closure's only intended target; it is a closure rather than a direct
    // reference to `TrackerRuntime` because Runtime/ and Location/ are two
    // halves of this same substep with no reason to depend on each other
    // directly - App/ (the composition root) wires the two together once
    // both exist.
    var onSample: ((Sample) -> Void)?

    // Section 6.2/7.3: every authorization change, widened by
    // `servicesEnabled` (below). Runtime/TrackerRuntime.swift's
    // `setAuthorization(_:)` is this closure's only intended target, for
    // the same reason as `onSample` above.
    var onAuthorizationChange: ((Authorization) -> Void)?

    // Section 6.6: negative `horizontalAccuracy` is invalid, and the fix is
    // dropped here, before it ever reaches the tracker -
    // `packages/tracker/src/counters.ts`'s own comment on
    // `droppedInvalid` says plainly that this count belongs to the shell
    // and the tracker never writes it. Diagnostics/, a later substep, is
    // what will read this; nothing in F2a does.
    private(set) var droppedInvalidFixesCount = 0

    override init() {
        manager = CLLocationManager()
        super.init()
        manager.delegate = self

        // Section 6.3: fixed, not per-profile, and set once. The default
        // is `true`, and iOS then stops delivering updates when it decides
        // the user has stopped moving - which is exactly a player sitting
        // in a bar, the one moment the dwelling profile needs fixes.
        // Paused updates do not resume on their own.
        manager.pausesLocationUpdatesAutomatically = false
        // Tells the (disabled, above) pause heuristics, and iOS's own
        // power decisions, that this is walking.
        manager.activityType = .fitness
        // iOS shows the location arrow in the status bar for as long as
        // this runs in the background; the app does not hide it (Section
        // 6.3, and 7.5's transparency rule applying to the platform too).
        manager.showsBackgroundLocationIndicator = true
    }

    // Section 7.2/7.3: called only through
    // Runtime/HostBridge.swift's `configureLocation`, itself only ever
    // called with a `LocationProfile` the tracker built from `config.ts` -
    // so neither parameter here is ever a literal this file wrote (I1).
    func configure(desiredAccuracyM: Double, distanceFilterM: Double, background: Bool) {
        manager.desiredAccuracy = Self.nearestAccuracyConstant(forMeters: desiredAccuracyM)
        manager.distanceFilter = distanceFilterM == 0 ? kCLDistanceFilterNone : distanceFilterM
        // Section 6.3: "true once Always is granted and consent given;
        // false otherwise". `background` here already carries consent -
        // it is the tracker's own `backgroundAllowed` (Section 5.4/7.3) -
        // and setting this property without the `location` background
        // mode declared crashes; that mode is always declared
        // (`project.yml`, Section 4.3), so this parameter is the whole of
        // what is left to check, and it already is that check.
        manager.allowsBackgroundLocationUpdates = background
        manager.startUpdatingLocation()
    }

    // Section 6.4: armed or disarmed by consent alone (Section 7.3's own
    // wording), independent of a transient authorization block - what lets
    // a killed app relaunch and find its authorization has since improved.
    func setSignificantChangeMonitoring(on: Bool) {
        if on {
            manager.startMonitoringSignificantLocationChanges()
        } else {
            manager.stopMonitoringSignificantLocationChanges()
        }
    }

    // Section 6.2: the temporary-full-accuracy request, offered here for
    // the Consent screen (Screens/, F3) to call - purpose key `TTPlay`,
    // matching `NSLocationTemporaryUsageDescriptionDictionary` in
    // `project.yml`.
    func requestTemporaryFullAccuracy() {
        manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "TTPlay")
    }

    // Section 6.2/11.1: the Primer screen's one button, offered here for
    // Screens/ (F3) to call - the same precedent as the temporary-accuracy
    // request above: a screen that does not exist yet is not a reason to
    // leave the manager with no way to ask.
    func requestWhenInUseAuthorization() {
        manager.requestWhenInUseAuthorization()
    }

    // Section 6.2's step two/10.1 step 4: the Consent screen's own request
    // for Always, offered here beside `requestWhenInUseAuthorization()`
    // above for the same reason - on `manager`, this class's own retained
    // `CLLocationManager`, and not a transient instance the Consent screen
    // might otherwise construct itself: a `CLLocationManager` must stay
    // alive for the duration of an authorization request, or the request
    // can be torn down by ARC before iOS has presented anything, or before
    // its answer is delivered to anyone. Screens/ConsentScreen.swift calls
    // this only after its own checkbox (Section 10.1's step 3) is checked -
    // that ordering is 10.1's legal basis for Always, not a nicety, and is
    // this call's caller's responsibility, not this method's.
    func requestAlwaysAuthorization() {
        manager.requestAlwaysAuthorization()
    }

    // Section 6.3: Core Location takes a named constant, not a metre
    // figure, so this is a ladder over Core Location's OWN constants -
    // every value compared here is one Apple already named, never a
    // literal this file introduces (Step F4's grep allows only 0, 1, -1).
    // `kCLLocationAccuracyBest`/`kCLLocationAccuracyBestForNavigation` are
    // negative sentinels with no metre reading and are deliberately left
    // out of the ladder: `TRACKER_DESIRED_ACCURACY_M` is always a whole
    // metre figure (Section 0 rule 2) and never asks for either.
    private static let accuracyLadder: [CLLocationAccuracy] = [
        kCLLocationAccuracyNearestTenMeters,
        kCLLocationAccuracyHundredMeters,
        kCLLocationAccuracyKilometer,
        kCLLocationAccuracyThreeKilometers,
    ]

    private static func nearestAccuracyConstant(forMeters metres: Double) -> CLLocationAccuracy {
        accuracyLadder.min { lhs, rhs in
            abs(lhs - metres) < abs(rhs - metres)
        } ?? kCLLocationAccuracyHundredMeters
    }
}

extension LocationEngine: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            // Section 6.6's table, exactly: negative `horizontalAccuracy`
            // is invalid and the fix never reaches the tracker; negative
            // `speed` becomes `nil`; the timestamp is the fix's own, in
            // milliseconds (`Date.millisecondsSince1970`, declared in
            // Runtime/HostBridge.swift and reused here), which is what
            // makes a deferred delivery honest against `SAMPLE_MAX_AGE_MS`.
            // Nothing else on `CLLocation` is read - no altitude, no
            // course, no floor (Section 6.6's closing paragraph; O-I3
            // tracks the direction-of-travel cone this drops).
            guard location.horizontalAccuracy >= 0 else {
                droppedInvalidFixesCount += 1
                continue
            }
            let sample = Sample(
                lat: location.coordinate.latitude,
                lon: location.coordinate.longitude,
                accuracy: location.horizontalAccuracy,
                speed: location.speed >= 0 ? location.speed : nil,
                timestamp: location.timestamp.millisecondsSince1970
            )
            onSample?(sample)
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        let accuracy = manager.accuracyAuthorization

        // Section 6.2: Apple's own documentation warns
        // `CLLocationManager.locationServicesEnabled()` can block the
        // calling thread. This delegate callback arrives on whichever
        // thread the manager was created on - the main thread, here - so
        // the one call that needs it hops off first, and only that call.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let servicesEnabled = CLLocationManager.locationServicesEnabled()
            let authorization = Authorization(
                status: Self.mapStatus(status),
                accuracy: Self.mapAccuracy(accuracy),
                servicesEnabled: servicesEnabled
            )
            self?.onAuthorizationChange?(authorization)
        }
    }

    private static func mapStatus(_ status: CLAuthorizationStatus) -> AuthorizationStatus {
        switch status {
        case .notDetermined:
            return .notDetermined
        case .restricted:
            return .restricted
        case .denied:
            return .denied
        case .authorizedAlways:
            return .authorizedAlways
        case .authorizedWhenInUse:
            return .authorizedWhenInUse
        @unknown default:
            return .notDetermined
        }
    }

    private static func mapAccuracy(_ accuracy: CLAccuracyAuthorization) -> AccuracyAuthorization {
        switch accuracy {
        case .fullAccuracy:
            return .fullAccuracy
        case .reducedAccuracy:
            return .reducedAccuracy
        @unknown default:
            return .reducedAccuracy
        }
    }
}
