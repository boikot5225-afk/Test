// toc138 — French reading polish: book-style justification + non-blocking manual knowledge.
// This is deliberately a late UI/performance layer. It does not own French lexical
// semantics; fr-reader-pipeline-v2 and fr-lexical-pipeline-v2 remain the data owners.

import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

const WORD_STATE_BASE_KEY = 'an2_reader_word_state_v1';
const STYLE_ID = 'rd-fr-smooth-reader-v1-style';
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
    .toLocaleLowerCase('fr-FR');
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
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
/* Horizontal typography belongs to the book text, not to Russian gloss boxes. */
#reader-reading-view.rd-fr-smooth-v1.rd-fr-pipeline-v2 .reader-paragraph-text,
#reader-reading-view.rd-fr-smooth-v1.rd-fr-unknown-gloss .reader-paragraph-text{
  line-height:1.72!important;
  text-align:justify!important;
  text-align-last:auto!important;
}
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-v2-wrap,
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-gloss-wrap{
  display:inline!important;
  position:relative!important;
  vertical-align:baseline!important;
  line-height:inherit!important;
  margin:0!important;
  padding:0!important;
  overflow:visible!important;
  white-space:inherit!important;
}
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-v2-wrap>.reader-word,
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-gloss-wrap>.reader-word{
  display:inline!important;
  position:relative!important;
  vertical-align:baseline!important;
  margin:0!important;
  padding:0!important;
  line-height:inherit!important;
  white-space:inherit!important;
  word-break:inherit!important;
  overflow-wrap:inherit!important;
  hyphens:inherit!important;
}
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-v2-gloss,
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-gloss-text{
  position:absolute!important;
  left:50%!important;
  top:100%!important;
  bottom:auto!important;
  transform:translateX(-50%)!important;
  max-width:none!important;
  white-space:nowrap!important;
  pointer-events:none!important;
  font-family:'IBM Plex Sans',sans-serif!important;
  font-size:var(--fr-v2-gloss-font,var(--fr-gloss-font,.38em))!important;
  font-weight:400!important;
  line-height:1!important;
  color:var(--text-muted)!important;
  text-decoration:none!important;
}
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-v2-gloss:not(:empty){display:block!important}
#reader-reading-view.rd-fr-smooth-v1 .rw-fr-gloss-wrap[data-fr-gloss-visible="1"]>.rw-fr-gloss-text:not(:empty){display:block!important}
#reader-reading-view.rd-fr-smooth-v1 [data-fr-fast-known="1"]>.rw-fr-v2-gloss,
#reader-reading-view.rd-fr-smooth-v1 [data-fr-fast-known="1"]>.rw-fr-gloss-text{display:none!important}
`;
  document.head.appendChild(style);
}

function syncViewClass() {
  injectStyles();
  const view = document.getElementById('reader-reading-view');
  if (!view) return;
  view.classList.toggle('rd-fr-smooth-v1', currentLang() === 'fr');
}

function lemmaFor(word) {
  const raw = normalize(word);
  if (!raw) return '';
  try { return normalize(globalThis.readerFrenchLemmaFor?.(raw) || raw); }
  catch { return raw; }
}

function directKey(word) { return `fr:${normalize(word)}`; }

function ensureState(store, word) {
  const key = directKey(word);
  if (!store[key]) {
    store[key] = {
      word: normalize(word), lang: 'fr', seen: 0, clicked: 0,
      saved: false, known: false, status: 'new', places: {}, clickContexts: {},
      updatedAt: new Date().toISOString(),
    };
  }
  return store[key];
}

function applyManualState(state, word, canonical, known, stamp) {
  state.word = normalize(word);
  state.lang = 'fr';
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
      console.warn('[fr smooth] IndexedDB save failed', error?.message || error));
  }, 0);

  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = 0;
    const commit = () => {
      try { localStorage.setItem(key, JSON.stringify(store)); }
      catch (error) { console.warn('[fr smooth] localStorage save failed', error?.message || error); }
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
  let parent = el.parentElement;
  for (let depth = 0; parent && depth < 2; depth += 1, parent = parent.parentElement) {
    if (!parent.classList?.contains('rw-fr-v2-wrap') && !parent.classList?.contains('rw-fr-gloss-wrap')) continue;
    if (known) {
      parent.dataset.frFastKnown = '1';
      if (parent.classList.contains('rw-fr-gloss-wrap')) parent.dataset.frGlossVisible = '0';
    } else {
      delete parent.dataset.frFastKnown;
      if (parent.classList.contains('rw-fr-gloss-wrap')) parent.dataset.frGlossVisible = '1';
    }
  }
}

function compactRussian(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/u.test(text)) return '';
  try { return globalThis.readerFrenchSanitizeRussian?.(text, 44) || text; }
  catch { return text.slice(0, 44).trim(); }
}

async function ensureUnknownGloss(el) {
  if (!el || !el.isConnected || !el.classList.contains('rw-migaku-unknown')) return;
  let wrap = el.parentElement?.classList?.contains('rw-fr-v2-wrap') ? el.parentElement : null;
  if (wrap?.querySelector(':scope > .rw-fr-v2-gloss:not(:empty)')) return;
  const surface = String(el.dataset.word || el.textContent || '').trim();
  if (!surface) return;
  let analysis = null;
  try {
    const paragraph = el.closest('.reader-paragraph');
    const context = String(paragraph?.textContent || '').replace(/\s+/g, ' ').trim();
    if (typeof globalThis.readerFrenchContextualAnalysisFor === 'function') {
      analysis = await globalThis.readerFrenchContextualAnalysisFor(surface, context);
    } else if (typeof globalThis.readerFrenchLexicalAnalysisFor === 'function') {
      analysis = await globalThis.readerFrenchLexicalAnalysisFor(surface);
    }
  } catch {}
  if (!el.isConnected || !el.classList.contains('rw-migaku-unknown')) return;
  const ru = compactRussian(analysis?.ru || analysis?.meaning || '');
  if (!ru) return;
  if (!wrap) {
    const old = el.parentElement?.classList?.contains('rw-fr-gloss-wrap') ? el.parentElement : null;
    if (old) {
      old.dataset.frGlossVisible = '1';
      const oldGloss = old.querySelector(':scope > .rw-fr-gloss-text');
      if (oldGloss && !oldGloss.textContent.trim()) oldGloss.textContent = ru;
      return;
    }
    wrap = document.createElement('span');
    wrap.className = 'rw-fr-v2-wrap';
    wrap.dataset.frPipeline = 'v2';
    el.parentNode?.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  delete wrap.dataset.frFastKnown;
  let gloss = wrap.querySelector(':scope > .rw-fr-v2-gloss');
  if (!gloss) {
    gloss = document.createElement('span');
    gloss.className = 'rw-fr-v2-gloss';
    gloss.setAttribute('aria-hidden', 'true');
    wrap.appendChild(gloss);
  }
  gloss.textContent = ru;
}

function syncPanelFromLiveState(word, known, canonical) {
  const panel = document.getElementById('reader-word-panel');
  if (!panel) return;
  const yes = panel.querySelector('#reader-fr-known-btn');
  const no = panel.querySelector('#reader-fr-unknown-btn');
  const source = panel.querySelector('#reader-fr-knowledge-source');
  yes?.classList.toggle('is-active', !!known);
  no?.classList.toggle('is-active', !known);
  if (!source) return;
  let info = null;
  try { info = globalThis.readerFrenchVocabularyKnowledgeFor?.(word) || null; } catch {}
  const lemma = normalize(info?.lemma || canonical || '');
  const lemmaText = lemma && normalize(word) !== lemma ? ` · лемма ${lemma}` : '';
  const rank = Number(info?.rank);
  const rankText = Number.isFinite(rank) && rank > 0 ? ` · частотность #${Math.round(rank).toLocaleString('ru-RU')}` : '';
  source.textContent = `${known ? 'Знаю' : 'Не знаю'} · вручную${lemmaText}${rankText}`;
}

