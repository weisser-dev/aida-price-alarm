const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const {
  TARIFF_BUCKETS, FLIGHT_OPTIONS,
  expandBuckets, bestPriceForJourney,
} = require('../services/pricing');
const { serializeTariffFilter, parseTariffFilter } = require('../services/notify');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const insertWatch = db.prepare(`
  INSERT INTO watchlist (
    email, watch_type, target_id, token, tariff_filter, flight_filter,
    baseline_price, baseline_tariff, baseline_journey
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email, watch_type, target_id) DO UPDATE SET
    tariff_filter    = excluded.tariff_filter,
    flight_filter    = excluded.flight_filter,
    baseline_price   = excluded.baseline_price,
    baseline_tariff  = excluded.baseline_tariff,
    baseline_journey = excluded.baseline_journey
`);

const findByToken = db.prepare(`SELECT * FROM watchlist WHERE token = ?`);
const deleteByToken = db.prepare(`DELETE FROM watchlist WHERE token = ?`);

const listForEmail = db.prepare(`SELECT * FROM watchlist WHERE email = ? ORDER BY created_at DESC`);
const routeStmt = db.prepare(`SELECT * FROM routes WHERE id = ?`);
const journeyStmt = db.prepare(`SELECT j.*, r.title AS route_title, r.ship_name, r.region FROM journeys j JOIN routes r ON r.id = j.route_id WHERE j.id = ?`);

router.post('/', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const watchType = String(req.body?.watchType || 'route');
  const targetId = String(req.body?.targetId || '').trim();
  const tariffBuckets = Array.isArray(req.body?.tariffBuckets)
    ? req.body.tariffBuckets
    : (req.body?.tariffBuckets ? String(req.body.tariffBuckets).split(',') : null);
  const tariffFilter = serializeTariffFilter(tariffBuckets);
  const flightFilter = FLIGHT_OPTIONS.includes(req.body?.flightOption) ? req.body.flightOption : 'any';

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!['route', 'journey'].includes(watchType)) return res.status(400).json({ error: 'invalid_watch_type' });
  if (!targetId) return res.status(400).json({ error: 'invalid_target' });

  let exists, journeysOfTarget;
  if (watchType === 'route') {
    exists = !!routeStmt.get(targetId);
    journeysOfTarget = exists ? db.prepare(`SELECT id FROM journeys WHERE route_id = ?`).all(targetId).map((j) => j.id) : [];
  } else {
    const j = journeyStmt.get(targetId);
    exists = !!j;
    journeysOfTarget = exists ? [targetId] : [];
  }
  if (!exists) return res.status(404).json({ error: 'target_not_found' });

  const tariffs = expandBuckets(tariffFilter);
  let best = null, bestJourneyId = null;
  for (const jid of journeysOfTarget) {
    const cand = bestPriceForJourney(jid, { tariffs, flightOption: flightFilter });
    if (!cand) continue;
    if (!best || cand.amount_eur < best.amount_eur) {
      best = cand;
      bestJourneyId = jid;
    }
  }

  const token = crypto.randomBytes(18).toString('base64url');
  insertWatch.run(
    email, watchType, targetId, token, tariffFilter, flightFilter,
    best ? best.amount_eur : null,
    best ? best.tariff_type : null,
    bestJourneyId,
  );

  res.status(201).json({
    ok: true,
    token,
    watchType,
    targetId,
    baseline: best ? {
      amountEur: best.amount_eur,
      perPersonEur: best.per_person_eur,
      tariffType: best.tariff_type,
      tariffName: best.tariff_name,
      flightIncluded: !!best.flight_included,
      journeyId: bestJourneyId,
    } : null,
    filters: {
      tariffBuckets: parseTariffFilter(tariffFilter),
      flightOption: flightFilter,
    },
  });
});

router.get('/', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const rows = listForEmail.all(email);
  const items = rows.map((w) => {
    const tariffs = expandBuckets(w.tariff_filter);
    const flightOption = w.flight_filter || 'any';

    let route, journey, journeyIds;
    if (w.watch_type === 'route') {
      route = routeStmt.get(w.target_id);
      journeyIds = db.prepare(`SELECT id FROM journeys WHERE route_id = ?`).all(w.target_id).map((r) => r.id);
    } else {
      journey = journeyStmt.get(w.target_id);
      route = journey ? routeStmt.get(journey.route_id) : null;
      journeyIds = journey ? [journey.id] : [];
    }
    if (!route) return null;

    let best = null, bestJourneyId = null;
    for (const jid of journeyIds) {
      const cand = bestPriceForJourney(jid, { tariffs, flightOption });
      if (!cand) continue;
      if (!best || cand.amount_eur < best.amount_eur) {
        best = cand;
        bestJourneyId = jid;
      }
    }

    return {
      token: w.token,
      watchType: w.watch_type,
      targetId: w.target_id,
      route: {
        id: route.id,
        title: route.title,
        ship: route.ship_name,
        region: route.region,
        departurePort: route.departure_port,
        arrivalPort: route.arrival_port,
      },
      journey: journey ? {
        id: journey.id,
        departsAt: journey.departs_at,
        returnsAt: journey.returns_at,
        durationNights: journey.duration_nights,
      } : null,
      filters: {
        tariffBuckets: parseTariffFilter(w.tariff_filter),
        flightOption,
      },
      baseline: {
        amountEur: w.baseline_price,
        tariffType: w.baseline_tariff,
        journeyId: w.baseline_journey,
      },
      currentBest: best ? {
        amountEur: best.amount_eur,
        perPersonEur: best.per_person_eur,
        tariffType: best.tariff_type,
        tariffName: best.tariff_name,
        flightIncluded: !!best.flight_included,
        journeyId: bestJourneyId,
      } : null,
    };
  }).filter(Boolean);

  res.json({ email, items });
});

router.delete('/:token', (req, res) => {
  const row = findByToken.get(req.params.token);
  if (!row) return res.status(404).json({ error: 'not_found' });
  deleteByToken.run(req.params.token);
  res.json({ ok: true });
});

module.exports = router;
