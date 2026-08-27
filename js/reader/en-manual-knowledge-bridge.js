import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

// English manual-knowledge compatibility bridge.
//
// Reader core predates the Migaku-style EN classifier and historically stores
// an explicit "I know this word" action as:
//   known=true, status='known', autoKnown=false
// while the EN classifier gives absolute priority only to:
//   manualKnowledge='known' | 'unknown'
//
// Without this bridge, an old/generic Known action can look correct for one
// render and then be overwritten by the assessment classifier on the next DOM
// pass. Reconcile those two state dialects without touching ZH/JA/FR behavior.
const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const WRAP_MARK = '__readerEnManualKnowledgeBridgeV1';

let reconcileTimer = null;
let rootObserver = null;
let rootObserverTarget = null;
let wrapAttempts = 0;

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).toLowerCase();
  return raw.startsWith('en') ? 'en' : raw;
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
  try {
    return JSON.parse(localStorage.getItem(scopedWordStateKey()) || '{}') || {};
  } catch {
    return {};
  }
}

function isEnglishState(key, state) {
  const lang = String(state?.lang || '').toLowerCase();
  return lang.startsWith('en') || String(key || '').toLowerCase().startsWith('en:');
}

function inferredManualKnowledge(state) {
  const explicit = String(state?.manualKnowledge || '').toLowerCase();
  if (explicit === 'known' || explicit === 'unknown') return '';

  const status = String(state?.status || '').trim().toLowerCase();

  // This exact shape is produced by readerWordState.markKnown(). Assessment
  // Known words are not written this way, and passive common-word auto Known is
  // tagged autoKnown='common', so this remains an explicit-user-action signal.
  if (state?.known === true && status === 'known' && state?.autoKnown === false) {
    return 'known';
  }

  // Legacy/generic "problem" button is an explicit user rejection in the word
  // panel. Preserve it as manual Unknown so the assessment cannot paint it Known
  // on the next render.
  if (state?.known === false && state?.saved === true && status === 'problem') {
    return 'unknown';
  }

  return '';
}

function persistStore(store) {
  const key = scopedWordStateKey();
  try { localStorage.setItem(key, JSON.stringify(store || {})); } catch {}
  try {
    wordStateIdbPut(key, store || {}).catch(error => {
      console.warn('[reader en manual knowledge] IndexedDB save failed', error?.message || error);
    });
  } catch {}
}

function refreshEnglishClassification() {
  if (currentLang() !== 'en') return;
  try {
    Promise.resolve(globalThis.readerApplyEnglishVocabularyEstimate?.()).catch(error => {
      console.warn('[reader en manual knowledge] reclassify failed', error?.message || error);
    });
  } catch {}
}

function reconcileManualKnowledge({ refresh = true } = {}) {
  const store = readWordStateStore();
  if (!store || typeof store !== 'object') return 0;

  let changed = 0;
  for (const [key, state] of Object.entries(store)) {
    if (!state || !isEnglishState(key, state)) continue;
    const inferred = inferredManualKnowledge(state);
    if (!inferred) continue;
    state.manualKnowledge = inferred;
    changed += 1;
  }

  if (!changed) return 0;
  persistStore(store);
  if (refresh) refreshEnglishClassification();
  return changed;
}

function scheduleReconcile(delay = 0) {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileManualKnowledge();
  }, Math.max(0, delay));
}

function wrapExplicitAction(name) {
  const original = globalThis[name];
  if (typeof original !== 'function') return false;
  if (original[WRAP_MARK]) return true;

  const wrapped = function readerEnManualKnowledgeWrappedAction(...args) {
    const result = original.apply(this, args);
    // The core action mutates the live word-state synchronously, while its
    // persistence/render may be deferred. Reconcile before the next paint and
    // once more after the immediate chapter rerender has settled.
    try { queueMicrotask(() => reconcileManualKnowledge()); }
    catch { scheduleReconcile(0); }
    scheduleReconcile(80);
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
  if (wrapAttempts >= 20) return;
  wrapAttempts += 1;
  setTimeout(installActionWrappers, Math.min(500, 40 + wrapAttempts * 20));
}

function installRootObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(installRootObserver, 250);
    return;
  }
  if (rootObserver && rootObserverTarget === root) return;
  rootObserver?.disconnect();
  rootObserverTarget = root;
  rootObserver = new MutationObserver(records => {
    if (currentLang() !== 'en') return;
    if (!records.some(record => record.type === 'childList' && (record.addedNodes?.length || record.removedNodes?.length))) return;
    scheduleReconcile(0);
  });
  rootObserver.observe(root, { childList: true, subtree: true });
}

function boot() {
  installActionWrappers();
  installRootObserver();
  // Migrate already-existing explicit states from builds before this bridge.
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

export { inferredManualKnowledge, reconcileManualKnowledge };
