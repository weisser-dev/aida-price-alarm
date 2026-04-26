const eur = (n) =>
  n == null ? '–' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const fmtDate = (s) => {
  if (!s) return '–';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('de-DE');
};
const fmtDateShort = (s) => {
  if (!s) return '–';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
};
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const flightLabel = (v) => v === 'with' ? 'inkl. Flug' : v === 'without' ? 'ohne Flug' : 'Flug egal';
const flightChip = (included) => included
  ? '<span class="tag flight-with">inkl. Flug</span>'
  : '<span class="tag flight-without">ohne Flug</span>';

let availableTariffs = [];

// --- Navigation ---------------------------------------------------------
const views = {
  routes: document.getElementById('view-routes'),
  'route-detail': document.getElementById('view-route-detail'),
  campaigns: document.getElementById('view-campaigns'),
  watchlist: document.getElementById('view-watchlist'),
};
document.querySelectorAll('.topbar nav button[data-view]').forEach((b) => {
  b.addEventListener('click', () => switchTo(b.dataset.view));
});

function switchTo(view) {
  for (const [k, el] of Object.entries(views)) el.hidden = (k !== view);
  document.querySelectorAll('.topbar nav button[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  if (view === 'campaigns' && !campaignsLoaded) loadCampaigns();
}

// --- Filter loading ------------------------------------------------------
async function loadFilters() {
  const r = await fetch('/api/routes/filters').then((x) => x.json());
  const fill = (selectName, values, addAllLabel) => {
    document.querySelectorAll(`select[name=${selectName}]`).forEach((sel) => {
      sel.innerHTML = `<option value="">${addAllLabel}</option>`;
      for (const v of values) sel.insertAdjacentHTML('beforeend', `<option>${escapeHtml(v)}</option>`);
    });
  };
  fill('ship', r.ships, 'Alle Schiffe');
  fill('region', r.regions, 'Alle Regionen');
  fill('port', r.ports, 'Alle Häfen');

  availableTariffs = r.tariffBuckets;
  const chipHtml = availableTariffs.map((b) =>
    `<label class="chip"><input type="checkbox" name="tariff" value="${escapeHtml(b.id)}"> ${escapeHtml(b.id.replaceAll('_', ' '))}</label>`
  ).join('');
  document.getElementById('tariff-chips').innerHTML = chipHtml;
  document.getElementById('campaign-tariff-chips').innerHTML = chipHtml;

  document.getElementById('watch-tariff-chips').innerHTML = availableTariffs.map((b) =>
    `<label class="chip"><input type="checkbox" name="tariffBuckets" value="${escapeHtml(b.id)}" checked> ${escapeHtml(b.id.replaceAll('_', ' '))}</label>`
  ).join('');
}

// --- Routes list ---------------------------------------------------------
const filtersForm = document.getElementById('filters');
const routeList = document.getElementById('route-list');
const statusLine = document.getElementById('status-line');

filtersForm.addEventListener('submit', (e) => { e.preventDefault(); loadRoutes(); });
filtersForm.addEventListener('reset', () => setTimeout(loadRoutes, 0));

async function loadRoutes() {
  const params = new URLSearchParams();
  const fd = new FormData(filtersForm);
  for (const k of ['q', 'ship', 'region', 'port', 'departsFrom', 'departsTo', 'flight']) {
    const v = fd.get(k); if (v) params.set(k, v);
  }
  const tariffs = fd.getAll('tariff').filter(Boolean);
  if (tariffs.length) params.set('tariff', tariffs.join(','));
  params.set('limit', '120');

  statusLine.textContent = 'Lade Reisen…';
  const data = await fetch(`/api/routes?${params}`).then((r) => r.json());
  const txt = (data.shown !== undefined && data.shown !== data.total)
    ? `${data.shown} von ${data.total} Routen`
    : `${data.total} Routen`;
  statusLine.textContent = `${txt} gefunden`;

  routeList.innerHTML = data.items.map(renderRouteCard).join('') ||
    `<li class="muted">Keine Reisen gefunden – Filter ggf. lockern.</li>`;

  routeList.querySelectorAll('button[data-watch-route]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog('route', b.dataset.watchRoute, b.dataset.title, b.dataset.subtitle));
  });
  routeList.querySelectorAll('a[data-route-detail]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); openRouteDetail(a.dataset.routeDetail); });
  });
}

