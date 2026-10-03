/* Probe: booking.proxy.json and detail.content.json — what params, what shape? */
const { ensureCookie } = require('../src/services/aidaAdapter');

const BASE = 'https://aida.de';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Referer': `${BASE}/finden`,
};

async function tryGet(label, path) {
  await sleep(500);
  try {
    const cookie = await ensureCookie(false);
    const res = await fetch(BASE + path, { headers: { ...HEADERS, Cookie: cookie } });
    const text = await res.text();
    console.log(`\n[${label}] ${res.status} ${path}`);
    console.log('  ', text.slice(0, 800).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message}`);
  }
}

async function tryPost(label, path, body) {
  await sleep(500);
  try {
    const cookie = await ensureCookie(false);
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { ...HEADERS, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n[${label}] POST ${res.status} ${path}`);
    console.log('  body:', JSON.stringify(body));
    console.log('  resp:', text.slice(0, 1200).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message}`);
  }
}

(async () => {
  await ensureCookie(true);

  const jid = 'CO07260529';
  const yrc = 'PMI07260';

  // Try various GET shapes for booking.proxy.json
  await tryGet('proxy-empty', '/content/aida-search-and-booking/requests/booking.proxy.json');
  await tryGet('proxy-jid', `/content/aida-search-and-booking/requests/booking.proxy.json?journeyIdentifier=${jid}`);
  await tryGet('proxy-jid-cla', `/content/aida-search-and-booking/requests/booking.proxy.json?journeyIdentifier=${jid}&tariffType=CLA`);
  await tryGet('proxy-jid-action-cabin', `/content/aida-search-and-booking/requests/booking.proxy.json?journeyIdentifier=${jid}&tariffType=CLA&action=cabin`);
  await tryGet('proxy-action', `/content/aida-search-and-booking/requests/booking.proxy.json?action=cabin&journeyIdentifier=${jid}`);

  await tryGet('detail-empty', '/content/aida-search-and-booking/requests/detail.content.json');
  await tryGet('detail-jid', `/content/aida-search-and-booking/requests/detail.content.json?journeyIdentifier=${jid}`);
  await tryGet('detail-jid-cla', `/content/aida-search-and-booking/requests/detail.content.json?journeyIdentifier=${jid}&tariffType=CLA`);
  await tryGet('detail-yrc', `/content/aida-search-and-booking/requests/detail.content.json?yieldRouteCode=${yrc}`);

  // Also try POST
  await tryPost('proxy-post-empty', '/content/aida-search-and-booking/requests/booking.proxy.json', {});
  await tryPost('proxy-post-jid', '/content/aida-search-and-booking/requests/booking.proxy.json', {
    journeyIdentifier: jid, tariffType: 'CLA', adults: 2,
  });
  await tryPost('proxy-post-cabin', '/content/aida-search-and-booking/requests/booking.proxy.json', {
    journeyIdentifier: jid, tariffType: 'CLA', adults: 2, action: 'cabin', step: 'cabin',
  });
  await tryPost('proxy-post-getCabins', '/content/aida-search-and-booking/requests/booking.proxy.json', {
    method: 'getCabins', journeyIdentifier: jid, tariffType: 'CLA', adults: 2,
  });
})();
