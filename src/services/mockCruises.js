/**
 * Deterministic, slightly-fluctuating sample data so the system is fully
 * usable without a live AIDA endpoint. Prices wobble day-to-day so the
 * notification path is exercised on a real schedule.
 *
 * Cabin types follow the categories AIDA actually shows on aida.de:
 *   Innenkabine, Meerblickkabine, Balkonkabine,
 *   Verandakabine Komfort, Verandakabine Deluxe,
 *   Junior-Suite, Suite.
 * The broad "cabinType" bucket (Innen/Außen/Balkon/Suite) is what users
 * filter and watch by; the specific cabin name is kept for transparency.
 *
 * Each "route" (ship × destination × duration × ports) produces multiple
 * departures spaced ~6 weeks apart so the per-route price tracking has
 * something to compare. A subset of fares is flagged as promo (with a
 * label like "Frühbucher Plus") so the Aktionen view has data on day 1.
 *
 * Each fare also exposes a tiny synthetic price `history`. The scraper
 * back-fills it on first persist so the "Tage vor Abfahrt zur Aktion"
 * statistic is meaningful from the very first scrape.
 */

const SHIPS = [
  'AIDAbella', 'AIDAblu', 'AIDAcosma', 'AIDAdiva', 'AIDAluna', 'AIDAmar',
  'AIDAnova', 'AIDAperla', 'AIDAprima', 'AIDAsol', 'AIDAstella',
];
const AREAS = [
  { name: 'Adria',                from: 'Venedig',     to: 'Venedig' },
  { name: 'Afrika',               from: 'Casablanca',  to: 'Casablanca' },
  { name: 'Asien',                from: 'Singapur',    to: 'Singapur' },
  { name: 'Indischer Ozean',      from: 'Mauritius',   to: 'Mauritius' },
  { name: 'Kanaren',              from: 'Gran Canaria', to: 'Gran Canaria' },
  { name: 'Karibik',              from: 'La Romana',   to: 'La Romana' },
  { name: 'Mittelmeer',           from: 'Mallorca',    to: 'Mallorca' },
  { name: 'Nordamerika',          from: 'New York',    to: 'New York' },
  { name: 'Nordeuropa',           from: 'Hamburg',     to: 'Hamburg' },
  { name: 'Orient',               from: 'Dubai',       to: 'Dubai' },
  { name: 'Ostsee',               from: 'Warnemünde',  to: 'Warnemünde' },
  { name: 'Transreisen',          from: 'Hamburg',     to: 'Gran Canaria' },
  { name: 'Weltreise',            from: 'Hamburg',     to: 'Hamburg' },
  { name: 'Westeuropa',           from: 'Hamburg',     to: 'Lissabon' },
  { name: 'Westliches Mittelmeer', from: 'Barcelona',  to: 'Barcelona' },
  { name: 'Östliches Mittelmeer', from: 'Korfu',       to: 'Korfu' },
];
const FARES = [
  { code: 'INNEN',           name: 'Innenkabine',           cabinType: 'Innen',  factor: 1.00 },
  { code: 'MEERBLICK',       name: 'Meerblickkabine',       cabinType: 'Außen',  factor: 1.15 },
  { code: 'BALKON',          name: 'Balkonkabine',          cabinType: 'Balkon', factor: 1.35 },
  { code: 'VERANDA_KOMFORT', name: 'Verandakabine Komfort', cabinType: 'Balkon', factor: 1.45 },
  { code: 'VERANDA_DELUXE',  name: 'Verandakabine Deluxe',  cabinType: 'Balkon', factor: 1.60 },
  { code: 'JUNIOR_SUITE',    name: 'Junior-Suite',          cabinType: 'Suite',  factor: 1.95 },
  { code: 'SUITE',           name: 'Suite',                 cabinType: 'Suite',  factor: 2.40 },
];

const PROMO_LABELS = ['Frühbucher Plus', 'AIDAspecialOffer', 'Last Minute'];
const DEPARTURES_PER_ROUTE = 6;
const DAYS_BETWEEN_DEPARTURES = 42;

