// German Reader v1.
// Классифицировать, сразу нарисовать перевод из WikDict, а уточнения оставить
// разбору абзаца. Устройство то же, что у испанского слоя; немецкого в нём три
// вещи.
//
// Заглавная буква — не имя собственное. В испанском слово с заглавной посреди
// предложения почти наверняка имя; в немецком с заглавной пишется КАЖДОЕ
// существительное, и правило испанского слоя записало бы в имена весь словарь.
// Поэтому имя здесь — это слово с заглавной, которого нет ни в списке
// существительных, ни в словаре.
//
// Регистр решает, какое это слово. Stunden с заглавной — существительное
// Stunde, stunden со строчной — глагол. Лемма берётся из слоя данных, который
// смотрит на написание в тексте, а не на приведённую строку.
//
// Составное слово переводится по частям. Haustür нет ни в одном словаре, но
// Haus и Tür есть, и «дом + дверь» — это и есть подсказка.
import {
  normalize,
  vocabularyData,
  lemmaFor as lemmaFromData,
  compoundParts,
  startsUpper,
  isName,
} from './de-vocab-data-v1.js?v=1';

const CORE_URL = new URL('../../../dereader/de_ru_core.json?v=1', import.meta.url).href;
const SENSES_URL = new URL('../../../dereader/de_ru_senses.json?v=1', import.meta.url).href;
const OCCURRENCE_CACHE_BASE = 'an2_reader_de_occurrence_context_v1';
const MAX_OCCURRENCE_CACHE = 2500;
const PREFETCH_PAGES = 1;

let vocabReady = null;
let assetsPromise = null;
let assets = null;
let scheduled = 0;
let running = false;
let rerun = false;
let lastSignature = '';

function containsCyrillic(value) {
  return /[Ѐ-ԯ]/u.test(String(value || ''));
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
  return raw === 'german' || raw === 'deutsch' || raw === 'de' || raw.startsWith('de-') ? 'de' : raw;
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
      await import('./de-vocab-estimate.js?v=1-passive');
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
      if (!r.ok) throw new Error(`DE core HTTP ${r.status}`);
      return r.json();
    }),
    fetch(SENSES_URL, { cache: 'force-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    vocabularyData(),
  ]).then(([core, senses, data]) => {
    assets = { core: core || {}, senses: senses || {}, data };
    return assets;
  }).finally(() => { assetsPromise = null; });
  return assetsPromise;
}

