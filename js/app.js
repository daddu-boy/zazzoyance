import { $, $$, esc, uid, toast, hideToast, todayISO, daysSince, resizeImage, cropImage, dominantColorName, blobURL, blobToDataURL, dataURLToBlob, openSheet, closeSheet } from './util.js';
import * as db from './db.js';
import * as wx from './weather.js';
import * as ai from './ai.js';
import { CATEGORIES, OCCASIONS, SEASONS, suggestOffline, weatherAdvice } from './stylist.js';

const state = {
  items: [],
  looks: [],
  settings: {},
  place: null,
  weather: null,
  dayIdx: 0,
  occasion: 'casual',
  closetTab: 'items',
  cat: 'all',
  chat: [],
  chatImage: null,
  aiMode: 'off',
  pending: null, // review sheet contents
};

// ---------------- boot ----------------

async function boot() {
  [state.items, state.looks, state.settings, state.chat] = await Promise.all([
    db.all('items'), db.all('looks'), db.kvGet('settings', {}), db.kvGet('chat', []),
  ]);
  state.items.sort((a, b) => b.createdAt - a.createdAt);
  state.looks.sort((a, b) => b.createdAt - a.createdAt);
  state.occasion = (await db.kvGet('lastOccasion', null)) || defaultOccasion();

  wireNav();
  wireToday();
  wireCloset();
  wireChat();
  wireSettings();
  wireSheets();

  renderOccasions();
  renderCloset();
  renderChat();
  loadSettingsForm();
  refreshAi();
  loadWeather();
  db.persist();

  const start = location.hash.slice(1);
  if (['today', 'closet', 'stylist', 'settings'].includes(start)) go(start);
  else if (!state.items.length) go('closet');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function defaultOccasion() {
  const d = new Date().getDay();
  return d === 0 || d === 6 ? 'casual' : 'work';
}

async function refreshAi() {
  state.aiMode = await ai.mode();
  const pill = $('#aiPill');
  pill.classList.toggle('on', state.aiMode !== 'off');
  pill.textContent = state.aiMode === 'off' ? 'AI off' : 'AI stylist on';
  const srv = await ai.checkServer();
  $('#aiExplain').textContent = state.aiMode === 'server'
    ? 'Connected through this site\'s shared OpenAI account. Nothing to set up. You can still paste your own key below to use yours instead.'
    : state.aiMode === 'key'
      ? 'Using your own OpenAI key from this phone.'
      : srv.configured && srv.passcode
        ? 'This site has AI, but it\'s locked. Enter the passcode the owner gave you — or paste your own OpenAI key.'
        : 'AI is off. Drape still works — you tag clothes yourself and a built-in stylist picks outfits. Paste an OpenAI API key to switch on photo recognition and the chat stylist.';
}

// ---------------- navigation ----------------

function go(view) {
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.go === view));
  history.replaceState(null, '', `#${view}`);
  window.scrollTo(0, view === 'stylist' ? document.body.scrollHeight : 0);
  if (view === 'stylist') setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 30);
}

function wireNav() {
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) go(g.dataset.go);
  });
}

function wireSheets() {
  $$('dialog.sheet').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close(); // tap on backdrop
      if (e.target.closest('[data-close]')) d.close();
    });
  });
}

// ---------------- weather + today ----------------

async function loadWeather(force = false) {
  const card = $('#weatherCard');
  const cached = await wx.cachedWeather();
  if (cached && !force) {
    state.place = cached.place;
    state.weather = cached.data;
    renderWeather();
    if (Date.now() - cached.data.fetchedAt < 20 * 60 * 1000) return;
  }
  try {
    state.place = await wx.resolvePlace();
    state.weather = await wx.fetchWeather(state.place);
    renderWeather();
  } catch (err) {
    if (!state.weather) card.innerHTML = `<div class="muted">Couldn't load weather — ${esc(err.message)}. <button class="link" id="retryWx">Retry</button></div>`;
    $('#retryWx')?.addEventListener('click', () => loadWeather(true));
  }
}

function currentDay() {
  return state.weather?.days[state.dayIdx];
}

function renderWeather() {
  const w = state.weather, d = currentDay(), unit = state.settings.unit || 'c';
  if (!w || !d) return;
  const [label, icon] = wx.describe(state.dayIdx === 0 ? w.current.code : d.code);
  const big = state.dayIdx === 0 ? w.current.temp : d.max;
  $('#weatherCard').innerHTML = `
    <div class="temp">${wx.fmtTemp(big, unit)}</div>
    <div class="place">${esc(state.place.name)}</div>
    <div class="muted">${icon} ${esc(label)} · ${wx.fmtTemp(d.min, unit)} / ${wx.fmtTemp(d.max, unit)}</div>
    <div class="facts">
      <span>Feels ${wx.fmtTemp(d.feelsMin, unit)}–${wx.fmtTemp(d.feelsMax, unit)}</span>
      <span>☔ ${d.rainChance}%</span>
      <span>UV ${Math.round(d.uv)}</span>
      <span>💨 ${Math.round(d.wind)} km/h</span>
    </div>
    <div class="advice">${esc(weatherAdvice(d))}</div>`;
}

