const path = require('path');
const express = require('express');
const cron = require('node-cron');

const config = require('./config');
require('./db'); // ensure schema exists

const cruisesRouter = require('./routes/cruises');
const watchlistRouter = require('./routes/watchlist');
const routesRouter = require('./routes/routes');
const promotionsRouter = require('./routes/promotions');
const { runScrape } = require('./services/scrape');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '128kb' }));

app.use('/api/cruises', cruisesRouter);
app.use('/api/watch', watchlistRouter);
app.use('/api/routes', routesRouter);
app.use('/api/promotions', promotionsRouter);

app.get('/api/status', (_req, res) => {
  const lastRun = db.prepare(`SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1`).get();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM cruises) AS cruises,
      (SELECT COUNT(*) FROM watchlist) AS watchers,
      (SELECT COUNT(*) FROM prices) AS prices
  `).get();
  res.json({
    ok: true,
    mockMode: config.scrape.useMock,
    cron: config.scrape.cron,
    lastRun,
    counts,
  });
});

app.get('/unsubscribe/:token', (req, res) => {
  const row = db.prepare(`SELECT id FROM watchlist WHERE token = ?`).get(req.params.token);
  if (!row) {
    res.status(404).type('html').send(unsubscribePage('Dieser Link ist ungültig oder bereits abgemeldet.', false));
    return;
  }
  db.prepare(`DELETE FROM watchlist WHERE token = ?`).run(req.params.token);
  res.type('html').send(unsubscribePage('Du erhältst keine Preisalarme für diese Reise mehr.', true));
});

function unsubscribePage(msg, ok) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Abmeldung</title>
    <style>body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 16px;color:#222}
    .ok{color:#0a7d32}.err{color:#a23}</style></head>
    <body><h1>AIDA Preisalarm</h1><p class="${ok ? 'ok' : 'err'}">${msg}</p>
    <p><a href="/">Zurück zur Übersicht</a></p></body></html>`;
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const server = app.listen(config.port, () => {
  console.log(`[server] listening on ${config.baseUrl}`);
  console.log(`[server] mock mode: ${config.scrape.useMock}`);
});

// Daily scrape via cron
if (cron.validate(config.scrape.cron)) {
  cron.schedule(config.scrape.cron, async () => {
    console.log(`[cron] running daily scrape (${new Date().toISOString()})`);
    try {
      await runScrape();
    } catch (err) {
      console.error('[cron] scrape failed:', err);
    }
  });
  console.log(`[cron] scheduled with "${config.scrape.cron}"`);
} else {
  console.warn(`[cron] invalid expression "${config.scrape.cron}", scheduler disabled`);
}

// Trigger an initial scrape on first ever boot so the UI isn't empty.
const totalCruises = db.prepare(`SELECT COUNT(*) AS n FROM cruises`).get().n;
if (totalCruises === 0) {
  console.log('[boot] empty database, running initial scrape...');
  runScrape({ notify: false }).catch((err) => console.error('[boot] initial scrape failed', err));
}

function shutdown(sig) {
  console.log(`[server] received ${sig}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
