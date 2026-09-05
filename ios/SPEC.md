# Tipsy Trails — iOS Companion Specification

**Version:** 0.4
**Status:** Specified, nothing built. A draft for the owner's review before any code lands.
**Parent:** `SPEC.md` at the repository root, v1.58. This document does not replace it and cannot contradict it; Section 14 here lists the amendments the parent needs before this one is in force.
**Keeping up with `main`:** `ios/PARENT-CONTRACT.md` — the list of what this app depends on in the parent, the record of every merge from `main`, and what to do when the pin above and the parent's version disagree. `packages/shared/src/ios-parent-pin.test.ts` fails until they agree, so the decision cannot be skipped by being forgotten.
**Repository:** https://github.com/AlexanderHultsch/TipsyTrails, branch `ios-app`
**Target device:** iPhone, iOS 17.0 or later
**Distribution:** TestFlight (internal testers) or Ad Hoc — not the App Store (Section 4.3)

---

## What this is

Tipsy Trails is played in a mobile browser, and a browser cannot follow a player who has put the phone in a pocket. `SPEC.md` Section 7.2 says so in one sentence — _"The app cannot receive positions in the background. This is a browser platform limitation, not a design choice"_ — and the whole game is shaped around that limit: fog clears only while the map is on screen, and mastering is deliberately two moments twenty minutes apart rather than a stay the app could witness.

The owner's report is that this is unrealistic on the street. Nobody walks across Karlsruhe holding a lit phone. The map reveals a few streets around each place the app was opened and nothing in between, and the game as played looks like a game that does not work.

This document specifies an iPhone app that fixes exactly that, and as little else as possible. It has three parts:

- **The shell** — a native Swift app that owns location permissions, a background location session, and a JavaScript runtime. It contains no game logic and holds no constant of its own.
- **The tracker** — a TypeScript module, `packages/tracker`, that owns every decision the phone makes about a position sample: what to queue, when to post, what to drop, what to say. It runs inside the shell's JavaScript runtime in the background, and it runs unchanged under Node in this repository's test suite, against the real API and a real SQLite file, replaying a walk through Karlsruhe.
- **The web app** — the existing `packages/web`, loaded into a web view inside the shell, and taught to take its position from the tracker instead of from `navigator.geolocation`.

The server is nearly untouched. Fog reveal, discovery and mastering already happen in `POST /api/samples` (`SPEC.md` 7.3–7.5), so a phone that posts samples in the background gets the whole feature. Section 9 lists the two small additions.

**The shape is chosen for testability, and that is a decision about this environment rather than about iOS.** The sessions that build this repository run on Linux with no Xcode, no Simulator and no iPhone, and the network policy blocks the Swift toolchain. Nothing here can compile a line of Swift. So the Swift is made as small and as free of decisions as it can be, and every decision is put where it can be run: the tracker in TypeScript, under `pnpm test`, beside the 1,427 tests the parent already has. Section 13 states exactly what is proven here and what only the owner's phone can settle, and Section 13.3 is the walk that settles it.

**Where to look**

| Question | Section |
| --- | --- |
| What may this app never do? | 1 |
| Why an app, and why this shape rather than Capacitor or a full native app? | 2 |
| Which exact tools and dependencies? | 3 |
| How do the three parts fit, and how is it built and distributed? | 4 |
| How does the app sign in, and how does the native side share the session? | 5 |
| What can iOS actually do in the background, and what can it not? | 6 |
| What does the tracker decide, and with which numbers? | 7 |
| What changes in the web app when it runs inside the shell? | 8 |
| What changes on the server? | 9 |
| What does GDPR require, and what does the privacy page have to say? | 10 |
| What do the native screens look like? | 11 |
| In what order is this built, and what proves each step? | 12 |
| What is proven here, and what is the owner's walk? | 13 |
| What must change in `SPEC.md`? | 14 |
| What is still open? | 15 |
| How does this branch keep up with `main`? | `PARENT-CONTRACT.md` |

**Section numbers are an interface here as they are in the parent.** Code will cite `ios/SPEC.md Section N.N`. Rewrite freely inside a section; never renumber, merge, split or repurpose one.

---

## 0. How to use this document

The parent's Section 0 applies in full. Three rules are restated because they bind here in ways that are easy to miss:

1. **Every constant lives in `packages/shared/src/config.ts`**, including every number the Swift shell needs. The shell reads none of them from source: the tracker hands the shell its configuration at start (Section 7.2), so a number reaches Swift only by having first been exported from `config.ts`. There is no `Constants.swift`, no `.plist` of thresholds, and no literal in a `CLLocationManager` call. Section 7.1 lists the keys this document adds.
2. **Units.** Everything the tracker holds is in milliseconds or metres, as `config.ts` names it. A Core Location timestamp is converted to milliseconds once, in the shell, at the boundary where a `CLLocation` becomes a tracker sample (Section 6.6); the tracker never converts.
3. **A constraint blocks the way, stop and report.** The parent's Section 1 applies unchanged, and Section 1 below adds six of its own.

---

## 1. Constraints

`SPEC.md` Section 1, C1–C11, applies in full. The ones that bite here: C2 (the Pi serves API and static assets only — the app does nothing that adds computation to the Pi), C3 (no third-party analytics, trackers or SDKs — see I3), C4 (no raw movement trails — see I2), C6 (no secrets in the repository — signing material never enters it), C9 (English only), C11 (reproducible from the repository alone).

Six constraints are added for this app:

| # | Constraint |
| --- | --- |
| I1 | **The shell holds no game logic and no constant.** Every threshold, radius, interval and cap reaches Swift from the tracker, which reads it from `config.ts`. A number in Swift is a defect. |
| I2 | **No position is ever written to disk on the device.** Not the queue, not the last fix, not a diagnostic breadcrumb. The queue is memory and a relaunch starts it empty, exactly as the web app's does (`SPEC.md` 12, Phase 8). The diagnostic report of Section 7.8 carries counts and timestamps and no coordinate. |
| I3 | **No third-party code in the app.** No crash reporter, no analytics, no push service, no background-geolocation SDK. Apple's frameworks and this repository's own code only. C3 already says this for the web; it is restated because iOS makes the temptation stronger. |
| I4 | **One sampler.** Inside the shell the tracker is the only source of position samples. The web app never calls `navigator.geolocation` there and never posts to `POST /api/samples` itself. |
| I5 | **The web app remains the product.** Every game screen is the existing web app in a web view. The shell adds screens only for what a web view cannot do: permissions, consent, diagnostics, and an error page for a server it cannot reach (Section 11). No screen is rebuilt natively. |
| I6 | **Background tracking is opt-in, separately, and reversible.** The foreground game works with "While Using" permission and no consent beyond what the web app already asks. Background tracking needs the player's explicit in-app consent (Section 10.1) and "Always" from iOS, and withdrawing either stops it at once. |

---

## 2. Why an app, and why this shape

### 2.1 The problem is the platform, not the design

The web app's tracking hook (`packages/web/src/tracking/useSampleTracking.ts`) does everything right within what a browser allows: `watchPosition` while the map is mounted, a Screen Wake Lock while it runs, a queue across offline stretches. What no web API on iOS offers is a position while Safari is not in the foreground. There is no background geolocation in a web app, no periodic background sync in Safari, and a home-screen web app is suspended like any tab. `SPEC.md` Section 14's O4 recorded the only way round it — a native app — and scoped it out of v1. This document brings it in.

### 2.2 Three shapes were weighed

**Capacitor**, the shape O4 named. It wraps the web app and adds a background-geolocation plugin. Rejected: the well-maintained plugin is commercial, the community one is a large dependency surface in a repository whose `packages/shared` deliberately has zero runtime dependencies, and everything Capacitor buys here — a web view and a bridge — is a few hundred lines of Swift. What it does not buy is the one thing that matters: the plugin's logic would still be someone else's, untestable here, and outside `config.ts`.

**A full native app** — SwiftUI, MapLibre Native, the fog shader in Metal. Rejected: it reimplements every screen and every rule the parent spent 2,300 lines pinning down, in a language nothing here can compile, and it would have to be kept in step with the web app forever. Months of work to end up with two copies of the game.

**A thin shell around a tested tracker**, the shape chosen. The shell is the part iOS insists must be native — permissions, the background session, notifications, a web view. The tracker is everything with a branch in it. The web app is the game.

### 2.3 What makes the shape work: JavaScriptCore, not the web view

The decision that makes the tracker testable is also the one that makes it run in the background at all, and it is worth stating precisely because the obvious alternative looks the same and fails.

A `WKWebView` runs its JavaScript in a separate WebKit content process. When the app leaves the foreground, iOS throttles that process and then suspends it; timers stop, `fetch` calls do not complete, and nothing in it can be relied on. Putting the tracker in the web view would be the PWA's limitation again with a native wrapper around it.

A `JSContext` from the JavaScriptCore framework runs in the app's own process. While the app is kept alive — which the `location` background mode does for as long as location updates are being delivered — that context keeps executing. The tracker runs there. The web view is a screen, and the tracker does not need it to exist: the shell can be relaunched by iOS without a window (Section 6.4) and run the tracker headless.

JavaScriptCore in a third-party app runs without a JIT. The tracker is a queue and a state machine; that is more than enough.

### 2.4 What this does not change about the game

Discovery, check-in, mastering, badges, the leaderboard and every rule of `SPEC.md` Section 7 are unchanged. A background sample is an ordinary sample: the same five gates in 7.2, the same reveal rule in 7.3, the same discovery radius, the same visit steps. `SPEC.md` 7.5's accepted trade-off — no continuous-presence enforcement — stands; a visit still completes on two on-site samples twenty minutes apart. What changes is that the second sample can now arrive while the phone is in a pocket, so a player who stays at the bar masters it without opening anything. That is the intended consequence and not a loophole (Section 7.6).

---

## 3. Technology stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Language | Swift 5.10+, SwiftUI | The only first-party option; SwiftUI for the four native screens |
| Minimum iOS | 17.0 | Drops every pre-17 branch in Core Location; the phones that play this are newer |
| Location | Core Location, classic `CLLocationManager` delegate API | The delegate API is what survives a system relaunch through significant-change monitoring (Section 6.4); iOS 17's `CLBackgroundActivitySession` does not add anything this app needs and is not used |
| JavaScript runtime | JavaScriptCore (`JSContext`) | Section 2.3 |
| Game UI | `WKWebView` with App-Bound Domains | The existing web app; App-Bound Domains are what make Service Workers available in a web view (Section 8.5) |
| Notifications | `UserNotifications`, local only | No APNs, no push service, no server change (Section 7.7) |
| Project generation | XcodeGen, `ios/project.yml` | The `.xcodeproj` is generated and gitignored, so the project is text this repository can read and diff, and never a hand-edited plist. `brew install xcodegen` is the one tool the owner installs |
| Tracker build | Vite library mode, `format: 'iife'` | Already in the workspace (`packages/web`); one file JavaScriptCore can load with no module loader |
| Tracker tests | Vitest | As every other package |

**Explicitly excluded:** Capacitor, Cordova, React Native, Flutter; any background-geolocation SDK; Firebase, Sentry, Crashlytics or any analytics; APNs and any push relay; CocoaPods, Carthage or Swift Package dependencies of any kind; a native map; Core Data or SQLite on the device.

**Exact dependencies.** Two manifests change and one is added.

| Manifest | Field | Contents |
| --- | --- | --- |
| `packages/tracker` | dependencies | `@tipsytrails/shared` `workspace:*` — bundled into the IIFE, so at runtime the tracker has none |
| `packages/tracker` | devDependencies | `@tipsytrails/api` `workspace:*` (the replay harness only, Section 13.2), `@types/node`, `vite` — the same major versions `packages/web` carries |
| root | devDependencies | unchanged |
| `ios/` | — | no manifest; Apple frameworks only |

`packages/tracker` resolves modules as NodeNext like `shared` and `api`: relative imports carry `.js`.

**Commands.** The four root commands are unchanged and now cover the tracker: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`. `pnpm build` gains `packages/tracker` after `shared`. One command is new and is run by Xcode, not by hand: `pnpm --filter @tipsytrails/tracker build` (Section 4.3).

---

## 4. Architecture

### 4.1 The three parts

```
┌───────────────────────────────────────────────────────────────────┐
│ iPhone                                                            │
│                                                                   │
│  ┌──────────────── Shell (Swift, one process) ─────────────────┐  │
│  │                                                             │  │
│  │  CLLocationManager ──fix──▶ ┌─────────────────────────┐     │  │
│  │                             │ JSContext: the tracker  │     │  │
│  │  UNUserNotificationCenter ◀─│  (packages/tracker,     │     │  │
│  │                             │   one IIFE bundle)      │     │  │
│  │  URLSession  ◀──fetch───────│                         │     │  │
│  │      │       ──result──────▶│                         │     │  │
│  │      │                      └───────┬─────────────────┘     │  │
│  │      │                        events│      ▲ messages       │  │
│  │      │                              ▼      │                │  │
│  │      │                      ┌─────────────────────────┐     │  │
│  │      │                      │ WKWebView: the web app  │     │  │
│  │      │                      │  (packages/web, loaded  │     │  │
│  │      │                      │   from the server)      │     │  │
│  │      │                      └──────────┬──────────────┘     │  │
│  │      │  Cookie: tt_session  ◀──────────┘ (borrowed, 5.2)    │  │
│  └──────┼──────────────────────────────────────────────────────┘  │
└─────────┼─────────────────────────────────────────────────────────┘
          │ https, Origin: PUBLIC_ORIGIN
          ▼
   Cloudflare ─▶ Pi ─▶ Fastify: POST /api/samples, unchanged
