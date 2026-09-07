// toc133 — Spanish Reader v1.
// Event-driven and isolated from pagination: classify first, paint WikDict
// immediately, then let es-context-batch refine exact occurrences later.

const CORE_URL = new URL('../../../esreader/es_ru_core.json?v=1', import.meta.url).href;
const SENSES_URL = new URL('../../../esreader/es_ru_senses.json?v=1', import.meta.url).href;
const OCCURRENCE_CACHE_BASE = 'an2_reader_es_occurrence_context_v1';
const MAX_OCCURRENCE_CACHE = 2500;
const PREFETCH_PAGES = 1;

let vocabReady = null;
let assetsPromise = null;
let assets = null;
let scheduled = 0;
let running = false;
let rerun = false;
let lastSignature = '';

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('es-ES');
}

function containsCyrillic(value) {
  return /[\u0400-\u052f]/u.test(String(value || ''));
}

function compactRussian(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || !containsCyrillic(text)) return '';
  text = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\[[^\]]*$/g, '')
    .replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '')
    .trim();
  const first = text.split(/\s*\|\s*|\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || text;
  if (first.length <= 42) return first;
  let out = '';
  for (const word of first.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 42) break;
    out = next;
  }
  return out || first.slice(0, 42).trim();
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'spanish' || raw === 'español' || raw === 'es' || raw.startsWith('es-') ? 'es' : raw;
}

function storageKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function readObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeObject(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value || {})); } catch {}
}

function hashText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

class SilentMutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

async function ensureVocabularyLayer() {
  if (vocabReady) return vocabReady;
  vocabReady = (async () => {
    const NativeObserver = globalThis.MutationObserver;
    try {
      if (NativeObserver) globalThis.MutationObserver = SilentMutationObserver;
      await import('./es-vocab-estimate.js?v=1-passive');
    } finally {
      if (NativeObserver) globalThis.MutationObserver = NativeObserver;
    }
    return true;
  })();
  return vocabReady;
}

async function loadAssets() {
  if (assets) return assets;
  if (assetsPromise) return assetsPromise;
  assetsPromise = Promise.all([
    fetch(CORE_URL, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`ES core HTTP ${r.status}`);
      return r.json();
    }),
    fetch(SENSES_URL, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`ES senses HTTP ${r.status}`);
      return r.json();
    }),
  ]).then(([core, senses]) => {
    assets = { core: core || {}, senses: senses || {} };
    return assets;
  }).finally(() => { assetsPromise = null; });
  return assetsPromise;
}

function injectStyles() {
  if (document.getElementById('rd-es-pipeline-v1-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-es-pipeline-v1-style';
  style.textContent = `
#reader-reading-view.rd-es-pipeline-v1 .reader-paragraph-text{line-height:1.82!important}
#reader-reading-view.rd-es-pipeline-v1 .rw-es-v1-wrap{display:inline-block!important;position:relative!important;vertical-align:-.37em!important;line-height:1!important;padding:0 0 .58em!important;margin:0 .018em!important;white-space:nowrap!important;overflow:visible!important}
#reader-reading-view.rd-es-pipeline-v1 .rw-es-v1-wrap>.reader-word{display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important}
#reader-reading-view.rd-es-pipeline-v1 .rw-es-v1-gloss{position:absolute!important;left:50%!important;bottom:.02em!important;transform:translateX(-50%)!important;white-space:nowrap!important;pointer-events:none!important;font-family:'IBM Plex Sans',sans-serif!important;font-size:var(--es-v1-gloss-font,.37em)!important;font-weight:400!important;line-height:1!important;color:var(--text-muted)!important;text-decoration:none!important}
#reader-reading-view.rd-es-pipeline-v1 .rw-es-v1-gloss:empty{visibility:hidden!important}
`;
  document.head.appendChild(style);
}

function glossFontSize(surface, ru) {
  const a = Math.max(2, Array.from(String(surface || '')).length);
  const b = Math.max(1, Array.from(String(ru || '')).length);
  const ratio = b / a;
  const em = Math.max(.27, Math.min(.44, .46 / Math.sqrt(Math.max(1, ratio))));
  return `${em.toFixed(3)}em`;
}

function ensureGlossSlot(el) {
  if (!el?.parentNode) return null;
  let wrap = el.parentElement?.classList?.contains('rw-es-v1-wrap') ? el.parentElement : null;
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-es-v1-wrap';
    wrap.dataset.esPipeline = 'v1';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  let gloss = wrap.querySelector(':scope > .rw-es-v1-gloss');
  if (!gloss) {
    gloss = document.createElement('span');
    gloss.className = 'rw-es-v1-gloss';
    gloss.setAttribute('aria-hidden', 'true');
    wrap.appendChild(gloss);
  }
  return { wrap, gloss };
}

function setGloss(el, value, provider = 'wikdict', occurrenceKey = '') {
  const ru = compactRussian(value);
  const slot = ensureGlossSlot(el);
  if (!slot) return false;
  const surface = String(el.dataset.word || el.textContent || '').trim();
  slot.gloss.textContent = ru;
  slot.wrap.dataset.esProvider = provider;
  if (occurrenceKey) slot.wrap.dataset.esOccurrenceKey = occurrenceKey;
  slot.wrap.style.setProperty('--es-v1-gloss-font', glossFontSize(surface, ru));
  return !!ru;
}

function removeGloss(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-es-v1-wrap') ? el.parentElement : null;
  if (!wrap) return;
  wrap.parentNode?.insertBefore(el, wrap);
  wrap.remove();
}

function wordSurface(el) {
  return String(el?.dataset?.word || el?.textContent || '').trim();
}

function lemmaFor(surface) {
  const raw = normalize(surface);
  if (!raw) return '';
  try {
    const mapped = normalize(globalThis.readerSpanishLemmaFor?.(raw) || raw);
    if (mapped) return mapped;
  } catch {}
  return raw;
}

function directTranslation(surface, lemma, core) {
  for (const key of [normalize(lemma), normalize(surface)]) {
    const ru = compactRussian(core?.[key] || '');
    if (ru) return ru;
  }
  return '';
}

function paragraphContext(paragraph) {
  return Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))
    .map(wordSurface).filter(Boolean).join(' ');
}

