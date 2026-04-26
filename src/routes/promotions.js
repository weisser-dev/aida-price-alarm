const express = require('express');
const { currentPromotions } = require('../services/routes');
const { CABIN_BUCKETS } = require('../services/notify');

const router = express.Router();
const FLIGHT_OPTIONS = new Set(['any', 'with', 'without']);

function parseCabinList(value) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = list.map((s) => String(s).trim()).filter(Boolean).filter((c) => CABIN_BUCKETS.includes(c));
  return cleaned.length ? cleaned : null;
}

router.get('/', (req, res) => {
  const flightOption = FLIGHT_OPTIONS.has(req.query.flight) ? req.query.flight : 'any';
  const cabinTypes = parseCabinList(req.query.cabinType);
  const items = currentPromotions({
    ship: req.query.ship || null,
    destination: req.query.destination || null,
    cabinTypes,
    flightOption,
  });
  res.json({
    total: items.length,
    filters: { ship: req.query.ship || null, destination: req.query.destination || null, cabinTypes, flightOption },
    items,
  });
});

module.exports = router;
