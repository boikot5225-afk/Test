// toc138 — Spanish reading polish: stable book justification + non-blocking manual knowledge.
// This is a late UI/performance layer. Spanish lexical/context owners remain authoritative.

import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const STYLE_ID = 'rd-es-smooth-reader-v1-style';
let lastTappedWord = null;
let idbSaveTimer = 0;
let localSaveTimer = 0;
let smoothApplyPoll = 0;
let originalApplyEstimate = null;

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('es-ES');
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'spanish' || raw === 'español' || raw === 'es' || raw.startsWith('es-') ? 'es' : raw;
}

function scopedWordStateKey() {
  try { return globalThis.an2ReaderStorageKey?.(WORD_STATE_BASE_KEY) || WORD_STATE_BASE_KEY; }
  catch { return WORD_STATE_BASE_KEY; }
}

function liveWordState() {
  try {
    const live = globalThis.an2ReaderWordStateSnapshot?.();
    if (live && typeof live === 'object' && !Array.isArray(live)) return live;
  } catch {}
  try {
    const parsed = JSON.parse(localStorage.getItem(scopedWordStateKey()) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* Russian glosses never participate in Spanish line measurement. */
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1 .reader-paragraph-text{
  line-height:1.72!important;
  text-align:justify!important;
  text-align-last:auto!important;
}
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1 .rw-es-v1-wrap,
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-wrap{
  display:inline!important;
  position:relative!important;
  vertical-align:baseline!important;
  line-height:inherit!important;
  margin:0!important;
  padding:0!important;
  overflow:visible!important;
  white-space:normal!important;
}
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1 .rw-es-v1-wrap>.reader-word,
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-wrap>.reader-word{
  display:inline!important;
  position:relative!important;
  vertical-align:baseline!important;
  margin:0!important;
  padding:0!important;
  line-height:inherit!important;
  white-space:nowrap!important;
  word-break:normal!important;
  overflow-wrap:normal!important;
}
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1 .rw-es-v1-gloss,
#reader-reading-view.rd-es-smooth-v1.rd-es-pipeline-v1.rd-es-unknown-gloss .rw-es-v1-gloss{
  position:absolute!important;
  left:50%!important;
  top:100%!important;
  bottom:auto!important;
  transform:translateX(-50%)!important;
  max-width:none!important;
  white-space:nowrap!important;
  pointer-events:none!important;
  font-family:'IBM Plex Sans',sans-serif!important;
  font-size:var(--es-v1-gloss-font,.38em)!important;
  font-weight:400!important;
  line-height:1!important;
  color:var(--text-muted)!important;
  text-decoration:none!important;
}
#reader-reading-view.rd-es-smooth-v1 .rw-es-v1-gloss:not(:empty){display:block!important}
#reader-reading-view.rd-es-smooth-v1 [data-es-fast-known="1"]>.rw-es-v1-gloss{display:none!important}
`;
  document.head.appendChild(style);
}

function syncViewClass() {
  injectStyles();
  const view = document.getElementById('reader-reading-view');
  if (!view) return;
  view.classList.toggle('rd-es-smooth-v1', currentLang() === 'es');
}

function lemmaFor(word) {
  const raw = normalize(word);
  if (!raw) return '';
  try { return normalize(globalThis.readerSpanishLemmaFor?.(raw) || raw); }
  catch { return raw; }
}

function directKey(word) { return `es:${normalize(word)}`; }

function ensureState(store, word) {
  const key = directKey(word);
  if (!store[key]) {
    store[key] = {
      word: normalize(word), lang: 'es', seen: 0, clicked: 0,
      saved: false, known: false, status: 'new', places: {}, clickContexts: {},
      updatedAt: new Date().toISOString(),
    };
  }
  return store[key];
}

function applyManualState(state, word, canonical, known, stamp) {
  state.word = normalize(word);
  state.lang = 'es';
  if (canonical && normalize(word) !== canonical) {
    state.lemma = canonical;
    state.linkedLemma = canonical;
  }
  state.manualKnowledge = known ? 'known' : 'unknown';
  state.manualKnowledgeAt = stamp;
  state.known = !!known;
  state.autoKnown = false;
  state.saved = !known;
  state.status = known ? 'known' : 'problem';
  state.updatedAt = stamp;
  delete state.variants;
  delete state.autoRubyVisible;
}

function schedulePersistence(store) {
  const key = scopedWordStateKey();
  clearTimeout(idbSaveTimer);
  idbSaveTimer = setTimeout(() => {
    idbSaveTimer = 0;
    wordStateIdbPut(key, store).catch(error =>
      console.warn('[es smooth] IndexedDB save failed', error?.message || error));
  }, 0);

  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = 0;
    const commit = () => {
      try { localStorage.setItem(key, JSON.stringify(store)); }
      catch (error) { console.warn('[es smooth] localStorage save failed', error?.message || error); }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(commit, { timeout: 1200 });
    else setTimeout(commit, 0);
  }, 180);
}

function relevantVisibleWords(anchor, canonical) {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const page = anchor?.closest?.('.rd-page-current,.rd-page-show');
  const paragraph = anchor?.closest?.('.reader-paragraph');
  const scope = page || paragraph || root.querySelector('.reader-paragraph.active') || root;
  const out = [];
  for (const el of scope.querySelectorAll('.reader-word[data-word]')) {
    const surface = normalize(el.dataset.word || el.textContent || '');
    if (!surface) continue;
    if (surface === canonical || lemmaFor(surface) === canonical) out.push(el);
  }
  if (anchor?.classList?.contains('reader-word') && !out.includes(anchor)) out.push(anchor);
  return out;
}

function setWordVisual(el, known) {
  if (!el) return;
  el.classList.remove('rw-migaku-known', 'rw-migaku-unknown');
  el.classList.add(known ? 'rw-migaku-known' : 'rw-migaku-unknown');
  el.dataset.readerManualKnowledge = known ? 'known' : 'unknown';
  delete el.dataset.readerEstimatedKnowledge;
  const wrap = el.parentElement?.classList?.contains('rw-es-v1-wrap') ? el.parentElement : null;
  if (!wrap) return;
  if (known) {
    wrap.dataset.esFastKnown = '1';
    const gloss = wrap.querySelector(':scope > .rw-es-v1-gloss');
    if (gloss) gloss.textContent = '';
  } else {
    delete wrap.dataset.esFastKnown;
  }
}

function compactRussian(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/u.test(text)) return '';
  try { return globalThis.readerSpanishSanitizeRussian?.(text, 44) || text; }
  catch { return text.slice(0, 44).trim(); }
}

async function ensureUnknownGloss(el) {
  if (!el || !el.isConnected || !el.classList.contains('rw-migaku-unknown')) return;
  let wrap = el.parentElement?.classList?.contains('rw-es-v1-wrap') ? el.parentElement : null;
  if (wrap?.querySelector(':scope > .rw-es-v1-gloss:not(:empty)')) return;
  const surface = String(el.dataset.word || el.textContent || '').trim();
  if (!surface) return;
  let analysis = null;
  try {
    const paragraph = el.closest('.reader-paragraph');
    const context = String(paragraph?.textContent || '').replace(/\s+/g, ' ').trim();
    if (typeof globalThis.readerSpanishContextualAnalysisFor === 'function') {
      analysis = await globalThis.readerSpanishContextualAnalysisFor(surface, context);
    } else if (typeof globalThis.readerSpanishLexicalAnalysisFor === 'function') {
      analysis = await globalThis.readerSpanishLexicalAnalysisFor(surface);
    }
  } catch {}
  if (!el.isConnected || !el.classList.contains('rw-migaku-unknown')) return;
  const ru = compactRussian(analysis?.ru || analysis?.meaning || '');
  if (!ru) return;
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-es-v1-wrap';
    wrap.dataset.esPipeline = 'v1';
    el.parentNode?.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  delete wrap.dataset.esFastKnown;
  let gloss = wrap.querySelector(':scope > .rw-es-v1-gloss');
  if (!gloss) {
    gloss = document.createElement('span');
    gloss.className = 'rw-es-v1-gloss';
    gloss.setAttribute('aria-hidden', 'true');
    wrap.appendChild(gloss);
  }
  gloss.textContent = ru;
}

function syncPanelFromLiveState(word, known, canonical) {
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const yes = panel.querySelector('#reader-es-known-btn');
  const no = panel.querySelector('#reader-es-unknown-btn');
  const source = panel.querySelector('#reader-es-knowledge-source');
  yes?.classList.toggle('is-active', !!known);
  no?.classList.toggle('is-active', !known);
  if (!source) return;
  let info = null;
  try { info = globalThis.readerSpanishVocabularyKnowledgeFor?.(word) || null; } catch {}
  const lemma = normalize(info?.lemma || canonical || '');
  const lemmaText = lemma && normalize(word) !== lemma ? ` · лемма ${lemma}` : '';
  const rank = Number(info?.rank);
  const rankText = Number.isFinite(rank) && rank > 0 ? ` · частотность #${Math.round(rank).toLocaleString('ru-RU')}` : '';
  source.textContent = `${known ? 'Знаю' : 'Не знаю'} · вручную${lemmaText}${rankText}`;
}

function scheduleQuietReconcile() {
  const run = () => {
    try { globalThis.readerSpanishRefresh?.('manual-idle', false); } catch {}
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 160);
}

async function handleManualKnowledge(button, event) {
  if (currentLang() !== 'es') return false;
  const known = button.id === 'reader-es-known-btn';
  const panelWord = String(document.getElementById('reader-word-title')?.textContent || '').trim();
  if (!panelWord || panelWord === '—') return false;

  // Own this click before the generated vocabulary module starts its old
  // synchronous whole-chapter repaint and localStorage serialization.
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const canonical = lemmaFor(panelWord) || normalize(panelWord);
  const surface = normalize(panelWord);
  const store = liveWordState();
  const stamp = new Date().toISOString();
  const canonicalState = ensureState(store, canonical);
  applyManualState(canonicalState, canonical, canonical, known, stamp);
  if (surface && surface !== canonical) {
    const alias = ensureState(store, surface);
    applyManualState(alias, surface, canonical, known, stamp);
  }

  syncPanelFromLiveState(panelWord, known, canonical);
  const affected = relevantVisibleWords(lastTappedWord, canonical);
  for (const el of affected) setWordVisual(el, known);
  if (!known) for (const el of affected) void ensureUnknownGloss(el);

  schedulePersistence(store);
  scheduleQuietReconcile();
  try {
    window.dispatchEvent(new CustomEvent('reader:es-manual-knowledge-fast', {
      detail: { surface, lemma: canonical, value: known ? 'known' : 'unknown' },
    }));
  } catch {}
  return true;
}

function visibleSpanishScopes() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  if (pages.length) {
    const current = pages.find(page => page.classList.contains('rd-page-current')) ||
      pages.find(page => page.classList.contains('rd-page-show')) || pages[0];
    return current ? [current] : [];
  }
  const active = root.querySelector('.reader-paragraph.active');
  return [active || root];
}

