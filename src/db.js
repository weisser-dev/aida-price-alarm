const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Detect legacy schema (cruises table from the pre-route refactor) and reset
// it. The previous mock-only data has no real value; users had to re-merken
// against real journey ids anyway.
const legacy = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='cruises'"
).get();
if (legacy) {
  db.exec(`
    DROP TABLE IF EXISTS prices;
    DROP TABLE IF EXISTS watchlist;
    DROP TABLE IF EXISTS cruises;
    DROP TABLE IF EXISTS scrape_runs;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS routes (
    id              TEXT PRIMARY KEY,             -- yieldRouteCode (fallback: routeCode)
    route_code      TEXT,                         -- e.g. WARBAL14
    yield_code      TEXT,                         -- e.g. WAR14251
    route_group     TEXT,                         -- e.g. "Ostsee ab Warnemünde"
    title           TEXT NOT NULL,
    ship_code       TEXT,                         -- e.g. DI
    ship_name       TEXT,                         -- AIDAdiva
    region          TEXT,                         -- "Nordeuropa"
    departure_port  TEXT,
    arrival_port    TEXT,
    duration_nights INTEGER,
    ports_json      TEXT,                         -- JSON array of port objects
    image_url       TEXT,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_routes_ship   ON routes(ship_code);
  CREATE INDEX IF NOT EXISTS idx_routes_region ON routes(region);

  CREATE TABLE IF NOT EXISTS journeys (
    id              TEXT PRIMARY KEY,             -- journeyIdentifier e.g. DI14270522
    route_id        TEXT NOT NULL,
    ship_code       TEXT,
    duration_nights INTEGER,
    departs_at      TEXT NOT NULL,                -- YYYY-MM-DD
    returns_at      TEXT NOT NULL,
    booking_url     TEXT,
    image_url       TEXT,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_journeys_route   ON journeys(route_id);
  CREATE INDEX IF NOT EXISTS idx_journeys_departs ON journeys(departs_at);
  CREATE INDEX IF NOT EXISTS idx_journeys_ship    ON journeys(ship_code);

  CREATE TABLE IF NOT EXISTS prices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id      TEXT NOT NULL,
    tariff_type     TEXT NOT NULL,                -- IND, CLA, LIG, PAUAI ...
    tariff_name     TEXT,                         -- PREMIUM, CLASSIC ...
    flight_included INTEGER NOT NULL DEFAULT 0,
    amount_eur      REAL NOT NULL,                -- total for the configured pax (default 2 adults)
    per_person_eur  REAL,
    currency        TEXT DEFAULT '€',
    notes_json      TEXT,                         -- JSON array of notes
    captured_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_prices_journey ON prices(journey_id, captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_prices_tariff  ON prices(journey_id, tariff_type, flight_included, captured_at DESC);

  CREATE TABLE IF NOT EXISTS campaigns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id      TEXT NOT NULL,
    code            TEXT NOT NULL,                -- "LMV 202617"
    name            TEXT,                         -- "Last Minute"
    medium          TEXT,
    valid_from      TEXT,
    valid_to        TEXT,
    captured_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_journey ON campaigns(journey_id);
  CREATE INDEX IF NOT EXISTS idx_campaigns_validto ON campaigns(valid_to);

  CREATE TABLE IF NOT EXISTS watchlist (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT NOT NULL,
    watch_type        TEXT NOT NULL,              -- 'route' | 'journey'
    target_id         TEXT NOT NULL,              -- routes.id or journeys.id
    token             TEXT NOT NULL UNIQUE,
    tariff_filter     TEXT,                       -- CSV of tariff codes (NULL = any)
    flight_filter     TEXT NOT NULL DEFAULT 'any',-- 'any' | 'with' | 'without'
    baseline_price    REAL,
    baseline_tariff   TEXT,
    baseline_journey  TEXT,                       -- which journey produced the baseline (for route watches)
    last_notified_at  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (email, watch_type, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_watchlist_email  ON watchlist(email);
  CREATE INDEX IF NOT EXISTS idx_watchlist_target ON watchlist(watch_type, target_id);

  CREATE TABLE IF NOT EXISTS scrape_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT,
    status        TEXT NOT NULL,
    routes_seen   INTEGER DEFAULT 0,
    journeys_seen INTEGER DEFAULT 0,
    prices_seen   INTEGER DEFAULT 0,
    campaigns_seen INTEGER DEFAULT 0,
    error         TEXT
  );
`);

// One-shot migrations keyed off PRAGMA user_version.
const userVersion = db.pragma('user_version', { simple: true });

if (userVersion < 1) {
  // Earlier scrapes inserted the same (journey, tariff, flight) row up to a
  // dozen times per run because AIDA returns each journey across multiple
  // pages. Wipe the polluted history and let the next scrape repopulate.
  const before = db.prepare('SELECT COUNT(*) AS n FROM prices').get().n;
  const beforeC = db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n;
  db.exec(`DELETE FROM prices; DELETE FROM campaigns;`);
  console.log(`[migration v1] cleared ${before} duplicated price rows and ${beforeC} campaign rows`);
  db.pragma('user_version = 1');
}

module.exports = db;
