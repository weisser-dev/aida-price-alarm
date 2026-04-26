const eur = (n) =>
  n == null ? '–' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const fmtDate = (s) => {
  if (!s) return '–';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('de-DE');
};
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const flightLabel = (v) => v === 'with' ? 'mit Flug' : v === 'without' ? 'ohne Flug' : 'Flug egal';

// ----- Navigation -----
const VIEWS = ['cruises', 'routes', 'route-detail', 'promotions', 'watchlist'];
const navButtons = document.querySelectorAll('header nav button[data-view]');
function switchTo(view) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.hidden = (v !== view);
  }
  navButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'routes') loadRoutes();
  if (view === 'promotions') loadPromotions();
}
navButtons.forEach((b) => b.addEventListener('click', () => switchTo(b.dataset.view)));

// ----- Shared cabin state -----
const filters = document.getElementById('filters');
const cabinChips = document.getElementById('cabin-chips');
const cruiseList = document.getElementById('cruise-list');
const statusLine = document.getElementById('status-line');
const dialog = document.getElementById('watch-dialog');
const watchTitle = document.getElementById('watch-title');
const watchSubtitle = document.getElementById('watch-subtitle');
const watchForm = document.getElementById('watch-form');
const watchCabinChips = document.getElementById('watch-cabin-chips');

let pendingCruiseId = null;
let availableCabins = [];

filters.addEventListener('submit', (e) => { e.preventDefault(); loadCruises(); });
filters.addEventListener('reset', () => setTimeout(loadCruises, 0));

async function loadFilters() {
  const r = await fetch('/api/cruises/filters').then((x) => x.json());
  for (const sel of [
    filters.querySelector('select[name=ship]'),
    document.querySelector('#route-filters select[name=ship]'),
    document.querySelector('#promo-filters select[name=ship]'),
  ]) {
    for (const s of r.ships) sel.insertAdjacentHTML('beforeend', `<option>${escapeHtml(s)}</option>`);
  }
  for (const sel of [
    filters.querySelector('select[name=destination]'),
    document.querySelector('#route-filters select[name=destination]'),
    document.querySelector('#promo-filters select[name=destination]'),
  ]) {
    for (const d of r.destinations) sel.insertAdjacentHTML('beforeend', `<option>${escapeHtml(d)}</option>`);
  }

  availableCabins = r.cabinTypes;
  cabinChips.innerHTML = availableCabins.map((c) =>
    `<label class="chip"><input type="checkbox" name="cabinType" value="${escapeHtml(c)}"> ${escapeHtml(c)}</label>`
  ).join('');
  document.getElementById('promo-cabin-chips').innerHTML = availableCabins.map((c) =>
    `<label class="chip"><input type="checkbox" name="cabinType" value="${escapeHtml(c)}"> ${escapeHtml(c)}</label>`
  ).join('');
  watchCabinChips.innerHTML = availableCabins.map((c) =>
    `<label class="chip"><input type="checkbox" name="cabinTypes" value="${escapeHtml(c)}" checked> ${escapeHtml(c)}</label>`
  ).join('');
}

// ----- Cruises view -----
async function loadCruises() {
  const params = new URLSearchParams();
  const fd = new FormData(filters);
  for (const k of ['q', 'ship', 'destination', 'departsFrom', 'departsTo', 'flight']) {
    const v = fd.get(k);
    if (v) params.set(k, v);
  }
  const cabins = fd.getAll('cabinType').filter(Boolean);
  if (cabins.length) params.set('cabinType', cabins.join(','));
  params.set('limit', '120');

  statusLine.textContent = 'Lade Reisen…';
  const data = await fetch(`/api/cruises?${params}`).then((r) => r.json());
  const filtered = (data.shown !== undefined && data.shown !== data.total)
    ? `${data.shown} von ${data.total} Reisen`
    : `${data.total} Reisen`;
  statusLine.textContent = filtered + ' gefunden';

  cruiseList.innerHTML = data.items.map((c) => renderCruiseCard(c)).join('') ||
    `<li class="muted">Keine Reisen gefunden – Filter ggf. lockern.</li>`;

  cruiseList.querySelectorAll('button[data-watch]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog(b.dataset.watch, b.dataset.title, b.dataset.subtitle));
  });
}

