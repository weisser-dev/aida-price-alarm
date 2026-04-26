const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mailer');
const {
  TARIFF_BUCKETS, FLIGHT_OPTIONS, expandBuckets, bucketForTariff,
  bestPriceForJourney,
} = require('./pricing');

function parseTariffFilter(csv) {
  if (!csv) return null;
  const parts = String(csv).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function serializeTariffFilter(arr) {
  if (!arr || !arr.length) return null;
  const valid = arr.filter((b) => TARIFF_BUCKETS.some((x) => x.id === b));
  return valid.length ? valid.join(',') : null;
}

const journeysOfRoute = db.prepare(`
  SELECT id, departs_at, returns_at, duration_nights, ship_code
  FROM journeys WHERE route_id = ?
`);
const journeyById = db.prepare(`
  SELECT j.*, r.title AS route_title, r.region, r.ship_name, r.departure_port, r.arrival_port
  FROM journeys j JOIN routes r ON r.id = j.route_id
  WHERE j.id = ?
`);
const routeById = db.prepare(`SELECT * FROM routes WHERE id = ?`);

const watchersStmt = db.prepare(`SELECT * FROM watchlist`);

const updateBaseline = db.prepare(`
  UPDATE watchlist SET baseline_price = ?, baseline_tariff = ?, baseline_journey = ?, last_notified_at = datetime('now')
  WHERE id = ?
`);
const setBaselineOnly = db.prepare(`
  UPDATE watchlist SET baseline_price = ?, baseline_tariff = ?, baseline_journey = ?
  WHERE id = ?
`);

/**
 * For each watcher, compute the cheapest matching price right now and flag an
 * alert if it dropped below the stored baseline.
 *
 * Route-watches scan every journey of the route; the cheapest one wins.
 * Journey-watches only look at that single journey.
 */
function findAlerts() {
  const watchers = watchersStmt.all();
  const alerts = [];

  for (const w of watchers) {
    const tariffs = expandBuckets(w.tariff_filter);
    const flightOption = w.flight_filter || 'any';
    const opts = { tariffs, flightOption };

    let best = null, bestJourneyId = null, bestRoute = null;

    if (w.watch_type === 'journey') {
      const j = journeyById.get(w.target_id);
      if (!j) continue;
      best = bestPriceForJourney(w.target_id, opts);
      bestJourneyId = w.target_id;
      bestRoute = { id: j.route_id, title: j.route_title, ship: j.ship_name, region: j.region };
    } else {
      const route = routeById.get(w.target_id);
      if (!route) continue;
      const journeys = journeysOfRoute.all(w.target_id);
      for (const j of journeys) {
        const cand = bestPriceForJourney(j.id, opts);
        if (!cand) continue;
        if (!best || cand.amount_eur < best.amount_eur) {
          best = cand;
          bestJourneyId = j.id;
        }
      }
      bestRoute = { id: route.id, title: route.title, ship: route.ship_name, region: route.region };
    }

    if (!best) continue;

    const baseline = Number(w.baseline_price);
    if (!Number.isFinite(baseline) || baseline <= 0) {
      // First evaluation -> just store baseline silently.
      setBaselineOnly.run(best.amount_eur, best.tariff_type, bestJourneyId, w.id);
      continue;
    }

    if (best.amount_eur < baseline - 0.5) {
      const journey = journeyById.get(bestJourneyId);
      alerts.push({
        watcherId: w.id,
        email: w.email,
        token: w.token,
        watchType: w.watch_type,
        route: bestRoute,
        journey: journey ? {
          id: journey.id,
          departsAt: journey.departs_at,
          returnsAt: journey.returns_at,
          durationNights: journey.duration_nights,
          bookingUrl: journey.booking_url,
        } : null,
        oldPrice: baseline,
        oldTariff: w.baseline_tariff,
        newPrice: best.amount_eur,
        newPerPerson: best.per_person_eur,
        newTariff: best.tariff_type,
        newTariffName: best.tariff_name,
        newFlightIncluded: !!best.flight_included,
        tariffFilter: parseTariffFilter(w.tariff_filter),
        flightFilter: flightOption,
      });
    }
  }

  return alerts;
}

async function sendAlertsForWatchers(alerts, { log = console } = {}) {
  for (const a of alerts) {
    const subject = `Preisalarm: ${a.route.title} jetzt ab ${formatEur(a.newPrice)}`;
    const unsubscribeUrl = `${config.baseUrl}/unsubscribe/${a.token}`;
    const text = renderTextMail(a, unsubscribeUrl);
    const html = renderHtmlMail(a, unsubscribeUrl);

    try {
      await sendMail({ to: a.email, subject, text, html });
      updateBaseline.run(a.newPrice, a.newTariff, a.journey?.id || null, a.watcherId);
      log.info?.(`[notify] sent alert to ${a.email} for ${a.route.id}/${a.journey?.id} (${a.oldPrice} -> ${a.newPrice})`);
    } catch (err) {
      log.error?.(`[notify] failed to send alert to ${a.email}: ${err.message}`);
    }
  }
}

function formatEur(n) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}
function formatDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('de-DE');
}
function flightLabel(v) {
  if (v === 'with') return 'mit Flug';
  if (v === 'without') return 'ohne Flug';
  return 'mit oder ohne Flug';
}