function isLikelyProper(el) {
  const shown = String(el?.textContent || el?.dataset?.word || '').trim();
  if (!/^[A-ZÁÉÍÓÚÜÑ]/u.test(shown)) return false;
  const paragraph = el.closest?.('.reader-paragraph');
  if (!paragraph) return false;
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const index = words.indexOf(el);
  if (index <= 0) return false;
  const previous = String(words[index - 1]?.textContent || '').trim();
  return !/[.!?…]$/u.test(previous);
}

function occurrenceKey(el, paragraph, context) {
  const root = document.getElementById('reader-chapter-text');
  const book = String(root?.dataset?.readerBookId || 'book');
  const chapter = String(root?.dataset?.renderedChapter || '0');
  const p = String(paragraph?.dataset?.p || '0');
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const index = Math.max(0, words.indexOf(el));
  return `${book}|${chapter}|${p}|${index}|${hashText(normalize(context))}|${normalize(wordSurface(el))}`;
}

function occurrenceCache() {
  return readObject(storageKey(OCCURRENCE_CACHE_BASE));
}

function saveOccurrence(key, ru, provider = 'context') {
  if (!key || !compactRussian(ru)) return;
  const cache = occurrenceCache();
  cache[key] = { ru: compactRussian(ru), provider, t: Date.now() };
  let entries = Object.entries(cache);
  if (entries.length > MAX_OCCURRENCE_CACHE) {
    entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
    entries = entries.slice(0, MAX_OCCURRENCE_CACHE);
  }
  writeObject(storageKey(OCCURRENCE_CACHE_BASE), Object.fromEntries(entries));
}

function activeScopes(root) {
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  if (!pages.length) return [root];
  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  if (current < 0) current = 0;
  return pages.slice(current, Math.min(pages.length, current + PREFETCH_PAGES + 1));
}

function renderSignature(root) {
  const words = root.querySelectorAll('.reader-word[data-word]');
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  return [
    root.dataset.readerBookId || '', root.dataset.renderedChapter || '', words.length,
    normalize(words[0]?.dataset?.word || ''), normalize(words[words.length - 1]?.dataset?.word || ''), current,
  ].join('|');
}

async function applyKnowledgeOnce() {
  await ensureVocabularyLayer();
  const fn = globalThis.readerApplySpanishVocabularyEstimate;
  if (typeof fn === 'function') await fn();
}

function processScope(scope, data) {
  const cache = occurrenceCache();
  for (const paragraph of Array.from(scope.querySelectorAll('.reader-paragraph'))) {
    const context = paragraphContext(paragraph);
    for (const el of Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))) {
      // Preserve a proper-name verdict from the vocabulary owner. The local
      // occurrence heuristic supplements it for obvious mid-sentence capitals.
      if (el.classList.contains('rw-es-proper') || isLikelyProper(el)) {
        el.classList.remove('rw-migaku-unknown');
        el.classList.add('rw-es-proper');
        removeGloss(el);
        continue;
      }
      if (!el.classList.contains('rw-migaku-unknown')) {
        removeGloss(el);
        continue;
      }
      const surface = wordSurface(el);
      if (!surface) continue;
      const key = occurrenceKey(el, paragraph, context);
      const cached = compactRussian(cache[key]?.ru || '');
      if (cached) {
        setGloss(el, cached, cache[key]?.provider || 'occurrence-cache', key);
        continue;
      }
      const lemma = lemmaFor(surface);
      const immediate = directTranslation(surface, lemma, data.core);
      setGloss(el, immediate, immediate ? 'wikdict-immediate' : 'missing-local', key);
    }
  }
}

