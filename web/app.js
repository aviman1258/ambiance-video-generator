// Ambiance Studio. Plain DOM, no build step. Hash routes:
//   #/new, #/saved, #/all  → home tabs
//   #/image/<id>           → one image (tags, actions, animation)

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 60;

const state = {
  config: null,
  tab: 'new',
  search: { saved: '', all: '' },
  library: { items: [], total: 0, key: '' },
  pending: [], // generations in progress: { id, scene, error? }
  image: null, // the image page's image
  suggestedMotion: '',
  takes: [],
  cameFromApp: false,
  timers: { takes: null, search: null },
};

// ---------- helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const money = (n) => `$${n.toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showError(el, err) {
  el.textContent = err ? (err.message ?? String(err)) : '';
  el.hidden = !err;
}

/** Two-step button for anything that spends money: first click arms it, second click within 5 s runs it. */
function armedButton(button, labelFn, costFn, action) {
  let armedUntil = 0;
  const reset = () => {
    armedUntil = 0;
    button.classList.remove('confirm');
    button.textContent = labelFn();
  };
  button.addEventListener('click', async () => {
    const cost = costFn();
    if (cost > 0 && Date.now() > armedUntil) {
      armedUntil = Date.now() + 5000;
      button.classList.add('confirm');
      button.textContent = `Confirm: spend ${money(cost)}`;
      setTimeout(() => Date.now() > armedUntil && reset(), 5100);
      return;
    }
    reset();
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  });
  reset();
  return reset;
}

const costSuffix = (usd) => (usd > 0 ? ` · ~${money(usd)}` : '');

// ---------- config / spend ----------

async function loadConfig() {
  state.config = await api('/api/config');
  const c = state.config;
  const badge = $('#provider');
  badge.textContent = c.provider === 'mock' ? 'MOCK · free' : 'LIVE · paid';
  badge.title = `${c.imageModel} · ${c.videoModel}`;
  badge.classList.toggle('paid', c.provider !== 'mock');
  $('#logout').hidden = !c.authEnabled;
  $('#style').replaceChildren(...c.stylePresets.map((p) => h('option', { value: p.id }, p.label)));
  renderSpend(c.spend);
}

function renderSpend(s) {
  const inflight = s.inFlightUsd > 0 ? ` (+${money(s.inFlightUsd)} in flight)` : '';
  $('#spend').textContent = `${money(s.spentUsd)}${inflight} of ${money(s.capUsd)}`;
}

const refreshSpend = async () => renderSpend(await api('/api/spend'));

async function refreshCounts() {
  const [all, saved] = await Promise.all([api('/api/images?limit=1'), api('/api/images?limit=1&saved=1')]);
  $('#all-count').textContent = all.total ? `(${all.total})` : '';
  $('#saved-count').textContent = saved.total ? `(${saved.total})` : '';
}

// ---------- routing ----------

