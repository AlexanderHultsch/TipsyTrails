export const CONFIG = {
  FOG_REVEAL_RADIUS_M: 100,
  FOG_MAX_SPEED_KMH: 30, // above this, no reveal
  FOG_MAX_ACCURACY_M: 200, // samples worse than this are discarded entirely
  FOG_REVEAL_ANIMATION_MS: 600, // SPEC.md Section 7.3

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

  // Badges are ACTIVITY FLOORS, not competitive targets. Their only job is to
  // separate someone who actually went out during the period from someone who
  // just opened the app or was inactive. Set them low. A badge is awarded when
  // value >= threshold (minimum, not "strictly greater").
  BADGE_THRESHOLDS: {
    // Percent of playable city area newly revealed in the period.
    // Deliberately not linear across periods: after the first weeks most walking
    // retraces already-revealed ground, so sustained progress decays sharply.
    // 0.1% is roughly 900 m of previously unexplored walking.
    explorer: { week: 0.1, month: 0.3, year: 2.0 },
    // Bars newly mastered in the period.
    barfly: { week: 1, month: 2, year: 3 },
  },

  TILES_FILENAME: 'karlsruhe.2026-08.pmtiles',
} as const;

// The single ms→s boundary required by rule 6 in Section 0.
export const DERIVED = {
  VISIT_REQUIRED_S: CONFIG.VISIT_REQUIRED_MS / 1000,
  VISIT_EXPIRY_S: CONFIG.VISIT_EXPIRY_MS / 1000,
  VISIT_PUSH_AFTER_S: CONFIG.VISIT_PUSH_AFTER_MS / 1000,
  SESSION_TTL_S: CONFIG.SESSION_TTL_DAYS * 86400,
  SESSION_REFRESH_THRESHOLD_S: CONFIG.SESSION_REFRESH_THRESHOLD_DAYS * 86400,
} as const;
