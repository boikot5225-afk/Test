import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

// Migaku-style Known / Unknown vocabulary layer for Reader AI.
// Chinese only for now. The assessment algorithm mirrors the behavior observed
// in Migaku 1.192.15: 42 broad samples, then 42 samples centered on the first
// estimate, 14 words per screen. The final estimate is kept separate from the
// conservative Known baseline (60% below 20k, capped at 10k).

const PROFILE_BASE_KEY = 'an2_reader_vocab_estimate_v3';
const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const OWNER_KEY = 'an2_reader_active_owner_v1';
const IS_ANDROID_ASSET = globalThis.location?.hostname === 'appassets.androidplatform.net';
const DATA_URL = IS_ANDROID_ASSET
  ? 'data/zh_vocab_frequency.txt'
  : 'data/zh_vocab_frequency.txt.gz?v=40';
const STYLE_ID = 'reader-migaku-vocab-style-v3';
const MODAL_ID = 'reader-vocab-estimate-modal';
const WORDS_PER_PAGE = 14;
const STEP1_COUNT = 42;
const STEP2_COUNT = 42;

let frequencyPromise = null;
let frequencyData = null;
let assessment = null;
let renderObserver = null;
let renderObserverRoot = null;
let pendingWordNodes = new Set();
let pendingBatchScheduled = false;
let toolbarButton = null;

function canonicalLang(value) {
  const lang = String(value || '').toLowerCase();
  if (lang.startsWith('zh') || lang === 'cn') return 'zh';
  if (lang.startsWith('ja') || lang === 'jp') return 'ja';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('es')) return 'es';
  if (lang.startsWith('en')) return 'en';
  return lang || 'zh';
}

function currentLang() {
  return canonicalLang(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || 'zh',
  );
}

function ownerId() {
  try {
    const stored = localStorage.getItem(OWNER_KEY);
    if (stored) return stored;
    if (localStorage.getItem('an2_guest') === '1') return 'guest';
  } catch {}
  return 'anon';
}

function scopedKey(base) {
  return `${base}::${ownerId()}`;
}

function formatNumber(value) {
  try { return Math.round(Number(value || 0)).toLocaleString('ru-RU'); }
  catch { return String(Math.round(Number(value || 0))); }
}

function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(PROFILE_BASE_KEY)) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const estimate = Math.max(0, Math.round(Number(raw.estimate || 0)));
    const conservativeKnownCount = Math.max(0, Math.round(Number(
      raw.conservativeKnownCount ?? conservativeCountForEstimate(estimate, 40000),
    )));
    return { ...raw, language: 'zh', estimate, conservativeKnownCount };
  } catch {
    return null;
  }
}

function saveProfile(profile) {
  const estimate = Math.max(0, Math.round(Number(profile?.estimate || 0)));
  const listLength = Math.max(0, Number(profile?.listLength || frequencyData?.words?.length || 0));
  const next = {
    language: 'zh',
    version: 3,
    ...profile,
    estimate,
    conservativeKnownCount: Math.max(0, Math.round(Number(
      profile?.conservativeKnownCount ?? conservativeCountForEstimate(estimate, listLength),
    ))),
    updatedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(scopedKey(PROFILE_BASE_KEY), JSON.stringify(next)); } catch {}
  return next;
}

function wordStateStore() {
  try {
    const live = globalThis.an2ReaderWordStateSnapshot?.();
    if (live && typeof live === 'object') return live;
  } catch {}
  try { return JSON.parse(localStorage.getItem(scopedKey(WORD_STATE_BASE_KEY)) || '{}') || {}; }
  catch { return {}; }
}

function persistWordState(store) {
  const key = scopedKey(WORD_STATE_BASE_KEY);
  try { localStorage.setItem(key, JSON.stringify(store || {})); } catch {}
  wordStateIdbPut(key, store || {}).catch(error => {
    console.warn('[reader vocab] IndexedDB save failed', error?.message || error);
  });
}

function normalizeWord(word, lang = currentLang()) {
  const value = String(word || '').trim();
  if (canonicalLang(lang) === 'zh' || canonicalLang(lang) === 'ja') return value;
  return value.toLocaleLowerCase();
}

function findWordState(word, lang = currentLang(), create = false) {
  const language = canonicalLang(lang);
  const normalized = normalizeWord(word, language);
  const store = wordStateStore();
  if (!normalized) return { store, key: '', state: null };
  const direct = `${language}:${normalized}`;
  if (store[direct]) return { store, key: direct, state: store[direct] };

  for (const [key, state] of Object.entries(store)) {
    if (!state || canonicalLang(state.lang) !== language) continue;
    if (normalizeWord(state.word, language) === normalized) return { store, key, state };
  }

  if (!create) return { store, key: direct, state: null };
  store[direct] = {
    word: normalized,
    lang: language,
    seen: 0,
    clicked: 0,
    saved: false,
    known: false,
    status: 'new',
    places: {},
    clickContexts: {},
    updatedAt: new Date().toISOString(),
  };
  return { store, key: direct, state: store[direct] };
}

function manualKnowledge(state) {
  const explicit = String(state?.manualKnowledge || '').toLowerCase();
  if (explicit === 'known' || explicit === 'unknown') return explicit;
  const status = String(state?.status || '').trim().toLowerCase();
  // Core Reader manual Known predates manualKnowledge. autoKnown=false is the
  // discriminator: automatic/common words must not become sticky overrides.
  if (state?.known === true && status === 'known' && state?.autoKnown === false) return 'known';
  // Preserve the old explicit Problem/Hard user decision as manual Unknown.
  if (state?.known === false && state?.saved === true && (status === 'problem' || status === 'hard')) return 'unknown';
  return '';
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.style.display = 'none'; }, 1700);
}

function currentPanelWord() {
  return String(document.getElementById('reader-word-title')?.textContent || '').trim();
}

