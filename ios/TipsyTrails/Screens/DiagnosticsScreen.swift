import SwiftUI
import UIKit

// ios/SPEC.md Section 11.3: "Reached from the Consent screen's footer.
// Every counter of 7.8 for today and for the retained days, the current
// state of the tracker, the authorization pair, the low-power flag, the
// last time the tracker ran, and the last exception if any. A 'Share
// report' button exports the JSON of 7.8 through the share sheet. This
// screen exists for the walk of 13.3 and stays in the app afterwards; it
// holds nothing a player should not see about their own phone."
//
// "The current state of the tracker, the authorization pair, the low-power
// flag" are Section 7.8's own words for why they are NOT counters:
// "those live values reach the Diagnostics screen from the tracking event
// of Section 7.5 and from the tracker's own state, which is where a live
// value belongs." `trackerState` (an `App/TipsyTrailsApp.swift`
// `TrackerStateObserver`, populated from exactly that event) is this
// screen's source for all three; `diagnosticsStore` is Section 7.8's own
// counters, unchanged from Diagnostics/DiagnosticsStore.swift (F2a).
struct DiagnosticsScreen: View {
    let trackerRuntime: TrackerRuntime
    let diagnosticsStore: DiagnosticsStore
    @ObservedObject var trackerState: TrackerStateObserver

    @State private var buckets: [String: [String: Any]] = [:]
    @State private var reportData: Data?
    @State private var isSharePresented = false

    var body: some View {
        List {
            Section("Tracker") {
                LabeledRow(label: "State", value: trackerState.trackingState)
                LabeledRow(label: "Profile", value: trackerState.profile ?? "-")
                LabeledRow(label: "Blocked reason", value: trackerState.blockedReason ?? "-")
                LabeledRow(label: "iOS authorization", value: trackerState.authorizationStatus.rawValue)
                LabeledRow(label: "Location accuracy", value: trackerState.accuracyAuthorization.rawValue)
                LabeledRow(label: "Low Power Mode", value: trackerState.lowPower ? "On" : "Off")
                LabeledRow(label: "Tracker last ran", value: lastRunDescription)
                if let lastExceptionMessage = diagnosticsStore.lastExceptionMessage {
                    LabeledRow(label: "Last exception", value: lastExceptionMessage)
                }
            }
            .listRowBackground(Metrics.paperColor)

            // Section 7.8's own closing argument: "a test in
            // packages/tracker walks the counter set generically... so a
            // counter added later is covered without anyone remembering
            // to." `Self.flatten` below does the same on the shell side -
            // every day's bucket is rendered from whatever keys it holds,
            // never from a list of counter names copied out of 7.8 by hand.
            ForEach(sortedDays, id: \.self) { day in
                Section(day) {
                    ForEach(Self.flatten(buckets[day] ?? [:]), id: \.key) { entry in
                        LabeledRow(label: entry.key, value: entry.value)
                    }
                }
                .listRowBackground(Metrics.paperColor)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Metrics.paperColor)
        .navigationTitle("Diagnostics")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Share report", action: shareReport)
            }
        }
        .onAppear(perform: refresh)
        .sheet(isPresented: $isSharePresented) {
            if let reportData {
                DiagnosticsReportActivityView(activityItems: [reportData])
            }
        }
    }

    private var sortedDays: [String] {
        // Section 7.8: "Berlin days"; 'yyyy-MM-dd' sorts lexicographically
        // exactly as it sorts chronologically (the same property
        // Diagnostics/DiagnosticsStore.swift's own `prune` relies on) - most
        // recent day first.
        buckets.keys.sorted(by: >)
    }

    private var lastRunDescription: String {
        guard let lastRunAt = diagnosticsStore.lastRunAt else { return "Never" }
        return Self.dateFormatter.string(from: lastRunAt)
    }

    // Section 7.8: "The tracker emits them on request; the shell persists
    // the daily buckets in UserDefaults." Nothing in F2a or F2b calls
    // `snapshotCounters`/`record` on any cadence - this screen is that
    // caller, refreshing today's bucket every time it is opened so what it
    // shows is never staler than the last visit here.
    private func refresh() {
        trackerRuntime.snapshotCounters { counters in
            diagnosticsStore.record(counters: counters)
            DispatchQueue.main.async {
                buckets = diagnosticsStore.buckets()
            }
        }
    }

    private func shareReport() {
        // Section 7.8: "the authorization pair" the report carries is the
        // same pair this screen already shows, from `trackerState` - not
        // re-queried from Core Location, because Location/LocationEngine.swift
        // (F2a) exposes no synchronous getter for it and this substep's
        // write scope does not extend to that file (flagged in this
        // substep's own report).
        let authorization = Authorization(
            status: trackerState.authorizationStatus,
            accuracy: trackerState.accuracyAuthorization,
            servicesEnabled: trackerState.servicesEnabled
        )
        reportData = diagnosticsStore.buildReport(authorization: authorization)
        isSharePresented = true
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private static func flatten(_ dictionary: [String: Any], prefix: String = "") -> [(key: String, value: String)] {
        dictionary.keys.sorted().flatMap { key -> [(key: String, value: String)] in
            let path = prefix.isEmpty ? key : "\(prefix).\(key)"
            if let nested = dictionary[key] as? [String: Any] {
                return flatten(nested, prefix: path)
            }
            return [(key: path, value: describe(dictionary[key]))]
        }
    }

    private static func describe(_ value: Any?) -> String {
        switch value {
        case let number as NSNumber:
            return number.stringValue
        case let text as String:
            return text
        case is NSNull, .none:
            return "-"
        default:
            return String(describing: value as Any)
        }
    }
}

// Not `private`: Screens/ConsentScreen.swift's own status section reuses
// this exact row rather than defining a second one for the same "label,
// value" shape.
struct LabeledRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(Metrics.inkColor)
            Spacer()
            Text(value)
                .foregroundStyle(Metrics.inkColor)
        }
    }
}

// Section 11.3: "A 'Share report' button exports the JSON of 7.8 through
// the share sheet." `UIActivityViewController` has no SwiftUI-native form,
// so this is the standard `UIViewControllerRepresentable` wrapper around it
// - `reportData` is handed straight to it as the one activity item, never
// written to a file of this screen's own first (I2's own words name what
// the report itself may not carry - a coordinate - and say nothing about
// writing the report itself to disk, which the share sheet's own recipient,
// not this app, may choose to do).
private struct DiagnosticsReportActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
