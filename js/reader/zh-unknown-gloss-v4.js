import { normalizeImportKey } from '../utils.js';

// Chinese Unknown-word gloss v4 — offline-first.
//
// Automatic reading annotations no longer call readerAI/DeepSeek at all.
// Source priority for every confirmed Unknown word:
//   1) a translation explicitly requested through Instant,
//   2) previously cached Russian meaning (including old DeepSeek results),
//   3) local Russian meaning from Reader's bundled lexicons,
// English definitions are used only as hidden lookup keys for the bundled
// EN→RU bridge. English is never rendered in the Chinese reading view.
// Pinyin comes from the bundled dictionary immediately. The full CC-CEDICT
// map is loaded in the background and rescanned without rebuilding the chapter.

const MODE_KEY = 'an2_reader_zh_unknown_gloss_mode_v1';
const CACHE_BASE_KEY = 'an2_reader_zh_unknown_gloss_cache_v1';
const INSTANT_WORD_CACHE_KEY = 'an2_instant_translate_word_cache_v1';
const READER_APP_URL = '../reader-app.js?v=77.42-zh-reader-quality';
const PREFETCH_PAGE_COUNT = 2;

let appPromise = null;
let appModule = null;
let dictionaryWarmPromise = null;
let scanTimer = null;
let rootObserver = null;
let rootObserved = null;
let viewObserver = null;
let viewObserved = null;
const paragraphSourceText = new WeakMap();

const stats = {
  scans: 0,
  annotated: 0,
  pinyinHits: 0,
  russianHits: 0,
  englishFallbackHits: 0,
  missingDictionary: 0,
  skippedKnown: 0,
  skippedPending: 0,
};

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function mode() {
  try { return localStorage.getItem(MODE_KEY) === 'unknown' ? 'unknown' : 'off'; }
  catch { return 'off'; }
}
function enabled() { return mode() === 'unknown'; }

function currentLang() {
  return String(document.getElementById('reader-reading-view')?.dataset?.readerLang || '').toLowerCase();
}

async function canonicalApp() {
  if (appModule) return appModule;
  if (!appPromise) appPromise = import(READER_APP_URL);
  appModule = await appPromise;
  return appModule;
}

function warmOfflineDictionary() {
  if (dictionaryWarmPromise) return dictionaryWarmPromise;
  dictionaryWarmPromise = canonicalApp()
    .then(async app => {
      try { await app?.readerEnsureZhCoreJsonLoaded?.({ rerender: false }); }
      catch (error) { console.warn('[zh offline gloss] CC-CEDICT warmup failed:', error?.message || error); }
      scheduleScan(0);
      return true;
    })
    .catch(error => {
      console.warn('[zh offline gloss] reader module unavailable:', error?.message || error);
      return false;
    });
  return dictionaryWarmPromise;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
  catch { return {}; }
}

function textHash(text) {
  const s = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function normalizeContext(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 260);
}

// Keep the exact key format from v2/v3 so Russian meanings already paid for
// and cached in older builds remain useful after switching to offline mode.
function cacheKey(word, context) {
  return `${normalizeImportKey(word)}|${textHash(normalizeContext(context))}`;
}

function ownCache() { return readJson(scopedKey(CACHE_BASE_KEY)); }
function lexicalCache() { return readJson(scopedKey('an2_reader_lexical_cache_v1')); }
function instantWordCache() { return readJson(INSTANT_WORD_CACHE_KEY); }
function lexicalEntry(word, cache = null) {
  const source = cache || lexicalCache();
  return source[`zh:${normalizeImportKey(word)}`] || null;
}
function instantEntry(word, cache = null) {
  const source = cache || instantWordCache();
  return source[`zh:${String(word || '').trim().toLowerCase()}`] || null;
}

function russianMeaning(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.ru || value.translation_ru || value.russian || value.meaning_ru || value.translation || '').trim();
}

