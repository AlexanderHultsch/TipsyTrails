// SPEC.md Section 7.1. Every constant this specification defines lives here,
// with exactly one exception: a constant a client must not be given lives in
// `server-config.ts` beside this file, which `packages/web` cannot reach (see
// that file, and Section 0 rule 3). There is no third place, and a call site
// still never inlines a constant from either.
//
// This module is client-safe by definition: everything in it is bundled into
// the browser, because `packages/web` imports `CONFIG` as a value in twelve
// modules and one object literal is all-or-nothing.

export const CONFIG = {
  FOG_REVEAL_RADIUS_M: 100,
  FOG_MAX_SPEED_KMH: 30, // above this, no reveal
  FOG_MAX_ACCURACY_M: 200, // samples worse than this are discarded entirely
  FOG_REVEAL_ANIMATION_MS: 600, // SPEC.md Section 7.3
  // Alpha of the DENSEST unrevealed fog, 0..1 — SPEC.md Section 7.3. Read by
  // both renderers: the WebGL shader's FOG_MAX_OPACITY (webgl-fog-layer.ts)
  // and the 2D canvas fallback's rgba() fill (canvas-fallback.ts). High
  // enough that the fog hides detail rather than merely tinting it; the road
  // and water layers stay legible by being drawn above the fog, not through
  // it.
  //
  // This is a CEILING, not the single value the whole fog is painted at. It
  // used to be both, which is what made the fog a flat wash; since v1.28 the
  // WebGL renderer thins it by up to FOG_DENSITY_VARIATION below this
  // figure, so the fog's floor is FOG_MAX_OPACITY - FOG_DENSITY_VARIATION
  // and this number is the alpha of the densest patch and the alpha no fog
  // anywhere ever exceeds.
  //
  // The variation only ever goes DOWNWARD from here, and that is what lets
  // this constant keep exactly one reading everywhere it is already read.
  // Every other consumer wants the *worst case* — the darkest ground the fog
  // can put under something drawn on top of it: the road opacity's contrast
  // argument (map/ink-style.ts), the status icons' contrast floor
  // (App.a11y.test.tsx) and the canvas fallback's flat fill. A variation that
  // went upward, or that straddled a midpoint, would silently understate that
  // worst case in all three.
  //
  // Raised from 0.88 in v1.28. Nudge this to change how dense the fog is at
  // its densest and FOG_DENSITY_VARIATION to change how uneven it is; they
  // are one pair of knobs, and the floor is their difference (0.84 as set
  // here). Raising it past 1.0 is meaningless — alpha is clamped by the GPU.
  FOG_MAX_OPACITY: 0.96,

  // SPEC.md Section 7.3's uneven fog, and the knob for how uneven. How far
  // BELOW FOG_MAX_OPACITY the density noise may thin the fog: the fog's alpha
  // runs over [FOG_MAX_OPACITY - FOG_DENSITY_VARIATION, FOG_MAX_OPACITY], and
  // 0 here is exactly the flat wash this replaced.
  //
  // What a player sees vary is how much of the base map bleeds through the
  // fog: 4% under the densest patch and 16% under the thinnest, against a
  // flat 12% before. It is bounded from below on purpose — the thinnest patch
  // still has to hide detail rather than tint it, which Section 7.3 requires
  // of the fog everywhere and is not a matter of taste — and bounded from
  // above by nothing but that, because a variation the player cannot make out
  // is the flat wash again under another name.
  FOG_DENSITY_VARIATION: 0.12,

  // The period, in grid cells, of the coarsest octave of that density noise —
  // 24 cells is 1.2 km at Karlsruhe's 50 m cell, so a walk crosses a few
  // patches rather than standing in one. Two finer octaves sit under it
  // (webgl-fog-layer.ts fixes their frequencies), putting the finest feature
  // at about 5 cells across.
  //
  // Deliberately no finer than that, for two separate reasons. A feature
  // approaching the size of a screen pixel aliases into shimmer, and
  // MAP_MIN_ZOOM is where a 50 m cell is already down to about two pixels.
  // And detail at cell scale is what stops reading as uneven density and
  // starts reading as a texture, which is the one thing Section 7.3 rules
  // out here. This is the "does it look like clouds" knob: larger is vaguer,
  // smaller is more structured, and more structured is the failure.
  FOG_DENSITY_NOISE_CELLS: 24,

  // SPEC.md Section 7.3, "Rendering". The WebGL fog quad is rebuilt every
  // frame from the map's *current viewport* (`grid-geometry.ts`), and this
  // is the margin added around that viewport, as a fraction of its own span
  // per axis. A quad fixed to the city's extent cannot work: MapLibre's
  // `maxBounds` constrains an axis-aligned viewport, so as soon as the
  // camera is rotated the viewport's corners sweep outside that rectangle,
  // and where there is no quad there is no fog.
  //
  // Deliberately NOT MAP_BOUNDS_PADDING_RATIO. That one is the map's pan
  // limit and answers a different question; deriving the fog quad from it
  // is exactly what left the corners of a rotated map un-fogged.
  FOG_VIEWPORT_PADDING_RATIO: 0.15,

  // SPEC.md Section 7.3's fog edge, in the two numbers the fragment shader
  // bakes into its source (`webgl-fog-layer.ts`). The edge is not
  // decoration: it is the feedback that the reveal mechanic works at all,
  // so it has to read as a boundary rather than as a slow fade.
  //
  // Radius, in grid cells, of the box blur applied to the binary mask -
  // the blur window is (2r + 1) cells across.
  FOG_EDGE_BLUR_RADIUS_CELLS: 1,
  // Half-width of the alpha ramp around the blurred mask's midpoint: alpha
  // is smoothstep(0.5 - h, 0.5 + h, blurred).
  //
  // The blurred mask is linear in distance from the boundary with slope
  // 1 / (2r + 1) per cell, so these two together fix the width of the
  // visible transition at exactly 2 * (2r + 1) * h cells - 0.6 cells, or
  // 30 m at Karlsruhe's 50 m cell, as set here. Halve h to halve the edge.
  // The low-frequency noise offset in the shader stays: it makes that
  // boundary irregular, which Section 7.3 asks for, and it warps the local
  // width around this figure without changing its average.
  FOG_EDGE_ALPHA_HALF_WIDTH: 0.1,

  BAR_DISCOVERY_RADIUS_M: 100,
  // SPEC.md Section 7.5 step 1. These two are added together (`onsiteRadiusM`,
  // packages/shared/src/visits.ts), so the pair is what matters and not
  // either number alone: 30 m with a good fix, 50 m at worst. They were 50
  // and 50, which reached 100 m — a whole street of bars, and the owner
  // could check into a bar he was nowhere near.
  //
  // The tolerance stays, and is not folded into the base radius. Removing it
  // would make check-in *impossible* on a poor fix rather than merely
  // harder, which is a worse failure than a generous one: the player is
  // standing in the bar and the app refuses. 20 m covers ordinary
  // city-centre GPS, and it is capped by the accuracy actually reported, so
  // a good fix never buys the full allowance.
  //
  // Deliberately smaller than BAR_DISCOVERY_RADIUS_M above and not tied to
  // it: discovery (Section 7.4) asks "have you been near this place", which
  // is a question about a walk, while check-in asks "are you at this bar",
  // which has to separate neighbours. A bar discovered at 100 m that needs
  // 30 m to check into is the intended shape, not a gap.
  BAR_ONSITE_RADIUS_M: 30,
  BAR_ACCURACY_TOLERANCE_M: 20, // added to on-site radius, capped by accuracy

  // SPEC.md Sections 7.4 and 8.3's bar stamp — the moment a bar is
  // discovered. How long one stamp is on screen, from the frame it is added
  // to the frame it is removed. One number, not three, and that is the point
  // of it: the element runs a single CSS animation of exactly this length
  // (index.css, `bar-stamp-press` — the press, the hold and the fade are
  // keyframe stops inside it) and the timer that removes the element waits
  // exactly this long, so the paint and the DOM cannot drift apart into a
  // stamp that has finished fading and is still in the document, or one
  // removed mid-fade.
  //
  // Long enough to read the bar's name at a glance and short enough that a
  // player walking down a street of bars is not watching an animation
  // instead of the map. It is not tied to FOG_REVEAL_ANIMATION_MS: that one
  // is how long the fog takes to clear, which is what the stamp *waits for*
  // (see BAR_STAMP_MAX_PER_BATCH below and map/bars/bar-stamps.ts), not how
  // long it lasts.
  BAR_STAMP_DURATION_MS: 1600,
  // A batch can discover several bars at once (`newBars` is an array), and
  // they are stamped one after another rather than all at the same instant:
  // several stamps appearing together is a flash of noise, and each one is
  // anchored at its own bar, so the eye needs to be led from one to the
  // next. This is the gap between one stamp appearing and the next.
  //
  // Deliberately far shorter than BAR_STAMP_DURATION_MS, so the stamps
  // overlap on screen: a batch of three reads as one event with three marks
  // in it rather than as three separate events queued up behind each other.
  BAR_STAMP_STAGGER_MS: 500,
  // How many bars of one batch are actually stamped. The cap is on the
  // *animation* and never on the information: every discovered bar is named
  // in the announcement (map/bars/bar-stamps.ts) and every one of them gets
  // its permanent marker, whether or not it was stamped.
  //
  // It exists because the worst case is not a walk down a dense street. A
  // batch carries up to SAMPLE_MAX_BATCH samples, which is ten minutes of
  // walking when a queue drains after an offline stretch, and BAR_DISCOVERY
  // _RADIUS_M is 100 m — ten minutes through Karlsruhe's centre can discover
  // a dozen bars in one response. Uncapped, that is (n-1) * STAGGER +
  // DURATION of dimmed map: the moment turns into a queue the player has to
  // sit through, which is the opposite of what it is for.
  BAR_STAMP_MAX_PER_BATCH: 3,

  VISIT_REQUIRED_MS: 20 * 60 * 1000,
  VISIT_EXPIRY_MS: 6 * 60 * 60 * 1000,
  VISIT_PUSH_AFTER_MS: 21 * 60 * 1000,
  VISIT_MIN_ONSITE_SAMPLES: 2, // check-in plus at least one later on-site sample

  SAMPLE_MIN_INTERVAL_MS: 10 * 1000, // client throttle
  SAMPLE_MAX_CLOCK_SKEW_MS: 60 * 1000, // reject samples further in the future
  SAMPLE_MAX_AGE_MS: 10 * 60 * 1000, // reject samples older than this
  SAMPLE_TELEPORT_SPEED_KMH: 300, // implied-speed guard between accepted samples
  SAMPLE_MAX_BATCH: 60, // per POST /api/samples

  SESSION_TTL_DAYS: 90,
  SESSION_REFRESH_THRESHOLD_DAYS: 30, // only then is expires_at rewritten

  GPS_ACCURACY_GOOD_M: 20,
  GPS_ACCURACY_FAIR_M: 50,
  GPS_STALE_MS: 30 * 1000,

  SUGGEST_DUPLICATE_RADIUS_M: 25,
  SUGGEST_NAME_SIMILARITY: 0.85, // normalized Levenshtein ratio, see 11.3

  // Section 11.1's import-side duplicate collapse: how close two same-named
  // records have to be before the import silently drops one of them.
  //
  // What it is for: Karlsruhe's "Fettschmelze" is two nodes 6.15 m apart
  // carrying the *identical* address - one venue entered twice, years apart,
  // by two mappers.
  //
  // What it must not reach: "Traube" is a node and a way 25.34 m apart with
  // the same name, and it is *two* venues - a restaurant and a beer garden
  // on opposite sides of the street, neither carrying an address tag and
  // with genuinely different footprints. Both have to survive. This is
  // written down rather than merely obeyed because the OSM data reads like a
  // double mapping and the next person to widen this radius will re-derive
  // exactly that wrong conclusion from it: a radius that swallowed Traube
  // would delete a bar a player can walk into, which is a worse failure than
  // the duplicate marker the collapse exists to remove.
  //
  // Those two are the only same-name pairs anywhere within 60 m of each
  // other in the committed seed, so any value strictly between 6.15 and
  // 25.34 behaves identically on this data. 15 is the roundest of them -
  // 2.4x above Fettschmelze, 1.7x below Traube - and it was not derived to
  // any finer precision than that.
  //
  // The similarity gate, not this radius, is what does most of the
  // discriminating. Every other pair within 60 m has a plainly different
  // name and comes nowhere near SUGGEST_NAME_SIMILARITY: the closest any of
  // them gets is 0.60 ("Old School" against "The Old Chapel Pub"), and
  // "Schlossbar" against "Schlosshotel" is 0.58 at 22.64 m, i.e. inside even
  // the old 40 m radius and rejected on the name alone. Re-measure for a
  // second city; this is a fact about how Karlsruhe is mapped, not a
  // universal one.
  //
  // Note that this is now *below* SUGGEST_DUPLICATE_RADIUS_M, reversing the
  // relationship the two constants used to have. That is deliberate, not an
  // oversight: the submission radius only raises a warning on a form a
  // person is filling in, while this one removes a record from the seed with
  // nobody looking, so it is the one that has to be tight.
  IMPORT_DUPLICATE_RADIUS_M: 15,

  LEADERBOARD_PAGE_SIZE: 50,
  MAINTENANCE_INTERVAL_MS: 60 * 1000, // see 7.9
  // Badge evaluation catch-up interval, see 7.9. Periods only close at 04:00
  // Europe/Berlin, so checking hourly still lands "shortly after" close while
  // running the aggregation queries 60x less often than MAINTENANCE_INTERVAL_MS.
  BADGE_EVAL_INTERVAL_MS: 60 * 60 * 1000,

  // Switching a brand-new database to WAL needs an exclusive lock and does not
  // go through SQLite's busy handler, so two processes opening the same fresh
  // file at once can collide — see 4.3. Total budget for getting there, and the
  // wait between attempts.
  DB_WAL_RETRY_BUDGET_MS: 5000,
  DB_WAL_RETRY_INTERVAL_MS: 50,

  // Section 5.3: username length bounds are spec-defined; password minimum is
  // not stated by SPEC.md and was chosen by the auth route implementation.
  USERNAME_MIN_LENGTH: 3,
  USERNAME_MAX_LENGTH: 20,
  PASSWORD_MIN_LENGTH: 8,

  // SPEC.md Section 9.4, enforced by the in-memory token bucket in
  // packages/api/src/http/rate-limit.ts. `by` names what a bucket is keyed
  // on, and the IP address is deliberately not one of the choices: it keys a
  // bucket on network topology, which was measurably wrong here — behind the
  // tunnel every request arrived from the proxy, so one bucket held the whole
  // site. Section 9.4 has the reasoning, the two exhaustion costs accepted
  // with these numbers, and the two routes deliberately left unlimited.
  RATE_LIMITS: {
    authGlobal: { limit: 60, windowMs: 60 * 1000, by: 'global' }, // ceiling on argon2 work, see 9.4
    register: { limit: 30, windowMs: 60 * 60 * 1000, by: 'global' }, // account spam; no authGlobal too
    loginByUser: { limit: 10, windowMs: 5 * 60 * 1000, by: 'username' }, // password guessing, one account
    resetByUser: { limit: 5, windowMs: 60 * 60 * 1000, by: 'username' }, // answer guessing, one account
    samples: { limit: 30, windowMs: 60 * 1000, by: 'user' },
    suggest: { limit: 10, windowMs: 24 * 60 * 60 * 1000, by: 'user' },
  },

  // The badge kinds of Section 7.7, and the whole of what this file says about
  // badges. Their qualifying FLOORS are numbers a client may not have, so they
  // live in server-config.ts instead (Section 0, rule 3) — this array is the
  // client-safe half, because the *names* are needed everywhere: the browser
  // draws a shelf of every badge that exists, and cannot ask the server which
  // badges exist without being told the catalogue it already has.
  //
  // An array and not the key set of the thresholds record, which is what this
  // used to be. Order is load-bearing — it is the order a shelf of
  // placeholders draws in (badges.ts, `BADGE_CATALOGUE`) — and an array states
  // that order instead of inheriting it from the insertion order of an object
  // literal that now lives in another file.
  //
  // The two halves cannot drift: server-config.ts's thresholds record is
  // `satisfies Record<BadgeKind, …>` over exactly this array, so a kind added
  // here without floors, or floors added there for a kind not named here,
  // fails to compile.
  BADGE_KINDS: ['explorer', 'barfly'],

  // Map zoom and pan limits. Zoom 10 keeps the whole city plus its
  // surroundings in view and is as far out as the map may go, so it never
  // leaves the area the tile extract covers (the extract is built for zoom
  // 0-14). Zoom 18 is past that 14, deliberately: MapLibre overzooms the
  // last level it has, which is what makes 50 m cells and bar markers
  // usable up close. The ratio is the margin left around the playable grid,
  // so the edge of the city is still reachable without the map drifting off
  // into empty space.
  MAP_MIN_ZOOM: 10,
  MAP_MAX_ZOOM: 18,
  MAP_BOUNDS_PADDING_RATIO: 0.2,

  // SPEC.md Section 8.3: the zoom the map opens at, and the zoom the "to my
  // location" control takes the player back to. One constant for both,
  // because they answer the same question - "show me where I am, close
  // enough to walk from" - and two numbers that mean the same thing drift.
  // A few blocks across: close enough that a bar marker, the player's own
  // position and the 50 m grain of the fog are all legible.
  MAP_DEFAULT_ZOOM: 16,

  // SPEC.md Section 8.3: the margin left around a district's bounding box
  // when "Open on the map" frames that district, in screen pixels on each
  // side — pixels because that is the unit MapLibre's `fitBounds` padding is
  // expressed in, and the quantity really is a screen margin rather than a
  // distance on the ground. Fitted edge to edge the district's own border
  // lands exactly on the edge of the viewport, which reads as a shape
  // continuing off-screen rather than as one the player is being shown
  // whole; a margin is what makes it read as "here is the district".
  // Deliberately not MAP_BOUNDS_PADDING_RATIO, which is the pan limit's
  // margin around the *city* and answers a different question.
  MAP_FIT_PADDING_PX: 24,

  // ios/SPEC.md Section 7 — the tracker (`packages/tracker`). These nine are
  // the numbers the Swift shell actually runs on, and the shell holds none of
  // its own: every one reaches it from the tracker, which reads it from here
  // (ios/SPEC.md I1). Nothing below is withheld from a client either, so the
  // whole block stays in this file rather than splitting across the two.
  //
  // Core Location takes no metres-typed accuracy, so the shell maps this to
  // the nearest kCLLocationAccuracy* constant — 10 becomes
  // kCLLocationAccuracyNearestTenMeters (ios/SPEC.md 6.3). Kept under
  // GPS_ACCURACY_GOOD_M on purpose: a fix this tight still reads as "good" on
  // Section 8.6's indicator, and it is one of the two levers ios/SPEC.md O-I7
  // names if the evening walk finds the battery cost unacceptable.
  TRACKER_DESIRED_ACCURACY_M: 10,

  // The three profiles of ios/SPEC.md 7.3, one distance filter apiece, chosen
  // by app state and by whether a visit is pending nearby. 0 means every fix
  // Core Location offers; a positive number throttles before a sample ever
  // reaches the queue.
  //
  // Foreground takes every fix because the map is on screen, and the
  // player's own marker should move as it does in a browser tab.
  TRACKER_FOREGROUND_DISTANCE_FILTER_M: 0,
  // Half of the 50 m fog cell, so a background walk cannot cross a whole
  // cell between two fixes and leave it unrevealed. The other O-I7 lever:
  // widening it to a full cell trades a diagonal walk's corner for less
  // background GPS use.
  TRACKER_WALKING_DISTANCE_FILTER_M: 25,
  // Every fix again, like foreground, because a player standing in a bar
  // does not walk 25 m — a throttled profile here would starve the pending
  // visit of the on-site samples it needs to complete (ios/SPEC.md 7.6).
  TRACKER_DWELLING_DISTANCE_FILTER_M: 0,

  // The tracker's in-memory queue (ios/SPEC.md 7.4). Past this many samples
  // the OLDEST is dropped, never the newest: a queue this full is already
  // behind, and the sample saying where the player is *now* is the one
  // thing a stale queue must not lose.
  TRACKER_QUEUE_CAP: 600,

  // One pair (ios/SPEC.md 7.4): a failed flush waits this long, doubles on
  // every consecutive failure, and is capped at TRACKER_FLUSH_BACKOFF_MAX_MS
  // below, reset back to this base the next time a flush succeeds.
  TRACKER_FLUSH_BACKOFF_BASE_MS: 5 * 1000,
  TRACKER_FLUSH_BACKOFF_MAX_MS: 5 * 60 * 1000,

  // How soon a JS context that threw on start may be restarted (ios/SPEC.md
  // 4.4). Without this floor, a bundle that throws immediately on every
  // start would restart as fast as the shell can loop — a spin, not a retry.
  TRACKER_RESTART_MIN_INTERVAL_MS: 60 * 1000,

  // How many Berlin days of the counters in ios/SPEC.md 7.8 the device keeps
  // in UserDefaults for the Diagnostics screen, by the same calendar the
  // badge job uses (`berlinDateString`), so a bucket's day means the same
  // thing everywhere it is computed.
  TRACKER_DIAGNOSTIC_DAYS: 7,

  TILES_FILENAME: 'karlsruhe.2026-08.pmtiles',
  VAPID_KEY_FILENAME: 'vapid-keys.json', // generated on first boot, persisted beside DATABASE_PATH — see 5.9
} as const;

// The single ms→s boundary required by rule 6 in Section 0.
export const DERIVED = {
  VISIT_REQUIRED_S: CONFIG.VISIT_REQUIRED_MS / 1000,
  VISIT_EXPIRY_S: CONFIG.VISIT_EXPIRY_MS / 1000,
  VISIT_PUSH_AFTER_S: CONFIG.VISIT_PUSH_AFTER_MS / 1000,
  SESSION_TTL_S: CONFIG.SESSION_TTL_DAYS * 86400,
  SESSION_REFRESH_THRESHOLD_S: CONFIG.SESSION_REFRESH_THRESHOLD_DAYS * 86400,
} as const;
