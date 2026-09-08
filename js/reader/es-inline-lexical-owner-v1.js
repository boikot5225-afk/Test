// toc134 — one Spanish lexical owner for both word cards and inline Unknown glosses.
// The toc133 painter remains responsible for layout/context cache. This bridge only
// replaces its direct-dictionary fallback with the same morphology + ES→RU analysis
// used by the Spanish word card, so forms such as cometerlos/bastaron cannot diverge.

let scheduled = 0;
let running = null;

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
      // Context owns an exact occurrence and must stay final. Everything else is
      // a local fallback and therefore must use the same lexical owner as cards.
      if (/(?:context-deepseek-batch|occurrence-cache|deepseek|context)/i.test(provider) && String(gloss.textContent || '').trim()) continue;
      out.push({ word, wrap, gloss });
    }
  }
  return out;
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

function schedule(delay = 0) {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => { void repaintNow(); }, Math.max(0, Number(delay) || 0));
}

function wrapExplicitRefresh() {
  if (globalThis.__readerEsInlineLexicalRefreshWrapped) return;
  const original = globalThis.readerSpanishPipelineV1RefreshNow;
  if (typeof original !== 'function') return;
  globalThis.__readerEsInlineLexicalRefreshWrapped = true;
  globalThis.readerSpanishPipelineV1RefreshNow = async (...args) => {
    const result = await original(...args);
    await repaintNow();
    return result;
  };
}

if (typeof window !== 'undefined' && !window.__readerEsInlineLexicalOwnerV1) {
  window.__readerEsInlineLexicalOwnerV1 = true;
  wrapExplicitRefresh();
  globalThis.readerSpanishInlineLexicalRefresh = repaintNow;
  window.addEventListener('reader:es-pipeline-v1-ready', () => schedule(0));
  window.addEventListener('reader:es-lexical-corrected', () => schedule(0));
  window.addEventListener('reader:pagechange', () => schedule(20));
  window.addEventListener('reader:word-state-changed', () => schedule(0));
  window.addEventListener('an2:languagechange', () => schedule(0));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { wrapExplicitRefresh(); schedule(0); }, { once: true });
  else schedule(0);
}

export { repaintNow };
