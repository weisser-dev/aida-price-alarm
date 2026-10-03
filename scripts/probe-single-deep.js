/* Deep look at singleCruise.json structure to confirm whether we're missing
 * journeys vs search.cruise.json.
 */
const { aidaJson, ensureCookie } = require('../src/services/aidaAdapter');
const SINGLE = '/content/aida-search-and-booking/requests/search.singleCruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ensureCookie(true);

  console.log('\n=== singleCruise sample (no filter, page 1, size 5) ===');
  const sample = await aidaJson(SINGLE, { p: 1, size: 5, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
  console.log('resultsTotal:', sample.resultsTotal, 'totalPages:', sample.totalPages);
  for (const item of sample.cruiseItems || []) {
    const v = item.cruiseItemVariant?.[0];
    console.log(`  yrc=${item.yieldRouteCode} variants=${item.cruiseItemVariant?.length} sample-variant: jid=${v?.journeyIdentifier} ship=${v?.ship?.code} tariff=${v?.tariffType} flight=${v?.flightIncluded} amount=${v?.amount}`);
  }

  // Now fetch ALL pages without filter, count unique journeyIdentifiers
  console.log('\n=== singleCruise full crawl, no filter ===');
  let page = 1, totalPages = 1;
  const allJourneyIds = new Set();
  const allYRCs = new Set();
  const journeysByShip = {};
  const cosmaJourneys = new Set();
  do {
    const data = await aidaJson(SINGLE, { p: page, size: 50, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
    if (page === 1) totalPages = data.totalPages;
    for (const item of data.cruiseItems || []) {
      allYRCs.add(item.yieldRouteCode);
      for (const v of item.cruiseItemVariant || []) {
        if (v.journeyIdentifier) {
          allJourneyIds.add(v.journeyIdentifier);
          const code = v.ship?.code || 'UNK';
          journeysByShip[code] = (journeysByShip[code] || new Set());
          journeysByShip[code].add(v.journeyIdentifier);
          if (code === 'CO') cosmaJourneys.add(v.journeyIdentifier);
        }
      }
    }
    if (page % 10 === 0 || page === totalPages) {
      console.log(`  p=${page}/${totalPages} unique-jids-so-far=${allJourneyIds.size} unique-yrcs=${allYRCs.size}`);
    }
    page++;
    if (page > totalPages) break;
    await sleep(500);
  } while (page <= totalPages);

  console.log(`\nTOTAL unique journeyIds: ${allJourneyIds.size}`);
  console.log(`TOTAL unique yieldRouteCodes: ${allYRCs.size}`);
  console.log(`Per-ship journey counts:`);
  for (const [s, set] of Object.entries(journeysByShip).sort()) {
    console.log(`  ${s}: ${set.size}`);
  }
  console.log(`\nCosma sample journey IDs (first 10): ${[...cosmaJourneys].slice(0, 10).join(', ')}`);
  console.log(`Cosma yieldRouteCodes (derived from journey IDs prefix): ${[...new Set([...cosmaJourneys].map((j) => j.slice(0, 2)))].join(', ')}`);
})();
