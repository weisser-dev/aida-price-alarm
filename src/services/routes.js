const db = require('../db');
const { CABIN_BUCKETS } = require('./notify');

/**
 * Aggregations across cruises that share the same `route_key` (same ship +
 * destination + duration + ports). Powers the "Routen" overview, the per-route
 * detail page, and the "Aktionen" page.
 *
 * "Latest fare" is the freshest captured price per (cruise_id, fare_code,
 * with_flight). All-time stats (lowest ever, promo timing) include the seeded
 * back-fill from mockCruises so the UI is meaningful from the first scrape.
 */

const routesGroupedStmt = db.prepare(`
  SELECT c.route_key,
         MAX(c.title)        AS title,
         c.ship,
         c.destination,
         c.duration_nights,
         c.departure_port,
         c.arrival_port,
         COUNT(*)             AS departure_count,
         MIN(c.departs_at)    AS first_departure,
         MAX(c.departs_at)    AS last_departure
  FROM cruises c
  WHERE c.route_key IS NOT NULL
    AND c.departs_at >= date('now')
  GROUP BY c.route_key, c.ship, c.destination, c.duration_nights, c.departure_port, c.arrival_port
`);

const latestPricesForRouteStmt = db.prepare(`
  SELECT p.cruise_id, p.fare_code, p.fare_name, p.cabin_type, p.with_flight,
         p.price_eur, p.is_promo, p.promo_label, p.captured_at,
         c.departs_at, c.returns_at, c.url
  FROM prices p
  JOIN cruises c ON c.id = p.cruise_id
  JOIN (
    SELECT p2.cruise_id, p2.fare_code, p2.with_flight, MAX(p2.captured_at) AS captured_at
    FROM prices p2
    JOIN cruises c2 ON c2.id = p2.cruise_id
    WHERE c2.route_key = ?
    GROUP BY p2.cruise_id, p2.fare_code, p2.with_flight
  ) latest ON latest.cruise_id = p.cruise_id
          AND latest.fare_code = p.fare_code
          AND latest.with_flight = p.with_flight
          AND latest.captured_at = p.captured_at
  WHERE c.route_key = ?
    AND c.departs_at >= date('now')
`);

const promoTimingStmt = db.prepare(`
  SELECT p.cruise_id, p.cabin_type, p.captured_at, c.departs_at,
         (julianday(c.departs_at) - julianday(p.captured_at)) AS days_before
  FROM prices p
  JOIN cruises c ON c.id = p.cruise_id
  WHERE c.route_key = ? AND p.is_promo = 1
`);

const lowestEverStmt = db.prepare(`
  SELECT p.cabin_type, p.with_flight, MIN(p.price_eur) AS price_eur
  FROM prices p
  JOIN cruises c ON c.id = p.cruise_id
  WHERE c.route_key = ?
  GROUP BY p.cabin_type, p.with_flight
`);

const departuresForRouteStmt = db.prepare(`
  SELECT id, title, ship, destination, departure_port, arrival_port,
         departs_at, returns_at, duration_nights, url
  FROM cruises
  WHERE route_key = ? AND departs_at >= date('now')
  ORDER BY departs_at ASC
`);

const historyForCruiseStmt = db.prepare(`
  SELECT fare_code, fare_name, cabin_type, with_flight,
         price_eur, is_promo, promo_label, captured_at
  FROM prices
  WHERE cruise_id = ?
  ORDER BY captured_at ASC
`);

function pickCheapest(rows) {
  if (!rows.length) return null;
  return rows.reduce((best, r) => (!best || r.price_eur < best.price_eur ? r : best), null);
}

function summariseLatest(latestRows, flightOption = 'any') {
  const filtered = latestRows.filter((r) => {
    if (flightOption === 'with' && !r.with_flight) return false;
    if (flightOption === 'without' && r.with_flight) return false;
    return true;
  });
  return filtered;
}

function perCabinAggregate(latestRows, lowestEverRows, flightOption = 'any') {
  const filteredLatest = summariseLatest(latestRows, flightOption);
  const filteredEver = lowestEverRows.filter((r) => {
    if (flightOption === 'with' && !r.with_flight) return false;
    if (flightOption === 'without' && r.with_flight) return false;
    return true;
  });

  return CABIN_BUCKETS.map((cabin) => {
    const cabinLatest = filteredLatest.filter((r) => r.cabin_type === cabin);
    const cheapest = pickCheapest(cabinLatest);
    const everPrices = filteredEver.filter((r) => r.cabin_type === cabin).map((r) => r.price_eur);
    const everMin = everPrices.length ? Math.min(...everPrices) : null;
    return {
      cabinType: cabin,
      lowestCurrent: cheapest ? Math.round(cheapest.price_eur) : null,
      lowestCurrentIsPromo: cheapest ? !!cheapest.is_promo : false,
      lowestCurrentPromoLabel: cheapest?.promo_label || null,
      lowestCurrentCruiseId: cheapest?.cruise_id || null,
      lowestCurrentDepartsAt: cheapest?.departs_at || null,
      lowestEver: everMin != null ? Math.round(everMin) : null,
      promoOffersNow: cabinLatest.filter((r) => r.is_promo).length,
    };
  });
}