function buildFrequencyData(words) {
  const clean = (Array.isArray(words) ? words : []).map(x => String(x || '').trim()).filter(Boolean);
  const rank = new Map();
  clean.forEach((word, index) => {
    if (!rank.has(word)) rank.set(word, index);
  });
  return {
    version: 2,
    source: 'Migaku 1.192.15 · Simplified Mandarin frequency order',
    words: clean,
    rank,
  };
}

async function loadFrequencyData() {
  if (frequencyData) return frequencyData;
  if (frequencyPromise) return frequencyPromise;
  frequencyPromise = fetch(new URL(DATA_URL, document.baseURI), { cache: 'force-cache' })
    .then(async response => {
      if (!response.ok) throw new Error(`${DATA_URL}: HTTP ${response.status}`);
      // Android's AAPT transparently expands .gz assets and removes the suffix.
      // The WebView therefore receives plain UTF-8 at the stripped .txt path.
      if (IS_ANDROID_ASSET) return response.text();
      if (typeof DecompressionStream !== 'function') {
        throw new Error('gzip decompression is unavailable in this browser');
      }
      const stream = response.body?.pipeThrough(new DecompressionStream('gzip'));
      if (!stream) throw new Error('frequency data stream unavailable');
      return new Response(stream).text();
    })
    .then(text => {
      const data = buildFrequencyData(text.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
      if (data.words.length !== 39999) throw new Error(`frequency list length ${data.words.length}, expected 39999`);
      if (data.rank.size !== 39999) throw new Error(`frequency list has ${39999 - data.rank.size} duplicate terms`);
      const sentinels = [[0, '我'], [1, '的'], [6, '我们'], [4768, '天天'], [4986, '竭尽全力'], [4996, '据我所知'], [4999, '围绕']];
      for (const [index, expected] of sentinels) {
        if (data.words[index] !== expected) throw new Error(`frequency list mismatch at #${index + 1}: ${data.words[index] || '∅'} != ${expected}`);
      }
      frequencyData = data;
      return data;
    })
    .finally(() => { frequencyPromise = null; });
  return frequencyPromise;
}

function rankIndexForWordSync(word) {
  const value = String(word || '').trim();
  if (!value || !frequencyData) return null;
  const direct = frequencyData.rank.get(value);
  if (Number.isInteger(direct)) return direct;
  try {
    const local = globalThis.readerLookupChineseWord?.(value);
    const simplified = String(local?.simplified || local?.word || '').trim();
    const mapped = simplified ? frequencyData.rank.get(simplified) : null;
    if (Number.isInteger(mapped)) return mapped;
  } catch {}
  return null;
}

function conservativeCountForEstimate(estimate, listLength) {
  const value = Number(estimate || 0);
  let count;
  if (value < 20000) count = Math.round((value * 0.6) / 10) * 10;
  else count = 10000;
  return Math.max(0, Math.min(10000, Math.min(Math.round(count), Math.max(0, Number(listLength || 0)))));
}

function classificationFor(word, lang = 'zh') {
  const language = canonicalLang(lang);
  const { state } = findWordState(word, language, false);
  const manual = manualKnowledge(state);
  const index = language === 'zh' ? rankIndexForWordSync(word) : null;
  const rank = Number.isInteger(index) ? index + 1 : null;

  if (manual) return { value: manual, source: 'manual', state, index, rank };
  if (language !== 'zh') return { value: '', source: '', state, index: null, rank: null };

  const profile = loadProfile();
  if (!profile) return { value: '', source: '', state, index, rank };
  if (!Number.isInteger(index)) {
    return { value: 'unknown', source: 'unranked', state, index: null, rank: null, ...profile };
  }

  return {
    value: index < profile.conservativeKnownCount ? 'known' : 'unknown',
    source: 'assessment',
    state,
    index,
    rank,
    estimate: profile.estimate,
    conservativeKnownCount: profile.conservativeKnownCount,
  };
}

function manualKnowledgeMapSnapshot(store = wordStateStore()) {
  const map = new Map();
  for (const state of Object.values(store || {})) {
    if (!state || canonicalLang(state.lang) !== 'zh') continue;
    const explicit = manualKnowledge(state);
    const word = normalizeWord(state.word, 'zh');
    if (explicit && word) map.set(word, explicit);
  }
  return map;
}

function classificationForSnapshot(word, profile, manualMap) {
  const normalized = normalizeWord(word, 'zh');
  if (!normalized) return { value: '', source: '', index: null, rank: null };
  const manual = manualMap?.get(normalized) || '';
  const index = frequencyData?.rank?.get(normalized);
  const rank = Number.isInteger(index) ? index + 1 : null;
  if (manual) return { value: manual, source: 'manual', index, rank };
  if (!profile) return { value: '', source: '', index, rank };
  if (!frequencyData) return { value: '', source: 'pending', index: null, rank: null };
  if (!Number.isInteger(index)) return { value: 'unknown', source: 'unranked', index: null, rank: null, ...profile };
  return {
    value: index < profile.conservativeKnownCount ? 'known' : 'unknown',
    source: 'assessment', index, rank,
    estimate: profile.estimate,
    conservativeKnownCount: profile.conservativeKnownCount,
  };
}

function removeKnowledgeClasses(el) {
  el.classList.remove('rw-migaku-known', 'rw-migaku-unknown');
  delete el.dataset.readerEstimatedKnowledge;
  delete el.dataset.readerManualKnowledge;
}

function applyClassificationToElement(el, classification) {
  removeKnowledgeClasses(el);
  if (classification?.value === 'known') {
    el.classList.add('rw-migaku-known');
  } else if (classification?.value === 'unknown') {
    // Manual Known outranks every automatic estimate.  A profile/frequency
    // refresh is advisory and is never allowed to resurrect red after the user
    // said "Знаю".  Only an explicit manual Unknown may clear rw-known.
    if (classification.source !== 'manual' && el.classList.contains('rw-known')) {
      el.classList.add('rw-migaku-known');
      return;
    }
    if (classification.source === 'manual') el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else {
    return;
  }

  if (classification.source === 'manual') el.dataset.readerManualKnowledge = classification.value;
  else el.dataset.readerEstimatedKnowledge = classification.value;

  const rankText = Number.isInteger(classification.rank) ? ` · частотность #${formatNumber(classification.rank)}` : '';
  if (classification.source === 'manual') {
    el.title = `${classification.value === 'known' ? 'Знаю' : 'Не знаю'} · вручную${rankText}`;
  } else if (classification.source === 'assessment') {
    el.title = `${classification.value === 'known' ? 'Known' : 'Unknown'} · оценка ≈ ${formatNumber(classification.estimate)}${rankText}`;
  } else if (classification.source === 'unranked') {
    el.title = 'Unknown · слова нет в частотном списке';
  }
}

function applyClassificationBatch(elements) {
  const list = Array.from(elements || []);
  if (!list.length) return;
  const profile = loadProfile();
  const manualMap = manualKnowledgeMapSnapshot();
  for (const el of list) {
    if (!el?.classList?.contains('reader-word')) continue;
    const lang = canonicalLang(el.dataset.lang || currentLang());
    if (lang !== 'zh') {
      removeKnowledgeClasses(el);
      continue;
    }
    const word = el.dataset.word || el.textContent || '';
    applyClassificationToElement(el, classificationForSnapshot(word, profile, manualMap));
  }
}

async function applyEstimateToRenderedWords() {
  if (currentLang() !== 'zh') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const profile = loadProfile();
  if (profile && !frequencyData) {
    try { await loadFrequencyData(); }
    catch (error) { console.warn('[reader vocab] frequency data unavailable', error?.message || error); }
  }
  applyClassificationBatch(root.querySelectorAll('.reader-word[data-word]'));
  decorateWordPanel();
  syncPanelKnowledge();
  ensureVocabularyButton();
}

function profileButtonText() {
  const profile = loadProfile();
  return profile
    ? `≈ ${formatNumber(profile.estimate)} слов · переоценить`
    : '≈ Оценить словарный запас';
}

function syncPanelKnowledge() {
  if (currentLang() !== 'zh') return;
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const yes = panel.querySelector('#reader-migaku-known-btn');
  const no = panel.querySelector('#reader-migaku-unknown-btn');
  const source = panel.querySelector('#reader-migaku-source');
  const estimateButton = panel.querySelector('#reader-vocab-estimate-btn');
  if (estimateButton) estimateButton.textContent = currentLang() === 'zh' ? profileButtonText() : '≈ Оценка словаря · китайский';
  if (!yes || !no || !source) return;

  yes.classList.remove('is-active');
  no.classList.remove('is-active');
  const word = currentPanelWord();
  if (!word || word === '—') { source.textContent = ''; return; }

  const info = classificationFor(word, currentLang());
  if (info.value === 'known') yes.classList.add('is-active');
  if (info.value === 'unknown') no.classList.add('is-active');
  const rankText = Number.isInteger(info.rank) ? `частотность #${formatNumber(info.rank)}` : '';
  if (info.source === 'manual') {
    source.textContent = `${info.value === 'known' ? 'Знаю' : 'Не знаю'} · задано вручную${rankText ? ` · ${rankText}` : ''}`;
  } else if (info.source === 'assessment') {
    source.textContent = info.value === 'known'
      ? `По тесту: Known · базовые ${formatNumber(info.conservativeKnownCount)} из ≈ ${formatNumber(info.estimate)}${rankText ? ` · ${rankText}` : ''}`
      : `По тесту: Unknown · оценка ≈ ${formatNumber(info.estimate)}${rankText ? ` · ${rankText}` : ''}`;
  } else if (info.source === 'unranked') {
    source.textContent = 'Не найдено в частотном списке · считаю Unknown до ручного решения';
  } else {
    source.textContent = rankText || 'Пройди оценку словаря или задай статус вручную';
  }
}

function decorateWordPanel() {
  if (currentLang() !== 'zh') return;
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const actions = panel.querySelector('.reader-word-actions');
  if (!actions) return;

  if (panel.dataset.migakuKnowledge !== '2') {
    panel.dataset.migakuKnowledge = '2';
    panel.querySelector('.rwp-migaku-knowledge')?.remove();
    for (const button of actions.querySelectorAll('button')) {
      const onclick = button.getAttribute('onclick') || '';
      if (onclick.includes('readerMarkSelectedWordKnown') || onclick.includes('readerMarkSelectedWordProblem')) {
        button.style.display = 'none';
        button.setAttribute('aria-hidden', 'true');
      }
    }

    const block = document.createElement('div');
    block.className = 'rwp-migaku-knowledge';
    block.innerHTML = `
      <div class="rwp-migaku-row">
        <button id="reader-migaku-unknown-btn" class="rwp-migaku-btn rwp-migaku-unknown" type="button">Не знаю</button>
        <button id="reader-migaku-known-btn" class="rwp-migaku-btn rwp-migaku-known" type="button">Знаю</button>
      </div>
      <div id="reader-migaku-source" class="rwp-migaku-source"></div>
      <button id="reader-vocab-estimate-btn" class="rwp-vocab-estimate-btn" type="button"></button>`;
    actions.before(block);
    block.querySelector('#reader-migaku-known-btn')?.addEventListener('click', () => markCurrentWord(true));
    block.querySelector('#reader-migaku-unknown-btn')?.addEventListener('click', () => markCurrentWord(false));
    block.querySelector('#reader-vocab-estimate-btn')?.addEventListener('click', () => openVocabularyDashboard());
  }
  syncPanelKnowledge();
}

async function markCurrentWord(known) {
  const word = currentPanelWord();
  const lang = currentLang();
  if (!word || word === '—') return;
  const found = findWordState(word, lang, true);
  const state = found.state;
  if (!state) return;

  state.manualKnowledge = known ? 'known' : 'unknown';
  state.known = !!known;
  state.autoKnown = false;
  if (known) {
    state.status = 'known';
  } else {
    // "Unknown" is not the old "problem" bucket. Keep it learnable without
    // turning a simple yes/no decision into a special warning state.
    state.status = 'learning';
  }
  state.updatedAt = new Date().toISOString();
  persistWordState(found.store);

  const root = document.getElementById('reader-chapter-text');
  root?.querySelectorAll('.reader-word[data-word]').forEach(el => {
    if (canonicalLang(el.dataset.lang || lang) !== lang) return;
    if (normalizeWord(el.dataset.word || '', lang) !== normalizeWord(word, lang)) return;
    applyClassificationToElement(el, classificationFor(word, lang));
  });
  syncPanelKnowledge();
  showToast(known ? '✓ Знаю' : 'Не знаю');
}

// Exact assessment mechanics observed in Migaku 1.192.15.
function randomNormal(mean, stdDev) {
  const u = Math.random() || Number.MIN_VALUE;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stdDev + mean;
}

function selectStep1Indices(length, count) {
  const picked = [];
  if (length <= 0) return picked;
  const target = Math.min(count, length);
  while (picked.length < target) {
    const index = Math.floor(Math.pow(Math.random(), 2) * length);
    if (!picked.includes(index)) picked.push(index);
  }
  return picked;
}

function selectStep2Indices(length, estimate, count) {
  let center = Number(estimate || 0);
  if (center < 100) center = 100;
  const picked = [];
  const target = Math.min(count, length);
  let guard = 0;
  while (picked.length < target && guard < 100000) {
    guard += 1;
    const index = Math.floor(randomNormal(center, center * 0.35));
    if (index < 0 || index >= length || picked.includes(index)) continue;
    picked.push(index);
  }
  // Extremely defensive fallback; with the 40k Mandarin list this should never
  // be needed, but it prevents a damaged data file from hanging the UI.
  for (let i = 0; picked.length < target && i < length; i += 1) {
    if (!picked.includes(i)) picked.push(i);
  }
  return picked;
}

function estimateFromChecks(checks, indices) {
  if (!Array.isArray(checks) || !checks.length || !Array.isArray(indices) || !indices.length) return 0;
  const unknownPrefix = [0];
  for (let i = 0; i < checks.length; i += 1) {
    unknownPrefix.push(unknownPrefix[i] + (checks[i] ? 0 : 1));
  }
  const knownSuffix = new Array(checks.length + 1).fill(0);
  for (let i = checks.length - 1; i >= 0; i -= 1) {
    knownSuffix[i] = knownSuffix[i + 1] + (checks[i] ? 1 : 0);
  }
  let boundary = 0;
  for (let i = 0; i < indices.length + 1; i += 1) {
    if (unknownPrefix[i] === knownSuffix[i]) { boundary = i; break; }
  }
  if (boundary >= indices.length) boundary = indices.length - 1;
  if (boundary < 0) boundary = 0;
  return boundary === 0
    ? 0.5 * indices[boundary]
    : 0.5 * (indices[boundary] + indices[boundary - 1]);
}

function checksFor(indices, knownSet) {
  return indices.map(index => knownSet.has(index));
}

function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeVocabularyEstimate();
  });
  document.body.appendChild(modal);
  return modal;
}