function renderOccasions() {
  $('#occasionChips').innerHTML = OCCASIONS.map((o) =>
    `<button class="chip ${o.id === state.occasion ? 'on' : ''}" data-occ="${o.id}">${esc(o.label)}</button>`).join('');
}

function wireToday() {
  $('#daySeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.dayIdx = Number(b.dataset.day);
    $$('#daySeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderWeather();
    $('#suggestions').innerHTML = '';
  });
  $('#occasionChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-occ]');
    if (!b) return;
    state.occasion = b.dataset.occ;
    db.kvSet('lastOccasion', state.occasion);
    renderOccasions();
  });
  $('#styleMe').addEventListener('click', styleMe);
  $('#changePlace').addEventListener('click', () => {
    $('#placeResults').innerHTML = '';
    openSheet($('#placeSheet'));
  });
  $('#suggestions').addEventListener('click', onSuggestionClick);
}

let lastOutfits = [];

async function styleMe() {
  const box = $('#suggestions');
  if (!state.items.length) {
    box.innerHTML = `<div class="card empty"><strong>Your closet is empty</strong>Add a few pieces first — a handful of tops, bottoms and shoes is enough to start.<br><br><button class="btn primary" data-go="closet">Go to closet</button></div>`;
    return;
  }
  if (!state.weather) await loadWeather(true);
  const day = currentDay();
  if (!day) { toast('Weather is still loading — try again in a moment.'); return; }
  const occasion = OCCASIONS.find((o) => o.id === state.occasion);
  const btn = $('#styleMe');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Styling…';
  let result, source = 'offline', note = '';
  try {
    if (state.aiMode !== 'off') {
      try {
        result = await ai.suggestOutfits({
          items: state.items,
          profile: state.settings,
          weatherText: wx.summarize(state.place, state.weather, state.dayIdx, 'c'),
          occasion,
        });
        source = 'ai';
      } catch (err) {
        note = `AI stylist unavailable (${err.message}) — showing built-in picks.`;
      }
    }
    if (!result) result = suggestOffline(state.items, day, state.occasion, { dayOffset: state.dayIdx });
    lastOutfits = result.outfits;
    renderSuggestions(result, source, note);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Style me again';
  }
}

function renderSuggestions({ outfits, missing }, source, note) {
  const box = $('#suggestions');
  if (!outfits.length) {
    box.innerHTML = `<div class="card empty"><strong>Not enough to build an outfit</strong>${esc(missing || 'Add at least a top and a bottom, or a dress.')}</div>`;
    return;
  }
  box.innerHTML = (note ? `<p class="small muted">${esc(note)}</p>` : '') + outfits.map((o, i) => `
    <article class="card outfit" style="margin-top:12px">
      <h3>${esc(o.title)}</h3>
      <div class="outfit-pieces">${o.items.map(pieceHTML).join('')}</div>
      ${o.why ? `<div class="why">${esc(o.why)}</div>` : ''}
      ${o.tip ? `<div class="tip">${esc(o.tip)}</div>` : ''}
      <div class="row">
        <button class="btn primary" data-wear="${i}">I'll wear this</button>
        <button class="btn ghost" data-discuss="${i}">Ask the stylist</button>
      </div>
    </article>`).join('') +
    (missing ? `<p class="small muted" style="margin-top:12px">💡 ${esc(missing)}</p>` : '') +
    `<p class="small muted center" style="margin-top:8px">${source === 'ai' ? 'Styled by AI from your closet' : 'Built-in stylist · switch on AI in the You tab for smarter picks'}</p>`;
}

function pieceHTML(item) {
  return `<button class="piece" data-item="${item.id}"><img src="${blobURL(item.image)}" alt=""><span>${esc(item.name)}</span></button>`;
}