function renderRouteCard(r) {
  const price = r.bestPrice ? eur(r.bestPrice.amountEur) : '–';
  const perPerson = r.bestPrice?.perPersonEur ? `<small>≈ ${eur(r.bestPrice.perPersonEur)} p.P.</small>` : '';
  const tariffTag = r.bestPrice ? `<span class="tag">${escapeHtml(r.bestPrice.tariffName || r.bestPrice.tariffType)}</span>` : '';
  const flightTag = r.bestPrice ? flightChip(r.bestPrice.flightIncluded) : '';
  const subtitle = `${r.ship || ''} · ${r.region || ''} · ${r.durationNights || '?'} Nächte`;
  const dateRange = r.firstDeparture ? `${fmtDate(r.firstDeparture)} – ${fmtDate(r.lastDeparture)}` : '';
  return `
    <li class="card">
      <h3><a href="#" data-route-detail="${escapeHtml(r.id)}">${escapeHtml(r.title)}</a></h3>
      <div class="meta">${escapeHtml(subtitle)}</div>
      <div class="meta">${escapeHtml(r.departurePort || '')}${r.arrivalPort && r.arrivalPort !== r.departurePort ? ' → ' + escapeHtml(r.arrivalPort) : ''} · ${r.journeyCount} Abfahrten ${dateRange ? '· ' + escapeHtml(dateRange) : ''}</div>
      <div class="price"><strong>${price}</strong> ${perPerson} ${tariffTag}${flightTag}</div>
      <div class="actions">
        <a href="#" data-route-detail="${escapeHtml(r.id)}">Details & Verlauf</a>
        <button data-watch-route="${escapeHtml(r.id)}" data-title="${escapeHtml(r.title)}" data-subtitle="${escapeHtml(subtitle)}">Merken</button>
      </div>
    </li>`;
}

// --- Route detail --------------------------------------------------------
const routeDetailEl = document.getElementById('route-detail');
document.getElementById('back-to-routes').addEventListener('click', () => switchTo('routes'));

async function openRouteDetail(routeId) {
  switchTo('route-detail');
  routeDetailEl.innerHTML = '<p class="muted">Lade…</p>';
  const params = new URLSearchParams();
  const fd = new FormData(filtersForm);
  const flight = fd.get('flight'); if (flight && flight !== 'any') params.set('flight', flight);
  const tariffs = fd.getAll('tariff').filter(Boolean);
  if (tariffs.length) params.set('tariff', tariffs.join(','));

  const r = await fetch(`/api/routes/${encodeURIComponent(routeId)}?${params}`).then((x) => x.json());
  routeDetailEl.innerHTML = renderRouteDetail(r);

  routeDetailEl.querySelectorAll('button[data-watch-route]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog('route', b.dataset.watchRoute, r.title, `${r.ship} · ${r.region}`));
  });
  routeDetailEl.querySelectorAll('button[data-watch-journey]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog('journey', b.dataset.watchJourney, r.title, b.dataset.subtitle));
  });
}

