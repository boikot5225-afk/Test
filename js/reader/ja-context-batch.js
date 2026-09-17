// Fills the Russian row under Japanese words without waiting for the reader to
// tap each one, the way zh-context-batch.js does for Chinese.
//
// It deliberately does NOT add a server task. The other languages call their own
// `*_context_batch` task, but this repository's functions/index.js has no
// handler for any of them — the deployed readerAI is ahead of the source here.
// Adding a Japanese batch task would mean redeploying from this tree, which
// would drop the Chinese, Spanish, English and French batch handlers that only
// exist in production. So this asks the one task that is provably deployed and
// already speaks Japanese: `reader_word`, which the word card uses and which
// carries a JMdict hint so the model spends its answer on the meaning.
//
// The cost of that choice is one call per word instead of one per paragraph.
// Three things keep it bounded: only Unknown words are asked about, only in the
// paragraphs on screen, and every answer is cached, so a word is paid for once.
//
// Answers land in this module's own cache, not the Reader core's lexical cache.
// The core keeps that one in memory and rewrites the whole object on its next
// save, so a write from out here would be silently dropped. Reading both is
// ja-readable-inline's job.
import { normalizeImportKey } from '../utils.js';

const CACHE_KEY = 'an2_reader_ja_context_gloss_v1';
const CACHE_MAX = 4000;
const MAX_PARALLEL = 3;
// One paragraph's worth of unknown words per pass. A chapter opened at a
// scrolled position can have several paragraphs visible at once, and asking
// about all of them at once is what would make this expensive.
const MAX_PER_PASS = 12;
const CALL_TIMEOUT_MS = 20000;
const RETRY_AFTER_MS = 60000;

let scanTimer = 0;
let inFlight = false;
let observer = null;
let observedRoot = null;
// A word the model declined to translate, or a call that failed: remember it so
// a scroll does not retry it on every frame.
const failed = new Map();

function clean(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'japanese' || raw === 'jp' || raw === 'ja' || raw.startsWith('ja-') ? 'ja' : raw;
}

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function loadCache() {
  try {
    const value = JSON.parse(localStorage.getItem(scopedKey(CACHE_KEY)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function saveCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => new Date(cache[a]?.cachedAt || 0) - new Date(cache[b]?.cachedAt || 0));
    for (const key of keys.slice(0, keys.length - CACHE_MAX)) delete cache[key];
  }
  try { localStorage.setItem(scopedKey(CACHE_KEY), JSON.stringify(cache)); }
  catch (error) { console.warn('[reader ja batch] cache write failed', error?.message || error); }
}

// The same key the Reader core builds, so a word already answered by the word
// card is recognised here and never asked about twice.
function cacheKeyFor(word) {
  const trimmed = String(word || '')
    .normalize('NFC')
    .replace(/^[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】「」『』〔〕・〜～\[\]{}…—\-]+|[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】「」『』〔〕・〜～\[\]{}…—\-]+$/g, '')
    .trim();
  return trimmed ? `ja:${normalizeImportKey(trimmed)}` : '';
}

function firebaseFunctionsClient() {
  for (const candidate of [globalThis.firebase, globalThis.__AN2_FALLBACK_FIREBASE].filter(Boolean)) {
    try {
      const app = typeof candidate.app === 'function' ? candidate.app() : null;
      if (typeof app?.functions === 'function') return candidate;
    } catch {}
  }
  return null;
}

function functionRegion() {
  return clean(globalThis.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1', 40) || 'asia-southeast1';
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readerAI reader_word timeout')), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

// The sentence the word sits in, not the whole paragraph: the model is being
// asked which sense is meant here, and a page of text buries that.
function contextFor(el) {
  const paragraph = el.closest('.reader-paragraph-text');
  const text = clean(paragraph?.textContent || '', 1200);
  if (!text) return '';
  const word = clean(el.dataset.word || el.textContent || '', 40);
  const sentences = text.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean);
  return sentences.find(sentence => sentence.includes(word)) || sentences[0] || text;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  return rect.bottom > -height * 0.5 && rect.top < height * 1.5;
}

function alreadyAnswered(word) {
  const key = cacheKeyFor(word);
  if (!key) return true;
  if (loadCache()[key]?.ru) return true;
  // The word card writes into the core's cache; ja-readable-inline reads that
  // too, so anything already there needs no call.
  try {
    const core = JSON.parse(localStorage.getItem(scopedKey('an2_reader_lexical_cache_v1')) || '{}');
    if (String(core?.[key]?.ru || '').trim()) return true;
  } catch {}
  return false;
}

function pending() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return [];
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll('.reader-word[data-lang="ja"][data-word]')) {
    if (out.length >= MAX_PER_PASS) break;
    // Only what the vocabulary test called Unknown. Before the test has run
    // nothing carries that class and this module stays quiet, which is the
    // right default: asking DeepSeek about every word of a chapter the reader
    // may already know is exactly the bill nobody wants.
    if (!el.classList.contains('rw-migaku-unknown')) continue;
    if (!isVisible(el)) continue;
    const word = clean(el.dataset.word || el.textContent || '', 40);
    if (!word || seen.has(word)) continue;
    const until = failed.get(word);
    if (until && until > Date.now()) continue;
    if (alreadyAnswered(word)) continue;
    seen.add(word);
    out.push({ word, context: contextFor(el) });
  }
  return out;
}