async function onSuggestionClick(e) {
  const p = e.target.closest('[data-item]');
  if (p) return openItem(p.dataset.item);
  const w = e.target.closest('[data-wear]');
  if (w) {
    const o = lastOutfits[Number(w.dataset.wear)];
    await logWear(o.items.map((i) => i.id), todayISO(state.dayIdx));
    w.textContent = state.dayIdx === 0 ? 'Logged for today ✓' : 'Planned for tomorrow ✓';
    w.disabled = true;
    return;
  }
  const d = e.target.closest('[data-discuss]');
  if (d) {
    const o = lastOutfits[Number(d.dataset.discuss)];
    go('stylist');
    $('#chatInput').value = `About this outfit: ${o.items.map((i) => `${i.name} [[${i.id}]]`).join(', ')}. `;
    $('#chatInput').focus();
    autoGrow();
  }
}

async function logWear(ids, date) {
  for (const id of ids) {
    const it = state.items.find((x) => x.id === id);
    if (!it) continue;
    it.wornCount = (it.wornCount || 0) + 1;
    if (!it.lastWorn || it.lastWorn < date) it.lastWorn = date;
    await db.put('items', it);
  }
  const hist = await db.kvGet('history', []);
  hist.push({ date, itemIds: ids, occasion: state.occasion });
  await db.kvSet('history', hist.slice(-365));
}

// place sheet
async function choosePlace(p) {
  await wx.setPlace(p);
  closeSheet($('#placeSheet'));
  state.place = p;
  $('#weatherCard').innerHTML = '<div class="muted">Loading weather…</div>';
  try {
    state.weather = await wx.fetchWeather(p);
    renderWeather();
  } catch (err) {
    toast(err.message);
  }
  $('#suggestions').innerHTML = '';
}

function wirePlace() {
  $('#useGps').addEventListener('click', async () => {
    const b = $('#useGps');
    b.disabled = true;
    try {
      const p = await wx.placeFromGps();
      await choosePlace(p);
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
  });
  let results = [];
  $('#placeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#placeQuery').value.trim();
    if (!q) return;
    $('#placeResults').innerHTML = '<p class="muted small"><span class="spinner"></span>Searching…</p>';
    try {
      results = await wx.searchCity(q);
      $('#placeResults').innerHTML = results.length
        ? results.map((r, i) => `<button class="btn place-result" data-place="${i}"><strong>${esc(r.name)}</strong> <span class="muted small">${esc(r.detail)}</span></button>`).join('')
        : '<p class="muted small">No places found.</p>';
    } catch {
      $('#placeResults').innerHTML = '<p class="muted small">Search failed — check your connection.</p>';
    }
  });
  $('#placeResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-place]');
    if (b) choosePlace(results[Number(b.dataset.place)]);
  });
}

// ---------------- closet ----------------

function wireCloset() {
  wirePlace();
  $('#closetSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.closetTab = b.dataset.tab;
    $$('#closetSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderCloset();
  });
  $('#catFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.cat = b.dataset.cat;
    renderCloset();
  });
  $('#closetGrid').addEventListener('click', (e) => {
    const t = e.target.closest('[data-item]');
    if (t) return openItem(t.dataset.item);
    const l = e.target.closest('[data-look]');
    if (l) return openLook(l.dataset.look);
    if (e.target.closest('[data-add]')) openSheet($('#addSheet'));
  });
  $('#addBtn').addEventListener('click', () => openSheet($('#addSheet')));

  const pickers = {
    'garment-camera': ['#pickGarmentCamera', 'garment'],
    'garment-gallery': ['#pickGarmentGallery', 'garment'],
    'person-camera': ['#pickPersonCamera', 'person'],
    'person-gallery': ['#pickPersonGallery', 'person'],
  };
  $('#addSheet').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    closeSheet($('#addSheet'));
    $(pickers[b.dataset.pick][0]).click();
  });
  for (const [sel, kind] of Object.values(pickers)) {
    const input = $(sel);
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      if (files.length) processPhotos(files, kind);
    });
  }
  $('#reviewSheet').addEventListener('input', onReviewInput);
  $('#reviewSheet').addEventListener('change', onReviewInput);
  $('#reviewSave').addEventListener('click', saveReview);
  $('#reviewSheet').addEventListener('close', () => { state.pending = null; });
}

