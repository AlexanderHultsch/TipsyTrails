import SwiftUI

// ios/SPEC.md Section 11.1: "Shown once, on first launch, before the web
// view. The wordmark; three sentences on what the game is and why it needs
// location while the app is open; one button, 'Continue', which requests
// When In Use (6.2). A player who declines lands on the web app with the
// indicator saying blocked (8.3), and the Primer is not shown again - the
// way back is iOS Settings, and the indicator's panel links there. A player
// who already has an authorization state other than .notDetermined never
// sees this screen."
//
// This view holds no state of its own and makes no authorization decision -
// App/TipsyTrailsApp.swift's `RootView` reads the live, synchronous
// `CLLocationManager().authorizationStatus` once, before this view is ever
// asked for, exactly as this section's last sentence requires ("never sees
// this screen"), and only presents this screen when that read is
// `.notDetermined`. Tapping "Continue" calls
// Location/LocationEngine.swift's own `requestWhenInUseAuthorization()`
// (Section 6.2's step one, the WhenInUse half of the two-step order) through
// `onContinue`, and the caller moves on to the web view regardless of what
// iOS answers - a decline is a supported state (6.2's own table), not an
// error this screen has anything further to say about. What happens after a
// decline (the indicator saying blocked, the way back through iOS Settings)
// is the web app's indicator panel, `packages/web`'s Step D, built on
// `main` under I7 and not this branch.
struct PrimerScreen: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: Metrics.sectionSpacing) {
            Spacer()

            WordmarkView(prominence: .hero)

            // Section 11.1: "three sentences on what the game is and why it
            // needs location while the app is open" - plain, English (C9),
            // promising nothing the app does not do (this substep's own
            // style rule): this screen asks only for When In Use, so it
            // says only what When In Use is for.
            VStack(alignment: .leading, spacing: Metrics.paragraphSpacing) {
                Text("Tipsy Trails is a map that clears as you walk through Karlsruhe and reveals the bars around you.")
                Text("While the app is open, it checks your position to show you the streets and bars nearby.")
                Text("iOS will ask for permission next. Allowing it while the app is in use is enough to play.")
            }
            .font(.body)
            .foregroundStyle(Metrics.inkColor)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)

            Spacer()

            Button(action: onContinue) {
                PrimaryButtonLabel(title: "Continue")
            }
            .accessibilityHint("Asks iOS for permission to use your location while the app is open.")
        }
        .padding(Metrics.screenPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Metrics.paperColor)
    }
}
