/* Try Bewo content-wrapped payloads. The 400 error revealed the type
 * `Bewo.DRV.String.StringMessageRequestType` and StackTrace shows
 * GetStringRequestContent — implying a `Content` field with the request XML.
 */
const { ensureCookie } = require('../src/services/aidaAdapter');
const BASE = 'https://aida.de';
const PATH = '/content/aida-search-and-booking/requests/booking.proxy.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = (cookie) => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Referer': `${BASE}/buchen/CO07260529/CLASSIC/meine-reise/kabine`,
  'Content-Type': 'application/json',
  Cookie: cookie,
});

async function tryPost(label, body) {
  await sleep(700);
  try {
    const cookie = await ensureCookie(false);
    const res = await fetch(BASE + PATH, { method: 'POST', headers: HEADERS(cookie), body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`\n[${label}] ${res.status}`);
    console.log('  body:', JSON.stringify(body).slice(0, 250));
    console.log('  resp:', text.slice(0, 500).replace(/\s+/g, ' '));
  } catch (e) { console.log(`[${label}] ERROR:`, e.message); }
}

(async () => {
  await ensureCookie(true);

  // Bewo XML payloads — try various tour-operator XML formats
  const xmlPayload = '<TourOperator code="AIDA"/><JourneyIdentifier>CO07260529</JourneyIdentifier><TariffType code="CLA"/><Adults>2</Adults>';
  const xmlFull = `<?xml version="1.0" encoding="UTF-8"?><BookingRequest tourOperatorCode="AIDA"><Journey id="CO07260529"/><Tariff code="CLA"/><Travelers adults="2"/></BookingRequest>`;
  const xmlAida = `<?xml version="1.0" encoding="UTF-8"?><AIDA><TourOperator>AIDA</TourOperator><JourneyIdentifier>CO07260529</JourneyIdentifier><TariffType>CLA</TariffType><Adults>2</Adults></AIDA>`;
  const xmlBewo = `<?xml version="1.0" encoding="UTF-8"?><Request><Header><TourOperatorCode>AIDA</TourOperatorCode></Header><Body><JourneyIdentifier>CO07260529</JourneyIdentifier><TariffType>CLA</TariffType><Adults>2</Adults></Body></Request>`;

  // Content wrapping
  await tryPost('content-xml',     { Content: xmlFull });
  await tryPost('content-aida',    { Content: xmlAida });
  await tryPost('content-bewo',    { Content: xmlBewo });
  await tryPost('content-stringMsg', { stringMessageRequest: { Content: xmlFull } });
  await tryPost('content-msgRequest', { messageRequest: { Content: xmlFull } });

  // Lowercase
  await tryPost('content-lowercase', { content: xmlFull });

  // Maybe Content takes JSON-stringified payload instead of XML
  await tryPost('content-json-str', { Content: JSON.stringify({ tourOperatorCode: 'AIDA', journeyIdentifier: 'CO07260529', tariffType: 'CLA', adults: 2 }) });

  // Maybe Action field hints what we're calling
  await tryPost('content+action', {
    Content: xmlFull,
    Action: 'cabinPrice',
  });
})();