function modalShell(inner, { title = 'Оценка словарного запаса', back = false } = {}) {
  return `<div class="rve-card">
    <div class="rve-head">
      ${back ? '<button class="rve-back" type="button" aria-label="Назад">←</button>' : '<span class="rve-head-spacer"></span>'}
      <div class="rve-title">${title}</div>
      <button class="rve-close" type="button" aria-label="Закрыть">×</button>
    </div>
    ${inner}
  </div>`;
}

function bindModalChrome(modal, { back = null } = {}) {
  modal.querySelector('.rve-close')?.addEventListener('click', closeVocabularyEstimate);
  if (back) modal.querySelector('.rve-back')?.addEventListener('click', back);
}

function currentVocabularyStats() {
  const root = document.getElementById('reader-chapter-text');
  const unique = new Set();
  root?.querySelectorAll('.reader-word[data-word]').forEach(el => {
    if (canonicalLang(el.dataset.lang || currentLang()) !== 'zh') return;
    const word = normalizeWord(el.dataset.word || el.textContent || '', 'zh');
    if (word) unique.add(word);
  });
  const profile = loadProfile();
  const manualMap = manualKnowledgeMapSnapshot();
  let known = 0;
  let unknown = 0;
  let unclassified = 0;
  for (const word of unique) {
    const info = classificationForSnapshot(word, profile, manualMap);
    if (info.value === 'known') known += 1;
    else if (info.value === 'unknown') unknown += 1;
    else unclassified += 1;
  }
  return { total: unique.size, known, unknown, unclassified };
}

