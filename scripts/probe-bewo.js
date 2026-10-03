/* Try various Bewo StringMessageRequestType shapes against booking.proxy.json
 * The error said:
 *   GetTourOperatorCode(StringMessageRequestType stringMessageRequest)
 * which suggests the payload wraps a string message, possibly XML.
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
    console.log('  body:', JSON.stringify(body).slice(0, 200));
    console.log('  resp:', text.slice(0, 500).replace(/\s+/g, ' '));
  } catch (e) { console.log(`[${label}] ERROR:`, e.message); }
}

(async () => {
  await ensureCookie(true);

  const jid = 'CO07260529';

  // Bewo XML wrapper guess
  const xml1 = `<RequestMessage><JourneyIdentifier>${jid}</JourneyIdentifier><TourOperator>AIDA</TourOperator><TariffType>CLA</TariffType><Adults>2</Adults></RequestMessage>`;
  await tryPost('xml-string-1', { stringMessageRequest: xml1 });
  await tryPost('xml-string-2', { stringMessage: xml1 });
  await tryPost('xml-string-3', { Message: xml1 });
  await tryPost('xml-direct-string', xml1);  // string body, may need other CT

  // Wrapped object guesses
  await tryPost('shape-1', { stringMessageRequest: { tourOperatorCode: 'AIDA', journeyIdentifier: jid, tariffType: 'CLA' } });
  await tryPost('shape-2', { tourOperatorCode: 'AIDA', journeyIdentifier: jid, tariffType: 'CLA', adults: 2 });
  await tryPost('shape-3', { request: { tourOperatorCode: 'AIDA', journeyIdentifier: jid, tariffType: 'CLA' } });
})();
