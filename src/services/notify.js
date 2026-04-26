const db = require('../db');
const config = require('../config');
const { sendMail } = require('./mailer');

/**
 * Returns the best (lowest) currently-known fare for a cruise based on the
 * most recent price snapshot per fare code.
 */
const latestFaresStmt = db.prepare(`
  SELECT p.fare_code, p.fare_name, p.cabin_type, p.price_eur, p.captured_at
  FROM prices p
  JOIN (
    SELECT fare_code, MAX(captured_at) AS captured_at
    FROM prices
    WHERE cruise_id = ?
    GROUP BY fare_code
  ) latest ON latest.fare_code = p.fare_code AND latest.captured_at = p.captured_at
  WHERE p.cruise_id = ?
`);

function bestCurrentFare(cruiseId) {
  const rows = latestFaresStmt.all(cruiseId, cruiseId);
  if (!rows.length) return null;
  return rows.reduce((best, r) =>
    !best || r.price_eur < best.price_eur ? r : best, null);
}

/**
 * Walks the watchlist and decides which entries should trigger an email.
 * An alert fires when the best current fare is strictly lower than the
 * watcher's recorded baseline price (or when a new, cheaper fare class
 * has become available since the watcher subscribed).
 */
const watchersStmt = db.prepare(`
  SELECT w.id, w.email, w.cruise_id, w.token, w.baseline_price, w.baseline_fare,
         c.title, c.ship, c.destination, c.departs_at, c.returns_at, c.duration_nights, c.url
  FROM watchlist w
  JOIN cruises c ON c.id = w.cruise_id
`);

function findAlerts() {
  const watchers = watchersStmt.all();
  const alerts = [];

  for (const w of watchers) {
    const best = bestCurrentFare(w.cruise_id);
    if (!best) continue;

    const baseline = Number(w.baseline_price);
    if (!Number.isFinite(baseline) || baseline <= 0) {
      // First evaluation - just store baseline, no notification.
      updateBaseline.run(best.price_eur, best.fare_code, w.id);
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
      });
    }
  }

  return alerts;
}

const updateBaseline = db.prepare(`
  UPDATE watchlist SET baseline_price = ?, baseline_fare = ?, last_notified_at = datetime('now') WHERE id = ?
`);

const setBaselineOnly = db.prepare(`
  UPDATE watchlist SET baseline_price = ?, baseline_fare = ? WHERE id = ?
`);

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

function renderTextMail(a, unsubscribeUrl) {
  const c = a.cruise;
  return [
    `Hallo,`,
    ``,
    `der Preis für deine gemerkte AIDA-Reise ist gefallen:`,
    ``,
    `${c.title}`,
    `Schiff: ${c.ship || '-'}`,
    `Termin: ${formatDate(c.departsAt)} – ${formatDate(c.returnsAt)} (${c.durationNights || '?'} Nächte)`,
    ``,
    `Vorher: ${formatEur(a.oldPrice)}${a.oldFare ? ` (${a.oldFare})` : ''}`,
    `Jetzt:  ${formatEur(a.newPrice)} – ${a.newFareName || a.newFare}${a.newCabin ? `, ${a.newCabin}` : ''}`,
    ``,
    c.url ? `Zur Reise: ${c.url}` : '',
    ``,
    `Diese Benachrichtigung abbestellen: ${unsubscribeUrl}`,
  ].filter(Boolean).join('\n');
}

function renderHtmlMail(a, unsubscribeUrl) {
  const c = a.cruise;
  const drop = Math.round((1 - a.newPrice / a.oldPrice) * 100);
  return `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:auto">
  <h2 style="margin-bottom:4px">Preisalarm: ${escapeHtml(c.title)}</h2>
  <p style="color:#666;margin-top:0">Schiff: ${escapeHtml(c.ship || '-')} · ${escapeHtml(formatDate(c.departsAt))} – ${escapeHtml(formatDate(c.returnsAt))} · ${c.durationNights || '?'} Nächte</p>
  <p>Der Preis ist um <strong>${drop}%</strong> gefallen:</p>
  <table style="border-collapse:collapse">
    <tr><td style="padding:4px 12px 4px 0;color:#666">Vorher</td><td><s>${formatEur(a.oldPrice)}</s>${a.oldFare ? ` <span style="color:#999">(${escapeHtml(a.oldFare)})</span>` : ''}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666">Jetzt</td><td><strong>${formatEur(a.newPrice)}</strong> – ${escapeHtml(a.newFareName || a.newFare)}${a.newCabin ? `, ${escapeHtml(a.newCabin)}` : ''}</td></tr>
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
  findAlerts,
  sendAlertsForWatchers,
  bestCurrentFare,
  setBaseline: (watcherId, price, fareCode) => setBaselineOnly.run(price, fareCode, watcherId),
};
