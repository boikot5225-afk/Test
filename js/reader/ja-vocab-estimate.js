// Migaku-style Known / Unknown vocabulary layer for Japanese, the way
// vocab-estimate.js does it for Chinese and en-vocab-estimate.js for English:
// a frequency-ranked word list -> a short adaptive test -> a conservative Known
// baseline -> manual override.
//
// Two things are specific to Japanese.
//
// A word in the text is almost never in its dictionary form. 食べました has to
// reduce to 食べる before it has a rank at all, so this module conjugates with
// ja-dict's rule table. It does that against its own 40k list rather than the
// bundled 18MB core dictionary: Reader's core owns that dictionary and is
// frozen, and building a second copy of it here would double the parsed JSON a
// phone holds for no gain — the test only ever asks about words that are in the
// frequency list anyway.
//
// A word has two spellings. 意見 and いけん are one word, so both columns of the
// list index to the same rank and a reader who met either has met the word.
import { createDeinflector } from './ja-dict.js';

const PROFILE_BASE_KEY = 'an2_reader_vocab_estimate_ja_v1';
const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const OWNER_KEY = 'an2_reader_active_owner_v1';
const FREQ_URL = 'data/ja_vocab_frequency.tsv?v=1';
const MODAL_ID = 'reader-vocab-estimate-modal';
const STYLE_ID = 'reader-ja-vocab-style-v1';
const BUTTON_ID = 'reader-ja-vocab-btn';
const WORDS_PER_PAGE = 14;
const STEP1_COUNT = 42;
const STEP2_COUNT = 42;
// The generator caps the list at 40000 and refuses to emit fewer than 30000, so
// anything below that here means a truncated download, not a smaller corpus.
const MIN_EXPECTED_COUNT = 30000;

let dataPromise = null;
let japaneseData = null;
let assessment = null;
let renderObserver = null;
let renderObserverRoot = null;
let pendingWordNodes = new Set();
let pendingBatchScheduled = false;

function canonicalLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ja' || raw.startsWith('ja-') || raw === 'jp' || raw === 'japanese') return 'ja';
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn' || raw === 'chinese') return 'zh';
  if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en';
  if (raw === 'es' || raw.startsWith('es-') || raw === 'spanish') return 'es';
  return 'fr';
}

function currentLang() {
  return canonicalLang(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  );
}

function ownerId() {
  try { return localStorage.getItem(OWNER_KEY) || 'guest'; }
  catch { return 'guest'; }
}

function scopedKey(base) { return `${base}::${ownerId()}`; }

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Math.max(0, Math.round(Number(value) || 0)));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Japanese has no case to fold and no accents to strip; NFC is the whole of it.
function normalizeSurface(value) {
  return String(value || '').normalize('NFC').trim();
}

function wordStateStore() {
  try { return JSON.parse(localStorage.getItem(scopedKey(WORD_STATE_BASE_KEY)) || '{}') || {}; }
  catch { return {}; }
}

function persistWordState(store) {
  try { localStorage.setItem(scopedKey(WORD_STATE_BASE_KEY), JSON.stringify(store)); }
  catch (error) { console.warn('[reader ja vocab] word state save failed', error?.message || error); }
}

function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(PROFILE_BASE_KEY)) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isFinite(Number(raw.estimate))) return null;
    return raw;
  } catch { return null; }
}

function saveProfile(profile) {
  try { localStorage.setItem(scopedKey(PROFILE_BASE_KEY), JSON.stringify(profile)); }
  catch (error) { console.warn('[reader ja vocab] profile save failed', error?.message || error); }
  return profile;
}

// ── data ────────────────────────────────────────────────────────────────────

function buildJapaneseData(text) {
  const entries = [];
  const rank = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const [word, reading, pos] = line.split('\t');
    const surface = normalizeSurface(word);
    if (!surface) continue;
    const index = entries.length;
    entries.push({ word: surface, reading: normalizeSurface(reading) || surface, pos: pos || '' });
    // Both spellings reach the same rank. First writer wins: the list is in
    // frequency order, so an earlier row is the more common word.
    if (!rank.has(surface)) rank.set(surface, index);
    const kana = normalizeSurface(reading);
    if (kana && !rank.has(kana)) rank.set(kana, index);
  }
  return { entries, rank };
}

