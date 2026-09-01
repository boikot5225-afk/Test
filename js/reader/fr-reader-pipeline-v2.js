// toc124 — French Reader v2.
// Goal: one event-driven pipeline for French reading, no MutationObserver loops.
// It keeps the toc119 reader core untouched and treats French as a data layer.

const CORE_URL = new URL('../../../frreader/fr_ru_core.json?v=2', import.meta.url).href;
const SENSES_URL = new URL('../../../frreader/fr_ru_senses.json?v=2', import.meta.url).href;
const OCCURRENCE_CACHE_BASE = 'an2_reader_fr_occurrence_context_v2';
const MAX_OCCURRENCE_CACHE = 2500;
const PREFETCH_PAGES = 1;

let legacyReady = null;
let assetsPromise = null;
let assets = null;
let scheduled = 0;
let running = false;
let rerun = false;
let lastSignature = '';
let lastTappedWord = null;

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('fr-FR');
}

function containsCyrillic(value) {
  return /[\u0400-\u052f]/u.test(String(value || ''));
}

function compactRussian(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || !containsCyrillic(text)) return '';
  try {
    const shared = globalThis.readerFrenchSanitizeRussian?.(text, 60);
    if (shared) text = shared;
  } catch {}
  text = text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s*\[[^\]]*$/g, '')
    .replace(/^[,;:|/\s]+|[,;:|/\s]+$/g, '')
    .trim();
  const first = text.split(/\s*\|\s*|\s*[;；]\s*|\s*\/\s*/).filter(Boolean)[0] || text;
  if (first.length <= 36) return first;
  let out = '';
  for (const word of first.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 36) break;
    out = next;
  }
  return out || first.slice(0, 36).trim();
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'french' || raw === 'fr' || raw.startsWith('fr-') ? 'fr' : raw;
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

async function ensureLegacyVocabularyLayer() {
  if (legacyReady) return legacyReady;
  legacyReady = (async () => {
    // Keep the mature Measure-my-level/manual Known-Unknown UI, but install it
    // with inert observers. toc124 calls its batch API only on real reader events.
    const NativeObserver = globalThis.MutationObserver;
    try {
      if (NativeObserver) globalThis.MutationObserver = SilentMutationObserver;
      await import('./fr-vocab-estimate.js?v=124-passive');
    } finally {
      if (NativeObserver) globalThis.MutationObserver = NativeObserver;
    }
    return true;
  })();
  return legacyReady;
}

async function loadAssets() {
  if (assets) return assets;
  if (assetsPromise) return assetsPromise;
  assetsPromise = Promise.all([
    fetch(CORE_URL, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`FR core HTTP ${r.status}`);
      return r.json();
    }),
    fetch(SENSES_URL, { cache: 'force-cache' }).then(r => {
      if (!r.ok) throw new Error(`FR senses HTTP ${r.status}`);
      return r.json();
    }),
  ]).then(([core, senses]) => {
    assets = { core: core || {}, senses: senses || {} };
    return assets;
  }).finally(() => { assetsPromise = null; });
  return assetsPromise;
}

