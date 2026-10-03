/* Probe: Welche Filter-Strategie liefert die meisten unique routes? */
const { aidaJson, ensureCookie } = require('../src/services/aidaAdapter');

const SEARCH_PATH = '/content/aida-search-and-booking/requests/search.cruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHIPS = ['BE','BL','CO','DI','LU','MA','NO','PE','PR','SO','ST'];
const REGIONS = ['VRAD','VRAF','VRAS','VRIO','VRKA','VRKM','VRNA','VRNE','VRDU','VROS','VRTR','VRWR','VRWE','VRWM','VROM'];

async function probe(label, params) {
  await ensureCookie(true);
  await sleep(1500);
  try {
    const data = await aidaJson(SEARCH_PATH, params);
    const items = data.cruiseItems || [];
    const yrcs = new Set(items.map((i) => i.yieldRouteCode));
    console.log(`[${label}] params=${JSON.stringify(params)} totalPages=${data.totalPages} pageItems=${items.length} uniqueYRC=${yrcs.size}`);
    return { totalPages: data.totalPages, pageYRCs: yrcs };
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message}`);
    return null;
  }
}

async function fullPaginate(label, baseParams) {
  await ensureCookie(true);
  await sleep(1500);
  const allYRC = new Set();
  let totalPages = 1, page = 1;
  try {
    do {
      const data = await aidaJson(SEARCH_PATH, { ...baseParams, p: page, size: 100 });
      totalPages = data.totalPages;
      for (const item of data.cruiseItems || []) allYRC.add(item.yieldRouteCode);
      page++;
      if (page > totalPages) break;
      await sleep(700);
    } while (page <= totalPages);
    console.log(`[${label}] full-paginate params=${JSON.stringify(baseParams)} pages=${totalPages} uniqueYRC=${allYRC.size}`);
    return allYRC;
  } catch (e) {
    console.log(`[${label}] ERROR: ${e.message}`);
    return allYRC;
  }
}

(async () => {
  console.log('\n=== A) size variations ===');
  await probe('size=20',  { p: 1, size: 20,  sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
  await probe('size=50',  { p: 1, size: 50,  sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
  await probe('size=100', { p: 1, size: 100, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
  await probe('size=200', { p: 1, size: 200, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
  await probe('size=500', { p: 1, size: 500, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });

  console.log('\n=== B) full paginate w/o filter (size=100) ===');
  const noFilter = await fullPaginate('no-filter', { sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });

  console.log('\n=== C) per ship full paginate ===');
  const allByShip = new Set();
  for (const s of SHIPS) {
    const set = await fullPaginate(`ship=${s}`, { ship: s, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
    for (const y of set) allByShip.add(y);
    await sleep(1500);
  }
  console.log(`\nGRAND TOTAL unique YRCs via per-ship: ${allByShip.size}`);

  console.log('\n=== D) ship + region combo (just CO + each region, page 1) ===');
  const cosmaByRegion = new Map();
  for (const r of REGIONS) {
    const res = await probe(`ship=CO+region=${r}`, { ship: 'CO', region: r, p: 1, size: 100, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
    if (res) cosmaByRegion.set(r, res.pageYRCs);
    await sleep(1500);
  }
  // intersection vs union to see if region actually narrows
  const allCosma = new Set();
  for (const s of cosmaByRegion.values()) for (const y of s) allCosma.add(y);
  console.log(`Cosma union of all region queries: ${allCosma.size} YRCs`);
  console.log(`Cosma per-region sizes:`, [...cosmaByRegion.entries()].map(([k,v]) => `${k}=${v.size}`).join(', '));

  process.exit(0);
})();