function renderTextMail(a, unsubscribeUrl) {
  const j = a.journey || {};
  const parts = [
    `Hallo,`,
    ``,
    `der Preis für deine gemerkte AIDA-Reise ist gefallen:`,
    ``,
    `${a.route.title}`,
    `Schiff: ${a.route.ship || '-'} · Region: ${a.route.region || '-'}`,
  ];
  if (j.departsAt) {
    parts.push(`Abfahrt: ${formatDate(j.departsAt)}${j.returnsAt ? ` – ${formatDate(j.returnsAt)}` : ''}${j.durationNights ? ` (${j.durationNights} Nächte)` : ''}`);
  }
  parts.push(`Filter: Tarife ${a.tariffFilter?.join(', ') || 'alle'} · ${flightLabel(a.flightFilter)}`);
  parts.push(``);
  parts.push(`Vorher: ${formatEur(a.oldPrice)}${a.oldTariff ? ` (${a.oldTariff})` : ''}`);
  parts.push(`Jetzt:  ${formatEur(a.newPrice)} – ${a.newTariffName || a.newTariff}${a.newFlightIncluded ? ', inkl. Flug' : ', ohne Flug'}${a.newPerPerson ? ` (≈ ${formatEur(a.newPerPerson)} p.P.)` : ''}`);
  parts.push(``);
  if (j.bookingUrl) parts.push(`Zur Buchung: ${j.bookingUrl}`);
  parts.push(``);
  parts.push(`Diese Benachrichtigung abbestellen: ${unsubscribeUrl}`);
  return parts.filter(Boolean).join('\n');
}

function renderHtmlMail(a, unsubscribeUrl) {
  const j = a.journey || {};
  const drop = Math.round((1 - a.newPrice / a.oldPrice) * 100);
  return `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:auto">
  <h2 style="margin-bottom:4px">Preisalarm: ${escapeHtml(a.route.title)}</h2>
  <p style="color:#666;margin-top:0">Schiff: ${escapeHtml(a.route.ship || '-')} · Region: ${escapeHtml(a.route.region || '-')}</p>
  ${j.departsAt ? `<p style="color:#666;margin-top:0">Abfahrt: ${escapeHtml(formatDate(j.departsAt))} – ${escapeHtml(formatDate(j.returnsAt || ''))} · ${j.durationNights || '?'} Nächte</p>` : ''}
  <p style="color:#666;margin-top:0">Filter: ${escapeHtml((a.tariffFilter && a.tariffFilter.length) ? a.tariffFilter.join(', ') : 'alle Tarife')} · ${escapeHtml(flightLabel(a.flightFilter))}</p>
  <p>Der Preis ist um <strong>${drop}%</strong> gefallen:</p>
  <table style="border-collapse:collapse">
    <tr><td style="padding:4px 12px 4px 0;color:#666">Vorher</td><td><s>${formatEur(a.oldPrice)}</s>${a.oldTariff ? ` <span style="color:#999">(${escapeHtml(a.oldTariff)})</span>` : ''}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666">Jetzt</td><td><strong>${formatEur(a.newPrice)}</strong> – ${escapeHtml(a.newTariffName || a.newTariff)}${a.newFlightIncluded ? ', inkl. Flug' : ', ohne Flug'}</td></tr>
    ${a.newPerPerson ? `<tr><td style="padding:4px 12px 4px 0;color:#666">pro Person</td><td>${formatEur(a.newPerPerson)}</td></tr>` : ''}
  </table>
  ${j.bookingUrl ? `<p><a href="${escapeAttr(j.bookingUrl)}">Zur Buchung auf aida.de →</a></p>` : ''}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="color:#999;font-size:12px">Diese Benachrichtigung <a href="${escapeAttr(unsubscribeUrl)}">abbestellen</a>.</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }

module.exports = {
  TARIFF_BUCKETS,
  FLIGHT_OPTIONS,
  findAlerts,
  sendAlertsForWatchers,
  parseTariffFilter,
  serializeTariffFilter,
  bucketForTariff,
};
