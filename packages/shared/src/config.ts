export const CONFIG = {
  FOG_REVEAL_RADIUS_M: 100,
  FOG_MAX_SPEED_KMH: 30, // above this, no reveal
  FOG_MAX_ACCURACY_M: 200, // samples worse than this are discarded entirely
  FOG_REVEAL_ANIMATION_MS: 600, // SPEC.md Section 7.3
  // Alpha of fully unrevealed fog, 0..1 — SPEC.md Section 7.3. Read by both
  // renderers: the WebGL shader's FOG_MAX_OPACITY (webgl-fog-layer.ts) and
  // the 2D canvas fallback's rgba() fill (canvas-fallback.ts). High enough
  // that the fog hides detail rather than merely tinting it; the motorway
  // layer stays legible by being drawn above the fog, not through it.
  FOG_MAX_OPACITY: 0.88,

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
  BAR_ONSITE_RADIUS_M: 50,
  BAR_ACCURACY_TOLERANCE_M: 50, // added to on-site radius, capped by accuracy

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

  RATE_LIMITS: {
    auth: { limit: 10, windowMs: 60 * 1000, by: 'ip' },
    resetByUser: { limit: 5, windowMs: 60 * 60 * 1000, by: 'username' },
    resetByIp: { limit: 20, windowMs: 60 * 60 * 1000, by: 'ip' },
    samples: { limit: 30, windowMs: 60 * 1000, by: 'user' },
    suggest: { limit: 10, windowMs: 24 * 60 * 60 * 1000, by: 'user' },
  },

  // Badges are a per-period COMPETITION, and these are its FLOORS. A badge
  // goes to the highest-scoring user of the period, and to nobody at all if
  // no one reaches the floor — its only job is to stop the badge being won by
  // being the least inactive person. Set them low: they are qualification, not
  // the target. A user qualifies when value >= threshold (minimum, not
  // "strictly greater"). Never sent to a client — see Section 7.7.
  BADGE_THRESHOLDS: {
    // Percent of playable city area newly revealed in the period.
    // Deliberately not linear across periods: after the first weeks most walking
    // retraces already-revealed ground, so sustained progress decays sharply.
    // 0.1% is roughly 900 m of previously unexplored walking.
    explorer: { week: 0.1, month: 0.3, year: 2.0 },
    // Bars newly mastered in the period.
    barfly: { week: 1, month: 2, year: 3 },
  },

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
