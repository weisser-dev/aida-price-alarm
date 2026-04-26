const express = require('express');
const { listRoutes, routeDetail } = require('../services/routes');

const router = express.Router();

const FLIGHT_OPTIONS = new Set(['any', 'with', 'without']);

router.get('/', (req, res) => {
  const flightOption = FLIGHT_OPTIONS.has(req.query.flight) ? req.query.flight : 'any';
  const items = listRoutes({
    ship: req.query.ship || null,
    destination: req.query.destination || null,
    q: req.query.q || null,
    flightOption,
  });
  res.json({ total: items.length, filters: { ...req.query, flightOption }, items });
});

router.get('/:routeKey', (req, res) => {
  const flightOption = FLIGHT_OPTIONS.has(req.query.flight) ? req.query.flight : 'any';
  const detail = routeDetail(req.params.routeKey, { flightOption });
  if (!detail) return res.status(404).json({ error: 'not_found' });
  res.json(detail);
});

module.exports = router;
