-- Initial schema. Transcribed from SPEC.md Section 5 (Data Model).

CREATE TABLE cities (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,        -- 'karlsruhe'
  name          TEXT NOT NULL,
  origin_lat    REAL NOT NULL,               -- grid anchor (SW corner)
  origin_lon    REAL NOT NULL,
  grid_width    INTEGER NOT NULL,            -- cells in x
  grid_height   INTEGER NOT NULL,            -- cells in y
  cell_size_m   INTEGER NOT NULL,            -- 50 in v1
  playable_cells INTEGER NOT NULL,           -- cells inside city boundary (% denominator)
  is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE districts (
  id             INTEGER PRIMARY KEY,
  city_id        INTEGER NOT NULL REFERENCES cities(id),
  name           TEXT NOT NULL,
  playable_cells INTEGER NOT NULL
);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,          -- argon2id
  security_question    TEXT NOT NULL,          -- user-authored, plaintext (it is a prompt, not a secret)
  security_answer_hash TEXT NOT NULL,          -- argon2id, lowercased + trimmed before hashing
  avatar_seed          TEXT NOT NULL,          -- deterministic avatar, see 8.5
  is_anonymous         INTEGER NOT NULL DEFAULT 0,
  is_admin             INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  age_confirmed_at     INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  last_seen_at         INTEGER
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,      -- 32 random bytes, base64url
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL       -- 90 days, sliding
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE fog_state (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id       INTEGER NOT NULL REFERENCES cities(id),
  mask          BLOB NOT NULL,        -- ceil(grid_width*grid_height/8) bytes
  revealed_cells INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, city_id)
);

CREATE TABLE fog_district_progress (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  district_id INTEGER NOT NULL REFERENCES districts(id),
  revealed_cells INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, district_id)
);

-- Per-day reveal counters. Required for period-scoped progress: the mask itself
-- carries no history, so "newly revealed this week" is not otherwise computable.
-- See 7.7 and 7.8. One row per user per active day; negligible size.
CREATE TABLE fog_daily_progress (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id        INTEGER NOT NULL REFERENCES cities(id),
  day            TEXT NOT NULL,       -- 'YYYY-MM-DD', Europe/Berlin local day
  revealed_cells INTEGER NOT NULL DEFAULT 0,   -- cells FIRST revealed on that day
  PRIMARY KEY (user_id, city_id, day)
);

CREATE TABLE bars (
  id           INTEGER PRIMARY KEY,
  city_id      INTEGER NOT NULL REFERENCES cities(id),
  district_id  INTEGER REFERENCES districts(id),   -- NULL if outside every district polygon
  name         TEXT NOT NULL,
  address      TEXT,
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  cell_index   INTEGER NOT NULL,           -- denormalized for fast lookup
  source       TEXT NOT NULL,              -- 'osm' | 'community' | 'admin'
  osm_id       TEXT,
  submitted_by INTEGER REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'hidden'
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_bars_city_cell ON bars(city_id, cell_index);

CREATE TABLE bar_discoveries (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bar_id       INTEGER NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, bar_id)
);

CREATE TABLE visits (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bar_id          INTEGER NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  started_at      INTEGER NOT NULL,   -- check-in time, seconds
  last_sample_at  INTEGER NOT NULL,   -- latest accepted on-site sample, seconds
  onsite_samples  INTEGER NOT NULL DEFAULT 1,   -- includes the check-in itself
  confirmed_s     INTEGER NOT NULL DEFAULT 0,   -- last_sample_at - started_at
  status          TEXT NOT NULL,      -- 'pending' | 'completed' | 'expired'
  completed_at    INTEGER,
  push_sent_at    INTEGER             -- set when the 21-minute reminder went out
);

CREATE INDEX idx_visits_user_status ON visits(user_id, status);
CREATE INDEX idx_visits_pending_sweep ON visits(status, last_sample_at);
CREATE UNIQUE INDEX idx_visits_one_pending ON visits(user_id, bar_id) WHERE status = 'pending';

CREATE TABLE badges (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,      -- 'explorer' | 'barfly'
  period      TEXT NOT NULL,      -- 'week' | 'month' | 'year'
  period_key  TEXT NOT NULL,      -- '2026-W32' | '2026-08' | '2026'
  value       REAL NOT NULL,      -- achieved value (percent or bar count)
  awarded_at  INTEGER NOT NULL,
  UNIQUE (user_id, kind, period, period_key)
);

CREATE TABLE push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
