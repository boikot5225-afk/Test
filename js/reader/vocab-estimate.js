// Migaku-style Known / Unknown vocabulary layer for Reader AI.
//
// The placement estimate is frequency-based rather than HSK-level-based:
// a test estimates a cutoff N in a bundled frequency-ranked Mandarin list,
// then words ranked <= N start as "known" and words above N as "unknown".
// Explicit taps always override the estimate. Manual taps also nudge the
// estimate gradually instead of violently recalculating it from one word.

const PROFILE_BASE_KEY = 'an2_reader_vocab_estimate_v2';
const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const OWNER_KEY = 'an2_reader_active_owner_v1';
const DATA_URL = 'data/zh_vocab_frequency.json';
const STYLE_ID = 'reader-migaku-vocab-style-v1';
const MODAL_ID = 'reader-vocab-estimate-modal';
const MAX_TEST_RANK = 12000;
const TEST_TARGETS = Object.freeze([
  90, 140, 210, 300, 420, 560, 720, 900,
  1120, 1380, 1680, 2020, 2400, 2850, 3350, 3950,
  4650, 5450, 6350, 7350, 8450, 9650, 10800, 12000,
]);

let frequencyPromise = null;
let frequencyData = null;
let testSession = null;
let renderScheduled = false;
let observer = null;

const fallbackEntries = Object.freeze([
  ['的', 1], ['是', 12], ['在', 18], ['有', 28], ['我', 34], ['你', 63], ['他', 72],
  ['这', 95], ['不', 101], ['人', 128], ['了', 142], ['说', 188], ['会', 205], ['要', 231],
  ['看', 258], ['去', 286], ['来', 319], ['知道', 386], ['觉得', 470], ['喜欢', 535],
  ['问题', 650], ['开始', 760], ['需要', 890], ['关系', 1040], ['机会', 1210], ['影响', 1420],
  ['选择', 1650], ['社会', 1920], ['经验', 2250], ['发展', 2620], ['责任', 3050], ['条件', 3540],
  ['观点', 4140], ['承担', 4850], ['资源', 5650], ['实施', 6550], ['趋势', 7600], ['维护', 8750],
  ['严峻', 10100], ['倡导', 11600],
]);

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
  return canonicalLang(document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || 'zh');
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

function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(PROFILE_BASE_KEY)) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const estimate = Math.max(0, Math.round(Number(raw.estimate || 0)));
    return { ...raw, language: 'zh', estimate };
  } catch {
    return null;
  }
}

