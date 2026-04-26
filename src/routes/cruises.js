const express = require('express');
const db = require('../db');
const { bestCurrentFare } = require('../services/notify');

const router = express.Router();

const listStmt = (where, params, limit, offset) => db.prepare(`
  SELECT c.*
  FROM cruises c
  ${where}
  ORDER BY c.departs_at ASC
  LIMIT ? OFFSET ?
`).all(...params, limit, offset);

const countStmt = (where, params) => db.prepare(`
  SELECT COUNT(*) AS n FROM cruises c ${where}
`).get(...params).n;

router.get('/', (req, res) => {
  const { ship, destination, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

  const conditions = [];
  const params = [];

  if (ship) {
    conditions.push('c.ship = ?');
    params.push(ship);
  }
  if (destination) {
    conditions.push('c.destination = ?');
    params.push(destination);
  }
  if (q) {
    conditions.push('(c.title LIKE ? OR c.destination LIKE ? OR c.ship LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = listStmt(where, params, limit, offset);
  const total = countStmt(where, params);

  const items = rows.map((c) => {
    const best = bestCurrentFare(c.id);
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
        capturedAt: best.captured_at,
      } : null,
    };
  });

  res.json({ total, limit, offset, items });
});

router.get('/filters', (_req, res) => {
  const ships = db.prepare(`SELECT DISTINCT ship FROM cruises WHERE ship IS NOT NULL ORDER BY ship`).all().map((r) => r.ship);
  const destinations = db.prepare(`SELECT DISTINCT destination FROM cruises WHERE destination IS NOT NULL ORDER BY destination`).all().map((r) => r.destination);
  res.json({ ships, destinations });
});

router.get('/:id', (req, res) => {
  const c = db.prepare(`SELECT * FROM cruises WHERE id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });

  const history = db.prepare(`
    SELECT fare_code, fare_name, cabin_type, price_eur, captured_at
    FROM prices WHERE cruise_id = ?
    ORDER BY captured_at DESC LIMIT 200
  `).all(c.id);

  const best = bestCurrentFare(c.id);

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
    bestFare: best,
    priceHistory: history,
  });
});

module.exports = router;
