/**
 * Deterministic mock catalogue mirroring the structure of the real AIDA API:
 * routes, each with multiple journeys, each with multiple tariff variants
 * (with/without flight) and occasional campaigns. Prices wobble slightly per
 * day so the watch/notify path is exercised on a real schedule.
 *
 * Cabin granularity is intentionally absent here because AIDA's
 * detail.cruise.json (the only place cabins live) is currently 503 in prod.
 * Tariff types act as the primary price differentiator until that endpoint
 * comes back.
 */

const SHIPS = [
  { code: 'BE', name: 'AIDAbella' },
  { code: 'BL', name: 'AIDAblu' },
  { code: 'CO', name: 'AIDAcosma' },
  { code: 'DI', name: 'AIDAdiva' },
  { code: 'LU', name: 'AIDAluna' },
  { code: 'MA', name: 'AIDAmar' },
  { code: 'NO', name: 'AIDAnova' },
  { code: 'PE', name: 'AIDAperla' },
  { code: 'PR', name: 'AIDAprima' },
  { code: 'SO', name: 'AIDAsol' },
  { code: 'ST', name: 'AIDAstella' },
];

const REGIONS = [
  { name: 'Adria',                  ports: ['Venedig', 'Korfu'] },
  { name: 'Afrika',                 ports: ['Casablanca', 'Kapstadt'] },
  { name: 'Asien',                  ports: ['Singapur', 'Bangkok'] },
  { name: 'Indischer Ozean',        ports: ['Mauritius', 'Mahé'] },
  { name: 'Kanaren',                ports: ['Gran Canaria', 'Teneriffa'] },
  { name: 'Karibik',                ports: ['La Romana', 'Bridgetown'] },
  { name: 'Nordamerika',            ports: ['New York', 'Boston'] },
  { name: 'Nordeuropa',             ports: ['Hamburg', 'Bergen'] },
  { name: 'Orient',                 ports: ['Dubai', 'Abu Dhabi'] },
  { name: 'Ostsee',                 ports: ['Warnemünde', 'Kopenhagen'] },
  { name: 'Transreisen',            ports: ['Hamburg', 'Gran Canaria'] },
  { name: 'Weltreise',              ports: ['Hamburg', 'Sydney'] },
  { name: 'Westeuropa',             ports: ['Hamburg', 'Lissabon'] },
  { name: 'westliches Mittelmeer',  ports: ['Mallorca', 'Barcelona'] },
  { name: 'östliches Mittelmeer',   ports: ['Korfu', 'Athen'] },
];