function renderCloset() {
  const grid = $('#closetGrid');
  const filter = $('#catFilter');
  if (state.closetTab === 'looks') {
    filter.hidden = true;
    $('#closetCount').textContent = `${state.looks.length} look${state.looks.length === 1 ? '' : 's'}`;
    grid.innerHTML = state.looks.length
      ? state.looks.map((l) => `<button class="tile" data-look="${l.id}"><img src="${blobURL(l.image)}" alt="" loading="lazy"><span class="label">${esc(l.description || new Date(l.createdAt).toLocaleDateString())}</span></button>`).join('')
      : `<div class="empty" style="grid-column:1/-1"><strong>No looks yet</strong>Add photos of yourself in an outfit — Drape saves the outfit here and adds each piece to your closet.<br><br><button class="btn primary" data-add>Add a photo</button></div>`;
    return;
  }
  filter.hidden = false;
  const counts = {};
  state.items.forEach((i) => (counts[i.category] = (counts[i.category] || 0) + 1));
  filter.innerHTML = [['all', `All ${state.items.length}`], ['fav', '♥ Favourites'], ...Object.entries(CATEGORIES).filter(([k]) => counts[k]).map(([k, v]) => [k, `${v} ${counts[k]}`])]
    .map(([k, v]) => `<button class="chip ${state.cat === k ? 'on' : ''}" data-cat="${k}">${esc(v)}</button>`).join('');
  const list = state.items.filter((i) => state.cat === 'all' || (state.cat === 'fav' ? i.favorite : i.category === state.cat));
  $('#closetCount').textContent = `${state.items.length} piece${state.items.length === 1 ? '' : 's'}`;
  grid.innerHTML = list.length
    ? list.map((i) => `<button class="tile" data-item="${i.id}"><img src="${blobURL(i.image)}" alt="" loading="lazy">${i.favorite ? '<span class="fav">♥</span>' : ''}<span class="label">${esc(i.name)}</span></button>`).join('')
    : state.items.length
      ? '<div class="empty" style="grid-column:1/-1">Nothing here yet.</div>'
      : `<div class="empty" style="grid-column:1/-1"><strong>Build your closet</strong>Photograph your clothes one at a time, or add photos of yourself wearing them — Drape will pick out each piece.<br><br><button class="btn primary" data-add>Add clothes</button></div>`;
}

async function processPhotos(files, kind) {
  const aiOn = state.aiMode !== 'off';
  const pending = { entries: [], looks: [] };
  let failed = 0, lastErr = '';
  for (let n = 0; n < files.length; n++) {
    toast(`<span class="spinner"></span>${aiOn ? 'Reading' : 'Preparing'} photo ${n + 1} of ${files.length}…`, 0);
    let photo;
    try {
      photo = await resizeImage(files[n], 1024);
    } catch {
      failed++; lastErr = 'That file could not be opened as an image.';
      continue;
    }
    const lookIdx = kind === 'person' ? pending.looks.push({ image: photo, description: '' }) - 1 : null;
    let detected = null;
    if (aiOn) {
      try {
        const res = await ai.tagPhoto(photo, kind);
        detected = res.items;
        if (lookIdx !== null) pending.looks[lookIdx].description = res.look;
      } catch (err) {
        failed++; lastErr = err.message;
      }
    }
    if (detected && detected.length) {
      for (const d of detected) {
        const crop = kind === 'person' || detected.length > 1 ? await cropImage(photo, d.bbox) : photo;
        pending.entries.push({ ...d, image: crop, include: true, lookIdx });
      }
    } else if (detected) {
      if (lookIdx === null) pending.entries.push({ ...ai.cleanItem({ name: '' }), image: photo, include: false, lookIdx, emptyHint: true });
    } else {
      // Manual path: one entry per photo, user fills the details.
      const color = await dominantColorName(photo);
      pending.entries.push({
        ...ai.cleanItem({ name: '', colors: color ? [color] : [], category: kind === 'person' ? 'onepiece' : 'top' }),
        name: '', image: photo, include: true, lookIdx, manual: true,
      });
    }
  }
  hideToast();
  if (failed) toast(`${failed} photo${failed > 1 ? 's' : ''} couldn't be read by AI${lastErr ? ` — ${esc(lastErr)}` : ''}. Fill those in by hand.`, 6000);
  if (!pending.entries.length && !pending.looks.length) return;
  state.pending = pending;
  renderReview();
  openSheet($('#reviewSheet'));
}

function renderReview() {
  const p = state.pending;
  const manual = p.entries.some((e) => e.manual);
  $('#reviewTitle').textContent = manual ? 'Tell us about these' : `Found ${p.entries.filter((e) => e.include).length} piece${p.entries.length === 1 ? '' : 's'}`;
  const catOpts = (sel) => Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  let html = '';
  if (manual) html += `<p class="small muted">AI is off, so name each piece and pick its type. You can fill in warmth, dressiness and more from the closet later.</p>`;
  p.looks.forEach((l, li) => {
    if (!p.entries.some((e) => e.lookIdx === li)) {
      html += `<p class="review-look">No clothing found in one look photo — it will still be saved under Looks.</p>`;
    }
  });
  html += p.entries.map((e, i) => `
    <div class="review-item ${e.include ? '' : 'off'}" data-i="${i}">
      <img src="${blobURL(e.image)}" alt="">
      <div class="fields">
        <label class="check"><input type="checkbox" data-f="include" ${e.include ? 'checked' : ''}> Save this piece</label>
        <input data-f="name" value="${esc(e.name)}" placeholder="${e.emptyHint ? 'No clothing detected — name it to save anyway' : 'Name, e.g. Blue denim jacket'}">
        <select data-f="category">${catOpts(e.category)}</select>
        ${e.manual ? '' : `<span class="small muted">${esc([e.colors.join(', '), e.material, `warmth ${e.warmth}/5`, `dressiness ${e.formality}/5`].filter(Boolean).join(' · '))}</span>`}
      </div>
    </div>`).join('');
  $('#reviewList').innerHTML = html;
}