function computePromoStats(rows) {
  const days = rows.map((r) => r.days_before).filter((n) => Number.isFinite(n) && n >= 0);
  if (!days.length) return null;
  const sorted = [...days].sort((a, b) => a - b);
  const mean = days.reduce((s, d) => s + d, 0) / days.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    promoSamples: days.length,
    avgDaysBeforeDeparture: Math.round(mean),
    medianDaysBeforeDeparture: Math.round(median),
    earliestPromoDaysBeforeDeparture: Math.round(sorted[sorted.length - 1]),
    latestPromoDaysBeforeDeparture: Math.round(sorted[0]),
  };
}

function summariseRoute(routeRow, { flightOption = 'any' } = {}) {
  const latest = latestPricesForRouteStmt.all(routeRow.route_key, routeRow.route_key);
  const lowestEver = lowestEverStmt.all(routeRow.route_key);
  const promos = promoTimingStmt.all(routeRow.route_key);

  const filteredLatest = summariseLatest(latest, flightOption);
  const lowest = filteredLatest.reduce((m, p) => (m == null || p.price_eur < m ? p.price_eur : m), null);
  const highest = filteredLatest.reduce((m, p) => (m == null || p.price_eur > m ? p.price_eur : m), null);
  const avg = filteredLatest.length
    ? filteredLatest.reduce((s, p) => s + p.price_eur, 0) / filteredLatest.length
    : null;
  const currentPromoDepartureIds = new Set(
    filteredLatest.filter((p) => p.is_promo).map((p) => p.cruise_id),
  );

  return {
    routeKey: routeRow.route_key,
    title: routeRow.title,
    ship: routeRow.ship,
    destination: routeRow.destination,
    durationNights: routeRow.duration_nights,
    departurePort: routeRow.departure_port,
    arrivalPort: routeRow.arrival_port,
    departureCount: routeRow.departure_count,
    firstDeparture: routeRow.first_departure,
    lastDeparture: routeRow.last_departure,
    lowestCurrentPrice: lowest != null ? Math.round(lowest) : null,
    highestCurrentPrice: highest != null ? Math.round(highest) : null,
    avgCurrentPrice: avg != null ? Math.round(avg) : null,
    currentPromoDepartures: currentPromoDepartureIds.size,
    perCabin: perCabinAggregate(latest, lowestEver, flightOption),
    promoStats: computePromoStats(promos),
  };
}

function listRoutes(filters = {}) {
  const all = routesGroupedStmt.all();
  const flightOption = filters.flightOption || 'any';
  const items = all
    .filter((r) => {
      if (filters.ship && r.ship !== filters.ship) return false;
      if (filters.destination && r.destination !== filters.destination) return false;
      if (filters.q) {
        const hay = `${r.title} ${r.ship} ${r.destination} ${r.departure_port} ${r.arrival_port}`.toLowerCase();
        if (!hay.includes(String(filters.q).toLowerCase())) return false;
      }
      return true;
    })
    .map((r) => summariseRoute(r, { flightOption }))
    .filter((r) => r.lowestCurrentPrice != null)
    .sort((a, b) => a.firstDeparture.localeCompare(b.firstDeparture));
  return items;
}

