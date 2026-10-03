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

// AIDA's search.cruise.json behaves oddly: the `region` parameter is silently
// ignored (every region returns the exact same global top-N route set), and
// `size` is server-side capped at 20 regardless of what we send. The only
// filter that actually narrows results is `ship`. Iterating ships is what
// gives us a reasonably complete catalogue; iterating regions does nothing
// useful.
const SHIP_CODES = ['BE', 'BL', 'CO', 'DI', 'LU', 'MA', 'NO', 'PE', 'PR', 'SO', 'ST'];

const SHIP_NAMES = {
  BE: 'AIDAbella',
  BL: 'AIDAblu',
  CO: 'AIDAcosma',
  DI: 'AIDAdiva',
  LU: 'AIDAluna',
  MA: 'AIDAmar',
  NO: 'AIDAnova',
  PE: 'AIDAperla',
  PR: 'AIDAprima',
  SO: 'AIDAsol',
  ST: 'AIDAstella',
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
 * Iterates every ship, paginates the search, and yields normalised routes
 * ship-by-ship so the caller can persist partial progress.
 *
 *   for await (const { ship, shipName, routes, error } of streamCatalog())
 *
 * On a per-ship error (e.g. Akamai blocks) we yield it and continue with
 * the next ship instead of aborting the whole scrape.
 *
 * We also yield the same chunk shape under `region`/`regionName` keys for
 * backwards compatibility with the persistence layer that consumed the old
 * region-based stream — the `region` field on each route now carries the
 * region name pulled out of `routeGroupCode` (e.g. "Spanien, Italien & ..."
 * → kept as-is; AIDA does not return a separate region label for ship-only
 * queries).
 */
async function* streamCatalog({ adults = 2, log = console, pauseMs = 900, shipPauseMs = 3000 } = {}) {
  // Randomise ship order so a daily run that gets cut off doesn't always
  // miss the same ships.
  const shipOrder = [...SHIP_CODES].sort(() => Math.random() - 0.5);

  for (let shipIdx = 0; shipIdx < shipOrder.length; shipIdx++) {
    const ship = shipOrder[shipIdx];
    const shipName = SHIP_NAMES[ship] || ship;
    const merged = new Map();
    let shipError = null;

    try {
      // Fresh cookie per ship keeps Akamai sessions short and isolates
      // problems: a failure in one ship doesn't poison the next.
      await ensureCookie(true);
      if (shipIdx > 0) await sleep(shipPauseMs);

      let page = 1, totalPages = 1, retried = false;
      do {
        const data = await aidaJson(SEARCH_PATH, {
          ship, p: page, size: 20,
          sortCriteria: 'DepartureDate', sortDirection: 'Asc',
          adults,
        });
        totalPages = Number(data.totalPages || 1);
        const items = Array.isArray(data.cruiseItems) ? data.cruiseItems : [];

        // Akamai often answers "200 OK with empty cruiseItems" instead of
        // an error after the bot detection kicks in. Detect this on page 1
        // and retry once with a fresh cookie before giving up on the ship.
        if (page === 1 && totalPages === 1 && items.length === 0 && !retried) {
          log.warn?.(`[scrape] ship=${ship} returned empty page 1, retrying with fresh cookie`);
          retried = true;
          await ensureCookie(true);
          await sleep(1500);
          continue;
        }

        for (const item of items) accumulateRoute(merged, item, null);
        log.info?.(`[scrape] ship=${ship}(${shipName}) page=${page}/${totalPages} items=${items.length}`);
        page += 1;
        await sleep(pauseMs);
      } while (page <= totalPages);

      if (merged.size === 0 && !shipError) {
        shipError = 'empty result (likely Akamai block)';
        log.warn?.(`[scrape] ship=${ship} ended with no routes`);
      }
    } catch (err) {
      shipError = String(err && err.message || err);
      log.warn?.(`[scrape] ship=${ship} failed: ${shipError}`);
    }

    yield {
      // ship-shape (new)
      ship,
      shipName,
      // region-shape (legacy aliases so persistence/error logging keeps working)
      region: ship,
      regionName: shipName,
      routes: [...merged.values()].map((r) => ({
        ...r,
        journeys: [...r.journeys.values()].map((j) => ({
          ...j,
          prices: [...j.prices.values()],
          campaigns: [...j.campaigns.values()],
        })),
      })),
      error: shipError,
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

// Heuristic: AIDA's search.cruise.json doesn't return a region label per
// route when filtered by `ship`, so we derive one from the departure port +
// arrival-port pair. Falls back to null for ports we don't know yet.
const PORT_REGION = {
  // Ostsee
  'KIEL': 'Ostsee', 'WARNEMÜNDE': 'Ostsee', 'WARNEMUENDE': 'Ostsee',
  // Nordeuropa
  'HAMBURG': 'Nordeuropa',
  // westliches Mittelmeer
  'PALMA': 'westliches Mittelmeer', 'MALLORCA': 'westliches Mittelmeer',
  'BARCELONA': 'westliches Mittelmeer',
  'CIVITAVECCHIA': 'westliches Mittelmeer', 'ROM': 'westliches Mittelmeer', 'ROM/CIVITAVECCHIA': 'westliches Mittelmeer',
  // östliches Mittelmeer
  'KORFU': 'östliches Mittelmeer', 'CORFU': 'östliches Mittelmeer',
  'VALLETTA': 'östliches Mittelmeer',
  'ANTALYA': 'östliches Mittelmeer',
  // Kanaren
  'LAS PALMAS': 'Kanaren', 'GRAN CANARIA': 'Kanaren',
  'SANTA CRUZ DE TENERIFFA': 'Kanaren', 'TENERIFFA': 'Kanaren',
  'PUERTO DEL ROSARIO': 'Kanaren', 'FUERTEVENTURA': 'Kanaren',
  // Orient
  'DUBAI': 'Orient', 'ABU DHABI': 'Orient',
  // Karibik
  'LA ROMANA': 'Karibik', 'BRIDGETOWN': 'Karibik',
  'MONTEGO BAY': 'Karibik',
  // Nordamerika
  'NEW YORK': 'Nordamerika', 'NEW YORK CITY': 'Nordamerika',
  // Asien
  'SINGAPUR': 'Asien', 'SINGAPORE': 'Asien',
  'BANGKOK': 'Asien', 'LAEM CHABANG': 'Asien',
  'TOKYO': 'Asien', 'YOKOHAMA': 'Asien', 'SHANGHAI': 'Asien',
  // Indischer Ozean
  'PORT LOUIS': 'Indischer Ozean', 'MAHÉ': 'Indischer Ozean', 'MAHE': 'Indischer Ozean',
  // Afrika
  'KAPSTADT': 'Afrika', 'CAPE TOWN': 'Afrika',
  // Westeuropa
  'LISSABON': 'Westeuropa', 'LISBON': 'Westeuropa',
  // Pacific / Weltreise hubs
  'SYDNEY': 'Weltreise', 'SAN ANTONIO': 'Weltreise',
};

function deriveRegion(departurePort, arrivalPort, durationNights) {
  const norm = (p) => (p ? String(p).trim().toUpperCase() : '');
  const dep = norm(departurePort);
  const arr = norm(arrivalPort);
  const oneWay = dep && arr && dep !== arr;

  // One-way long-distance trips are Transreisen/Weltreise regardless of port.
  if (oneWay && Number(durationNights) >= 14) {
    if (Number(durationNights) >= 60) return 'Weltreise';
    return 'Transreisen';
  }
  return PORT_REGION[dep] || PORT_REGION[arr] || null;
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
  const duration = Number(item.duration) || null;

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
      region: regionName || deriveRegion(departurePort, arrivalPort, duration),
      departurePort,
      arrivalPort,
      durationNights: duration,
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
  SHIP_CODES,
  SHIP_NAMES,
  TARIFF_NAMES,
  // exported for tests / CLI tools
  ensureCookie,
  aidaJson,
};