function englishMeaning(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  const raw = value.en || value.english || value.definition || value.definitions || value.gloss || '';
  return Array.isArray(raw) ? raw.join('; ') : String(raw || '').trim();
}

function pinyinReading(data = {}) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.pinyin || value.py || value.pinyin_marked || value.pinyinTone || value.pronunciation || '').trim();
}

function compactGloss(value) {
  let full = String(value || '')
    .replace(/\bCL:[^/;]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!full) return '';
  // CEDICT sources can use semicolons or slash-separated senses. One or two
  // senses are enough for an inline hint. Do not cut a sense by character
  // count: the interlinear renderer wraps it inside its own word block.
  const parts = full.split(/\s*(?:[;；]|\/(?!\s*$))\s*/).map(x => x.trim()).filter(Boolean);
  if (parts.length) full = parts.slice(0, 2).join(' · ');
  return full;
}

function isChineseWord(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'zh'
    && /[㐀-鿿]/.test(String(el.dataset?.word || ''));
}

function knowledgeState(el) {
  if (!el) return '';
  if (el.classList.contains('rw-migaku-unknown')) return 'unknown';
  if (el.classList.contains('rw-migaku-known') || el.classList.contains('rw-known')) return 'known';
  return '';
}

function wrapperFor(el) {
  const parent = el?.parentElement;
  return parent?.classList?.contains('rw-zh-gloss-wrap') ? parent : null;
}

function ensureWrapper(el) {
  if (!isChineseWord(el)) return null;
  let wrap = wrapperFor(el);
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-zh-gloss-wrap rw-zh-fixed-slot';
    wrap.dataset.zhGloss = '1';
    const parent = el.parentNode;
    if (!parent) return null;
    parent.insertBefore(wrap, el);
    wrap.appendChild(el);
  } else {
    wrap.classList.add('rw-zh-fixed-slot');
    wrap.dataset.zhGloss = '1';
  }
  if (!('zhGlossRu' in wrap.dataset)) wrap.dataset.zhGlossRu = '';
  return wrap;
}

function paragraphContext(el) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return String(el?.dataset?.word || '').trim();
  if (paragraphSourceText.has(paragraph)) return paragraphSourceText.get(paragraph) || '';

  let source = '';
  const textRoot = paragraph.querySelector?.('.reader-paragraph-text');
  if (textRoot) {
    try {
      const clone = textRoot.cloneNode(true);
      clone.querySelectorAll?.('rt').forEach(node => node.remove());
      source = String(clone.textContent || '');
    } catch {
      source = String(textRoot.textContent || '');
    }
  } else {
    source = String(paragraph.textContent || '');
  }
  source = normalizeContext(source);
  if (!source) source = String(el?.dataset?.word || '').trim();
  paragraphSourceText.set(paragraph, source);
  return source;
}

function mergeDictionaryEntries(primary = null, core = null) {
  if (!primary && !core) return null;
  const a = core && typeof core === 'object' ? core : {};
  const b = primary && typeof primary === 'object' ? primary : {};
  return {
    ...a,
    ...b,
    pinyin: pinyinReading(b) || pinyinReading(a),
    ru: russianMeaning(b) || russianMeaning(a),
    en: englishMeaning(b) || englishMeaning(a),
  };
}

function localDictionaryHint(word) {
  let primary = null;
  let core = null;
  try { primary = globalThis.readerLookupChineseWord?.(word) || null; } catch {}
  try { core = appModule?.readerLookupChineseJsonEntry?.(word) || null; } catch {}
  return mergeDictionaryEntries(primary, core);
}

