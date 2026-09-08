// toc134 — one Spanish lexical owner for both word cards and inline Unknown glosses.
// The toc133 painter remains responsible for layout/context cache. This bridge first
// uses the same morphology + ES→RU analysis as the Spanish word card. If that local
// dictionary has no Russian for a real Spanish lemma, the existing conservative
// paragraph context batch is kicked immediately instead of leaving a blank label.

let scheduled = 0;
let running = null;
let ensuring = null;
const contextByOccurrence = new Map();

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'spanish' || raw === 'español' || raw === 'es' || raw.startsWith('es-') ? 'es' : raw;
}

function compactRussian(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/u.test(text)) return '';
  text = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\[[^\]]*$/g, '')
    .replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '')
    .trim();
  const first = text.split(/\s*\|\s*|\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || text;
  return first.length <= 42 ? first : first.slice(0, 42).trim();
}

function glossFontSize(surface, ru) {
  const a = Math.max(2, Array.from(String(surface || '')).length);
  const b = Math.max(1, Array.from(String(ru || '')).length);
  const ratio = b / a;
  const em = Math.max(.27, Math.min(.44, .46 / Math.sqrt(Math.max(1, ratio))));
  return `${em.toFixed(3)}em`;
}

function isContextProvider(provider) {
  return /(?:context-deepseek-batch|context-batch-cache|occurrence-cache|deepseek|context)/i.test(String(provider || ''));
}

function rememberContext(wrap, gloss) {
  const ru = compactRussian(gloss?.textContent || '');
  const provider = String(wrap?.dataset?.esProvider || '');
  const occurrenceKey = String(wrap?.dataset?.esOccurrenceKey || '');
  if (!ru || !occurrenceKey || !isContextProvider(provider)) return false;
  contextByOccurrence.set(occurrenceKey, {
    ru,
    provider,
    contextKey: String(wrap.dataset.esContextKey || ''),
  });
  return true;
}

function restoreRememberedContext(word, wrap, gloss) {
  const occurrenceKey = String(wrap?.dataset?.esOccurrenceKey || '');
  const saved = occurrenceKey ? contextByOccurrence.get(occurrenceKey) : null;
  if (!saved?.ru || word?.classList?.contains('rw-es-proper') || !word?.classList?.contains('rw-migaku-unknown')) return false;
  gloss.textContent = saved.ru;
  wrap.dataset.esProvider = saved.provider || 'context-batch-cache';
  if (saved.contextKey) wrap.dataset.esContextKey = saved.contextKey;
  const surface = String(word.dataset.word || word.textContent || '').trim();
  wrap.style.setProperty('--es-v1-gloss-font', glossFontSize(surface, saved.ru));
  return true;
}

function activeScopes(root) {
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  if (!pages.length) return [root];
  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  if (current < 0) current = 0;
  return pages.slice(current, Math.min(pages.length, current + 2));
}

function candidates(root) {
  const out = [];
  for (const scope of activeScopes(root)) {
    for (const word of scope.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')) {
      if (word.classList.contains('rw-es-proper')) continue;
      const wrap = word.parentElement?.classList?.contains('rw-es-v1-wrap') ? word.parentElement : null;
      const gloss = wrap?.querySelector(':scope > .rw-es-v1-gloss') || null;
      if (!wrap || !gloss) continue;
      const provider = String(wrap.dataset.esProvider || '');
      // Context owns an exact occurrence and must stay final. Remember it by the
      // stable toc133 occurrence key before skipping so a Known -> Unknown toggle
      // can restore it immediately even though the wrapper itself was removed.
      if (isContextProvider(provider) && compactRussian(gloss.textContent || '')) {
        rememberContext(wrap, gloss);
        continue;
      }
      out.push({ word, wrap, gloss });
    }
  }
  return out;
}

function blankUnknowns(root) {
  return candidates(root).filter(({ gloss }) => !compactRussian(gloss.textContent || ''));
}