function renderCruiseCard(c) {
  const price = c.bestFare ? eur(c.bestFare.priceEur) : '–';
  const fareTag = c.bestFare
    ? `<span class="tag">${escapeHtml(c.bestFare.name || c.bestFare.code)}${c.bestFare.cabinType ? ' · ' + escapeHtml(c.bestFare.cabinType) : ''}</span>${c.bestFare.withFlight ? '<span class="tag">inkl. Flug</span>' : '<span class="tag muted-tag">ohne Flug</span>'}`
    : '<span class="tag err">nicht verfügbar</span>';
  const subtitle = `${c.ship || ''} · ${fmtDate(c.departsAt)} – ${fmtDate(c.returnsAt)} · ${c.durationNights || '?'} Nächte`;
  return `
    <li class="card">
      <h3>${escapeHtml(c.title)}</h3>
      <div class="meta">${escapeHtml(subtitle)}</div>
      <div class="meta">${escapeHtml(c.departurePort || '')} → ${escapeHtml(c.arrivalPort || '')}</div>
      <div class="price"><strong>${price}</strong>${fareTag}</div>
      <div class="actions">
        ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">Zur Reise</a>` : ''}
        <button data-watch="${escapeHtml(c.id)}" data-title="${escapeHtml(c.title)}" data-subtitle="${escapeHtml(subtitle)}">Merken</button>
      </div>
    </li>`;
}

// ----- Routes view -----
const routeFilters = document.getElementById('route-filters');
const routeList = document.getElementById('route-list');
const routeStatus = document.getElementById('route-status');
const routeDetailBody = document.getElementById('route-detail-body');
const routeBack = document.getElementById('route-back');

routeFilters.addEventListener('submit', (e) => { e.preventDefault(); loadRoutes(); });
routeFilters.addEventListener('reset', () => setTimeout(loadRoutes, 0));
routeBack.addEventListener('click', () => switchTo('routes'));

async function loadRoutes() {
  const params = new URLSearchParams();
  const fd = new FormData(routeFilters);
  for (const k of ['q', 'ship', 'destination', 'flight']) {
    const v = fd.get(k);
    if (v) params.set(k, v);
  }
  routeStatus.textContent = 'Lade Routen…';
  const data = await fetch(`/api/routes?${params}`).then((r) => r.json());
  routeStatus.textContent = `${data.total} Routen mit aktueller Verfügbarkeit`;
  routeList.innerHTML = data.items.map(renderRouteCard).join('') ||
    `<li class="muted">Keine Routen gefunden.</li>`;
  routeList.querySelectorAll('button[data-route]').forEach((b) => {
    b.addEventListener('click', () => openRouteDetail(b.dataset.route));
  });
}

function renderRouteCard(r) {
  const promoBadge = r.currentPromoDepartures
    ? `<span class="tag drop">${r.currentPromoDepartures} aktive Aktion${r.currentPromoDepartures === 1 ? '' : 'en'}</span>`
    : '';
  const timing = r.promoStats
    ? `<div class="meta">⌀ Aktionsstart ca. <strong>${r.promoStats.avgDaysBeforeDeparture} Tage</strong> vor Abfahrt (${r.promoStats.promoSamples} Beobachtungen)</div>`
    : '<div class="meta muted">Noch keine Aktionsmuster erfasst.</div>';

  const cabinBadges = r.perCabin.filter((c) => c.lowestCurrent != null).map((c) => `
    <div class="cabin-badge">
      <span class="cabin-name">${escapeHtml(c.cabinType)}</span>
      <span class="cabin-price">${eur(c.lowestCurrent)}</span>
      ${c.lowestEver != null && c.lowestEver < c.lowestCurrent
        ? `<span class="cabin-low muted small">Tief: ${eur(c.lowestEver)}</span>`
        : ''}
      ${c.lowestCurrentIsPromo ? '<span class="tag drop small">Aktion</span>' : ''}
    </div>
  `).join('');

  return `
    <li class="card route-card">
      <h3>${escapeHtml(r.destination)} mit ${escapeHtml(r.ship)}</h3>
      <div class="meta">${r.durationNights} Nächte · ${escapeHtml(r.departurePort || '')} → ${escapeHtml(r.arrivalPort || '')}</div>
      <div class="meta">${r.departureCount} Abfahrten zwischen ${fmtDate(r.firstDeparture)} und ${fmtDate(r.lastDeparture)} ${promoBadge}</div>
      ${timing}
      <div class="cabins">${cabinBadges || '<span class="muted small">Keine Preise</span>'}</div>
      <div class="price">
        <strong>ab ${eur(r.lowestCurrentPrice)}</strong>
        ${r.avgCurrentPrice ? `<small>⌀ ${eur(r.avgCurrentPrice)} · max ${eur(r.highestCurrentPrice)}</small>` : ''}
      </div>
      <div class="actions">
        <button data-route="${escapeHtml(r.routeKey)}">Alle Abfahrten ansehen</button>
      </div>
    </li>`;
}

async function openRouteDetail(routeKey) {
  switchTo('route-detail');
  routeDetailBody.innerHTML = '<p class="muted">Lade…</p>';
  const flightSel = routeFilters.querySelector('select[name=flight]');
  const flight = flightSel ? flightSel.value : 'any';
  const params = new URLSearchParams({ flight });
  const r = await fetch(`/api/routes/${encodeURIComponent(routeKey)}?${params}`).then((x) => x.json());
  if (!r || r.error) {
    routeDetailBody.innerHTML = '<p class="muted">Route nicht gefunden.</p>';
    return;
  }
  routeDetailBody.innerHTML = renderRouteDetail(r);
  routeDetailBody.querySelectorAll('button[data-watch]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog(b.dataset.watch, b.dataset.title, b.dataset.subtitle));
  });
}

function renderRouteDetail(r) {
  const cabinSummary = r.perCabin.filter((c) => c.lowestCurrent != null || c.lowestEver != null).map((c) => `
    <tr>
      <td><strong>${escapeHtml(c.cabinType)}</strong></td>
      <td>${c.lowestCurrent != null ? eur(c.lowestCurrent) : '–'}${c.lowestCurrentIsPromo ? ' <span class="tag drop small">Aktion</span>' : ''}</td>
      <td>${c.lowestEver != null ? eur(c.lowestEver) : '–'}</td>
      <td>${c.promoOffersNow}</td>
    </tr>
  `).join('');

  const promoBlock = r.promoStats
    ? `<p class="meta">Diese Route geht im Schnitt <strong>${r.promoStats.avgDaysBeforeDeparture} Tage</strong> vor Abfahrt in den Aktionspreis (Median ${r.promoStats.medianDaysBeforeDeparture} Tage, frühestens ${r.promoStats.earliestPromoDaysBeforeDeparture} Tage, spätestens ${r.promoStats.latestPromoDaysBeforeDeparture} Tage). Basis: ${r.promoStats.promoSamples} Beobachtungen.</p>`
    : '<p class="meta muted">Noch keine Aktionspreise für diese Route erfasst.</p>';

  const departureRows = r.departures.map((d) => {
    const cabinCells = r.perCabin.map((c) => {
      const dep = d.perCabin.find((x) => x.cabinType === c.cabinType);
      if (!dep || dep.price == null) return `<td class="muted">–</td>`;
      const promoBadge = dep.isPromo ? `<br><span class="tag drop small">${escapeHtml(dep.promoLabel || 'Aktion')}</span>` : '';
      const days = dep.daysBeforeDeparture != null ? `<br><span class="muted small">erfasst ${dep.daysBeforeDeparture} T. v. Abfahrt</span>` : '';
      return `<td>${eur(dep.price)}${promoBadge}${days}</td>`;
    }).join('');
    const subtitle = `${r.ship} · ${fmtDate(d.departsAt)} – ${fmtDate(d.returnsAt)} · ${r.durationNights} Nächte`;
    return `
      <tr>
        <td>
          <strong>${fmtDate(d.departsAt)}</strong>
          <br><span class="muted small">– ${fmtDate(d.returnsAt)}</span>
          <br><button class="link small" data-watch="${escapeHtml(d.cruiseId)}" data-title="${escapeHtml(r.title)}" data-subtitle="${escapeHtml(subtitle)}">merken</button>
          ${d.url ? ` · <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener" class="link small">Detail</a>` : ''}
        </td>
        ${cabinCells}
      </tr>`;
  }).join('');

  const cabinHeaderCells = r.perCabin.map((c) => `<th>${escapeHtml(c.cabinType)}</th>`).join('');

  return `
    <h2>${escapeHtml(r.destination)} mit ${escapeHtml(r.ship)}</h2>
    <p class="meta">${r.durationNights} Nächte · ${escapeHtml(r.departurePort || '')} → ${escapeHtml(r.arrivalPort || '')} · ${r.departureCount} Abfahrten</p>

    <h3>Preisübersicht je Kabinenart</h3>
    <table class="ptable">
      <thead><tr><th>Kabine</th><th>Aktuell ab</th><th>Tiefpreis (alle Termine)</th><th>aktive Aktionen</th></tr></thead>
      <tbody>${cabinSummary || '<tr><td colspan="4" class="muted">Keine Preise</td></tr>'}</tbody>
    </table>

    <h3>Aktionsmuster</h3>
    ${promoBlock}

    <h3>Alle Abfahrten</h3>
    <div class="ptable-wrap">
      <table class="ptable">
        <thead><tr><th>Termin</th>${cabinHeaderCells}</tr></thead>
        <tbody>${departureRows}</tbody>
      </table>
    </div>
  `;
}

// ----- Promotions view -----
const promoFilters = document.getElementById('promo-filters');
const promoList = document.getElementById('promo-list');
const promoStatus = document.getElementById('promo-status');

promoFilters.addEventListener('submit', (e) => { e.preventDefault(); loadPromotions(); });
promoFilters.addEventListener('reset', () => setTimeout(loadPromotions, 0));

async function loadPromotions() {
  const params = new URLSearchParams();
  const fd = new FormData(promoFilters);
  for (const k of ['ship', 'destination', 'flight']) {
    const v = fd.get(k);
    if (v) params.set(k, v);
  }
  const cabins = fd.getAll('cabinType').filter(Boolean);
  if (cabins.length) params.set('cabinType', cabins.join(','));
  promoStatus.textContent = 'Lade Aktionen…';
  const data = await fetch(`/api/promotions?${params}`).then((r) => r.json());
  promoStatus.textContent = `${data.total} aktuell rabattierte Tarife`;
  promoList.innerHTML = data.items.map(renderPromoCard).join('') ||
    `<li class="muted">Keine aktiven Aktionen gefunden.</li>`;
  promoList.querySelectorAll('button[data-watch]').forEach((b) => {
    b.addEventListener('click', () => openWatchDialog(b.dataset.watch, b.dataset.title, b.dataset.subtitle));
  });
}

function renderPromoCard(p) {
  const subtitle = `${p.ship || ''} · ${fmtDate(p.departsAt)} – ${fmtDate(p.returnsAt)} · ${p.durationNights || '?'} Nächte`;
  const discount = p.promo.discountPercent != null
    ? `<span class="tag drop">−${p.promo.discountPercent}%</span>`
    : '<span class="tag">Aktion</span>';
  const previous = p.promo.regularPrice
    ? `<small><s>${eur(p.promo.regularPrice)}</s></small>`
    : '';
  return `
    <li class="card">
      <h3>${escapeHtml(p.title)}</h3>
      <div class="meta">${escapeHtml(subtitle)}</div>
      <div class="meta">${escapeHtml(p.departurePort || '')} → ${escapeHtml(p.arrivalPort || '')}</div>
      <div class="meta">
        <span class="tag">${escapeHtml(p.promo.label)}</span>
        <span class="tag">${escapeHtml(p.promo.cabinType || p.promo.fareName || p.promo.fareCode)}</span>
        ${p.promo.withFlight ? '<span class="tag">inkl. Flug</span>' : '<span class="tag muted-tag">ohne Flug</span>'}
      </div>
      <div class="price">
        <strong>${eur(p.promo.currentPrice)}</strong>
        ${previous}
        ${discount}
      </div>
      <div class="meta muted small">erfasst ${p.promo.daysBeforeDeparture} Tage vor Abfahrt</div>
      <div class="actions">
        ${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Zur Reise</a>` : ''}
        <button data-watch="${escapeHtml(p.cruiseId)}" data-title="${escapeHtml(p.title)}" data-subtitle="${escapeHtml(subtitle)}">Merken</button>
      </div>
    </li>`;
}