function renderRouteDetail(r) {
  const a = r.aggregate || {};
  const ports = (r.ports || []).map((p) => p.name || p.code).filter(Boolean);
  const portsLine = ports.length ? ports.join(' → ') : '';
  const aggregateBox = `
    <div class="aggregate">
      ${a.currentLow ? `<div><label>aktuell ab</label><strong>${eur(a.currentLow.amountEur)}</strong><small>${escapeHtml(a.currentLow.tariffName || a.currentLow.tariffType)}${a.currentLow.flightIncluded ? ', inkl. Flug' : ', ohne Flug'} · ${fmtDate(a.currentLow.departsAt)}</small></div>` : ''}
      ${a.allTimeLow ? `<div><label>jemals gesehen</label><strong>${eur(a.allTimeLow.amountEur)}</strong><small>${escapeHtml(a.allTimeLow.tariffType || '')}${a.allTimeLow.flightIncluded ? ', inkl. Flug' : ', ohne Flug'}<br>am ${fmtDate(a.allTimeLow.capturedAt)}</small></div>` : ''}
      ${a.median ? `<div><label>Median akt. Abfahrten</label><strong>${eur(a.median)}</strong></div>` : ''}
      ${a.typicalCampaignLeadDays ? `<div><label>Aktion meist</label><strong>${a.typicalCampaignLeadDays} Tage</strong><small>vor Abfahrt</small></div>` : ''}
    </div>`;

  const journeysHtml = r.journeys.map((j) => {
    const cheapest = j.cheapestForFilter;
    const allPrices = j.latestPrices.sort((x, y) => x.amountEur - y.amountEur);
    const camps = j.activeCampaigns?.length
      ? j.activeCampaigns.map((c) => `<span class="tag campaign">${escapeHtml(c.name || c.code)}${c.validTo ? ` bis ${fmtDate(c.validTo)}` : ''}</span>`).join('')
      : '';
    return `
      <li class="journey">
        <div class="journey-head">
          <div>
            <strong>${fmtDateShort(j.departsAt)}</strong> – ${fmtDateShort(j.returnsAt)}
            <small>${j.durationNights} Nächte · ${escapeHtml(j.id)}</small>
          </div>
          <div class="journey-best">
            ${cheapest ? `<strong>${eur(cheapest.amountEur)}</strong> <span class="tag">${escapeHtml(cheapest.tariffName || cheapest.tariffType)}</span>${flightChip(cheapest.flightIncluded)}` : '<span class="muted">kein Tarif im Filter</span>'}
          </div>
        </div>
        ${camps ? `<div class="campaigns">${camps}</div>` : ''}
        <details class="prices-detail">
          <summary>${allPrices.length} Tarif-Variante${allPrices.length === 1 ? '' : 'n'} verfügbar</summary>
          <ul class="price-list">
            ${allPrices.map((p) => `
              <li>
                <span>${escapeHtml(p.tariffName || p.tariffType)}</span>
                ${flightChip(p.flightIncluded)}
                <span><strong>${eur(p.amountEur)}</strong>${p.perPersonEur ? ` <small>(${eur(p.perPersonEur)} p.P.)</small>` : ''}</span>
              </li>
            `).join('')}
          </ul>
        </details>
        <div class="actions">
          ${j.bookingUrl ? `<a href="${escapeHtml(j.bookingUrl)}" target="_blank" rel="noopener">Auf aida.de buchen</a>` : ''}
          <button data-watch-journey="${escapeHtml(j.id)}" data-subtitle="${escapeHtml(`${fmtDate(j.departsAt)} – ${fmtDate(j.returnsAt)}`)}">Diese Abfahrt merken</button>
        </div>
      </li>`;
  }).join('');

  return `
    <header class="detail-head">
      <h2>${escapeHtml(r.title)}</h2>
      <p class="muted">${escapeHtml(r.ship || '')} · ${escapeHtml(r.region || '')} · ${r.durationNights || '?'} Nächte</p>
      ${portsLine ? `<p class="muted small">${escapeHtml(portsLine)}</p>` : ''}
      <div class="actions">
        <button class="primary" data-watch-route="${escapeHtml(r.id)}">Ganze Route merken</button>
      </div>
    </header>
    <section class="aggregate-section">
      <h3>Preis-Übersicht</h3>
      ${aggregateBox}
    </section>
    <section>
      <h3>Abfahrten (${r.journeys.length})</h3>
      <ul class="journeys">${journeysHtml}</ul>
    </section>`;
}

// --- Watch dialog --------------------------------------------------------
const dialog = document.getElementById('watch-dialog');
const watchTitle = document.getElementById('watch-title');
const watchSubtitle = document.getElementById('watch-subtitle');
const watchScope = document.getElementById('watch-scope');
const watchForm = document.getElementById('watch-form');

let pendingTarget = null;