```

**The shell** owns what only native code can: the location manager and its authorization, the background session, the notification centre, the web view, the cookie store, one `URLSession`, and the JavaScript context. It has four screens (Section 11). It is deliberately stupid: every fix goes to the tracker, every network call comes from the tracker, every notification is one the tracker asked for.

**The tracker** is a TypeScript state machine with no access to any global. It is given a host (Section 7.2) — a clock, timers, a `fetch`, a notification scheduler, a log — and it produces events. Under the shell the host is Swift; under `pnpm test` it is a fake, or the real API reached through Fastify's `inject`. Same bytes in both places, because the tests load the built bundle (Section 13.2).

**The web app** is loaded from the server at `PUBLIC_ORIGIN`, not from the app bundle. It is the same deployment every browser gets, so a fix to a screen ships to the app without a new build. Inside the shell it detects the shell (Section 8.1) and swaps the source of its position from `navigator.geolocation` to the tracker's events; nothing else about it changes.

### 4.2 Repository structure

```
TipsyTrails/
├── ios/
│   ├── SPEC.md                      # this document
│   ├── PARENT-CONTRACT.md           # what this app depends on in the parent; the merge record
│   ├── project.yml                  # XcodeGen; the project file is generated from this
│   ├── Config/
│   │   ├── Server.xcconfig          # SERVER_ORIGIN — committed, no secret in it
│   │   └── Server.local.xcconfig    # gitignored; a developer's override
│   ├── TipsyTrails/
│   │   ├── App/                     # @main, the UIApplicationDelegate adaptor, lifecycle
│   │   ├── Location/                # CLLocationManager wrapper; the one place CLLocation becomes a sample
│   │   ├── Runtime/                 # JSContext, the host bridge, timers, fetch, log
│   │   ├── Web/                     # WKWebView container, user script, message handler, cookie observer
│   │   ├── Notifications/           # UNUserNotificationCenter wrapper
│   │   ├── Screens/                 # Primer, Consent, Diagnostics, Unreachable (Section 11)
│   │   ├── Diagnostics/             # counters, the report, export
│   │   ├── Resources/
│   │   │   ├── tracker.js           # gitignored; copied here by the build phase from packages/tracker/dist
│   │   │   ├── Info.plist
│   │   │   └── PrivacyInfo.xcprivacy
│   │   └── Assets.xcassets
│   └── TipsyTrails.xcodeproj/       # gitignored; `xcodegen generate` makes it
└── packages/
    └── tracker/
        ├── package.json
        ├── tsconfig.json            # lib: ["ES2022"] and no DOM — the tracker cannot reach a browser API by accident
        ├── vite.config.ts           # library mode, iife, one output file
        └── src/
            ├── index.ts             # the IIFE entry: reads globalThis.__tipsyTrailsHost, exposes the tracker
            ├── tracker.ts           # the state machine (Section 7.3)
            ├── queue.ts             # Section 7.4
            ├── visits.ts            # Section 7.6
            ├── notifications.ts     # Section 7.7
            ├── counters.ts          # Section 7.8
            ├── host.ts              # the Host interface (Section 7.2)
            ├── events.ts            # the event union (Section 7.5)
            └── replay/              # the walk harness (Section 13.2)
```

`.gitignore` gains `ios/TipsyTrails.xcodeproj/`, `ios/TipsyTrails/Resources/tracker.js`, `ios/Config/Server.local.xcconfig`, and Xcode's `xcuserdata/` and `DerivedData/` — none of them yet, because no Xcode project exists.

`.prettierignore` **already** lists `ios/SPEC.md` on this branch, for the same reason it lists `SPEC.md`: a test reads that file by regular expression, and Prettier rewrites `*text*` to `_text_` under one. `ios/PARENT-CONTRACT.md` is deliberately not listed — nothing reads it by regular expression, and Prettier aligning its tables is what keeps "add a row" from meaning "re-align a table by hand".

### 4.3 Build and distribution

**Generating the project.** `cd ios && xcodegen generate` produces `TipsyTrails.xcodeproj` from `project.yml`. The YAML is the source; the project file is never edited by hand and never committed. Xcode is opened on the generated project.

**The tracker reaches the bundle through a build phase.** `project.yml` declares a run-script phase on the app target, before "Copy Bundle Resources", that runs `pnpm --filter @tipsytrails/tracker build` from the repository root and copies `packages/tracker/dist/tracker.js` to `ios/TipsyTrails/Resources/tracker.js`. The phase declares its input and output files so Xcode skips it when nothing changed. This means a Mac that builds the app needs Node 22 and pnpm, which a Mac that builds the web app already has. A build without the file fails at that phase with a message naming the command, not at runtime with an empty context.

**The server origin is a build setting, not a constant.** `ios/Config/Server.xcconfig` carries `SERVER_ORIGIN = https:/$()/tipsytrails.ahultsch.com` (the `$()` is xcconfig's way of writing `//` without opening a comment) and `project.yml` exposes it to `Info.plist` as `TTServerOrigin`. It is the same value the server holds as `PUBLIC_ORIGIN` (`SPEC.md` 4.3) and has the same status: deployment configuration, not a game constant, so it does not belong in `config.ts`. A developer pointing a build at a local server overrides it in the gitignored `Server.local.xcconfig`. The shell uses it for exactly three things: the web view's initial URL, the `Origin` header on native requests (Section 5.3), and the one entry in `WKAppBoundDomains` (Section 8.5), derived at build time so the three cannot disagree.

**Signing.** Bundle identifier `com.ahultsch.tipsytrails`. The team, certificates and provisioning profiles are the owner's and are configured in Xcode's signing settings, which XcodeGen leaves to automatic signing; nothing about them is in the repository (C6). `project.yml` carries `DEVELOPMENT_TEAM` as an empty value that the owner's `Server.local.xcconfig` fills in.

**Distribution is TestFlight or Ad Hoc, and not the App Store, and this is a decision.** The app is for the owner and a handful of friends. Both routes need the Apple Developer Program and neither needs App Store review: Ad Hoc signs a build for up to 100 named devices for a year; TestFlight's internal testers (up to 100, members of the owner's App Store Connect team) get builds without Beta App Review. What review would raise is real and is avoided rather than argued: Guideline 4.2 rejects apps that are "a web clipping" — which a thin shell around a web app is, deliberately (I5) — and Guideline 1.4.3 forbids encouraging excessive alcohol consumption, which a game about visiting bars would have to explain at a 17+ rating. Neither is a reason to change the app; both are reasons not to submit it. If the owner ever wants the App Store, the shell would need enough native surface to pass 4.2, and that is a different app than this document specifies (O-I2).

**Reproducibility (C11).** Everything needed to build the app is in the repository except signing material and the tracker's built output, both of which are regenerated by the steps above. A fresh clone plus Xcode, XcodeGen, Node and pnpm builds it.

### 4.4 Process model

The shell runs the tracker on **one serial `DispatchQueue`**, owned by the runtime module. The `JSContext` is created on it, the bundle is evaluated on it, and every call into the context happens on it: a fix from the location delegate, a timer firing, a `fetch` completing, a message from the web view, an app-state change. Core Location delivers on the main queue and `URLSession` on its own; both are hopped to the tracker queue before touching the context. The tracker is therefore single-threaded from its own point of view, which is what lets it be a plain state machine with no locks, and what lets the same code run under Vitest.

**Calls out of the context** — an event the tracker emits — are handed back from the tracker queue to whichever queue the consumer needs: the main queue for the web view and the screens, the notification centre's own API for notifications.

**Lifecycle.** The shell tells the tracker which of three states the app is in — `foreground`, `background`, or `launchedHeadless` — and the tracker chooses the location profile (Section 7.3). The context is created once per process and lives until the process ends. If the JavaScript throws an uncaught exception, the context's `exceptionHandler` logs it, counts it (Section 7.8), and the shell recreates the context and restarts the tracker from its start state; the in-memory queue is lost, which I2 accepts. It does not retry more than once per `TRACKER_RESTART_MIN_INTERVAL_MS` (Section 7.1), so a bundle that throws on start cannot spin.

**Background execution.** Every flush the tracker starts is wrapped by the shell in `UIApplication.beginBackgroundTask(withName:expirationHandler:)`, ended when the request completes or the handler fires. The location background mode is what keeps the process alive between fixes; the task assertion is what stops a request that is in the air from being killed with the process if the delivery of fixes happens to stop at that moment.

---

## 5. The session

### 5.1 Signing in happens in the web app, and nowhere else

There is no native login screen. The web view loads `SERVER_ORIGIN`, the web app shows its landing and login screens exactly as in Safari, and `POST /api/auth/login` sets the `tt_session` cookie into the web view's cookie store (`WKWebsiteDataStore.default().httpCookieStore`). Registration, password change, the security-question reset and the age gate are all the web app's, unchanged. The shell never sees a password.

### 5.2 The native side borrows the cookie and never owns it

The tracker's requests need the same session. The cookie is `httpOnly`, which stops JavaScript in the page reading it and does not stop the app: `WKHTTPCookieStore.getAllCookies` returns it to native code. The shell reads the `tt_session` cookie for the server's host from the web view's store and hands its value to the runtime's `fetch` (Section 7.2), which sends it as a `Cookie` header on every request.

Four rules keep that honest:

- **The web view's store is the only authority.** The shell does not copy the cookie into `HTTPCookieStorage`, does not let `URLSession` manage cookies (`httpShouldSetCookies = false`, an ephemeral configuration), and does not persist it anywhere. If a request's response carries a `Set-Cookie`, it is ignored; the server's sliding refresh (`SPEC.md` 5.4) reaches the web view through the web view's own requests, and the next borrow picks it up.
- **The shell observes the store** with a `WKHTTPCookieStoreObserver` and re-reads the cookie on every change, so a refreshed value, a logout, or an account deletion is seen within the same run loop turn.
- **A missing cookie means signed out.** The tracker is told `sessionLost` (Section 7.5) and stops; nothing is posted until a cookie is back. The shell does not try to sign in, cannot, and must not pretend to.
- **A 401 from any tracker request is the same event.** The tracker stops on it, tells the shell, and the shell re-reads the store once; if the cookie is still there but the server refuses it, the session has been ended from elsewhere (`SPEC.md` 5.4 lists the four ways) and the web view is told to reload so the web app shows its login screen. One notification tells the player (Section 7.7). There is no retry loop on a 401.

The cookie is signed by `@fastify/cookie` and its wire value is `<id>.<signature>`. The shell forwards it verbatim and never parses it.

### 5.3 `Origin`, and why the CSRF check is not weakened

`SPEC.md` 10.1 makes every state-changing `/api` request carry an `Origin` equal to `PUBLIC_ORIGIN`, and `packages/api/src/http/csrf.ts` fails closed when the header is absent. `URLSession` sends no `Origin`. The runtime's `fetch` therefore sets `Origin: <SERVER_ORIGIN>` on every request it makes, from the build setting of Section 4.3. Nothing on the server changes.

This does not weaken the check. It exists against a browser being made to send a request the user did not intend, and a native client that asserts its own origin is not that attacker — it is the same thing as a `curl` with the right header, which the check never claimed to stop. `SPEC.md` 10.1 already states the deeper truth: positions are client-asserted and anyone with a session can already claim to be anywhere. The web view's own requests are a browser's and carry `Origin` on their own.

### 5.4 Consent is recorded on the account

Section 10.1 needs a record that the player consented to background tracking and when. That is a column on `users` and a field on `PATCH /api/settings` (Section 9.2). The shell sets it through the web app rather than directly: the consent screen (Section 11.2) is native, and on the player's confirmation the shell asks the web view to call the settings endpoint, so there is one client that writes settings and it is the one that already does. The shell reads the answer back from the tracker's `GET /api/auth/me` at start (Section 7.3) and treats "not consented" as "do not track in the background", whatever iOS authorization says.

Withdrawal is `backgroundTracking: false` on the same endpoint, which clears the column to `NULL` — the wire field is a boolean and is never sent as `null` (9.2) — from the web app's Settings screen (Section 8.6) or the shell's own Consent screen, and it stops background tracking on the next state change and at the latest on the next start.

---

## 6. Location on iOS

This section is the honest inventory: what iOS grants, on what conditions, and what it takes away that no design can get back. Everything the tracker decides in Section 7 rests on it.

### 6.1 What works

With `UIBackgroundModes` containing `location`, `allowsBackgroundLocationUpdates = true`, and the player's "Always" authorization, `CLLocationManager.startUpdatingLocation()` delivers fixes continuously while the app is in the background, while the screen is locked, and while the phone is in a pocket. The process stays alive for as long as fixes are being delivered. This is how every running and cycling app works, and it is the whole of what this app needs from the platform.

