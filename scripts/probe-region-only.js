/* Probe: Was liefert die AIDA-API für eine einzelne Region (ohne ship-Filter)?
 * Vergleicht die unique yieldRouteCodes pro Region und zählt Schiffe.
 */
const { aidaJson, ensureCookie, REGIONS, REGION_NAMES } = require('../src/services/aidaAdapter');

const SEARCH_PATH = '/content/aida-search-and-booking/requests/search.cruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Test specific regions where Cosma is likely to sail: Westmittelmeer, Ostmittelmeer, Nordeuropa, Ostsee
  const testRegions = ['VRWM', 'VROM', 'VRNE', 'VROS', 'VRKA', 'VRTR'];

  for (const region of testRegions) {
    await ensureCookie(true);
    await sleep(2000);
    const allYRC = new Set();
    const shipCounts = {};
    const cosmaYRCs = new Set();
    let totalPages = 1;
    try {
      let page = 1;
      do {
        const data = await aidaJson(SEARCH_PATH, {
          region, p: page, size: 20,
          sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2,
        });
        totalPages = data.totalPages;
        for (const item of data.cruiseItems || []) {
          allYRC.add(item.yieldRouteCode);
          const variants = item.cruiseItemVariant || [];
          const ship = variants[0]?.ship?.code || 'UNK';
          shipCounts[ship] = (shipCounts[ship] || 0) + 1;
          if (ship === 'CO') cosmaYRCs.add(item.yieldRouteCode);
        }
        page++;
        if (page > totalPages) break;
        await sleep(900);
      } while (page <= totalPages);
      console.log(`[${region}] ${REGION_NAMES[region]}: pages=${totalPages} uniqueYRCs=${allYRC.size} ships=${JSON.stringify(shipCounts)} cosmaYRCs=${cosmaYRCs.size}`);
      if (cosmaYRCs.size) console.log(`   Cosma in ${region}:`, [...cosmaYRCs].join(', '));
    } catch (e) {
      console.log(`[${region}] ERROR: ${e.message}`);
    }
  }
  process.exit(0);
})();
