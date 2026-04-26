const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mailer');

const CABIN_BUCKETS = ['Innen', 'Außen', 'Balkon', 'Suite'];

function parseCabinFilter(csv) {
  if (!csv) return null;
  const parts = String(csv).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function serializeCabinFilter(arr) {
  if (!arr || !arr.length) return null;
  const valid = arr.filter((c) => CABIN_BUCKETS.includes(c));
  return valid.length ? valid.join(',') : null;
}

const latestFaresStmt = db.prepare(`
  SELECT p.fare_code, p.fare_name, p.cabin_type, p.with_flight, p.price_eur, p.captured_at
  FROM prices p
  JOIN (
    SELECT fare_code, with_flight, MAX(captured_at) AS captured_at
    FROM prices
    WHERE cruise_id = ?
    GROUP BY fare_code, with_flight
  ) latest ON latest.fare_code = p.fare_code
          AND latest.with_flight = p.with_flight
          AND latest.captured_at = p.captured_at
  WHERE p.cruise_id = ?
`);

/**
 * Returns the cheapest currently-known fare for a cruise. Optionally restricted
 * to specific cabin buckets (Innen/Außen/Balkon/Suite) and/or a flight option.
 */
function bestCurrentFare(cruiseId, options = {}) {
  const rows = latestFaresStmt.all(cruiseId, cruiseId);
  if (!rows.length) return null;

  const cabinSet = options.cabinTypes && options.cabinTypes.length
    ? new Set(options.cabinTypes)
    : null;
  const flight = options.flightOption || 'any';

  const candidates = rows.filter((r) => {
    if (cabinSet && !cabinSet.has(r.cabin_type)) return false;
    if (flight === 'with' && !r.with_flight) return false;
    if (flight === 'without' && r.with_flight) return false;
    return true;
  });

  if (!candidates.length) return null;
  return candidates.reduce((best, r) =>
    !best || r.price_eur < best.price_eur ? r : best, null);
}

const watchersStmt = db.prepare(`
  SELECT w.id, w.email, w.cruise_id, w.token,
         w.baseline_price, w.baseline_fare,
         w.cabin_filter, w.flight_filter,
         c.title, c.ship, c.destination, c.departs_at, c.returns_at,
         c.duration_nights, c.url
  FROM watchlist w
  JOIN cruises c ON c.id = w.cruise_id
`);

const updateBaseline = db.prepare(`
  UPDATE watchlist SET baseline_price = ?, baseline_fare = ?, last_notified_at = datetime('now') WHERE id = ?
`);

const setBaselineOnly = db.prepare(`
  UPDATE watchlist SET baseline_price = ?, baseline_fare = ? WHERE id = ?
`);

function findAlerts() {
  const watchers = watchersStmt.all();
  const alerts = [];

  for (const w of watchers) {
    const cabinTypes = parseCabinFilter(w.cabin_filter);
    const flightOption = w.flight_filter || 'any';
    const best = bestCurrentFare(w.cruise_id, { cabinTypes, flightOption });
    if (!best) continue;

    const baseline = Number(w.baseline_price);
    if (!Number.isFinite(baseline) || baseline <= 0) {
      setBaselineOnly.run(best.price_eur, best.fare_code, w.id);
      continue;
    }

    if (best.price_eur < baseline - 0.5) {
      alerts.push({
        watcherId: w.id,
        email: w.email,
        token: w.token,
        cruise: {
          id: w.cruise_id,
          title: w.title,
          ship: w.ship,
          destination: w.destination,
          departsAt: w.departs_at,
          returnsAt: w.returns_at,
          durationNights: w.duration_nights,
          url: w.url,
        },
        oldPrice: baseline,
        oldFare: w.baseline_fare,
        newPrice: best.price_eur,
        newFare: best.fare_code,
        newFareName: best.fare_name,
        newCabin: best.cabin_type,
        newWithFlight: !!best.with_flight,
        cabinFilter: cabinTypes,
        flightFilter: flightOption,
      });
    }
  }

  return alerts;
}

async function sendAlertsForWatchers(alerts, { log = console } = {}) {
  for (const a of alerts) {
    const subject = `Preisalarm: ${a.cruise.title} jetzt ab ${formatEur(a.newPrice)}`;
    const unsubscribeUrl = `${config.baseUrl}/unsubscribe/${a.token}`;
    const text = renderTextMail(a, unsubscribeUrl);
    const html = renderHtmlMail(a, unsubscribeUrl);

    try {
      await sendMail({ to: a.email, subject, text, html });
      updateBaseline.run(a.newPrice, a.newFare, a.watcherId);
      log.info?.(`[notify] sent alert to ${a.email} for ${a.cruise.id} (${a.oldPrice} -> ${a.newPrice})`);
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
  const c = a.cruise;
  const filterDesc = [];
  if (a.cabinFilter && a.cabinFilter.length) filterDesc.push(`Kabinen: ${a.cabinFilter.join(', ')}`);
  filterDesc.push(`Flug: ${flightLabel(a.flightFilter)}`);
  return [
    `Hallo,`,
    ``,
    `der Preis für deine gemerkte AIDA-Reise ist gefallen:`,
    ``,
    `${c.title}`,
    `Schiff: ${c.ship || '-'}`,
    `Termin: ${formatDate(c.departsAt)} – ${formatDate(c.returnsAt)} (${c.durationNights || '?'} Nächte)`,
    `Filter: ${filterDesc.join(' · ')}`,
    ``,
    `Vorher: ${formatEur(a.oldPrice)}${a.oldFare ? ` (${a.oldFare})` : ''}`,
    `Jetzt:  ${formatEur(a.newPrice)} – ${a.newFareName || a.newFare}${a.newCabin ? `, ${a.newCabin}` : ''}${a.newWithFlight ? ', inkl. Flug' : ''}`,
    ``,
    c.url ? `Zur Reise: ${c.url}` : '',
    ``,
    `Diese Benachrichtigung abbestellen: ${unsubscribeUrl}`,
  ].filter(Boolean).join('\n');
}

function renderHtmlMail(a, unsubscribeUrl) {
  const c = a.cruise;
  const drop = Math.round((1 - a.newPrice / a.oldPrice) * 100);
  const filterDesc = [];
  if (a.cabinFilter && a.cabinFilter.length) filterDesc.push(`Kabinen: ${a.cabinFilter.join(', ')}`);
  filterDesc.push(`Flug: ${flightLabel(a.flightFilter)}`);
  return `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:auto">
  <h2 style="margin-bottom:4px">Preisalarm: ${escapeHtml(c.title)}</h2>
  <p style="color:#666;margin-top:0">Schiff: ${escapeHtml(c.ship || '-')} · ${escapeHtml(formatDate(c.departsAt))} – ${escapeHtml(formatDate(c.returnsAt))} · ${c.durationNights || '?'} Nächte</p>
  <p style="color:#666;margin-top:0">${escapeHtml(filterDesc.join(' · '))}</p>
  <p>Der Preis ist um <strong>${drop}%</strong> gefallen:</p>
  <table style="border-collapse:collapse">
    <tr><td style="padding:4px 12px 4px 0;color:#666">Vorher</td><td><s>${formatEur(a.oldPrice)}</s>${a.oldFare ? ` <span style="color:#999">(${escapeHtml(a.oldFare)})</span>` : ''}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666">Jetzt</td><td><strong>${formatEur(a.newPrice)}</strong> – ${escapeHtml(a.newFareName || a.newFare)}${a.newCabin ? `, ${escapeHtml(a.newCabin)}` : ''}${a.newWithFlight ? ', inkl. Flug' : ''}</td></tr>
  </table>
  ${c.url ? `<p><a href="${escapeAttr(c.url)}">Zur Reise auf aida.de →</a></p>` : ''}
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
  CABIN_BUCKETS,
  findAlerts,
  sendAlertsForWatchers,
  bestCurrentFare,
  parseCabinFilter,
  serializeCabinFilter,
  setBaseline: (watcherId, price, fareCode) => setBaselineOnly.run(price, fareCode, watcherId),
};