async function refresh(reason = 'event', force = false) {
  if (currentLang() !== 'es') return false;
  const root = document.getElementById('reader-chapter-text');
  const view = document.getElementById('reader-reading-view');
  if (!root || !view || view.style.display === 'none') return false;
  const before = renderSignature(root);
  if (!force && before && before === lastSignature) return false;
  if (running) { rerun = true; return false; }
  running = true;
  try {
    injectStyles();
    view.classList.add('rd-es-pipeline-v1');
    const [, data] = await Promise.all([ensureVocabularyLayer(), loadAssets()]);
    await applyKnowledgeOnce();
    for (const scope of activeScopes(root)) processScope(scope, data);
    lastSignature = renderSignature(root);
    try {
      window.dispatchEvent(new CustomEvent('reader:es-pipeline-v1-ready', {
        detail: { reason, signature: lastSignature },
      }));
    } catch {}
    return true;
  } catch (error) {
    console.warn('[es pipeline v1] refresh failed', error?.message || error);
    return false;
  } finally {
    running = false;
    if (rerun) { rerun = false; scheduleRefresh('rerun', 0, true); }
  }
}

function scheduleRefresh(reason = 'event', delay = 30, force = false) {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => { void refresh(reason, force); }, Math.max(0, Number(delay) || 0));
}

function installEventHooks() {
  document.addEventListener('click', () => scheduleRefresh('click', 45, false), true);
  window.addEventListener('pageshow', () => scheduleRefresh('pageshow', 0, true));
  window.addEventListener('an2:languagechange', () => scheduleRefresh('language', 0, true));
  window.addEventListener('reader:pagechange', () => scheduleRefresh('pagechange', 40, true));
  window.addEventListener('reader:es-vocab-ready', () => scheduleRefresh('knowledge', 0, true));
  window.addEventListener('reader:word-state-changed', () => scheduleRefresh('word-state', 0, true));
}

function boot() {
  injectStyles();
  const warm = () => { void Promise.allSettled([ensureVocabularyLayer(), loadAssets()]); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 700 });
  else setTimeout(warm, 120);
  scheduleRefresh('boot', 80, true);
}

if (typeof window !== 'undefined' && !window.__readerEsPipelineV1) {
  window.__readerEsPipelineV1 = true;
  window.readerSpanishRefresh = (reason = 'external', force = true) => scheduleRefresh(reason, 0, force);
  window.readerSpanishPipelineV1RefreshNow = refresh;
  window.readerSpanishLemmaForOccurrence = lemmaFor;
  // Never equate "capitalized" with "proper noun" at sentence start. Require
  // at least one non-initial capitalized occurrence in the current chapter,
  // mirroring the proven French chapter heuristic. A one-off ambiguous name can
  // still be resolved by the conservative context batch.
  window.readerSpanishIsProperWord = (word) => {
    const raw = String(word || '').trim();
    if (!/^[A-ZÁÉÍÓÚÜÑ]/u.test(raw)) return false;
    const root = document.getElementById('reader-chapter-text');
    if (!root || typeof document.createRange !== 'function') return false;
    const wanted = normalize(raw);
    const matches = Array.from(root.querySelectorAll('.reader-word[data-word]'))
      .filter(el => normalize(el.dataset.word || el.textContent || '') === wanted);
    if (!matches.length) return false;
    let capitals = 0;
    let lowers = 0;
    let nonInitial = 0;
    for (const el of matches) {
      const shown = String(el.textContent || el.dataset.word || '').trim();
      const upper = /^[A-ZÁÉÍÓÚÜÑ]/u.test(shown);
      if (upper) capitals += 1; else lowers += 1;
      let before = '';
      try {
        const paragraph = el.closest('.reader-paragraph') || root;
        const range = document.createRange();
        range.setStart(paragraph, 0);
        range.setEndBefore(el);
        before = String(range.toString() || '').slice(-80).trimEnd();
      } catch {}
      const sentenceInitial = !before || /[.!?…][\s"'»”)]*$/u.test(before);
      if (upper && !sentenceInitial) nonInitial += 1;
    }
    return capitals > 0 && lowers === 0 && nonInitial > 0;
  };
  installEventHooks();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

export { normalize, compactRussian, lemmaFor, directTranslation, refresh };
