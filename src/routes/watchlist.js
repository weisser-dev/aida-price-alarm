const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const {
  bestCurrentFare,
  parseCabinFilter,
  serializeCabinFilter,
} = require('../services/notify');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FLIGHT_OPTIONS = new Set(['any', 'with', 'without']);

const insertWatch = db.prepare(`
  INSERT INTO watchlist (email, cruise_id, token, baseline_price, baseline_fare, cabin_filter, flight_filter)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email, cruise_id) DO UPDATE SET
    baseline_price = excluded.baseline_price,
    baseline_fare  = excluded.baseline_fare,
    cabin_filter   = excluded.cabin_filter,
    flight_filter  = excluded.flight_filter
`);

const findByToken = db.prepare(`SELECT * FROM watchlist WHERE token = ?`);
const deleteByToken = db.prepare(`DELETE FROM watchlist WHERE token = ?`);
const listForEmail = db.prepare(`
  SELECT w.token, w.cruise_id, w.baseline_price, w.baseline_fare,
         w.cabin_filter, w.flight_filter, w.created_at,
         c.title, c.ship, c.destination, c.departs_at, c.returns_at,
         c.duration_nights, c.url
  FROM watchlist w
  JOIN cruises c ON c.id = w.cruise_id
  WHERE w.email = ?
  ORDER BY c.departs_at ASC
`);
const cruiseStmt = db.prepare(`SELECT id FROM cruises WHERE id = ?`);

router.post('/', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const cruiseId = String(req.body?.cruiseId || '').trim();
  const cabinTypes = Array.isArray(req.body?.cabinTypes)
    ? req.body.cabinTypes
    : (req.body?.cabinTypes ? String(req.body.cabinTypes).split(',') : null);
  const cabinFilter = serializeCabinFilter(cabinTypes);
  const flightFilter = FLIGHT_OPTIONS.has(req.body?.flightOption) ? req.body.flightOption : 'any';

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!cruiseId) return res.status(400).json({ error: 'invalid_cruise' });
  if (!cruiseStmt.get(cruiseId)) return res.status(404).json({ error: 'cruise_not_found' });

  const best = bestCurrentFare(cruiseId, {
    cabinTypes: parseCabinFilter(cabinFilter),
    flightOption: flightFilter,
  });

  const token = crypto.randomBytes(18).toString('base64url');

  insertWatch.run(
    email,
    cruiseId,
    token,
    best ? best.price_eur : null,
    best ? best.fare_code : null,
    cabinFilter,
    flightFilter,
  );

  res.status(201).json({
    ok: true,
    token,
    baseline: best ? {
      price: best.price_eur,
      fare: best.fare_code,
      cabin: best.cabin_type,
      withFlight: !!best.with_flight,
    } : null,
    filters: {
      cabinTypes: parseCabinFilter(cabinFilter),
      flightOption: flightFilter,
    },
  });
});

router.get('/', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const rows = listForEmail.all(email).map((r) => {
    const cabinTypes = parseCabinFilter(r.cabin_filter);
    const flightOption = r.flight_filter || 'any';
    const best = bestCurrentFare(r.cruise_id, { cabinTypes, flightOption });
    return {
      token: r.token,
      cruiseId: r.cruise_id,
      title: r.title,
      ship: r.ship,
      destination: r.destination,
      departsAt: r.departs_at,
      returnsAt: r.returns_at,
      durationNights: r.duration_nights,
      url: r.url,
      filters: { cabinTypes, flightOption },
      baseline: { price: r.baseline_price, fare: r.baseline_fare },
      currentBest: best ? {
        code: best.fare_code,
        name: best.fare_name,
        cabinType: best.cabin_type,
        priceEur: best.price_eur,
        withFlight: !!best.with_flight,
      } : null,
    };
  });

  res.json({ email, items: rows });
});

router.delete('/:token', (req, res) => {
  const row = findByToken.get(req.params.token);
  if (!row) return res.status(404).json({ error: 'not_found' });
  deleteByToken.run(req.params.token);
  res.json({ ok: true });
});

module.exports = router;
