import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

// toc55 — English manual knowledge is authoritative at the LEMMA level.
//
// Reader core stores colours by surface form (went -> en:went), while the
// Migaku-style English layer classifies by lemma (went -> go). That allowed an
// old surface state such as en:went/status=problem to repaint a word red after
// the user had explicitly marked the lemma go as Known.
//
// This bridge makes one user decision converge across every stored/rendered
// inflection of the same lemma. It is deliberately EN-only; the frozen Chinese
// vocabulary/ruby pipeline is never touched.
const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const WRAP_MARK = '__readerEnManualKnowledgeAuthorityV2';
const CORE_CONFLICT_CLASSES = [
  'rw-new', 'rw-seen', 'rw-faded', 'rw-saved', 'rw-looked',
  'rw-learning', 'rw-familiar', 'rw-problem',
];

let reconcileTimer = null;
let domRepairScheduled = false;
let rootObserver = null;
let rootObserverTarget = null;
let wrapAttempts = 0;
let manualDecisionCache = new Map();

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).toLowerCase();
  return raw.startsWith('en') ? 'en' : raw;
}

function normalizeSurface(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .trim()
    .toLocaleLowerCase('en-US');
}

function scopedWordStateKey() {
  try { return globalThis.an2ReaderStorageKey?.(WORD_STATE_BASE_KEY) || WORD_STATE_BASE_KEY; }
  catch { return WORD_STATE_BASE_KEY; }
}

function readWordStateStore() {
  try {
    const live = globalThis.an2ReaderWordStateSnapshot?.();
    if (live && typeof live === 'object') return live;
  } catch {}
  try { return JSON.parse(localStorage.getItem(scopedWordStateKey()) || '{}') || {}; }
  catch { return {}; }
}

function isEnglishState(key, state) {
  const lang = String(state?.lang || '').toLowerCase();
  return lang.startsWith('en') || String(key || '').toLowerCase().startsWith('en:');
}

function surfaceFromKey(key) {
  const raw = String(key || '');
  return raw.toLowerCase().startsWith('en:') ? normalizeSurface(raw.slice(3)) : '';
}

function lemmaFor(value) {
  const surface = normalizeSurface(value);
  if (!surface) return '';
  try {
    const lemma = normalizeSurface(globalThis.readerEnglishLemmaFor?.(surface));
    if (lemma) return lemma;
  } catch {}
  return surface;
}

function explicitOrLegacyDecision(state) {
  const explicit = String(state?.manualKnowledge || '').toLowerCase();
  if (explicit === 'known' || explicit === 'unknown') {
    return { value: explicit, explicit: true };
  }

  const status = String(state?.status || '').trim().toLowerCase();
  // Generic Reader "Known" is an explicit action. Passive/common auto Known is
  // tagged autoKnown='common', so it cannot be mistaken for a manual override.
  if (state?.known === true && status === 'known' && state?.autoKnown === false) {
    return { value: 'known', explicit: false };
  }
  // Legacy generic "problem" is also an explicit user rejection.
  if (state?.known === false && state?.saved === true && (status === 'problem' || status === 'hard')) {
    return { value: 'unknown', explicit: false };
  }
  return null;
}

function entryLemma(key, state) {
  // The key is the reliable surface identity. toc48 could canonicalize
  // state.word without moving its object from en:went to en:go, so prefer the
  // key and use state.word only as a fallback.
  return lemmaFor(surfaceFromKey(key) || state?.word || '');
}

function persistStore(store) {
  const key = scopedWordStateKey();
  try { localStorage.setItem(key, JSON.stringify(store || {})); } catch {}
  try {
    wordStateIdbPut(key, store || {}).catch(error => {
      console.warn('[reader en knowledge] IndexedDB save failed', error?.message || error);
    });
  } catch {}
}

function buildManualDecisionMap(store) {
  const decisions = new Map();
  for (const [key, state] of Object.entries(store || {})) {
    if (!state || !isEnglishState(key, state)) continue;
    const decision = explicitOrLegacyDecision(state);
    if (!decision) continue;
    const lemma = entryLemma(key, state);
    if (!lemma) continue;
    const stamp = Date.parse(state.updatedAt || '') || 0;
    const prev = decisions.get(lemma);
    // Newest user action wins. At an equal timestamp an explicit Migaku field
    // beats a legacy inferred shape.
    if (!prev || stamp > prev.stamp || (stamp === prev.stamp && decision.explicit && !prev.explicit)) {
      decisions.set(lemma, { value: decision.value, stamp, explicit: decision.explicit });
    }
  }
  return decisions;
}

