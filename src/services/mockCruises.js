/**
 * Deterministic, slightly-fluctuating sample data so the system is fully
 * usable without a live AIDA endpoint. Prices wobble day-to-day so the
 * notification path is exercised on a real schedule.
 */

const SHIPS = ['AIDAprima', 'AIDAcosma', 'AIDAnova', 'AIDAperla', 'AIDAblu'];
const AREAS = [
  { name: 'Mittelmeer', from: 'Mallorca', to: 'Mallorca' },
  { name: 'Nordland', from: 'Hamburg', to: 'Hamburg' },
  { name: 'Karibik', from: 'La Romana', to: 'La Romana' },
  { name: 'Kanaren', from: 'Gran Canaria', to: 'Gran Canaria' },
  { name: 'Orient', from: 'Dubai', to: 'Dubai' },
];
const FARES = [
  { code: 'JUST', name: 'Just AIDA', cabinType: 'Innen' },
  { code: 'VARIO', name: 'VARIO', cabinType: 'Aussen' },
  { code: 'PREMIUM_BALKON', name: 'PREMIUM', cabinType: 'Balkon' },
  { code: 'PREMIUM_SUITE', name: 'PREMIUM', cabinType: 'Suite' },
];

function seeded(n) {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

function todayBucket() {
  // A bucket value that changes once per day so prices wobble between days.
  const d = new Date();
  return d.getUTCFullYear() * 1000 + (d.getUTCMonth() + 1) * 50 + d.getUTCDate();
}

function generate() {
  const bucket = todayBucket();
  const cruises = [];
  let counter = 0;

  for (let s = 0; s < SHIPS.length; s++) {
    for (let a = 0; a < AREAS.length; a++) {
      for (let r = 0; r < 2; r++) {
        counter += 1;
        const id = `MOCK-${SHIPS[s].slice(4, 8).toUpperCase()}-${AREAS[a].name.slice(0, 3).toUpperCase()}-${r + 1}`;
        const nights = 7 + ((s + a + r) % 3) * 7;
        const departs = new Date();
        departs.setUTCDate(departs.getUTCDate() + 30 + counter * 3);
        const returns = new Date(departs);
        returns.setUTCDate(returns.getUTCDate() + nights);

        const basePrice = 600 + ((s * 7 + a * 11 + r * 13) % 9) * 120 + nights * 25;
        const wobble = (seeded(bucket + counter) - 0.5) * 0.18;

        const fares = FARES.map((f, i) => {
          const factor = 1 + i * 0.35;
          return {
            code: f.code,
            name: f.name,
            cabinType: f.cabinType,
            priceEur: Math.round(basePrice * factor * (1 + wobble)),
            currency: 'EUR',
          };
        });

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
