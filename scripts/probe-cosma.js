/* Diagnostic: query AIDA for AIDAcosma to see what unique routes exist
 * - tries with `ship=CO` (no region)
 * - then iterates all regions with the same ship filter
 * - reports unique yieldRouteCodes per region and overall
 */
const { aidaJson, ensureCookie, REGIONS, REGION_NAMES } = require('../src/services/aidaAdapter');

const SEARCH_PATH = '/content/aida-search-and-booking/requests/search.cruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ensureCookie(true);

  console.log('\n=== Test 1: ship=CO without region ===');
  try {
    const data = await aidaJson(SEARCH_PATH, {
      ship: 'CO', p: 1, size: 20,
      sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2,
    });
    console.log(`totalPages=${data.totalPages} totalItems=${data.totalItems} pageItems=${(data.cruiseItems||[]).length}`);
    const seen = new Map();
    for (const item of data.cruiseItems || []) {
      const yrc = item.yieldRouteCode;
      if (!seen.has(yrc)) seen.set(yrc, item);
    }
    for (const [yrc, item] of seen) {
      console.log(`  yield=${yrc} route=${item.routeCode} group=${item.routeGroupCode} dur=${item.duration} title=${(item.title||'').slice(0,60)} variants=${(item.cruiseItemVariant||[]).length}`);
    }
    console.log(`Unique yieldRouteCodes on page 1: ${seen.size}`);
  } catch (e) {
    console.log('  ERROR:', e.message);
  }

  console.log('\n=== Test 2: per region with ship=CO filter ===');
  const allRoutes = new Map();
  for (const region of REGIONS) {
    await sleep(1500);
    try {
      const data = await aidaJson(SEARCH_PATH, {
        region, ship: 'CO', p: 1, size: 20,
        sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2,
      });
      const items = data.cruiseItems || [];
      const uniq = new Set(items.map((i) => i.yieldRouteCode));
      console.log(`  region=${region}(${REGION_NAMES[region]}) totalPages=${data.totalPages} totalItems=${data.totalItems} pageItems=${items.length} uniqueYRC=${uniq.size}`);
      for (const item of items) {
        const yrc = item.yieldRouteCode;
        if (!allRoutes.has(yrc)) allRoutes.set(yrc, { ...item, _seenIn: [region] });
        else allRoutes.get(yrc)._seenIn.push(region);
      }
    } catch (e) {
      console.log(`  region=${region}: ERROR ${e.message}`);
    }
  }
  console.log(`\n=== UNIQUE Cosma routes across all regions (page 1 each): ${allRoutes.size} ===`);
  for (const [yrc, item] of allRoutes) {
    console.log(`  yield=${yrc} dur=${item.duration} title=${(item.title||'').slice(0,70)} regions=${item._seenIn.join(',')}`);
  }

  console.log('\n=== Test 3: full pagination for region without ship filter (Kanaren) ===');
  try {
    let page = 1, totalPages = 1;
    const yrcSet = new Set();
    do {
      const data = await aidaJson(SEARCH_PATH, {
        region: 'VRKA', p: page, size: 20,
        sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2,
      });
      totalPages = data.totalPages;
      for (const item of data.cruiseItems || []) yrcSet.add(item.yieldRouteCode);
      console.log(`  Kanaren p=${page}/${totalPages} items=${(data.cruiseItems||[]).length}`);
      page++;
      if (page > totalPages) break;
      await sleep(900);
    } while (page <= totalPages);
    console.log(`  Kanaren unique yieldRouteCodes total=${yrcSet.size}`);
  } catch (e) {
    console.log('  ERROR:', e.message);
  }

  process.exit(0);
})();