function injectStyles() {
  if (document.getElementById('rd-fr-pipeline-v2-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-fr-pipeline-v2-style';
  style.textContent = `
#reader-reading-view.rd-fr-pipeline-v2 .reader-paragraph-text{line-height:1.82!important}
#reader-reading-view.rd-fr-pipeline-v2 .rw-fr-v2-wrap{display:inline-block!important;position:relative!important;vertical-align:-.37em!important;line-height:1!important;padding:0 0 .58em!important;margin:0 .018em!important;white-space:nowrap!important;overflow:visible!important}
#reader-reading-view.rd-fr-pipeline-v2 .rw-fr-v2-wrap>.reader-word{display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important}
#reader-reading-view.rd-fr-pipeline-v2 .rw-fr-v2-gloss{position:absolute!important;left:50%!important;bottom:.02em!important;transform:translateX(-50%)!important;white-space:nowrap!important;pointer-events:none!important;font-family:'IBM Plex Sans',sans-serif!important;font-size:var(--fr-v2-gloss-font,.37em)!important;font-weight:400!important;line-height:1!important;color:var(--text-muted)!important;text-decoration:none!important}
#reader-reading-view.rd-fr-pipeline-v2 .rw-fr-v2-gloss:empty{visibility:hidden!important}
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

function unwrapOldGloss(el) {
  const parent = el?.parentElement;
  if (!parent?.classList?.contains('rw-fr-gloss-wrap')) return el;
  parent.parentNode?.insertBefore(el, parent);
  parent.remove();
  return el;
}

function ensureGlossSlot(el) {
  if (!el?.parentNode) return null;
  unwrapOldGloss(el);
  let wrap = el.parentElement?.classList?.contains('rw-fr-v2-wrap') ? el.parentElement : null;
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-fr-v2-wrap';
    wrap.dataset.frPipeline = 'v2';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  let gloss = wrap.querySelector(':scope > .rw-fr-v2-gloss');
  if (!gloss) {
    gloss = document.createElement('span');
    gloss.className = 'rw-fr-v2-gloss';
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
  slot.wrap.dataset.frProvider = provider;
  if (occurrenceKey) slot.wrap.dataset.frOccurrenceKey = occurrenceKey;
  slot.wrap.style.setProperty('--fr-v2-gloss-font', glossFontSize(surface, ru));
  return !!ru;
}

function removeGloss(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-fr-v2-wrap') ? el.parentElement : null;
  if (!wrap) return;
  wrap.parentNode?.insertBefore(el, wrap);
  wrap.remove();
}

function wordSurface(el) {
  return String(el?.dataset?.word || el?.textContent || '').trim();
}

function baseSurface(surface) {
  const raw = normalize(surface);
  const inversion = raw.match(/^(.+?)-(?:je|tu|il|elle|on|nous|vous|ils|elles)$/u);
  if (inversion?.[1]) return inversion[1];
  const elision = raw.match(/^(?:[cdjlmnst]|qu)'(.+)$/u);
  if (elision?.[1]) return elision[1];
  return raw;
}

function lemmaFor(surface) {
  const raw = normalize(surface);
  if (!raw) return '';
  for (const candidate of [raw, baseSurface(raw)]) {
    if (!candidate) continue;
    try {
      const value = normalize(globalThis.readerFrenchLemmaFor?.(candidate) || candidate);
      if (value && value !== candidate) return value;
    } catch {}
  }
  return baseSurface(raw) || raw;
}

function directTranslation(surface, lemma, core) {
  const raw = normalize(surface);
  const base = baseSurface(raw);
  for (const key of [lemma, base, raw]) {
    const ru = compactRussian(core?.[normalize(key)] || '');
    if (ru) return ru;
  }
  return '';
}

const SURFACE_CONTEXT = new Map([
  ["veux-tu", { lemma: 'vouloir', ru: 'хочешь' }],
  ["t'ennuiera", { lemma: 'ennuyer', ru: 'тебе наскучит' }],
  ["m'ennuie", { lemma: 'ennuyer', ru: 'мне скучно' }],
  ["s'ennuie", { lemma: 'ennuyer', ru: 'ему скучно' }],
]);

const PHRASE_RULES = [
  { words: ['tendre', 'la', 'joue'], values: { 0: 'подставить', 2: 'щёку' }, id: 'tendre-la-joue' },
  { words: ['au', 'courant'], values: { 1: 'в курсе' }, id: 'au-courant' },
  { words: ['tout', 'de', 'suite'], values: { 2: 'сразу' }, id: 'tout-de-suite' },
  { words: ['se', 'rendre', 'compte'], values: { 1: 'понять', 2: 'осознать' }, id: 'se-rendre-compte' },
  { words: ['il', 'faut'], values: { 1: 'нужно' }, id: 'il-faut' },
  { words: ['avoir', "l'air"], values: { 0: 'казаться', 1: 'вид' }, id: 'avoir-l-air' },
  { words: ['être', 'en', 'train', 'de'], values: { 2: 'сейчас' }, id: 'etre-en-train-de' },
];

function phraseOverrides(paragraph) {
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const normalized = words.map(el => normalize(wordSurface(el)));
  const overrides = new Map();
  for (let start = 0; start < normalized.length; start += 1) {
    const direct = SURFACE_CONTEXT.get(normalized[start]);
    if (direct) overrides.set(words[start], { ...direct, provider: 'surface-context' });
    for (const rule of PHRASE_RULES) {
      if (start + rule.words.length > normalized.length) continue;
      let matches = true;
      for (let i = 0; i < rule.words.length; i += 1) {
        const actual = normalized[start + i];
        const expected = rule.words[i];
        const actualLemma = lemmaFor(actual);
        if (actual !== expected && actualLemma !== expected) { matches = false; break; }
      }
      if (!matches) continue;
      for (const [offsetText, ru] of Object.entries(rule.values)) {
        const offset = Number(offsetText);
        const target = words[start + offset];
        if (target) overrides.set(target, { ru, provider: `phrase:${rule.id}` });
      }
    }
  }
  return overrides;
}

function paragraphContext(paragraph) {
  return Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))
    .map(wordSurface).filter(Boolean).join(' ');
}

function isLikelyProper(el) {
  const shown = String(el?.textContent || el?.dataset?.word || '').trim();
  if (!/^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/u.test(shown)) return false;
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
  return `${book}|${chapter}|${p}|${index}|${hashText(normalize(context))}`;
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
  const first = normalize(words[0]?.dataset?.word || '');
  const last = normalize(words[words.length - 1]?.dataset?.word || '');
  return [
    root.dataset.readerBookId || '', root.dataset.renderedChapter || '',
    words.length, first, last, current,
  ].join('|');
}

async function applyKnowledgeOnce(root) {
  await ensureLegacyVocabularyLayer();
  const fn = globalThis.readerApplyFrenchVocabularyEstimate;
  if (typeof fn !== 'function') return;
  // The old proper-name helper performs chapter-wide searches for each token.
  // Suppress only during bulk classification; v2 has a cheap occurrence-local guard.
  const proper = globalThis.readerFrenchIsProperWord;
  try {
    globalThis.readerFrenchIsProperWord = undefined;
    await fn();
  } finally {
    globalThis.readerFrenchIsProperWord = proper;
  }
}

function processScope(scope, data) {
  const cache = occurrenceCache();
  const paragraphs = Array.from(scope.querySelectorAll('.reader-paragraph'));
  for (const paragraph of paragraphs) {
    const context = paragraphContext(paragraph);
    const overrides = phraseOverrides(paragraph);
    const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
    for (const el of words) {
      if (isLikelyProper(el)) {
        el.classList.remove('rw-migaku-unknown');
        el.classList.add('rw-fr-proper');
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
      const contextual = overrides.get(el);
      if (contextual?.ru) {
        setGloss(el, contextual.ru, contextual.provider || 'phrase', key);
        saveOccurrence(key, contextual.ru, contextual.provider || 'phrase');
        continue;
      }
      const lemma = normalize(contextual?.lemma || lemmaFor(surface));
      const immediate = directTranslation(surface, lemma, data.core);
      // Never leave an Unknown blank merely because a future context pass might
      // improve it. Context is allowed to replace, never to suppress.
      setGloss(el, immediate, immediate ? 'wikdict-immediate' : 'missing-local', key);
    }
  }
}

async function refresh(reason = 'event', force = false) {
  if (currentLang() !== 'fr') return false;
  const root = document.getElementById('reader-chapter-text');
  const view = document.getElementById('reader-reading-view');
  if (!root || !view || view.style.display === 'none') return false;
  const before = renderSignature(root);
  if (!force && before && before === lastSignature) return false;
  if (running) { rerun = true; return false; }
  running = true;
  try {
    injectStyles();
    view.classList.add('rd-fr-pipeline-v2');
    const [, data] = await Promise.all([ensureLegacyVocabularyLayer(), loadAssets()]);
    await applyKnowledgeOnce(root);
    for (const scope of activeScopes(root)) processScope(scope, data);
    lastSignature = renderSignature(root);
    try {
      window.dispatchEvent(new CustomEvent('reader:fr-pipeline-v2-ready', {
        detail: { reason, signature: lastSignature },
      }));
    } catch {}
    return true;
  } catch (error) {
    console.warn('[fr pipeline v2] refresh failed', error?.message || error);
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

function updateTappedOccurrenceFromAnalysis(detail = {}) {
  const el = lastTappedWord;
  if (!el?.isConnected || currentLang() !== 'fr') return;
  const surface = normalize(detail.surface || detail.word || '');
  if (!surface || surface !== normalize(wordSurface(el))) return;
  const ru = compactRussian(detail.ru || detail.translation || detail.meaning || '');
  const context = String(detail.context || '').trim();
  if (!ru || !context) return; // context-free lexical corrections stay lexical.
  const paragraph = el.closest('.reader-paragraph');
  if (!paragraph) return;
  const key = occurrenceKey(el, paragraph, paragraphContext(paragraph));
  setGloss(el, ru, 'deepseek-occurrence', key);
  saveOccurrence(key, ru, 'deepseek-occurrence');
}

function installEventHooks() {
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const word = target?.closest?.('#reader-chapter-text .reader-word[data-word]');
    if (word) lastTappedWord = word;
    // Clicks can open a book/chapter or change the language. A signature check
    // makes this cheap when the rendered text did not change.
    scheduleRefresh('click', 45, false);
  }, true);
  window.addEventListener('pageshow', () => scheduleRefresh('pageshow', 0, true));
  window.addEventListener('an2:languagechange', () => scheduleRefresh('language', 0, true));
  window.addEventListener('reader:fr-vocab-ready', () => scheduleRefresh('knowledge', 0, true));
  document.addEventListener('reader:fr-analysis-ready', event => updateTappedOccurrenceFromAnalysis(event?.detail || {}));
}

function boot() {
  injectStyles();
  // Warm assets without touching layout. The first visible French page then
  // mostly performs DOM writes only.
  const warm = () => { void Promise.allSettled([ensureLegacyVocabularyLayer(), loadAssets()]); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 700 });
  else setTimeout(warm, 120);
  scheduleRefresh('boot', 80, true);
}

if (typeof window !== 'undefined' && !window.__readerFrPipelineV2) {
  window.__readerFrPipelineV2 = true;
  window.readerFrenchRefresh = (reason = 'external', force = true) => scheduleRefresh(reason, 0, force);
  window.readerFrenchPipelineV2RefreshNow = refresh;
  installEventHooks();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

export { normalize, compactRussian, lemmaFor, directTranslation, phraseOverrides, refresh };