### 6.2 The authorization ladder

iOS authorization has more states than "yes" and "no", and the shell must reflect each one rather than collapse them.

| `authorizationStatus` | `accuracyAuthorization` | Meaning for this app |
| --- | --- | --- |
| `.notDetermined` | — | Never asked. The Primer screen (11.1) is shown before the first request. |
| `.denied` | — | Refused, or Location Services off globally. Nothing works. The shell says so and offers the Settings deep link. |
| `.restricted` | — | Parental controls or device management. As denied, with different words. |
| `.authorizedWhenInUse` | `.fullAccuracy` | The foreground game works. Background does not. This is the state a player who declined the upgrade lands in, and it is a **supported** state: the app is the PWA with a better position source. |
| `.authorizedAlways` | `.fullAccuracy` | Background tracking is possible, subject to the in-app consent of I6. |
| any authorized | `.reducedAccuracy` | Precise Location is off. Fixes arrive fuzzed to roughly 1–20 km with `horizontalAccuracy` in the thousands of metres. Every one would fail `FOG_MAX_ACCURACY_M` (200 m). The tracker treats this as **blocked** (7.3): nothing is queued, nothing is posted, and the player is told. The shell asks once per foreground session for temporary full accuracy (`requestTemporaryFullAccuracyAuthorization(withPurposeKey:)`, purpose key `TTPlay` in `NSLocationTemporaryUsageDescriptionDictionary`). |

**The request is made in two steps, and the order is the product's one chance to explain itself.** Step one asks for When In Use, from the Primer, before the map is ever shown; iOS presents its own sheet with "Allow Once / Allow While Using App / Don't Allow". Step two asks for Always, only from the Consent screen, only after the player has read what background tracking is and said yes to it in the app (10.1); with When In Use already granted, iOS presents its upgrade sheet at once ("Keep Only While Using / Change to Always Allow"). Asking for Always cold, from a `.notDetermined` state, gets a provisional grant that iOS silently downgrades later with a prompt the app cannot control; the two-step order avoids that and, more importantly, puts the app's own words before Apple's.

**iOS will re-ask on its own, and the app must survive the answer.** Some days after Always is granted, iOS shows a system prompt summarising the app's background location use — on a map — and offers to downgrade. If the player downgrades, `authorizationStatus` moves to `.authorizedWhenInUse` and the delegate is called. The tracker learns of it through the `authorization` event (7.5), background stops, the web app's indicator changes (8.3), and nothing else breaks. The Consent screen shows the way back. This prompt is a fact of the platform and is listed in 13.3 as something the field test must see once.

### 6.3 The manager's configuration

All values reach Swift from the tracker (I1, Section 7.2), per profile (7.3). Fixed settings that are not numbers:

| Setting | Value | Why |
| --- | --- | --- |
| `allowsBackgroundLocationUpdates` | `true` once Always is granted and consent given; `false` otherwise | Setting it without the background mode entitlement crashes; setting it without Always is pointless |
| `pausesLocationUpdatesAutomatically` | **`false`** | The default is `true`, and iOS then stops delivering when it decides the user has stopped moving — which is a player sitting in a bar, the one moment the dwelling profile needs fixes. Paused updates do not resume on their own |
| `activityType` | `.fitness` | Tells the pause heuristics (disabled above, but also used for power decisions) that this is walking |
| `showsBackgroundLocationIndicator` | `true` | iOS shows the location arrow in the status bar while the app tracks in the background. The app does not hide it; `SPEC.md` 7.5's transparency rule applies to the platform too |
| `desiredAccuracy` | `TRACKER_DESIRED_ACCURACY_M`, mapped to the nearest `kCLLocationAccuracy*` constant | The tracker sends metres; the shell maps 10 → `kCLLocationAccuracyNearestTenMeters` |
| `distanceFilter` | per profile, from the tracker; `0` maps to `kCLDistanceFilterNone` | Section 7.3 |

### 6.4 Being killed, and coming back

Three things end the process, and they are not the same.

**iOS terminates the app** — memory pressure, or a long stretch with no fixes and nothing else to do. The app is relaunched by the system when a location event arrives for a service that survives termination. Standard updates do not survive it; **significant-change monitoring does**, and so the shell calls `startMonitoringSignificantLocationChanges()` whenever background tracking is on and leaves it running. A significant change (cell-tower scale, roughly 500 m or a few minutes) relaunches the app in the background with `UIApplication.LaunchOptionsKey.location` in the launch options. On that launch the shell creates no window, creates the runtime, starts the tracker in the `launchedHeadless` state (7.3), and the tracker restarts standard updates. Cells walked between the kill and the relaunch are not revealed; the counter in 7.8 records the relaunch so the walk of 13.3 can see how often it happens.

**The player force-quits the app** from the app switcher. Apple's documented rule is that an app the user force-quit is not relaunched for any event until the user opens it again, and this document takes the documented rule as the design assumption. Background tracking is therefore off from a force-quit until the next open, and the app says nothing about it because it cannot run to say anything. The Diagnostics screen (11.3) shows the last time the tracker was running so a player who wonders can see the gap. Whether current iOS versions relaunch a force-quit app for significant-change events is a question the field test answers (13.3, walk 3); if they do, nothing here changes except a sentence.

**The phone reboots.** Significant-change monitoring survives a reboot too, so the first significant change after the phone is back relaunches the app as above, without the player opening it.

### 6.5 What iOS does that the app cannot change

Listed so the field test and the privacy page both know what to say.

- **The blue location indicator.** Shown in the status bar while any app uses location in the background. Not hidden (6.3).
- **The periodic re-ask** (6.2).
- **Low Power Mode.** iOS may reduce the rate of background fixes. The shell reads `ProcessInfo.isLowPowerModeEnabled` and its change notification and passes it to the tracker as part of the app state; the tracker counts fixes per hour under it (7.8) and changes nothing else, because there is nothing it can change. The Diagnostics screen shows the flag.
- **Precise Location off** (6.2, blocked).
- **Location Services off globally** — `.denied` with the system-wide flag; the shell's words name the global switch rather than the app's.
- **Battery.** Continuous high-accuracy GPS over a five-hour evening is a real cost. The levers are the accuracy and the distance filter in 7.1, both of which are matched to the 50 m grid rather than set for smoothness; the measurement is the field test's (13.3). No figure is promised here, because none has been measured.

### 6.6 From `CLLocation` to a sample

One function in `ios/TipsyTrails/Location/` turns a `CLLocation` into the tracker's sample, and it is the only unit boundary in the shell (Section 0, rule 2):

| Sample field | From | Rule |
| --- | --- | --- |
| `lat`, `lon` | `coordinate` | as is |
| `accuracy` | `horizontalAccuracy` | metres already. **Negative means invalid**: the fix is dropped in the shell and counted, never handed to the tracker |
| `speed` | `speed` | metres per second, the unit the API already expects (`packages/api/src/routes/fog.ts`, `sampleSchema`). **Negative means unknown**: mapped to `null` |
| `timestamp` | `timestamp` | `timeIntervalSince1970 * 1000`, rounded — the fix's own time, not the delivery time, which is what makes a deferred delivery honest against `SAMPLE_MAX_AGE_MS` |

Nothing else on a `CLLocation` — altitude, course, floor, speed accuracy — is read or forwarded. The web app's direction-of-travel cone (`SPEC.md` 8.3) is display-only there and reads the browser's course; inside the shell it is absent, because the tracker's samples carry no course and C4 says the server never gets one either. That is recorded as O-I3 rather than fixed here.

---

## 7. The tracker

`packages/tracker` is the whole of the phone's judgement about samples. It is written so that a reader of `packages/web/src/tracking/useSampleTracking.ts` recognises it: the same queue, the same throttle, the same batch, the same "behind" arithmetic, moved out of React and out of the browser so it can run without either.

### 7.1 Constants

Added to `packages/shared/src/config.ts`, client-safe, every one of them. The block reproduces the keys; the reasoning is in the sections that own them.

```ts
  // ios/SPEC.md Section 7 — the tracker. Every number the Swift shell uses
  // reaches it from here through the tracker (ios/SPEC.md I1); Swift holds
  // none of its own.
  TRACKER_DESIRED_ACCURACY_M: 10,            // Core Location's "nearest ten metres"; ios/SPEC.md 6.3
  TRACKER_FOREGROUND_DISTANCE_FILTER_M: 0,   // 0 = every fix; the map is on screen — ios/SPEC.md 7.3
  TRACKER_WALKING_DISTANCE_FILTER_M: 25,     // half a cell; a fix every 25 m of movement in the background
  TRACKER_DWELLING_DISTANCE_FILTER_M: 0,     // every fix while a visit is pending at a bar the player is near
  TRACKER_QUEUE_CAP: 600,                    // oldest dropped beyond this; ~10 min of foreground fixes — 7.4
  TRACKER_FLUSH_BACKOFF_BASE_MS: 5 * 1000,   // after a failed flush; doubles — 7.4
  TRACKER_FLUSH_BACKOFF_MAX_MS: 5 * 60 * 1000,
  TRACKER_RESTART_MIN_INTERVAL_MS: 60 * 1000, // a crashed context is not restarted sooner — 4.4
  TRACKER_DIAGNOSTIC_DAYS: 7,                // daily counter buckets kept on the device — 7.8
```

Constants the tracker reuses rather than redefines, because they already say what it needs: `SAMPLE_MIN_INTERVAL_MS` (the flush cadence), `SAMPLE_MAX_BATCH` (the batch size), `SAMPLE_MAX_AGE_MS` (what it drops locally as certainly stale), `FOG_MAX_ACCURACY_M` (what it drops locally as certainly unusable), `BAR_DISCOVERY_RADIUS_M` (the dwelling radius, 7.6), `VISIT_PUSH_AFTER_MS` (the local reminder, 7.7), `GPS_ACCURACY_GOOD_M`, `GPS_ACCURACY_FAIR_M`, `GPS_STALE_MS` (the indicator, 8.3). No constant of the server's changes value.

**Two of the local drops are a second implementation of a server rule, and that is admitted rather than hidden.** `SPEC.md` 7.3 argues against a client re-testing a threshold the server applies, and the argument is right where the two could disagree. These two cannot: the tracker drops only what the server is *certain* to reject by the same constant on the same field — an accuracy above `FOG_MAX_ACCURACY_M`, a timestamp older than `SAMPLE_MAX_AGE_MS` by the phone's own clock — and it counts each drop separately (7.8), so a phone whose clock is wrong shows up as a phone dropping samples the server would have accepted. What it buys is not spending batch slots and rate-limit budget (30 posts a minute, `SPEC.md` 9.4) on samples with no chance. The server still decides everything it decides today; the tracker never re-tests speed, the bounding box, or the future-clock skew.

### 7.2 The host interface

The tracker touches no global. It is handed one object and calls nothing else:

```ts
interface Host {
  now(): number;                                   // ms epoch; injected so tests drive time
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  fetch(input: HostRequest): Promise<HostResponse>; // adds Cookie and Origin itself; the tracker sets Content-Type only
  configureLocation(profile: LocationProfile): void; // { desiredAccuracyM, distanceFilterM, background: boolean }
  requestSignificantChanges(on: boolean): void;
  scheduleNotification(n: LocalNotification): void; // { id, atMs, title, body }
  cancelNotification(id: string): void;
  emit(event: TrackerEvent): void;                 // Section 7.5
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
```

The shell installs it as `globalThis.__tipsyTrailsHost` before evaluating the bundle; the bundle's entry reads it once and exposes `globalThis.__tipsyTrails` with the calls the shell makes in (7.3). Under Vitest the host is a fake with a controllable clock; under the replay harness its `fetch` is Fastify's `inject` (13.2). The `Host` type is the contract between the two languages, and the runtime module's Swift is a line-for-line implementation of it — which is what makes that Swift boring enough to write blind.

**What the host's `fetch` is and is not.** It takes `{ method, path, body?: string }` and returns `{ status, headers: Record<string,string>, body: string }`. It prepends `SERVER_ORIGIN`, adds `Cookie` (5.2) and `Origin` (5.3), and adds `Content-Type: application/json` only when there is a body (`SPEC.md` 7.5 records why that matters). It follows no redirect and throws only on a transport failure; every HTTP status is returned as a response. It is not the WHATWG `fetch`, deliberately: a subset with no streams, no `Headers` class and no `Request` object is a subset Swift can implement completely.

**On start, the tracker configures the shell, not the reverse.** `configureLocation` is called with the profile for the current state before any fix is expected. That call is where `config.ts` numbers become `CLLocationManager` properties, and it is the only way they get there.

### 7.3 The state machine

```
                 start(appState, consent, authorization)
                              │
                              ▼
   ┌─────────── idle ────────────┐    no session, or not signed in
   │                             │
   │  sessionOk ∧ authorized     │
   ▼                             │
 tracking ──────────────────────┘    401 / cookie gone → sessionLost → idle
   │  profile ∈ { foreground, walking, dwelling }
   │
   ├─ reducedAccuracy / denied ──▶ blocked(reason) ──(restored)──▶ tracking
   │
   └─ consent withdrawn ∧ background ──▶ idle
```