function route() {
  const hash = location.hash || '#/new';
  const imageMatch = hash.match(/^#\/image\/(\d+)/);
  clearTimeout(state.timers.takes);
  const overlay = $('#image-view');

  if (imageMatch) {
    // The image opens as a layer over the grid; the grid underneath keeps its scroll position.
    if (!state.homeShown) showHome(state.tab === 'new' ? 'all' : state.tab, { scrollTop: true }); // opened from a direct link
    overlay.hidden = false;
    document.body.classList.add('no-scroll');
    openImage(Number(imageMatch[1]));
    return;
  }

  const closingOverlay = !overlay.hidden;
  overlay.hidden = true;
  document.body.classList.remove('no-scroll');
  const tab = { '#/saved': 'saved', '#/all': 'all' }[hash] ?? 'new';
  const backToSameGrid = closingOverlay && tab === state.tab;
  showHome(tab, { scrollTop: !backToSameGrid, keepCount: backToSameGrid });
}

function showHome(tab, { scrollTop, keepCount = false }) {
  state.homeShown = true;
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#new-tab').hidden = tab !== 'new';
  $('#library-tab').hidden = tab === 'new';
  if (tab !== 'new') {
    $('#search').value = state.search[tab];
    // Coming back from an image: refresh in place (stars/tags may have changed) without losing loaded pages.
    loadLibrary({ reset: true, keepCount });
    loadTagChips();
  }
  if (scrollTop || state.scrollTopNext) window.scrollTo(0, 0);
  state.scrollTopNext = false;
}

window.addEventListener('hashchange', () => {
  state.cameFromApp = true;
  route();
});

// ---------- generating ----------

/** Starts a generation, shows it as a "generating" tile in All images, then opens the new image. */
async function generate(body, errorEl) {
  showError(errorEl, null);
  let gen;
  try {
    gen = await api('/api/generations', { method: 'POST', body });
  } catch (e) {
    showError(errorEl, e);
    return;
  }
  const pending = { id: gen.id, scene: gen.scene_prompt };
  state.pending.unshift(pending);
  if (location.hash === '#/all') {
    loadLibrary({ reset: true });
    window.scrollTo(0, 0);
  } else {
    state.scrollTopNext = true; // so the "Generating…" tile at the top of the grid is in view
    location.hash = '#/all';
  }

  while (true) {
    await sleep(2000);
    let latest;
    try {
      latest = await api(`/api/generations/${gen.id}`);
    } catch {
      continue;
    }
    if (latest.status === 'running') continue;
    refreshSpend();
    refreshCounts();
    if (latest.images.length) {
      state.pending = state.pending.filter((p) => p !== pending);
      // Only jump to the new image if they're still waiting on the All tab.
      if (location.hash === '#/all') location.hash = `#/image/${latest.images[0].id}`;
      return;
    }
    pending.error = latest.error ?? 'Generation failed';
    if (state.tab === 'all') renderLibrary();
    return;
  }
}

// ---------- library (Saved / All) ----------

async function loadLibrary({ reset, keepCount = false }) {
  const tab = state.tab;
  const q = state.search[tab];
  const key = `${tab}|${q}`;
  const offset = reset ? 0 : state.library.items.length;
  const limit = keepCount && state.library.key === key ? Math.max(PAGE_SIZE, state.library.items.length) : PAGE_SIZE;
  const params = new URLSearchParams({ limit: String(Math.min(limit, 200)), offset: String(offset) });
  if (q) params.set('q', q);
  if (tab === 'saved') params.set('saved', '1');
  const page = await api(`/api/images?${params}`);
  if (`${state.tab}|${state.search[state.tab]}` !== key) return; // a newer search won
  state.library = { key, total: page.total, items: reset ? page.items : [...state.library.items, ...page.items] };
  renderLibrary();
}

function renderLibrary() {
  const { items, total } = state.library;
  const tab = state.tab;
  const q = state.search[tab];
  const pendingTiles =
    tab === 'all' && !q
      ? state.pending.map((p) =>
          h(
            'div',
            { class: 'thumb pending', title: p.scene },
            p.error
              ? h('div', { class: 'thumb-error' }, h('strong', {}, 'Failed'), h('span', {}, p.error), h('button', { onclick: () => { state.pending = state.pending.filter((x) => x !== p); renderLibrary(); } }, 'Dismiss'))
              : h('div', { class: 'skeleton' }, h('span', {}, 'Generating…')),
          ),
        )
      : [];
  const tiles = items.map((img) =>
    h(
      'a',
      { class: 'thumb', href: `#/image/${img.id}`, title: img.tags.join(', ') },
      h('img', { src: img.thumbUrl, loading: 'lazy', alt: img.tags.join(', ') || img.scene_prompt }),
      h(
        'span',
        { class: 'thumb-badges' },
        img.saved && h('span', { class: 'tb star-badge' }, '★'),
        img.animation_count > 0 && h('span', { class: 'tb' }, `▶ ${img.animation_count}`),
      ),
    ),
  );
  $('#library-grid').replaceChildren(...pendingTiles, ...tiles);
  $('#library-summary').textContent = total ? `${total} image${total === 1 ? '' : 's'}${q ? ` tagged “${q}”` : ''}` : '';
  const empty = $('#library-empty');
  empty.hidden = items.length > 0 || pendingTiles.length > 0;
  empty.textContent = q
    ? 'No images match those tags.'
    : tab === 'saved'
      ? 'Nothing saved yet. Open an image and tap ☆ Save to keep it here.'
      : 'No images yet. Describe a scene in the New scene tab.';
  $('#load-more').hidden = items.length >= total;
}

async function loadTagChips() {
  const tags = await api('/api/tags');
  const active = new Set(state.search[state.tab].split(/\s+/).filter(Boolean));
  $('#tag-chips').replaceChildren(
    ...tags.slice(0, 18).map((t) =>
      h('button', { class: `chip${active.has(t.tag.split(' ')[0]) ? ' on' : ''}`, onclick: () => toggleSearchTag(t.tag) }, t.tag, h('span', { class: 'chip-count' }, String(t.count))),
    ),
  );
}

function toggleSearchTag(tag) {
  const word = tag.split(' ')[0];
  const terms = state.search[state.tab].split(/\s+/).filter(Boolean);
  const next = terms.includes(word) ? terms.filter((t) => t !== word) : [...terms, word];
  setSearch(next.join(' '));
}

function setSearch(q) {
  state.search[state.tab] = q;
  $('#search').value = q;
  loadLibrary({ reset: true });
  loadTagChips();
}

$('#search').addEventListener('input', () => {
  clearTimeout(state.timers.search);
  state.timers.search = setTimeout(() => setSearch($('#search').value.trim().toLowerCase()), 250);
});
$('#load-more').addEventListener('click', () => loadLibrary({ reset: false }));

// ---------- image page ----------

async function openImage(id) {
  showError($('#image-error'), null);
  showError($('#animate-error'), null);
  $('#image-view').scrollTop = 0;
  // Show the grid's thumbnail instantly (if we have it) while the full details load.
  const known = state.library.items.find((i) => i.id === id);
  $('#image-preview').src = known ? known.thumbUrl : '';
  let img;
  try {
    img = await api(`/api/images/${id}`);
  } catch (e) {
    showError($('#image-error'), e);
    return;
  }
  if (!location.hash.startsWith(`#/image/${id}`)) return; // closed or moved on while loading
  state.image = img;
  renderImage();
  const { motionPrompt } = await api(`/api/images/${id}/motion-suggestion`);
  state.suggestedMotion = motionPrompt;
  $('#motion').value = motionPrompt;
  loadTakes();
}

function renderImage() {
  const img = state.image;
  $('#image-preview').src = img.previewUrl;
  $('#image-preview').alt = img.tags.join(', ');
  $('#full-link').href = img.url;
  const save = $('#save-toggle');
  save.textContent = img.saved ? '★ Saved' : '☆ Save';
  save.classList.toggle('on', img.saved);
  const created = new Date(img.created_at).toLocaleString();
  $('#image-meta').replaceChildren(
    `#${img.id}${img.width ? ` · ${img.width}×${img.height}` : ''} · ${created}`,
    img.reference_image_id ? h('span', {}, ' · variation of ', h('a', { href: `#/image/${img.reference_image_id}` }, `#${img.reference_image_id}`)) : '',
    ' · tap the image for full resolution',
  );
  $('#image-scene').textContent = img.scene_prompt;
  $('#image-prompt').textContent = img.full_prompt;
  renderTags();
}

function renderTags() {
  const tags = state.image.tags;
  $('#image-tags').replaceChildren(
    ...(tags.length
      ? tags.map((tag) =>
          h(
            'span',
            { class: 'chip' },
            h('a', { href: '#/all', title: `Show all images tagged ${tag}`, onclick: () => { state.search.all = tag.split(' ')[0]; } }, tag),
            h('button', { class: 'chip-x', title: `Remove ${tag}`, 'aria-label': `Remove ${tag}`, onclick: () => saveTags(tags.filter((t) => t !== tag)) }, '×'),
          ),
        )
      : [h('span', { class: 'hint' }, 'No tags yet.')]),
  );
}

async function saveTags(tags) {
  try {
    state.image = await api(`/api/images/${state.image.id}`, { method: 'PATCH', body: { tags } });
    renderTags();
  } catch (e) {
    showError($('#image-error'), e);
  }
}

$('#tag-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#tag-input');
  const added = input.value.split(',').map((t) => t.trim()).filter(Boolean);
  if (!added.length) return;
  input.value = '';
  saveTags([...state.image.tags, ...added]);
});