function bestHint(word, context, existingPinyin = '', own = null, lexical = null, instant = null) {
  const oldContextHit = (own || ownCache())[cacheKey(word, context)] || null;
  const lexHit = lexicalEntry(word, lexical);
  const instantHit = instantEntry(word, instant);
  const localHit = localDictionaryHint(word);

  const pinyin = pinyinReading(oldContextHit)
    || pinyinReading(lexHit)
    || pinyinReading(localHit)
    || existingPinyin
    || '';

  const ru = russianMeaning(instantHit)
    || russianMeaning(oldContextHit)
    || russianMeaning(lexHit)
    || russianMeaning(localHit)
    || '';

  const en = englishMeaning(localHit)
    || englishMeaning(lexHit)
    || englishMeaning(oldContextHit)
    || '';

  const gloss = ru;
  const source = ru ? 'ru' : '';
  return { pinyin, ru, en, gloss, source, local: localHit };
}

function applyHint(el, own, lexical, instant) {
  if (!isChineseWord(el)) return;
  const word = String(el.dataset.word || '').trim();
  const context = paragraphContext(el) || word;
  const existingRt = String(el.querySelector?.('rt')?.textContent || '').trim();
  const hint = bestHint(word, context, existingRt, own, lexical, instant);
  const wrap = ensureWrapper(el);
  if (!wrap) return;

  // Fill data even while classification is pending. CSS/stability decides when
  // it becomes visible. That prevents a later Unknown classification from
  // needing another network-like enrichment pass.
  if (hint.pinyin) {
    wrap.dataset.zhGlossPinyin = hint.pinyin;
    stats.pinyinHits += 1;
  }
  if (hint.gloss) {
    wrap.dataset.zhGlossRu = compactGloss(hint.gloss);
    wrap.dataset.zhGlossSource = hint.source;
  }

  const state = knowledgeState(el);
  if (state === 'known') {
    stats.skippedKnown += 1;
    return;
  }
  if (state !== 'unknown') {
    stats.skippedPending += 1;
    return;
  }

  if (hint.ru) stats.russianHits += 1;
  else if (hint.en) stats.englishFallbackHits += 1;
  else stats.missingDictionary += 1;
  if (hint.pinyin || hint.gloss) stats.annotated += 1;
}

function isVisibleWord(el) {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const bottom = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
    return rect.bottom >= 0 && rect.top <= bottom;
  } catch { return true; }
}

function scanScope(scope, own, lexical, instant, visibleOnly = false) {
  const words = scope?.querySelectorAll?.('.reader-word[data-lang="zh"][data-word]') || [];
  for (const el of words) {
    if (visibleOnly && !isVisibleWord(el)) continue;
    applyHint(el, own, lexical, instant);
  }
}

function scan() {
  stats.scans += 1;
  syncControl();
  if (!enabled() || currentLang() !== 'zh') return;
  bindObservers();

  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const own = ownCache();
  const lexical = lexicalCache();
  const instant = instantWordCache();
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));

  if (!pages.length) {
    // Scroll mode: only touch what the user can currently see. The scroll/class
    // observers will cheaply fill later text as it becomes relevant.
    scanScope(root, own, lexical, instant, true);
    try { globalThis.readerSyncZhGlossStability?.(); } catch {}
    return;
  }

  let current = pages.findIndex(page => page.classList.contains('rd-page-current'));
  if (current < 0) current = pages.findIndex(page => page.classList.contains('rd-page-show'));
  if (current < 0) current = 0;

  // No request queue exists anymore, so current + two next pages can be filled
  // immediately from RAM/localStorage in one deterministic pass.
  for (let offset = 0; offset <= PREFETCH_PAGE_COUNT; offset++) {
    const page = pages[current + offset];
    if (!page) break;
    scanScope(page, own, lexical, instant, false);
  }
  try { globalThis.readerSyncZhGlossStability?.(); } catch {}
}

function ensureControl() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return null;
  let row = document.getElementById('rd-dp-zh-unknown-gloss-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'rd-dp-zh-unknown-gloss-row';
    row.className = 'rd-dp-row';
    row.style.display = 'none';
    row.innerHTML = `
      <span class="rd-dp-label">Китайский · незнакомые слова</span>
      <div class="rd-dp-pills">
        <button type="button" class="rd-dp-pill rd-zh-gloss-mode" data-mode="off">Обычный текст</button>
        <button type="button" class="rd-dp-pill rd-zh-gloss-mode" data-mode="unknown">Пиньинь + перевод</button>
      </div>`;
    row.querySelectorAll('.rd-zh-gloss-mode').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.mode || 'off'));
    });
    panel.appendChild(row);
  }
  return row;
}

