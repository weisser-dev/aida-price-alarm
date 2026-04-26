const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS cruises (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    ship            TEXT,
    destination     TEXT,
    departure_port  TEXT,
    arrival_port    TEXT,
    departs_at      TEXT,
    returns_at      TEXT,
    duration_nights INTEGER,
    url             TEXT,
    raw_json        TEXT,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cruises_ship ON cruises(ship);
  CREATE INDEX IF NOT EXISTS idx_cruises_destination ON cruises(destination);
  CREATE INDEX IF NOT EXISTS idx_cruises_departs_at ON cruises(departs_at);

  CREATE TABLE IF NOT EXISTS prices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cruise_id    TEXT NOT NULL,
    fare_code    TEXT NOT NULL,
    fare_name    TEXT,
    cabin_type   TEXT,
    price_eur    REAL NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'EUR',
    captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (cruise_id) REFERENCES cruises(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_prices_cruise ON prices(cruise_id, captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_prices_fare ON prices(cruise_id, fare_code, captured_at DESC);

  CREATE TABLE IF NOT EXISTS watchlist (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    email             TEXT NOT NULL,
    cruise_id         TEXT NOT NULL,
    token             TEXT NOT NULL UNIQUE,
    baseline_price    REAL,
    baseline_fare     TEXT,
    last_notified_at  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (email, cruise_id),
    FOREIGN KEY (cruise_id) REFERENCES cruises(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_watchlist_email ON watchlist(email);
  CREATE INDEX IF NOT EXISTS idx_watchlist_cruise ON watchlist(cruise_id);

  CREATE TABLE IF NOT EXISTS scrape_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT,
    status       TEXT NOT NULL,
    cruises_seen INTEGER DEFAULT 0,
    prices_seen  INTEGER DEFAULT 0,
    error        TEXT
  );
`);

module.exports = db;