function injectStyles() {
  if (document.getElementById('rd-de-pipeline-v1-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-de-pipeline-v1-style';
  style.textContent = `
#reader-reading-view.rd-de-pipeline-v1 .reader-paragraph-text{line-height:1.82!important}
#reader-reading-view.rd-de-pipeline-v1 .rw-de-v1-wrap{display:inline-block!important;position:relative!important;vertical-align:-.37em!important;line-height:1!important;padding:0 0 .58em!important;margin:0 .018em!important;white-space:nowrap!important;overflow:visible!important}
#reader-reading-view.rd-de-pipeline-v1 .rw-de-v1-wrap>.reader-word{display:inline!important;margin:0!important;padding:0 1px!important;line-height:1.04!important;white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important}
#reader-reading-view.rd-de-pipeline-v1 .rw-de-v1-gloss{position:absolute!important;left:50%!important;bottom:.02em!important;transform:translateX(-50%)!important;white-space:nowrap!important;pointer-events:none!important;font-family:'IBM Plex Sans',sans-serif!important;font-size:var(--de-v1-gloss-font,.37em)!important;font-weight:400!important;line-height:1!important;color:var(--text-muted)!important;text-decoration:none!important}
#reader-reading-view.rd-de-pipeline-v1 .rw-de-v1-gloss:empty{visibility:hidden!important}
`;
  document.head.appendChild(style);
}

function glossFontSize(surface, ru) {
  const a = Math.max(2, Array.from(String(surface || '')).length);
  const b = Math.max(1, Array.from(String(ru || '')).length);
  const em = Math.max(.27, Math.min(.44, .46 / Math.sqrt(Math.max(1, b / a))));
  return `${em.toFixed(3)}em`;
}

function ensureGlossSlot(el) {
  if (!el?.parentNode) return null;
  let wrap = el.parentElement?.classList?.contains('rw-de-v1-wrap') ? el.parentElement : null;
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-de-v1-wrap';
    wrap.dataset.dePipeline = 'v1';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  let gloss = wrap.querySelector(':scope > .rw-de-v1-gloss');
  if (!gloss) {
    gloss = document.createElement('span');
    gloss.className = 'rw-de-v1-gloss';
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
  slot.wrap.dataset.deProvider = provider;
  if (occurrenceKey) slot.wrap.dataset.deOccurrenceKey = occurrenceKey;
  slot.wrap.style.setProperty('--de-v1-gloss-font', glossFontSize(surface, ru));
  return !!ru;
}

function removeGloss(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-de-v1-wrap') ? el.parentElement : null;
  if (!wrap) return;
  wrap.parentNode?.insertBefore(el, wrap);
  wrap.remove();
}

function wordSurface(el) {
  return String(el?.dataset?.word || el?.textContent || '').trim();
}

function sentenceInitial(el, paragraph) {
  const words = Array.from(paragraph?.querySelectorAll?.('.reader-word[data-word]') || []);
  const index = words.indexOf(el);
  if (index <= 0) return true;
  const previous = String(words[index - 1]?.textContent || '').trim();
  return /[.!?…:;»"']$/u.test(previous);
}

export function lemmaForElement(data, el, paragraph) {
  const shown = String(el?.textContent || el?.dataset?.word || '').trim();
  if (!shown) return '';
  return lemmaFromData(data, shown, {
    capitalized: startsUpper(shown),
    sentenceInitial: sentenceInitial(el, paragraph),
  });
}

function dictionaryHit(core, word) {
  return compactRussian(core?.[normalize(word)] || '');
}

// Перевод немецкого слова: сначала словарь, потом — по частям составного.
export function translationFor(core, data, surface, lemma) {
  for (const key of [lemma, surface]) {
    const ru = dictionaryHit(core, key);
    if (ru) return { ru, provider: 'wikdict-immediate' };
  }
  const parts = data ? compoundParts(data, lemma || surface) : null;
  if (parts && parts.length > 1) {
    const glosses = parts.map(part => dictionaryHit(core, part));
    if (glosses.every(Boolean)) return { ru: glosses.join(' + '), provider: 'compound' };
  }
  return { ru: '', provider: 'missing-local' };
}

// Имя собственное по-немецки. Правило испанского слоя — «заглавная посреди
// предложения» — здесь записало бы в имена весь словарь: с заглавной пишется
// каждое существительное. Поэтому имя — это либо слово, которое Викисловарь
// знает только как имя, фамилию или топоним (пометка NAME в частотном файле),
// либо слово с заглавной, которого не знает ни список, ни словарь, ни разбор
// на части.
export function looksProper(core, data, el, paragraph) {
  const shown = String(el?.textContent || el?.dataset?.word || '').trim();
  if (!data || !startsUpper(shown)) return false;
  const word = normalize(shown);
  const lemma = lemmaFromData(data, shown, { capitalized: true, sentenceInitial: false });
  if (isName(data, lemma) || isName(data, word)) return true;
  if (sentenceInitial(el, paragraph)) return false;
  if (data.rank.has(lemma) || data.rank.has(word)) return false;
  if (dictionaryHit(core, lemma) || dictionaryHit(core, word)) return false;
  // Составное слово из известных частей — это не имя: Hausmeisterwohnung.
  return !(compoundParts(data, word) || []).length;
}

function paragraphContext(paragraph) {
  return Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))
    .map(wordSurface).filter(Boolean).join(' ');
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

export function saveOccurrence(key, ru, provider = 'context') {
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
  const fn = globalThis.readerApplyGermanVocabularyEstimate;
  if (typeof fn === 'function') await fn();
}

function processScope(scope, { core, data }) {
  const cache = occurrenceCache();
  for (const paragraph of Array.from(scope.querySelectorAll('.reader-paragraph'))) {
    const context = paragraphContext(paragraph);
    for (const el of Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))) {
      if (el.classList.contains('rw-de-proper') || looksProper(core, data, el, paragraph)) {
        el.classList.remove('rw-migaku-unknown');
        el.classList.add('rw-de-proper');
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
      const lemma = lemmaForElement(data, el, paragraph);
      const hit = translationFor(core, data, surface, lemma);
      setGloss(el, hit.ru, hit.provider, key);
    }
  }
}

async function refresh(reason = 'event', force = false) {
  if (currentLang() !== 'de') return false;
  const root = document.getElementById('reader-chapter-text');
  const view = document.getElementById('reader-reading-view');
  if (!root || !view || view.style.display === 'none') return false;
  const before = renderSignature(root);
  if (!force && before && before === lastSignature) return false;
  if (running) { rerun = true; return false; }
  running = true;
  try {
    injectStyles();
    view.classList.add('rd-de-pipeline-v1');
    const [, loaded] = await Promise.all([ensureVocabularyLayer(), loadAssets()]);
    await applyKnowledgeOnce();
    for (const scope of activeScopes(root)) processScope(scope, loaded);
    lastSignature = renderSignature(root);
    try {
      window.dispatchEvent(new CustomEvent('reader:de-pipeline-v1-ready', {
        detail: { reason, signature: lastSignature },
      }));
    } catch {}
    return true;
  } catch (error) {
    console.warn('[de pipeline v1] refresh failed', error?.message || error);
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
  window.addEventListener('reader:de-vocab-ready', () => scheduleRefresh('knowledge', 0, true));
  window.addEventListener('reader:word-state-changed', () => scheduleRefresh('word-state', 0, true));
}

function boot() {
  injectStyles();
  const warm = () => { void Promise.allSettled([ensureVocabularyLayer(), loadAssets()]); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 700 });
  else setTimeout(warm, 120);
  scheduleRefresh('boot', 80, true);
}

if (typeof window !== 'undefined' && !window.__readerDePipelineV1) {
  window.__readerDePipelineV1 = true;
  window.readerGermanRefresh = (reason = 'external', force = true) => scheduleRefresh(reason, 0, force);
  window.readerGermanPipelineV1RefreshNow = refresh;
  window.readerGermanSaveOccurrence = saveOccurrence;
  installEventHooks();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

export { normalize, compactRussian, refresh };