async function loadJapaneseData() {
  if (japaneseData) return japaneseData;
  if (dataPromise) return dataPromise;
  dataPromise = fetch(FREQ_URL, { cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`Japanese frequency: HTTP ${response.status}`);
      return response.text();
    })
    .then(text => {
      const data = buildJapaneseData(text);
      if (data.entries.length < MIN_EXPECTED_COUNT) {
        throw new Error(`Japanese frequency list too small: ${data.entries.length}`);
      }
      japaneseData = data;
      try { window.dispatchEvent(new CustomEvent('reader:ja-vocab-ready')); } catch {}
      return data;
    })
    .finally(() => { dataPromise = null; });
  return dataPromise;
}

// The rule table needs a [reading, pos] row for a candidate spelling; the
// frequency list is the vocabulary this module knows about.
const deinflect = createDeinflector(candidate => {
  const index = japaneseData?.rank.get(candidate);
  if (index === undefined) return null;
  const entry = japaneseData.entries[index];
  return entry ? [entry.reading, entry.pos, ''] : null;
});

const rankCache = new Map();
const RANK_CACHE_MAX = 4000;

function rankIndexForWordSync(word) {
  const surface = normalizeSurface(word);
  if (!surface || !japaneseData) return null;
  if (rankCache.has(surface)) return rankCache.get(surface);
  let index = japaneseData.rank.get(surface);
  if (index === undefined) {
    const hit = deinflect(surface);
    index = hit ? japaneseData.rank.get(hit.lemma) : undefined;
  }
  const result = index === undefined ? null : index;
  if (rankCache.size >= RANK_CACHE_MAX) rankCache.clear();
  rankCache.set(surface, result);
  return result;
}

function lemmaForWordSync(word) {
  const surface = normalizeSurface(word);
  if (!surface || !japaneseData) return surface;
  if (japaneseData.rank.has(surface)) return surface;
  return deinflect(surface)?.lemma || surface;
}

// ── knowledge ───────────────────────────────────────────────────────────────

function directStateKey(word) { return `ja:${normalizeSurface(word)}`; }

function findWordState(word, create = false) {
  const store = wordStateStore();
  const keys = [directStateKey(word)];
  const lemma = lemmaForWordSync(word);
  if (lemma && lemma !== normalizeSurface(word)) keys.push(directStateKey(lemma));
  for (const key of keys) {
    if (store[key]) return { store, key, state: store[key] };
  }
  const key = keys[keys.length - 1];
  if (create) store[key] = {};
  return { store, key, state: store[key] || null };
}

// A decision the reader made by hand outranks any estimate, in both directions.
function manualKnowledge(state) {
  if (!state) return '';
  const explicit = String(state.migakuKnowledge || '').trim().toLowerCase();
  if (explicit === 'known' || explicit === 'unknown') return explicit;
  const status = String(state.status || '').trim().toLowerCase();
  if (state.known === true && status === 'known' && state.autoKnown === false) return 'known';
  if (state.known === false && state.saved === true && (status === 'problem' || status === 'hard')) return 'unknown';
  return '';
}

// The estimate is how many words the reader knows, not which ones. Declaring
// the whole head of the list Known on that basis would hide words they have
// never met, so only a fraction of it is taken automatically — the same 60%
// below 20k that Chinese and English use, capped at 10k.
function conservativeCountForEstimate(estimate, listLength) {
  const value = Math.max(0, Math.round(Number(estimate) || 0));
  const scaled = value < 20000 ? value * 0.6 : Math.min(10000, value * 0.5);
  return Math.max(0, Math.min(listLength, Math.round(scaled)));
}