async function openVocabularyDashboard() {
  installStyles();
  const modal = ensureModal();
  modal.innerHTML = modalShell('<div class="rve-copy">Загружаю словарь…</div>', { title: 'Китайский словарь' });
  bindModalChrome(modal);
  try { await loadFrequencyData(); }
  catch (error) {
    modal.innerHTML = modalShell(`<div class="rve-copy">Не удалось загрузить частотный список: ${String(error?.message || error)}</div>`, { title: 'Китайский словарь' });
    bindModalChrome(modal);
    return;
  }

  const profile = loadProfile();
  const stats = currentVocabularyStats();
  const knownPct = stats.total ? Math.round(stats.known * 100 / stats.total) : 0;
  const unknownPct = stats.total ? Math.round(stats.unknown * 100 / stats.total) : 0;
  modal.innerHTML = modalShell(`
    <div class="rve-dashboard">
      <div class="rve-result-kicker">Measure my level</div>
      <div class="rve-number">${profile ? `≈ ${formatNumber(profile.estimate)}` : '—'}</div>
      <div class="rve-result-label">${profile ? 'оценка китайского словаря' : 'уровень ещё не измерен'}</div>
      ${profile ? `<div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div>` : ''}
      <div class="rve-stat-grid">
        <div><b>${formatNumber(stats.total)}</b><span>уникальных слов<br>в текущей главе</span></div>
        <div><b>${formatNumber(stats.known)}</b><span>Known · ${knownPct}%</span></div>
        <div><b>${formatNumber(stats.unknown)}</b><span>Unknown · ${unknownPct}%</span></div>
      </div>
      ${stats.unclassified ? `<div class="rve-rule">${formatNumber(stats.unclassified)} слов пока без классификации.</div>` : ''}
      <button class="rve-primary" data-rve-measure type="button">${profile ? 'Пройти тест заново' : 'Оценить мой уровень'}</button>
      <button class="rve-secondary" data-rve-close type="button">Вернуться к чтению</button>
    </div>`, { title: 'Китайский словарь' });
  bindModalChrome(modal);
  modal.querySelector('[data-rve-measure]')?.addEventListener('click', openVocabularyEstimate);
  modal.querySelector('[data-rve-close]')?.addEventListener('click', closeVocabularyEstimate);
}