function onReviewInput(e) {
  const row = e.target.closest('[data-i]');
  if (!row || !state.pending) return;
  const entry = state.pending.entries[Number(row.dataset.i)];
  const f = e.target.dataset.f;
  if (f === 'include') {
    entry.include = e.target.checked;
    row.classList.toggle('off', !entry.include);
  } else if (f) {
    entry[f] = e.target.value;
    if (f === 'name' && e.target.value.trim() && !entry.include) {
      entry.include = true;
      row.classList.remove('off');
      row.querySelector('[data-f=include]').checked = true;
    }
  }
}

async function saveReview() {
  const p = state.pending;
  if (!p) return;
  const now = Date.now();
  const lookIds = p.looks.map(() => uid('l'));
  const saved = [];
  for (const [n, e] of p.entries.entries()) {
    if (!e.include) continue;
    const item = {
      id: uid(),
      createdAt: now + n,
      image: e.image,
      name: e.name.trim() || `Piece ${state.items.length + saved.length + 1}`,
      category: e.category,
      colors: e.colors,
      pattern: e.pattern,
      material: e.material,
      warmth: e.warmth,
      formality: e.formality,
      occasions: e.occasions,
      seasons: e.seasons,
      waterproof: e.waterproof,
      notes: e.notes,
      favorite: false,
      wornCount: 0,
      lastWorn: null,
      lookId: e.lookIdx !== null ? lookIds[e.lookIdx] : null,
    };
    await db.put('items', item);
    saved.push(item);
  }
  for (const [li, l] of p.looks.entries()) {
    const look = {
      id: lookIds[li],
      createdAt: now + li,
      image: l.image,
      description: l.description,
      itemIds: saved.filter((s) => s.lookId === lookIds[li]).map((s) => s.id),
    };
    await db.put('looks', look);
    state.looks.unshift(look);
  }
  state.items.unshift(...saved.reverse());
  closeSheet($('#reviewSheet'));
  renderCloset();
  const lookMsg = p.looks.length ? ` and ${p.looks.length} look${p.looks.length > 1 ? 's' : ''}` : '';
  toast(`Saved ${saved.length} piece${saved.length === 1 ? '' : 's'}${lookMsg}.`);
}

// ---------------- item editor ----------------

function chipGroup(name, options, selected) {
  return `<div class="chips">${options.map(([v, l]) =>
    `<label class="chip ${selected.includes(v) ? 'on' : ''}"><input type="checkbox" name="${name}" value="${v}" ${selected.includes(v) ? 'checked' : ''} hidden>${esc(l)}</label>`).join('')}</div>`;
}