function classificationFor(word) {
  const { state } = findWordState(word, false);
  const manual = manualKnowledge(state);
  const index = rankIndexForWordSync(word);
  const rank = Number.isInteger(index) ? index + 1 : null;
  if (manual) return { value: manual, source: 'manual', state, index, rank };

  const profile = loadProfile();
  if (!profile) return { value: '', source: '', state, index, rank };
  if (!Number.isInteger(index)) {
    // Not in the frequency list at all. For Japanese that is usually a compound
    // or a name rather than a rare word, but either way it has not been vouched
    // for, so it stays Unknown.
    return { value: 'unknown', source: 'unranked', state, index: null, rank: null, ...profile };
  }
  return {
    value: index < profile.conservativeKnownCount ? 'known' : 'unknown',
    source: 'assessment',
    state,
    index,
    rank,
    ...profile,
  };
}

function removeKnowledgeClasses(el) {
  el.classList.remove('rw-migaku-known', 'rw-migaku-unknown');
}

function applyClassificationToElement(el, info) {
  if (!(el instanceof Element)) return;
  removeKnowledgeClasses(el);
  if (!info?.value) { el.removeAttribute('data-migaku-rank'); return; }
  if (info.value === 'known') {
    el.classList.add('rw-migaku-known');
  } else {
    // An estimate must not undo a word the reader has already learned by hand;
    // only an explicit manual Unknown may.
    if (info.source !== 'manual' && el.classList.contains('rw-known')) {
      el.classList.add('rw-migaku-known');
    } else {
      if (info.source === 'manual') el.classList.remove('rw-known');
      el.classList.add('rw-migaku-unknown');
    }
  }
  if (info.rank) el.dataset.migakuRank = String(info.rank);
  else el.removeAttribute('data-migaku-rank');
  const rankText = info.rank ? ` · #${formatNumber(info.rank)}` : '';
  if (info.source === 'manual') {
    el.title = `${info.value === 'known' ? 'Знаю' : 'Не знаю'} · вручную${rankText}`;
  } else if (info.source === 'assessment') {
    el.title = `${info.value === 'known' ? 'Known' : 'Unknown'} · оценка ≈ ${formatNumber(info.estimate)}${rankText}`;
  } else if (info.source === 'unranked') {
    el.title = 'Unknown · слова нет в частотном списке';
  }
}

function applyClassificationBatch(elements) {
  if (!japaneseData || currentLang() !== 'ja') return;
  for (const el of elements) {
    if (!(el instanceof Element) || !el.classList.contains('reader-word')) continue;
    if (el.dataset.lang && canonicalLang(el.dataset.lang) !== 'ja') continue;
    applyClassificationToElement(el, classificationFor(el.dataset.word || el.textContent || ''));
  }
}

async function applyEstimateToRenderedWords() {
  if (currentLang() !== 'ja') return;
  await loadJapaneseData();
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  applyClassificationBatch(Array.from(root.querySelectorAll('.reader-word')));
  // The reading row under a word is keyed off these classes, so it has to be
  // told the verdicts changed.
  try { globalThis.readerSyncJaReadableInline?.(); } catch {}
}

// ── word panel ──────────────────────────────────────────────────────────────

function currentPanelWord() {
  const panel = document.getElementById('reader-word-panel');
  return normalizeSurface(panel?.dataset?.word || panel?.querySelector('#reader-word-title')?.textContent || '');
}

function showToast(message) {
  try { globalThis.showToast?.(message); } catch {}
}

function profileButtonText() {
  const profile = loadProfile();
  return profile
    ? `日本語 ≈ ${formatNumber(profile.estimate)} слов · тест заново`
    : 'Оценить японский словарный запас';
}

function syncPanelKnowledge() {
  if (currentLang() !== 'ja') return;
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const word = currentPanelWord();
  const info = word ? classificationFor(word) : null;
  const known = panel.querySelector('#reader-ja-known-btn');
  const unknown = panel.querySelector('#reader-ja-unknown-btn');
  known?.classList.toggle('is-active', info?.value === 'known');
  unknown?.classList.toggle('is-active', info?.value === 'unknown');
  const source = panel.querySelector('#reader-ja-knowledge-source');
  if (source) {
    const rankText = info?.rank ? ` · #${formatNumber(info.rank)}` : '';
    source.textContent = !info?.value ? 'Уровень ещё не измерен'
      : info.source === 'manual' ? `Вручную${rankText}`
      : info.source === 'unranked' ? 'Нет в частотном списке'
      : `По тесту: ${info.value === 'known' ? 'Known' : 'Unknown'}${rankText}`;
  }
  const button = panel.querySelector('#reader-ja-vocab-estimate-btn');
  if (button) button.textContent = profileButtonText();
}