async function openVocabularyEstimate() {
  installStyles();
  const modal = ensureModal();
  modal.innerHTML = modalShell('<div class="rve-copy">Загружаю китайский частотный список…</div>');
  bindModalChrome(modal);
  let data;
  try {
    data = await loadFrequencyData();
  } catch (error) {
    modal.innerHTML = modalShell(`<div class="rve-copy">Не удалось загрузить данные теста: ${String(error?.message || error)}</div>`);
    bindModalChrome(modal);
    return;
  }
  const profile = loadProfile();
  const previous = profile
    ? `<div class="rve-rule">Текущая оценка: <b>≈ ${formatNumber(profile.estimate)} слов</b>. Базовыми Known считаются ${formatNumber(profile.conservativeKnownCount)} самых частых. Ручные «Знаю / Не знаю» при повторном тесте не стираются.</div>`
    : '';
  modal.innerHTML = modalShell(`
    <div class="rve-welcome">
      <div class="rve-migachu">词</div>
      <div class="rve-copy rve-copy-center"><b>Короткий тест задаст стартовую оценку слов, которые ты уже знаешь.</b><br><br>На каждом экране будет 14 слов. Нажимай только на те, значение которых действительно знаешь без подсказки.</div>
      ${previous}
      <div class="rve-rule">Как в Migaku: сначала 42 слова по всему частотному списку, затем ещё 42 около найденной границы. Итоговая оценка и автоматически Known — не одно и то же: Known задаётся консервативно.</div>
      <button class="rve-primary" type="button">Начать</button>
    </div>`);
  bindModalChrome(modal);
  modal.querySelector('.rve-primary')?.addEventListener('click', () => startAssessment(data));
}

function startAssessment(data = frequencyData) {
  const step1 = selectStep1Indices(data.words.length, STEP1_COUNT).sort((a, b) => a - b);
  assessment = {
    phase: 1,
    page: 0,
    step1,
    step2: [],
    known1: new Set(),
    known2: new Set(),
    preliminaryEstimate: 0,
    startedAt: new Date().toISOString(),
  };
  renderAssessmentPage();
}

function currentIndices() {
  if (!assessment) return [];
  return assessment.phase === 1 ? assessment.step1 : assessment.step2;
}

function currentKnownSet() {
  if (!assessment) return new Set();
  return assessment.phase === 1 ? assessment.known1 : assessment.known2;
}

function currentPageSlice() {
  const indices = currentIndices();
  const start = assessment.page * WORDS_PER_PAGE;
  return indices.slice(start, start + WORDS_PER_PAGE);
}

function difficultyNumber() {
  return (assessment?.phase === 2 ? 3 : 0) + Number(assessment?.page || 0) + 1;
}

function renderAssessmentPage() {
  const modal = ensureModal();
  if (!assessment || !frequencyData) return;
  const indices = currentPageSlice();
  const known = currentKnownSet();
  const selectedOnPage = indices.filter(index => known.has(index)).length;
  const difficulty = difficultyNumber();
  const chips = indices.map(index => {
    const word = frequencyData.words[index] || '';
    const selected = known.has(index);
    return `<button class="rve-word-chip${selected ? ' is-known' : ''}" type="button" data-index="${index}" aria-pressed="${selected ? 'true' : 'false'}"><span>${word}</span><i></i></button>`;
  }).join('');
  modal.innerHTML = modalShell(`
    <div class="rve-assessment-head">
      <div class="rve-page-title">Какие слова ты знаешь?</div>
      <div class="rve-page-desc">Отметь знакомые слова:</div>
    </div>
    <div class="rve-word-grid">${chips}</div>
    <div class="rve-difficulty">Сложность ${difficulty}</div>
    <div class="rve-wave" aria-hidden="true"></div>
    <div class="rve-known-count">${selectedOnPage}/${indices.length} знаю</div>
    <button class="rve-primary rve-continue" type="button">Продолжить</button>`, { title: '', back: true });
  bindModalChrome(modal, { back: goAssessmentBack });
  modal.querySelectorAll('.rve-word-chip').forEach(button => {
    button.addEventListener('click', () => toggleAssessmentWord(Number(button.dataset.index)));
  });
  modal.querySelector('.rve-continue')?.addEventListener('click', continueAssessment);
}

function toggleAssessmentWord(index) {
  if (!assessment || !Number.isInteger(index)) return;
  const known = currentKnownSet();
  if (known.has(index)) known.delete(index);
  else known.add(index);
  renderAssessmentPage();
}

function goAssessmentBack() {
  if (!assessment) { closeVocabularyEstimate(); return; }
  if (assessment.page > 0) {
    assessment.page -= 1;
    renderAssessmentPage();
    return;
  }
  if (assessment.phase === 2) {
    renderIntermediary();
    return;
  }
  openVocabularyEstimate();
}

