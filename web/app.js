// Ambiance Studio. Plain DOM, no build step. Hash routes:
//   #/new, #/all, #/animations           → home tabs
//   #/image/<id>                          → one image, as a layer over the grid
//   #/animation/<id>                      → one animation, as a layer over the grid
import { sceneProblem } from '/scene-check.js';

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 60;
const TABS = { '#/new': 'new', '#/all': 'all', '#/animations': 'animations' };

const state = {
  config: null,
  tab: 'new',
  homeShown: false,
  scrollTopNext: false,
  search: { all: '' },
  library: { items: [], total: 0, key: '' },
  animations: [],
  pending: [], // image generations in progress: { id, scene, error? }
  image: null, // the open image
  motionFor: null, // image id the motion plan was loaded for
  plan: null, // { summary, takes[], source, warning? }
  animation: null, // the open animation
  cameFromApp: false,
  timers: { search: null, animations: null, animation: null },
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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function showError(el, err) {
  el.textContent = err ? (err.message ?? String(err)) : '';
  el.hidden = !err;
}

const spinner = (big = false) => h('span', { class: big ? 'spinner big' : 'spinner', role: 'status', 'aria-label': 'Working' });

/** Disables a button and shows a spinner in it while work is in flight. */
function setBusy(button, busy) {
  button.classList.toggle('busy', busy);
  button.querySelector(':scope > .spinner')?.remove();
  if (busy) button.prepend(spinner());
}

/** Runs the action with the button disabled, so a double tap can't fire it twice. */
function onTap(button, action) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
      setBusy(button, false);
    }
  });
}

/**
 * Asks before anything that costs money or deletes something. Resolves true only on the confirm
 * button; Cancel, Escape or tapping outside all count as no.
 */
function askConfirm({ title, body, confirmLabel, danger = false }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  const ok = $('#confirm-ok');
  ok.textContent = confirmLabel;
  ok.className = danger ? 'danger' : 'primary';
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

// Tapping the dimmed area outside the box cancels.
$('#confirm-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close('cancel');
});

const PAID = 'This uses your Gemini API credit.';

// ---------- config / spend / counts ----------

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
  const inflight = s.inFlightUsd > 0 ? ` (+${money(s.inFlightUsd)} in progress)` : '';
  $('#spend').textContent = `${money(s.spentUsd)} spent${inflight}`;
}

const refreshSpend = async () => renderSpend(await api('/api/spend'));

async function refreshCounts() {
  const [all, anims] = await Promise.all([api('/api/images?limit=1'), api('/api/animations')]);
  $('#all-count').textContent = all.total ? `(${all.total})` : '';
  const running = anims.filter((a) => a.status === 'pending' || a.status === 'running').length;
  $('#animations-count').textContent = anims.length ? `(${anims.length}${running ? ` · ${running} in progress` : ''})` : '';
}

// ---------- routing ----------

