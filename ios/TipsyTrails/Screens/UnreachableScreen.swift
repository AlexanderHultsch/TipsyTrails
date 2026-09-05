import SwiftUI

// ios/SPEC.md Section 11.4: "Shown in place of the web view when the
// initial load of SERVER_ORIGIN fails and there is no cached shell to show -
// a fresh install with no connectivity. One sentence, one 'Try again'. Once
// the web app has loaded once, its own service worker owns the offline case
// (SPEC.md 12, Phase 8) and this screen is not shown."
//
// That last rule is why this view is shown or hidden by App/'s own
// `AppRootState.showUnreachable`, latched permanently false the first time
// `WKNavigationDelegate.webView(_:didFinish:)` fires - the wiring that
// delegate needs lives in App/TipsyTrailsApp.swift, not here, because
// Web/WebViewController.swift (F2b) is outside this substep's file scope
// (I7) and already owns `WKNavigationDelegate` for its own reason (Section
// 8.5's host-confinement policy); this screen only ever renders what
// `AppRootState` already decided and asks it to try again.
struct UnreachableScreen: View {
    let onTryAgain: () -> Void

    var body: some View {
        VStack(spacing: Metrics.sectionSpacing) {
            Spacer()

            WordmarkView(prominence: .hero)

            Text("Tipsy Trails could not reach its server. Check your connection and try again.")
                .font(.body)
                .foregroundStyle(Metrics.inkColor)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()

            Button(action: onTryAgain) {
                PrimaryButtonLabel(title: "Try again")
            }
        }
        .padding(Metrics.screenPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Metrics.paperColor)
    }
}