function decorateWordPanel() {
  if (currentLang() !== 'ja') return;
  const panel = document.getElementById('reader-word-panel');
  const actions = panel?.querySelector('.reader-word-actions');
  if (!panel || !actions) return;
  if (panel.dataset.migakuKnowledgeJa !== 'ja1') {
    panel.dataset.migakuKnowledgeJa = 'ja1';
    panel.querySelector('.rwp-migaku-knowledge-ja')?.remove();
    const block = document.createElement('div');
    block.className = 'rwp-migaku-knowledge rwp-migaku-knowledge-ja';
    block.innerHTML = `
      <div class="rwp-migaku-row">
        <button id="reader-ja-unknown-btn" class="rwp-migaku-btn rwp-migaku-unknown" type="button">Не знаю</button>
        <button id="reader-ja-known-btn" class="rwp-migaku-btn rwp-migaku-known" type="button">Знаю</button>
      </div>
      <div id="reader-ja-knowledge-source" class="rwp-migaku-source"></div>
      <button id="reader-ja-vocab-estimate-btn" class="rwp-vocab-estimate-btn" type="button"></button>`;
    actions.before(block);
    block.querySelector('#reader-ja-known-btn')?.addEventListener('click', () => markCurrentWord(true));
    block.querySelector('#reader-ja-unknown-btn')?.addEventListener('click', () => markCurrentWord(false));
    block.querySelector('#reader-ja-vocab-estimate-btn')?.addEventListener('click', openVocabularyDashboard);
  }
  syncPanelKnowledge();
}

async function markCurrentWord(known) {
  const word = currentPanelWord();
  if (!word) return;
  await loadJapaneseData().catch(() => {});
  const { store, key } = findWordState(word, true);
  const state = store[key] || (store[key] = {});
  state.migakuKnowledge = known ? 'known' : 'unknown';
  state.autoKnown = false;
  state.known = known;
  state.status = known ? 'known' : 'learning';
  state.updatedAt = new Date().toISOString();
  persistWordState(store);
  await applyEstimateToRenderedWords().catch(() => {});
  syncPanelKnowledge();
  showToast(known ? '✅ Знаю' : '📌 Не знаю');
}

// ── assessment ──────────────────────────────────────────────────────────────

function randomNormal(mean, stdDev) {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function selectStep1Indices(length, count) {
  const picks = new Set();
  // Log-spaced across the whole list: the first page has to be able to tell a
  // beginner from a fluent reader, and linear sampling would spend most of its
  // words in the rare tail where neither knows any of them.
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const index = Math.min(length - 1, Math.round(Math.pow(length, t) - 1));
    let candidate = index;
    while (picks.has(candidate) && candidate < length - 1) candidate++;
    picks.add(candidate);
  }
  return [...picks].slice(0, count).sort((a, b) => a - b);
}

function selectStep2Indices(length, estimate, count) {
  const picks = new Set();
  const centre = Math.max(1, Math.min(length - 1, Math.round(estimate)));
  let guard = 0;
  while (picks.size < count && guard++ < count * 40) {
    const index = Math.round(randomNormal(centre, Math.max(200, centre * 0.45)));
    if (index >= 0 && index < length) picks.add(index);
  }
  return [...picks].slice(0, count).sort((a, b) => a - b);
}

// Each checked word stands for the slice of the list it was drawn from.
function estimateFromChecks(checks, indices) {
  if (!checks.length) return 0;
  let total = 0;
  for (let i = 0; i < indices.length; i++) {
    if (!checks[i]) continue;
    const previous = i === 0 ? 0 : indices[i - 1];
    const next = i === indices.length - 1 ? indices[i] : indices[i + 1];
    total += (next - previous) / 2;
  }
  return total;
}

function checksFor(indices, knownSet) { return indices.map(index => knownSet.has(index)); }

