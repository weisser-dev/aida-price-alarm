/**
 * Shared price-aggregation helpers used by the API and the notify path.
 * Everything here works on the new routes/journeys/prices schema.
 */

const db = require('../db');

const FLIGHT_OPTIONS = ['any', 'with', 'without'];

const TARIFF_BUCKETS = [
  { id: 'LIGHT',           tariffs: ['LIG'] },
  { id: 'CLASSIC',         tariffs: ['CLA', 'CLAAI'] },
  { id: 'PREMIUM',         tariffs: ['IND', 'INDAI'] },
  { id: 'COMFORT_ALL_IN',  tariffs: ['COMAI'] },
  { id: 'PAUSCHAL',        tariffs: ['PAU', 'PAUAI'] },
  { id: 'SEETOURS',        tariffs: ['SEE', 'SEEAI'] },
];
const BUCKET_TARIFFS = new Map(TARIFF_BUCKETS.map((b) => [b.id, new Set(b.tariffs)]));

function expandBuckets(bucketCsv) {
  if (!bucketCsv) return null;
  const requested = String(bucketCsv).split(',').map((s) => s.trim()).filter(Boolean);
  const tariffs = new Set();
  for (const id of requested) {
    const set = BUCKET_TARIFFS.get(id);
    if (set) for (const t of set) tariffs.add(t);
  }
  return tariffs.size ? [...tariffs] : null;
}

function bucketForTariff(tariffCode) {
  for (const b of TARIFF_BUCKETS) if (b.tariffs.includes(tariffCode)) return b.id;
  return tariffCode || null;
}

// Use MAX(id) instead of MAX(captured_at) so multiple inserts within the
// same second (one transaction) collapse to a single row.
const latestPricesPerJourney = db.prepare(`
  SELECT p.tariff_type, p.tariff_name, p.flight_included, p.amount_eur, p.per_person_eur, p.captured_at
  FROM prices p
  WHERE p.journey_id = ?
    AND p.id IN (
      SELECT MAX(id) FROM prices
      WHERE journey_id = ?
      GROUP BY tariff_type, flight_included
    )
`);

function filterPriceRows(rows, { tariffs, flightOption }) {
  const tariffSet = tariffs && tariffs.length ? new Set(tariffs) : null;
  const flight = flightOption || 'any';
  return rows.filter((r) => {
    if (tariffSet && !tariffSet.has(r.tariff_type)) return false;
    if (flight === 'with' && !r.flight_included) return false;
    if (flight === 'without' && r.flight_included) return false;
    return true;
  });
}

function bestPriceForJourney(journeyId, options = {}) {
  const rows = latestPricesPerJourney.all(journeyId, journeyId);
  const candidates = filterPriceRows(rows, options);
  if (!candidates.length) return null;
  return candidates.reduce((best, r) =>
    !best || r.amount_eur < best.amount_eur ? r : best, null);
}

function allLatestPricesForJourney(journeyId) {
  return latestPricesPerJourney.all(journeyId, journeyId);
}

const journeysOfRoute = db.prepare(`
  SELECT id, departs_at, returns_at, duration_nights, ship_code, booking_url
  FROM journeys
  WHERE route_id = ?
  ORDER BY departs_at ASC
`);

/**
 * Aggregate stats for an entire route across all of its journeys, optionally
 * scoped to specific tariff buckets and flight option.
 *  - currentLow: cheapest currently advertised price among matching variants
 *  - allTimeLow: cheapest ever recorded
 *  - median:    median of latest matching prices across journeys
 *  - typicalCampaignLeadDays: mean (days_to_departure when campaign valid_from)
 */
function routeAggregate(routeId, options = {}) {
  const journeys = journeysOfRoute.all(routeId);
  if (!journeys.length) return null;

  const currentLatestRows = [];
  let currentLow = null;
  let currentLowJourney = null;

  for (const j of journeys) {
    const rows = filterPriceRows(latestPricesPerJourney.all(j.id, j.id), options);
    for (const r of rows) {
      currentLatestRows.push({ ...r, journey_id: j.id, departs_at: j.departs_at });
      if (!currentLow || r.amount_eur < currentLow.amount_eur) {
        currentLow = r;
        currentLowJourney = j;
      }
    }
  }

  // All-time low across the full price history of this route
  const tariffsCsv  = options.tariffs && options.tariffs.length ? options.tariffs.map(quote).join(',') : null;
  const flightWhere = options.flightOption === 'with' ? 'AND p.flight_included = 1'
                    : options.flightOption === 'without' ? 'AND p.flight_included = 0' : '';
  const tariffWhere = tariffsCsv ? `AND p.tariff_type IN (${tariffsCsv})` : '';

  const lowRow = db.prepare(`
    SELECT MIN(p.amount_eur) AS min_amount,
           p.tariff_type, p.flight_included, p.captured_at, p.journey_id
    FROM prices p JOIN journeys j ON j.id = p.journey_id
    WHERE j.route_id = ? ${tariffWhere} ${flightWhere}
  `).get(routeId);

  const median = computeMedian(currentLatestRows.map((r) => r.amount_eur));

  // Campaign lead-time: median days between campaign valid_from and journey departs_at
  const camps = db.prepare(`
    SELECT c.valid_from, j.departs_at
    FROM campaigns c JOIN journeys j ON j.id = c.journey_id
    WHERE j.route_id = ? AND c.valid_from IS NOT NULL
  `).all(routeId);
  const leadDays = camps
    .map((c) => daysBetween(c.valid_from, c.departs_at))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const typicalCampaignLeadDays = leadDays.length ? Math.round(median0(leadDays)) : null;

  return {
    journeys: journeys.length,
    currentLow: currentLow ? {
      amountEur: currentLow.amount_eur,
      perPersonEur: currentLow.per_person_eur,
      tariffType: currentLow.tariff_type,
      tariffName: currentLow.tariff_name,
      flightIncluded: !!currentLow.flight_included,
      journeyId: currentLowJourney?.id,
      departsAt: currentLowJourney?.departs_at,
    } : null,
    allTimeLow: lowRow && lowRow.min_amount ? {
      amountEur: lowRow.min_amount,
      tariffType: lowRow.tariff_type,
      flightIncluded: !!lowRow.flight_included,
      capturedAt: lowRow.captured_at,
      journeyId: lowRow.journey_id,
    } : null,
    median,
    typicalCampaignLeadDays,
  };
}

function computeMedian(arr) {
  if (!arr.length) return null;
  return Math.round(median0(arr));
}
function median0(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function quote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function daysBetween(a, b) {
  const da = new Date(a), db_ = new Date(b);
  if (isNaN(da) || isNaN(db_)) return NaN;
  return Math.round((db_ - da) / 86400000);
}

module.exports = {
  TARIFF_BUCKETS,
  FLIGHT_OPTIONS,
  expandBuckets,
  bucketForTariff,
  bestPriceForJourney,
  allLatestPricesForJourney,
  routeAggregate,
  filterPriceRows,
  latestPricesPerJourney,
};
