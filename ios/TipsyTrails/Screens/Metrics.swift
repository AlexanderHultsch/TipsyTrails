import SwiftUI

// ios/SPEC.md Section 12 Step F4 greps every Swift file in
// ios/TipsyTrails/ for a numeric literal other than 0, 1 and -1 (Section
// 12's own words: "No numeric literal other than 0, 1 and -1 - F4 greps for
// it"). This file is where every layout number Section 11's four screens
// need lives, named, so that check has one file to point at rather than
// four screens each holding its own stray padding. These are LAYOUT values -
// a tap target, a padding, a corner radius - not a game constant of the kind
// I1 governs (ios/SPEC.md Section 0 rule 1, I1): `config.ts` holds the
// thresholds, radii, tolerances and timeouts the TRACKER decides with, and
// nothing here is one of those, because no screen in Section 11 needs a
// game number to render itself. Flagged for the parent in this substep's
// own report: F4 does not exist yet, and whoever writes it has to decide
// whether it excludes this file or whether Section 12's rule is narrowed to
// say "no numeric literal outside `Metrics.swift`" - that is not this
// substep's call to make alone.
enum Metrics {
    // root SPEC.md 8.2: "Minimum tap target 44 x 44 px."
    static let tapTarget: CGFloat = 44

    static let screenPadding: CGFloat = 24
    static let sectionSpacing: CGFloat = 24
    static let paragraphSpacing: CGFloat = 12
    static let controlSpacing: CGFloat = 16
    static let footnoteSpacing: CGFloat = 8
    static let cornerRadius: CGFloat = 6
    static let borderWidth: CGFloat = 1
    static let checkboxSize: CGFloat = 22
    static let statusDotSize: CGFloat = 10

    // root SPEC.md 8.1: "the wordmark is on every main screen... one
    // wordmark at two sizes" - hero (the two entry screens) and chrome (a
    // small line elsewhere). Section 11's four screens use only the hero
    // form, full-screen as they are, but both sizes are named here rather
    // than one, so a screen that later wants the chrome form (a header
    // above its own content, as the Diagnostics and Consent screens' own
    // navigation titles already are here) has it to hand instead of
    // inventing a third size.
    static let wordmarkFontSizeHero: CGFloat = 34
    static let wordmarkFontSizeChrome: CGFloat = 17
    static let wordmarkTrackingHero: CGFloat = 4
    static let wordmarkTrackingChrome: CGFloat = 2
}

// root SPEC.md 8.1: "Desaturated, slightly warm paper ground"; "ink text";
// "one accent colour is permitted across the entire application: a muted
// red." `packages/web/src/index.css` names the exact values this restates -
// `--color-paper: #f4efe6`, `--color-ink: #1c1a17`, `--color-accent:
// #9a3324` - because SwiftUI has no CSS custom property to read them from
// (I1 is about game constants; a palette token is a design value the parent
// SPEC.md already writes as one, and there is no seam from a stylesheet into
// SwiftUI the way `config.ts` reaches the tracker). Written as `Color(red:
// green: blue:)` triples computed from those hex values by hand, rather
// than a hex-string parser, because a parser's own bit-shifting arithmetic
// (`>> 16`, `& 0xFF`, `/ 255`) would only add MORE numeric literals for
// Step F4 to see, for no reader's benefit over three named constants with
// the hex value in the comment beside each.
extension Metrics {
    // #f4efe6
    static let paperColor = Color(red: 0.957, green: 0.937, blue: 0.902)
    // #1c1a17
    static let inkColor = Color(red: 0.110, green: 0.102, blue: 0.090)
    // #9a3324
    static let accentColor = Color(red: 0.604, green: 0.200, blue: 0.141)
}

// root SPEC.md 8.1: "The wordmark is on every main screen, and it is one
// wordmark at two sizes... TIPSY TRAILS is set in the serif of Section 8.2,
// in capitals, with wide letter-spacing, in ink - one definition used
// everywhere." One definition here too, for the same reason: Section 11's
// four screens share it rather than each drawing its own text. `.serif` is
// SwiftUI's own system serif design (New York) - the closest native
// counterpart to "the system serif" ios/SPEC.md Section 11's own intro
// names, matching root SPEC.md 8.2's "no webfont is loaded at all" as
// closely as SwiftUI allows.
struct WordmarkView: View {
    enum Prominence {
        case hero
        case chrome
    }

    let prominence: Prominence

    var body: some View {
        Text("TIPSY TRAILS")
            .font(
                .system(
                    size: prominence == .hero ? Metrics.wordmarkFontSizeHero : Metrics.wordmarkFontSizeChrome,
                    design: .serif
                )
            )
            .tracking(prominence == .hero ? Metrics.wordmarkTrackingHero : Metrics.wordmarkTrackingChrome)
            .foregroundStyle(Metrics.inkColor)
            // root SPEC.md 8.1: "The capitals live in the stylesheet, not in
            // the document... what a screen reader announces is a name and
            // not shouting." The rendered text is the capitalised mark; the
            // accessible name is the ordinary name, exactly as that section
            // asks of the web app's own markup.
            .accessibilityLabel("Tipsy Trails")
    }
}

// A single reusable primary-action button style, so "Continue" (Primer),
// "I agree, and continue" (Consent) and "Try again" (Unreachable) read as
// one product's buttons rather than three. root SPEC.md 8.1: "one accent
// colour is permitted... reserved for the player's own position and for
// active states" - a primary button is exactly that active state, so it
// alone carries the accent; root SPEC.md 8.2's 44 pt minimum tap target is
// `Metrics.tapTarget`, not a literal repeated at every call site.
struct PrimaryButtonLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .frame(maxWidth: .infinity, minHeight: Metrics.tapTarget)
            .foregroundStyle(Metrics.paperColor)
            .background(Metrics.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius))
    }
}