// ----- Watch dialog -----
function openWatchDialog(cruiseId, title, subtitle) {
  pendingCruiseId = cruiseId;
  watchTitle.textContent = `Merken: ${title}`;
  watchSubtitle.textContent = subtitle;
  watchForm.querySelector('input[name=email]').value = localStorage.getItem('aida-email') || '';

  const activeCabins = new Set(
    new FormData(filters).getAll('cabinType').filter(Boolean)
  );
  watchCabinChips.querySelectorAll('input[name=cabinTypes]').forEach((cb) => {
    cb.checked = activeCabins.size === 0 || activeCabins.has(cb.value);
  });

  const filterFlight = new FormData(filters).get('flight') || 'any';
  watchForm.querySelector(`input[name=flightOption][value="${filterFlight}"]`)?.click();

  dialog.showModal();
}

watchForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const fd = new FormData(watchForm);
  const email = String(fd.get('email') || '').trim().toLowerCase();
  const cabinTypes = fd.getAll('cabinTypes').filter(Boolean);
  const flightOption = fd.get('flightOption') || 'any';
  if (!email || !pendingCruiseId) { dialog.close(); return; }

  const res = await fetch('/api/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, cruiseId: pendingCruiseId, cabinTypes, flightOption }),
  });
  const data = await res.json();
  if (!res.ok) { alert('Fehler: ' + (data.error || res.status)); return; }
  localStorage.setItem('aida-email', email);
  dialog.close();
  const baseTxt = data.baseline
    ? `Baseline ${eur(data.baseline.price)} – ${data.baseline.cabin || data.baseline.fare}${data.baseline.withFlight ? ', inkl. Flug' : ''}`
    : 'aktuell kein Tarif in deiner Auswahl verfügbar';
  alert(`Reise gemerkt. ${baseTxt}. Wir melden uns per Mail, sobald der Preis günstiger wird.`);
});

