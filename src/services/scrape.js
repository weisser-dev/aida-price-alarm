const db = require('../db');
const adapter = require('./aidaAdapter');
const config = require('../config');
const { findAlerts, sendAlertsForWatchers } = require('./notify');

const upsertRoute = db.prepare(`
  INSERT INTO routes (
    id, route_code, yield_code, route_group, title,
    ship_code, ship_name, region, departure_port, arrival_port,
    duration_nights, ports_json, image_url, updated_at
  )
  VALUES (
    @id, @routeCode, @yieldCode, @routeGroup, @title,
    @shipCode, @shipName, @region, @departurePort, @arrivalPort,
    @durationNights, @portsJson, @imageUrl, datetime('now')
  )
  ON CONFLICT(id) DO UPDATE SET
    route_code = excluded.route_code, yield_code = excluded.yield_code,
    route_group = excluded.route_group, title = excluded.title,
    ship_code = excluded.ship_code, ship_name = excluded.ship_name,
    region = excluded.region, departure_port = excluded.departure_port,
    arrival_port = excluded.arrival_port, duration_nights = excluded.duration_nights,
    ports_json = excluded.ports_json, image_url = excluded.image_url,
    updated_at = datetime('now')
`);

const upsertJourney = db.prepare(`
  INSERT INTO journeys (
    id, route_id, ship_code, duration_nights, departs_at, returns_at,
    booking_url, image_url, updated_at
  )
  VALUES (
    @id, @routeId, @shipCode, @durationNights, @departsAt, @returnsAt,
    @bookingUrl, @imageUrl, datetime('now')
  )
  ON CONFLICT(id) DO UPDATE SET
    route_id = excluded.route_id, ship_code = excluded.ship_code,
    duration_nights = excluded.duration_nights,
    departs_at = excluded.departs_at, returns_at = excluded.returns_at,
    booking_url = excluded.booking_url, image_url = excluded.image_url,
    updated_at = datetime('now')
`);

const insertPrice = db.prepare(`
  INSERT INTO prices (journey_id, tariff_type, tariff_name, flight_included,
                      amount_eur, per_person_eur, currency, notes_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertCampaign = db.prepare(`
  INSERT INTO campaigns (journey_id, code, name, medium, valid_from, valid_to)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const deleteOldCampaigns = db.prepare(`DELETE FROM campaigns WHERE journey_id = ?`);

const startRun  = db.prepare(`INSERT INTO scrape_runs (status) VALUES ('running')`);
const finishRun = db.prepare(`
  UPDATE scrape_runs
     SET finished_at = datetime('now'), status = ?,
         routes_seen = ?, journeys_seen = ?, prices_seen = ?, campaigns_seen = ?, error = ?
   WHERE id = ?
`);

function persistRoutes(routes) {
  let routeCount = 0, journeyCount = 0, priceCount = 0, campaignCount = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      upsertRoute.run({
        id: r.id,
        routeCode: r.routeCode || null,
        yieldCode: r.yieldCode || null,
        routeGroup: r.routeGroup || null,
        title: r.title,
        shipCode: r.shipCode || null,
        shipName: r.shipName || null,
        region: r.region || null,
        departurePort: r.departurePort || null,
        arrivalPort: r.arrivalPort || null,
        durationNights: r.durationNights ?? null,
        portsJson: r.portsJson || null,
        imageUrl: r.imageUrl || null,
      });
      routeCount += 1;

      for (const j of r.journeys) {
        upsertJourney.run({
          id: j.id,
          routeId: r.id,
          shipCode: j.shipCode || r.shipCode || null,
          durationNights: j.durationNights ?? r.durationNights ?? null,
          departsAt: j.departsAt,
          returnsAt: j.returnsAt,
          bookingUrl: j.bookingUrl || null,
          imageUrl: j.imageUrl || null,
        });
        journeyCount += 1;

        const seen = new Map();
        for (const p of (j.prices || [])) {
          const key = `${p.tariffType}|${p.flightIncluded ? 1 : 0}`;
          const prev = seen.get(key);
          if (!prev || p.amountEur < prev.amountEur) seen.set(key, p);
        }
        for (const p of seen.values()) {
          insertPrice.run(
            j.id, p.tariffType, p.tariffName || null,
            p.flightIncluded ? 1 : 0,
            p.amountEur, p.perPersonEur ?? null,
            p.currency || '€',
            p.notes && p.notes.length ? JSON.stringify(p.notes) : null,
          );
          priceCount += 1;
        }

        deleteOldCampaigns.run(j.id);
        const seenCamps = new Set();
        for (const c of (j.campaigns || [])) {
          if (seenCamps.has(c.code)) continue;
          seenCamps.add(c.code);
          upsertCampaign.run(j.id, c.code, c.name || null, c.medium || null,
            c.validFrom || null, c.validTo || null);
          campaignCount += 1;
        }
      }
    }
  });
  tx(routes);
  return { routeCount, journeyCount, priceCount, campaignCount };
}

async function runScrape({ notify = true, log = console } = {}) {
  const runInfo = startRun.run();
  const runId = runInfo.lastInsertRowid;

  let totals = { routes: 0, journeys: 0, prices: 0, campaigns: 0 };
  const regionErrors = [];

  try {
    if (config.scrape.useMock) {
      const all = await adapter.fetchCatalog({ log });
      const r = persistRoutes(all);
      totals.routes += r.routeCount;
      totals.journeys += r.journeyCount;
      totals.prices += r.priceCount;
      totals.campaigns += r.campaignCount;
    } else {
      // Streaming + persist-per-region: a partial scrape still leaves data
      // in the DB if Akamai blocks half-way.
      for await (const chunk of adapter.streamCatalog({ log })) {
        if (chunk.error) regionErrors.push(`${chunk.region}: ${chunk.error}`);
        if (chunk.routes.length) {
          const r = persistRoutes(chunk.routes);
          totals.routes += r.routeCount;
          totals.journeys += r.journeyCount;
          totals.prices += r.priceCount;
          totals.campaigns += r.campaignCount;
          log.info?.(`[scrape] persisted region=${chunk.region}: +${r.routeCount} routes, +${r.journeyCount} journeys, +${r.priceCount} prices`);
        }
      }
    }
  } catch (err) {
    finishRun.run('error', totals.routes, totals.journeys, totals.prices, totals.campaigns, String(err && err.message || err), runId);
    throw err;
  }

  const status = regionErrors.length ? 'partial' : 'ok';
  finishRun.run(
    status,
    totals.routes, totals.journeys, totals.prices, totals.campaigns,
    regionErrors.length ? regionErrors.join(' | ') : null,
    runId,
  );
  log.info?.(`[scrape] done (${status}): ${totals.routes} routes / ${totals.journeys} journeys / ${totals.prices} prices / ${totals.campaigns} campaigns${regionErrors.length ? ` · errors in ${regionErrors.length} region(s)` : ''}`);

  if (notify) {
    const alerts = findAlerts();
    if (alerts.length) {
      log.info?.(`[scrape] found ${alerts.length} alert(s) to send`);
      await sendAlertsForWatchers(alerts, { log });
    }
  }

  return totals;
}

module.exports = { runScrape };
