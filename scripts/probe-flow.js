/* Try a full flow: homepage → search → click a cruise → cabin page.
 * Maybe Akamai needs us to look like a real session.
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'de-DE', timezoneId: 'Europe/Berlin',
    viewport: { width: 1366, height: 900 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();

  console.log('--- step 1: homepage ---');
  const r1 = await page.goto('https://aida.de/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('  status:', r1.status(), 'title:', await page.title());

  await page.waitForTimeout(3000);

  console.log('--- step 2: /finden ---');
  const r2 = await page.goto('https://aida.de/finden', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('  status:', r2.status(), 'title:', await page.title());

  await page.waitForTimeout(3000);

  console.log('--- step 3: cabin URL ---');
  const r3 = await page.goto('https://aida.de/buchen/CO07260529/CLASSIC/meine-reise/kabine?adults=2', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('  status:', r3.status(), 'title:', await page.title());
  const html = await page.content();
  console.log('  body length:', html.length);
  console.log('  body head:', html.slice(0, 400).replace(/\s+/g, ' '));

  // Check what cookies we have at this point (Akamai sets _abck etc.)
  const cookies = await ctx.cookies();
  console.log('\nCookies on aida.de:');
  for (const c of cookies.filter((c) => c.domain.includes('aida'))) {
    console.log(`  ${c.name} = ${c.value.slice(0, 60)}…`);
  }
  await browser.close();
})();
