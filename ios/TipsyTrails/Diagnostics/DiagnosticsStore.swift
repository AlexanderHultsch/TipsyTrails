import CryptoKit
import Foundation
import UIKit

// ios/SPEC.md Section 7.8: the daily buckets, in `UserDefaults`, for
// `TRACKER_DIAGNOSTIC_DAYS` days. This is the shell's half of Section 7.8 -
// `packages/tracker/src/counters.ts` builds the closed set of counts this
// file merely stores; nothing here invents a counter or reads inside one.
final class DiagnosticsStore {
    private let defaults: UserDefaults

    // Section 7.1: "TRACKER_DIAGNOSTIC_DAYS: 7... daily counter buckets
    // kept on the device." I1 forbids a Swift literal standing in for this
    // - App/'s composition root reads it from the tracker bundle's own
    // `config` (Runtime/TrackerRuntime.swift's `configNumber`, the same way
    // that file already reads `TRACKER_RESTART_MIN_INTERVAL_MS`) and sets
    // it here once the bundle has evaluated. `1` is this property's own
    // starting value for the brief window before that read completes, not
    // a second copy of the constant - a store that has not been told the
    // real window yet keeps only today's bucket rather than guessing.
    var retentionDays = 1

    private static let bucketsKey = "com.ahultsch.tipsytrails.diagnostics.buckets"
    private static let lastRunAtKey = "com.ahultsch.tipsytrails.diagnostics.lastRunAt"
    private static let lastExceptionKey = "com.ahultsch.tipsytrails.diagnostics.lastExceptionMessage"

