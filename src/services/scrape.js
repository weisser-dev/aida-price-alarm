const db = require('../db');
const { fetchCruises } = require('./aidaAdapter');
const { findAlerts, sendAlertsForWatchers } = require('./notify');

const upsertCruise = db.prepare(`
  INSERT INTO cruises (id, title, ship, destination, departure_port, arrival_port,
                       departs_at, returns_at, duration_nights, url, route_key, raw_json, updated_at)
  VALUES (@id, @title, @ship, @destination, @departurePort, @arrivalPort,
          @departsAt, @returnsAt, @durationNights, @url, @routeKey, @rawJson, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    title           = excluded.title,
    ship            = excluded.ship,
    destination     = excluded.destination,
    departure_port  = excluded.departure_port,
    arrival_port    = excluded.arrival_port,
    departs_at      = excluded.departs_at,
    returns_at      = excluded.returns_at,
    duration_nights = excluded.duration_nights,
    url             = excluded.url,
    route_key       = COALESCE(excluded.route_key, cruises.route_key),
    raw_json        = excluded.raw_json,
    updated_at      = datetime('now')
`);

const insertPrice = db.prepare(`
  INSERT INTO prices (cruise_id, fare_code, fare_name, cabin_type, price_eur, currency, with_flight, is_promo, promo_label)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertPriceAt = db.prepare(`
  INSERT INTO prices (cruise_id, fare_code, fare_name, cabin_type, price_eur, currency, with_flight, is_promo, promo_label, captured_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const fareHasHistory = db.prepare(`
  SELECT 1 FROM prices WHERE cruise_id = ? AND fare_code = ? AND with_flight = ? LIMIT 1
`);

const startRun = db.prepare(`
  INSERT INTO scrape_runs (status) VALUES ('running')
`);
const finishRun = db.prepare(`
  UPDATE scrape_runs SET finished_at = datetime('now'), status = ?, cruises_seen = ?, prices_seen = ?, error = ?
  WHERE id = ?
`);

async function runScrape({ notify = true, log = console } = {}) {
  const runInfo = startRun.run();
  const runId = runInfo.lastInsertRowid;

  let cruises = [];
  try {
    cruises = await fetchCruises();
  } catch (err) {
    finishRun.run('error', 0, 0, String(err && err.message || err), runId);
    throw err;
  }

  let priceCount = 0;
  const persist = db.transaction((items) => {
    for (const c of items) {
      upsertCruise.run({
        id: c.id,
        title: c.title,
        ship: c.ship,
        destination: c.destination,
        departurePort: c.departurePort,
        arrivalPort: c.arrivalPort,
        departsAt: c.departsAt,
        returnsAt: c.returnsAt,
        durationNights: c.durationNights,
        url: c.url,
        routeKey: c.routeKey || null,
        rawJson: c.raw ? JSON.stringify(c.raw) : null,
      });

      for (const f of c.fares) {
        const flightFlag = f.withFlight ? 1 : 0;

        // Backfill seeded history once per (cruise, fare, flight) combination.
        const seenBefore = fareHasHistory.get(c.id, f.code, flightFlag);
        if (!seenBefore && Array.isArray(f.history) && f.history.length) {
          for (const h of f.history) {
            insertPriceAt.run(
              c.id, f.code, f.name, f.cabinType, h.priceEur,
              f.currency || 'EUR', flightFlag,
              h.isPromo ? 1 : 0,
              h.promoLabel || null,
              h.capturedAt,
            );
            priceCount += 1;
          }
        }

        insertPrice.run(
          c.id, f.code, f.name, f.cabinType, f.priceEur,
          f.currency || 'EUR', flightFlag,
          f.isPromo ? 1 : 0,
          f.promoLabel || null,
        );
        priceCount += 1;
      }
    }
  });
  persist(cruises);

  finishRun.run('ok', cruises.length, priceCount, null, runId);
  log.info?.(`[scrape] persisted ${cruises.length} cruises / ${priceCount} fares`);

  if (notify) {
    const alerts = findAlerts();
    if (alerts.length) {
      log.info?.(`[scrape] found ${alerts.length} alert(s) to send`);
      await sendAlertsForWatchers(alerts, { log });
    }
  }

  return { cruises: cruises.length, prices: priceCount };
}

module.exports = { runScrape };
