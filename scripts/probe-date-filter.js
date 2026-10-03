/* Test if date filters reveal more routes (maybe 2027/2028 routes are hidden
 * behind departureDateFrom).
 */
const { aidaJson, ensureCookie } = require('../src/services/aidaAdapter');
const SEARCH = '/content/aida-search-and-booking/requests/search.cruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ensureCookie(true);

  const tests = [
    { label: 'no date filter',           params: {} },
    { label: 'date 2027 onward',         params: { departureDateFrom: '2027-01-01' } },
    { label: 'date 2027 - 2028',         params: { departureDateFrom: '2027-06-01', departureDateTo: '2028-06-01' } },
    { label: 'sort by Price asc',        params: { sortCriteria: 'Price', sortDirection: 'Asc' } },
    { label: 'sort by Price desc',       params: { sortCriteria: 'Price', sortDirection: 'Desc' } },
    { label: 'sort by Duration asc',     params: { sortCriteria: 'Duration', sortDirection: 'Asc' } },
    { label: 'CO + 2027',                params: { ship: 'CO', departureDateFrom: '2027-01-01' } },
  ];

  for (const t of tests) {
    await sleep(2000);
    const yrcs = new Set();
    let page = 1, totalPages = 1;
    do {
      try {
        const data = await aidaJson(SEARCH, { p: page, size: 20, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2, ...t.params });
        if (page === 1) totalPages = data.totalPages;
        for (const item of data.cruiseItems || []) yrcs.add(item.yieldRouteCode);
      } catch (e) { console.log(`    err on p=${page}: ${e.message}`); break; }
      page++;
      if (page > totalPages) break;
      await sleep(500);
    } while (page <= totalPages);
    console.log(`[${t.label}] pages=${totalPages} unique YRCs=${yrcs.size}`);
    if (yrcs.size <= 25) console.log(`   YRCs: ${[...yrcs].sort().join(', ')}`);
  }
})();