**Start.** The shell calls `start` with the app state (`foreground` | `background` | `launchedHeadless`), whether the cookie is present, the authorization pair of 6.2, and the low-power flag. The tracker then, in order: calls `GET /api/auth/me` (a 401 here is `sessionLost` before anything else is tried, and the consent field on the answer is what decides whether background is allowed — 5.4); calls `GET /api/visits/pending` to seed the visit set (7.6); chooses the profile; calls `configureLocation`; and emits `tracking`. A headless launch does exactly this with no web view, which is why the tracker has to be able to learn everything it needs from the API and the shell and nothing from the page.

**Profiles.** The profile is a function of the app state and the visit set, and it is recomputed on every change of either:

| Profile | When | Distance filter | Background updates |
| --- | --- | --- | --- |
| `foreground` | the app is visible | `TRACKER_FOREGROUND_DISTANCE_FILTER_M` | as consented |
| `walking` | not visible, no pending visit within `BAR_DISCOVERY_RADIUS_M` of the last accepted position | `TRACKER_WALKING_DISTANCE_FILTER_M` | yes |
| `dwelling` | not visible, a pending visit at a bar within `BAR_DISCOVERY_RADIUS_M` | `TRACKER_DWELLING_DISTANCE_FILTER_M` | yes |

`foreground` takes every fix because the map is on screen and the own-position marker should move as it does in Safari. `walking` takes one per 25 m because the fog grid is 50 m and a fix every half-cell reveals every cell a walk crosses with no fix wasted standing still. `dwelling` takes every fix again because a player standing in a bar does not move 25 m, and the visit needs on-site samples to advance (7.6). No profile has a timer that asks for a fix; Core Location is the only clock for fixes, and the distance filter is the only throttle before the queue.

**Blocked** is a tracking state with a reason (`reducedAccuracy` | `denied` | `restricted` | `servicesOff`) and nothing queued: fixes that arrive are counted and discarded, no request is made, and the `tracking` event carries the reason so the web app can say it (8.3). It returns to `tracking` on the authorization event that lifts it.

**Idle** is where the tracker sits with no session or no authorization at all. It emits nothing but its own state and makes no request until `start` is called again with a session.

**Every transition emits a `tracking` event**, and every event the shell forwards to the web view is idempotent, so a web view that mounts late gets the current state by asking (8.2) rather than by replaying history.

### 7.4 The queue and the flush

The queue is an in-memory array of samples in arrival order, exactly as `useSampleTracking`'s `queueRef` is, and it is not persisted (I2).

**Enqueue.** A sample from the host is dropped and counted if its `accuracy` exceeds `FOG_MAX_ACCURACY_M`, or if `now() - timestamp` exceeds `SAMPLE_MAX_AGE_MS` (7.1 says why both are safe). Otherwise it is appended. If the queue then exceeds `TRACKER_QUEUE_CAP`, the oldest is dropped and counted — the newest sample is the one that says where the player is now, and it is the one a stale queue must not push out.

**Flush.** A timer at `SAMPLE_MIN_INTERVAL_MS` posts up to `SAMPLE_MAX_BATCH` samples from the front of the queue to `POST /api/samples`, one request in flight at a time, and only while the state is `tracking`. This is the web app's cadence, and it stays under the `samples` rate limit (`SPEC.md` 9.4, 30 a minute) by five times. Before posting, samples that have become certainly stale while waiting are dropped and counted, so a queue that sat through a long dead spot does not spend its first batch on samples the server will refuse.

**On success (2xx)** the batch is removed from the queue, the response is parsed and validated with the same rules `packages/web/src/api/response-guards.ts` applies to it (finite numbers, a known `status` on each visit update), and a `flush` event carries it (7.5). The response's `rejected` counts (9.1) are added to the counters. `behind` — the number of samples that were queued when this attempt began and are still queued after it — is computed exactly as `useSampleTracking` computes it and rides on the same event, so `SPEC.md` 8.6's connection state means the same thing in the shell as in Safari.

**On failure** the batch stays at the front of the queue and the next flush is delayed by a backoff: `TRACKER_FLUSH_BACKOFF_BASE_MS`, doubling per consecutive failure, capped at `TRACKER_FLUSH_BACKOFF_MAX_MS`, reset by the next success. Three statuses are not retried this way: **401** is `sessionLost` (5.2); **403 with `code: 'password_change_required'`** is treated the same, because the web app has to be opened to clear it; **429** waits exactly the `Retry-After` the server sends (`SPEC.md` 9.4) and then resumes with the backoff reset. A transport failure — no connectivity — is an ordinary failure, and the queue simply waits; the shell does not watch reachability, because a failed request is a cheaper and more honest signal than a reachability API that says "online" over a captive portal.

**A response the guard rejects** is an ordinary failure too: the batch stays queued and retries, which is `SPEC.md` 9.6's own rule for the web client, and which is what lets a shell running against a server that has moved on recover once the web app has caught up.

### 7.5 What the tracker emits

One event union, `TrackerEvent`, and the shell forwards each to the web view verbatim as JSON (8.2). Every payload is either something the web app already has a type for in `packages/web/src/api/types.ts` or a small addition beside it.

| Event | Payload | When |
| --- | --- | --- |
| `tracking` | `{ state: 'idle' \| 'tracking' \| 'blocked', profile?, reason?, background: boolean, authorization: { status, accuracy }, lowPower: boolean }` | every transition, and on request |
| `position` | the sample, plus `receivedAt: now()` | every sample enqueued — the web app's marker, nearby panel and check-in enablement read this |
| `flush` | `SamplesResponse` from the server, plus `{ sent, behind, queued }` | every successful flush |
| `queue` | `{ queued, behind }` | every enqueue and every drop, so the indicator's queued count is live |
| `visit` | `VisitSummary` | a visit entering or leaving the tracker's set (7.6), whichever side learned of it |
| `sessionLost` | `{ cause: 'cookie' \| 'unauthenticated' \| 'password_change_required' }` | once per loss |
| `notification` | `LocalNotification` | mirrored to the web app for its own display, if it wants one |

The web app never receives a fix that was not accepted into the queue, so `position` already carries the accuracy the indicator needs and nothing the server would refuse on accuracy.

### 7.6 Visits, and how a bar is mastered from a pocket

The tracker keeps the set of the player's pending visits, because the dwelling profile depends on it. The set is seeded by `GET /api/visits/pending` at start, updated by every `visitUpdates` entry in a `flush` (`pending` adds or refreshes; `completed`, `expired` and — from the web app's cancel — `cancelled` removes), and told directly by the web app when it creates or cancels a visit (8.2), so the profile changes the moment the player taps "Check in" rather than a flush later. On every return to the foreground the tracker re-fetches `GET /api/visits/pending` and reconciles, for the same reason `SPEC.md` 7.5 makes the banner do so: it is the only source that can say a visit ended for a reason no client saw.

**What this makes possible is precisely what `SPEC.md` 7.5 describes and never enforces.** A visit completes on two accepted on-site samples at least `VISIT_REQUIRED_MS` apart. Today the second one needs the app opened at the bar; with the dwelling profile the phone supplies one every few seconds for as long as the player stands within the on-site radius, and the server completes the visit at twenty minutes on its own ordinary rule. Nothing is added to the server's judgement and nothing is taken from the player: a player who leaves after five minutes has a pending visit exactly as before, and a player who comes back later completes it exactly as before.

**The dwelling profile ends when the player has left**, judged by the last accepted position moving beyond `BAR_DISCOVERY_RADIUS_M` of the visit's bar, and not by the visit ending: the visit stays pending on the server for `VISIT_EXPIRY_MS` (six hours) and the tracker has no business tracking at full rate for six hours to watch a visit nobody is at. It resumes if the player comes back within that radius. The constant is reused rather than invented — the question "is the player near this bar" already has an answer in the discovery radius, and a second number for the same question would drift.

**A completed visit is the one game moment the phone announces on its own** (7.7).

### 7.7 Notifications

There is no push. `WKWebView` has no Push API, APNs would add a server dependency and a second outside party for one reminder, and every notification this app has a reason to send is a fact the tracker already knows at the moment it becomes true. So notifications are **local**, scheduled by the tracker through the host, and there are four:

| Notification | Scheduled | Cancelled |
| --- | --- | --- |
| **The 21-minute reminder** — `SPEC.md` 7.5's push, made local | when a visit enters the set, at `startedAt + VISIT_PUSH_AFTER_MS`, one per visit id | when that visit leaves the set for any reason; a dwelling visit usually completes at twenty minutes and this never fires |
| **Bar mastered** | on a `completed` in `visitUpdates`, immediately | — |
| **Bars discovered** | on a non-empty `newBars`, immediately, one notification per flush naming up to three bars and "and N more" | — |
| **Signed out** | on `sessionLost`, once | — |

Rules that bound them:

- **Nothing announces revealed ground.** `SPEC.md` 7.3 removed "Revealed N new areas" from the map for being noise, and a notification for it would be that noise in a pocket. `newCells` is counted (7.8) and never spoken.
- **Discovery notifications can be turned off**, in the shell's Consent screen (11.2), and that switch is device-local `UserDefaults` — it records a preference, not a position. The reminder and the mastered notification cannot be turned off separately from notifications as a whole, because they are the mechanic's transparency (`SPEC.md` 7.5) and not a nicety.
- **Permission is asked from the Consent screen** and never on launch; the same rule `usePushSubscription` follows for the same reason.
- **A notification carries the bar's name and nothing else** — no coordinate, no distance, no cell count. What the notification centre stores is a name.
- **The web app's own push offer is hidden inside the shell** (8.4). One channel.

### 7.8 Counters, and the diagnostic report

The tracker counts, and this is the part of the design that makes the owner's walk (13.3) produce a report instead of an impression. Every counter is an integer or a timestamp, none is a coordinate, and the set is closed:

- fixes: received, dropped invalid (negative accuracy), dropped reduced-accuracy, dropped accuracy, dropped stale at enqueue, dropped stale at flush, dropped by cap
- queue: current depth, current behind, maximum depth seen
- flushes: attempted, succeeded, failed by HTTP status class, transport failures, backoff currently in force
- samples: sent, and from the server's answer (9.1) rejected per gate — accuracy, future, stale, outsideCity, tooFast — so "accepted" is sent minus the sum
- results: `newCells` total, bars discovered, visits completed, `tooFastToReveal` batches
- state: transitions of `tracking` with timestamps; the current profile; low-power flag and how many fixes arrived under it
- process: starts by cause (`user`, `location`, `unknown`), context restarts after an exception, last exception message
- session: `sessionLost` events by cause

The tracker emits them on request; the shell persists the *daily* buckets in `UserDefaults` for `TRACKER_DIAGNOSTIC_DAYS` days (Berlin days, computed by the shared helper the badge job uses — `berlinDateString` in `packages/shared`) and shows them on the Diagnostics screen (11.3). The report is those buckets plus the device model, iOS version, app version, tracker bundle hash, authorization pair, and the timestamp of the last time the tracker ran. It is exported through the share sheet as JSON. **It contains no position, no cell index, no bar id and no bar name.** It is a report about the pipeline, and reading it tells you whether the pipeline worked and not where anyone went.

---

## 8. The web app inside the shell

`packages/web` runs unchanged in Safari and in the shell, and knows which it is in. Every change in this section is behind one detection and is a no-op outside it.

### 8.1 Detection

The shell injects a `WKUserScript` at document start, for the main frame only, that defines `window.__tipsyTrails = { platform: 'ios', shellVersion, trackerVersion, ... }` with the bridge in 8.2. The web app detects the shell by the presence of that object and by nothing else — not the user agent, which is also given a `TipsyTrailsShell/<version>` suffix for the server's log lines but is not a contract. `packages/web/src/shell/` holds the detection and the bridge's typed wrapper; nothing else in the web app touches `window.__tipsyTrails` directly.

### 8.2 The bridge

**Shell → page.** The shell calls `window.__tipsyTrails.dispatch(json)` through `evaluateJavaScript` for every tracker event (7.5). The injected object fans `dispatch` out to listeners the web app registers, and it holds the **latest** `tracking`, `position`, `queue` and `flush` payloads so a listener that registers after the fact reads the current state at once instead of waiting for the next event; this is what lets the map screen mount and unmount freely while the tracker runs on.

**Page → shell.** The web app posts to `window.webkit.messageHandlers.tipsyTrails.postMessage({ type, ... })`, and the types are:

| Message | When | The shell does |
| --- | --- | --- |
| `ready` | the web app has mounted | replies with the current state through `dispatch` |
| `signedIn` | after login or registration succeeds | re-reads the cookie, starts the tracker if it was idle |
| `signedOut` | before the web app's own logout request | tells the tracker `sessionLost('cookie')` first, so no sample is posted against a cookie about to be deleted; the observer of 5.2 is the safety net if the message is missed |
| `visitStarted` / `visitEnded` | `POST /api/visits` and the cancel succeed | forwards to the tracker (7.6) |
| `openExternal` | a link leaves the app (8.5) | opens it in Safari |
| `requestNotifications` | the player asks for notifications from the web app | shows the Consent screen's notification step (11.2) |
| `openConsent` | the player opens background-tracking settings from the web app (8.6) | shows the Consent screen |

