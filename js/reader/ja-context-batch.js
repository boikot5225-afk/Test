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
//
// The same call also settles the reading. JMdict gives a word one reading, but
// a word can have several and the sentence decides which: 朝 is あさ "morning"
// here and ちょう "dynasty" elsewhere. The model is handed the reading already
// on screen and keeps it unless the context contradicts it, so an ordinary word
// is never re-read on a whim; when it does disagree, the furigana above the
// word is repainted. Those verdicts are keyed by sentence, not by word, because
// that is the whole point of asking.
import { normalizeImportKey } from '../utils.js';
import { splitJapaneseRuby } from './ja-dict.js';

const CACHE_KEY = 'an2_reader_ja_context_gloss_v1';
// Readings are kept per occurrence, not per word: 今日 is きょう in ordinary
// prose and こんにち in 今日では, and the whole point is telling those apart.
// The meaning cache above stays keyed by word — one equivalent per word is
// what the row under it shows.
const READING_CACHE_KEY = 'an2_reader_ja_context_reading_v1';
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

function loadReadingCache() {
  try {
    const value = JSON.parse(localStorage.getItem(scopedKey(READING_CACHE_KEY)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function saveReadingCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => new Date(cache[a]?.cachedAt || 0) - new Date(cache[b]?.cachedAt || 0));
    for (const key of keys.slice(0, keys.length - CACHE_MAX)) delete cache[key];
  }
  try { localStorage.setItem(scopedKey(READING_CACHE_KEY), JSON.stringify(cache)); }
  catch (error) { console.warn('[reader ja batch] reading cache write failed', error?.message || error); }
}

function hash(value) {
  let h = 5381;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// A reading belongs to this word in this sentence, so the sentence is part of
// the key. The same word elsewhere asks again and may get a different answer.
function readingKeyFor(word, context) {
  const base = cacheKeyFor(word);
  return base ? `${base}|${hash(clean(context, 400))}` : '';
}

function isKanaOnly(value) {
  return /^[\u3041-\u3096\u30a1-\u30fa\u30fc\u3005]+$/.test(String(value || ''));
}

// What the scaffold currently says: the ruby text plus whatever kana trails it,
// which together spell the surface form. Sent to the model as the reading to
// keep unless the context actually contradicts it, so an ordinary word is not
// re-read on a whim.
function renderedReading(el) {
  const ruby = el?.querySelector?.('ruby');
  if (!ruby) return '';
  const rt = ruby.querySelector('rt');
  if (!rt) return '';
  let tail = '';
  for (let node = ruby.nextSibling; node; node = node.nextSibling) tail += node.textContent || '';
  return clean(rt.textContent, 40) + clean(tail, 40);
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

// The paragraph as written, without the furigana printed above it. textContent
// includes every <rt>, so reading it raw gave the model 朝ちょう、六時ろくじ and
// — worse — made the context change the moment this module repainted a reading,
// which moved the cache key and asked about the same word again on every pass.
function plainText(node) {
  let out = '';
  for (const child of node?.childNodes || []) {
    if (child.nodeType === 3) { out += child.nodeValue || ''; continue; }
    if (child.nodeType !== 1) continue;
    if (child.tagName === 'RT' || child.tagName === 'RP') continue;
    out += plainText(child);
  }
  return out;
}

// The sentence the word sits in, not the whole paragraph: the model is being
// asked which sense is meant here, and a page of text buries that.
function contextFor(el) {
  const paragraph = el.closest('.reader-paragraph-text');
  const text = clean(plainText(paragraph), 1200);
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
  const readingCache = loadReadingCache();
  for (const el of root.querySelectorAll('.reader-word[data-lang="ja"][data-word]')) {
    if (out.length >= MAX_PER_PASS) break;
    // Only what the vocabulary test called Unknown. Before the test has run
    // nothing carries that class and this module stays quiet, which is the
    // right default: asking DeepSeek about every word of a chapter the reader
    // may already know is exactly the bill nobody wants.
    if (!el.classList.contains('rw-migaku-unknown')) continue;
    if (!isVisible(el)) continue;
    const word = clean(el.dataset.word || el.textContent || '', 40);
    if (!word) continue;
    const context = contextFor(el);
    const readingKey = readingKeyFor(word, context);
    // Two reasons to ask, and a word can need only one of them: a meaning it
    // has never had, or a reading for this sentence. The key for the second
    // includes the sentence, so the same word in a new one is asked again.
    const needsMeaning = !alreadyAnswered(word);
    const rendered = renderedReading(el);
    const needsReading = !!rendered && !!readingKey && !readingCache[readingKey];
    if (!needsMeaning && !needsReading) continue;
    const dedupe = `${word}|${needsReading ? readingKey : ''}`;
    if (seen.has(dedupe)) continue;
    const until = failed.get(dedupe);
    if (until && until > Date.now()) continue;
    seen.add(dedupe);
    out.push({ word, context, readingKey, rendered, dedupe });
  }
  return out;
}

function localHint(word, reading) {
  // The word card sends this so the model does not spend its answer
  // re-deriving the dictionary form; the same courtesy applies here. The
  // reading goes with it because the prompt keeps a supplied one unless the
  // context clearly contradicts it — which is exactly the bar a re-reading
  // should clear.
  let lemma = '';
  try { lemma = globalThis.readerJapaneseLemmaFor?.(word) || ''; } catch {}
  if (!lemma && !reading) return null;
  const hint = {};
  if (lemma && lemma !== word) hint.lemma = lemma;
  if (reading) hint.reading = reading;
  return Object.keys(hint).length ? hint : null;
}

async function askFor(item) {
  const firebase = firebaseFunctionsClient();
  if (!firebase?.app) throw new Error('Firebase Functions not ready');
  const fn = firebase.app().functions(functionRegion()).httpsCallable('readerAI');
  const payload = { task: 'reader_word', sourceLang: 'ja', lang: 'ja', word: item.word, surface: item.word, context: item.context };
  const hint = localHint(item.word, item.rendered);
  if (hint) payload.hint = hint;
  const result = await withTimeout(fn(payload), CALL_TIMEOUT_MS);
  const data = result?.data?.data || result?.data || {};
  const reading = clean(data?.reading || data?.kana || data?.furigana || data?.yomi || '', 40);
  return {
    ru: clean(data?.ru || data?.translation || data?.meaning || '', 80),
    // Anything that is not plain kana is not a reading — an answer that came
    // back with kanji in it would paint the word over itself.
    reading: isKanaOnly(reading) ? reading : '',
  };
}

async function runPass() {
  if (inFlight || currentLang() !== 'ja') return;
  const items = pending();
  if (!items.length) return;
  inFlight = true;
  try {
    const cache = loadCache();
    const readings = loadReadingCache();
    let wroteMeaning = false;
    let wroteReading = false;
    for (let start = 0; start < items.length; start += MAX_PARALLEL) {
      const slice = items.slice(start, start + MAX_PARALLEL);
      const answers = await Promise.allSettled(slice.map(askFor));
      answers.forEach((answer, index) => {
        const item = slice[index];
        const value = answer.status === 'fulfilled' ? answer.value : null;
        if (!value || (!value.ru && !value.reading)) {
          failed.set(item.dedupe, Date.now() + RETRY_AFTER_MS);
          if (answer.status === 'rejected') {
            console.warn('[reader ja batch]', item.word, answer.reason?.message || answer.reason);
          }
          return;
        }
        const key = cacheKeyFor(item.word);
        if (value.ru && key) {
          cache[key] = { ru: value.ru, lang: 'ja', cachedAt: new Date().toISOString() };
          wroteMeaning = true;
        }
        if (item.readingKey && value.reading) {
          // Store the verdict even when it matches what is already printed:
          // "this sentence was checked" is worth remembering, and it stops the
          // word being asked about again on every scroll.
          readings[item.readingKey] = { reading: value.reading, word: item.word, cachedAt: new Date().toISOString() };
          wroteReading = true;
        }
      });
      // A failing backend should stop the pass, not walk the whole paragraph
      // producing the same error a dozen times.
      if (answers.every(answer => answer.status === 'rejected')) break;
    }
    if (wroteMeaning) saveCache(cache);
    if (wroteReading) saveReadingCache(readings);
    if (wroteMeaning || wroteReading) {
      if (wroteReading) applyContextReadings();
      try { globalThis.readerSyncJaReadableInline?.(); } catch {}
    }
  } finally {
    inFlight = false;
  }
}

// Repaint the furigana where the model read the word differently from the
// dictionary. The core owns the ruby scaffold and rebuilds it on every render,
// so this runs again after each one rather than trying to hold the change.
function applyContextReadings() {
  if (currentLang() !== 'ja') return 0;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return 0;
  const readings = loadReadingCache();
  let changed = 0;
  for (const el of root.querySelectorAll('.reader-word[data-lang="ja"][data-word]')) {
    const ruby = el.querySelector('ruby');
    const rt = ruby?.querySelector('rt');
    if (!rt) continue;
    const word = clean(el.dataset.word || el.textContent || '', 40);
    const key = readingKeyFor(word, contextFor(el));
    const wanted = key ? String(readings[key]?.reading || '') : '';
    if (!wanted || wanted === renderedReading(el)) continue;
    // The scaffold covers the kanji head only — 起きました shows お over 起 and
    // leaves きました beside it — so the whole-word reading has to be split the
    // same way before it can replace what is there.
    const split = splitJapaneseRuby(word, wanted);
    if (!split?.ruby || rt.textContent === split.ruby) continue;
    rt.textContent = split.ruby;
    el.dataset.jaContextReading = wanted;
    changed++;
  }
  return changed;
}

function schedule(delay = 400) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => { runPass().catch(() => {}); }, Math.max(0, delay));
}

function bindObserver() {
  if (typeof MutationObserver === 'undefined') return;
  // Only while a Japanese book is open. The callback returned immediately for
  // other languages, but the observer itself is not free: it was watching every
  // class change across a 1800-word French chapter and charging that to the
  // frame the reader is waiting on. Nothing here has anything to say about
  // French, so it should not be listening to it.
  if (currentLang() !== 'ja') {
    observer?.disconnect();
    observer = null;
    observedRoot = null;
    return;
  }
  const root = document.getElementById('reader-chapter-text');
  if (!root) { setTimeout(bindObserver, 250); return; }
  if (observer && observedRoot === root) return;
  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(records => {
    if (currentLang() !== 'ja') return;
    // Ignore the rt rewrites this module just made, or applying them would
    // wake the observer that applies them.
    const ours = records.every(r => r.type === 'characterData' && r.target?.parentElement?.tagName === 'RT');
    if (ours) return;
    // A render rebuilds the ruby from the dictionary, so the context readings
    // have to go back on immediately rather than after the network debounce —
    // otherwise the word shows its dictionary reading for a beat first.
    applyContextReadings();
    schedule(500);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function install() {
  if (typeof document === 'undefined') return;
  bindObserver();
  applyContextReadings();
  schedule(900);
}

if (typeof window !== 'undefined') {
  globalThis.readerJaContextBatchNow = () => runPass();
  globalThis.readerJaApplyContextReadings = applyContextReadings;
  globalThis.readerJaContextGlossCache = loadCache;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', install);
  window.addEventListener('an2:languagechange', () => { bindObserver(); schedule(600); });
  window.addEventListener('reader:pagechange', () => { applyContextReadings(); schedule(500); });
  window.addEventListener('scroll', () => schedule(700), { passive: true });
  window.addEventListener('reader:ja-vocab-ready', () => schedule(600));
}

export { runPass, cacheKeyFor, loadCache, applyContextReadings, loadReadingCache, readingKeyFor };
