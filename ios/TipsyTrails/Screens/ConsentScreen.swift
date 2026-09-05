import SwiftUI
import UIKit
import UserNotifications
import WebKit

// ios/SPEC.md Section 11.2, and Section 10.1 is the authority on its
// content - reached from the web app's Settings row (8.6), from the
// indicator's panel when tracking is "on while open only", and from
// `requestNotifications` (App/TipsyTrailsApp.swift's `AppWebBridgeDelegate`
// presents this screen for both of those bridge messages, since 8.2's own
// table sends both here). It holds the four steps of 10.1 in order, then a
// notifications section, then the current state of each of the three things
// a player might be confused by, then withdrawal behind a confirmation.
//
// **Apple's permission dialog is not this consent (10.1).** A player who
// grants Always in iOS from this screen's own step 4 and has NOT checked
// the box in step 3 is not tracked in the background (5.4) - `recordConsent`
// below only runs once the checkbox is checked, and it is what asks the web
// view to write consent (5.4) and only then requests Always (6.2's step
// two); nothing here treats iOS's own answer as if it were the consent
// itself. This is the one rule in this file most tempting to simplify away,
// so it is stated here as plainly as 10.1 states it.
struct ConsentScreen: View {
    let locationEngine: LocationEngine
    let notificationCentre: NotificationCentre
    let trackerRuntime: TrackerRuntime
    let diagnosticsStore: DiagnosticsStore
    let webViewController: WebViewController
    @ObservedObject var trackerState: TrackerStateObserver
    // Section 5.4: "the shell learns the result back through the tracker's
    // next start" - App/TipsyTrailsApp.swift owns assembling a fresh
    // `start` call (it already assembles the first one, at launch) and
    // hands this screen a closure rather than the pieces (the cookie
    // provider, the app state) that call needs, so this screen stays a
    // consumer of `TrackerRuntime`'s public surface and not a second place
    // that reassembles its input.
    let onConsentChanged: () -> Void
    let onDismiss: () -> Void

    static let discoveryNotificationsDefaultsKey = "com.ahultsch.tipsytrails.discoveryNotificationsEnabled"

    @State private var hasCheckedConsentSentence = false
    @State private var isWithdrawConfirmationPresented = false
    @State private var notificationAuthorizationStatus: UNAuthorizationStatus = .notDetermined
    @AppStorage(ConsentScreen.discoveryNotificationsDefaultsKey) private var discoveryNotificationsEnabled = true