async function repaintNow() {
  if (currentLang() !== 'es') return false;
  const root = document.getElementById('reader-chapter-text');
  const view = document.getElementById('reader-reading-view');
  const analyze = globalThis.readerSpanishLexicalAnalysisFor;
  if (!root || !view || view.style.display === 'none' || typeof analyze !== 'function') return false;
  if (running) return running;

  running = (async () => {
    const items = candidates(root);
    await Promise.all(items.map(async ({ word, wrap, gloss }) => {
      const surface = String(word.dataset.word || word.textContent || '').trim();
      if (!surface) return;
      // A forced toc133 painter refresh can recreate the wrapper with a blank
      // missing-local slot. Restore the already accepted contextual occurrence
      // before doing morphology/network work; this removes the visible blank flash.
      if (restoreRememberedContext(word, wrap, gloss)) return;
      let analysis = null;
      try { analysis = await analyze(surface); } catch {}
      const ru = compactRussian(analysis?.ru || analysis?.meaning || '');
      if (!ru || word.classList.contains('rw-es-proper') || !word.classList.contains('rw-migaku-unknown')) return;
      gloss.textContent = ru;
      wrap.dataset.esProvider = 'es-lexical-owner';
      if (analysis?.lemma) wrap.dataset.esLemma = String(analysis.lemma);
      wrap.style.setProperty('--es-v1-gloss-font', glossFontSize(surface, ru));
    }));
    return true;
  })().finally(() => { running = null; });
  return running;
}

async function ensureGlossesNow(reason = 'lexical-miss') {
  if (currentLang() !== 'es') return false;
  if (ensuring) return ensuring;
  ensuring = (async () => {
    await repaintNow();
    const root = document.getElementById('reader-chapter-text');
    if (!root || !blankUnknowns(root).length) return true;

    // WikDict ES→RU is intentionally conservative and has genuine lexical gaps.
    // Reuse the already-shipped paragraph DeepSeek path for only those blanks;
    // its >=.90 confidence gate and occurrence cache remain authoritative.
    try {
      const context = await import('./es-context-batch-v1.js?v=1');
      if (typeof context?.refine === 'function') await context.refine(reason);
    } catch (error) {
      console.warn('[es inline lexical owner] context fallback unavailable', error?.message || error);
    }
    // Capture any context result before returning. If a later knowledge/pagination
    // refresh replaces the slot, repaintNow can restore this accepted occurrence.
    await repaintNow();
    return !blankUnknowns(root).length;
  })().finally(() => { ensuring = null; });
  return ensuring;
}

function schedule(delay = 0, reason = 'event') {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => { void ensureGlossesNow(reason); }, Math.max(0, Number(delay) || 0));
}

function wrapExplicitRefresh() {
  if (globalThis.__readerEsInlineLexicalRefreshWrapped) return;
  const original = globalThis.readerSpanishPipelineV1RefreshNow;
  if (typeof original !== 'function') return;
  globalThis.__readerEsInlineLexicalRefreshWrapped = true;
  globalThis.readerSpanishPipelineV1RefreshNow = async (...args) => {
    const result = await original(...args);
    // Rendering must never wait on the network. Repaint from local data or a
    // remembered accepted context immediately, then fill genuine misses async.
    await repaintNow();
    schedule(0, 'explicit-refresh');
    return result;
  };
}

if (typeof window !== 'undefined' && !window.__readerEsInlineLexicalOwnerV1) {
  window.__readerEsInlineLexicalOwnerV1 = true;
  wrapExplicitRefresh();
  globalThis.readerSpanishInlineLexicalRefresh = repaintNow;
  globalThis.readerSpanishEnsureInlineGlosses = ensureGlossesNow;
  window.addEventListener('reader:es-pipeline-v1-ready', () => schedule(0, 'pipeline-ready'));
  window.addEventListener('reader:es-lexical-corrected', () => schedule(0, 'lexical-corrected'));
  window.addEventListener('reader:es-vocab-ready', () => schedule(20, 'vocab-ready'));
  window.addEventListener('reader:pagechange', () => schedule(20, 'pagechange'));
  window.addEventListener('reader:word-state-changed', () => schedule(0, 'word-state'));
  window.addEventListener('an2:languagechange', () => schedule(0, 'language'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { wrapExplicitRefresh(); schedule(0, 'dom-ready'); }, { once: true });
  else schedule(0, 'boot');
}

export { repaintNow, ensureGlossesNow };
