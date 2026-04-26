const express = require('express');
const db = require('../db');
const {
  TARIFF_BUCKETS, FLIGHT_OPTIONS,
  expandBuckets, bestPriceForJourney, allLatestPricesForJourney, routeAggregate,
} = require('../services/pricing');

const router = express.Router();

function parseTariffBuckets(value) {
  if (!value) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(TARIFF_BUCKETS.map((b) => b.id));
  const cleaned = list.map((s) => String(s).trim()).filter((s) => allowed.has(s));
  return cleaned.length ? cleaned : null;
}

router.get('/filters', (_req, res) => {
  const ships = db.prepare(`SELECT DISTINCT ship_name FROM routes WHERE ship_name IS NOT NULL ORDER BY ship_name`).all().map((r) => r.ship_name);
  const regions = db.prepare(`SELECT DISTINCT region FROM routes WHERE region IS NOT NULL ORDER BY region`).all().map((r) => r.region);
  const ports = db.prepare(`SELECT DISTINCT departure_port FROM routes WHERE departure_port IS NOT NULL ORDER BY departure_port`).all().map((r) => r.departure_port);
  const dates = db.prepare(`SELECT MIN(departs_at) AS first, MAX(departs_at) AS last FROM journeys`).get();
  res.json({
    ships, regions, ports,
    tariffBuckets: TARIFF_BUCKETS,
    flightOptions: FLIGHT_OPTIONS,
    dateRange: dates,
  });
});

router.get('/', (req, res) => {
  const { ship, region, port, q, departsFrom, departsTo } = req.query;
  const tariffBuckets = parseTariffBuckets(req.query.tariff);
  const flightOption = FLIGHT_OPTIONS.includes(req.query.flight) ? req.query.flight : 'any';
  const limit = Math.min(parseInt(req.query.limit || '60', 10) || 60, 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

  // Find route ids that have at least one matching journey in the date range.
  const routeConds = [];
  const routeParams = [];
  if (ship)   { routeConds.push('r.ship_name = ?');     routeParams.push(ship); }
  if (region) { routeConds.push('r.region = ?');        routeParams.push(region); }
  if (port)   { routeConds.push('r.departure_port = ?');routeParams.push(port); }
  if (q) {
    routeConds.push(`(r.title LIKE ? OR r.region LIKE ? OR r.ship_name LIKE ? OR r.departure_port LIKE ? OR r.route_group LIKE ?)`);
    const like = `%${q}%`;
    routeParams.push(like, like, like, like, like);
  }

  const journeyJoinConds = [];
  const journeyJoinParams = [];
  if (departsFrom) { journeyJoinConds.push('j.departs_at >= ?'); journeyJoinParams.push(departsFrom); }
  if (departsTo)   { journeyJoinConds.push('j.departs_at <= ?'); journeyJoinParams.push(departsTo); }

  const joinFilter = journeyJoinConds.length
    ? `AND r.id IN (SELECT route_id FROM journeys j WHERE ${journeyJoinConds.join(' AND ')})`
    : '';

  const whereClause = routeConds.length ? `WHERE ${routeConds.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM routes r ${whereClause} ${joinFilter ? `AND ${joinFilter.slice(4)}` : ''}
  `).get(...routeParams, ...journeyJoinParams).n;

  const rows = db.prepare(`
    SELECT r.* FROM routes r
    ${whereClause}
    ${joinFilter ? `AND ${joinFilter.slice(4)}` : ''}
    ORDER BY r.title ASC
    LIMIT ? OFFSET ?
  `).all(...routeParams, ...journeyJoinParams, limit, offset);

  const tariffs = expandBuckets(tariffBuckets ? tariffBuckets.join(',') : null);

  const items = rows.map((r) => {
    const journeys = db.prepare(`
      SELECT id, departs_at, returns_at, duration_nights
      FROM journeys
      WHERE route_id = ?
        ${departsFrom ? 'AND departs_at >= ?' : ''}
        ${departsTo   ? 'AND departs_at <= ?' : ''}
      ORDER BY departs_at ASC
    `).all(r.id, ...(departsFrom ? [departsFrom] : []), ...(departsTo ? [departsTo] : []));

    let bestForRoute = null;
    let bestForJourney = null;
    for (const j of journeys) {
      const cand = bestPriceForJourney(j.id, { tariffs, flightOption });
      if (!cand) continue;
      if (!bestForRoute || cand.amount_eur < bestForRoute.amount_eur) {
        bestForRoute = cand;
        bestForJourney = j;
      }
    }

    return {
      id: r.id,
      title: r.title,
      routeGroup: r.route_group,
      ship: r.ship_name,
      shipCode: r.ship_code,
      region: r.region,
      departurePort: r.departure_port,
      arrivalPort: r.arrival_port,
      durationNights: r.duration_nights,
      imageUrl: r.image_url,
      journeyCount: journeys.length,
      firstDeparture: journeys[0]?.departs_at,
      lastDeparture: journeys[journeys.length - 1]?.departs_at,
      bestPrice: bestForRoute ? {
        amountEur: bestForRoute.amount_eur,
        perPersonEur: bestForRoute.per_person_eur,
        tariffType: bestForRoute.tariff_type,
        tariffName: bestForRoute.tariff_name,
        flightIncluded: !!bestForRoute.flight_included,
        journeyId: bestForJourney?.id,
        journeyDepartsAt: bestForJourney?.departs_at,
      } : null,
    };
  });

  const filtered = (tariffBuckets || flightOption !== 'any')
    ? items.filter((i) => i.bestPrice)
    : items;

  res.json({
    total,
    shown: filtered.length,
    limit,
    offset,
    filters: { ship, region, port, q, departsFrom, departsTo, tariffBuckets, flightOption },
    items: filtered,
  });
});