function saveProfile(profile) {
  const next = {
    language: 'zh',
    version: 2,
    ...profile,
    estimate: Math.max(0, Math.round(Number(profile?.estimate || 0))),
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
  try { localStorage.setItem(scopedKey(WORD_STATE_BASE_KEY), JSON.stringify(store || {})); } catch {}
}

function normalizeWord(word, lang = currentLang()) {
  const value = String(word || '').trim();
  if (canonicalLang(lang) === 'zh' || canonicalLang(lang) === 'ja') return value;
  return value.toLocaleLowerCase();
}

function findWordState(word, lang = currentLang(), create = false) {
  const language = canonicalLang(lang);
  const normalized = normalizeWord(word, language);
  if (!normalized) return { store: wordStateStore(), key: '', state: null };
  const store = wordStateStore();
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
  if (state?.known && state?.autoKnown === false) return 'known';
  if (state?.saved || ['problem', 'hard', 'learning', 'familiar'].includes(String(state?.status || '').toLowerCase())) return 'unknown';
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

function formatNumber(value) {
  try { return Math.round(Number(value || 0)).toLocaleString('ru-RU'); }
  catch { return String(Math.round(Number(value || 0))); }
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
      color: inherit !important;
      border-radius: .22em;
      box-shadow: inset 0 -.48em 0 color-mix(in srgb, var(--warn, #d0a248) 34%, transparent) !important;
      opacity: 1 !important;
    }
    #reader-reading-view .reader-word.rw-migaku-unknown[data-reader-manual-knowledge="unknown"] {
      box-shadow: inset 0 -.58em 0 color-mix(in srgb, var(--warn, #d0a248) 52%, transparent) !important;
    }
    .rwp-migaku-knowledge {
      margin: 11px 0 10px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 13px;
      background: color-mix(in srgb, var(--surface2) 86%, transparent);
    }
    .rwp-migaku-row { display:grid;grid-template-columns:1fr 1fr;gap:9px; }
    .rwp-migaku-btn {
      min-height: 48px;
      border-radius: 11px;
      border: 1px solid var(--border);
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: .94rem;
      font-weight: 650;
      cursor: pointer;
      transition: transform .08s ease, border-color .15s ease, background .15s ease;
    }
    .rwp-migaku-btn:active { transform:scale(.98); }
    .rwp-migaku-known {
      background: color-mix(in srgb, var(--good, #4b8f6a) 13%, var(--surface));
      color: var(--text);
    }
    .rwp-migaku-unknown {
      background: color-mix(in srgb, var(--warn, #d0a248) 17%, var(--surface));
      color: var(--text);
    }
    .rwp-migaku-known.is-active { border-color:var(--good, #4b8f6a);box-shadow:0 0 0 1px var(--good, #4b8f6a); }
    .rwp-migaku-unknown.is-active { border-color:var(--warn, #d0a248);box-shadow:0 0 0 1px var(--warn, #d0a248); }
    .rwp-migaku-source { min-height:1.2em;margin:7px 2px 0;font-size:.69rem;color:var(--text-muted);line-height:1.35; }
    .rwp-vocab-estimate-btn {
      width:100%;margin-top:8px;padding:8px 10px;border:0;background:none;color:var(--accent);
      font-family:'IBM Plex Sans',sans-serif;font-size:.76rem;cursor:pointer;text-align:left;
    }
    #${MODAL_ID} {
      position: fixed; inset: 0; z-index: 10040;
      display:flex;align-items:flex-end;justify-content:center;
      background: rgba(10, 10, 10, .48);
      padding: 0;
    }
    #${MODAL_ID} .rve-card {
      width:min(100%, 520px);max-height:min(88dvh,760px);overflow:auto;
      border:1px solid var(--border);border-radius:20px 20px 0 0;
      background:var(--surface);color:var(--text);
      padding:16px 16px calc(18px + env(safe-area-inset-bottom));
      box-shadow:0 -18px 48px rgba(0,0,0,.28);
    }
    #${MODAL_ID} .rve-head { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px; }
    #${MODAL_ID} .rve-title { font-family:'Lora','Noto Serif SC',serif;font-size:1.25rem;font-weight:650; }
    #${MODAL_ID} .rve-close { border:0;background:none;color:var(--text-muted);font-size:1.55rem;cursor:pointer; }
    #${MODAL_ID} .rve-copy { color:var(--text-muted);font-size:.83rem;line-height:1.5; }
    #${MODAL_ID} .rve-start, #${MODAL_ID} .rve-again {
      width:100%;margin-top:16px;min-height:46px;border:0;border-radius:11px;
      background:var(--accent);color:#fff;font-family:'IBM Plex Sans',sans-serif;font-weight:650;font-size:.92rem;cursor:pointer;
    }
    #${MODAL_ID} .rve-progress { height:5px;background:var(--surface2);border-radius:999px;overflow:hidden;margin:4px 0 18px; }
    #${MODAL_ID} .rve-progress > div { height:100%;background:var(--accent);transition:width .18s ease; }
    #${MODAL_ID} .rve-count { font-size:.71rem;color:var(--text-muted);text-align:right;margin-bottom:4px; }
    #${MODAL_ID} .rve-word {
      display:flex;min-height:150px;align-items:center;justify-content:center;text-align:center;
      font-family:'Noto Serif SC','Lora',serif;font-size:2.55rem;font-weight:600;line-height:1.15;
      padding:12px 4px;
    }
    #${MODAL_ID} .rve-question { text-align:center;color:var(--text-muted);font-size:.78rem;margin:-2px 0 14px; }
    #${MODAL_ID} .rve-actions { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
    #${MODAL_ID} .rve-answer {
      min-height:54px;border-radius:12px;border:1px solid var(--border);font-family:'IBM Plex Sans',sans-serif;
      font-size:1rem;font-weight:650;cursor:pointer;color:var(--text);
    }
    #${MODAL_ID} .rve-no { background:color-mix(in srgb,var(--warn,#d0a248) 18%,var(--surface)); }
    #${MODAL_ID} .rve-yes { background:color-mix(in srgb,var(--good,#4b8f6a) 15%,var(--surface)); }
    #${MODAL_ID} .rve-result { text-align:center;padding:12px 4px 4px; }
    #${MODAL_ID} .rve-number { font-family:'Lora','Noto Serif SC',serif;font-size:2.45rem;font-weight:700;color:var(--accent);margin:8px 0 2px; }
    #${MODAL_ID} .rve-label { font-size:.8rem;color:var(--text-muted); }
    #${MODAL_ID} .rve-rule { margin:17px 0 0;padding:11px;border:1px solid var(--border);border-radius:11px;background:var(--surface2);font-size:.77rem;line-height:1.45;color:var(--text-muted);text-align:left; }
    @media(min-width:760px) {
      #${MODAL_ID} { align-items:center;padding:18px; }
      #${MODAL_ID} .rve-card { border-radius:20px; }
    }
  `;
  document.head.appendChild(style);
}

function buildFrequencyData(payload) {
  const rows = Array.isArray(payload?.entries) ? payload.entries : [];
  const entries = rows
    .map(row => [String(row?.[0] || '').trim(), Number(row?.[1])])
    .filter(([word, rank]) => word && Number.isFinite(rank) && rank > 0)
    .sort((a, b) => a[1] - b[1]);
  const effective = entries.length >= 500 ? entries : [...fallbackEntries];
  return {
    version: payload?.version || 0,
    source: payload?.source || (entries.length ? 'bundled frequency data' : 'fallback'),
    maxRank: Math.max(...effective.map(row => row[1]), 1),
    entries: effective,
    rank: new Map(effective.map(([word, rank]) => [word, rank])),
  };
}

async function loadFrequencyData() {
  if (frequencyData) return frequencyData;
  if (frequencyPromise) return frequencyPromise;
  frequencyPromise = fetch(new URL(DATA_URL, document.baseURI), { cache: 'force-cache' })
    .then(res => {
      if (!res.ok) throw new Error(`frequency data HTTP ${res.status}`);
      return res.json();
    })
    .then(payload => {
      frequencyData = buildFrequencyData(payload);
      return frequencyData;
    })
    .catch(error => {
      console.warn('[reader vocab estimate] bundled frequency data unavailable; using fallback', error?.message || error);
      frequencyData = buildFrequencyData({ entries: fallbackEntries, source: 'fallback' });
      return frequencyData;
    })
    .finally(() => { frequencyPromise = null; });
  return frequencyPromise;
}

function rankForWordSync(word) {
  const w = String(word || '').trim();
  if (!w || !frequencyData) return null;
  const direct = frequencyData.rank.get(w);
  if (Number.isFinite(direct)) return direct;
  try {
    const local = globalThis.readerLookupChineseWord?.(w);
    const simplified = String(local?.simplified || local?.word || '').trim();
    if (simplified && frequencyData.rank.has(simplified)) return frequencyData.rank.get(simplified);
  } catch {}
  return null;
}

async function rankForWord(word) {
  await loadFrequencyData();
  return rankForWordSync(word);
}

function removeKnowledgeClasses(el) {
  el.classList.remove('rw-migaku-known', 'rw-migaku-unknown');
  delete el.dataset.readerEstimatedKnowledge;
  delete el.dataset.readerManualKnowledge;
}

function classificationFor(word, lang = 'zh') {
  const language = canonicalLang(lang);
  const { state } = findWordState(word, language, false);
  const manual = manualKnowledge(state);
  if (manual) return { value: manual, source: 'manual', state, rank: language === 'zh' ? rankForWordSync(word) : null };

  if (language !== 'zh') return { value: '', source: '', state, rank: null };
  const profile = loadProfile();
  if (!profile || !profile.estimate) return { value: '', source: '', state, rank: rankForWordSync(word) };
  const rank = rankForWordSync(word);
  if (!Number.isFinite(rank)) return { value: '', source: '', state, rank: null };
  return {
    value: rank <= profile.estimate ? 'known' : 'unknown',
    source: 'estimate',
    state,
    rank,
    estimate: profile.estimate,
  };
}

function applyClassificationToElement(el, classification) {
  removeKnowledgeClasses(el);
  if (classification?.value === 'known') el.classList.add('rw-migaku-known');
  else if (classification?.value === 'unknown') el.classList.add('rw-migaku-unknown');
  else return;

  if (classification.source === 'manual') el.dataset.readerManualKnowledge = classification.value;
  if (classification.source === 'estimate') el.dataset.readerEstimatedKnowledge = classification.value;

  const rankText = Number.isFinite(classification.rank) ? ` · частотность #${formatNumber(classification.rank)}` : '';
  el.title = classification.source === 'manual'
    ? `${classification.value === 'known' ? 'Знаю' : 'Не знаю'} · вручную${rankText}`
    : `${classification.value === 'known' ? 'Предположительно знаю' : 'Предположительно не знаю'} · по оценке словаря${rankText}`;
}

async function applyEstimateToRenderedWords() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const words = [...root.querySelectorAll('.reader-word[data-word]')];
  if (!words.length) return;

  const hasZh = words.some(el => canonicalLang(el.dataset.lang || root.dataset.lang) === 'zh');
  if (hasZh && !frequencyData) await loadFrequencyData();

  for (const el of words) {
    const lang = canonicalLang(el.dataset.lang || root.dataset.lang || currentLang());
    const word = el.dataset.word || el.textContent || '';
    const classification = classificationFor(word, lang);
    applyClassificationToElement(el, classification);
  }
  syncPanelKnowledge();
}

function profileButtonText() {
  const profile = loadProfile();
  return profile?.estimate
    ? `≈ ${formatNumber(profile.estimate)} слов · переоценить`
    : '≈ Оценить словарный запас';
}

function syncPanelKnowledge() {
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const yes = panel.querySelector('#reader-migaku-known-btn');
  const no = panel.querySelector('#reader-migaku-unknown-btn');
  const source = panel.querySelector('#reader-migaku-source');
  const estimateButton = panel.querySelector('#reader-vocab-estimate-btn');
  if (estimateButton) {
    estimateButton.textContent = currentLang() === 'zh' ? profileButtonText() : '≈ Оценка словаря · китайский';
  }
  if (!yes || !no || !source) return;

  yes.classList.remove('is-active');
  no.classList.remove('is-active');
  const word = currentPanelWord();
  if (!word || word === '—') { source.textContent = ''; return; }

  const info = classificationFor(word, currentLang());
  if (info.value === 'known') yes.classList.add('is-active');
  if (info.value === 'unknown') no.classList.add('is-active');
  const rankText = Number.isFinite(info.rank) ? `частотность #${formatNumber(info.rank)}` : '';
  if (info.source === 'manual') source.textContent = `${info.value === 'known' ? 'Знаю' : 'Не знаю'} · задано вручную${rankText ? ` · ${rankText}` : ''}`;
  else if (info.source === 'estimate') source.textContent = `${info.value === 'known' ? 'Предположительно знаю' : 'Предположительно не знаю'} · по оценке ≈ ${formatNumber(info.estimate)} слов${rankText ? ` · ${rankText}` : ''}`;
  else source.textContent = rankText || 'Статус ещё не задан';
}

function decorateWordPanel() {
  const panel = document.getElementById('reader-word-panel');
  if (!panel || panel.dataset.migakuKnowledge === '1') { syncPanelKnowledge(); return; }
  const actions = panel.querySelector('.reader-word-actions');
  if (!actions) return;

  panel.dataset.migakuKnowledge = '1';
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
      <button id="reader-migaku-known-btn" class="rwp-migaku-btn rwp-migaku-known" type="button">✓ Знаю</button>
    </div>
    <div id="reader-migaku-source" class="rwp-migaku-source"></div>
    <button id="reader-vocab-estimate-btn" class="rwp-vocab-estimate-btn" type="button"></button>`;
  actions.before(block);

  block.querySelector('#reader-migaku-known-btn')?.addEventListener('click', () => markCurrentWord(true));
  block.querySelector('#reader-migaku-unknown-btn')?.addEventListener('click', () => markCurrentWord(false));
  block.querySelector('#reader-vocab-estimate-btn')?.addEventListener('click', () => openVocabularyEstimate());
  syncPanelKnowledge();
}

function nudgeEstimate(profile, rank, known) {
  if (!profile?.estimate || !Number.isFinite(rank)) return profile;
  let estimate = Number(profile.estimate);
  const step = Math.max(50, Math.round(estimate * 0.045));
  if (known && rank > estimate) estimate += Math.min(rank - estimate, step);
  if (!known && rank < estimate) estimate -= Math.min(estimate - rank, step);
  estimate = Math.max(0, Math.min(frequencyData?.maxRank || MAX_TEST_RANK, Math.round(estimate / 25) * 25));
  return saveProfile({
    ...profile,
    estimate,
    manualEvidence: Number(profile.manualEvidence || 0) + 1,
  });
}

async function markCurrentWord(known) {
  const word = currentPanelWord();
  const lang = currentLang();
  if (!word || word === '—') return;
  const before = findWordState(word, lang, true);

  // Use the core "known" action as a persistence trigger. It schedules the
  // canonical word-state save (including IndexedDB) and refreshes the reader.
  // For Unknown we immediately replace the live state before that deferred
  // save runs, without putting the word into SRS/saved vocabulary.
  try { globalThis.readerMarkSelectedWordKnown?.(); } catch {}

  const found = findWordState(word, lang, true);
  const state = found.state || before.state;
  if (state) {
    state.manualKnowledge = known ? 'known' : 'unknown';
    state.known = !!known;
    state.autoKnown = false;
    if (known) {
      state.status = 'known';
    } else {
      state.saved = false;
      state.status = 'problem';
    }
    state.updatedAt = new Date().toISOString();
    persistWordState(found.store);
  }

  if (lang === 'zh') {
    const data = await loadFrequencyData();
    const rank = data.rank.get(word) ?? rankForWordSync(word);
    const profile = loadProfile();
    if (profile?.estimate && Number.isFinite(rank)) nudgeEstimate(profile, rank, known);
  }

  await applyEstimateToRenderedWords();
  showToast(known ? '✓ Знаю' : 'Не знаю · оставлено для изучения');
}

function nearestEligible(entries, target, used) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (entries[mid][1] < target) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [];
  for (let d = 0; d < 45; d++) {
    if (lo - d >= 0) candidates.push(entries[lo - d]);
    if (d && lo + d < entries.length) candidates.push(entries[lo + d]);
  }
  const isGood = ([word, rank]) => {
    if (used.has(word) || rank > MAX_TEST_RANK * 1.08) return false;
    if (!/^[\u3400-\u9fff]{1,4}$/.test(word)) return false;
    return true;
  };
  const available = candidates.filter(isGood);
  if (!available.length) return null;
  const close = available.slice(0, Math.min(8, available.length));
  return close[Math.floor(Math.random() * close.length)];
}

function buildTestItems(data) {
  const sorted = data.entries.filter(([, rank]) => rank <= MAX_TEST_RANK * 1.08);
  const used = new Set();
  const items = [];
  for (const target of TEST_TARGETS) {
    const row = nearestEligible(sorted, target, used);
    if (!row) continue;
    used.add(row[0]);
    items.push({ word: row[0], rank: row[1], target });
  }
  if (items.length < 14) {
    for (const [word, rank] of fallbackEntries) {
      if (used.has(word)) continue;
      used.add(word);
      items.push({ word, rank, target: rank });
    }
  }
  return items.sort((a, b) => a.rank - b.rank);
}

function sampleWeight(items, index) {
  const prev = index === 0 ? 0 : (items[index - 1].rank + items[index].rank) / 2;
  const next = index === items.length - 1
    ? Math.max(MAX_TEST_RANK, items[index].rank)
    : (items[index].rank + items[index + 1].rank) / 2;
  return Math.max(1, next - prev);
}

function estimateFromAnswers(items) {
  const answered = items.filter(item => typeof item.known === 'boolean').sort((a, b) => a.rank - b.rank);
  if (!answered.length) return { estimate: 0, consistency: 0 };
  if (answered.every(item => item.known)) return { estimate: MAX_TEST_RANK, consistency: 1 };
  if (answered.every(item => !item.known)) return { estimate: 0, consistency: 1 };

  const candidates = [0, ...answered.map(item => item.rank), MAX_TEST_RANK];
  let best = { estimate: 0, error: Infinity };
  const totalWeight = answered.reduce((sum, item, i) => sum + sampleWeight(answered, i), 0);
  for (const cutoff of candidates) {
    let error = 0;
    answered.forEach((item, i) => {
      const predictedKnown = item.rank <= cutoff;
      if (predictedKnown !== item.known) error += sampleWeight(answered, i);
    });
    if (error < best.error || (error === best.error && cutoff > best.estimate)) best = { estimate: cutoff, error };
  }
  const rounded = Math.max(0, Math.min(MAX_TEST_RANK, Math.round(best.estimate / 50) * 50));
  const consistency = totalWeight ? Math.max(0, 1 - best.error / totalWeight) : 0;
  return { estimate: rounded, consistency };
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

function modalShell(inner) {
  return `<div class="rve-card">
    <div class="rve-head"><div class="rve-title">Оценка словарного запаса</div><button class="rve-close" type="button" aria-label="Закрыть">×</button></div>
    ${inner}
  </div>`;
}

function bindModalClose(modal) {
  modal.querySelector('.rve-close')?.addEventListener('click', closeVocabularyEstimate);
}

async function openVocabularyEstimate() {
  installStyles();
  const modal = ensureModal();
  modal.innerHTML = modalShell('<div class="rve-copy">Загружаю частотный список…</div>');
  bindModalClose(modal);
  const data = await loadFrequencyData();
  const profile = loadProfile();
  const previous = profile?.estimate
    ? `<div class="rve-rule">Текущая оценка: <b>≈ ${formatNumber(profile.estimate)} слов</b>. Её можно пересчитать; твои ручные «Знаю / Не знаю» не сотрутся.</div>`
    : '';
  modal.innerHTML = modalShell(`
    <div class="rve-copy">Покажу ${TEST_TARGETS.length} китайских слова без перевода и пиньиня. Отмечай только то, значение чего ты действительно узнаёшь. По ответам Reader AI найдёт твой частотный порог — примерно как стартовая оценка Known Words в Migaku.</div>
    ${previous}
    <div class="rve-rule">После теста слова с частотностью выше порога будут стартовать как <b>«Знаю»</b>, остальные — как <b>«Не знаю»</b>. Любое ручное нажатие важнее оценки.</div>
    <button class="rve-start" type="button">Начать · ${Math.max(14, buildTestItems(data).length)} слов</button>`);
  bindModalClose(modal);
  modal.querySelector('.rve-start')?.addEventListener('click', () => startVocabularyTest(data));
}

function startVocabularyTest(data = frequencyData) {
  testSession = { items: buildTestItems(data), index: 0, startedAt: new Date().toISOString() };
  renderVocabularyQuestion();
}

function renderVocabularyQuestion() {
  const modal = ensureModal();
  const session = testSession;
  if (!session || session.index >= session.items.length) { finishVocabularyTest(); return; }
  const item = session.items[session.index];
  const pct = Math.round((session.index / session.items.length) * 100);
  modal.innerHTML = modalShell(`
    <div class="rve-count">${session.index + 1} / ${session.items.length}</div>
    <div class="rve-progress"><div style="width:${pct}%"></div></div>
    <div class="rve-word" lang="zh">${item.word}</div>
    <div class="rve-question">Знаешь значение этого слова без подсказки?</div>
    <div class="rve-actions">
      <button class="rve-answer rve-no" type="button">Не знаю</button>
      <button class="rve-answer rve-yes" type="button">✓ Знаю</button>
    </div>`);
  bindModalClose(modal);
  modal.querySelector('.rve-no')?.addEventListener('click', () => answerVocabulary(false));
  modal.querySelector('.rve-yes')?.addEventListener('click', () => answerVocabulary(true));
}

function answerVocabulary(known) {
  if (!testSession) return;
  const item = testSession.items[testSession.index];
  if (!item) return;
  item.known = !!known;
  testSession.index += 1;
  renderVocabularyQuestion();
}

function finishVocabularyTest() {
  const modal = ensureModal();
  const session = testSession;
  if (!session) return;
  const result = estimateFromAnswers(session.items);
  const confidence = result.consistency >= .86 ? 'высокая' : result.consistency >= .7 ? 'средняя' : 'примерная';
  const profile = saveProfile({
    estimate: result.estimate,
    assessmentAnswers: session.items.map(item => ({ word: item.word, rank: item.rank, known: !!item.known })),
    consistency: result.consistency,
    confidence,
    assessedAt: new Date().toISOString(),
    manualEvidence: 0,
    source: frequencyData?.source || 'bundled frequency data',
  });
  testSession = null;
  applyEstimateToRenderedWords();

  modal.innerHTML = modalShell(`
    <div class="rve-result">
      <div class="rve-label">примерный активный порог</div>
      <div class="rve-number">≈ ${formatNumber(profile.estimate)}</div>
      <div class="rve-label">наиболее частотных китайских слов · точность: ${confidence}</div>
      <div class="rve-rule">Reader AI теперь использует <b>${formatNumber(profile.estimate)}</b> как стартовую границу Known / Unknown. Это не экзаменационный уровень и не обещание, что ты буквально знаешь каждое слово до этой позиции. Это стартовая модель; ручные «Знаю / Не знаю» имеют приоритет и понемногу уточняют оценку во время чтения.</div>
      <button class="rve-again" type="button">Пройти ещё раз</button>
    </div>`);
  bindModalClose(modal);
  modal.querySelector('.rve-again')?.addEventListener('click', () => startVocabularyTest(frequencyData));
}

function closeVocabularyEstimate() {
  document.getElementById(MODAL_ID)?.remove();
  testSession = null;
}

function scheduleRefresh() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    decorateWordPanel();
    applyEstimateToRenderedWords().catch(() => {});
  });
}

function installObserver() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(scheduleRefresh);
  const root = document.documentElement || document.body;
  if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
}

export function installVocabularyEstimate() {
  if (globalThis.__readerVocabularyEstimateInstalled) return;
  globalThis.__readerVocabularyEstimateInstalled = true;
  installStyles();
  installObserver();
  globalThis.readerOpenVocabularyEstimate = openVocabularyEstimate;
  globalThis.readerCloseVocabularyEstimate = closeVocabularyEstimate;
  globalThis.readerApplyVocabularyEstimate = applyEstimateToRenderedWords;
  globalThis.readerMigakuMarkKnown = () => markCurrentWord(true);
  globalThis.readerMigakuMarkUnknown = () => markCurrentWord(false);
  globalThis.readerVocabularyEstimateProfile = loadProfile;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
  } else {
    scheduleRefresh();
  }
}

installVocabularyEstimate();