async function smoothApplyEstimate() {
  if (currentLang() !== 'es') return false;
  const classify = globalThis.readerSpanishVocabularyKnowledgeFor;
  if (typeof classify !== 'function') return originalApplyEstimate?.() || false;
  const nodes = [];
  for (const scope of visibleSpanishScopes()) {
    for (const el of scope.querySelectorAll('.reader-word[data-word]')) nodes.push(el);
  }
  const CHUNK = 72;
  for (let i = 0; i < nodes.length; i += CHUNK) {
    for (const el of nodes.slice(i, i + CHUNK)) {
      let info = null;
      try { info = classify(el.dataset.word || el.textContent || ''); } catch {}
      if (!info?.value) continue;
      setWordVisual(el, info.value === 'known');
    }
    if (i + CHUNK < nodes.length) await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return true;
}

function installSmoothVocabularyApply() {
  if (typeof globalThis.readerApplySpanishVocabularyEstimate !== 'function') return false;
  if (globalThis.readerApplySpanishVocabularyEstimate.__toc138SmoothEs) return true;
  originalApplyEstimate = globalThis.readerApplySpanishVocabularyEstimate;
  smoothApplyEstimate.__toc138SmoothEs = true;
  globalThis.readerApplySpanishVocabularyEstimate = smoothApplyEstimate;
  return true;
}

function pollVocabularyOwner() {
  if (installSmoothVocabularyApply()) return;
  clearTimeout(smoothApplyPoll);
  smoothApplyPoll = setTimeout(pollVocabularyOwner, 40);
}

function installCaptureHooks() {
  document.addEventListener('pointerdown', event => {
    if (currentLang() !== 'es') return;
    const target = event.target instanceof Element ? event.target.closest('#reader-chapter-text .reader-word') : null;
    if (target) lastTappedWord = target;
  }, true);

  document.addEventListener('click', event => {
    syncViewClass();
    if (currentLang() !== 'es') return;
    const target = event.target instanceof Element ? event.target : null;
    const word = target?.closest?.('#reader-chapter-text .reader-word');
    if (word) lastTappedWord = word;
    const button = target?.closest?.('#reader-es-known-btn,#reader-es-unknown-btn');
    if (button) void handleManualKnowledge(button, event);
  }, true);

  window.addEventListener('pageshow', () => { syncViewClass(); pollVocabularyOwner(); });
  window.addEventListener('an2:languagechange', () => { syncViewClass(); pollVocabularyOwner(); });
  window.addEventListener('reader:pagechange', syncViewClass);
}

function boot() {
  injectStyles();
  syncViewClass();
  installCaptureHooks();
  pollVocabularyOwner();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