function continueAssessment() {
  if (!assessment) return;
  const pageCount = Math.ceil(currentIndices().length / WORDS_PER_PAGE);
  if (assessment.page < pageCount - 1) {
    assessment.page += 1;
    renderAssessmentPage();
    return;
  }
  if (assessment.phase === 1) {
    assessment.preliminaryEstimate = estimateFromChecks(checksFor(assessment.step1, assessment.known1), [...assessment.step1]);
    renderIntermediary();
    return;
  }
  finishAssessment();
}

function renderIntermediary() {
  const modal = ensureModal();
  if (!assessment) return;
  modal.innerHTML = modalShell(`
    <div class="rve-intermediary">
      <div class="rve-migachu">✓</div>
      <div class="rve-inter-title">Отлично!</div>
      <div class="rve-copy rve-copy-center">Теперь ещё один короткий раунд — слова будут подобраны ближе к твоему предполагаемому уровню.</div>
      <button class="rve-primary" type="button">Продолжить</button>
    </div>`, { title: '', back: true });
  bindModalChrome(modal, {
    back: () => {
      assessment.phase = 1;
      assessment.page = Math.max(0, Math.ceil(assessment.step1.length / WORDS_PER_PAGE) - 1);
      renderAssessmentPage();
    },
  });
  modal.querySelector('.rve-primary')?.addEventListener('click', startAssessmentPhase2);
}

function startAssessmentPhase2() {
  if (!assessment || !frequencyData) return;
  if (!assessment.step2.length) {
    assessment.step2 = selectStep2Indices(
      frequencyData.words.length,
      assessment.preliminaryEstimate,
      STEP2_COUNT,
    ).sort((a, b) => a - b);
  }
  assessment.phase = 2;
  assessment.page = 0;
  renderAssessmentPage();
}

function finishAssessment() {
  if (!assessment || !frequencyData) return;
  const estimateRaw = estimateFromChecks(checksFor(assessment.step2, assessment.known2), [...assessment.step2]);
  const estimate = Math.max(0, Math.round(estimateRaw));
  const conservativeKnownCount = conservativeCountForEstimate(estimate, frequencyData.words.length);
  const profile = saveProfile({
    estimate,
    conservativeKnownCount,
    listLength: frequencyData.words.length,
    source: frequencyData.source,
    assessedAt: new Date().toISOString(),
    step1Estimate: Math.round(assessment.preliminaryEstimate),
    step1: assessment.step1.map(index => ({ index, word: frequencyData.words[index], known: assessment.known1.has(index) })),
    step2: assessment.step2.map(index => ({ index, word: frequencyData.words[index], known: assessment.known2.has(index) })),
  });
  assessment = null;
  applyEstimateToRenderedWords().catch(() => {});
  renderAssessmentResult(profile);
}

function renderAssessmentResult(profile) {
  const modal = ensureModal();
  modal.innerHTML = modalShell(`
    <div class="rve-result">
      <div class="rve-result-kicker">Оценка словарного запаса</div>
      <div class="rve-number">≈ ${formatNumber(profile.estimate)}</div>
      <div class="rve-result-label">китайских слов</div>
      <div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div>
      <div class="rve-rule">Как в оригинальной логике Migaku, Reader AI не утверждает, что ты знаешь каждое слово до ≈ ${formatNumber(profile.estimate)}. Автоматически Known становятся только ${formatNumber(profile.conservativeKnownCount)} самых частых слов. Любое ручное «Знаю / Не знаю» имеет приоритет.</div>
      <button class="rve-primary rve-done" type="button">Готово</button>
      <button class="rve-secondary" type="button">Пройти ещё раз</button>
    </div>`);
  bindModalChrome(modal);
  modal.querySelector('.rve-done')?.addEventListener('click', openVocabularyDashboard);
  modal.querySelector('.rve-secondary')?.addEventListener('click', () => startAssessment(frequencyData));
}

