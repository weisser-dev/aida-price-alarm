const config = require('../config');
const mockData = require('./mockCruises');

/**
 * Fetches the current cruise catalogue from AIDA and returns a normalised list
 * of cruises with their fares.
 *
 * The real AIDA site does not expose a stable public API. The endpoint used by
 * their "Reisefinder" returns JSON that looks roughly like the structure parsed
 * below. If the response shape changes, only this file needs to be updated -
 * the rest of the system consumes the normalised structure produced here.
 *
 * Each returned item has the shape:
 *   {
 *     id, title, ship, destination, departurePort, arrivalPort,
 *     departsAt, returnsAt, durationNights, url, raw,
 *     fares: [{ code, name, cabinType, priceEur, currency }]
 *   }
 */
async function fetchCruises() {
  if (config.scrape.useMock || !config.scrape.apiUrl) {
    return mockData.generate();
  }

  const res = await fetch(config.scrape.apiUrl, {
    headers: {
      'User-Agent': config.scrape.userAgent,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`AIDA endpoint returned ${res.status} ${res.statusText}`);
  }

  const payload = await res.json();
  return normaliseAidaResponse(payload);
}

function normaliseAidaResponse(payload) {
  const items = Array.isArray(payload) ? payload : payload.cruises || payload.items || [];

  return items
    .map((c) => {
      const id = String(c.id || c.cruiseId || c.code || '').trim();
      if (!id) return null;

      const fares = (c.fares || c.prices || []).map((f) => ({
        code: String(f.code || f.id || f.fareCode || 'STD'),
        name: f.name || f.label || f.title || null,
        cabinType: f.cabinType || f.cabin || null,
        priceEur: Number(f.priceEur ?? f.price ?? f.amount ?? 0),
        currency: f.currency || 'EUR',
      })).filter((f) => Number.isFinite(f.priceEur) && f.priceEur > 0);

      return {
        id,
        title: c.title || c.name || `AIDA ${id}`,
        ship: c.ship || c.shipName || null,
        destination: c.destination || c.area || c.region || null,
        departurePort: c.departurePort || c.embarkationPort || null,
        arrivalPort: c.arrivalPort || c.disembarkationPort || null,
        departsAt: c.departsAt || c.departureDate || c.from || null,
        returnsAt: c.returnsAt || c.returnDate || c.to || null,
        durationNights: c.durationNights ?? c.nights ?? null,
        url: c.url || c.detailUrl || null,
        raw: c,
        fares,
      };
    })
    .filter(Boolean);
}

module.exports = { fetchCruises, normaliseAidaResponse };
