// Ambiance Studio: the image picker + animation page. Plain DOM, no build step.

const $ = (sel) => document.querySelector(sel);
const state = {
  config: null,
  batchId: null,
  batch: null,
  animateImage: null, // { id, url, scene_prompt }
  suggestedMotion: '',
  takes: [],
  timers: { batch: null, takes: null },
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const money = (n) => `$${n.toFixed(2)}`;

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

// ---------- config / spend ----------

async function loadConfig() {
  state.config = await api('/api/config');
  const c = state.config;
  const badge = $('#provider');
  badge.textContent = c.provider === 'mock' ? 'MOCK · free' : `${c.imageModel} · ${c.videoModel}`;
  badge.classList.toggle('paid', c.provider !== 'mock');
  $('#style').replaceChildren(...c.stylePresets.map((p) => h('option', { value: p.id }, p.label)));
  renderSpend(c.spend);
}

function renderSpend(s) {
  const inflight = s.inFlightUsd > 0 ? ` (+${money(s.inFlightUsd)} in flight)` : '';
  $('#spend').textContent = `Spent ${money(s.spentUsd)}${inflight} of ${money(s.capUsd)}`;
}

async function refreshSpend() {
  renderSpend(await api('/api/spend'));
}

// ---------- compose ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== tab.dataset.tab));
    if (tab.dataset.tab === 'saved') loadSaved();
  });
}

const generateLabel = () => {
  const c = state.config;
  return c ? `Generate ${c.imagesPerBatch} images${c.batchCostUsd > 0 ? ` · ~${money(c.batchCostUsd)}` : ''}` : 'Generate';
};

async function startBatch(body) {
  const batch = await api('/api/batches', { method: 'POST', body });
  await openBatch(batch.id);
  loadHistory();
  $('#batch').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let resetGenerate = () => {};

// ---------- saved images ----------

async function loadSaved() {
  const saved = await api('/api/images/saved');
  $('#saved-count').textContent = saved.length ? `(${saved.length})` : '';
  $('#saved-empty').hidden = saved.length > 0;
  $('#saved-grid').replaceChildren(
    ...saved.map((img) =>
      h(
        'div',
        { class: 'card' },
        h('a', { class: 'media-link', href: img.url, target: '_blank', rel: 'noopener' }, h('img', { class: 'media', src: img.url, loading: 'lazy', alt: img.scene_prompt })),
        h('div', { class: 'meta', title: img.scene_prompt }, truncate(img.scene_prompt, 90)),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', onclick: () => openAnimate(img) }, 'Animate'),
          h('button', { onclick: () => startBatch({ referenceImageId: img.id }).catch((e) => showError($('#compose-error'), e)) }, 'More like this'),
          h('button', { onclick: async () => { await api(`/api/images/${img.id}`, { method: 'PATCH', body: { saved: false } }); loadSaved(); } }, 'Unsave'),
        ),
      ),
    ),
  );
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- batch view ----------

async function openBatch(id) {
  state.batchId = id;
  clearTimeout(state.timers.batch);
  await pollBatch();
}

async function pollBatch() {
  const id = state.batchId;
  const batch = await api(`/api/batches/${id}`);
  if (state.batchId !== id) return;
  state.batch = batch;
  renderBatch();
  if (batch.status === 'running') state.timers.batch = setTimeout(pollBatch, 2000);
  else {
    refreshSpend();
    loadHistory();
  }
}

function renderBatch() {
  const b = state.batch;
  $('#batch').hidden = false;
  $('#batch-title').textContent = `Batch #${b.id}${b.reference_image_id ? ` · more like image #${b.reference_image_id}` : ''}`;
  const pill = $('#batch-status');
  pill.className = `pill ${b.status}`;
  pill.textContent = b.status === 'running' ? `generating ${b.images.length}/${b.requested_count}` : b.status;
  $('#batch-scene').textContent = b.scene_prompt;
  $('#batch-prompt').textContent = b.full_prompt;
  showError($('#batch-error'), b.error ? new Error(b.error) : null);

  const cards = b.images.map((img) => imageCard(img));
  const missing = b.status === 'running' ? b.requested_count - b.images.length : 0;
  for (let i = 0; i < missing; i++) cards.push(h('div', { class: 'card' }, h('div', { class: 'skeleton' })));
  $('#batch-grid').replaceChildren(...cards);
}

function imageCard(img) {
  const card = h(
    'div',
    { class: `card${img.saved ? ' saved' : ''}` },
    h('a', { class: 'media-link', href: img.url, target: '_blank', rel: 'noopener', title: 'Open full size' }, h('img', { class: 'media', src: img.url, loading: 'lazy', alt: `Candidate ${img.id}` })),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: `star${img.saved ? ' on' : ''}`, title: img.saved ? 'Saved: click to unsave' : 'Save for later', onclick: () => toggleSave(img) }, img.saved ? '★ Saved' : '☆ Save'),
      h('button', { onclick: () => startBatch({ referenceImageId: img.id }).catch((e) => showError($('#batch-error'), e)) }, 'More like this'),
      h('span', { class: 'grow' }),
      h('button', { class: 'primary', onclick: () => openAnimate({ ...img, scene_prompt: state.batch.scene_prompt }) }, 'Animate'),
    ),
    h('div', { class: 'meta' }, `#${img.id}${img.width ? ` · ${img.width}×${img.height}` : ''}`),
  );
  return card;
}