function route() {
  const hash = location.hash || '#/new';
  const imageMatch = hash.match(/^#\/image\/(\d+)/);
  const animationMatch = hash.match(/^#\/animation\/(\d+)/);
  clearTimeout(state.timers.animation);

  if (imageMatch || animationMatch) {
    // Layers over the grid; the grid underneath keeps its scroll position.
    if (!state.homeShown) showHome(animationMatch ? 'animations' : state.tab === 'new' ? 'all' : state.tab, { scrollTop: true });
    showOverlay(imageMatch ? '#image-view' : '#animation-view');
    if (imageMatch) openImage(Number(imageMatch[1]));
    else openAnimation(Number(animationMatch[1]));
    return;
  }

  const closingOverlay = !!openOverlay();
  showOverlay(null);
  const tab = TABS[hash] ?? 'new';
  const backToSameGrid = closingOverlay && tab === state.tab;
  showHome(tab, { scrollTop: !backToSameGrid, keepCount: backToSameGrid });
}

function openOverlay() {
  return ['#image-view', '#animation-view'].find((sel) => !$(sel).hidden);
}

function showOverlay(sel) {
  for (const s of ['#image-view', '#animation-view']) $(s).hidden = s !== sel;
  document.body.classList.toggle('no-scroll', !!sel);
  if (sel !== '#animation-view') $('#animation-media').replaceChildren(); // stop any playing video
}

function showHome(tab, { scrollTop, keepCount = false }) {
  state.homeShown = true;
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#new-tab').hidden = tab !== 'new';
  $('#library-tab').hidden = tab !== 'all';
  $('#animations-tab').hidden = tab !== 'animations';
  if (tab === 'all') {
    $('#search').value = state.search[tab];
    // Coming back from an image: refresh in place (stars/tags may have changed) without losing loaded pages.
    loadLibrary({ reset: true, keepCount });
    loadTagChips();
  }
  if (tab === 'animations') loadAnimations();
  else clearTimeout(state.timers.animations);
  if (scrollTop || state.scrollTopNext) window.scrollTo(0, 0);
  state.scrollTopNext = false;
}

window.addEventListener('hashchange', () => {
  state.cameFromApp = true;
  route();
});

for (const back of document.querySelectorAll('.back')) {
  back.addEventListener('click', () => {
    if (state.cameFromApp && history.length > 1) history.back();
    else location.hash = openOverlay() === '#animation-view' ? '#/animations' : '#/all';
  });
}

// ---------- new scene ----------

function updateGenerateButton() {
  const text = $('#scene').value;
  const problem = sceneProblem(text);
  $('#generate').disabled = !!problem;
  const hint = $('#scene-hint');
  hint.hidden = !problem || text.trim().length === 0; // nothing typed yet: just the grey button
  hint.textContent = problem ?? '';
}
$('#scene').addEventListener('input', updateGenerateButton);

/**
 * Starts a generation and shows a "generating" tile in the Images tab. Resolves once the request is
 * accepted; a background check opens the new image when it's ready.
 */
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
  watchGeneration(gen.id, pending);
}

async function watchGeneration(id, pending) {
  while (true) {
    await sleep(2000);
    let latest;
    try {
      latest = await api(`/api/generations/${id}`);
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
    !q
      ? state.pending.map((p) =>
          h(
            'div',
            { class: 'thumb pending', title: p.scene },
            p.error
              ? h('div', { class: 'thumb-error' }, h('strong', {}, 'Failed'), h('span', {}, p.error), h('button', { onclick: () => { state.pending = state.pending.filter((x) => x !== p); renderLibrary(); } }, 'Dismiss'))
              : h('div', { class: 'skeleton' }, spinner(true), h('span', {}, 'Generating…')),
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
        img.animation_count > 0 && h('span', { class: 'tb' }, `▶ ${img.animation_count}`),
      ),
    ),
  );
  $('#library-grid').replaceChildren(...pendingTiles, ...tiles);
  $('#library-summary').textContent = total ? `${plural(total, 'image')}${q ? ` tagged “${q}”` : ''}` : '';
  const empty = $('#library-empty');
  empty.hidden = items.length > 0 || pendingTiles.length > 0;
  empty.textContent = q ? 'No images match those tags.' : 'No images yet. Describe a scene in the New scene tab.';
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

// ---------- animations tab ----------

const isRunning = (a) => a.status === 'pending' || a.status === 'running';

async function loadAnimations() {
  clearTimeout(state.timers.animations);
  state.animations = await api('/api/animations');
  if (state.tab !== 'animations') return;
  renderAnimations();
  // Keep checking while anything is still animating.
  if (state.animations.some(isRunning)) {
    state.timers.animations = setTimeout(() => {
      if (state.tab === 'animations') {
        loadAnimations();
        refreshCounts();
        refreshSpend();
      }
    }, 5000);
  }
}

function renderAnimations() {
  const list = state.animations;
  const running = list.filter(isRunning).length;
  $('#animations-summary').textContent = list.length ? `${plural(list.length, 'animation')}${running ? ` · ${running} in progress` : ''}` : '';
  $('#animations-empty').hidden = list.length > 0;
  $('#animations-grid').replaceChildren(
    ...list.map((a) =>
      h(
        'a',
        { class: `thumb anim ${a.status}`, href: `#/animation/${a.id}`, title: a.motion_prompt },
        h('img', { src: a.imageThumbUrl, loading: 'lazy', alt: a.scene_prompt }),
        isRunning(a) ? h('span', { class: 'thumb-label' }, spinner(), a.clip_count > 1 ? ` Animating ${a.clips_done}/${a.clip_count}` : ' Animating…') : a.status === 'failed' ? h('span', { class: 'thumb-label bad' }, 'Failed') : h('span', { class: 'play' }, '▶'),
        h('span', { class: 'thumb-badges' }, a.starred && h('span', { class: 'tb star-badge' }, '★ Best')),
      ),
    ),
  );
}

// ---------- finished animations open themselves ----------

const watching = new Set();

/** Checks an in-progress animation every few seconds; when it's done, opens it over the Animations tab. */
async function watchAnimation(id) {
  if (watching.has(id)) return;
  watching.add(id);
  while (true) {
    await sleep(5000);
    let a;
    try {
      a = await api(`/api/animations/${id}`);
    } catch {
      continue; // network blip; keep checking
    }
    if (isRunning(a)) continue;
    watching.delete(id);
    refreshCounts();
    refreshSpend();
    if (a.status === 'succeeded') await openFinishedAnimation(id);
    else if (state.image?.id === a.image_id && !$('#image-view').hidden) refreshAnimateStatus(); // shows why it failed
    return;
  }
}

async function openFinishedAnimation(id) {
  while ($('#confirm-dialog').open) await sleep(500); // don't yank the page out from under a question
  if (location.hash === `#/animation/${id}`) return openAnimation(id);
  // Put the Animations tab underneath (and in history, so Back lands there), then open the clip.
  showHome('animations', { scrollTop: true });
  history.pushState(null, '', '#/animations');
  location.hash = `#/animation/${id}`;
}

// ---------- one animation ----------

async function openAnimation(id) {
  clearTimeout(state.timers.animation);
  $('#animation-view').scrollTop = 0;
  showError($('#animation-error'), null);
  let a;
  try {
    a = await api(`/api/animations/${id}`);
  } catch (e) {
    showError($('#animation-error'), e);
    return;
  }
  if (!location.hash.startsWith(`#/animation/${id}`)) return;
  state.animation = a;
  renderAnimation();
  if (isRunning(a)) state.timers.animation = setTimeout(() => openAnimation(id), 5000);
  else refreshSpend();
}

function renderAnimation() {
  const a = state.animation;
  const media = $('#animation-media');
  const current = media.querySelector('video');
  if (a.status === 'succeeded') {
    if (!current || current.dataset.id !== String(a.id)) {
      const video = h('video', { class: 'player', src: a.url, autoplay: true, loop: true, muted: true, playsinline: true, controls: true, 'data-id': String(a.id) });
      video.muted = true; // the attribute alone doesn't mute in every browser
      media.replaceChildren(video);
    }
  } else {
    media.replaceChildren(
      h(
        'div',
        { class: 'player-wait' },
        h('img', { src: a.imagePreviewUrl, alt: '' }),
        a.status === 'failed'
          ? h('span', { class: 'thumb-label bad' }, 'Failed')
          : h(
              'span',
              { class: 'player-spinner' },
              spinner(true),
              h('span', {}, a.clip_count > 1 ? `Animating… ${a.clips_done} of ${a.clip_count} takes done` : 'Animating… usually a few minutes'),
            ),
      ),
    );
  }
  const takesText = a.clip_count > 1 ? ` (${a.clip_count} takes)` : '';
  $('#animation-meta').textContent = `#${a.id} · ${a.duration_s}s${takesText} · ${a.resolution} · seamless loop · ${new Date(a.created_at).toLocaleString()}`;
  const note = $('#animation-note');
  note.hidden = !a.note;
  note.textContent = a.note ?? '';
  showError($('#animation-error'), a.error ? new Error(a.error) : null);
  $('#animation-image-link').href = `#/image/${a.image_id}`;
  const file = $('#animation-file-link');
  file.hidden = a.status !== 'succeeded';
  if (a.url) file.href = a.url;
  $('#delete-animation').hidden = isRunning(a);
  const best = $('#best-toggle');
  best.hidden = a.status !== 'succeeded';
  best.textContent = a.starred ? '★ Best' : '☆ Best';
  best.classList.toggle('on', a.starred);
  const takes = a.takes?.length ? a.takes : [{ idx: 0, motion_prompt: a.motion_prompt, status: a.status }];
  $('#animation-takes').replaceChildren(
    ...takes.map((t) =>
      h('li', { class: `take-item ${t.status}` }, t.motion_prompt, t.status === 'failed' && t.error ? h('span', { class: 'plan-warning' }, ` (failed: ${t.error})`) : ''),
    ),
  );
}

onTap($('#delete-animation'), async () => {
  const yes = await askConfirm({
    title: 'Delete this animation?',
    body: 'The video is deleted; the image stays. This can’t be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!yes) return;
  try {
    await api(`/api/animations/${state.animation.id}`, { method: 'DELETE' });
  } catch (e) {
    showError($('#animation-error'), e);
    return;
  }
  refreshCounts();
  leaveOverlay('#/animations');
});

onTap($('#best-toggle'), async () => {
  state.animation = await api(`/api/animations/${state.animation.id}`, { method: 'PATCH', body: { starred: !state.animation.starred } });
  renderAnimation();
});

// ---------- one image ----------

async function openImage(id) {
  showError($('#image-error'), null);
  showError($('#animate-error'), null);
  $('#animate-panel').hidden = true;
  $('#animate-status').hidden = true;
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
  refreshAnimateStatus();
}

function renderImage() {
  const img = state.image;
  $('#image-preview').src = img.previewUrl;
  $('#image-preview').alt = img.tags.join(', ');
  $('#full-link').href = img.url;
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

/** One line under the buttons: what's animating for this image, or how many animations it has. */
async function refreshAnimateStatus() {
  const img = state.image;
  const takes = await api(`/api/animations?imageId=${img.id}`);
  if (state.image?.id !== img.id) return;
  const running = takes.filter(isRunning).length;
  const done = takes.filter((t) => t.status === 'succeeded').length;
  const latest = takes[0]; // newest first
  const failed = latest?.status === 'failed';
  const status = $('#animate-status');
  status.hidden = !running && !done && !failed;
  status.classList.toggle('bad', failed && !running);
  status.replaceChildren(
    running ? spinner() : '',
    running
      ? ` Animating… this takes a few minutes. It opens in the Animations tab when it's done. `
      : failed
        ? `The last animation failed: ${latest.error ?? 'unknown error'} `
        : `${plural(done, 'animation')} of this image. `,
    running > 0 || done > 0 ? h('a', { href: '#/animations' }, 'Open Animations') : '', // not `running || done`: 0 would render as "0"
  );
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

onTap($('#delete-image'), async () => {
  const yes = await askConfirm({
    title: 'Delete this image?',
    body: 'Its animations and tags are deleted too. This can’t be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!yes) return;
  try {
    await api(`/api/images/${state.image.id}`, { method: 'DELETE' });
  } catch (e) {
    showError($('#image-error'), e);
    return;
  }
  state.library.items = state.library.items.filter((i) => i.id !== state.image.id);
  refreshCounts();
  leaveOverlay('#/all');
});

/** Closes a layer after its item was deleted: back to where they came from, else to the given tab. */
function leaveOverlay(fallback) {
  if (state.cameFromApp && history.length > 1) history.back();
  else location.hash = fallback;
}

// Animate opens right under the buttons.
onTap($('#toggle-animate'), async () => {
  const panel = $('#animate-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  showError($('#animate-error'), null);
  const takes = state.config.animationTakes;
  $('#animate-hint').textContent =
    `${takes} takes of 8 seconds at 1080p, each starting and ending on this image, joined into one ${takes * 8}-second loop. ` +
    `Veo's own sound is removed. It takes a few minutes and opens in the Animations tab when it's done.`;
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (state.motionFor !== state.image.id) await loadMotionPlan(state.image.id);
});
$('#cancel-animate').addEventListener('click', () => ($('#animate-panel').hidden = true));
$('#reset-motion').addEventListener('click', () => renderMotionTakes(state.plan.takes));

/** Gemini looks at the image and writes one motion prompt per take (cached on the server). */
async function loadMotionPlan(imageId) {
  const start = $('#start-animation');
  start.disabled = true;
  $('#motion-details').hidden = true;
  $('#motion-summary').replaceChildren(spinner(), ' Looking at the image to plan the motion…');
  let plan;
  try {
    plan = await api(`/api/images/${imageId}/motion-plan`);
  } catch (e) {
    $('#motion-summary').textContent = '';
    showError($('#animate-error'), e);
    return;
  }
  if (state.image?.id !== imageId) return;
  state.plan = plan;
  state.motionFor = imageId;
  $('#motion-summary').replaceChildren(
    plan.source === 'vision' ? h('strong', {}, 'Plan: ') : h('strong', {}, 'Plan (from the description): '),
    plan.summary,
    plan.warning ? h('span', { class: 'plan-warning' }, ` ${plan.warning}`) : '',
  );
  renderMotionTakes(plan.takes);
  $('#motion-details').hidden = false;
  start.disabled = false;
}

function renderMotionTakes(takes) {
  $('#motion-takes').replaceChildren(
    ...takes.map((t, i) => h('label', { class: 'take' }, `Take ${i + 1}`, h('textarea', { rows: '5', class: 'take-prompt' }, t))),
  );
}

// ---------- wire up ----------

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

async function init() {
  await loadConfig();

  $('#generate').addEventListener('click', async () => {
    if ($('#generate').disabled) return;
    $('#generate').disabled = true;
    if (await askConfirm({ title: 'Generate this image?', body: PAID, confirmLabel: 'Generate' })) {
      setBusy($('#generate'), true);
      await generate({ scenePrompt: $('#scene').value, stylePreset: $('#style').value }, $('#generate-error'));
    }
    setBusy($('#generate'), false);
    updateGenerateButton(); // back to grey if the box no longer holds a usable scene
  });
  onTap($('#more-like-this'), async () => {
    if (!(await askConfirm({ title: 'Make a variation of this image?', body: `A new image in the same spirit. ${PAID}`, confirmLabel: 'Generate' }))) return;
    setBusy($('#more-like-this'), true);
    await generate({ referenceImageId: state.image.id }, $('#image-error'));
  });
  onTap($('#generate-another'), async () => {
    if (!(await askConfirm({ title: 'Generate another from this prompt?', body: PAID, confirmLabel: 'Generate' }))) return;
    setBusy($('#generate-another'), true);
    await generate({ scenePrompt: state.image.scene_prompt, stylePreset: state.image.style_preset, parentBatchId: state.image.batch_id }, $('#image-error'));
  });
  onTap($('#start-animation'), async () => {
    const yes = await askConfirm({
      title: 'Start this animation?',
      body: `Veo makes ${state.config.animationTakes} eight-second takes and joins them into a ${state.config.animationTakes * 8}-second loop. It takes a few minutes and costs a few times more than an image. ${PAID}`,
      confirmLabel: 'Start animation',
    });
    if (!yes) return;
    setBusy($('#start-animation'), true);
    showError($('#animate-error'), null);
    let started;
    try {
      const motionPrompts = [...document.querySelectorAll('#motion-takes .take-prompt')].map((t) => t.value);
      started = await api('/api/animations', { method: 'POST', body: { imageId: state.image.id, motionPrompts } });
    } catch (e) {
      showError($('#animate-error'), e);
      return;
    }
    watchAnimation(started.id);
    $('#animate-panel').hidden = true;
    refreshAnimateStatus();
    refreshCounts();
    refreshSpend();
  });

  updateGenerateButton();
  refreshCounts();
  route();
  for (const a of await api('/api/animations')) if (isRunning(a)) watchAnimation(a.id);
}

init().catch((e) => {
  document.body.prepend(h('p', { class: 'error', style: 'padding:16px' }, `Failed to load: ${e.message}`));
});
