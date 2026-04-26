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

const navCruises = document.getElementById('nav-cruises');
const navWatchlist = document.getElementById('nav-watchlist');
const viewCruises = document.getElementById('view-cruises');
const viewWatchlist = document.getElementById('view-watchlist');

navCruises.addEventListener('click', () => switchTo('cruises'));
navWatchlist.addEventListener('click', () => switchTo('watchlist'));
function switchTo(view) {
  const cruises = view === 'cruises';
  viewCruises.hidden = !cruises;
  viewWatchlist.hidden = cruises;
  navCruises.classList.toggle('active', cruises);
  navWatchlist.classList.toggle('active', !cruises);
}

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
  const shipSel = filters.querySelector('select[name=ship]');
  const destSel = filters.querySelector('select[name=destination]');
  for (const s of r.ships) shipSel.insertAdjacentHTML('beforeend', `<option>${escapeHtml(s)}</option>`);
  for (const d of r.destinations) destSel.insertAdjacentHTML('beforeend', `<option>${escapeHtml(d)}</option>`);

  availableCabins = r.cabinTypes;
  cabinChips.innerHTML = availableCabins.map((c) =>
    `<label class="chip"><input type="checkbox" name="cabinType" value="${escapeHtml(c)}"> ${escapeHtml(c)}</label>`
  ).join('');
  watchCabinChips.innerHTML = availableCabins.map((c) =>
    `<label class="chip"><input type="checkbox" name="cabinTypes" value="${escapeHtml(c)}" checked> ${escapeHtml(c)}</label>`
  ).join('');
}

async function loadCruises() {
  const params = new URLSearchParams();
  const fd = new FormData(filters);
  // Single-value fields
  for (const k of ['q', 'ship', 'destination', 'departsFrom', 'departsTo', 'flight']) {
    const v = fd.get(k);
    if (v) params.set(k, v);
  }
  // Multi-value cabinType
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

function openWatchDialog(cruiseId, title, subtitle) {
  pendingCruiseId = cruiseId;
  watchTitle.textContent = `Merken: ${title}`;
  watchSubtitle.textContent = subtitle;
  watchForm.querySelector('input[name=email]').value = localStorage.getItem('aida-email') || '';

  // Pre-select the cabin filters that are active in the main view, otherwise all checked.
  const activeCabins = new Set(
    new FormData(filters).getAll('cabinType').filter(Boolean)
  );
  watchCabinChips.querySelectorAll('input[name=cabinTypes]').forEach((cb) => {
    cb.checked = activeCabins.size === 0 || activeCabins.has(cb.value);
  });

  // Inherit the flight option from the main filter
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

// Watchlist view
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