async function toggleSave(img) {
  await api(`/api/images/${img.id}`, { method: 'PATCH', body: { saved: !img.saved } });
  await pollBatch();
  loadSaved();
}

// ---------- animate ----------

async function openAnimate(img) {
  state.animateImage = img;
  $('#animate').hidden = false;
  $('#animate-image').src = img.url;
  showError($('#animate-error'), null);
  const { motionPrompt } = await api(`/api/images/${img.id}/motion-suggestion`);
  state.suggestedMotion = motionPrompt;
  $('#motion').value = motionPrompt;
  await loadTakes();
  $('#animate').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#close-animate').addEventListener('click', () => {
  $('#animate').hidden = true;
  state.animateImage = null;
  clearTimeout(state.timers.takes);
});
$('#reset-motion').addEventListener('click', () => ($('#motion').value = state.suggestedMotion));

async function loadTakes() {
  clearTimeout(state.timers.takes);
  const img = state.animateImage;
  if (!img) return;
  const takes = await api(`/api/animations?imageId=${img.id}`);
  if (state.animateImage?.id !== img.id) return;
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
            ? h('img', { class: 'media', src: state.animateImage.url, alt: '', style: 'opacity:.35' })
            : h('div', { class: 'skeleton' });
      if (media.tagName === 'VIDEO') media.muted = true; // attribute alone doesn't mute in every browser
      return h(
        'div',
        { class: 'card' },
        media,
        h(
          'div',
          { class: 'actions' },
          h('span', { class: `pill ${t.status}` }, t.status === 'running' ? 'generating…' : t.status),
          h('span', { class: 'grow' }),
          t.status === 'succeeded' && h('a', { href: t.url, target: '_blank', rel: 'noopener' }, h('button', {}, 'Open')),
          t.status === 'succeeded' &&
            h('button', { class: `star${t.starred ? ' on' : ''}`, onclick: async () => { await api(`/api/animations/${t.id}`, { method: 'PATCH', body: { starred: !t.starred } }); loadTakes(); } }, t.starred ? '★ Best' : '☆ Best'),
        ),
        h('div', { class: 'meta', title: t.motion_prompt }, `#${t.id} · ${t.model} · ${t.duration_s}s ${t.resolution} · ${truncate(t.motion_prompt, 80)}`, t.error && h('p', { class: 'error' }, t.error)),
      );
    }),
  );
}

// ---------- history ----------

async function loadHistory() {
  const batches = await api('/api/batches?limit=15');
  $('#history').hidden = batches.length === 0;
  $('#history-list').replaceChildren(
    ...batches.map((b) =>
      h(
        'div',
        { class: 'history-item', onclick: () => openBatch(b.id).then(() => $('#batch').scrollIntoView({ behavior: 'smooth' })) },
        h('div', { class: 'history-thumbs' }, ...b.images.slice(0, 6).map((i) => h('img', { src: i.url, loading: 'lazy', alt: '' }))),
        h('div', {}, h('div', {}, `#${b.id} `, h('span', { class: `pill ${b.status}` }, b.status)), h('div', { class: 'history-scene' }, b.scene_prompt)),
      ),
    ),
  );
}

// ---------- wire up ----------

async function init() {
  await loadConfig();

  resetGenerate = armedButton(
    $('#generate'),
    generateLabel,
    () => state.config.batchCostUsd,
    async () => {
      showError($('#compose-error'), null);
      try {
        await startBatch({ scenePrompt: $('#scene').value, stylePreset: $('#style').value });
      } catch (e) {
        showError($('#compose-error'), e);
      }
    },
  );

  armedButton(
    $('#regenerate'),
    () => 'Regenerate (same prompt)',
    () => state.config.batchCostUsd,
    async () => {
      const b = state.batch;
      try {
        await startBatch({ scenePrompt: b.scene_prompt, stylePreset: b.style_preset, parentBatchId: b.id });
      } catch (e) {
        showError($('#batch-error'), e);
      }
    },
  );

  $('#edit-prompt').addEventListener('click', () => {
    $('#scene').value = state.batch.scene_prompt;
    $('#scene').focus();
    $('#compose').scrollIntoView({ behavior: 'smooth' });
  });

  armedButton(
    $('#start-animation'),
    () => `Animate${state.config.animationCostUsd > 0 ? ` · ~${money(state.config.animationCostUsd)}` : ''}`,
    () => state.config.animationCostUsd,
    async () => {
      showError($('#animate-error'), null);
      try {
        await api('/api/animations', { method: 'POST', body: { imageId: state.animateImage.id, motionPrompt: $('#motion').value } });
        await loadTakes();
      } catch (e) {
        showError($('#animate-error'), e);
      }
    },
  );

  await Promise.all([loadHistory(), loadSaved()]);
  const [latest] = await api('/api/batches?limit=1');
  if (latest) await openBatch(latest.id);
}

init().catch((e) => {
  document.body.prepend(h('p', { class: 'error', style: 'padding:16px' }, `Failed to load: ${e.message}`));
});