function seeded(n) {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

function todayBucket() {
  const d = new Date();
  return d.getUTCFullYear() * 1000 + (d.getUTCMonth() + 1) * 50 + d.getUTCDate();
}

function isoDaysFromNow(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function generate() {
  const bucket = todayBucket();
  const cruises = [];
  let routeCounter = 0;

  for (let s = 0; s < SHIPS.length; s++) {
    for (let a = 0; a < AREAS.length; a++) {
      // Only ~60 % of (ship, region) pairs sail; keeps catalogue realistic.
      if (seeded(s * 31 + a * 17) > 0.6) continue;

      routeCounter += 1;
      const shipSlug = SHIPS[s].slice(4).toUpperCase();
      const nights = 7 + ((s + a) % 3) * 7;
      const routeKey = `${SHIPS[s]}|${AREAS[a].name}|${nights}|${AREAS[a].from}|${AREAS[a].to}`;
      const routeBasePrice = 600 + ((s * 7 + a * 11) % 9) * 120 + nights * 25;

      for (let d = 0; d < DEPARTURES_PER_ROUTE; d++) {
        const id = `MOCK-${shipSlug}-A${String(a).padStart(2, '0')}-D${d + 1}`;
        const departs = new Date();
        departs.setUTCDate(departs.getUTCDate() + 30 + routeCounter * 3 + d * DAYS_BETWEEN_DEPARTURES);
        const returns = new Date(departs);
        returns.setUTCDate(returns.getUTCDate() + nights);

        // Departure-level wobble so the same route has different prices per date.
        const departureWobble = (seeded(routeCounter * 100 + d * 7) - 0.5) * 0.12;
        const dailyWobble = (seeded(bucket + routeCounter * 11 + d) - 0.5) * 0.08;

        const fares = [];
        FARES.forEach((f, i) => {
          // Random availability per cruise/cabin (~85% available).
          const availSeed = seeded(routeCounter * 100 + d * 9 + i);
          if (availSeed < 0.15) return;

          const fareBase = routeBasePrice * f.factor * (1 + departureWobble);
          const promoSeed = seeded(routeCounter * 200 + d * 13 + i * 5);
          const isPromo = promoSeed > 0.65;
          const promoLabel = isPromo
            ? PROMO_LABELS[Math.floor(promoSeed * 1000) % PROMO_LABELS.length]
            : null;
          const promoDiscount = isPromo ? (0.15 + (promoSeed - 0.65) * 0.6) : 0; // 15–35 %
          const currentNoFlight = Math.round(fareBase * (1 - promoDiscount) * (1 + dailyWobble));
          const flightSurcharge = 220 + ((routeCounter + d + i) % 3) * 40;

          // Seeded backdated history so per-route stats are useful on first run.
          // For promo fares we draw a believable "regular price → discount" curve;
          // for full-fare we draw a flat-with-jitter line. The scrape backfills
          // these only the first time it sees the (cruise_id, fare_code, with_flight) pair.
          const historyDays = isPromo ? [60, 45, 30, 18, 9] : [50, 35, 20, 10];
          const promoStartIdx = isPromo
            ? Math.max(2, Math.floor(promoSeed * historyDays.length))
            : historyDays.length;
          const buildHistory = (withFlight) => historyDays.map((ago, h) => {
            const inPromo = h >= promoStartIdx;
            const factor = inPromo
              ? (1 - promoDiscount * (0.6 + (h - promoStartIdx) * 0.15))
              : (1 + 0.04 - h * 0.01);
            const base = Math.round(fareBase * factor);
            return {
              capturedAt: isoDaysFromNow(-ago),
              priceEur: withFlight ? base + flightSurcharge : base,
              isPromo: inPromo,
              promoLabel: inPromo ? promoLabel : null,
            };
          });

          fares.push({
            code: f.code,
            name: f.name,
            cabinType: f.cabinType,
            priceEur: currentNoFlight,
            currency: 'EUR',
            withFlight: false,
            isPromo,
            promoLabel,
            history: buildHistory(false),
          });
          fares.push({
            code: f.code,
            name: f.name,
            cabinType: f.cabinType,
            priceEur: currentNoFlight + flightSurcharge,
            currency: 'EUR',
            withFlight: true,
            isPromo,
            promoLabel,
            history: buildHistory(true),
          });
        });

        if (!fares.length) continue;

        cruises.push({
          id,
          title: `${nights} Nächte ${AREAS[a].name} mit ${SHIPS[s]}`,
          ship: SHIPS[s],
          destination: AREAS[a].name,
          departurePort: AREAS[a].from,
          arrivalPort: AREAS[a].to,
          departsAt: departs.toISOString().slice(0, 10),
          returnsAt: returns.toISOString().slice(0, 10),
          durationNights: nights,
          url: `https://www.aida.de/kreuzfahrt/${id}`,
          routeKey,
          raw: { mock: true },
          fares,
        });
      }
    }
  }

  return cruises;
}

module.exports = { generate };