function openWatchDialog(watchType, targetId, title, subtitle) {
  pendingTarget = { watchType, targetId };
  watchTitle.textContent = `Merken: ${title}`;
  watchSubtitle.textContent = subtitle || '';
  watchScope.textContent = watchType === 'route'
    ? 'Du erhältst eine Mail, sobald der Preis irgendeiner Abfahrt dieser Route günstiger wird.'
    : 'Du erhältst eine Mail, sobald der Preis dieser einen Abfahrt günstiger wird.';
  watchForm.querySelector('input[name=email]').value = localStorage.getItem('aida-email') || '';

  // Inherit current main filter selections
  const activeTariffs = new Set(new FormData(filtersForm).getAll('tariff').filter(Boolean));
  watchForm.querySelectorAll('input[name=tariffBuckets]').forEach((cb) => {
    cb.checked = activeTariffs.size === 0 || activeTariffs.has(cb.value);
  });
  const filterFlight = new FormData(filtersForm).get('flight') || 'any';
  watchForm.querySelector(`input[name=flightOption][value="${filterFlight}"]`)?.click();

  dialog.showModal();
}

watchForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const fd = new FormData(watchForm);
  const email = String(fd.get('email') || '').trim().toLowerCase();
  const tariffBuckets = fd.getAll('tariffBuckets').filter(Boolean);
  const flightOption = fd.get('flightOption') || 'any';
  if (!email || !pendingTarget) { dialog.close(); return; }

  const res = await fetch('/api/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      watchType: pendingTarget.watchType,
      targetId: pendingTarget.targetId,
      tariffBuckets, flightOption,
    }),
  });
  const data = await res.json();
  if (!res.ok) { alert('Fehler: ' + (data.error || res.status)); return; }
  localStorage.setItem('aida-email', email);
  dialog.close();
  const baseTxt = data.baseline
    ? `Baseline ${eur(data.baseline.amountEur)} – ${data.baseline.tariffName || data.baseline.tariffType}${data.baseline.flightIncluded ? ', inkl. Flug' : ', ohne Flug'}`
    : 'aktuell kein Tarif in deiner Auswahl verfügbar';
  alert(`Reise gemerkt. ${baseTxt}. Wir melden uns per Mail, sobald der Preis günstiger wird.`);
});

// --- Campaigns view ------------------------------------------------------
const campaignFilters = document.getElementById('campaign-filters');
const campaignsList = document.getElementById('campaigns-list');
const campaignsStatus = document.getElementById('campaigns-status');
let campaignsLoaded = false;

campaignFilters.addEventListener('submit', (e) => { e.preventDefault(); loadCampaigns(); });
campaignFilters.addEventListener('reset', () => setTimeout(loadCampaigns, 0));

async function loadCampaigns() {
  campaignsLoaded = true;
  const params = new URLSearchParams();
  const fd = new FormData(campaignFilters);
  for (const k of ['q', 'ship', 'region', 'flight']) {
    const v = fd.get(k); if (v) params.set(k, v);
  }
  const tariffs = fd.getAll('tariff').filter(Boolean);
  if (tariffs.length) params.set('tariff', tariffs.join(','));
  params.set('limit', '200');

  campaignsStatus.textContent = 'Lade Aktionen…';
  const data = await fetch(`/api/campaigns?${params}`).then((r) => r.json());
  campaignsStatus.textContent = `${data.shown ?? data.total} aktive Aktionen`;
  campaignsList.innerHTML = data.items.map(renderCampaignCard).join('') ||
    `<li class="muted">Keine aktiven Aktionen passend zum Filter.</li>`;

  campaignsList.querySelectorAll('button[data-watch-journey]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog('journey', b.dataset.watchJourney, b.dataset.title, b.dataset.subtitle));
  });
}