function openItem(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const form = $('#itemForm');
  const look = it.lookId && state.looks.find((l) => l.id === it.lookId);
  form.innerHTML = `
    <img class="editor-photo" src="${blobURL(it.image)}" alt="">
    <div class="form" style="margin-top:14px">
      <label>Name <input name="name" value="${esc(it.name)}" required></label>
      <label>Type <select name="category">${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${k === it.category ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Colours <input name="colors" value="${esc((it.colors || []).join(', '))}" placeholder="navy, white"></label>
      <div class="row" style="flex-wrap:nowrap">
        <label style="flex:1">Pattern <input name="pattern" value="${esc(it.pattern || '')}"></label>
        <label style="flex:1">Fabric <input name="material" value="${esc(it.material || '')}"></label>
      </div>
      <label>Warmth <input type="range" name="warmth" min="1" max="5" value="${it.warmth || 3}">
        <span class="range-row"><span>Summer-light</span><span>Winter-heavy</span></span></label>
      <label>Dressiness <input type="range" name="formality" min="1" max="5" value="${it.formality || 3}">
        <span class="range-row"><span>Lounge</span><span>Black tie</span></span></label>
      <div class="field">Good for ${chipGroup('occasions', OCCASIONS.map((o) => [o.id, o.label]), it.occasions || [])}</div>
      <div class="field">Seasons ${chipGroup('seasons', SEASONS.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), it.seasons || [])}</div>
      <label class="check"><input type="checkbox" name="waterproof" ${it.waterproof ? 'checked' : ''}> Rain-friendly</label>
      <label class="check"><input type="checkbox" name="favorite" ${it.favorite ? 'checked' : ''}> Favourite</label>
      <label>Notes <textarea name="notes" rows="2">${esc(it.notes || '')}</textarea></label>
      <p class="stat">${it.wornCount ? `Worn ${it.wornCount} time${it.wornCount > 1 ? 's' : ''}, last ${daysSince(it.lastWorn) === 0 ? 'today' : `${daysSince(it.lastWorn)} days ago`}.` : 'Not logged as worn yet.'}
        ${look ? ' <button type="button" class="link" data-open-look>From a look →</button>' : ''}</p>
      <div class="row sticky-actions">
        <button type="button" class="btn danger" data-delete>Delete</button>
        <span style="flex:1"></span>
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </div>`;
  form.onchange = (e) => {
    if (e.target.type === 'checkbox' && e.target.closest('.chip')) e.target.closest('.chip').classList.toggle('on', e.target.checked);
  };
  form.onclick = async (e) => {
    if (e.target.closest('[data-delete]')) {
      if (!confirm(`Delete "${it.name}" from your closet?`)) return;
      await db.del('items', it.id);
      state.items = state.items.filter((x) => x.id !== it.id);
      for (const l of state.looks.filter((l) => l.itemIds.includes(it.id))) {
        l.itemIds = l.itemIds.filter((x) => x !== it.id);
        await db.put('looks', l);
      }
      closeSheet($('#itemSheet'));
      renderCloset();
      toast('Deleted.');
    }
    if (e.target.closest('[data-open-look]')) {
      closeSheet($('#itemSheet'));
      openLook(look.id);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    Object.assign(it, {
      name: fd.get('name').trim() || it.name,
      category: fd.get('category'),
      colors: fd.get('colors').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      pattern: fd.get('pattern').trim(),
      material: fd.get('material').trim(),
      warmth: Number(fd.get('warmth')),
      formality: Number(fd.get('formality')),
      occasions: fd.getAll('occasions'),
      seasons: fd.getAll('seasons'),
      waterproof: fd.has('waterproof'),
      favorite: fd.has('favorite'),
      notes: fd.get('notes').trim(),
    });
    await db.put('items', it);
    closeSheet($('#itemSheet'));
    renderCloset();
    toast('Saved.');
  };
  openSheet($('#itemSheet'));
  $('#itemSheet').scrollTop = 0;
}

function openLook(id) {
  const l = state.looks.find((x) => x.id === id);
  if (!l) return;
  const pieces = l.itemIds.map((i) => state.items.find((x) => x.id === i)).filter(Boolean);
  const sheet = $('#lookSheet');
  sheet.innerHTML = `
    <img class="editor-photo" src="${blobURL(l.image)}" alt="">
    <h3 style="margin-top:14px">${esc(l.description || 'Look')}</h3>
    <p class="small muted">Added ${new Date(l.createdAt).toLocaleDateString()}</p>
    ${pieces.length ? `<div class="outfit-pieces">${pieces.map(pieceHTML).join('')}</div>` : '<p class="muted">No pieces linked to this look.</p>'}
    <div class="row sticky-actions">
      <button class="btn danger" data-del-look>Delete look</button>
      <span style="flex:1"></span>
      ${pieces.length ? '<button class="btn" data-wear-look>Wearing it today</button>' : ''}
      <button class="btn ghost" data-close>Close</button>
    </div>`;
  sheet.onclick = async (e) => {
    const p = e.target.closest('[data-item]');
    if (p) { closeSheet(sheet); openItem(p.dataset.item); }
    if (e.target.closest('[data-wear-look]')) {
      await logWear(pieces.map((x) => x.id), todayISO());
      toast('Logged for today.');
      closeSheet(sheet);
    }
    if (e.target.closest('[data-del-look]')) {
      if (!confirm('Delete this look photo? The pieces stay in your closet.')) return;
      await db.del('looks', l.id);
      state.looks = state.looks.filter((x) => x.id !== l.id);
      closeSheet(sheet);
      renderCloset();
    }
  };
  openSheet(sheet);
  sheet.scrollTop = 0;
}

// ---------------- chat ----------------

const STARTERS = [
  'What should I wear today?',
  'Pack for a 3-day trip to Goa',
  'What goes with my favourite piece?',
  'What\'s missing from my wardrobe?',
  'Dress me for a wedding this weekend',
];

function wireChat() {
  $('#chatSuggest').innerHTML = STARTERS.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
  $('#chatSuggest').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (b) sendChat(b.textContent);
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat($('#chatInput').value);
  });
  $('#chatInput').addEventListener('input', autoGrow);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) {
      e.preventDefault();
      sendChat($('#chatInput').value);
    }
  });
  $('#chatAttach').addEventListener('click', () => $('#pickChat').click());
  $('#pickChat').addEventListener('change', async () => {
    const f = $('#pickChat').files[0];
    $('#pickChat').value = '';
    if (!f) return;
    state.chatImage = await resizeImage(f, 768);
    renderAttach();
  });
  $('#attachPreview').addEventListener('click', (e) => {
    if (e.target.closest('button')) { state.chatImage = null; renderAttach(); }
  });
  $('#chatLog').addEventListener('click', (e) => {
    const p = e.target.closest('[data-item]');
    if (p) openItem(p.dataset.item);
    if (e.target.closest('[data-clear-chat]')) {
      state.chat = [];
      db.kvSet('chat', []);
      renderChat();
    }
  });
}