    // Section 7.8: "Berlin days, computed by the shared helper the badge
    // job uses - berlinDateString in packages/shared." This package cannot
    // import `packages/shared` (I7's own boundary runs the other way here:
    // this is Swift, and `berlinDateString` is TypeScript), so this
    // `DateFormatter` restates the same definition - Europe/Berlin, the
    // calendar day - by hand. The two must agree;
    // `packages/shared/src/berlin-time.test.ts` pins the TypeScript side
    // down, and there is nothing here that could compile to check the
    // Swift side against it (Section 13.1), so this comment is the only
    // thing standing between the two drifting unnoticed.
    private static let berlinDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "Europe/Berlin")
        return formatter
    }()

    private static var berlinCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin") ?? .current
        return calendar
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private static func berlinDay(for date: Date) -> String {
        berlinDayFormatter.string(from: date)
    }

    // Section 7.8's closing sentence, and I2: "It contains no position, no
    // cell index, no bar id and no bar name." `counters` here is exactly
    // whatever Runtime/TrackerRuntime.swift's `snapshotCounters` handed
    // back - `packages/tracker/src/counters.ts`'s own closed set, where
    // every field is already an integer, a timestamp, or the one message
    // string 7.8 names, never a coordinate. This write path adds nothing of
    // its own that could be one; it only files the dictionary under today's
    // Berlin day and prunes what has aged out.
    func record(counters: [String: Any], at date: Date = Date()) {
        var dailyBuckets = loadBuckets()
        dailyBuckets[Self.berlinDay(for: date)] = Self.plistSafe(counters)
        prune(&dailyBuckets, referenceDate: date)
        saveBuckets(dailyBuckets)
        defaults.set(date.timeIntervalSince1970, forKey: Self.lastRunAtKey)
    }

    // `counters.ts`'s own closed set carries one field that is `null` on a
    // fresh tracker - `process.lastExceptionMessage` - and `JSValue.
    // toDictionary()` (Runtime/TrackerRuntime.swift's `snapshotCounters`)
    // turns a JavaScript `null` into `NSNull`, which `UserDefaults` cannot
    // store: a property list has no `null`, and writing one anywhere in the
    // graph silently drops the whole write rather than half-storing it.
    // This walks the dictionary this store was handed and omits every key
    // whose value is `NSNull`, recursively, before it ever reaches
    // `saveBuckets` - the omission itself is not information lost, since
    // "the key is absent" already means "nothing to report" for a field
    // that can only ever be a message or nothing.
    private static func plistSafe(_ dictionary: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in dictionary {
            if value is NSNull {
                continue
            }
            if let nested = value as? [String: Any] {
                result[key] = plistSafe(nested)
            } else {
                result[key] = value
            }
        }
        return result
    }

    // Section 4.4/7.8: "the context's exceptionHandler logs it, counts it...
    // last exception message." Runtime/TrackerRuntime.swift's own
    // `handleException` has nowhere durable to keep this across a context
    // recreation - the crash it is reporting is what wipes the JS state a
    // counters snapshot would otherwise hold it in - so it is kept here
    // instead, independently of `record` above, and survives exactly the
    // event it describes.
    func recordException(_ message: String, at date: Date = Date()) {
        defaults.set(message, forKey: Self.lastExceptionKey)
    }

    // Section 11.3: "the last time the tracker ran."
    var lastRunAt: Date? {
        let interval = defaults.double(forKey: Self.lastRunAtKey)
        return interval > 0 ? Date(timeIntervalSince1970: interval) : nil
    }

    // Section 11.3: "the last exception if any."
    var lastExceptionMessage: String? {
        defaults.string(forKey: Self.lastExceptionKey)
    }

    // Section 11.3: "Every counter of 7.8 for today and for the retained
    // days" - the Diagnostics screen's (F3, not yet built) own source for
    // that table.
    func buckets() -> [String: [String: Any]] {
        loadBuckets()
    }

    // Section 7.8: "The report is those buckets plus the device model, iOS
    // version, app version, tracker bundle hash, authorization pair, and
    // the timestamp of the last time the tracker ran... exported through
    // the share sheet as JSON." `authorization` is supplied by the caller
    // (F3's Diagnostics screen) rather than held here - this store has no
    // standing relationship with Location/LocationEngine.swift and Section
    // 7.8 asks for the pair as a value, not a subscription.
    func buildReport(authorization: Authorization) -> Data {
        var report: [String: Any] = [
            "buckets": loadBuckets(),
            "device": [
                "model": UIDevice.current.model,
                "systemVersion": UIDevice.current.systemVersion,
                "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
                    ?? "unknown",
                "trackerBundleHash": Self.trackerBundleHash(),
            ],
            "authorization": [
                "status": authorization.status.rawValue,
                "accuracy": authorization.accuracy.rawValue,
                "servicesEnabled": authorization.servicesEnabled,
            ],
        ]
        if let lastRunAt {
            report["lastRunAt"] = lastRunAt.timeIntervalSince1970
        }
        if let lastExceptionMessage {
            report["lastExceptionMessage"] = lastExceptionMessage
        }
        return (try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    }

    // Section 7.8: the same "tracker bundle hash" Web/WebViewController.swift
    // computes for its own `trackerVersion` field - restated here rather
    // than shared, for that file's own reason: both read the same
    // `tracker.js` and SHA-256 is deterministic, so the two figures cannot
    // disagree without the bundle itself being corrupt, which is a larger
    // problem than the duplication.
    private static func trackerBundleHash() -> String {
        guard
            let url = Bundle.main.url(forResource: "tracker", withExtension: "js"),
            let data = try? Data(contentsOf: url)
        else { return "unknown" }
        return SHA256.hash(data: data).description
    }

    private func loadBuckets() -> [String: [String: Any]] {
        defaults.dictionary(forKey: Self.bucketsKey) as? [String: [String: Any]] ?? [:]
    }

    private func saveBuckets(_ dailyBuckets: [String: [String: Any]]) {
        defaults.set(dailyBuckets, forKey: Self.bucketsKey)
    }

    // Section 7.8: "Prunes buckets older than the retention window on every
    // write." A day string older than `retentionDays` Berlin days before
    // `referenceDate`'s own Berlin day (inclusive of today, so
    // `retentionDays` days survive in total) is dropped. String comparison
    // is correct here because 'yyyy-MM-dd' sorts lexicographically exactly
    // as it sorts chronologically.
    private func prune(_ dailyBuckets: inout [String: [String: Any]], referenceDate: Date) {
        guard
            let cutoffDate = Self.berlinCalendar.date(
                byAdding: .day,
                value: -(retentionDays - 1),
                to: referenceDate
            )
        else { return }
        let cutoffDay = Self.berlinDay(for: cutoffDate)
        dailyBuckets = dailyBuckets.filter { entry in entry.key >= cutoffDay }
    }
}
