const express = require('express');
const db = require('../db');
const { bestCurrentFare, CABIN_BUCKETS } = require('../services/notify');

const router = express.Router();

const FLIGHT_OPTIONS = new Set(['any', 'with', 'without']);

function parseCabinList(value) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = list.map((s) => String(s).trim()).filter(Boolean).filter((c) => CABIN_BUCKETS.includes(c));
  return cleaned.length ? cleaned : null;
}

router.get('/', (req, res) => {
  const { ship, destination, q, departsFrom, departsTo } = req.query;
  const cabinTypes = parseCabinList(req.query.cabinType);
  const flightOption = FLIGHT_OPTIONS.has(req.query.flight) ? req.query.flight : 'any';
  const limit = Math.min(parseInt(req.query.limit || '60', 10) || 60, 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

  const conditions = [];
  const params = [];

  if (ship) { conditions.push('c.ship = ?'); params.push(ship); }
  if (destination) { conditions.push('c.destination = ?'); params.push(destination); }
  if (q) {
    conditions.push('(c.title LIKE ? OR c.destination LIKE ? OR c.ship LIKE ? OR c.departure_port LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (departsFrom) { conditions.push('c.departs_at >= ?'); params.push(departsFrom); }
  if (departsTo)   { conditions.push('c.departs_at <= ?'); params.push(departsTo); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT c.* FROM cruises c
    ${where}
    ORDER BY c.departs_at ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cruises c ${where}`).get(...params).n;

  const items = rows.map((c) => {
    const best = bestCurrentFare(c.id, { cabinTypes, flightOption });
    return {
      id: c.id,
      title: c.title,
      ship: c.ship,
      destination: c.destination,
      departurePort: c.departure_port,
      arrivalPort: c.arrival_port,
      departsAt: c.departs_at,
      returnsAt: c.returns_at,
      durationNights: c.duration_nights,
      url: c.url,
      bestFare: best ? {
        code: best.fare_code,
        name: best.fare_name,
        cabinType: best.cabin_type,
        priceEur: best.price_eur,
        withFlight: !!best.with_flight,
        capturedAt: best.captured_at,
      } : null,
    };
  });

  // If a cabin or flight filter is set, hide cruises with no matching fare.
  const filtered = (cabinTypes || flightOption !== 'any')
    ? items.filter((i) => i.bestFare)
    : items;

  res.json({
    total,
    shown: filtered.length,
    limit,
    offset,
    filters: { ship, destination, q, departsFrom, departsTo, cabinTypes, flightOption },
    items: filtered,
  });
});

router.get('/filters', (_req, res) => {
  const ships = db.prepare(`SELECT DISTINCT ship FROM cruises WHERE ship IS NOT NULL ORDER BY ship`).all().map((r) => r.ship);
  const destinations = db.prepare(`SELECT DISTINCT destination FROM cruises WHERE destination IS NOT NULL ORDER BY destination`).all().map((r) => r.destination);
  res.json({ ships, destinations, cabinTypes: CABIN_BUCKETS });
});

router.get('/:id', (req, res) => {
  const c = db.prepare(`SELECT * FROM cruises WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const history = db.prepare(`
    SELECT fare_code, fare_name, cabin_type, with_flight, price_eur, captured_at
    FROM prices WHERE cruise_id = ?
    ORDER BY captured_at DESC LIMIT 400
  `).all(c.id);

  res.json({
    id: c.id,
    title: c.title,
    ship: c.ship,
    destination: c.destination,
    departurePort: c.departure_port,
    arrivalPort: c.arrival_port,
    departsAt: c.departs_at,
    returnsAt: c.returns_at,
    durationNights: c.duration_nights,
    url: c.url,
    bestFare: bestCurrentFare(c.id),
    priceHistory: history,
  });
});

module.exports = router;