    var body: some View {
        NavigationStack {
            List {
                explanationSection
                howToStopSection
                consentSection
                statusSection
                notificationsSection
                withdrawSection
                diagnosticsSection
            }
            .scrollContentBackground(.hidden)
            .background(Metrics.paperColor)
            .navigationTitle("Background tracking")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                }
            }
        }
        // root SPEC.md 8.1: "one accent colour is permitted across the
        // entire application" - without this, SwiftUI's toolbar buttons,
        // the Toggle above and DiagnosticsScreen's own toolbar (pushed
        // inside this same NavigationStack, and inheriting this tint)
        // would fall back to the system's own blue rather than the one
        // accent this application allows.
        .tint(Metrics.accentColor)
        .onAppear(perform: refreshNotificationAuthorization)
    }

    // MARK: - Section 10.1 step 1

    private var explanationSection: some View {
        Section {
            Text(
                "With your consent, Tipsy Trails can keep checking your position while the app is closed. "
                    + "Your phone sends its position to the game's server, which turns it into revealed map "
                    + "squares and bar visits and keeps no trail of where you have been. Cloudflare carries "
                    + "the request to the server. iOS shows a status bar indicator the whole time this runs, "
                    + "and it uses some extra battery."
            )
            .foregroundStyle(Metrics.inkColor)
        } header: {
            Text("What background tracking does")
        }
        .listRowBackground(Metrics.paperColor)
    }

    // MARK: - Section 10.1 step 2

    private var howToStopSection: some View {
        Section {
            Text(
                "You can stop it at any time: on this screen, from the Background tracking row in the "
                    + "web app's Settings, or by turning off Location for Tipsy Trails in iOS Settings. "
                    + "Any of the three stops it at once."
            )
            .foregroundStyle(Metrics.inkColor)
        } header: {
            Text("How to stop")
        }
        .listRowBackground(Metrics.paperColor)
    }

    // MARK: - Section 10.1 steps 3 and 4

    private var consentSection: some View {
        Section {
            Button(action: { hasCheckedConsentSentence.toggle() }) {
                HStack(alignment: .top, spacing: Metrics.controlSpacing) {
                    Image(systemName: hasCheckedConsentSentence ? "checkmark.square.fill" : "square")
                        .font(.system(size: Metrics.checkboxSize))
                        .foregroundStyle(hasCheckedConsentSentence ? Metrics.accentColor : Metrics.inkColor)
                    // Section 10.1: "A checkbox, unchecked, with the consent
                    // sentence." This is that sentence - true and specific
                    // (this substep's own style rule): it names what is
                    // sent, when, and what the server does with it, and
                    // promises nothing beyond that.
                    Text(
                        "I agree that Tipsy Trails may check my position and send it to the game's server "
                            + "while the app is closed, so fog keeps clearing and bar visits still count."
                    )
                    .foregroundStyle(Metrics.inkColor)
                    .multilineTextAlignment(.leading)
                }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(hasCheckedConsentSentence ? [.isSelected] : [])

            Button(action: recordConsent) {
                PrimaryButtonLabel(title: "I agree, and continue")
            }
            // Section 10.1: "the button that records it is disabled until
            // it is checked."
            .disabled(!hasCheckedConsentSentence)
        } header: {
            Text("Your consent")
        } footer: {
            // Section 10.1: "Only then, the iOS prompt for Always."
            Text("Only after this does iOS ask whether to allow Always access.")
        }
        .listRowBackground(Metrics.paperColor)
    }

    private func recordConsent() {
        webViewController.requestSettingsUpdate(backgroundTracking: true)
        // Section 10.1: "Only then, the iOS prompt for Always" - step 4
        // runs only from here, after `recordConsent` is reachable at all
        // only once the checkbox of step 3 is checked (`.disabled`, above).
        // That ordering is 10.1's legal basis for asking Always - the
        // player has already said yes in the app's own words - not a
        // nicety, so it is worth keeping this call after, never before,
        // `requestSettingsUpdate` above.
        locationEngine.requestAlwaysAuthorization()
        onConsentChanged()
    }

    // MARK: - Current status (11.2: "so it is also where a player sees why
    // background tracking is off")

    private var statusSection: some View {
        Section {
            LabeledRow(label: "Background tracking", value: consentAndTrackingDescription)
            LabeledRow(label: "iOS location authorization", value: authorizationDescription)
            LabeledRow(label: "Notifications", value: notificationAuthorizationDescription)
            if trackerState.accuracyAuthorization == .reducedAccuracy {
                Button("Enable precise location", action: locationEngine.requestTemporaryFullAccuracy)
            }
            if trackerState.authorizationStatus == .denied || trackerState.authorizationStatus == .restricted {
                // Section 6.2: "the shell says so and offers the Settings
                // deep link."
                Button("Open Settings", action: openSystemSettings)
            }
        } header: {
            Text("Current status")
        }
        .listRowBackground(Metrics.paperColor)
    }

    // Section 7.5's own `tracking` event carries `background` (is
    // background tracking actually running) and the authorization pair, but
    // no separate "consent on the account" boolean - the tracker has no
    // event for that alone (5.4: it only ever re-reads consent through a
    // fresh `start`). This is derived rather than invented: 5.4/7.3's own
    // rule is that `background` is true only when consent is given AND
    // authorization is Always, so `background == false` with
    // `authorizedAlways` already granted can only mean consent is the
    // remaining reason - the three-way split below has no ambiguous case.
    // Flagged in this substep's own report as an inference rather than a
    // field this substep invented on the wire.
    private var consentAndTrackingDescription: String {
        if trackerState.backgroundActive {
            return "On"
        }
        if trackerState.authorizationStatus != .authorizedAlways {
            return "Off - iOS has not granted Always access yet"
        }
        return "Off - you have not agreed above yet"
    }

    private var authorizationDescription: String {
        switch trackerState.authorizationStatus {
        case .notDetermined:
            return "Not asked yet"
        case .denied:
            // Section 6.2's "third field": denied with Location Services
            // off device-wide gets its own words, naming the global switch
            // rather than the app (Section 6.5's own rule).
            return trackerState.servicesEnabled ? "Denied" : "Location Services are off"
        case .restricted:
            return "Restricted"
        case .authorizedWhenInUse:
            return "While using the app"
        case .authorizedAlways:
            return "Always"
        }
    }

    private var notificationAuthorizationDescription: String {
        switch notificationAuthorizationStatus {
        case .notDetermined:
            return "Not asked yet"
        case .denied:
            return "Denied"
        case .authorized, .provisional, .ephemeral:
            return "Allowed"
        @unknown default:
            return "Unknown"
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func refreshNotificationAuthorization() {
        notificationCentre.currentAuthorizationStatus { status in
            notificationAuthorizationStatus = status
        }
    }

    // MARK: - Section 7.7's four notifications, and the one switch

    private var notificationsSection: some View {
        Section {
            Text(
                "Tipsy Trails schedules four notifications on this device, never through a push service: "
                    + "a reminder if a check-in is about to expire, a bar mastered, bars discovered nearby, "
                    + "and being signed out."
            )
            .foregroundStyle(Metrics.inkColor)
            Toggle("Bars discovered", isOn: $discoveryNotificationsEnabled)
                .tint(Metrics.accentColor)
                .onChange(of: discoveryNotificationsEnabled) { _, newValue in
                    // Runtime/TrackerRuntime.swift: "setDiscoveryNotifications(on):
                    // void - the shell's own UserDefaults preference (Section
                    // 7.7's decision (a)), mirrored here whenever it changes."
                    trackerRuntime.setDiscoveryNotifications(newValue)
                }
            Button("Allow notifications", action: requestNotificationAuthorization)
        } header: {
            Text("Notifications")
        } footer: {
            Text(
                "The reminder and the bar-mastered notification cannot be turned off separately - they "
                    + "are the mechanic's own transparency, not a nicety (Section 7.7)."
            )
        }
        .listRowBackground(Metrics.paperColor)
    }

    private func requestNotificationAuthorization() {
        notificationCentre.requestAuthorization { _ in
            refreshNotificationAuthorization()
        }
    }

    // MARK: - Withdrawal

    private var withdrawSection: some View {
        Section {
            Button("Stop background tracking", role: .destructive) {
                isWithdrawConfirmationPresented = true
            }
            .confirmationDialog(
                "Stop background tracking?",
                isPresented: $isWithdrawConfirmationPresented,
                titleVisibility: .visible
            ) {
                Button("Stop background tracking", role: .destructive, action: withdrawConsent)
                Button("Cancel", role: .cancel) {}
            } message: {
                // Section 11.2: "behind a confirmation that names what it
                // stops and what it keeps (everything revealed so far)."
                Text(
                    "Your phone will stop sending your position while the app is closed. Everything you "
                        + "have already revealed on the map stays revealed."
                )
            }
        }
        .listRowBackground(Metrics.paperColor)
    }

    private func withdrawConsent() {
        webViewController.requestSettingsUpdate(backgroundTracking: false)
        hasCheckedConsentSentence = false
        onConsentChanged()
    }

    // MARK: - Section 11.3: "Reached from the Consent screen's footer."

    private var diagnosticsSection: some View {
        Section {
            NavigationLink("Diagnostics") {
                DiagnosticsScreen(
                    trackerRuntime: trackerRuntime,
                    diagnosticsStore: diagnosticsStore,
                    trackerState: trackerState
                )
            }
        } footer: {
            Text("What the tracker has done on this phone, for the walk that proves it (Section 13.3).")
        }
        .listRowBackground(Metrics.paperColor)
    }
}

// ios/SPEC.md Section 5.4: "The shell sets it through the web app rather
// than directly: the consent screen (Section 11.2) is native, and on the
// player's confirmation the shell asks the web view to call the settings
// endpoint, so there is one client that writes settings and it is the one
// that already does." Section 8.2's page<->shell bridge table (built on
// `main`, not this branch, under I7) has no shell-to-page call for this yet.
// Narrowly defined here, mirroring Web/WebViewController.swift's own
// `dispatch`'s guarded-call idiom ("window.__tipsyTrails &&
// window.__tipsyTrails.dispatch(...)") - a page that has not yet
// implemented `requestSettingsUpdate` on its own `window.__tipsyTrails`
// object simply ignores this call rather than throwing. Defined here, in
// Screens/, rather than in Web/WebViewController.swift itself, because this
// substep's write scope is Screens/ and App/TipsyTrailsApp.swift only (I7).
// Flagged in this substep's own report as a new shell-to-page surface that
// belongs in Section 8.2's table and in `packages/web`'s own bridge
// wrapper - the list for `main` this branch cannot write to directly (I7).
extension WebViewController {
    func requestSettingsUpdate(backgroundTracking: Bool) {
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript(
                "window.__tipsyTrails && window.__tipsyTrails.requestSettingsUpdate && "
                    + "window.__tipsyTrails.requestSettingsUpdate(\(backgroundTracking));"
            )
        }
    }
}