function autoGrow() {
  const t = $('#chatInput');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}

function renderAttach() {
  const box = $('#attachPreview');
  box.hidden = !state.chatImage;
  box.innerHTML = state.chatImage ? `<img src="${blobURL(state.chatImage)}" alt=""><button type="button" aria-label="Remove">×</button>` : '';
}

function renderMessage(m) {
  const imgs = [];
  let html = esc(m.text).replace(/\[\[([a-z0-9]+)\]\]/gi, (_, id) => {
    const it = state.items.find((x) => x.id === id);
    if (!it) return '';
    if (!imgs.includes(it)) imgs.push(it);
    return `<button class="inline-piece" data-item="${it.id}" title="${esc(it.name)}"><img src="${blobURL(it.image)}" alt="${esc(it.name)}"></button>`;
  });
  if (m.role === 'assistant' && imgs.length > 1) {
    html += `<div class="msg-pieces">${imgs.map((it) => `<img data-item="${it.id}" src="${blobURL(it.image)}" alt="${esc(it.name)}">`).join('')}</div>`;
  }
  const img = m.image ? `<img class="attached" src="${blobURL(m.image)}" alt="">` : '';
  return `<div class="msg ${m.role}">${img}${html}</div>`;
}

function renderChat() {
  const log = $('#chatLog');
  const intro = {
    role: 'assistant',
    text: state.items.length
      ? `Hi${state.settings.name ? ` ${state.settings.name}` : ''} — I know the ${state.items.length} piece${state.items.length === 1 ? '' : 's'} in your closet and today's weather. Ask me what to wear, what to pack, or send a photo of something you're thinking of buying.`
      : 'Hi — I\'m your stylist. Add some clothes in the Closet tab first so I can dress you from what you own.',
  };
  log.innerHTML = [intro, ...state.chat].map(renderMessage).join('') +
    (state.chat.length ? '<button class="link small center" data-clear-chat style="align-self:center">Clear conversation</button>' : '');
  $('#chatSuggest').hidden = state.chat.length > 0;
}

let chatBusy = false;
async function sendChat(text) {
  text = text.trim();
  if (chatBusy || (!text && !state.chatImage)) return;
  const image = state.chatImage;
  const userMsg = { role: 'user', text, image, hadImage: !!image };
  state.chat.push(userMsg);
  state.chatImage = null;
  renderAttach();
  $('#chatInput').value = '';
  autoGrow();
  renderChat();
  const log = $('#chatLog');
  log.insertAdjacentHTML('beforeend', '<div class="msg assistant typing" id="typing">Thinking…</div>');
  window.scrollTo(0, document.body.scrollHeight);
  chatBusy = true;
  let reply;
  try {
    if (state.aiMode === 'off') throw new ai.AIOff();
    const weatherText = state.weather ? wx.summarize(state.place, state.weather, 0, 'c') + ' ' + wx.summarize(state.place, state.weather, 1, 'c') : 'unknown';
    reply = await ai.chatReply({ history: state.chat, items: state.items, profile: state.settings, weatherText, image });
  } catch (err) {
    reply = err instanceof ai.AIOff ? offlineChat(text) : `Sorry — I couldn't reach the AI (${err.message}).`;
  } finally {
    chatBusy = false;
  }
  state.chat.push({ role: 'assistant', text: reply });
  state.chat = state.chat.slice(-60);
  await db.kvSet('chat', state.chat);
  renderChat();
  window.scrollTo(0, document.body.scrollHeight);
}