function syncStateToDecision(state, decision, { touch = false } = {}) {
  if (!state || (decision !== 'known' && decision !== 'unknown')) return false;
  let changed = false;
  if (state.manualKnowledge !== decision) { state.manualKnowledge = decision; changed = true; }
  if (decision === 'known') {
    if (state.known !== true) { state.known = true; changed = true; }
    if (state.status !== 'known') { state.status = 'known'; changed = true; }
    if (state.autoKnown !== false) { state.autoKnown = false; changed = true; }
  } else {
    if (state.known !== false) { state.known = false; changed = true; }
    if (state.autoKnown !== false) { state.autoKnown = false; changed = true; }
    // Do not erase saved/problem learning semantics for Unknown. Migaku owns the
    // red underline; the DOM repair below prevents legacy status colours from
    // fighting it visually.
    if (String(state.status || '').toLowerCase() === 'known') {
      state.status = state.saved ? 'learning' : 'new';
      changed = true;
    }
  }
  if (touch && changed) state.updatedAt = new Date().toISOString();
  return changed;
}

function reconcileManualKnowledge({ refresh = true } = {}) {
  const store = readWordStateStore();
  if (!store || typeof store !== 'object') return 0;

  const decisions = buildManualDecisionMap(store);
  manualDecisionCache = decisions;
  let changed = 0;

  // Mirror the winning lemma decision to EVERY stored surface form. This is the
  // missing piece in toc54: core visual() reads en:went while Migaku reads go.
  for (const [key, state] of Object.entries(store)) {
    if (!state || !isEnglishState(key, state)) continue;
    const lemma = entryLemma(key, state);
    const decision = decisions.get(lemma)?.value;
    if (!decision) continue;
    if (syncStateToDecision(state, decision)) changed += 1;
  }

  if (changed) persistStore(store);
  if (refresh && currentLang() === 'en') {
    try { Promise.resolve(globalThis.readerApplyEnglishVocabularyEstimate?.()).catch(() => {}); } catch {}
  }
  scheduleDomRepair();
  return changed;
}

function ensureState(store, surface) {
  const clean = normalizeSurface(surface);
  if (!clean) return null;
  const key = `en:${clean}`;
  if (!store[key]) {
    store[key] = {
      word: clean, lang: 'en', seen: 0, clicked: 0, saved: false,
      known: false, status: 'new', places: {}, clickContexts: {},
      updatedAt: new Date().toISOString(),
    };
  }
  return store[key];
}

async function forceLemmaDecision(word, decision) {
  if (decision !== 'known' && decision !== 'unknown') return false;
  try { await globalThis.readerLoadEnglishVocabularyData?.(); } catch {}

  const surface = normalizeSurface(word);
  const lemma = lemmaFor(surface);
  if (!lemma) return false;
  const store = readWordStateStore();
  const now = new Date().toISOString();
  let touched = 0;

  // Ensure both canonical lemma and the actually tapped form exist so core and
  // Migaku have no opportunity to consult different records.
  ensureState(store, lemma);
  ensureState(store, surface);

  for (const [key, state] of Object.entries(store)) {
    if (!state || !isEnglishState(key, state)) continue;
    if (entryLemma(key, state) !== lemma) continue;
    syncStateToDecision(state, decision);
    state.updatedAt = now;
    touched += 1;
  }

  persistStore(store);
  manualDecisionCache.set(lemma, { value: decision, stamp: Date.parse(now), explicit: true });
  try { await globalThis.readerApplyEnglishVocabularyEstimate?.(); } catch {}
  repairRenderedManualKnowledge();
  return touched > 0;
}

function repairRenderedManualKnowledge() {
  if (currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root || !manualDecisionCache.size) return;

  for (const el of root.querySelectorAll('.reader-word[data-word]')) {
    const lang = String(el.dataset.lang || 'en').toLowerCase();
    if (!lang.startsWith('en')) continue;
    const lemma = lemmaFor(el.dataset.word || el.textContent || '');
    const decision = manualDecisionCache.get(lemma)?.value;
    if (!decision) continue;

    // English manual Known/Unknown is the final visual authority. Remove stale
    // surface-form Reader colours (especially rw-problem) before applying the
    // lemma decision. Keep rw-sel because it is transient text selection, not a
    // knowledge status. This is idempotent: an already-correct rw-known is not
    // removed/re-added, otherwise our class MutationObserver would wake itself.
    for (const cls of CORE_CONFLICT_CLASSES) {
      if (el.classList.contains(cls)) el.classList.remove(cls);
    }
    if (decision === 'known') {
      if (el.classList.contains('rw-migaku-unknown')) el.classList.remove('rw-migaku-unknown');
      if (!el.classList.contains('rw-known')) el.classList.add('rw-known');
      if (!el.classList.contains('rw-migaku-known')) el.classList.add('rw-migaku-known');
    } else {
      if (el.classList.contains('rw-known')) el.classList.remove('rw-known');
      if (el.classList.contains('rw-migaku-known')) el.classList.remove('rw-migaku-known');
      if (!el.classList.contains('rw-migaku-unknown')) el.classList.add('rw-migaku-unknown');
    }
    if (el.dataset.readerManualKnowledge !== decision) el.dataset.readerManualKnowledge = decision;
    delete el.dataset.readerEstimatedKnowledge;
  }
}