### 8.3 The tracking hook takes a second driver

`useSampleTracking` (`packages/web/src/tracking/useSampleTracking.ts`) keeps its interface — `SampleTrackingState`'s **thirteen** members are exactly the thirteen it has today, with the same names and the same types, so every screen that reads it reads it unchanged — and gains a driver chosen once at mount: the existing `watchPosition` driver, or a shell driver that subscribes to the bridge (8.2).

**Nothing is added to the interface**, and that is a decision rather than an omission. A fourteenth member is a member every screen inherits, every test re-runs against and every future driver has to produce, and the shell needs none: everything the shell knows that the interface cannot carry — the four states of the third icon below — reaches the one component that wants it through `packages/web/src/shell/` (8.1) and not through this hook. What this section does owe the reader is the other half: **a member the shell driver leaves at its initial value is a screen that silently stops updating**, so every one of the thirteen is accounted for below, and none of them is "unchanged" by default.

**No `watchPosition`, no queue, no flush, no wake lock** under the shell driver (I4). The hook posts nothing of its own there, with the single exception of a standing teleport (below).

**Every member, and where the shell driver gets it.** The event names are 7.5's.

| Member | Under the shell driver |
| --- | --- |
| `gpsStatus` | `computeGpsStatus` over the latest `position` event — its sample's `accuracy` and its `receivedAt` — with the same `GPS_STALE_MS` timer restarted on each event, so `SPEC.md` 8.6's three states mean what they mean in Safari |
| `connectionStatus` | `computeConnectionStatus(navigator.onLine, behindDepth)`, the same call the hook makes today, over the internal `behindDepth` the driver now feeds (below) |
| `trackingActive` | `true` while the latest `tracking` event's state is `tracking`, `false` while it is `idle` or `blocked` |
| `queueDepth` | the `queued` of the latest `queue` or `flush` event — the tracker's queue (7.4), which is the only queue there is under the shell |
| `tooFastToReveal` | the `tooFastToReveal` of the latest `flush`, replaced by every one including a `false`, exactly as a successful post replaces it today. A failed flush emits nothing and so leaves the last thing the server said standing — again the hook's own rule |
| `postError` | `null`, except while a teleport stands, when it is that path's own error (below) |
| `revealVersion` | the hook's own counter, `+1` per `flush` with `newCells > 0` (below) |
| `discoveryVersion` | the hook's own counter, `+1` per `flush` with a non-empty `newBars` **or** any `visitUpdates` entry whose status is `completed` — the same two reasons the hook advances it for today |
| `newBars` | the `newBars` of the latest `flush`, replaced by every one including an empty array |
| `newBarsVersion` | the hook's own counter, `+1` per `flush` with a non-empty `newBars` |
| `visitUpdates` | the `visitUpdates` of the latest `flush`, replaced by every one including an empty array |
| `visitVersion` | the hook's own counter, `+1` per `flush` with a non-empty `visitUpdates` |
| `lastPosition` | the latest `position` event's sample: `lat`, `lon`, `accuracy` as sent, `heading` always `null` (6.6, O-I3). While a teleport stands, the teleported point instead |

**`behindDepth` is not a member of this interface, and an earlier draft of this section said it was.** It is local state inside `useSampleTracking`, written only by `flush()` because only a flush knows what an attempt found and what it left, and its only reader is the `computeConnectionStatus` call in the hook's return statement. No screen can see it. The correction is the `connectionStatus` row above: **the shell driver feeds the hook's internal `behindDepth`** from the `behind` carried by the `queue` and `flush` events, which the tracker computes "exactly as `useSampleTracking` computes it" (7.4), and the connection status is then computed by the same function from the same two inputs under both drivers.

The alternative — computing the connection status differently under the shell, from the `tracking` event's own state — is rejected. `SPEC.md` 8.6's `syncing` would then mean one thing in Safari and another in the app, on the same icon, for the same player; `PARENT-CONTRACT.md` D2 exists to stop exactly that, and `tracking` cannot say what `behind` says anyway — a tracker that is healthy and behind is both at once. `navigator.onLine` stays the offline input: the web view shares the app process's connectivity, and a request the tracker cannot get out while the web view believes it is online shows up honestly as `behind` rising.

**The four counters are the hook's own, and they start at nought on every mount.** They are never copied from a tracker-side count. Two consumers — `useBarStamps` and `useVisits` — read `=== 0` as "nothing has happened yet in this mount", and a counter seeded from a tracker that has been running for an hour would fire on the first render and stamp a batch of bars discovered before the map existed. The rule that makes this exact is the bridge's: 8.2 has it hold the **latest** `flush` payload and hand it to a listener that registers late, and **that replayed payload seeds the replaced-on-every-post members and never advances a counter.** Only a `flush` that arrives after the subscription does, and it advances each counter at most once, by the predicates in the table. This is what lets the map screen mount and unmount freely while the tracker runs on, without a remount replaying a reveal, a stamp or a visit reconciliation the player already saw.

**`trackingActive` under a driver with no watch to be active.** The field's meaning in the parent is not "is `watchPosition` running" but "is this device recording a position at all" — which is why the hook keeps it `true` while a teleport stands and the watch is stopped. Under the shell that question is the tracker's state and not the web view's visibility, so a phone in a pocket with the map unmounted is recording and this is `true`: that is the entire point of the app, and a hook that reported `Paused` there would be the false statement `SPEC.md` 8.6 already refuses. `blocked` is `false` because nothing is being queued (7.3), and `idle` is `false` because nothing is being tracked.

**`postError` under a driver that posts nothing.** In Safari it is the words the indicator's panel shows when a post failed, cleared by the next success. The shell driver makes no post, and the tracker's failures are deliberately not forwarded to it: a flush that fails is retried with backoff (7.4), so by the time a screen exists to show anything the message would describe a state that has usually passed — the same "message about a train that survives the player getting off it" the hook's own comment refuses. What the player gets instead is live and self-clearing: `behind` rises, `connectionStatus` becomes `syncing`, and the panel says there is a reason to keep the app open. The two failures that are **not** transient are not silent either: a lost session reloads the web view to its login screen and sends one notification (5.2, 7.7), and a blocked authorization is the third icon's own state with the reason in words. The counts of every failure by status live in the diagnostic report (7.8), which is where a question about the pipeline belongs. So `postError` is `null` under the shell driver, deliberately and permanently, and 7.5 gains no failure event to carry it.

