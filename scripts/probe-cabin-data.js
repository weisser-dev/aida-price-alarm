/* Probe: Was liefert singleCruise.json und detail.cruise.json?
 * Prüft, ob cabin-level Preise verfügbar sind.
 */
const { aidaJson, ensureCookie } = require('../src/services/aidaAdapter');

const SEARCH_PATH = '/content/aida-search-and-booking/requests/search.cruise.json';
const SINGLE_PATH = '/content/aida-search-and-booking/requests/search.singleCruise.json';
const DETAIL_PATH = '/content/aida-search-and-booking/requests/detail.cruise.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ensureCookie(true);
  await sleep(1500);

  // 1) Fetch a known Cosma journey to get its identifiers
  const data = await aidaJson(SEARCH_PATH, { ship: 'CO', p: 1, size: 20, sortCriteria: 'DepartureDate', sortDirection: 'Asc', adults: 2 });
  const item = (data.cruiseItems || []).find((i) => (i.cruiseItemVariant || []).length);
  if (!item) { console.log('no item found'); process.exit(1); }
  const variant = item.cruiseItemVariant[0];

  console.log('=== Sample cruiseItem keys ===');
  console.log(Object.keys(item));
  console.log('=== Sample cruiseItemVariant keys ===');
  console.log(Object.keys(variant));
  console.log('=== Sample cruiseItemVariant content (first 2000 chars) ===');
  console.log(JSON.stringify(variant, null, 2).slice(0, 2000));

  console.log('\n=== Looking for cabin info in variant ===');
  console.log('cabinType:', variant.cabinType);
  console.log('cabinCategory:', variant.cabinCategory);
  console.log('cabin:', variant.cabin);
  console.log('cabins:', variant.cabins);
  console.log('roomType:', variant.roomType);

  const journeyId = variant.journeyIdentifier;
  console.log(`\n=== Test singleCruise.json for ${journeyId} ===`);
  await sleep(1500);
  try {
    const single = await aidaJson(SINGLE_PATH, { journeyIdentifier: journeyId, adults: 2 });
    console.log('  keys:', Object.keys(single));
    console.log('  first 3000 chars:', JSON.stringify(single, null, 2).slice(0, 3000));
  } catch (e) {
    console.log('  ERROR:', e.message);
    // Try other common params
    await sleep(1500);
    try {
      const single2 = await aidaJson(SINGLE_PATH, { id: journeyId, adults: 2 });
      console.log('  retry id=  keys:', Object.keys(single2));
    } catch (e2) {
      console.log('  retry ERROR:', e2.message);
    }
  }

  console.log(`\n=== Test detail.cruise.json for ${journeyId} ===`);
  await sleep(1500);
  for (const params of [
    { journeyIdentifier: journeyId, adults: 2 },
    { id: journeyId, adults: 2 },
    { yieldRouteCode: item.yieldRouteCode, adults: 2 },
    { journeyIdentifier: journeyId, tariffType: 'CLA', adults: 2 },
  ]) {
    try {
      console.log(`  trying params=${JSON.stringify(params)}`);
      const detail = await aidaJson(DETAIL_PATH, params);
      console.log('   keys:', Object.keys(detail));
      console.log('   first 2000 chars:', JSON.stringify(detail, null, 2).slice(0, 2000));
      break;
    } catch (e) {
      console.log('   ERROR:', e.message);
    }
    await sleep(1500);
  }

  // Also try fetching the actual cabin page HTML to learn URL patterns
  const bookingLink = variant.bookingLink;
  console.log(`\n=== bookingLink = ${bookingLink} ===`);
  // e.g. /buchen/CO07260529/CLASSIC/meine-reise/kabine?...
  // Try to derive a cabin endpoint
  process.exit(0);
})();
