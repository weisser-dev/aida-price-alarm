const config = require('../config');
const mockData = require('./mockCruises');

const BASE = 'https://aida.de';
const FILTER_PATH  = '/content/aida-search-and-booking/requests/search.filter.json';
const SEARCH_PATH  = '/content/aida-search-and-booking/requests/search.cruise.json';
const SINGLE_PATH  = '/content/aida-search-and-booking/requests/search.singleCruise.json';

const REGIONS = [
  'VRAD', 'VRAF', 'VRAS', 'VRIO', 'VRKA', 'VRKM', 'VRNA', 'VRNE',
  'VRDU', 'VROS', 'VRTR', 'VRWR', 'VRWE', 'VRWM', 'VROM',
];

const REGION_NAMES = {
  VRAD: 'Adria',
  VRAF: 'Afrika',
  VRAS: 'Asien',
  VRIO: 'Indischer Ozean',
  VRKA: 'Kanaren',
  VRKM: 'Karibik',
  VRNA: 'Nordamerika',
  VRNE: 'Nordeuropa',
  VRDU: 'Orient',
  VROS: 'Ostsee',
  VRTR: 'Transreisen',
  VRWR: 'Weltreise',
  VRWE: 'Westeuropa',
  VRWM: 'westliches Mittelmeer',
  VROM: 'östliches Mittelmeer',
};

const TARIFF_NAMES = {
  LIG:   'LIGHT',
  CLA:   'CLASSIC',
  IND:   'PREMIUM',
  INDAI: 'PREMIUM ALL IN',
  CLAAI: 'CLASSIC ALL IN',
  COMAI: 'COMFORT ALL IN',
  SEE:   'SEETOURS',
  SEEAI: 'SEETOURS ALL IN',
  PAU:   'PAUSCHAL',
  PAUAI: 'PAUSCHAL ALL IN',
};

const BROWSER_HEADERS = {
  'User-Agent': config.scrape.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Referer': `${BASE}/finden`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

const COOKIE_TTL_MS = 25 * 60 * 1000;
let cookieJar = null;
let cookieFetchedAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureCookie(force = false) {
  if (!force && cookieJar && Date.now() - cookieFetchedAt < COOKIE_TTL_MS) return cookieJar;

  const res = await fetch(`${BASE}/finden`, { headers: BROWSER_HEADERS, redirect: 'follow' });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!setCookies.length) {
    throw new Error(`No Set-Cookie returned by aida.de/finden (HTTP ${res.status})`);
  }
  cookieJar = setCookies.map((c) => c.split(';')[0]).join('; ');
  cookieFetchedAt = Date.now();
  return cookieJar;
}