function closeVocabularyEstimate() {
  document.getElementById(MODAL_ID)?.remove();
  assessment = null;
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view .reader-word.rw-migaku-known {
      background: transparent !important;
      box-shadow: none !important;
      text-decoration: none !important;
      color: inherit !important;
      opacity: 1 !important;
    }
    #reader-reading-view .reader-word.rw-migaku-unknown {
      background: transparent !important;
      box-shadow: none !important;
      color: inherit !important;
      opacity: 1 !important;
      text-decoration-line: underline !important;
      text-decoration-color: #ff3f75 !important;
      text-decoration-thickness: .09em !important;
      text-underline-offset: .13em !important;
      text-decoration-skip-ink: none !important;
    }
    #reader-reading-view .reader-word.rw-migaku-unknown[data-reader-manual-knowledge="unknown"] {
      text-decoration-thickness: .12em !important;
    }

    .rwp-migaku-knowledge {
      margin: 11px 0 10px;padding: 10px;border: 1px solid var(--border);border-radius: 13px;
      background: color-mix(in srgb, var(--surface2) 86%, transparent);
    }
    .rwp-migaku-row { display:grid;grid-template-columns:1fr 1fr;gap:9px; }
    .rwp-migaku-btn {
      min-height:50px;border-radius:12px;border:1px solid var(--border);font-family:'IBM Plex Sans',sans-serif;
      font-size:.95rem;font-weight:700;cursor:pointer;transition:transform .08s ease,border-color .15s ease,background .15s ease;
    }
    .rwp-migaku-btn:active { transform:scale(.98); }
    .rwp-migaku-known { background:color-mix(in srgb,#12c9a7 12%,var(--surface));color:var(--text); }
    .rwp-migaku-unknown { background:color-mix(in srgb,#ff3f75 12%,var(--surface));color:var(--text); }
    .rwp-migaku-known.is-active { border-color:#12c9a7;box-shadow:0 0 0 1px #12c9a7 inset; }
    .rwp-migaku-unknown.is-active { border-color:#ff3f75;box-shadow:0 0 0 1px #ff3f75 inset; }
    .rwp-migaku-source { min-height:1.2em;margin:7px 2px 0;font-size:.69rem;color:var(--text-muted);line-height:1.35; }
    .rwp-vocab-estimate-btn { width:100%;margin-top:7px;padding:8px 4px 2px;border:0;background:none;color:var(--accent);font-family:'IBM Plex Sans',sans-serif;font-size:.76rem;cursor:pointer;text-align:left; }

    /* Classification owns only state and underline. Chinese annotation
       geometry is isolated in zh-readable-inline.js. */

    #${MODAL_ID} { position:fixed;inset:0;z-index:10040;display:flex;align-items:stretch;justify-content:center;background:#12002f;color:#fff; }
    #${MODAL_ID} .rve-card { width:min(100%,620px);min-height:100dvh;box-sizing:border-box;overflow:auto;padding:calc(12px + env(safe-area-inset-top)) 22px calc(22px + env(safe-area-inset-bottom));background:#12002f;color:#fff;font-family:'IBM Plex Sans',system-ui,sans-serif; }
    #${MODAL_ID} .rve-head { min-height:52px;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;gap:6px; }
    #${MODAL_ID} .rve-title { text-align:center;font-size:1.08rem;font-weight:800; }
    #${MODAL_ID} .rve-back,#${MODAL_ID} .rve-close { width:42px;height:42px;border:0;background:none;color:#bb65ff;font-size:1.7rem;cursor:pointer;border-radius:50%; }
    #${MODAL_ID} .rve-close { color:#a89fba;font-size:1.55rem; }
    #${MODAL_ID} .rve-welcome,#${MODAL_ID} .rve-intermediary,#${MODAL_ID} .rve-result { max-width:520px;margin:8vh auto 0;text-align:center; }
    #${MODAL_ID} .rve-migachu { width:94px;height:94px;margin:0 auto 22px;border-radius:30px;display:grid;place-items:center;background:linear-gradient(145deg,#1ddbd4,#9b4dff);font-size:2.6rem;font-weight:900;box-shadow:0 16px 40px rgba(0,0,0,.24); }
    #${MODAL_ID} .rve-copy { color:#d7cfe2;font-size:.94rem;line-height:1.5; }
    #${MODAL_ID} .rve-copy-center { text-align:center; }
    #${MODAL_ID} .rve-rule { margin:18px 0 0;padding:13px 14px;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(255,255,255,.06);font-size:.78rem;line-height:1.46;color:#bfb5cf;text-align:left; }
    #${MODAL_ID} .rve-primary { width:100%;min-height:56px;margin-top:26px;border:0;border-radius:999px;background:linear-gradient(180deg,#ff9c35,#ff3478);color:#fff;font:800 1rem 'IBM Plex Sans',sans-serif;cursor:pointer; }
    #${MODAL_ID} .rve-secondary { width:100%;min-height:48px;margin-top:10px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:transparent;color:#d8cfe5;font:700 .9rem 'IBM Plex Sans',sans-serif;cursor:pointer; }
    #${MODAL_ID} .rve-assessment-head { text-align:center;margin:16px 0 28px; }
    #${MODAL_ID} .rve-page-title { font-size:2rem;line-height:1.04;font-weight:900;letter-spacing:-.035em; }
    #${MODAL_ID} .rve-page-desc { color:#aaa0b5;font-size:.96rem;margin-top:10px; }
    #${MODAL_ID} .rve-word-grid { display:flex;flex-wrap:wrap;justify-content:center;align-content:flex-start;gap:16px 20px;max-width:520px;margin:0 auto;min-height:430px;padding:8px 0 12px; }
    #${MODAL_ID} .rve-word-chip { position:relative;min-width:76px;max-width:170px;min-height:76px;padding:10px 16px 15px;border:0;border-radius:18px;background:#261450;color:#8f85a4;font:800 1.58rem 'Noto Serif SC','IBM Plex Sans',sans-serif;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.12);transition:transform .08s ease,background .12s ease,color .12s ease; }
    #${MODAL_ID} .rve-word-chip:active { transform:scale(.97); }
    #${MODAL_ID} .rve-word-chip i { position:absolute;left:20%;right:20%;bottom:11px;height:4px;border-radius:999px;background:#d91d72; }
    #${MODAL_ID} .rve-word-chip.is-known { background:#173f48;color:#f8fffe;box-shadow:0 0 0 2px #14c8a7 inset,0 5px 0 rgba(0,0,0,.12); }
    #${MODAL_ID} .rve-word-chip.is-known i { background:#14c8a7; }
    #${MODAL_ID} .rve-difficulty { width:max-content;margin:10px auto 8px;padding:6px 13px;border-radius:999px;background:#139ee8;color:#fff;font-weight:800;font-size:.8rem; }
    #${MODAL_ID} .rve-wave { height:9px;max-width:500px;margin:0 auto 22px;background:radial-gradient(circle at 6px 0,#7b37cf 6px,transparent 6.5px) 0 0/18px 9px repeat-x; }
    #${MODAL_ID} .rve-known-count { text-align:center;color:#a79cb7;font-size:.9rem;font-weight:700;margin-bottom:2px; }
    #${MODAL_ID} .rve-continue { margin-top:18px; }
    #${MODAL_ID} .rve-inter-title { font-size:2rem;font-weight:900;margin-bottom:12px; }
    #${MODAL_ID} .rve-result-kicker { color:#bcb1cc;font-size:.86rem;font-weight:700; }
    #${MODAL_ID} .rve-number { margin-top:10px;font-size:3.35rem;line-height:1;font-weight:950;color:#ff9634;letter-spacing:-.04em; }
    #${MODAL_ID} .rve-result-label { color:#bfb5cf;font-size:.9rem;margin-top:7px; }
    #${MODAL_ID} .rve-known-baseline { display:flex;align-items:center;justify-content:center;gap:10px;margin:26px auto 8px;padding:14px;border-radius:16px;background:rgba(18,201,167,.10);max-width:330px; }
    #${MODAL_ID} .rve-known-baseline b { color:#12c9a7;font-size:1.55rem; }
    #${MODAL_ID} .rve-known-baseline span { color:#d7cfe2;font-size:.8rem; }
    #${MODAL_ID} .rve-dashboard { max-width:520px;margin:4vh auto 0;text-align:center; }
    #${MODAL_ID} .rve-stat-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:24px 0 8px; }
    #${MODAL_ID} .rve-stat-grid > div { min-height:92px;padding:13px 8px;border-radius:16px;background:rgba(255,255,255,.07);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px; }
    #${MODAL_ID} .rve-stat-grid b { font-size:1.45rem;color:#19d0b0; }
    #${MODAL_ID} .rve-stat-grid span { color:#c9bfd7;font-size:.72rem;line-height:1.3; }
    @media(max-width:390px) {
      #${MODAL_ID} .rve-card { padding-left:16px;padding-right:16px; }
      #${MODAL_ID} .rve-word-grid { gap:12px 13px;min-height:390px; }
      #${MODAL_ID} .rve-word-chip { min-width:68px;min-height:68px;padding:8px 12px 14px;font-size:1.4rem; }
      #${MODAL_ID} .rve-page-title { font-size:1.72rem; }
    }
  `;
  document.head.appendChild(style);
}

function queueWordNode(node) {
  if (!(node instanceof Element)) return;
  if (node.classList.contains('reader-word')) pendingWordNodes.add(node);
  node.querySelectorAll?.('.reader-word').forEach(word => pendingWordNodes.add(word));
}

function flushPendingWordNodes() {
  pendingBatchScheduled = false;
  if (pendingWordNodes.size && currentLang() === 'zh') {
    const batch = Array.from(pendingWordNodes);
    pendingWordNodes.clear();
    applyClassificationBatch(batch);
  } else {
    pendingWordNodes.clear();
  }
  ensureVocabularyButton();
}

function schedulePendingWordBatch() {
  if (pendingBatchScheduled) return;
  pendingBatchScheduled = true;
  requestAnimationFrame(flushPendingWordNodes);
}

function installRenderObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) { setTimeout(installRenderObserver, 250); return; }
  if (renderObserver && renderObserverRoot === root) return;
  renderObserver?.disconnect();
  renderObserverRoot = root;
  renderObserver = new MutationObserver(records => {
    if (currentLang() !== 'zh') return;
    for (const record of records) {
      for (const node of record.addedNodes || []) queueWordNode(node);
    }
    if (pendingWordNodes.size) schedulePendingWordBatch();
  });
  renderObserver.observe(root, { childList: true, subtree: true });
  if (currentLang() === 'zh') {
    root.querySelectorAll('.reader-word').forEach(word => pendingWordNodes.add(word));
    schedulePendingWordBatch();
  }
}

function ensureVocabularyButton() {
  const top = document.querySelector('#reader-reading-view .rd-top');
  if (!top) return null;
  let button = document.getElementById('reader-vocab-btn');
  if (!button) {
    button = document.createElement('button');
    button.id = 'reader-vocab-btn';
    button.type = 'button';
    button.className = 'rd-icon rd-vocab-btn';
    button.textContent = '词';
    button.title = 'Словарь · Measure my level';
    button.setAttribute('aria-label', 'Словарь и оценка уровня');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openVocabularyDashboard();
    });
    const pinyin = document.getElementById('reader-pinyin-btn');
    if (pinyin?.parentNode === top) top.insertBefore(button, pinyin);
    else top.appendChild(button);
  }
  toolbarButton = button;
  button.style.display = currentLang() === 'zh' ? '' : 'none';
  return button;
}

function installPanelHook() {
  if (document.documentElement?.dataset?.readerVocabPanelHook === '1') return;
  if (document.documentElement) document.documentElement.dataset.readerVocabPanelHook = '1';
  document.addEventListener('click', event => {
    if (currentLang() !== 'zh') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.('#reader-chapter-text .reader-word')) return;
    queueMicrotask(() => { decorateWordPanel(); syncPanelKnowledge(); });
    setTimeout(() => { decorateWordPanel(); syncPanelKnowledge(); }, 40);
  }, true);
}

function warmFrequencyWhenUseful() {
  if (!loadProfile()) return;
  const run = () => loadFrequencyData()
    .then(() => { if (currentLang() === 'zh') return applyEstimateToRenderedWords(); })
    .catch(error => console.warn('[reader vocab] unable to warm Mandarin list', error?.message || error));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 900 });
  else setTimeout(run, 250);
}

function bootVocabularyUi() {
  ensureVocabularyButton();
  installPanelHook();
  installRenderObserver();
  decorateWordPanel();
  warmFrequencyWhenUseful();
}

export function installVocabularyEstimate() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (globalThis.__readerVocabularyEstimateVersion === 7) return;
  globalThis.__readerVocabularyEstimateVersion = 7;
  installStyles();

  globalThis.readerOpenVocabularyEstimate = openVocabularyDashboard;
  globalThis.readerStartVocabularyEstimate = openVocabularyEstimate;
  globalThis.readerCloseVocabularyEstimate = closeVocabularyEstimate;
  globalThis.readerApplyVocabularyEstimate = applyEstimateToRenderedWords;
  globalThis.readerMigakuMarkKnown = () => markCurrentWord(true);
  globalThis.readerMigakuMarkUnknown = () => markCurrentWord(false);
  globalThis.readerVocabularyEstimateProfile = loadProfile;
  globalThis.readerVocabularyKnowledgeFor = (word, lang = 'zh') => classificationFor(word, lang);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootVocabularyUi, { once: true });
  } else {
    bootVocabularyUi();
  }
  window.addEventListener('pageshow', bootVocabularyUi);
}

installVocabularyEstimate();

export {
  conservativeCountForEstimate,
  estimateFromChecks,
  selectStep1Indices,
  selectStep2Indices,
};