function routeDetail(routeKey, { flightOption = 'any' } = {}) {
  const routeRow = routesGroupedStmt.all().find((r) => r.route_key === routeKey);
  if (!routeRow) return null;
  const summary = summariseRoute(routeRow, { flightOption });

  const latest = latestPricesForRouteStmt.all(routeKey, routeKey);
  const departures = departuresForRouteStmt.all(routeKey).map((dep) => {
    const cabinRows = CABIN_BUCKETS.map((cabin) => {
      const matches = latest.filter((r) => {
        if (r.cruise_id !== dep.id) return false;
        if (r.cabin_type !== cabin) return false;
        if (flightOption === 'with' && !r.with_flight) return false;
        if (flightOption === 'without' && r.with_flight) return false;
        return true;
      });
      const cheapest = pickCheapest(matches);
      if (!cheapest) return { cabinType: cabin, price: null };
      const daysBefore = Math.round(
        (new Date(dep.departs_at).getTime() - new Date(cheapest.captured_at).getTime()) / 86400000,
      );
      return {
        cabinType: cabin,
        price: Math.round(cheapest.price_eur),
        fareName: cheapest.fare_name,
        withFlight: !!cheapest.with_flight,
        isPromo: !!cheapest.is_promo,
        promoLabel: cheapest.promo_label,
        capturedAt: cheapest.captured_at,
        daysBeforeDeparture: daysBefore,
      };
    });
    const cheapestOverall = pickCheapest(latest.filter((r) => {
      if (r.cruise_id !== dep.id) return false;
      if (flightOption === 'with' && !r.with_flight) return false;
      if (flightOption === 'without' && r.with_flight) return false;
      return true;
    }));
    return {
      cruiseId: dep.id,
      departsAt: dep.departs_at,
      returnsAt: dep.returns_at,
      url: dep.url,
      lowestCurrentPrice: cheapestOverall ? Math.round(cheapestOverall.price_eur) : null,
      lowestCurrentIsPromo: cheapestOverall ? !!cheapestOverall.is_promo : false,
      lowestCurrentPromoLabel: cheapestOverall?.promo_label || null,
      perCabin: cabinRows,
    };
  });

  return { ...summary, departures };
}

const currentPromosStmt = db.prepare(`
  SELECT p.cruise_id, p.fare_code, p.fare_name, p.cabin_type, p.with_flight,
         p.price_eur, p.promo_label, p.captured_at,
         c.title, c.ship, c.destination, c.departure_port, c.arrival_port,
         c.departs_at, c.returns_at, c.duration_nights, c.url, c.route_key
  FROM prices p
  JOIN cruises c ON c.id = p.cruise_id
  JOIN (
    SELECT cruise_id, fare_code, with_flight, MAX(captured_at) AS captured_at
    FROM prices
    GROUP BY cruise_id, fare_code, with_flight
  ) latest ON latest.cruise_id = p.cruise_id
          AND latest.fare_code = p.fare_code
          AND latest.with_flight = p.with_flight
          AND latest.captured_at = p.captured_at
  WHERE p.is_promo = 1
    AND c.departs_at >= date('now')
`);

const regularBaselineStmt = db.prepare(`
  SELECT MAX(price_eur) AS regular_price
  FROM prices
  WHERE cruise_id = ? AND fare_code = ? AND with_flight = ? AND is_promo = 0
`);

function currentPromotions(filters = {}) {
  const rows = currentPromosStmt.all();
  const flightOption = filters.flightOption || 'any';
  const cabinSet = filters.cabinTypes && filters.cabinTypes.length
    ? new Set(filters.cabinTypes)
    : null;

  const out = [];
  for (const r of rows) {
    if (filters.ship && r.ship !== filters.ship) continue;
    if (filters.destination && r.destination !== filters.destination) continue;
    if (cabinSet && !cabinSet.has(r.cabin_type)) continue;
    if (flightOption === 'with' && !r.with_flight) continue;
    if (flightOption === 'without' && r.with_flight) continue;

    const baseline = regularBaselineStmt.get(r.cruise_id, r.fare_code, r.with_flight)?.regular_price;
    const discountPct = baseline && baseline > r.price_eur
      ? Math.round((1 - r.price_eur / baseline) * 100)
      : null;
    const daysBefore = Math.round(
      (new Date(r.departs_at).getTime() - new Date(r.captured_at).getTime()) / 86400000,
    );

    out.push({
      cruiseId: r.cruise_id,
      routeKey: r.route_key,
      title: r.title,
      ship: r.ship,
      destination: r.destination,
      departurePort: r.departure_port,
      arrivalPort: r.arrival_port,
      departsAt: r.departs_at,
      returnsAt: r.returns_at,
      durationNights: r.duration_nights,
      url: r.url,
      promo: {
        label: r.promo_label || 'Aktion',
        fareCode: r.fare_code,
        fareName: r.fare_name,
        cabinType: r.cabin_type,
        withFlight: !!r.with_flight,
        currentPrice: Math.round(r.price_eur),
        regularPrice: baseline ? Math.round(baseline) : null,
        discountPercent: discountPct,
        daysBeforeDeparture: daysBefore,
        capturedAt: r.captured_at,
      },
    });
  }

  // Best deal first.
  out.sort((a, b) => {
    const da = a.promo.discountPercent ?? -1;
    const db = b.promo.discountPercent ?? -1;
    return db - da;
  });
  return out;
}

module.exports = {
  listRoutes,
  routeDetail,
  currentPromotions,
  historyForCruise: (id) => historyForCruiseStmt.all(id),
};