const TARIFFS = [
  { code: 'LIG',   name: 'LIGHT',           factor: 0.85, flight: false },
  { code: 'CLA',   name: 'CLASSIC',         factor: 1.00, flight: false },
  { code: 'IND',   name: 'PREMIUM',         factor: 1.20, flight: false },
  { code: 'CLAAI', name: 'CLASSIC ALL IN',  factor: 1.45, flight: false },
  { code: 'PAU',   name: 'PAUSCHAL',        factor: 1.30, flight: true  },
  { code: 'PAUAI', name: 'PAUSCHAL ALL IN', factor: 1.65, flight: true  },
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
  const routes = [];
  let counter = 0;

  for (let s = 0; s < SHIPS.length; s++) {
    for (let a = 0; a < REGIONS.length; a++) {
      // Only ~55 % of (ship, region) combos sail (still plenty).
      if (seeded(s * 31 + a * 17) > 0.55) continue;
      counter += 1;

      const ship = SHIPS[s];
      const region = REGIONS[a];
      const nights = 7 + ((s + a) % 3) * 7; // 7, 14, 21
      const fromPort = region.ports[0];
      const toPort = region.ports[region.ports.length - 1];
      const isOneWay = region.name === 'Transreisen' || region.name === 'Weltreise';
      const arrivalPort = isOneWay ? toPort : fromPort;
      const routeId = `MOCK-${ship.code}${String(nights).padStart(2, '0')}-${region.name.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase()}-${counter}`;

      // 6-9 departures across the next 18 months
      const numDepartures = 6 + (counter % 4);
      const journeys = [];
      const baseDeparture = new Date();
      // Region/route-specific phase offset so multiple routes of the same
      // ship don't collide on the same calendar date in the mock.
      baseDeparture.setUTCDate(baseDeparture.getUTCDate() + 30 + (counter * 5));
      for (let d = 0; d < numDepartures; d++) {
        const departs = new Date(baseDeparture);
        departs.setUTCDate(departs.getUTCDate() + d * (14 + (d % 2) * 7));
        const returns = new Date(departs);
        returns.setUTCDate(returns.getUTCDate() + nights);
        const yyMMdd = `${String(departs.getUTCFullYear()).slice(-2)}${String(departs.getUTCMonth() + 1).padStart(2, '0')}${String(departs.getUTCDate()).padStart(2, '0')}`;
        // Include a route-counter byte so jids are unique even when the same
        // ship/duration would otherwise repeat on the same date.
        const jid = `${ship.code}${String(nights).padStart(2, '0')}${yyMMdd}M${counter.toString(36).padStart(2, '0').toUpperCase()}`;

        const basePrice = 700 + ((s * 7 + a * 11 + d * 13) % 9) * 90 + nights * 25;
        const wobble = (seeded(bucket + counter * 100 + d) - 0.5) * 0.18;

        const prices = [];
        for (const t of TARIFFS) {
          // Random availability per (journey, tariff): ~80%
          if (seeded(counter * 50 + d * 7 + t.code.length) < 0.20) continue;
          const amount = Math.round(basePrice * t.factor * (1 + wobble) * 2); // total for 2 adults
          prices.push({
            tariffType: t.code,
            tariffName: t.name,
            flightIncluded: t.flight,
            amountEur: amount,
            perPersonEur: Math.round(amount / 2),
            currency: '€',
            notes: t.code === 'IND' && d < 3 ? ['Frühbucher Plus'] : [],
          });
        }
        if (!prices.length) continue;

        // Random Last-Minute campaign for journeys departing within 60 days
        const daysToDeparture = Math.round((departs - Date.now()) / 86400000);
        const campaigns = [];
        if (daysToDeparture > 0 && daysToDeparture <= 60 && seeded(counter * 7 + d) > 0.5) {
          const validFrom = new Date(); validFrom.setUTCDate(validFrom.getUTCDate() - 3);
          const validTo = new Date();   validTo.setUTCDate(validTo.getUTCDate() + 14);
          campaigns.push({
            code: `LMV-${jid}`,
            name: 'Last Minute',
            medium: 'Last Minute',
            validFrom: validFrom.toISOString().slice(0, 10),
            validTo:   validTo.toISOString().slice(0, 10),
          });
        } else if (daysToDeparture > 240 && seeded(counter * 11 + d) > 0.65) {
          const validFrom = new Date(); validFrom.setUTCDate(validFrom.getUTCDate() - 5);
          const validTo = new Date();   validTo.setUTCDate(validTo.getUTCDate() + 30);
          campaigns.push({
            code: `FBP-${jid}`,
            name: 'Frühbucher Plus',
            medium: 'Frühbucher',
            validFrom: validFrom.toISOString().slice(0, 10),
            validTo:   validTo.toISOString().slice(0, 10),
          });
        }

        journeys.push({
          id: jid,
          shipCode: ship.code,
          durationNights: nights,
          departsAt: departs.toISOString().slice(0, 10),
          returnsAt: returns.toISOString().slice(0, 10),
          bookingUrl: `https://www.aida.de/${jid}/PREMIUM/meine-reise/reisende?adults=2`,
          imageUrl: null,
          prices,
          campaigns,
        });
      }

      if (!journeys.length) continue;

      routes.push({
        id: routeId,
        routeCode: `${fromPort.slice(0, 3).toUpperCase()}${(toPort || fromPort).slice(0, 3).toUpperCase()}${nights}`,
        yieldCode: routeId,
        routeGroup: `${region.name} ab ${fromPort}`,
        title: `${nights} Nächte ${region.name} mit ${ship.name}`,
        shipCode: ship.code,
        shipName: ship.name,
        region: region.name,
        departurePort: fromPort,
        arrivalPort,
        durationNights: nights,
        portsJson: JSON.stringify(region.ports.map((p) => ({ code: null, name: p }))),
        imageUrl: null,
        journeys,
      });
    }
  }

  return routes;
}

module.exports = { generate };