function localHint(word) {
  // The word card sends this so the model does not spend its answer
  // re-deriving the dictionary form; the same courtesy applies here.
  try {
    const lemma = globalThis.readerJapaneseLemmaFor?.(word) || '';
    return lemma && lemma !== word ? { lemma } : null;
  } catch { return null; }
}

async function askFor(item) {
  const firebase = firebaseFunctionsClient();
  if (!firebase?.app) throw new Error('Firebase Functions not ready');
  const fn = firebase.app().functions(functionRegion()).httpsCallable('readerAI');
  const payload = { task: 'reader_word', sourceLang: 'ja', lang: 'ja', word: item.word, surface: item.word, context: item.context };
  const hint = localHint(item.word);
  if (hint) payload.hint = hint;
  const result = await withTimeout(fn(payload), CALL_TIMEOUT_MS);
  const data = result?.data?.data || result?.data || {};
  return clean(data?.ru || data?.translation || data?.meaning || '', 80);
}

async function runPass() {
  if (inFlight || currentLang() !== 'ja') return;
  const items = pending();
  if (!items.length) return;
  inFlight = true;
  try {
    const cache = loadCache();
    let wrote = false;
    for (let start = 0; start < items.length; start += MAX_PARALLEL) {
      const slice = items.slice(start, start + MAX_PARALLEL);
      const answers = await Promise.allSettled(slice.map(askFor));
      answers.forEach((answer, index) => {
        const item = slice[index];
        if (answer.status !== 'fulfilled' || !answer.value) {
          failed.set(item.word, Date.now() + RETRY_AFTER_MS);
          if (answer.status === 'rejected') {
            console.warn('[reader ja batch]', item.word, answer.reason?.message || answer.reason);
          }
          return;
        }
        const key = cacheKeyFor(item.word);
        if (!key) return;
        cache[key] = { ru: answer.value, lang: 'ja', cachedAt: new Date().toISOString() };
        wrote = true;
      });
      // A failing backend should stop the pass, not walk the whole paragraph
      // producing the same error a dozen times.
      if (answers.every(answer => answer.status === 'rejected')) break;
    }
    if (wrote) {
      saveCache(cache);
      try { globalThis.readerSyncJaReadableInline?.(); } catch {}
    }
  } finally {
    inFlight = false;
  }
}

function schedule(delay = 400) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => { runPass().catch(() => {}); }, Math.max(0, delay));
}

function bindObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) { setTimeout(bindObserver, 250); return; }
  if (observer && observedRoot === root) return;
  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(() => {
    if (currentLang() === 'ja') schedule(500);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function install() {
  if (typeof document === 'undefined') return;
  bindObserver();
  schedule(900);
}

if (typeof window !== 'undefined') {
  globalThis.readerJaContextBatchNow = () => runPass();
  globalThis.readerJaContextGlossCache = loadCache;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', install);
  window.addEventListener('an2:languagechange', () => schedule(600));
  window.addEventListener('reader:pagechange', () => schedule(500));
  window.addEventListener('scroll', () => schedule(700), { passive: true });
  window.addEventListener('reader:ja-vocab-ready', () => schedule(600));
}

export { runPass, cacheKeyFor, loadCache };