// ----- Watchlist view -----
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
    const baseline = w.baseline?.price;
    const current = w.currentBest?.priceEur;
    let drop = '';
    if (baseline && current && current < baseline) {
      const pct = Math.round((1 - current / baseline) * 100);
      drop = `<span class="tag drop">−${pct}% seit Merken</span>`;
    } else if (baseline && current && current > baseline) {
      const pct = Math.round((current / baseline - 1) * 100);
      drop = `<span class="tag warn">+${pct}% seit Merken</span>`;
    }
    const subtitle = `${w.ship || ''} · ${fmtDate(w.departsAt)} – ${fmtDate(w.returnsAt)} · ${w.durationNights || '?'} Nächte`;
    const cabinFilter = w.filters?.cabinTypes?.length ? w.filters.cabinTypes.join(', ') : 'alle Kabinen';
    const filterTag = `<span class="tag">${escapeHtml(cabinFilter)} · ${escapeHtml(flightLabel(w.filters?.flightOption))}</span>`;
    return `
      <li class="card">
        <h3>${escapeHtml(w.title)}</h3>
        <div class="meta">${escapeHtml(subtitle)}</div>
        <div class="meta">${filterTag}</div>
        <div class="price">
          <strong>${eur(current)}</strong>
          ${baseline ? `<small>beim Merken: ${eur(baseline)}</small>` : ''}
          ${drop}
        </div>
        <div class="actions">
          ${w.url ? `<a href="${escapeHtml(w.url)}" target="_blank" rel="noopener">Zur Reise</a>` : ''}
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
}

const savedEmail = localStorage.getItem('aida-email');
if (savedEmail) watchlistForm.email.value = savedEmail;

loadFilters().then(loadCruises);
