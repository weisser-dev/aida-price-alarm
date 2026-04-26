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
 * Some cabin variants are randomly unavailable per cruise (no price row),
 * matching AIDA's "Nicht verfügbar" reality.
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

function seeded(n) {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

function todayBucket() {
  const d = new Date();
  return d.getUTCFullYear() * 1000 + (d.getUTCMonth() + 1) * 50 + d.getUTCDate();
}

function generate() {
  const bucket = todayBucket();
  const cruises = [];
  let counter = 0;

  for (let s = 0; s < SHIPS.length; s++) {
    for (let a = 0; a < AREAS.length; a++) {
      // Only ~60 % of (ship, region) pairs sail; keeps catalogue realistic.
      if (seeded(s * 31 + a * 17) > 0.6) continue;
      for (let r = 0; r < 1; r++) {
        counter += 1;
        const shipSlug = SHIPS[s].slice(4).toUpperCase();
        const id = `MOCK-${shipSlug}-A${String(a).padStart(2, '0')}-V${r + 1}`;
        const nights = 7 + ((s + a + r) % 3) * 7;
        const departs = new Date();
        departs.setUTCDate(departs.getUTCDate() + 30 + counter * 3);
        const returns = new Date(departs);
        returns.setUTCDate(returns.getUTCDate() + nights);

        const basePrice = 600 + ((s * 7 + a * 11 + r * 13) % 9) * 120 + nights * 25;
        const wobble = (seeded(bucket + counter) - 0.5) * 0.18;

        const fares = [];
        FARES.forEach((f, i) => {
          // Random availability per cruise/cabin (~85% available).
          const availSeed = seeded(counter * 100 + i);
          if (availSeed < 0.15) return;

          const priceNoFlight = Math.round(basePrice * f.factor * (1 + wobble));
          const flightSurcharge = 220 + ((counter + i) % 3) * 40;

          fares.push({
            code: f.code,
            name: f.name,
            cabinType: f.cabinType,
            priceEur: priceNoFlight,
            currency: 'EUR',
            withFlight: false,
          });
          fares.push({
            code: f.code,
            name: f.name,
            cabinType: f.cabinType,
            priceEur: priceNoFlight + flightSurcharge,
            currency: 'EUR',
            withFlight: true,
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
          raw: { mock: true },
          fares,
        });
      }
    }
  }

  return cruises;
}

module.exports = { generate };