function syncControl() {
  const row = ensureControl();
  const view = document.getElementById('reader-reading-view');
  if (!row || !view) return;
  const isZh = currentLang() === 'zh';
  row.style.display = isZh ? 'flex' : 'none';
  row.querySelectorAll('.rd-zh-gloss-mode').forEach(button => {
    button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
  });
  view.classList.toggle('rd-zh-unknown-gloss', isZh && enabled());
}

async function setMode(next) {
  try { localStorage.setItem(MODE_KEY, next === 'unknown' ? 'unknown' : 'off'); } catch {}
  syncControl();
  if (next === 'unknown') warmOfflineDictionary();
  try { (await canonicalApp()).renderReaderChapter?.(); }
  catch (error) { console.warn('[zh offline gloss] refresh skipped:', error?.message || error); }
  scheduleScan(20);
}

function scheduleScan(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

function applyInstantTranslation(event) {
  const detail = event?.detail || {};
  if (String(detail.lang || '').trim().toLowerCase() !== 'zh') return;
  const ru = compactGloss(detail.ru);
  const keys = new Set([detail.surface, detail.lemma].map(normalizeImportKey).filter(Boolean));
  const root = document.getElementById('reader-chapter-text');
  if (!ru || !keys.size || !root || currentLang() !== 'zh') return;

  for (const el of root.querySelectorAll('.reader-word[data-lang="zh"][data-word]')) {
    if (!isChineseWord(el) || knowledgeState(el) === 'known') continue;
    if (!keys.has(normalizeImportKey(el.dataset.word || ''))) continue;
    const wrap = ensureWrapper(el);
    if (!wrap) continue;
    wrap.dataset.zhGlossRu = ru;
    wrap.dataset.zhGlossSource = 'instant';
    if (knowledgeState(el) === 'unknown') wrap.dataset.zhGlossVisible = '1';
  }
  try { globalThis.readerSyncZhGlossStability?.(); } catch {}
  scheduleScan(20);
}

function bindObservers() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== rootObserved) {
    rootObserver?.disconnect();
    rootObserved = root;
    rootObserver = new MutationObserver(records => {
      const relevant = records.some(record => {
        if (record.type === 'attributes') return true;
        return Array.from(record.addedNodes || []).some(node => node instanceof Element);
      });
      if (relevant) scheduleScan(15);
    });
    rootObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  const view = document.getElementById('reader-reading-view');
  if (view && view !== viewObserved) {
    viewObserver?.disconnect();
    viewObserved = view;
    viewObserver = new MutationObserver(() => { syncControl(); scheduleScan(15); });
    viewObserver.observe(view, { attributes: true, attributeFilter: ['data-reader-lang', 'style', 'class'] });
  }
}

function boot() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  ensureControl();
  syncControl();
  bindObservers();
  if (enabled() && currentLang() === 'zh') warmOfflineDictionary();
  scheduleScan(0);
}

if (typeof window !== 'undefined') {
  window.readerSetZhUnknownGlossMode = setMode;
  window.readerGetZhUnknownGlossMode = mode;
  window.readerPrefetchZhUnknownGloss = () => scheduleScan(0);
  window.readerZhUnknownGlossQueueStats = () => ({
    ...stats,
    offline: true,
    activeWorkers: 0,
    queueLength: 0,
    queuedKeys: 0,
    failedKeys: 0,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', () => { boot(); scheduleScan(20); });
  window.addEventListener('reader:zh-core-ready', () => scheduleScan(0));
  window.addEventListener('reader-instant-word-translation', applyInstantTranslation);
}

export { mode, enabled, compactGloss, cacheKey, knowledgeState };
