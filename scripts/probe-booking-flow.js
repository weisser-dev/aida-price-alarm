/* Probe: What does the booking flow page load? Look for cabin-pricing endpoints.
 * Strategy:
 *   1) Fetch the /buchen/{jid}/{TARIFF}/meine-reise/kabine HTML
 *   2) Scan for any URLs/endpoints referenced in <script>, <link>, data-* attrs
 *   3) Try common candidate JSON paths to discover the cabin pricing endpoint
 */
const { ensureCookie } = require('../src/services/aidaAdapter');

const BASE = 'https://aida.de';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Referer': `${BASE}/finden`,
};
const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Referer': `${BASE}/finden`,
};

async function fetchText(url, cookie, accept = 'html') {
  const headers = accept === 'json' ? { ...HEADERS_JSON } : { ...HEADERS_HTML };
  headers.Cookie = cookie;
  const res = await fetch(url, { headers });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, contentType: ct, text };
}

(async () => {
  const cookie = await ensureCookie(true);
  // The user's example journey
  const jid = 'CO07260529';
  const url = `${BASE}/buchen/${jid}/CLASSIC/meine-reise/kabine?adults=2&juveniles=0&children=0&babies=0&cabin=K`;
  console.log(`\n=== 1. Fetching booking HTML: ${url} ===`);
  const { status, contentType, text } = await fetchText(url, cookie, 'html');
  console.log(`HTTP ${status} content-type=${contentType} bytes=${text.length}`);

  // Look for endpoint hints
  console.log('\n=== 2. Scan HTML for endpoint hints ===');
  const patterns = [
    /\/content\/aida-search-and-booking\/requests\/[a-zA-Z.]+\.json/g,
    /requests\/[a-zA-Z.]+\.json/g,
    /\/api\/[a-zA-Z\/.\-]+/g,
    /cabin[A-Za-z]*\.json/g,
  ];
  const seen = new Set();
  for (const p of patterns) {
    const matches = text.match(p) || [];
    for (const m of matches) seen.add(m);
  }
  for (const s of [...seen].sort()) console.log('  found:', s);

  // The HTML probably has data-vue-app or data-booking-state or window.__INITIAL_STATE__
  console.log('\n=== 3. Searching for inline JSON state blobs ===');
  const initialMatch = text.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});/);
  if (initialMatch) {
    console.log('  __INITIAL_STATE__ first 500 chars:', initialMatch[1].slice(0, 500));
  } else {
    console.log('  no __INITIAL_STATE__ found');
  }

  // Also extract any data-* attribute that looks JSON-like
  console.log('\n=== 4. Searching for data-config/data-state/data-props ===');
  const dataAttrMatches = text.match(/data-(config|state|props|json|booking)="[^"]+"/g) || [];
  for (const m of dataAttrMatches.slice(0, 5)) console.log('  ', m.slice(0, 200));

  console.log('\n=== 5. Try candidate endpoints ===');
  const candidates = [
    `/content/aida-search-and-booking/requests/cabinPrice.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabin.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabinTypes.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabinSelection.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabinList.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabinAvailability.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabinprice.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/getCabin.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cabin.search.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/booking.cabin.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/checkAvailability.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/availability.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/prices.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/price.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/details.cruise.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
    `/content/aida-search-and-booking/requests/cruise.detail.json?journeyIdentifier=${jid}&tariffType=CLA&adults=2`,
  ];
  for (const path of candidates) {
    await sleep(700);
    try {
      const r = await fetchText(`${BASE}${path}`, cookie, 'json');
      const preview = r.text.slice(0, 120).replace(/\s+/g, ' ');
      console.log(`  ${r.status} ${path.split('?')[0].split('/').pop()} :: ${preview}`);
    } catch (e) {
      console.log(`  ERR  ${path}: ${e.message}`);
    }
  }
})();
