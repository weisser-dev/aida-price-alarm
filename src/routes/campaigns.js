const express = require('express');
const db = require('../db');
const { TARIFF_BUCKETS, FLIGHT_OPTIONS, expandBuckets, bestPriceForJourney } = require('../services/pricing');

const router = express.Router();

function parseTariffBuckets(value) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(TARIFF_BUCKETS.map((b) => b.id));
  const cleaned = list.map((s) => String(s).trim()).filter((s) => allowed.has(s));
  return cleaned.length ? cleaned : null;
}

router.get('/', (req, res) => {
  const { ship, region, q, name } = req.query;
  const tariffBuckets = parseTariffBuckets(req.query.tariff);
  const flightOption  = FLIGHT_OPTIONS.includes(req.query.flight) ? req.query.flight : 'any';
  const tariffs = expandBuckets(tariffBuckets ? tariffBuckets.join(',') : null);
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 300);

  const conds = ["(c.valid_to IS NULL OR c.valid_to >= date('now'))",
                 "(c.valid_from IS NULL OR c.valid_from <= date('now'))"];
  const params = [];
  if (ship)   { conds.push('r.ship_name = ?');  params.push(ship); }
  if (region) { conds.push('r.region = ?');     params.push(region); }
  if (q) {
    conds.push('(r.title LIKE ? OR r.route_group LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (name) { conds.push('c.name LIKE ?'); params.push(`%${name}%`); }

  const rows = db.prepare(`
    SELECT
      c.code, c.name, c.medium, c.valid_from, c.valid_to,
      j.id AS journey_id, j.departs_at, j.returns_at, j.duration_nights, j.booking_url,
      r.id AS route_id, r.title AS route_title, r.ship_name, r.region,
      r.departure_port, r.arrival_port
    FROM campaigns c
    JOIN journeys j ON j.id = c.journey_id
    JOIN routes   r ON r.id = j.route_id
    WHERE ${conds.join(' AND ')}
    ORDER BY c.valid_to ASC, j.departs_at ASC
    LIMIT ?
  `).all(...params, limit);

  const today = new Date().toISOString().slice(0, 10);
  const items = rows.map((r) => {
    const best = bestPriceForJourney(r.journey_id, { tariffs, flightOption });
    return {
      campaign: {
        code: r.code,
        name: r.name,
        medium: r.medium,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        daysRemaining: r.valid_to ? daysUntil(r.valid_to, today) : null,
      },
      route: {
        id: r.route_id,
        title: r.route_title,
        ship: r.ship_name,
        region: r.region,
        departurePort: r.departure_port,
        arrivalPort: r.arrival_port,
      },
      journey: {
        id: r.journey_id,
        departsAt: r.departs_at,
        returnsAt: r.returns_at,
        durationNights: r.duration_nights,
        bookingUrl: r.booking_url,
      },
      bestPrice: best ? {
        amountEur: best.amount_eur,
        perPersonEur: best.per_person_eur,
        tariffType: best.tariff_type,
        tariffName: best.tariff_name,
        flightIncluded: !!best.flight_included,
      } : null,
    };
  });

  // If a tariff/flight filter was set, hide rows without a matching price.
  const filtered = (tariffBuckets || flightOption !== 'any')
    ? items.filter((i) => i.bestPrice)
    : items;

  res.json({
    total: rows.length,
    shown: filtered.length,
    filters: { ship, region, q, name, tariffBuckets, flightOption },
    items: filtered,
  });
});

function daysUntil(dateStr, today) {
  const a = new Date(today), b = new Date(dateStr);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

module.exports = router;