function scheduleQuietReconcile() {
  const run = () => {
    // Never force a second chapter-wide pass from the tap frame. The existing
    // pipeline will reconcile naturally on navigation; this idle call is only
    // useful when it can run without changing layout signature.
    try { globalThis.readerFrenchRefresh?.('manual-idle', false); } catch {}
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 160);
}

async function handleManualKnowledge(button, event) {
  if (currentLang() !== 'fr') return false;
  const known = button.id === 'reader-fr-known-btn';
  const panelWord = String(document.getElementById('reader-word-title')?.textContent || '').trim();
  if (!panelWord || panelWord === '—') return false;

  // Own this click before fr-vocab-estimate's old synchronous whole-chapter
  // handler sees it. This is the main toc138 jank fix.
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

  // UI first: panel and visible occurrence are updated in the same tap frame.
  syncPanelFromLiveState(panelWord, known, canonical);
  const affected = relevantVisibleWords(lastTappedWord, canonical);
  for (const el of affected) setWordVisual(el, known);
  if (!known) {
    for (const el of affected) void ensureUnknownGloss(el);
  }

  schedulePersistence(store);
  scheduleQuietReconcile();
  try {
    window.dispatchEvent(new CustomEvent('reader:fr-manual-knowledge-fast', {
      detail: { surface, lemma: canonical, value: known ? 'known' : 'unknown' },
    }));
  } catch {}
  return true;
}

function visibleFrenchScopes() {
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
  if (currentLang() !== 'fr') return false;
  const classify = globalThis.readerFrenchVocabularyKnowledgeFor;
  if (typeof classify !== 'function') return originalApplyEstimate?.() || false;
  const nodes = [];
  for (const scope of visibleFrenchScopes()) {
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
    if (i + CHUNK < nodes.length) await new Promise(resolve => requestAnimationFrame(() => resolve()));
  }
  return true;
}

function installSmoothVocabularyApply() {
  if (typeof globalThis.readerApplyFrenchVocabularyEstimate !== 'function') return false;
  if (globalThis.readerApplyFrenchVocabularyEstimate.__toc138Smooth) return true;
  originalApplyEstimate = globalThis.readerApplyFrenchVocabularyEstimate;
  smoothApplyEstimate.__toc138Smooth = true;
  globalThis.readerApplyFrenchVocabularyEstimate = smoothApplyEstimate;
  return true;
}

function pollVocabularyOwner() {
  if (installSmoothVocabularyApply()) return;
  clearTimeout(smoothApplyPoll);
  smoothApplyPoll = setTimeout(pollVocabularyOwner, 120);
}

function installCaptureHooks() {
  document.addEventListener('pointerdown', event => {
    if (currentLang() !== 'fr') return;
    const target = event.target instanceof Element ? event.target.closest('#reader-chapter-text .reader-word') : null;
    if (target) lastTappedWord = target;
  }, true);

  document.addEventListener('click', event => {
    syncViewClass();
    if (currentLang() !== 'fr') return;
    const target = event.target instanceof Element ? event.target : null;
    const word = target?.closest?.('#reader-chapter-text .reader-word');
    if (word) lastTappedWord = word;
    const button = target?.closest?.('#reader-fr-known-btn,#reader-fr-unknown-btn');
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

if (typeof window !== 'undefined' && !window.__readerFrSmoothV1) {
  window.__readerFrSmoothV1 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

export { syncViewClass, smoothApplyEstimate };