$('#save-toggle').addEventListener('click', async () => {
  state.image = await api(`/api/images/${state.image.id}`, { method: 'PATCH', body: { saved: !state.image.saved } });
  renderImage();
  refreshCounts();
});

$('#jump-animate').addEventListener('click', () => $('#animate-section').scrollIntoView({ behavior: 'smooth', block: 'start' }));

$('#back').addEventListener('click', () => {
  if (state.cameFromApp && history.length > 1) history.back();
  else location.hash = '#/all';
});

// ---------- animation takes ----------

$('#reset-motion').addEventListener('click', () => ($('#motion').value = state.suggestedMotion));

async function loadTakes() {
  clearTimeout(state.timers.takes);
  const img = state.image;
  if (!img || $('#image-view').hidden) return;
  const takes = await api(`/api/animations?imageId=${img.id}`);
  if (state.image?.id !== img.id) return;
  state.takes = takes;
  renderTakes();
  if (takes.some((t) => t.status === 'pending' || t.status === 'running')) state.timers.takes = setTimeout(loadTakes, 3000);
  refreshSpend();
}

function renderTakes() {
  $('#takes-empty').hidden = state.takes.length > 0;
  $('#takes').replaceChildren(
    ...state.takes.map((t) => {
      const media =
        t.status === 'succeeded'
          ? h('video', { class: 'media', src: t.url, autoplay: true, loop: true, muted: true, playsinline: true, controls: true })
          : t.status === 'failed'
            ? h('img', { class: 'media', src: state.image.thumbUrl, alt: '', style: 'opacity:.35' })
            : h('div', { class: 'skeleton' }, h('span', {}, 'Animating… a few minutes'));
      if (media.tagName === 'VIDEO') media.muted = true; // the attribute alone doesn't mute in every browser
      return h(
        'div',
        { class: 'card' },
        media,
        h(
          'div',
          { class: 'actions' },
          h('span', { class: `pill ${t.status}` }, t.status === 'running' ? 'generating…' : t.status),
          h('span', { class: 'grow' }),
          t.status === 'succeeded' && h('a', { href: t.url, target: '_blank', rel: 'noopener', class: 'button-link' }, 'Open'),
          t.status === 'succeeded' &&
            h('button', { class: `star${t.starred ? ' on' : ''}`, onclick: async () => { await api(`/api/animations/${t.id}`, { method: 'PATCH', body: { starred: !t.starred } }); loadTakes(); } }, t.starred ? '★ Best' : '☆ Best'),
        ),
        h('div', { class: 'meta', title: t.motion_prompt }, `#${t.id} · ${t.duration_s}s ${t.resolution}`, t.error && h('p', { class: 'error' }, t.error)),
      );
    }),
  );
}