**The third icon changes meaning, and `SPEC.md` 8.6 is amended to say so** (14). In Safari it is _foreground tracking_ — active or paused, and paused is how phones work. In the shell it is _tracking_ with four states drawn from the `tracking` event: **on in the background** (ok), **on while open only** (degraded — When In Use, or consent not given, with the panel's words saying which and offering `openConsent`), **blocked** (bad — reduced accuracy, denied, services off, with the reason in words), **idle** (bad — not signed in, which the screen showing it can only reach while signed in, so in practice a session being ended underneath it). The shapes do not change (`SPEC.md` 8.6); the words in the panel do. **Those four states reach `TrackingIndicator` from the shell module of 8.1, not from `SampleTrackingState`** — which is what keeps the interface unchanged. `trackingActive` stays the two-state boolean for every reader that wants only a boolean, and under the shell it is the coarser reading of the same event: never wrong, only less specific.

**A dropped fix is not a bad fix, and the indicator takes up to `GPS_STALE_MS` to say so.** The web app never receives a fix the tracker refused (7.5), so a stretch of fixes worse than `FOG_MAX_ACCURACY_M`, or a `blocked(reducedAccuracy)` state, arrives as **no `position` events at all** rather than as bad ones. `gpsStatus` therefore reaches `poor` through the staleness rule, up to `GPS_STALE_MS` (30 s) later than Safari would have reached it through the accuracy rule. Both end in the same state, the delay is bounded by one constant, and the reason is on the third icon in words while it lasts.

**The teleport mode (`SPEC.md` 9.3) is unchanged, and it is the one case where the hook still posts.** While it stands, the hook asserts the teleported point and posts it on its own path regardless of driver, because the teleport is a server-side test fixture and not a position source. So while it stands, `lastPosition`, `queueDepth`, the internal `behindDepth` and `postError` are that path's, exactly as in Safari, and incoming `position` events are ignored for `lastPosition` — the shell's fixes are the real position, which is the position the mode exists to override. `flush` events keep feeding the members that read the server's answer, since those answers are the server's whatever posted them. What this leaves is two posters against one account for as long as an admin stays teleported inside the app; O-I8 records it, and it is not fixed here because the mode is admin-only, gated by `ADMIN_TELEPORT_ENABLED` (`SPEC.md` 4.3), and reaches no player.

### 8.4 What the shell hides or replaces

- **The push offer** in `screens/HowMasteringWorks.tsx` (`usePushSubscription`) is replaced under the shell by a button that posts `requestNotifications`; the hook reports `unsupported` there, which it already does when the Push API is absent, so the change is the button's destination and not the hook.
- **The Screen Wake Lock** is not requested (8.3).
- **The "tracking pauses when the app is not in the foreground" sentence** in the indicator's panel is replaced by the state-specific words of 8.3.
- **The direction-of-travel cone** is absent (6.6, O-I3).

### 8.5 The web view's configuration

- **App-Bound Domains.** `Info.plist` lists `SERVER_ORIGIN`'s host as the only entry in `WKAppBoundDomains`, and the configuration sets `limitsNavigationsToAppBoundDomains = true`. This is what makes Service Workers available inside `WKWebView`, so the web app's one service worker (`SPEC.md` 4.1) registers and the offline shell works in the app as it does in Safari. It also confines the web view to the one origin it should ever load.
- **Links that leave the origin cannot be followed in the web view**, and there are three: "Report a bug on GitHub" (`SPEC.md` 8.4), the two outbound links on `/privacy` (`SPEC.md` 10.3), and the OSM attribution (`SPEC.md` 10.5). The shell's `WKNavigationDelegate` cancels any navigation whose host is not app-bound and opens the URL in Safari, and `WKUIDelegate.createWebViewWith` does the same for `target="_blank"`. The web app does not need to know; `openExternal` (8.2) exists for a screen that wants to be explicit.
- **Cookies** are the default persistent store, so the session survives an app restart exactly as in Safari.
- **Scrolling.** `scrollView.bounces = false` and `contentInsetAdjustmentBehavior = .never`: the map screen is `position: fixed` and pads its own safe areas (`SPEC.md` 8.2), and a bouncing web view under a map that is meant to be dragged is a map that lurches.
- **Media and JavaScript** default; no `allowsInlineMediaPlayback` decisions apply, the app plays nothing.
- **The web view is created once** and kept for the process's life. Navigating away from the map does not destroy it, and the tracker does not care whether it exists.

### 8.6 Settings

The web app's Settings screen gains, under the shell only, a "Background tracking" row that shows the consent state (5.4) and opens the Consent screen through `openConsent`. The row does not render in Safari, where it would describe a feature the browser does not have. The privacy page changes are in 10.2 and render everywhere, because the policy is one document.

---

## 9. Server changes

Two additions, both backwards compatible with every client the parent describes, and nothing else.

### 9.1 `POST /api/samples` reports why samples were refused

The response gains one field:

```ts
rejected: { accuracy: number, future: number, stale: number, outsideCity: number, tooFast: number }
```

One count per gate of `SPEC.md` 7.2, in that section's order and naming, for the samples of *this request only*. A batch of sixty in which fifty-eight were accepted answers with counts summing to two. Nothing is stored; the counts are computed in the same loop that already decides each sample's fate in `processSampleBatch` (`packages/api/src/routes/fog.ts`) and are gone with the request.

**It leaks nothing.** Every count concerns the caller's own samples, which the caller sent. It does not say *which* sample failed or where; a client that wants that already knows what it sent.

**Why the server and not the tracker.** The tracker could compute two of the five (7.1) and none of the other three — the bounding box, the teleport speed and the clock skew are judged against state and a clock the server holds and the client does not, which is exactly `SPEC.md` 7.3's argument for `tooFastToReveal`. The counts exist so that the walk of 13.3 can distinguish "the phone posted nothing" from "the phone posted and the server refused it", and only the server can say the second.

The web client's response guard (`packages/web/src/api/response-guards.ts`) does not check the field, because no web screen reads it; the tracker's guard does. The admin teleport (`SPEC.md` 9.3) answers with the same body and therefore the same field, with `tooFast` always zero, because its gate is off.

### 9.2 Background-tracking consent on the account

`users` gains `background_tracking_consented_at INTEGER NULL` by migration, defaulting to `NULL` — no existing account and no new registration consents by default. The `User` shape (`SPEC.md` 9.6) gains `backgroundTrackingConsentedAt: number | null` — epoch **seconds**, like every timestamp the database holds (Section 0, rule 6) — so `GET /api/auth/me`, login, registration and `PATCH /api/settings` all carry it.

**`PATCH /api/settings` takes a partial body.** Today `settingsSchema` (`packages/api/src/routes/account.ts`) is `z.object({ isAnonymous: z.boolean() })` and is **not** partial, so a body naming only a consent field is a 400 before the route sees it: "accepts `{ backgroundTracking }` beside `isAnonymous`" has no implementation until the schema changes. It becomes two optional booleans of which at least one must be present:

```ts
const settingsSchema = z
  .object({
    isAnonymous: z.boolean().optional(),
    backgroundTracking: z.boolean().optional(),
  })
  .refine((data) => data.isAnonymous !== undefined || data.backgroundTracking !== undefined);
```

and the route applies exactly the keys the body names, leaving every column it does not name alone. Step C has no decision left; this table is the whole of the contract:

| Request body | What the route does |
| --- | --- |
| `{ isAnonymous }` | sets anonymity, leaves consent untouched — **every existing caller, byte for byte unchanged** |
| `{ backgroundTracking }` | sets consent, leaves anonymity untouched — which is the point: a consent screen must never assert an anonymity value, and with this shape it neither has to read one first nor can flip one by accident |
| both keys | both applied, in one `UPDATE` on one row, so there is no order between them and no window in which one has landed and the other has not. The two settings are independent and naming one never implies anything about the other |
| `{}` | **400** `invalid_request_body`, the route's existing error (`sendInvalidRequestBody`). A body that names nothing is a caller with a bug, and a 200 that changed nothing would hide it. Because the schema is not `.strict()`, a body naming only keys it does not know — `{ backgroundTrackng: true }` — parses to the same empty object and is the same 400, so a misspelt key is loud rather than silent |
| either key `null` | **400.** The column is nullable; the wire field is not. `false` already means "withdraw", and a second spelling of one act is a client sending the other |
| either key not a boolean | **400.** This is the one body whose treatment changes: `{ isAnonymous: true, backgroundTracking: 5 }` is a 200 today, because an unknown key is stripped, and is a 400 after. No client in the parent sends that key at all |
| no body, or a body that is not an object | 400, as today |
| unauthenticated | 401, as today — `requireAuth` and the `request.userId` guard are untouched |

Every body that answers 200 today still answers 200, and every body that answers 400 today still answers 400. The route is a strict widening.

**The response is unchanged**: 200 with the bare `User` of `SPEC.md` 9.6, now carrying `backgroundTrackingConsentedAt`, so a caller that has just written consent learns the recorded timestamp from the same response and never needs a follow-up `GET /api/auth/me`.

**What `backgroundTracking` writes.** `true` writes the server's current second; `false` writes `NULL`. A `true` sent while the column already holds a timestamp re-stamps it, because the endpoint is only ever called from a player's explicit act — the Consent screen's button (11.2) or the Settings row (8.6) — and the record Article 7(1) wants is when the player last gave this consent, not the first time they ever did. Nothing else writes the column: the shell **reads** it at start (5.4, 7.3) and never writes it, and the server itself never writes it (below).

**Omitted-means-unchanged is the parent's own reading of a PATCH, not an invention here.** `PATCH /api/admin/bars/:id` and `PATCH /api/admin/users/:id` are both partial already (`SPEC.md` 9.3: _"An omitted field means unchanged… an unknown field is ignored"_), so this makes `/api/settings` consistent with the two PATCH routes the parent already has rather than special. The one place it diverges from `patchUserSchema` is the empty body, which that route accepts as a no-op: there, the response is a user row the admin screen puts straight back into its list and a no-op costs nothing; here, the body carries a consent record, and a call that recorded nothing must not answer like a call that did.

**Why not a separate route.** A `PATCH /api/settings/background-tracking`, or a `POST /api/consent`, would leave `settingsSchema` alone and was weighed against the shape above. It is rejected on four counts. This section's opening promises "two additions… and nothing else", and a third route is a third addition that lands in the parent's `SPEC.md` 9.2 route table, 9.4's rate limits, 9.6's response shapes and the web client, all for one boolean. 5.4's rule is that **one** client writes settings and it is the one that already does; a second route splits the write path for the same row, and its only caller would be the consent screen — the corner nothing else exercises. Whatever it answered would be wrong in one of two ways: `User` makes it `PATCH /api/settings` under another name, and `{ ok: true }` makes the consent screen read the account a second time to learn the timestamp it just wrote. And the one real advantage a separate route has — never touching anonymity — is exactly what the partial body already delivers, without the read-modify-write that an optional-key-on-a-required-schema reading would have forced.

**The web client widens with it.** `updateSettings` in `packages/web/src/api/client.ts` takes `{ isAnonymous?: boolean; backgroundTracking?: boolean }` and its existing caller, the Settings screen's anonymity toggle, passes what it passes today. `packages/web/src/api/types.ts`'s `User` gains the field with the shape above.

**The server does not act on it.** It cannot tell a background sample from a foreground one and has no reason to try. The column is the record Article 7(1) GDPR wants the controller to be able to produce (10.1), and the value the shell reads at start to decide whether background tracking is allowed on this account (5.4). It is deleted with the account (`SPEC.md` 10.6), and it is not shown on the leaderboard, profiles or the admin user list, none of which have a reason to know.

---

## 10. Privacy and legal

Germany is where this app runs, and the GDPR and the TDDDG are the law it runs under. Nothing in either forbids an app tracking a consenting adult's location in the background. What both require is that the consent be real, separate, informed and revocable, and that the app say what it does. The data-minimisation design the parent already has — raw positions processed in memory and discarded, only revealed cells stored (`SPEC.md` 10.2) — is the strongest single argument this app can make to a supervisory authority, and every decision below preserves it.

### 10.1 Consent

**Background tracking rests on consent, Art. 6(1)(a).** The foreground game arguably rests on Art. 6(1)(b) — the player asked for a location game and location is the game — but background collection is a different act, so it gets its own basis and its own question. Continuous background location is also the kind of processing Art. 35 names as a candidate for a data protection impact assessment; at this scale "large scale" is not met, and a short written DPIA is nonetheless recorded as O-I4, because the German DSK's list of DPIA cases includes location tracking and the assessment costs an afternoon.

**TDDDG § 25** governs access to information on the terminal device, which reading a GPS sensor is. Its "strictly necessary" exception is not relied on: consent is obtained.

**What the consent is, in order, on the Consent screen (11.2):**

1. A plain description, in the app's own words, of what background tracking does — that the phone will send its position to the game's server while the app is closed, that the server turns it into revealed map squares and bar visits and keeps no trail, that Cloudflare carries the request (`SPEC.md` 10.3), that iOS shows a status-bar indicator while it runs, and that it costs battery.
2. How to stop: the row in Settings (8.6), this screen, or iOS's own Location setting, any of which ends it at once.
3. A checkbox, unchecked, with the consent sentence; the button that records it (5.4) is disabled until the box is checked.
4. Only then, the iOS prompt for Always (6.2).

**Apple's permission dialog is not this consent.** It is a platform gate, worded by Apple, presented after the app's own question and never instead of it. A player who grants Always in iOS and has not checked the box is not tracked in the background (5.4).

**The age gate** is the web app's (`SPEC.md` 10.4) and applies before any of this is reachable.

### 10.2 The privacy page

`/privacy` (`SPEC.md` 10.3) gains a section, "The iPhone app", rendered everywhere the page renders, stating: that the app can collect location while closed, only after the consent above; that the app's samples are processed exactly as the browser's and stored exactly as little; that the app schedules notifications on the device and uses no push service, so no outside party carries them (this corrects, for the app, the sentence naming the browser vendor's push service, which remains true for Safari); that the app stores on the device only the consent preference, the notification preference and the diagnostic counters of 7.8, none of which is a position; that the consent timestamp is stored on the account and deleted with it; and that the diagnostic report, if the player shares one, contains counts and no coordinates. The Article 13 items already on the page — retention, the anonymity setting, deletion, the backup caveat — are unchanged and cover the app.

The Impressum requirement (DDG § 5) is met the way the parent meets it: the page links to the one on `ahultsch.com`, and the link is reachable from the app (8.5).

### 10.3 Apple's requirements

Even outside the App Store, a build uploaded to App Store Connect for TestFlight is checked for a privacy manifest. `PrivacyInfo.xcprivacy` declares: `NSPrivacyTracking` false; `NSPrivacyCollectedDataTypes` with precise location, linked to the user's identity, not used for tracking, purpose app functionality; `NSPrivacyAccessedAPITypes` with `UserDefaults` under reason `CA92.1` (the app's own preferences and counters). The `Info.plist` purpose strings are the consent's words in short: `NSLocationWhenInUseUsageDescription` explains the foreground game, `NSLocationAlwaysAndWhenInUseUsageDescription` the background one, and `NSLocationTemporaryUsageDescriptionDictionary`'s `TTPlay` entry why precise location is needed at all (6.2). All three are English (C9).

### 10.4 What the device holds

For the avoidance of a later re-read finding otherwise (`HANDOVER.md` Section 8's fourth habit): the app's `UserDefaults` hold the consent preference mirror, the discovery-notification preference, the daily counter buckets of 7.8, and the timestamp the tracker last ran. The app's cookie store holds the session cookie. The notification centre holds the text of delivered notifications, which is bar names. The web view's storage holds what Safari's would — the fog cache keyed by user id (`SPEC.md` 10.2) and the "seen the explainer" flag. **Nothing else, and no coordinate anywhere.** Sign-out clears the web view's storage exactly as it does in Safari, and the shell clears its counters on account deletion, which it learns of through the cookie vanishing after `DELETE /api/account`.

---

## 11. Screens

Four native screens, in SwiftUI, following `SPEC.md` 8.1 as far as SwiftUI allows: paper ground, ink text, the system serif for the wordmark in capitals with wide tracking and the system sans for everything else (the same two families the web app uses, `SPEC.md` 8.2), the one accent for the active state of a control and for nothing else, 44 pt targets. No native screen shows a map.

### 11.1 Primer

Shown once, on first launch, before the web view. The wordmark; three sentences on what the game is and why it needs location while the app is open; one button, "Continue", which requests When In Use (6.2). A player who declines lands on the web app with the indicator saying blocked (8.3), and the Primer is not shown again — the way back is iOS Settings, and the indicator's panel links there. A player who already has an authorization state other than `.notDetermined` never sees this screen.

### 11.2 Consent

Reached from the web app's Settings row (8.6), from the indicator's panel when tracking is "on while open only", and from `requestNotifications`. It holds the four steps of 10.1 in order, then a notifications section: a description of the four notifications (7.7), a switch for discovery notifications, and a button that requests notification permission. It shows the current state of each — consented on the account or not, iOS authorization, notification permission — so it is also where a player sees why background tracking is off. Withdrawing consent is a button on this screen, behind a confirmation that names what it stops and what it keeps (everything revealed so far).

### 11.3 Diagnostics

Reached from the Consent screen's footer. Every counter of 7.8 for today and for the retained days, the current state of the tracker, the authorization pair, the low-power flag, the last time the tracker ran, and the last exception if any. A "Share report" button exports the JSON of 7.8 through the share sheet. This screen exists for the walk of 13.3 and stays in the app afterwards; it holds nothing a player should not see about their own phone.

### 11.4 Unreachable

Shown in place of the web view when the initial load of `SERVER_ORIGIN` fails and there is no cached shell to show — a fresh install with no connectivity. One sentence, one "Try again". Once the web app has loaded once, its own service worker owns the offline case (`SPEC.md` 12, Phase 8) and this screen is not shown.

---

## 12. Development steps and Definition of Done

`SPEC.md` Section 12 gains one phase, **Phase 9 — iOS companion**, whose Definition of Done is the union of the steps below. The parent's rule on gating applies: an item only the owner's phone can settle stays `[ ]` with what it needs named, and does not gate the next step; an unticked item with no annotation does. Each step ends in a commit with the four root commands green.

Each step is delegated as a sequence of **substeps**, and a substep exists exactly where a command can prove it. The verification column names that command: it is the narrow, fast one the executor runs. It is not authoritative on its own — `HANDOVER.md` records that a single package's tests bypass the shared rebuild hook and can read a stale `dist` — so the four root commands of `CLAUDE.md` are run at every step boundary by the reviewer, and they are what decides.

### Step A — Amendments and scaffold

The `SPEC.md` amendments of Section 14, in one commit, with `HANDOVER.md` updated in the same commit (`CLAUDE.md`). `packages/tracker` created with its manifest, `tsconfig`, Vite config and an entry that evaluates and exposes an empty tracker. The constants of 7.1 added to `config.ts`. `.gitignore` updated (4.2); `.prettierignore` needs nothing, because its one line arrives with `ios/` itself.

| # | Does | Verification |
| --- | --- | --- |
| A0 | This substep table into Section 12 | `pnpm format:check` |
| A1 | The nine constants of 7.1 into `packages/shared/src/config.ts` | `pnpm --filter @tipsytrails/shared test` |
| A2 | `packages/tracker` scaffold, its two tests, the `pnpm build` wiring, `.gitignore` | `pnpm --filter @tipsytrails/tracker test`, `pnpm build` |
| A3 | The eighteen `SPEC.md` amendments of Section 14 and `HANDOVER.md`, version 1.59 | `pnpm --filter @tipsytrails/shared test` |

A1 precedes A3: `SPEC.md` 7.1 reproduces `config.ts` key for key and nothing tests that agreement, so the reproduction is written by copying a file that already exists.

**Definition of Done**

- [ ] `SPEC.md` carries every amendment in Section 14, its version bumped, its changelog entry written; `packages/shared/src/spec-version.test.ts` and `HANDOVER.md` agree with it
- [ ] `pnpm build` builds `packages/tracker` after `shared` and produces one file, `packages/tracker/dist/tracker.js`, that evaluates in a bare `vm` context with `globalThis.__tipsyTrailsHost` set and defines `globalThis.__tipsyTrails` — a test in `packages/tracker` asserts this against the built output
- [ ] `packages/tracker/tsconfig.json` has `lib: ["ES2022"]` and no DOM lib, and a test asserts that `dist/tracker.js` contains no reference to `window`, `document`, `navigator` or `localStorage`
- [ ] Every constant of 7.1 is in `config.ts` and nowhere else; `pnpm lint` passes

### Step B — The tracker

Sections 7.2–7.8 in full, under Vitest with a fake host and a controllable clock.

| # | Does | Verification |
| --- | --- | --- |
| B1 | `host.ts`, `events.ts`, `counters.ts` — the interface, the event union, the counters of 7.8 | `pnpm --filter @tipsytrails/tracker test` |
| B2 | `queue.ts` — 7.4's enqueue, the two local drops, the cap, `behind` | as above |
| B3 | `api.ts` — the three calls the tracker makes, with their response guards | as above |
| B4 | `visits.ts` — 7.6's visit set and its near-bar test | as above |
| B5 | `tracker.ts` — 7.3's states and the profile table | as above |
| B6 | The flush — 7.4's cadence, batch, backoff, and the three statuses that do not retry | as above |
| B7 | `notifications.ts` — 7.7's four, and what cancels each | as above |

`counters.ts` is in B1 and not last because the queue drops and counts in the same step; `visits.ts` precedes the state machine because profile selection reads the visit set. B2's `behind` and `useSampleTracking`'s share one test fixture rather than being two implementations that agree today.

**Definition of Done**

- [ ] The state machine of 7.3: every transition in the diagram has a test, and every emitted `tracking` event is asserted for its payload
- [ ] `start` calls `GET /api/auth/me` before anything else and goes `idle` on 401 with exactly one `sessionLost`; consent `null` on the answer keeps `background: false` whatever the authorization
- [ ] The profile table of 7.3: foreground / walking / dwelling chosen correctly for each combination of app state and visit set, and `configureLocation` called with the `config.ts` values and no other number — a mutation test changes each constant and asserts the call changes with it
- [ ] The queue of 7.4: enqueue drops on accuracy and staleness with separate counters, the cap drops the oldest, `behind` matches `useSampleTracking`'s definition on the same scenario (a shared test fixture, so the two cannot drift)
- [ ] The flush of 7.4: cadence at `SAMPLE_MIN_INTERVAL_MS`, batch at `SAMPLE_MAX_BATCH`, one in flight, backoff doubling to the cap and resetting on success, `Retry-After` honoured on 429, 401 and `password_change_required` stop without retry, a guard-rejected response retries
- [ ] Visits of 7.6: seeded from the pending endpoint, updated from `visitUpdates`, told by the page, reconciled on foreground; the dwelling profile ends when the last accepted position is beyond `BAR_DISCOVERY_RADIUS_M`
- [ ] Notifications of 7.7: the reminder scheduled at `startedAt + VISIT_PUSH_AFTER_MS` and cancelled when the visit leaves; mastered and discovered notifications with the stated text; nothing scheduled for `newCells`
- [ ] Counters of 7.8: every counter named there exists and moves in the scenario that should move it; a test asserts the report's JSON contains no key named `lat`, `lon`, `latitude`, `longitude`, `cell` or `barId` and no floating-point value at all
- [ ] The tracker's response guard accepts the parent's `POST /api/samples` shape plus `rejected` and rejects a batch answer missing any field it reads

### Step C — The server

Section 9.

| # | Does | Verification |
| --- | --- | --- |
| C1 | `rejected` on `POST /api/samples` and on the teleport; the web types and guard beside them | `pnpm --filter @tipsytrails/api test` |
| C2 | The migration, the consent column, `PATCH /api/settings`, the `User` shape, and the absence and cascade tests | as above |

**Definition of Done**

- [ ] `POST /api/samples` and `POST /api/admin/teleport` answer with `rejected`; a test per gate sends a batch that fails only that gate and asserts the one count; the existing web response guard still passes on the new shape
- [ ] Migration adds `background_tracking_consented_at`; `PATCH /api/settings` sets it to the server's current second on `backgroundTracking: true` and to `NULL` on `false`; `User` carries it on every route that returns a user; it is absent from the leaderboard, profile and admin-user shapes — asserted
- [ ] `PATCH /api/settings` takes the partial body of 9.2, with a test per row of that section's table: `{ isAnonymous }` alone leaves consent untouched, `{ backgroundTracking }` alone leaves anonymity untouched, both together apply both, `{}` and an unknown-key-only body are 400, either key `null` or non-boolean is 400, unauthenticated is 401. The existing `PATCH /api/settings` tests pass unedited — a body that answered 200 before answers 200 now
- [ ] `DELETE /api/account` takes it with the row (cascade already does; a test says so)

### Step D — The web app

Section 8.

| # | Does | Verification |
| --- | --- | --- |
| D1 | `packages/web/src/shell/` — 8.1's detection and 8.2's typed bridge | `pnpm --filter @tipsytrails/web test` |
| D2 | `useSampleTracking` gains the driver seam and the shell driver | as above |
| D3 | The indicator's four shell states, their words and their accessible names | as above |
| D4 | The push offer, the Settings row, and `/privacy`'s section | as above |
| D5 | The five outbound messages, at the moments 8.2 fixes | as above |

D2 is the largest risk in this plan: it puts a seam through the hook every screen reads. Its evidence is spies that must not be called — no `watchPosition`, no post to `/api/samples`, no wake lock — and the existing screen tests re-run against the new driver.

**Definition of Done**

- [ ] `useSampleTracking` under the shell driver: no `watchPosition`, no `fetch` to `/api/samples`, no wake lock — asserted by spies that must not be called; **each of the thirteen rows of 8.3's table has a test**, including `trackingActive` across `tracking` / `blocked` / `idle`, `postError` staying `null` through a run in which the tracker's flushes fail, and `queueDepth` and the internal `behindDepth` taken from the `queued` and `behind` of `queue` and `flush`; `SampleTrackingState` still has thirteen members, asserted against the type so a fourteenth cannot be added without this item failing; the existing screens' tests re-run against the shell driver
- [ ] The four counters start at nought on mount and are advanced only by a `flush` that arrives after the subscription: a late-mounting listener seeded with the bridge's replayed `flush` payload gets `newBars` and `visitUpdates` and stamps nothing, refetches nothing and re-reconciles nothing — asserted with `useBarStamps` and `useVisits` mounted against a bridge that already holds a payload
- [ ] The indicator's third icon shows the four states of 8.3 with the stated words, keeps its shape, and its accessible name states the state
- [ ] The push offer becomes `requestNotifications` under the shell; `usePushSubscription` reports `unsupported` there
- [ ] The Settings row of 8.6 renders under the shell and not in Safari; `/privacy` carries the section of 10.2 everywhere
- [ ] `ready`, `signedIn`, `signedOut`, `visitStarted`, `visitEnded` are posted at the stated moments — `signedOut` before the logout request, asserted by order

### Step E — The replay harness

Section 13.2. This is the step that proves the whole pipeline in this repository, and it is deliberately before the Swift so that the contract the Swift has to meet is a passing test rather than a paragraph.

| # | Does | Verification |
| --- | --- | --- |
| E1 | The harness: the route, the fake host, `app.inject` as `fetch`, and loading the built bundle | `pnpm --filter @tipsytrails/tracker test` |
| E2 | Scenarios 1–4 of 13.2 | as above |
| E3 | Scenarios 5–8 of 13.2 | as above |

**Definition of Done**

- [ ] The eight scenarios of 13.2 run under `pnpm test`, loading `packages/tracker/dist/tracker.js` — the built bundle, not the source — against `buildApp` from `@tipsytrails/api` on an in-memory SQLite, and each asserts what 13.2 says it asserts

### Step F — The shell

Sections 4–6, 8.5, 10.3, 11. Written without a compiler, and the Definition of Done says so item by item.

| # | Does | Verification |
| --- | --- | --- |
| F1 | `project.yml`, `Server.xcconfig`, `Info.plist`, `PrivacyInfo.xcprivacy`, and the test that parses all four | `pnpm --filter @tipsytrails/tracker test` |
| F2 | The Swift of `App/`, `Location/`, `Runtime/`, `Web/`, `Notifications/`, `Diagnostics/` | none — reviewed by reading |
| F3 | The Swift of `Screens/` — Section 11's four screens | none — reviewed by reading |
| F4 | The two mechanical guards: no numeric literal in Swift, and `Host` method parity | `pnpm --filter @tipsytrails/tracker test` |

F2 and F3 are the only substeps in this plan whose output nothing in this repository can execute (13.1). They are reviewed by reading, and F4 is what turns two of this document's rules into something a machine checks.

**Definition of Done**

- [ ] `ios/project.yml`, `Config/Server.xcconfig`, `Info.plist`, `PrivacyInfo.xcprivacy` exist and are valid YAML, plist and JSON respectively — asserted by a test in `packages/tracker` that parses them, checks the four purpose strings are non-empty English, the background mode is `location`, `WKAppBoundDomains` has exactly the server's host, and no key in either plist is a number that also appears in `config.ts` (I1, mechanically)
- [ ] Every Swift file in `ios/TipsyTrails/` carries no numeric literal other than `0`, `1` and `-1` — a grep test, because the constraint is textual and nothing here can compile
- [ ] The runtime module implements every method of the `Host` interface of 7.2 and no other — a test compares the Swift method names against the TypeScript interface's
- [ ] **The app builds in Xcode** — owner's Mac
- [ ] **The app runs, loads the web app, signs in, and the map shows a position** — owner's phone
- [ ] **A headless launch runs the tracker** — owner's phone, by forcing a termination and walking (13.3, walk 2)

### Step G — The walk

Section 13.3, run by the owner, with the report of 7.8 attached to the commit that closes the step.

Step G has no substeps: it is six walks, and the owner runs them.

**Definition of Done**

- [ ] Each of the six walks has a report, and the observations column of 13.3 is filled in from them
- [ ] Any sentence in this document the walk falsified is corrected in the same commit, with the report as the evidence

---

## 13. Verification

### 13.1 What is proven where

| Claim | Proven in this repository | Needs the owner's phone |
| --- | --- | --- |
| The tracker's every decision (7.3–7.8) | Vitest, Step B | — |
| The server's two additions (9) | Vitest, Step C | — |
| The web app's behaviour under the shell (8) | Vitest with a fake bridge, Step D | — |
| A walk through Karlsruhe reveals the right cells, discovers the right bars, completes a dwelt visit, survives a dead spot, a relaunch, a 401 and a 429 — through the built bundle against the real API (13.2) | Vitest, Step E | — |
| The shell's configuration files are consistent with this document and with `config.ts` | Vitest, Step F | — |
| The Swift compiles and the `Host` bridge works | — | Xcode |
| iOS delivers fixes in the background, at the stated cadence, on this phone | — | 13.3 |
| The Always upgrade prompt, the periodic re-ask, Low Power Mode, Precise Location off | — | 13.3 |
| Relaunch after a system kill; the force-quit rule of 6.4 | — | 13.3 |
| Battery cost over an evening | — | 13.3 |

The line is drawn where it is because everything above it is a decision and everything below it is the platform. The Swift below the line is written to contain no decisions (I1, Step F's grep), so that what the phone tests is Apple's behaviour and the bridge's plumbing, and not this app's logic.

### 13.2 The replay harness

`packages/tracker/src/replay/` builds a synthetic walk and runs the built tracker through it against the real API. It needs no fixture beyond what the repository already commits: two bars from `data/seed/karlsruhe/bars.json` about a kilometre apart, a straight-line route between them at 1.3 m/s, a fix per second with accuracy jittered between 5 and 25 m by a seeded generator. Time is the fake host's clock; nothing sleeps. The API is `buildApp(env, db)` with `better-sqlite3`'s `:memory:` and the committed seed, and the host's `fetch` is `app.inject`, so there is no socket and the whole run is deterministic.

The eight scenarios, and what each asserts against the database and the emitted events:

1. **Foreground walk.** Every fix queued; flushes every `SAMPLE_MIN_INTERVAL_MS`; `rejected` all zero; the cells within `FOG_REVEAL_RADIUS_M` of the route are set in `fog_state.mask` and no others; both bars discovered when passed within `BAR_DISCOVERY_RADIUS_M`.
2. **Background walk.** The harness applies the walking profile's distance filter to the fixes before handing them over, as Core Location would; fewer samples reach the server; **the same cells are revealed** — the assertion that justifies `TRACKER_WALKING_DISTANCE_FILTER_M`.
3. **Dead spot.** `fetch` fails for fifteen minutes mid-walk. Backoff climbs to the cap; on recovery the batch that goes first has been stripped of certainly-stale samples; the server's `rejected.stale` is zero (the local drop was right); the cells walked in the dead spot beyond `SAMPLE_MAX_AGE_MS` ago are *not* revealed and the counters say how many samples were dropped — the honest cost, asserted rather than hidden.
4. **Headless relaunch.** The tracker is destroyed mid-walk and a new instance started in `launchedHeadless`; it seeds visits from the API, restarts tracking, and the walk continues; the queue was lost (I2) and the fixes in it are the gap.
5. **Dwelling.** A check-in via `POST /api/visits` at the first bar; the fake clock advances twenty-one minutes with the player standing still; the dwelling profile is in force; the visit's `completed` arrives in a `flush`; the reminder was scheduled at `startedAt + VISIT_PUSH_AFTER_MS` and cancelled before it fired; the mastered notification was scheduled once.
6. **Reduced accuracy.** The authorization event flips to `reducedAccuracy`; the state is `blocked`; zero requests are made while it stands; it returns to `tracking` when the event flips back.
7. **Session ends.** A 401 mid-walk; exactly one `sessionLost`; the state is `idle`; no further request for the rest of the run however many fixes arrive.
8. **Rate limited.** A 429 with `Retry-After: 30`; the next flush is thirty seconds later and not before; the backoff is reset afterwards.

Scenario 2 is the one that would have caught the question this document spent its first draft on: whether a distance filter matched to the grid loses cells. Scenario 3 is the one that makes `SAMPLE_MAX_AGE_MS` a measured cost rather than a surprise.

### 13.3 The walk

Six walks, each with a report from the Diagnostics screen exported at the end, and a column to fill in. The report is the evidence; a walk without one did not happen.

| # | Walk | Do | The report must show | The map must show | Observed |
| --- | --- | --- | --- | --- | --- |
| 1 | **Baseline** | Twenty minutes with the map on screen | `rejected` all zero; fixes received ≈ 1/s; no drops | The walked streets revealed as they are today | |
| 2 | **Pocket** | Lock the phone, put it away, walk thirty minutes through streets not yet revealed | Fixes received at roughly one per 25 m; flushes succeeding; the profile `walking` throughout; if a `location`-cause start appears, the system killed and relaunched the app | The walked streets revealed on next open, with no gap except at a relaunch | |
| 3 | **Force-quit** | Force-quit from the app switcher, walk fifteen minutes, open the app | Whether any start with cause `location` occurred — this is the question 6.4 leaves open | Either nothing revealed (the documented rule) or the walk revealed (the rule has changed; fix 6.4) | |
| 4 | **Dwell** | Check in at a bar, lock the phone, stay twenty-five minutes | Profile `dwelling`; fixes at ~1/s; a `completed` visit; the reminder cancelled, the mastered notification delivered | The glass nearly empty on the marker, without the app having been opened | |
| 5 | **Low Power Mode** | Walk 2 again with Low Power Mode on | Fixes per hour under the flag, compared with walk 2 | Whatever gaps the rate produced, honestly | |
| 6 | **Precise Location off** | Turn it off in Settings, open the app | State `blocked(reducedAccuracy)`; zero flushes; the temporary-accuracy prompt shown once | The indicator bad, with the words naming Precise Location | |

Beside the six: note when the Always upgrade prompt appeared and what was chosen; note the day the periodic re-ask appeared; note the battery percentage at the start and end of the longest evening. None of these has a pass mark. They are what this document could not know.

---

## 14. Amendments this document requires of `SPEC.md`

Made in Step A, in one commit, each inside its section without renumbering, with a changelog entry for v1.59. None changes a Hard Constraint.

| Section | Amendment |
| --- | --- |
| Front matter, _What this is_ | "played in a mobile browser" gains ", or in the iPhone app of `ios/SPEC.md`" |
| 3, _Explicitly excluded_ | remove "native app wrappers"; add a sentence that the iOS app is specified in `ios/SPEC.md` and is a shell around the same web app, and that the exclusion of native rewrites, cross-platform frameworks and background-location SDKs stands |
| 3, dependency table | add `packages/tracker`'s two rows (3 here) |
| 3, commands | `pnpm build` gains `tracker` after `shared` |
| 4.2 | the tree gains `ios/` and `packages/tracker/` as in 4.2 here. `.prettierignore` needs no amendment: it is a bare list with no comments in it, and its `ios/SPEC.md` line arrives on `main` with `ios/` itself rather than being added by Step A |
| 5.3 | `users` gains `background_tracking_consented_at` with the sentence of 9.2 |
| 7.1 | the constants block gains the keys of 7.1 here, in `config.ts` |
| 7.2 | "The app cannot receive positions in the background" becomes "The web app cannot…", and the paragraph gains: "The iPhone app can, through a native location session, and `ios/SPEC.md` Section 6 is the authority on what that can and cannot do. Its samples pass every gate below unchanged." |
| 7.5, _Accepted trade-off_ | "it would require either background tracking (impossible, Section 7.2)" becomes "the iPhone app can now supply the samples (`ios/SPEC.md` 7.6), and this trade-off is kept as a decision rather than a limitation: a visit still completes on two samples and is never enforced by presence" |
| 7.5, push bullet | gains "In the iPhone app this reminder is a local notification (`ios/SPEC.md` 7.7); no push subscription is made there." |
| 8.6 | the third icon's definition gains the shell's four states of 8.3 here; the "tracking pauses when the app is not in the foreground" sentence is scoped to the web app |
| 9.2 | `POST /api/samples` gains `rejected`. The `PATCH /api/settings` row's request note stops being `{ isAnonymous }` and becomes the partial body of 9.2 here — `{ isAnonymous?, backgroundTracking? }`, at least one key, an omitted key meaning unchanged, `{}` a 400. This is an amendment to what the route **accepts**, not only a field it gained: it is the parent's third partial PATCH and the sentence has to say so, because a reader of the old note would build a required key and break every existing caller |
| 9.6 | `User` gains `backgroundTrackingConsentedAt`; the `POST /api/samples` row gains `rejected` with 9.1's shape; the teleport row says it carries it too. Nothing else: 9.6 is response shapes only and has no request column, so the widened request body of the row above lands in 9.2 and here only as the response `User` carrying the new field |
| 10.2 | _Stored per user_ gains the consent timestamp; a sentence says the app stores no position on the device (I2) |
| 10.3 | the push-service sentence is scoped to browsers; the section of 10.2 here is added |
| 12 | Phase 9 as in 12 here, with a pointer to this document for the steps |
| 14 | O4 becomes "Superseded by `ios/SPEC.md` (v1.59)"; row kept, per that section's rule |
| 15 | v1.59 entry |

`HANDOVER.md`'s opening sentence "There is no Phase 9" is falsified by this and is corrected in the same commit (`CLAUDE.md`), and its Section 2 gains the walk of 13.3 as items only the owner can close.

---

## 15. Open items

| # | Item | Status |
| --- | --- | --- |
| O-I1 | **Android.** The tracker is designed so that a second shell could host it — a `JSContext` equivalent on Android is QuickJS or the system WebView's JavaScript engine, and the `Host` interface is the whole contract. Nothing here is Android-specific except the shell. Not planned; recorded so the design's portability is not lost. | Out of scope |
| O-I2 | **The App Store.** Would need enough native surface to clear Guideline 4.2 and a rating conversation under 1.4.3 (4.3). Not planned. | Out of scope |
| O-I3 | **The direction-of-travel cone** is absent under the shell (6.6). Restoring it means the shell forwarding `course` to the web app on the `position` event — display-only, never to the server — which is a small change once someone has seen the map without it and wants it back. | Deferred |
| O-I4 | **A written DPIA** for background tracking (10.1). An afternoon's document, kept outside the repository because it names the controller. | Open |
| O-I5 | **Whether force-quit is relaunched** on current iOS (6.4). Walk 3 answers it. | Open until 13.3 |
| O-I6 | **The web view's Service Worker under App-Bound Domains** has never been seen running; Step F's first run is where it is confirmed. If it does not register, the offline shell is absent in the app and the Unreachable screen (11.4) covers more cases than it should. | Open until Step F |
| O-I7 | **Battery.** No figure until walk 2 and the evening note of 13.3. If the cost is unacceptable, the levers are `TRACKER_WALKING_DISTANCE_FILTER_M` (a fix per cell instead of per half-cell, at the cost of the corner of a diagonal walk) and `TRACKER_DESIRED_ACCURACY_M` (a hundred metres is still under `FOG_MAX_ACCURACY_M`, and Core Location's hundred-metre mode uses far less radio). Both are `config.ts` changes and both are covered by scenario 2 of 13.2, which would show what each costs in cells. | Open until 13.3 |
| O-I8 | **Two posters while an admin is teleported inside the shell** (8.3). The hook keeps posting the teleported point on its own path while the mode stands, and the tracker keeps posting the real one, so the server's `lastAccepted` alternates between two places and its speed gate refuses some of both. The two ways out are a bridge message that pauses the tracker's own sampling for the duration, and accepting the interleaving as the cost of a fixture. Not fixed here: the mode is admin-only, needs `ADMIN_TELEPORT_ENABLED` (`SPEC.md` 4.3), and reaches no player. | Open |

---

## 16. Changelog

- **v0.4** — Three claims in the amendment bookkeeping that were already false on this branch. 4.2 said `.prettierignore` "gains" `ios/SPEC.md`; it has carried that line since the branch's first commit, and 4.2 now says so, records why `ios/PARENT-CONTRACT.md` is deliberately not listed beside it, and notes that none of the `.gitignore` entries exist yet because there is no Xcode project. Step A's checklist no longer asks for a `.prettierignore` edit it cannot make. Section 14's row for the parent's 4.2 asked Step A to name the file in "`.prettierignore`'s comment" — that file is a bare list with no comments in it, and the line reaches `main` with `ios/` itself rather than by amendment; the row says that instead. `PARENT-CONTRACT.md` gains E4 for `.prettierignore`, which is the one file in the workspace whose contents already differ between the two branches and therefore the one place a merge can conflict over text neither side thinks of as iOS work. The parent pin stays v1.58.
- **v0.3** — Two things this document asked for that could not be built as written. **9.2's `PATCH /api/settings`**: "accepts `{ backgroundTracking }` beside `isAnonymous`" had no implementation, because `settingsSchema` is not partial and a body without `isAnonymous` is a 400 before the route sees it. The endpoint now takes two optional booleans of which at least one must be present, with a table saying what every body does — an omitted key means unchanged, `{}` and an unknown-key-only body are 400, neither key may be `null`, both together are one `UPDATE`, and every body that answers 200 today still answers 200. The alternative, a route of its own, is weighed and rejected in the same section. Section 14's row for the parent's 9.2 says the request note itself changes; its row for 9.6 says why nothing about the request lands there. **8.3's seam**: the section claimed `behindDepth` was an output of the hook when it is local state no screen can read, and left `trackingActive`, `postError`, `newBarsVersion` and `visitVersion` unaccounted for. All thirteen members of `SampleTrackingState` are now in one table with their source under the shell driver; `behindDepth` is corrected and fed by the driver so that one `computeConnectionStatus` serves both; the four counters are the hook's own, start at nought per mount and are never advanced by the bridge's replayed payload; `trackingActive` is the tracker's state rather than a watch's; `postError` is `null` by argument rather than by omission; and the interface is deliberately not widened. Steps C and D's Definitions of Done follow. O-I8 records the two posters an admin teleport produces inside the shell. No amendment of Section 14 is added or removed — there are still eighteen — and the parent pin stays v1.58; nothing on `main` moved.
- **v0.2** — Connected this branch to `main` with something that cannot rot. `ios/PARENT-CONTRACT.md` is added: the dependency surface this app has on the parent (what each entry is on both sides, why the app depends on it, what breaks if it changes), a "not a dependency" section naming what is deliberately out and how each exclusion was checked, and a merge record of one row per merge of `main` into `ios-app` — never one row per change, which is what makes it affordable to keep. The **Parent:** pin in the front matter above is made enforceable by `packages/shared/src/ios-parent-pin.test.ts`, a new test on this branch only, which fails when the pin and the root `SPEC.md`'s version disagree and says in its failure what to do about it. Nothing else in this document changed; the amendments of Section 14 are still Step A's work and are still unmade.
- **v0.1** — First draft, for the owner's review. Specifies the three-part shape (shell, tracker, web app), the reasoning against Capacitor and a native rewrite, the JavaScriptCore decision, the session-borrowing rules, the iOS authorization ladder and its limits, the tracker's constants, host interface, state machine, queue, visits, notifications and counters, the web app's shell driver, the two server additions, the GDPR consent flow and privacy-page section, the four native screens, seven build steps with their Definitions of Done, the verification matrix, the eight-scenario replay harness, the six-walk field test, and the amendments `SPEC.md` needs. Nothing is built.