async function aidaJson(pathName, params = {}, { retry = 1 } = {}) {
  const cookie = await ensureCookie();
  const url = new URL(BASE + pathName);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
  if (!res.ok) {
    if (retry > 0 && (res.status === 401 || res.status === 403 || res.status === 429)) {
      await ensureCookie(true);
      await sleep(1000);
      return aidaJson(pathName, params, { retry: retry - 1 });
    }
    throw new Error(`AIDA ${pathName} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchFilterCatalog() {
  return aidaJson(FILTER_PATH, {});
}

/**
 * Iterates every region, paginates the search, and yields normalised routes
 * region-by-region so the caller can persist partial progress.
 *
 *   for await (const { region, regionName, routes, error } of streamCatalog())
 *
 * On a per-region error (e.g. Akamai blocks) we yield it and continue with
 * the next region instead of aborting the whole scrape.
 */
async function* streamCatalog({ adults = 2, log = console, pauseMs = 900 } = {}) {
  for (const region of REGIONS) {
    const regionName = REGION_NAMES[region] || region;
    const merged = new Map();
    let regionError = null;

    try {
      // Fresh cookie per region keeps Akamai sessions short and isolates
      // problems: a failure in one region doesn't poison the next.
      await ensureCookie(true);

      let page = 1, totalPages = 1;
      do {
        const data = await aidaJson(SEARCH_PATH, {
          region, p: page, size: 20,
          sortCriteria: 'DepartureDate', sortDirection: 'Asc',
          adults,
        });
        totalPages = Number(data.totalPages || 1);
        const items = Array.isArray(data.cruiseItems) ? data.cruiseItems : [];
        for (const item of items) accumulateRoute(merged, item, regionName);
        log.info?.(`[scrape] region=${region} page=${page}/${totalPages} items=${items.length}`);
        page += 1;
        await sleep(pauseMs);
      } while (page <= totalPages);
    } catch (err) {
      regionError = String(err && err.message || err);
      log.warn?.(`[scrape] region=${region} failed: ${regionError}`);
    }

    yield {
      region,
      regionName,
      routes: [...merged.values()].map((r) => ({
        ...r,
        journeys: [...r.journeys.values()].map((j) => ({
          ...j,
          prices: [...j.prices.values()],
          campaigns: [...j.campaigns.values()],
        })),
      })),
      error: regionError,
    };
  }
}

async function fetchAllRoutes(options = {}) {
  const all = new Map();
  for await (const chunk of streamCatalog(options)) {
    for (const r of chunk.routes) {
      // Merge journey lists across regions (a route can appear in two)
      const existing = all.get(r.id);
      if (!existing) { all.set(r.id, r); continue; }
      const seen = new Set(existing.journeys.map((j) => j.id));
      for (const j of r.journeys) if (!seen.has(j.id)) existing.journeys.push(j);
    }
  }
  return [...all.values()];
}

function accumulateRoute(map, item, regionName) {
  const variants = Array.isArray(item.cruiseItemVariant) ? item.cruiseItemVariant : [];
  if (!variants.length) return;

  const firstVariant = variants[0];
  const ship = firstVariant.ship || {};
  const id = String(item.yieldRouteCode || item.routeCode || `${ship.code || 'X'}-${item.duration || 0}-${item.startDate || ''}`).trim();
  if (!id) return;

  const ports = Array.isArray(item.ports) ? item.ports : [];
  const departurePort = ports[0]?.name || firstVariant.fromCity || null;
  const arrivalPort   = ports[ports.length - 1]?.name || firstVariant.toCity || null;

  let route = map.get(id);
  if (!route) {
    route = {
      id,
      routeCode: item.routeCode || null,
      yieldCode: item.yieldRouteCode || null,
      routeGroup: item.routeGroupCode || null,
      title: item.title || item.routeGroupCode || `${ship.name || 'AIDA'} ${item.duration || ''}T`,
      shipCode: ship.code || null,
      shipName: ship.name || null,
      region: regionName || null,
      departurePort,
      arrivalPort,
      durationNights: Number(item.duration) || null,
      portsJson: JSON.stringify(ports),
      imageUrl: firstVariant.imageUrl || null,
      journeys: new Map(),
    };
    map.set(id, route);
  }

  for (const v of variants) {
    const jid = String(v.journeyIdentifier || '').trim();
    if (!jid) continue;
    const amount = Number(v.amount);
    const perPerson = Number(v.amountPerPerson);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    let journey = route.journeys.get(jid);
    if (!journey) {
      journey = {
        id: jid,
        shipCode: v.ship?.code || ship.code || null,
        durationNights: Number(v.duration) || route.durationNights,
        departsAt: v.startDate || item.startDate || null,
        returnsAt: v.endDate || item.endDate || null,
        bookingUrl: v.bookingLink ? `${BASE}${v.bookingLink}` : null,
        imageUrl: v.imageUrl || null,
        // Maps so the same (tariff, flight) / campaign code from multiple
        // pages collapses into a single row.
        prices: new Map(),
        campaigns: new Map(),
      };
      route.journeys.set(jid, journey);
    }

    const tariffType = v.tariffType || 'IND';
    const flightIncluded = !!v.flightIncluded;
    const priceKey = `${tariffType}|${flightIncluded ? 1 : 0}`;
    const existing = journey.prices.get(priceKey);
    // Keep the cheapest price seen for the (tariff, flight) combo - AIDA
    // sometimes returns slightly different amounts per page; the lowest
    // matches what the user would actually book.
    if (!existing || amount < existing.amountEur) {
      journey.prices.set(priceKey, {
        tariffType,
        tariffName: TARIFF_NAMES[tariffType] || tariffType || null,
        flightIncluded,
        amountEur: amount,
        perPersonEur: Number.isFinite(perPerson) ? perPerson : Math.round(amount / 2),
        currency: v.currency || '€',
        notes: Array.isArray(v.notes) ? v.notes : [],
      });
    }

    for (const c of (v.campaigns || [])) {
      if (!c.code) continue;
      journey.campaigns.set(c.code, {
        code: c.code,
        name: c.name || null,
        medium: c.medium || null,
        validFrom: c.validity?.bookingDateFrom || null,
        validTo:   c.validity?.bookingDateTo   || null,
      });
    }
  }
}

/** Public entry point used by the scrape pipeline. */
async function fetchCatalog(options = {}) {
  if (config.scrape.useMock) {
    return mockData.generate();
  }
  return fetchAllRoutes(options);
}

module.exports = {
  fetchCatalog,
  fetchFilterCatalog,
  streamCatalog,
  REGIONS,
  REGION_NAMES,
  TARIFF_NAMES,
  // exported for tests / CLI tools
  ensureCookie,
  aidaJson,
};
