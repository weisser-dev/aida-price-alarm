/* Probe singleCruise.json with ship=CO to see if we get more journeys
 * than search.cruise.json delivered.
 */
const { aidaJson, ensureCookie } = require('../src/services/aidaAdapter');
const SINGLE = '/content/aida-search-and-booking/requests/search.singleCruise.json';
const SEARCH = '/content/aida-search-and-booking/requests/search.cruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ensureCookie(true);

  console.log('\n=== singleCruise.json with ship=CO, all pages ===');
  let page = 1, totalPages = 1;
  const yrcSet = new Set();
  const journeyIds = new Set();
  const items = [];
  do {
    const data = await aidaJson(SINGLE, { ship: 'CO', p: page, size: 50, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
    if (page === 1) {
      console.log('  resultsTotal:', data.resultsTotal, 'totalPages:', data.totalPages);
      totalPages = data.totalPages || 1;
    }
    const cruiseItems = data.cruiseItems || [];
    for (const item of cruiseItems) {
      yrcSet.add(item.yieldRouteCode);
      const variants = item.cruiseItemVariant || [];
      for (const v of variants) {
        if (v.ship?.code === 'CO' && v.journeyIdentifier) {
          journeyIds.add(v.journeyIdentifier);
        }
      }
      items.push(item);
    }
    console.log(`  p=${page}/${totalPages} cruiseItems=${cruiseItems.length} yrc-so-far=${yrcSet.size} co-journeys-so-far=${journeyIds.size}`);
    page++;
    if (page > totalPages) break;
    await sleep(700);
  } while (page <= totalPages);

  console.log(`\nFINAL: yieldRouteCodes=${yrcSet.size}, CO-journey-ids=${journeyIds.size}`);
  console.log('All Cosma YRCs:', [...yrcSet].join(', '));

  // Also count unique CO-yrcs (yrcs where AT LEAST ONE variant is CO)
  const coOnlyYrcs = new Set();
  for (const item of items) {
    const variants = item.cruiseItemVariant || [];
    if (variants.some((v) => v.ship?.code === 'CO')) {
      coOnlyYrcs.add(item.yieldRouteCode);
    }
  }
  console.log(`\nUnique YRCs that have at least one CO variant: ${coOnlyYrcs.size}`);
  console.log('CO-operated YRCs:', [...coOnlyYrcs].join(', '));
})();