function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    document.body.appendChild(modal);
  }
  return modal;
}

function modalShell(inner, { title = 'Оценка словарного запаса', back = false } = {}) {
  return `<div class="rve-backdrop"><div class="rve-sheet">
    <div class="rve-head">${back ? '<button class="rve-back" type="button">‹</button>' : '<span></span>'}
    <div class="rve-title">${escapeHtml(title)}</div>
    <button class="rve-close" type="button">×</button></div>
    <div class="rve-body">${inner}</div></div></div>`;
}

function bindModalChrome(modal, { back = null } = {}) {
  modal.querySelector('.rve-close')?.addEventListener('click', closeVocabularyEstimate);
  modal.querySelector('.rve-backdrop')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeVocabularyEstimate();
  });
  modal.querySelector('.rve-back')?.addEventListener('click', back || goAssessmentBack);
}

function currentVocabularyStats() {
  const root = document.getElementById('reader-chapter-text');
  const lemmas = new Map();
  if (root) {
    for (const el of root.querySelectorAll('.reader-word')) {
      const word = normalizeSurface(el.dataset.word || el.textContent || '');
      if (!word) continue;
      const lemma = lemmaForWordSync(word);
      if (!lemmas.has(lemma)) lemmas.set(lemma, classificationFor(word));
    }
  }
  let known = 0, unknown = 0;
  for (const info of lemmas.values()) {
    if (info?.value === 'known') known++;
    else if (info?.value === 'unknown') unknown++;
  }
  return { total: lemmas.size, known, unknown };
}

async function openVocabularyDashboard() {
  if (currentLang() !== 'ja') return;
  const modal = ensureModal();
  modal.innerHTML = modalShell('<div class="rve-copy">Загружаю японский частотный список…</div>', { title: '日本語 vocabulary' });
  bindModalChrome(modal);
  let data;
  try { data = await loadJapaneseData(); }
  catch (error) {
    modal.innerHTML = modalShell(`<div class="rve-copy">Не удалось загрузить данные: ${escapeHtml(error?.message || error)}</div>`, { title: '日本語 vocabulary' });
    bindModalChrome(modal);
    return;
  }
  const profile = loadProfile();
  const stats = currentVocabularyStats();
  const knownPct = stats.total ? Math.round(stats.known * 100 / stats.total) : 0;
  modal.innerHTML = modalShell(`<div class="rve-dashboard">
    <div class="rve-result-kicker">Измерить уровень</div>
    <div class="rve-number">${profile ? `≈ ${formatNumber(profile.estimate)}` : '—'}</div>
    <div class="rve-result-label">${profile ? 'оценка японского словаря' : 'уровень ещё не измерен'}</div>
    ${profile ? `<div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div>` : ''}
    <div class="rve-stat-grid">
      <div><b>${stats.total}</b><span>уникальных слов в главе</span></div>
      <div><b>${stats.known}</b><span>Known · ${knownPct}%</span></div>
      <div><b>${stats.unknown}</b><span>Unknown</span></div>
    </div>
    <div class="rve-rule">Формы сводятся к словарной: <b>食べました → 食べる</b>, <b>寒かった → 寒い</b>. Написание не важно: <b>意見</b> и <b>いけん</b> — одно слово. Ручное «Знаю / Не знаю» всегда важнее оценки.</div>
    <button class="rve-primary" type="button">${profile ? 'Пройти тест заново' : 'Оценить мой уровень'}</button>
  </div>`, { title: '日本語 vocabulary' });
  bindModalChrome(modal);
  modal.querySelector('.rve-primary')?.addEventListener('click', openVocabularyEstimate);
}

