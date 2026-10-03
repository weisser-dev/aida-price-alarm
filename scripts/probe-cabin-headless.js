/* Phase B proof-of-concept: drive the AIDA cabin selection page in a real
 * browser, wait for the cabin list to render, and dump every cabin code +
 * price we can find. Try a few selector strategies so we learn the DOM.
 *
 * Run: node scripts/probe-cabin-headless.js [journeyId] [tariff]
 *      defaults: CO07260529 / CLASSIC
 */
const { chromium } = require('playwright');

const JID = process.argv[2] || 'CO07260529';
const TARIFF = process.argv[3] || 'CLASSIC';
const URL = `https://aida.de/buchen/${JID}/${TARIFF}/meine-reise/kabine?adults=2&juveniles=0&children=0&babies=0`;

(async () => {
  console.log(`URL: ${URL}\n`);
  // Use the full chromium build (NOT headless-shell) so user-agent and
  // browser-feature surface look like a real browser to Akamai.
  const browser = await chromium.launch({
    headless: true,
    channel: undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    },
  });
  // Hide navigator.webdriver — primary Akamai bot tell.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();

  // Warm-up: hit the homepage first so Akamai issues us cookies in the same
  // way a normal user would arrive.
  console.log('Warming up cookies via /finden…');
  try { await page.goto('https://aida.de/finden', { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
  await page.waitForTimeout(1500);

  // Capture all XHR/fetch responses so we know which JSON endpoints feed
  // the cabin section (might let us bypass the browser later).
  const apiResponses = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    const ct = (resp.headers()['content-type'] || '');
    if (ct.includes('json') && /aida-search-and-booking|booking|cabin/i.test(url)) {
      try {
        const body = await resp.text();
        apiResponses.push({ url, status: resp.status(), bodyHead: body.slice(0, 800) });
      } catch (_) { /* ignore */ }
    }
  });

  console.log('Navigating…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Click cookie consent if it appears
  try {
    const consentBtn = page.locator('button:has-text("Akzeptieren"), button:has-text("Alle akzeptieren"), [data-testid="uc-accept-all-button"]').first();
    if (await consentBtn.isVisible({ timeout: 3000 })) {
      console.log('Clicking cookie consent…');
      await consentBtn.click({ timeout: 2000 });
    }
  } catch (_) {}

  // Wait for "something cabin-related" to render — try several selectors
  console.log('Waiting for cabin content…');
  const candidates = [
    '[data-testid*="cabin" i]',
    '[class*="cabin" i]',
    '[class*="kabine" i]',
    '.price', '[data-test*="price"]',
  ];
  let found = null;
  for (const sel of candidates) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      found = sel;
      break;
    } catch (_) { /* try next */ }
  }
  console.log('First match:', found || '(none)');

  // Give the SPA a moment to settle once it starts rendering
  await page.waitForTimeout(4000);

  // Dump page title + URL after redirects
  console.log('\nPage title:', await page.title());
  console.log('Final URL :', page.url());

  // Try to extract cabin entries: heuristic — every distinct block that
  // contains a € price and a cabin label.
  const cabins = await page.evaluate(() => {
    const out = [];
    const text = (n) => (n?.innerText || '').trim();
    // Search for elements containing a € amount
    const all = document.querySelectorAll('article, section, li, div');
    for (const el of all) {
      const t = text(el);
      if (!t) continue;
      if (!/€/.test(t)) continue;
      if (t.length > 600) continue;
      // Try to identify cabin labels (Innen, Außen, Balkon, Suite, …)
      const m = t.match(/(Innen|Aussen|Außen|Meerblick|Balkon|Veranda|Suite|Premium-Suite|Deluxe|Komfort|Junior|Patio|Family)[^\n]{0,80}/i);
      if (!m) continue;
      const priceMatch = t.match(/[\d.]+\s?€/g);
      out.push({
        cabin: m[0].trim().slice(0, 80),
        text: t.slice(0, 220).replace(/\s+/g, ' '),
        prices: priceMatch ? priceMatch.slice(0, 3) : null,
        rect: { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height },
      });
    }
    return out;
  });

  console.log(`\nFound ${cabins.length} candidate cabin blocks. First 15:\n`);
  for (const c of cabins.slice(0, 15)) {
    console.log(`  [${c.cabin}] prices=${c.prices ? c.prices.join(',') : '–'}`);
    console.log(`    text: ${c.text}`);
  }

  // Save the rendered HTML for offline inspection
  const html = await page.content();
  require('fs').writeFileSync('/tmp/aida-cabin-dump.html', html);
  console.log(`\nFull HTML saved to /tmp/aida-cabin-dump.html (${html.length} bytes)`);

  console.log(`\nCaptured ${apiResponses.length} XHR(s) hit cabin endpoints:`);
  for (const r of apiResponses) {
    console.log(`  ${r.status} ${r.url}`);
    console.log(`    ${r.bodyHead.replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  await browser.close();
})();
