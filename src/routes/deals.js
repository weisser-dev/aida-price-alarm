/**
 * Deals API: pro (route × tariff bucket × flight option) finden wir die
 * günstigste Abfahrt und vergleichen sie mit dem Median aller aktuellen
 * Abfahrten derselben Route+Tarif+Flug-Kombination. Wenn der günstigste
 * Preis ≥ minDropPct unter dem Median liegt, ist es ein Deal.
 *
 * Default minDropPct = 30 (also Preise mind. 30% unter Median). Der Wert
 * lässt sich per Querystring `min` überschreiben (1–80).
 */
const express = require('express');
const db = require('../db');
const {
  TARIFF_BUCKETS, FLIGHT_OPTIONS, expandBuckets, bucketForTariff,
} = require('../services/pricing');
const { SHIP_NAMES } = require('../services/aidaAdapter');

const router = express.Router();

const SHIP_CODE_BY_NAME = Object.fromEntries(
  Object.entries(SHIP_NAMES).map(([code, name]) => [name, code]),
);

function parseTariffBuckets(value) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(TARIFF_BUCKETS.map((b) => b.id));
  const cleaned = list.map((s) => String(s).trim()).filter((s) => allowed.has(s));
  return cleaned.length ? cleaned : null;
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

router.get('/', (req, res) => {
  const { ship, region, port, q, departsFrom, departsTo } = req.query;
  const tariffBuckets = parseTariffBuckets(req.query.tariff);
  const flightOption  = FLIGHT_OPTIONS.includes(req.query.flight) ? req.query.flight : 'any';
  const limit = Math.min(parseInt(req.query.limit || '120', 10) || 120, 500);
  const minDropPct = Math.min(80, Math.max(1, parseInt(req.query.min || '30', 10) || 30));
  const minJourneys = Math.max(2, parseInt(req.query.minJourneys || '3', 10) || 3);

  // Pull the latest price-per-(journey, tariff, flight) joined with route+journey
  // metadata, restricted to journeys whose departure is still in the future
  // and that match the optional filter set. We collapse "same-second insert
  // duplicates" by selecting MAX(id) per (journey, tariff, flight).
  const conds = [`j.departs_at >= date('now')`];
  const params = [];
  if (ship) {
    // Multi-ship routes: filter via journey-level ship_code (see routes.js).
    const code = SHIP_CODE_BY_NAME[ship] || ship;
    conds.push('j.ship_code = ?');
    params.push(code);
  }
  if (region) { conds.push('r.region = ?');         params.push(region); }
  if (port)   { conds.push('r.departure_port = ?'); params.push(port); }
  if (q) {
    conds.push(`(r.title LIKE ? OR r.region LIKE ? OR r.ship_name LIKE ? OR r.departure_port LIKE ? OR r.route_group LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (departsFrom) { conds.push('j.departs_at >= ?'); params.push(departsFrom); }
  if (departsTo)   { conds.push('j.departs_at <= ?'); params.push(departsTo); }

  const where = `WHERE ${conds.join(' AND ')}`;

  const rows = db.prepare(`
    WITH latest AS (
      SELECT MAX(id) AS id
      FROM prices
      GROUP BY journey_id, tariff_type, flight_included
    )
    SELECT
      r.id           AS route_id,
      r.title        AS route_title,
      r.route_group  AS route_group,
      r.ship_name    AS ship_name,
      r.region       AS region,
      r.duration_nights AS duration_nights,
      r.departure_port  AS departure_port,
      r.arrival_port    AS arrival_port,
      r.image_url       AS route_image,
      j.id           AS journey_id,
      j.ship_code    AS journey_ship_code,
      j.departs_at   AS departs_at,
      j.returns_at   AS returns_at,
      j.duration_nights AS journey_duration,
      j.booking_url  AS booking_url,
      p.tariff_type  AS tariff_type,
      p.tariff_name  AS tariff_name,
      p.flight_included AS flight_included,
      p.amount_eur   AS amount_eur,
      p.per_person_eur AS per_person_eur,
      p.captured_at  AS captured_at
    FROM prices p
    JOIN latest l ON l.id = p.id
    JOIN journeys j ON j.id = p.journey_id
    JOIN routes r   ON r.id = j.route_id
    ${where}
  `).all(...params);

  // Group by (route, bucket, flight)
  // bucket = tariff family ID like 'CLASSIC', 'PREMIUM', etc.
  const tariffFilter = tariffBuckets ? new Set(expandBuckets(tariffBuckets.join(','))) : null;
  const groups = new Map();
  for (const row of rows) {
    if (tariffFilter && !tariffFilter.has(row.tariff_type)) continue;
    const flight = !!row.flight_included;
    if (flightOption === 'with' && !flight) continue;
    if (flightOption === 'without' && flight) continue;
    const bucket = bucketForTariff(row.tariff_type) || row.tariff_type;
    const key = `${row.route_id}|${bucket}|${flight ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        routeId: row.route_id,
        bucket,
        flightIncluded: flight,
        route: {
          id: row.route_id,
          title: row.route_title,
          routeGroup: row.route_group,
          ship: row.ship_name,
          region: row.region,
          durationNights: row.duration_nights,
          departurePort: row.departure_port,
          arrivalPort: row.arrival_port,
          imageUrl: row.route_image,
        },
        priceByJourney: new Map(), // journey_id -> { amount, p row }
      };
      groups.set(key, g);
    }
    // Collapse multiple tariff codes within the bucket: keep the cheapest
    const prev = g.priceByJourney.get(row.journey_id);
    if (!prev || row.amount_eur < prev.amount_eur) g.priceByJourney.set(row.journey_id, row);
  }

  // For each group: compute median + cheapest, decide if it's a deal.
  const deals = [];
  for (const g of groups.values()) {
    const entries = [...g.priceByJourney.values()];
    if (entries.length < minJourneys) continue;
    const amounts = entries.map((e) => e.amount_eur);
    const med = median(amounts);
    const min = Math.min(...amounts);
    if (!med || !min) continue;
    const dropPct = Math.round((1 - min / med) * 100);
    if (dropPct < minDropPct) continue;
    const cheapest = entries.find((e) => e.amount_eur === min);
    deals.push({
      route: g.route,
      tariffBucket: g.bucket,
      flightIncluded: g.flightIncluded,
      journeysConsidered: entries.length,
      medianEur: Math.round(med),
      cheapestEur: Math.round(min),
      perPersonEur: cheapest.per_person_eur ?? null,
      dropPct,
      savingEur: Math.round(med - min),
      cheapestJourney: {
        id: cheapest.journey_id,
        shipCode: cheapest.journey_ship_code,
        departsAt: cheapest.departs_at,
        returnsAt: cheapest.returns_at,
        durationNights: cheapest.journey_duration,
        bookingUrl: cheapest.booking_url,
        tariffType: cheapest.tariff_type,
        tariffName: cheapest.tariff_name,
        capturedAt: cheapest.captured_at,
      },
    });
  }

  deals.sort((a, b) => b.dropPct - a.dropPct);
  res.json({
    total: deals.length,
    minDropPct,
    minJourneys,
    filters: { ship, region, port, q, departsFrom, departsTo, tariffBuckets, flightOption },
    items: deals.slice(0, limit),
  });
});

module.exports = router;