async function openVocabularyEstimate() {
  if (currentLang() !== 'ja') return;
  const modal = ensureModal();
  modal.innerHTML = modalShell('<div class="rve-copy">Загружаю словарь…</div>', { title: 'Измерить уровень' });
  bindModalChrome(modal);
  let data;
  try { data = await loadJapaneseData(); }
  catch (error) {
    modal.innerHTML = modalShell(`<div class="rve-copy">Не удалось загрузить данные: ${escapeHtml(error?.message || error)}</div>`, { title: 'Измерить уровень' });
    bindModalChrome(modal);
    return;
  }
  const profile = loadProfile();
  const previous = profile
    ? `<div class="rve-rule">Текущая оценка: <b>≈ ${formatNumber(profile.estimate)} слов</b>. Базовыми Known считаются ${formatNumber(profile.conservativeKnownCount)} самых частых. Ручные решения при повторном тесте не стираются.</div>`
    : '';
  modal.innerHTML = modalShell(`<div class="rve-welcome">
    <div class="rve-migachu">語</div>
    <div class="rve-copy rve-copy-center"><b>Короткий тест задаст стартовую оценку японских слов, которые ты уже знаешь.</b><br><br>На каждом экране 14 слов. Отмечай слово, только если понимаешь его без подсказки.</div>
    ${previous}
    <div class="rve-rule">Та же схема, что в китайском: 42 слова по всему частотному списку, затем ещё 42 около найденной границы. Слова показаны так, как пишутся в тексте, с чтением каной.</div>
    <button class="rve-primary" type="button">Начать</button>
  </div>`, { title: 'Измерить уровень' });
  bindModalChrome(modal);
  modal.querySelector('.rve-primary')?.addEventListener('click', () => startAssessment(data));
}

function startAssessment(data = japaneseData) {
  if (!data) return;
  assessment = {
    phase: 1,
    page: 0,
    step1: selectStep1Indices(data.entries.length, STEP1_COUNT),
    step2: [],
    known1: new Set(),
    known2: new Set(),
    preliminaryEstimate: 0,
  };
  renderAssessmentPage();
}

function currentIndices() { return assessment?.phase === 1 ? assessment.step1 : assessment?.step2 || []; }
function currentKnownSet() { return assessment?.phase === 1 ? assessment.known1 : assessment?.known2 || new Set(); }
function currentPageSlice() {
  const start = assessment.page * WORDS_PER_PAGE;
  return currentIndices().slice(start, start + WORDS_PER_PAGE);
}
function difficultyNumber() { return (assessment?.phase === 2 ? 3 : 0) + Number(assessment?.page || 0) + 1; }

function renderAssessmentPage() {
  const modal = ensureModal();
  if (!assessment || !japaneseData) return;
  const known = currentKnownSet();
  const chips = currentPageSlice().map(index => {
    const entry = japaneseData.entries[index];
    if (!entry) return '';
    // The reading is the point for Japanese: a reader who knows 意見 by sound
    // may not place the kanji, and the test is about the word, not the script.
    const reading = entry.reading && entry.reading !== entry.word
      ? `<span class="rve-chip-reading">${escapeHtml(entry.reading)}</span>` : '';
    return `<button class="rve-word-chip rve-word-chip-ja${known.has(index) ? ' is-known' : ''}" type="button" data-index="${index}">
      <span class="rve-chip-word">${escapeHtml(entry.word)}</span>${reading}</button>`;
  }).join('');
  const pageCount = Math.ceil(currentIndices().length / WORDS_PER_PAGE);
  modal.innerHTML = modalShell(`<div class="rve-assessment">
    <div class="rve-step">Сложность ${difficultyNumber()} · страница ${assessment.page + 1}/${pageCount}</div>
    <div class="rve-copy rve-copy-center">Отметь слова, которые знаешь</div>
    <div class="rve-word-grid">${chips}</div>
    <button class="rve-primary" type="button">${assessment.page < pageCount - 1 || assessment.phase === 1 ? 'Дальше' : 'Готово'}</button>
  </div>`, { title: 'Измерить уровень', back: true });
  bindModalChrome(modal);
  modal.querySelectorAll('.rve-word-chip').forEach(chip => {
    chip.addEventListener('click', () => toggleAssessmentWord(Number(chip.dataset.index)));
  });
  modal.querySelector('.rve-primary')?.addEventListener('click', continueAssessment);
}

function toggleAssessmentWord(index) {
  if (!assessment || !Number.isInteger(index)) return;
  const known = currentKnownSet();
  known.has(index) ? known.delete(index) : known.add(index);
  renderAssessmentPage();
}