function offlineChat(text) {
  const t = text.toLowerCase();
  const occ = OCCASIONS.find((o) => t.includes(o.id) || t.includes(o.label.toLowerCase().split(' ')[0])) ||
    (/wedding|festiv|shaadi|puja|diwali/.test(t) && OCCASIONS.find((o) => o.id === 'festive')) ||
    (/office|meeting|interview/.test(t) && OCCASIONS.find((o) => o.id === 'work')) ||
    (/gym|run|yoga/.test(t) && OCCASIONS.find((o) => o.id === 'workout'));
  const day = state.weather?.days[/tomorrow/.test(t) ? 1 : 0];
  if (day && state.items.length) {
    const { outfits, missing } = suggestOffline(state.items, day, occ?.id || state.occasion, { count: 1 });
    if (outfits.length) {
      const o = outfits[0];
      return `The chat stylist needs AI switched on (You tab), but here's my built-in pick for ${(occ || OCCASIONS.find((x) => x.id === state.occasion)).label.toLowerCase()}:\n\n` +
        o.items.map((i) => `- ${i.name} [[${i.id}]]`).join('\n') + `\n\n${o.why}${missing ? `\n\n${missing}` : ''}`;
    }
  }
  return 'The chat stylist needs AI switched on — open the You tab and paste an OpenAI API key. Meanwhile, the Today tab can still pick outfits for you.';
}

// ---------------- settings ----------------

function loadSettingsForm() {
  const s = state.settings;
  $('#setName').value = s.name || '';
  $('#setWear').value = s.wear || 'mixed';
  $('#setStyle').value = s.style || '';
  $('#setUnit').value = s.unit || 'c';
  $('#setKey').value = s.apiKey || '';
  $('#setPass').value = s.passcode || '';
  $('#setModel').value = s.model || '';
}

function wireSettings() {
  const map = { setName: 'name', setWear: 'wear', setStyle: 'style', setUnit: 'unit', setKey: 'apiKey', setPass: 'passcode', setModel: 'model' };
  for (const [elId, key] of Object.entries(map)) {
    $(`#${elId}`).addEventListener('change', async (e) => {
      state.settings[key] = e.target.value.trim();
      await db.kvSet('settings', state.settings);
      if (['apiKey', 'passcode', 'model'].includes(key)) refreshAi();
      if (key === 'unit') renderWeather();
      if (key === 'name') renderChat();
    });
  }
  $('#testAi').addEventListener('click', async () => {
    const b = $('#testAi');
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span>Testing…';
    await refreshAi();
    try {
      await ai.ping();
      toast('✓ AI stylist is connected.');
    } catch (err) {
      toast(err instanceof ai.AIOff ? 'No AI configured yet — paste an API key first.' : `Didn't work: ${esc(err.message)}`, 6000);
    } finally {
      b.disabled = false;
      b.textContent = 'Test connection';
    }
  });
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#pickBackup').click());
  $('#pickBackup').addEventListener('change', importData);
  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('Erase your whole closet, looks, chat and settings from this phone? This cannot be undone.')) return;
    await Promise.all(['items', 'looks', 'kv'].map((s) => db.clear(s)));
    location.reload();
  });
}

async function exportData() {
  toast('<span class="spinner"></span>Packing your closet…', 0);
  const enc = async (x) => ({ ...x, image: x.image ? await blobToDataURL(x.image) : null });
  const { apiKey, passcode, ...safeSettings } = state.settings; // never put secrets in a backup file
  const data = {
    app: 'drape', version: 1, exportedAt: new Date().toISOString(),
    items: await Promise.all(state.items.map(enc)),
    looks: await Promise.all(state.looks.map(enc)),
    settings: safeSettings,
    history: await db.kvGet('history', []),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `drape-backup-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Backup downloaded.');
}

async function importData() {
  const f = $('#pickBackup').files[0];
  $('#pickBackup').value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'drape') throw new Error('not a Drape backup');
    toast('<span class="spinner"></span>Restoring…', 0);
    const dec = async (x) => ({ ...x, image: x.image ? await dataURLToBlob(x.image) : null });
    for (const it of data.items || []) await db.put('items', await dec(it));
    for (const l of data.looks || []) await db.put('looks', await dec(l));
    if (data.history) await db.kvSet('history', data.history);
    if (data.settings) await db.kvSet('settings', { ...data.settings, apiKey: state.settings.apiKey, passcode: state.settings.passcode });
    location.reload();
  } catch (err) {
    toast(`Couldn't restore: ${esc(err.message)}`, 5000);
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<p style="padding:16px;color:#a3322a">Drape failed to start: ${esc(err.message)}</p>`);
});
