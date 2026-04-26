#!/usr/bin/env node
const { runScrape } = require('../services/scrape');

(async () => {
  try {
    const r = await runScrape();
    console.log('Done:', r);
    process.exit(0);
  } catch (err) {
    console.error('scrape failed:', err);
    process.exit(1);
  }
})();