// ---------- wire up ----------

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

async function init() {
  await loadConfig();
  const genCost = () => state.config.generationCostUsd;

  armedButton(
    $('#generate'),
    () => `Generate ${state.config.imagesPerBatch === 1 ? 'image' : `${state.config.imagesPerBatch} images`}${costSuffix(genCost())}`,
    genCost,
    () => generate({ scenePrompt: $('#scene').value, stylePreset: $('#style').value }, $('#generate-error')),
  );
  armedButton($('#more-like-this'), () => `More like this${costSuffix(genCost())}`, genCost, () =>
    generate({ referenceImageId: state.image.id }, $('#image-error')),
  );
  armedButton($('#generate-another'), () => `Generate another${costSuffix(genCost())}`, genCost, () =>
    generate({ scenePrompt: state.image.scene_prompt, stylePreset: state.image.style_preset, parentBatchId: state.image.batch_id }, $('#image-error')),
  );
  armedButton(
    $('#start-animation'),
    () => `Animate${costSuffix(state.config.animationCostUsd)}`,
    () => state.config.animationCostUsd,
    async () => {
      showError($('#animate-error'), null);
      try {
        await api('/api/animations', { method: 'POST', body: { imageId: state.image.id, motionPrompt: $('#motion').value } });
        await loadTakes();
      } catch (e) {
        showError($('#animate-error'), e);
      }
    },
  );

  refreshCounts();
  route();
}

init().catch((e) => {
  document.body.prepend(h('p', { class: 'error', style: 'padding:16px' }, `Failed to load: ${e.message}`));
});