function scheduleDomRepair() {
  if (domRepairScheduled) return;
  domRepairScheduled = true;
  const run = () => {
    domRepairScheduled = false;
    repairRenderedManualKnowledge();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function scheduleReconcile(delay = 0) {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileManualKnowledge();
  }, Math.max(0, delay));
}

function panelWord() {
  return String(document.getElementById('reader-word-title')?.textContent || '').trim();
}

function installClickAuthority() {
  if (document.documentElement?.dataset?.readerEnKnowledgeAuthority === '2') return;
  if (document.documentElement) document.documentElement.dataset.readerEnKnowledgeAuthority = '2';
  document.addEventListener('click', event => {
    if (currentLang() !== 'en') return;
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    let decision = '';
    if (target.id === 'reader-en-migaku-known-btn') decision = 'known';
    else if (target.id === 'reader-en-migaku-unknown-btn') decision = 'unknown';
    else {
      const onclick = String(target.getAttribute('onclick') || '');
      if (onclick.includes('readerMarkSelectedWordKnown')) decision = 'known';
      else if (onclick.includes('readerMarkSelectedWordProblem')) decision = 'unknown';
    }
    if (!decision) return;
    const word = panelWord();
    if (!word || word === '—') return;
    // Run after the panel's own handler, then once more after any immediate
    // rerender. forceLemmaDecision itself waits for the lemma table.
    setTimeout(() => forceLemmaDecision(word, decision), 0);
    setTimeout(() => forceLemmaDecision(word, decision), 120);
  }, true);
}

function wrapExplicitAction(name) {
  const original = globalThis[name];
  if (typeof original !== 'function') return false;
  if (original[WRAP_MARK]) return true;
  const wrapped = function readerEnKnowledgeWrappedAction(...args) {
    const result = original.apply(this, args);
    scheduleReconcile(0);
    scheduleReconcile(100);
    return result;
  };
  try { Object.defineProperty(wrapped, WRAP_MARK, { value: true }); }
  catch { wrapped[WRAP_MARK] = true; }
  globalThis[name] = wrapped;
  return true;
}

function installActionWrappers() {
  const knownReady = wrapExplicitAction('readerMarkSelectedWordKnown');
  const problemReady = wrapExplicitAction('readerMarkSelectedWordProblem');
  if (knownReady && problemReady) return;
  if (wrapAttempts >= 24) return;
  wrapAttempts += 1;
  setTimeout(installActionWrappers, Math.min(500, 40 + wrapAttempts * 20));
}

function installRootObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) { setTimeout(installRootObserver, 250); return; }
  if (rootObserver && rootObserverTarget === root) return;
  rootObserver?.disconnect();
  rootObserverTarget = root;
  rootObserver = new MutationObserver(records => {
    if (currentLang() !== 'en') return;
    let childChanged = false;
    let classChanged = false;
    for (const record of records) {
      if (record.type === 'childList' && (record.addedNodes?.length || record.removedNodes?.length)) childChanged = true;
      if (record.type === 'attributes' && record.attributeName === 'class') classChanged = true;
    }
    // Any core repaint can re-add rw-problem/rw-learning to a surface form.
    // Class-only repairs use the cached lemma decisions and stay cheap.
    if (classChanged || childChanged) scheduleDomRepair();
    // A real rerender may arrive after cloud/IDB hydration; refresh the decision
    // map once, throttled, instead of rescanning the store for every class flip.
    if (childChanged) scheduleReconcile(60);
  });
  rootObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function boot() {
  installClickAuthority();
  installActionWrappers();
  installRootObserver();
  reconcileManualKnowledge();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', () => {
    installActionWrappers();
    installRootObserver();
    scheduleReconcile(0);
  });
  window.addEventListener('reader:en-vocab-ready', () => scheduleReconcile(0));
}

export { explicitOrLegacyDecision, reconcileManualKnowledge, forceLemmaDecision, repairRenderedManualKnowledge };