router.get('/:id', (req, res) => {
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(req.params.id);
  if (!route) return res.status(404).json({ error: 'not_found' });

  const tariffBuckets = parseTariffBuckets(req.query.tariff);
  const flightOption  = FLIGHT_OPTIONS.includes(req.query.flight) ? req.query.flight : 'any';
  const tariffs = expandBuckets(tariffBuckets ? tariffBuckets.join(',') : null);

  const journeys = db.prepare(`
    SELECT * FROM journeys WHERE route_id = ? ORDER BY departs_at ASC
  `).all(route.id);

  const journeyDtos = journeys.map((j) => {
    const all = allLatestPricesForJourney(j.id);
    const filtered = all.filter((r) => {
      if (tariffs && !tariffs.includes(r.tariff_type)) return false;
      if (flightOption === 'with' && !r.flight_included) return false;
      if (flightOption === 'without' && r.flight_included) return false;
      return true;
    });
    const cheapest = filtered.length
      ? filtered.reduce((a, b) => a.amount_eur < b.amount_eur ? a : b)
      : null;

    const campaigns = db.prepare(`
      SELECT code, name, medium, valid_from, valid_to FROM campaigns
      WHERE journey_id = ? AND (valid_to IS NULL OR valid_to >= date('now'))
    `).all(j.id);

    return {
      id: j.id,
      departsAt: j.departs_at,
      returnsAt: j.returns_at,
      durationNights: j.duration_nights,
      shipCode: j.ship_code,
      bookingUrl: j.booking_url,
      latestPrices: all.map((p) => ({
        tariffType: p.tariff_type,
        tariffName: p.tariff_name,
        flightIncluded: !!p.flight_included,
        amountEur: p.amount_eur,
        perPersonEur: p.per_person_eur,
        capturedAt: p.captured_at,
      })),
      cheapestForFilter: cheapest ? {
        amountEur: cheapest.amount_eur,
        perPersonEur: cheapest.per_person_eur,
        tariffType: cheapest.tariff_type,
        tariffName: cheapest.tariff_name,
        flightIncluded: !!cheapest.flight_included,
      } : null,
      activeCampaigns: campaigns,
    };
  });

  const ports = route.ports_json ? safeJson(route.ports_json) : [];
  const aggregate = routeAggregate(route.id, { tariffs, flightOption });

  // Price history (capped) for the chart
  const history = db.prepare(`
    SELECT p.journey_id, p.tariff_type, p.flight_included, p.amount_eur, p.captured_at,
           j.departs_at
    FROM prices p JOIN journeys j ON j.id = p.journey_id
    WHERE j.route_id = ?
    ORDER BY p.captured_at DESC
    LIMIT 5000
  `).all(route.id);

  res.json({
    id: route.id,
    title: route.title,
    routeGroup: route.route_group,
    routeCode: route.route_code,
    yieldCode: route.yield_code,
    ship: route.ship_name,
    shipCode: route.ship_code,
    region: route.region,
    departurePort: route.departure_port,
    arrivalPort: route.arrival_port,
    durationNights: route.duration_nights,
    ports,
    imageUrl: route.image_url,
    aggregate,
    journeys: journeyDtos,
    priceHistory: history.map((h) => ({
      journeyId: h.journey_id,
      departsAt: h.departs_at,
      tariffType: h.tariff_type,
      flightIncluded: !!h.flight_included,
      amountEur: h.amount_eur,
      capturedAt: h.captured_at,
    })),
  });
});

function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = router;