function renderCampaignCard(c) {
  const remain = c.campaign.daysRemaining;
  const remainTag = remain != null ? `<span class="tag ${remain <= 3 ? 'warn' : ''}">noch ${remain} Tag${remain === 1 ? '' : 'e'}</span>` : '';
  const price = c.bestPrice
    ? `<strong>${eur(c.bestPrice.amountEur)}</strong>${c.bestPrice.perPersonEur ? ` <small>≈ ${eur(c.bestPrice.perPersonEur)} p.P.</small>` : ''} <span class="tag">${escapeHtml(c.bestPrice.tariffName || c.bestPrice.tariffType)}</span>${flightChip(c.bestPrice.flightIncluded)}`
    : '<span class="muted">kein Preis im Filter</span>';
  const subtitle = `${fmtDate(c.journey.departsAt)} – ${fmtDate(c.journey.returnsAt)} · ${c.journey.durationNights} Nächte`;
  return `
    <li class="card">
      <div class="campaign-head">
        <span class="tag campaign">${escapeHtml(c.campaign.name || c.campaign.code)}</span> ${remainTag}
      </div>
      <h3>${escapeHtml(c.route.title)}</h3>
      <div class="meta">${escapeHtml(c.route.ship || '')} · ${escapeHtml(c.route.region || '')} · ${escapeHtml(subtitle)}</div>
      <div class="price">${price}</div>
      <div class="actions">
        ${c.journey.bookingUrl ? `<a href="${escapeHtml(c.journey.bookingUrl)}" target="_blank" rel="noopener">Auf aida.de buchen</a>` : ''}
        <button data-watch-journey="${escapeHtml(c.journey.id)}" data-title="${escapeHtml(c.route.title)}" data-subtitle="${escapeHtml(subtitle)}">Merken</button>
      </div>
    </li>`;
}

// --- Watchlist view ------------------------------------------------------
const watchlistForm = document.getElementById('watchlist-form');
const watchlistList = document.getElementById('watchlist-list');

watchlistForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = watchlistForm.email.value.trim().toLowerCase();
  if (!email) return;
  localStorage.setItem('aida-email', email);
  loadWatchlist(email);
});

async function loadWatchlist(email) {
  watchlistList.innerHTML = '<li class="muted">Lade…</li>';
  const data = await fetch(`/api/watch?email=${encodeURIComponent(email)}`).then((r) => r.json());
  if (!data.items?.length) {
    watchlistList.innerHTML = '<li class="muted">Keine gemerkten Reisen.</li>';
    return;
  }
  watchlistList.innerHTML = data.items.map((w) => {
    const baseline = w.baseline?.amountEur;
    const current = w.currentBest?.amountEur;
    let drop = '';
    if (baseline && current && current < baseline) {
      const pct = Math.round((1 - current / baseline) * 100);
      drop = `<span class="tag drop">−${pct}% seit Merken</span>`;
    } else if (baseline && current && current > baseline) {
      const pct = Math.round((current / baseline - 1) * 100);
      drop = `<span class="tag warn">+${pct}% seit Merken</span>`;
    }
    const tariffTxt = w.filters?.tariffBuckets?.length ? w.filters.tariffBuckets.join(', ') : 'alle Tarife';
    const filterTag = `<span class="tag">${escapeHtml(tariffTxt)} · ${escapeHtml(flightLabel(w.filters?.flightOption))}</span>`;
    const scopeTag = `<span class="tag scope">${w.watchType === 'route' ? 'gesamte Route' : 'einzelne Abfahrt'}</span>`;
    const journeyLine = w.journey
      ? `Abfahrt: ${fmtDate(w.journey.departsAt)} – ${fmtDate(w.journey.returnsAt)} · ${w.journey.durationNights} Nächte`
      : `${w.route.region} · ${w.route.ship}`;
    return `
      <li class="card">
        <h3><a href="#" data-route-detail="${escapeHtml(w.route.id)}">${escapeHtml(w.route.title)}</a></h3>
        <div class="meta">${escapeHtml(journeyLine)}</div>
        <div class="meta">${scopeTag} ${filterTag}</div>
        <div class="price">
          <strong>${eur(current)}</strong>
          ${baseline ? `<small>beim Merken: ${eur(baseline)}</small>` : ''}
          ${drop}
          ${w.currentBest ? flightChip(w.currentBest.flightIncluded) : ''}
        </div>
        <div class="actions">
          <button class="remove" data-token="${escapeHtml(w.token)}">Entfernen</button>
        </div>
      </li>`;
  }).join('');

  watchlistList.querySelectorAll('button[data-token]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await fetch(`/api/watch/${b.dataset.token}`, { method: 'DELETE' });
      if (r.ok) loadWatchlist(email);
    });
  });
  watchlistList.querySelectorAll('a[data-route-detail]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); openRouteDetail(a.dataset.routeDetail); });
  });
}

const savedEmail = localStorage.getItem('aida-email');
if (savedEmail) watchlistForm.email.value = savedEmail;

loadFilters().then(loadRoutes);