function goAssessmentBack() {
  if (!assessment) { closeVocabularyEstimate(); return; }
  if (assessment.page > 0) { assessment.page -= 1; renderAssessmentPage(); return; }
  if (assessment.phase === 2) { renderIntermediary(); return; }
  openVocabularyEstimate();
}

function continueAssessment() {
  if (!assessment) return;
  const pageCount = Math.ceil(currentIndices().length / WORDS_PER_PAGE);
  if (assessment.page < pageCount - 1) { assessment.page += 1; renderAssessmentPage(); return; }
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
  modal.innerHTML = modalShell(`<div class="rve-intermediary">
    <div class="rve-migachu">✓</div>
    <div class="rve-inter-title">Отлично!</div>
    <div class="rve-copy rve-copy-center">Теперь ещё один короткий раунд — слова ближе к предполагаемому уровню.</div>
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
  if (!assessment || !japaneseData) return;
  if (!assessment.step2.length) {
    assessment.step2 = selectStep2Indices(japaneseData.entries.length, assessment.preliminaryEstimate, STEP2_COUNT);
  }
  assessment.phase = 2;
  assessment.page = 0;
  renderAssessmentPage();
}

function finishAssessment() {
  if (!assessment || !japaneseData) return;
  const estimate = Math.max(0, Math.round(estimateFromChecks(checksFor(assessment.step2, assessment.known2), [...assessment.step2])));
  const profile = saveProfile({
    estimate,
    conservativeKnownCount: conservativeCountForEstimate(estimate, japaneseData.entries.length),
    listLength: japaneseData.entries.length,
    source: 'wordfreq large_ja, filtered to JMdict headwords',
    assessedAt: new Date().toISOString(),
    step1Estimate: Math.round(assessment.preliminaryEstimate),
    step1: assessment.step1.map(index => ({ index, word: japaneseData.entries[index]?.word, known: assessment.known1.has(index) })),
    step2: assessment.step2.map(index => ({ index, word: japaneseData.entries[index]?.word, known: assessment.known2.has(index) })),
  });
  assessment = null;
  applyEstimateToRenderedWords().catch(() => {});
  // The reading row is what the estimate is for: now that words are sorted into
  // Known and Unknown, turn it on so the Unknown ones carry their translation.
  try { globalThis.readerSetJaGlossMode?.('meaning'); } catch {}
  renderAssessmentResult(profile);
}

function renderAssessmentResult(profile) {
  const modal = ensureModal();
  modal.innerHTML = modalShell(`<div class="rve-result">
    <div class="rve-result-kicker">Оценка словарного запаса</div>
    <div class="rve-number">≈ ${formatNumber(profile.estimate)}</div>
    <div class="rve-result-label">японских слов</div>
    <div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div>
    <div class="rve-rule">Reader AI не объявляет Known все ≈ ${formatNumber(profile.estimate)} слов. Автоматически Known становятся только ${formatNumber(profile.conservativeKnownCount)} самых частых. Ручные решения имеют приоритет.</div>
    <button class="rve-primary rve-done" type="button">Готово</button>
    <button class="rve-secondary" type="button">Пройти ещё раз</button>
  </div>`, { title: 'Измерить уровень' });
  bindModalChrome(modal);
  modal.querySelector('.rve-done')?.addEventListener('click', openVocabularyDashboard);
  modal.querySelector('.rve-secondary')?.addEventListener('click', () => startAssessment(japaneseData));
}

function closeVocabularyEstimate() {
  document.getElementById(MODAL_ID)?.remove();
  assessment = null;
}

// ── wiring ──────────────────────────────────────────────────────────────────

function installExtraStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${MODAL_ID} .rve-word-chip-ja {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      min-width: 92px; max-width: 190px; line-height: 1.15;
    }
    #${MODAL_ID} .rve-word-chip-ja .rve-chip-word {
      font-size: 1.22rem; font-weight: 600;
    }
    #${MODAL_ID} .rve-word-chip-ja .rve-chip-reading {
      font-family: 'IBM Plex Sans', system-ui, sans-serif;
      font-size: .72rem; opacity: .68;
    }
    #reader-reading-view .rd-ja-vocab-btn {
      font-family: 'IBM Plex Sans', system-ui, sans-serif; font-weight: 800;
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
  if (pendingWordNodes.size && currentLang() === 'ja') {
    const batch = Array.from(pendingWordNodes);
    pendingWordNodes.clear();
    applyClassificationBatch(batch);
    try { globalThis.readerSyncJaReadableInline?.(); } catch {}
  } else pendingWordNodes.clear();
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
    if (currentLang() !== 'ja') return;
    for (const record of records) for (const node of record.addedNodes || []) queueWordNode(node);
    if (pendingWordNodes.size) schedulePendingWordBatch();
  });
  renderObserver.observe(root, { childList: true, subtree: true });
  if (currentLang() === 'ja') {
    root.querySelectorAll('.reader-word').forEach(word => pendingWordNodes.add(word));
    schedulePendingWordBatch();
  }
}

function ensureVocabularyButton() {
  const top = document.querySelector('#reader-reading-view .rd-top');
  if (!top) return null;
  let button = document.getElementById(BUTTON_ID);
  if (!button) {
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'rd-icon rd-ja-vocab-btn';
    button.textContent = '語';
    button.title = '日本語 vocabulary · измерить уровень';
    button.setAttribute('aria-label', 'Японский словарный запас и оценка уровня');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openVocabularyDashboard();
    });
    const pinyin = document.getElementById('reader-pinyin-btn');
    if (pinyin?.parentNode === top) top.insertBefore(button, pinyin);
    else top.appendChild(button);
  }
  button.style.display = currentLang() === 'ja' ? '' : 'none';
  return button;
}

function installPanelHook() {
  if (document.documentElement?.dataset?.readerJaVocabPanelHook === '1') return;
  if (document.documentElement) document.documentElement.dataset.readerJaVocabPanelHook = '1';
  document.addEventListener('click', event => {
    if (currentLang() !== 'ja') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest?.('#reader-chapter-text .reader-word')) return;
    queueMicrotask(() => { decorateWordPanel(); syncPanelKnowledge(); });
    setTimeout(() => { decorateWordPanel(); syncPanelKnowledge(); }, 40);
  }, true);
}

function warmJapaneseDataWhenUseful() {
  if (currentLang() !== 'ja' && !loadProfile()) return;
  const run = () => loadJapaneseData()
    .then(() => { if (currentLang() === 'ja') return applyEstimateToRenderedWords(); })
    .catch(error => console.warn('[reader ja vocab] warmup failed', error?.message || error));
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 900 });
  else setTimeout(run, 250);
}

function boot() {
  installExtraStyles();
  ensureVocabularyButton();
  installPanelHook();
  installRenderObserver();
  if (currentLang() === 'ja') decorateWordPanel();
  warmJapaneseDataWhenUseful();
}

export function installJapaneseVocabularyEstimate() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (globalThis.__readerJapaneseVocabularyEstimateVersion === 1) return;
  globalThis.__readerJapaneseVocabularyEstimateVersion = 1;
  globalThis.readerOpenJapaneseVocabularyEstimate = openVocabularyDashboard;
  globalThis.readerStartJapaneseVocabularyEstimate = openVocabularyEstimate;
  globalThis.readerApplyJapaneseVocabularyEstimate = applyEstimateToRenderedWords;
  globalThis.readerJapaneseVocabularyKnowledgeFor = classificationFor;
  globalThis.readerJapaneseLemmaFor = lemmaForWordSync;
  globalThis.readerJapaneseVocabularyProfile = loadProfile;
  globalThis.readerLoadJapaneseVocabularyData = loadJapaneseData;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', boot);
  window.addEventListener('an2:languagechange', () => {
    ensureVocabularyButton();
    if (currentLang() === 'ja') warmJapaneseDataWhenUseful();
  });
  window.addEventListener('reader:ja-vocab-ready', () => {
    if (currentLang() === 'ja') applyEstimateToRenderedWords().catch(() => {});
  });
}

installJapaneseVocabularyEstimate();
