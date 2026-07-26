Warning: truncated output (original token count: 68512)
Total output lines: 5311

// ════════════════════════════════════════════════
// reader-app.js — читалка: оркестрация (Phase 2 extraction from app.js)
// ════════════════════════════════════════════════

import { sb, sbUser, sbGetCurrentUserId, isSupabaseReady, fbSaveWordState, fbLoadWordState,
         LONG_REQUEST_TIMEOUT_MS, initSupabase } from './supabase.js';
import { isGuest, VERBS, NOUNS, setCurrentProfile } from './state.js';
import { speak, stopSpeak, getTtsRate, setTtsRate, getTtsVoiceEngine, setTtsVoiceEngine, getTtsVoice, setTtsVoice, KOKORO_VOICES, prefetchSpeech } from './tts.js?v=68.43-zh-tts-cache-bust';
import { showToast, showLoading, hideLoading, normalizeImportKey } from './utils.js';
import { createReaderAudio } from './reader/audio.js?v=3';
import { createReaderNavigation } from './reader/navigation.js?v=1';
import { readFileAsArrayBuffer as epubReadFileAsArrayBuffer, zipU16 as epubZipU16,
         zipU32 as epubZipU32, inflateZipData as epubInflateZipData,
         readZipEntries as epubReadZipEntries, resolveEpubPath as epubResolvePath,
         cleanEpubText as epubCleanText, looksLikeEpubBoilerplate as epubLooksLikeBoilerplate,
         htmlToPlainText as epubHtmlToPlainText, htmlToParagraphs as epubHtmlToParagraphs,
         htmlToMixedItems as epubHtmlToMixedItems } from './reader/epub.js?v=3';
import { imgStorePut, imgStoreGet, imgStoreDeleteBook } from './reader/image-store.js?v=1';
import { audioStorePut, audioStoreGet, audioStoreDelete } from './reader/audio-store.js?v=1';
import { libraryIdbPut, libraryIdbGet } from './reader/library-idb-store.js?v=1';
import { wordStateIdbPut, wordStateIdbGet } from './reader/word-state-idb-store.js?v=1';
import { lexicalCacheIdbPut, lexicalCacheIdbGet } from './reader/lexical-cache-idb-store.js?v=1';
import { createReaderWordPanel } from './reader/word-panel.js?v=5';
import { createReaderWordLookup } from './reader/word-lookup.js?v=1';
import { createReaderWordState } from './reader/word-state.js?v=4';
import { createReaderLibraryStore } from './reader/library-store.js?v=5';
import { createReaderDisplay } from './reader/display.js?v=5';
import { createReaderTimeTracker } from './reader/reading-time.js?v=2-per-paragraph-timer-guard';
import { createReaderPinyinControls } from './reader/pinyin.js?v=1';
import { createReaderChapterRenderer } from './reader/chapter-render.js?v=8';
import { createReaderPagesMode } from './reader/pages-mode.js?v=3';
import { translationValueText } from './reader/semantic-content.js?v=6';
import { splitTextToChapters as readerImportSplitTextToChapters,
         splitSongToChapters as readerImportSplitSongToChapters } from './reader/import-parsers.js?v=1';

// ════════════════════════════════════════════════
// READER v51 — lexical cards + cloud library + sentence analysis,
// words keep correct POS, translations can be hidden, books can sync between devices.
// ════════════════════════════════════════════════

const READER_BOOKS_KEY = 'an2_reader_books_v1';

// ── Трекер времени чтения ─────────────────────────────
const READER_TIME_KEY = 'an2_reader_time_v1';
const readerTimeTracker = createReaderTimeTracker({ key: READER_TIME_KEY });

function readerTimeToday() { return readerTimeTracker.today(); }
function readerTimeAddSeconds(seconds) { return readerTimeTracker.addSeconds(seconds); }
function readerTimeParagraphId() {
  const book = readerCurrentBook?.();
  if (!book) return null;
  return `${book.id || ''}:${book.currentChapter || 0}:${book.currentParagraph || 0}`;
}
function readerTimeParagraphOpen() { return readerTimeTracker.openParagraph(readerTimeParagraphId()); }
function readerTimeParagraphClose() { return readerTimeTracker.closeParagraph(); }

const READER_OWNER_KEY = 'an2_reader_active_owner_v1';
let readerBooks = [];
let readerCurrentBookId = null;
let readerSelectedWord = null;
let readerSelectedParagraphIndex = 0;
let readerSpeechActive = false;
let readerAutoPlayActive = false;
let readerAutoPlayAbort = false;
let readerPendingImportChapters = null;
let readerPendingImportSource = 'manual_text';
let readerPendingImportBookId = null;
let readerPendingImportHasAudio = false;
let readerPendingImportTimestamps = null; // per-paragraph {start,end} seconds in the original recording
let readerOriginalAudioUrl = null; // objectURL for the currently open book's original recording
let readerOriginalAudioBookId = null;
const readerEpubImgCache = new Map(); // key → blob URL (session-scoped, avoids repeated IndexedDB reads)
let readerActiveOwnerId = null;
let readerWordStateCache = null;

function readerSafeOwnerKey(owner) {
  return String(owner || 'anon').replace(/[.#$\[\]/\s:]+/g, '_').slice(0, 96) || 'anon';
}

function readerCurrentOwnerId() {
  if (readerActiveOwnerId) return readerActiveOwnerId;
  const uid = (typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null) || sbUser?.uid || sbUser?.id || null;
  if (uid) return 'u_' + readerSafeOwnerKey(uid);
  if (isGuest || localStorage.getItem('an2_guest') === '1') return 'guest';
  try { return localStorage.getItem(READER_OWNER_KEY) || 'anon'; }
  catch { return 'anon'; }
}

function readerScopedKey(base) {
  return `${base}::${readerCurrentOwnerId()}`;
}

function readerBooksStorageKey() { return readerScopedKey(READER_BOOKS_KEY); }
function readerScopedStorageKey(base) { return readerScopedKey(base); }
try {
  window.an2ReaderStorageKey = readerScopedStorageKey;
  window.an2ReaderOwnerId = readerCurrentOwnerId;
} catch {}

function profileNameStorageKey(user = null) {
  const uid = user?.uid || user?.id || (typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null) || sbUser?.uid || sbUser?.id || null;
  return uid ? `an2_profile_name::u_${readerSafeOwnerKey(uid)}` : 'an2_profile_name::anon';
}
function getCachedProfileName(user = null) {
  try {
    return localStorage.getItem(profileNameStorageKey(user)) || '';
  } catch { return ''; }
}
function setCachedProfileName(name, user = null) {
  const clean = String(name || '').trim();
  if (!clean || clean === 'user') return;
  try { localStorage.setItem(profileNameStorageKey(user), clean); } catch {}
  try { window.an2CurrentProfileName = clean; } catch {}
}
function setActiveProfileName(name, user = null) {
  const profile = String(name || '').trim() || 'user';
  setCurrentProfile(profile);
  setCachedProfileName(profile, user);
  return profile;
}

function readerSwitchStorageOwner(owner = null) {
  const uid = owner || (typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null) || sbUser?.uid || sbUser?.id || (isGuest ? 'guest' : 'anon');
  const next = uid === 'guest' || uid === 'anon' ? uid : 'u_' + readerSafeOwnerKey(uid);
  if (readerActiveOwnerId === next) return;
  readerActiveOwnerId = next;
  try { localStorage.setItem(READER_OWNER_KEY, next); } catch {}
  readerBooks = [];
  readerCurrentBookId = null;
  readerWordStateCache = null;
  try { readerLexicalCache = null; readerLexicalCacheOwnerId = null; } catch {}
  readerCloudLoadedOnce = false;
}

window.an2ImportLegacyReaderBooks = function an2ImportLegacyReaderBooks() {
  try {
    // v68.17: legacy means the old unscoped key, not the current user's scoped key.
    const raw = localStorage.getItem(READER_BOOKS_KEY);
    if (!raw) return { ok: false, message: 'Старой общей библиотеки в localStorage нет.' };
    const imported = JSON.parse(raw) || [];
    const current = loadReaderBooks();
    readerBooks = readerDedupeBooks([...(Array.isArray(current) ? current : []), ...(Array.isArray(imported) ? imported : [])]);
    localStorage.setItem(readerBooksStorageKey(), JSON.stringify(readerBooks));
    showToast('📚 Старая локальная библиотека перенесена в текущий аккаунт');
    renderReaderScreen();
    return { ok: true, owner: readerCurrentOwnerId(), count: readerBooks.length };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
};

const READER_HIDE_TRANSLATIONS_KEY = 'an2_reader_hide_translations_v1';
let readerTranslationsHidden = localStorage.getItem(READER_HIDE_TRANSLATIONS_KEY) !== '0';

// ── Настройки отображения текста читалки ──────────────────────────────────
const READER_DISPLAY_KEY = 'an2_reader_display_v1';
const READER_ZH_PINYIN_MODE_KEY = 'an2_reader_zh_pinyin_mode_v1';
const readerDisplay = createReaderDisplay({ key: READER_DISPLAY_KEY });

function readerLoadDisplay() { return readerDisplay.load(); }
function readerSaveDisplay(settings) { return readerDisplay.save(settings); }
function readerApplyDisplay(settings) { return readerDisplay.apply(settings); }
function readerInitDisplay() { return readerDisplay.init(); }
function readerSyncVoiceEnginePanel() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return;
  const engine = getTtsVoiceEngine();
  panel.querySelectorAll('.rd-dp-voice').forEach(btn => btn.classList.toggle('rd-dp-active', btn.dataset.voice === engine));
  readerSyncVoicePicker();
}
// The available Kokoro voices differ per language, so this row is only
// shown (and only ever rendered) for the language actually being read —
// French has just one Kokoro voice, so there's nothing worth picking there.
function readerSyncVoicePicker() {
  const row = document.getElementById('rd-dp-voice-picker-row');
  const wrap = document.getElementById('rd-dp-voice-picker');
  if (!row || !wrap) return;
  const lang = readerCurrentLang();
  const options = KOKORO_VOICES[lang] || [];
  if (options.length < 2) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  const current = getTtsVoice(lang) || options[0].id;
  wrap.innerHTML = options.map(o => `<button class="rd-dp-pill${current === o.id ? ' rd-dp-active' : ''}" onclick="rdSetVoice('${lang}','${o.id}',this)">${o.label}</button>`).join('');
}
function readerToggleDisplayPanel() {
  const open = readerDisplay.togglePanel();
  if (open) {
    readerSyncVoiceEnginePanel();
    readerSyncPageAnimationPanel();
  }
  return open;
}
function readerCloseDisplayPanel() { return readerDisplay.closePanel(); }
function rdSetFont(name, element) { return readerDisplay.setFont(name, element); }
function rdSetSize(input) { return readerDisplay.setSize(input); }
function rdSetLH(input) { return readerDisplay.setLineHeight(input); }
function rdSetTheme(theme, element) { return readerDisplay.setTheme(theme, element); }
function readerSyncPageAnimationPanel() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return;
  const current = readerPagesMode.getAnimation();
  panel.querySelectorAll('.rd-dp-page-animation').forEach((button) => {
    button.classList.toggle('rd-dp-active', button.dataset.animation === current);
  });
}
function rdSetPageAnimation(animation, element) {
  const selected = readerPagesMode.setAnimation(animation);
  element?.closest('.rd-dp-row')?.querySelectorAll('.rd-dp-page-animation').forEach((button) => {
    button.classList.toggle('rd-dp-active', button.dataset.animation === selected);
  });
  const labels = {
    flip: 'лист', slide: 'сдвиг', stack: 'стопка', fade: 'плавно', none: 'без анимации',
  };
  showToast(readerPagesMode.isEnabled()
    ? `📖 Листание: ${labels[selected]}`
    : `📖 Выбрано: ${labels[selected]}. Эффект работает в режиме страниц`);
  return selected;
}
function rdSetVoiceEngine(engine, element) {
  setTtsVoiceEngine(engine);
  element?.closest('.rd-dp-row')?.querySelectorAll('.rd-dp-voice').forEach(btn => btn.classList.remove('rd-dp-active'));
  element?.classList.add('rd-dp-active');
  showToast(engine === 'gpt4o' ? '🎙 Голос: GPT-4o (лучше, ~4x дороже)' : '🎙 Голос: Kokoro (по умолчанию)');
}
function rdSetVoice(lang, voiceId, element) {
  setTtsVoice(lang, voiceId);
  element?.closest('.rd-dp-pills')?.querySelectorAll('.rd-dp-pill').forEach(btn => btn.classList.remove('rd-dp-active'));
  element?.classList.add('rd-dp-active');
}

const readerPinyinControls = createReaderPinyinControls({
  storageKey: READER_ZH_PINYIN_MODE_KEY,
  getCurrentLang: readerCurrentLang,
  canonicalLang: readerCanonicalLang,
  rerender: renderReaderChapter,
  toast: showToast,
});

function readerZhPinyinMode() { return readerPinyinControls.mode(); }
function readerZhPinyinModeLabel(mode = readerZhPinyinMode()) { return readerPinyinControls.label(mode); }
function readerZhPinyinModeTitle(mode = readerZhPinyinMode()) { return readerPinyinControls.title(mode); }
function readerUpdatePinyinButton(lang = readerCurrentLang()) { return readerPinyinControls.update(lang); }
function readerCycleZhPinyinMode() {
  const result = readerPinyinControls.cycle();
  readerApplyDisplay(readerLoadDisplay());
  return result;
}

let readerCloudLoadedOnce = false;
let readerCloudSaveTimer = null;
let readerCloudSaving = false;

function readerBookParagraphCount(book = {}) {
  return (book.chapters || []).reduce((n, ch) => n + ((ch.paragraphs || []).length), 0);
}

function readerBookCharCount(book = {}) {
  return (book.chapters || []).reduce((n, ch) => n + ((ch.paragraphs || []).join('').replace(/\s+/g, '').length), 0);
}

function readerBookProgressScore(book = {}) {
  const chIndex = Math.max(0, book.currentChapter || 0);
  const pIndex = Math.max(0, book.currentParagraph || 0);
  const before = (book.chapters || []).slice(0, chIndex).reduce((n, ch) => n + ((ch.paragraphs || []).length), 0);
  return before + pIndex;
}

function readerHashString(str = '') {
  let h = 2166136261;
  const text = String(str || '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function readerBookImportKey(book = {}) {
  if (book.importKey) return String(book.importKey);
  const chapters = book.chapters || [];
  const title = normalizeImportKey(book.title || '');
  const author = normalizeImportKey(book.author || '');
  const lang = readerCanonicalLang(book.lang || book.sourceLang || 'fr');
  const paraCount = readerBookParagraphCount(book);
  const charCount = readerBookCharCount(book);
  const first = (chapters[0]?.paragraphs || []).slice(0, 2).join(' ').slice(0, 300);
  const lastCh = chapters[chapters.length - 1] || {};
  const last = (lastCh.paragraphs || []).slice(-2).join(' ').slice(-300);
  return [lang, title, author, chapters.length, paraCount, charCount, readerHashString(first + '|' + last)].join('|');
}

function readerMergeBookDuplicates(a = {}, b = {}) {
  const keep = readerBookProgressScore(b) > readerBookProgressScore(a) ? { ...b } : { ...a };
  const other = keep.id === b.id ? a : b;
  keep.id = keep.id || other.id || readerId();
  keep.importKey = readerBookImportKey(keep);
  keep.readerTranslations = { ...(other.readerTranslations || {}), ...(keep.readerTranslations || {}) };
  keep.readerAnalyses = { ...(other.readerAnalyses || {}), ...(keep.readerAnalyses || {}) };
  keep.comprehension = { ...(other.comprehension || {}), ...(keep.comprehension || {}) };
  keep.createdAt = [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || keep.createdAt || new Date().toISOString();
  keep.updatedAt = [a.updatedAt, b.updatedAt].filter(Boolean).sort().pop() || keep.updatedAt || new Date().toISOString();
  return keep;
}

function readerDedupeBooks(list = []) {
  const byKey = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || !Array.isArray(raw.chapters)) continue;
    const book = { ...raw, importKey: readerBookImportKey(raw) };
    const key = book.importKey;
    byKey.set(key, byKey.has(key) ? readerMergeBookDuplicates(byKey.get(key), book) : book);
  }
  return [...byKey.values()].sort((a,b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

window.an2ReaderCleanupDuplicates = async function an2ReaderCleanupDuplicates() {
  loadReaderBooks();
  const before = readerBooks.length;
  readerBooks = readerDedupeBooks(readerBooks);
  const removed = before - readerBooks.length;
  localStorage.setItem(readerBooksStorageKey(), JSON.stringify(readerBooks));
  if (removed > 0) {
    showToast(`🧹 Убрано дублей: ${removed}`);
    try { await saveReaderBooksToCloud({ replaceAll: true }); } catch(e) { console.warn('[reader cleanup] cloud cleanup skipped:', e?.message || e); }
  } else showToast('Дублей не нашёл');
  renderReaderScreen();
  return { before, after: readerBooks.length, removed, owner: readerCurrentOwnerId() };
};


const READER_LEXICAL_CACHE_KEY = 'an2_reader_lexical_cache_v1';
// This cache had no size cap at all and no durable backup — it grew forever
// (1MB+ observed in the wild) purely in localStorage, unlike the book library
// and word-state which already got an IndexedDB durable copy + a bound. Same
// fix here: cap the count and evict the oldest entries by cachedAt, and keep
// a durable IndexedDB copy so a localStorage quota failure can't lose it.
const READER_LEXICAL_CACHE_MAX = 4000;
let readerLexicalCache = null;
let readerLexicalCacheOwnerId = null;
const readerLexicalInFlight = new Map();

function readerLexicalCacheStorageKey() { return readerScopedKey(READER_LEXICAL_CACHE_KEY); }

function pruneReaderLexicalCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= READER_LEXICAL_CACHE_MAX) return false;
  keys.sort((a, b) => new Date(cache[a]?.cachedAt || 0) - new Date(cache[b]?.cachedAt || 0));
  for (const k of keys.slice(0, keys.length - READER_LEXICAL_CACHE_MAX)) delete cache[k];
  return true;
}

function loadReaderLexicalCache() {
  const owner = readerCurrentOwnerId();
  if (readerLexicalCache && readerLexicalCacheOwnerId === owner) return readerLexicalCache;
  try { readerLexicalCache = JSON.parse(localStorage.getItem(readerLexicalCacheStorageKey()) || '{}') || {}; }
  catch { readerLexicalCache = {}; }
  readerLexicalCacheOwnerId = owner;
  return readerLexicalCache;
}

function saveReaderLexicalCache() {
  const cache = loadReaderLexicalCache();
  pruneReaderLexicalCache(cache);
  let localOk = true;
  try { localStorage.setItem(readerLexicalCacheStorageKey(), JSON.stringify(cache)); }
  catch (e) { localOk = false; console.warn('[reader] lexical cache localStorage write failed (IndexedDB still holds it)', e); }
  lexicalCacheIdbPut(readerLexicalCacheStorageKey(), cache).catch(e => {
    if (!localOk) console.warn('[reader] lexical cache IndexedDB save also failed — this lookup is not durably saved', e);
  });
}

async function hydrateReaderLexicalCacheFromIndexedDB() {
  let fromIdb;
  try { fromIdb = await lexicalCacheIdbGet(readerLexicalCacheStorageKey()); }
  catch { return false; }
  if (!fromIdb || typeof fromIdb !== 'object') return false;
  const current = loadReaderLexicalCache();
  let changed = false;
  for (const [k, v] of Object.entries(fromIdb)) {
    const existing = current[k];
    if (!existing || new Date(v?.cachedAt || 0) > new Date(existing?.cachedAt || 0)) { current[k] = v; changed = true; }
  }
  if (!changed) return false;
  pruneReaderLexicalCache(current);
  try { localStorage.setItem(readerLexicalCacheStorageKey(), JSON.stringify(current)); } catch (_) {}
  return true;
}

window.an2ImportLegacyReaderLexicalCache = function an2ImportLegacyReaderLexicalCache() {
  try {
    const raw = localStorage.getItem(READER_LEXICAL_CACHE_KEY);
    if (!raw) return { ok: false, message: 'Старого общего кэша слов нет.' };
    const legacy = JSON.parse(raw) || {};
    const current = loadReaderLexicalCache();
    readerLexicalCache = { ...legacy, ...current };
    readerLexicalCacheOwnerId = readerCurrentOwnerId();
    saveReaderLexicalCache();
    showToast('中文 Старый кэш слов перенесён в текущий аккаунт');
    return { ok: true, owner: readerCurrentOwnerId(), count: Object.keys(readerLexicalCache).length };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
};

function readerLexicalCacheKey(word, lang = null) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  return `${l}:${normalizeImportKey(readerNormalizeWord(word, l))}`;
}

function readerGetCachedLexical(word, lang = null) {
  return loadReaderLexicalCache()[readerLexicalCacheKey(word, lang)] || null;
}

function readerPutCachedLexical(word, data, lang = null) {
  if (!word || !data) return;
  const cache = loadReaderLexicalCache();
  const l = readerCanonicalLang(lang || data.lang || readerCurrentLang());
  cache[readerLexicalCacheKey(word, l)] = { ...data, lang: l, cachedAt: new Date().toISOString() };
  saveReaderLexicalCache();
}

function applyReaderTranslationVisibility() {
  document.body.classList.toggle('reader-hide-translation', !!readerTranslationsHidden);
  document.querySelectorAll('.reader-toggle-translations-btn').forEach(btn => {
    btn.textContent = readerTranslationsHidden ? '👁️ показать помощь' : '🙈 скрыть помощь';
  });
}

function toggleReaderTranslations() {
  readerTranslationsHidden = !readerTranslationsHidden;
  localStorage.setItem(READER_HIDE_TRANSLATIONS_KEY, readerTranslationsHidden ? '1' : '0');
  applyReaderTranslationVisibility();
  // No renderReaderChapter() here: help blocks are always in the DOM and the
  // body class alone shows/hides them. The full rebuild this used to do
  // re-tokenized every word of the chapter and froze the UI for seconds.
  const helpButton = document.getElementById('reader-help-btn');
  if (helpButton) helpButton.classList.toggle('on', !readerTranslationsHidden);
}

const READER_WORD_STATE_KEY = 'an2_reader_word_state_v1';
function readerWordStateStorageKey() { return readerScopedKey(READER_WORD_STATE_KEY); }

// Reader colours are navigation, not a permanent report of everything in the database.
// A passive word is allowed to fade visually after repeated real encounters, but it is NOT
// marked as learned. Any manual action can bring it back into an active status at once.
const READER_SEEN_AFTER = 3;             // 3 distinct visible paragraphs → yellow “often seen”
const READER_AUTO_FADE_AFTER = 6;        // 6+ distinct paragraphs without action → visually neutral
const READER_FAMILIAR_AFTER = 5;         // saved word may be marked “familiar”

const READER_COMMON_WORDS = new Set(`
  le la les un une des du de d' l' au aux à a et ou mais donc car ni que qui quoi dont où en y ce cet cette ces
  je j' tu il elle on nous vous ils elles me te se moi toi lui leur eux mon ma mes ton ta tes son sa ses notre nos votre vos
  suis es est sommes êtes sont ai as avons avez ont vais va vas vont aller être avoir fait faire peut peux peuvent pour par avec sans sur sous dans chez entre
  ne pas plus très bien comme si alors aussi tout toute tous toutes même chaque autre autres déjà encore ici là c'est il est
`.trim().split(/\s+/));

const READER_QUICK_LEXICON = {
  "dont": { pos: "pronoun", lemma: "dont", ru: "которого / чей / о котором; заменяет de + что-то", level: "A2", note: "относительное местоимение: связывает части фразы и часто значит 'of which / whose / about whom'" },
  "qui": { pos: "pronoun", lemma: "qui", ru: "который / кто", level: "A1", note: "относительное местоимение, обычно подлежащее" },
  "que": { pos: "pronoun", lemma: "que", ru: "который / что", level: "A1", note: "местоимение или союз; значение зависит от контекста" },
  "où": { pos: "pronoun", lemma: "où", ru: "где / куда / в котором", level: "A1", note: "место или момент времени" },
  "en": { pos: "pronoun", lemma: "en", ru: "этого / из этого / немного; также предлог 'в'", level: "A2", note: "часто заменяет de + существительное" },
  "y": { pos: "pronoun", lemma: "y", ru: "там / туда / к этому", level: "A2", note: "часто заменяет à + место/предмет" },
  "ce": { pos: "pronoun", lemma: "ce", ru: "это / этот", level: "A1", note: "указательное слово" },
  "cet": { pos: "determiner", lemma: "ce", ru: "этот", level: "A1", note: "форма перед гласной/немым h" },
  "cette": { pos: "determiner", lemma: "ce", ru: "эта", level: "A1", note: "женский род" },
  "ces": { pos: "determiner", lemma: "ce", ru: "эти", level: "A1", note: "множественное число" },
  "des": { pos: "determiner", lemma: "des", ru: "неопределённый артикль мн.ч. / de + les", level: "A1", note: "часто просто не переводится дословно" },
  "du": { pos: "determiner", lemma: "du", ru: "частичный артикль / de + le", level: "A1", note: "часто значит 'немного/какое-то количество' или 'of the'" },
  "au": { pos: "preposition", lemma: "à + le", ru: "в / к / на", level: "A1", note: "слияние à + le" },
  "aux": { pos: "preposition", lemma: "à + les", ru: "в / к / на", level: "A1", note: "слияние à + les" },
  "plus": { pos: "adverb", lemma: "plus", ru: "больше / более / самый", level: "A1", note: "в le plus = превосходная степень: самый" },
  "mois": { pos: "noun", lemma: "mois", ru: "месяц", gender: "m", level: "A1", note: "форма ед. и мн. числа одинаковая" },
  "leur": { pos: "determiner", lemma: "leur", ru: "их / им", level: "A1", note: "притяжательное слово или косвенное местоимение" },
  "leurs": { pos: "determiner", lemma: "leur", ru: "их", level: "A1", note: "множественная форма" },
  "celui": { pos: "pronoun", lemma: "celui", ru: "тот / тот, кто", level: "A2", note: "указательное местоимение" },
  "celle": { pos: "pronoun", lemma: "celle", ru: "та / та, которая", level: "A2", note: "указательное местоимение" },
  "ceux": { pos: "pronoun", lemma: "ceux", ru: "те", level: "A2", note: "указательное местоимение" },
  "celles": { pos: "pronoun", lemma: "celles", ru: "те", level: "A2", note: "указательное местоимение" },
  "lequel": { pos: "pronoun", lemma: "lequel", ru: "который / какой", level: "A2", note: "относительное/вопросительное местоимение" }
};

function readerQuickLookup(word) {
  const w = readerNormalizeWord(word).replace(/^l'/, '');
  const hit = READER_QUICK_LEXICON[w];
  if (!hit) return null;
  return { ...hit, word: w, surface: word, _source: 'quick', _note: 'локальный быстрый разбор' };
}


// v68.7 — stronger Chinese segmentation layer. DeepSeek stays for explanations;
// segmentation + basic pinyin are cheap dictionary work.
const READER_ZH_SEGMENT_URL = 'https://icudtjvnnoeibzxyyxfz.supabase.co/functions/v1/segment-text';
const READER_ZH_SEGMENT_KEY = 'sb_publishable_U72E36q-R5ZXlWrbWor-Ug_t0gmHDfA';
const READER_ZH_SEGMENT_CACHE_KEY = 'an2_zh_segment_cache_v4';
const READER_ZH_SEGMENT_CACHE_MAX = 1800;
// CC-CEDICT/lang_dictionary lookup: используем как технический слой для pinyin и факта существования слова.
// Русский смысл всё равно добирает DeepSeek, если в базе нет ru-поля.
const READER_ZH_DICT_URL = 'https://icudtjvnnoeibzxyyxfz.supabase.co/rest/v1/lang_dictionary';
const READER_ZH_DICT_KEY = READER_ZH_SEGMENT_KEY;
const READER_ZH_DICT_CACHE_KEY = 'an2_zh_ccedict_lookup_cache_v1';
const READER_ZH_DICT_CACHE_MAX = 2500;
// v68.15 — CC-CEDICT + EPUB/auth storage hardening.
// It is loaded from /data/zh_dict_core.json and used for segmentation + pinyin.
// DeepSeek still provides Russian contextual explanations when needed.
const READER_ZH_CORE_JSON_URL = 'data/zh_dict_core.json?v=68.15-epub-user-deepseek';
const READER_ZH_CORE_JSON_META_KEY = 'an2_zh_core_json_meta_v2';
const readerZhSegmentInFlight = new Map();
let readerZhSegmentCache = null;
let readerZhDictCache = null;
export let readerZhCoreJson = null;
export let readerZhCoreJsonPromise = null;

function readerNormalizeZhCoreEntry(row = {}, surface = '') {
  // v68.14 supports compact CC-CEDICT rows:
  //   "词": ["cí", "English fallback", "詞"]
  // as well as older object rows.
  if (Array.isArray(row)) {
    row = { word: surface, pinyin: row[0] || '', en: row[1] || '', traditional: row[2] || '' };
  }
  const word = readerNormalizeWord(row.word || row.simplified || row.simp || row.hanzi || row.zh || surface, 'zh');
  if (!word) return null;
  const pinyin = String(row.pinyin || row.py || row.pinyin_marked || row.pinyin_tone || row.reading || '').trim();
  const ru = String(row.ru || row.russian || row.translation_ru || row.meaning_ru || '').trim();
  const enRaw = row.en || row.english || row.definition || row.definitions || row.meaning || row.gloss || '';
  const en = Array.isArray(enRaw) ? enRaw.join('; ') : readerCleanCedictEnglish(enRaw);
  return {
    lang: 'zh', word, surface: surface || word, lemma: word,
    pinyin, ru, translation: ru, meaning: ru,
    en, english: en, traditional: row.traditional || row.trad || '',
    pos: row.pos || row.part_of_speech || row.type || '',
    level: row.level || row.hsk || row.hsk_level || 'CC-CEDICT',
    form_note: pinyin || '',
    note: row.note || 'полный локальный CC-CEDICT: pinyin + English fallback; русский смысл — через DeepSeek/ручной кэш',
    _source: row.source || 'cc-cedict-full',
    _note: 'полный локальный CC-CEDICT / data/zh_dict_core.json'
  };
}

function readerBuildZhCoreJsonMap(payload) {
  const map = {};
  const src = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.entries)
      ? payload.entries
      : payload?.map || payload?.words || payload?.dict || payload || {};
  if (Array.isArray(src)) {
    src.forEach(row => {
      const entry = readerNormalizeZhCoreEntry(row);
      if (entry?.word) map[entry.word] = entry;
    });
  } else {
    Object.entries(src || {}).forEach(([word, row]) => {
      let raw;
      if (Array.isArray(row)) raw = row;
      else raw = { ...(row || {}), word: row?.word || word };
      const entry = readerNormalizeZhCoreEntry(raw, word);
      if (entry?.word) map[entry.word] = entry;
    });
  }
  return Object.freeze(map);
}

function readerZhCoreJsonCount() {
  return readerZhCoreJson ? Object.keys(readerZhCoreJson).length : 0;
}

function readerEnsureZhCoreJsonLoaded(options = {}) {
  if (readerZhCoreJson) return Promise.resolve(readerZhCoreJson);
  if (readerZhCoreJsonPromise) return readerZhCoreJsonPromise;
  readerZhCoreJsonPromise = fetch(READER_ZH_CORE_JSON_URL, { cache: 'force-cache' })
    .then(res => {
      if (!res.ok) throw new Error('zh_dict_core.json HTTP ' + res.status);
      return res.json();
    })
    .then(payload => {
      readerZhCoreJson = readerBuildZhCoreJsonMap(payload);
      try {
        localStorage.setItem(READER_ZH_CORE_JSON_META_KEY, JSON.stringify({
          loadedAt: new Date().toISOString(),
          count: readerZhCoreJsonCount(),
          version: payload?.version || 'unknown'
        }));
      } catch {}
      if (options.rerender && readerCurrentLang() === 'zh') {
        setTimeout(() => { try { renderReaderChapter(); } catch {} }, 0);
      }
      return readerZhCoreJson;
    })
    .catch(e => {
      console.warn('[zh core json] load failed:', e?.message || e);
      readerZhCoreJson = Object.freeze({});
      return readerZhCoreJson;
    });
  return readerZhCoreJsonPromise;
}

function readerLookupChineseJsonEntry(w) {
  const word = readerNormalizeWord(w, 'zh');
  if (!word) return null;
  return readerZhCoreJson?.[word] || null;
}

const READER_ZH_CORE_LEXICON = Object.freeze({
  '我':{pinyin:'wǒ',ru:'я',pos:'pronoun',level:'HSK1'}, '你':{pinyin:'nǐ',ru:'ты',pos:'pronoun',level:'HSK1'},
  '他':{pinyin:'tā',ru:'он',pos:'pronoun',level:'HSK1'}, '她':{pinyin:'tā',ru:'она',pos:'pronoun',level:'HSK1'},
  '我们':{pinyin:'wǒmen',ru:'мы',pos:'pronoun',level:'HSK1'}, '他们':{pinyin:'tāmen',ru:'они',pos:'pronoun',level:'HSK1'},
  '是':{pinyin:'shì',ru:'быть / являться',pos:'verb',level:'HSK1'}, '有':{pinyin:'yǒu',ru:'иметь; есть',pos:'verb',level:'HSK1'},
  '没有':{pinyin:'méiyǒu',ru:'нет; не иметь',pos:'verb',level:'HSK1'}, '在':{pinyin:'zài',ru:'быть в/на; находиться',pos:'preposition',level:'HSK1'},
  '不':{pinyin:'bù',ru:'не',pos:'adverb',level:'HSK1'}, '没':{pinyin:'méi',ru:'не; нет',pos:'adverb',level:'HSK1'},
  '了':{pinyin:'le',ru:'частица завершённости/изменения',pos:'particle',level:'HSK1'}, '的':{pinyin:'de',ru:'частица принадлежности/определения',pos:'particle',level:'HSK1'},
  '吗':{pinyin:'ma',ru:'вопросительная частица',pos:'particle',level:'HSK1'}, '呢':{pinyin:'ne',ru:'частица',pos:'particle',level:'HSK1'},
  '很':{pinyin:'hěn',ru:'очень; связка перед прил.',pos:'adverb',level:'HSK1'}, '也':{pinyin:'yě',ru:'тоже',pos:'adverb',level:'HSK1'},
  '都':{pinyin:'dōu',ru:'все; уже',pos:'adverb',level:'HSK1'}, '和':{pinyin:'hé',ru:'и; с',pos:'conjunction',level:'HSK1'},
  '因为':{pinyin:'yīnwèi',ru:'потому что',pos:'conjunction',level:'HSK2'}, '所以':{pinyin:'suǒyǐ',ru:'поэтому',pos:'conjunction',level:'HSK2'},
  '但是':{pinyin:'dànshì',ru:'но',pos:'conjunction',level:'HSK2'}, '如果':{pinyin:'rúguǒ',ru:'если',pos:'conjunction',level:'HSK3'},
  '这个':{pinyin:'zhège',ru:'этот',pos:'determiner',level:'HSK1'}, '那个':{pinyin:'nàge',ru:'тот',pos:'determiner',level:'HSK1'},
  '这些':{pinyin:'zhèxiē',ru:'эти',pos:'determiner',level:'HSK2'}, '那些':{pinyin:'nàxiē',ru:'те',pos:'determiner',level:'HSK2'},
  '这':{pinyin:'zhè',ru:'это; этот',pos:'determiner',level:'HSK1'}, '那':{pinyin:'nà',ru:'то; тот',pos:'determiner',level:'HSK1'},
  '什么':{pinyin:'shénme',ru:'что; какой',pos:'pronoun',level:'HSK1'}, '怎么':{pinyin:'zěnme',ru:'как',pos:'pronoun',level:'HSK1'},
  '为什么':{pinyin:'wèishénme',ru:'почему',pos:'pronoun',level:'HSK2'}, '谁':{pinyin:'shéi',ru:'кто',pos:'pronoun',level:'HSK1'},
  '多少':{pinyin:'duōshao',ru:'сколько',pos:'pronoun',level:'HSK1'}, '几':{pinyin:'jǐ',ru:'сколько; несколько',pos:'pronoun',level:'HSK1'},
  '个':{pinyin:'gè',ru:'универсальное счётное слово',pos:'classifier',level:'HSK1'}, '本':{pinyin:'běn',ru:'счётное слово для книг',pos:'classifier',level:'HSK1'},
  '人':{pinyin:'rén',ru:'человек',pos:'noun',level:'HSK1'}, '女人':{pinyin:'nǚrén',ru:'женщина',pos:'noun',level:'HSK1'},
  '男人':{pinyin:'nánrén',ru:'мужчина',pos:'noun',level:'HSK1'}, '孩子':{pinyin:'háizi',ru:'ребёнок',pos:'noun',level:'HSK2'},
  '朋友':{pinyin:'péngyou',ru:'друг',pos:'noun',level:'HSK1'}, '老师':{pinyin:'lǎoshī',ru:'учитель',pos:'noun',level:'HSK1'},
  '学生':{pinyin:'xuésheng',ru:'ученик; студент',pos:'noun',level:'HSK1'}, '妈妈':{pinyin:'māma',ru:'мама',pos:'noun',level:'HSK1'},
  '爸爸':{pinyin:'bàba',ru:'папа',pos:'noun',level:'HSK1'}, '哥哥':{pinyin:'gēge',ru:'старший брат',pos:'noun',level:'HSK1'},
  '家':{pinyin:'jiā',ru:'дом; семья',pos:'noun',level:'HSK1'}, '学校':{pinyin:'xuéxiào',ru:'школа',pos:'noun',level:'HSK1'},
  '公司':{pinyin:'gōngsī',ru:'компания',pos:'noun',level:'HSK2'}, '北京':{pinyin:'Běijīng',ru:'Пекин',pos:'proper_noun',level:'HSK1'},
  '中国':{pinyin:'Zhōngguó',ru:'Китай',pos:'proper_noun',level:'HSK1'}, '俄罗斯':{pinyin:'Éluósī',ru:'Россия',pos:'proper_noun',level:'HSK2'},
  '今天':{pinyin:'jīntiān',ru:'сегодня',pos:'noun',level:'HSK1'}, '昨天':{pinyin:'zuótiān',ru:'вчера',pos:'noun',level:'HSK1'},
  '明天':{pinyin:'míngtiān',ru:'завтра',pos:'noun',level:'HSK1'}, '现在':{pinyin:'xiànzài',ru:'сейчас',pos:'noun',level:'HSK1'},
  '时候':{pinyin:'shíhou',ru:'время; момент',pos:'noun',level:'HSK2'}, '认识':{pinyin:'rènshi',ru:'знать человека; быть знакомым',pos:'verb',level:'HSK1'},
  '知道':{pinyin:'zhīdào',ru:'знать факт',pos:'verb',level:'HSK1'}, '看见':{pinyin:'kànjiàn',ru:'увидеть',pos:'verb',level:'HSK1'},
  '看到':{pinyin:'kàndào',ru:'увидеть; заметить',pos:'verb',level:'HSK2'}, '看':{pinyin:'kàn',ru:'смотреть; читать',pos:'verb',level:'HSK1'},
  '听':{pinyin:'tīng',ru:'слушать',pos:'verb',level:'HSK1'}, '说':{pinyin:'shuō',ru:'говорить',pos:'verb',level:'HSK1'},
  '告诉':{pinyin:'gàosu',ru:'сказать; сообщить',pos:'verb',level:'HSK2'}, '问':{pinyin:'wèn',ru:'спрашивать',pos:'verb',level:'HSK1'},
  '回答':{pinyin:'huídá',ru:'отвечать',pos:'verb',level:'HSK2'}, '想':{pinyin:'xiǎng',ru:'думать; хотеть; скучать',pos:'verb',level:'HSK1'},
  '觉得':{pinyin:'juéde',ru:'считать; чувствовать',pos:'verb',level:'HSK2'}, '喜欢':{pinyin:'xǐhuan',ru:'нравиться; любить',pos:'verb',level:'HSK1'},
  '爱':{pinyin:'ài',ru:'любить',pos:'verb',level:'HSK1'}, '去':{pinyin:'qù',ru:'идти; ехать',pos:'verb',level:'HSK1'},
  '来':{pinyin:'lái',ru:'приходить',pos:'verb',level:'HSK1'}, '回':{pinyin:'huí',ru:'вернуться',pos:'verb',level:'HSK1'},
  '住':{pinyin:'zhù',ru:'жить; проживать',pos:'verb',level:'HSK1'}, '走':{pinyin:'zǒu',ru:'идти пешком; уходить',pos:'verb',level:'HSK1'},
  '买':{pinyin:'mǎi',ru:'покупать',pos:'verb',level:'HSK1'}, '卖':{pinyin:'mài',ru:'продавать',pos:'verb',level:'HSK2'},
  '吃':{pinyin:'chī',ru:'есть',pos:'verb',level:'HSK1'}, '喝':{pinyin:'hē',ru:'пить',pos:'verb',level:'HSK1'},
  '做':{pinyin:'zuò',ru:'делать',pos:'verb',level:'HSK1'}, '工作':{pinyin:'gōngzuò',ru:'работать; работа',pos:'verb',level:'HSK1'},
  '学习':{pinyin:'xuéxí',ru:'учиться; изучать',pos:'verb',level:'HSK1'}, '睡觉':{pinyin:'shuìjiào',ru:'спать',pos:'verb',level:'HSK1'},
  '高兴':{pinyin:'gāoxìng',ru:'радостный; радоваться',pos:'adjective',level:'HSK1'}, '好':{pinyin:'hǎo',ru:'хороший',pos:'adjective',level:'HSK1'},
  '大':{pinyin:'dà',ru:'большой',pos:'adjective',level:'HSK1'}, '小':{pinyin:'xiǎo',ru:'маленький',pos:'adjective',level:'HSK1'},
  '漂亮':{pinyin:'piàoliang',ru:'красивый',pos:'adjective',level:'HSK1'}, '书':{pinyin:'shū',ru:'книга',pos:'noun',level:'HSK1'},
  '一本书':{pinyin:'yì běn shū',ru:'одна книга',pos:'phrase',level:'HSK1'}, '电影':{pinyin:'diànyǐng',ru:'фильм',pos:'noun',level:'HSK1'},
  '音乐':{pinyin:'yīnyuè',ru:'музыка',pos:'noun',level:'HSK1'}, '水':{pinyin:'shuǐ',ru:'вода',pos:'noun',level:'HSK1'},
  '茶':{pinyin:'chá',ru:'чай',pos:'noun',level:'HSK1'}, '米饭':{pinyin:'mǐfàn',ru:'рис; еда',pos:'noun',level:'HSK1'},
  '钱':{pinyin:'qián',ru:'деньги',pos:'noun',level:'HSK1'}, '名字':{pinyin:'míngzi',ru:'имя',pos:'noun',level:'HSK1'},
  '天气':{pinyin:'tiānqì',ru:'погода',pos:'noun',level:'HSK1'}, '东西':{pinyin:'dōngxi',ru:'вещь',pos:'noun',level:'HSK1'},
  '事情':{pinyin:'shìqing',ru:'дело; событие',pos:'noun',level:'HSK2'}, '问题':{pinyin:'wèntí',ru:'вопрос; проблема',pos:'noun',level:'HSK2'},
  '意思':{pinyin:'yìsi',ru:'смысл; значение',pos:'noun',level:'HSK2'}
});

// v68.7 — reading-oriented Chinese lexicon. This is not a full CC-CEDICT import yet;
// it is a stronger local layer so the reader does not fall back to single hanzi too often.
const READER_ZH_READING_LEXICON = Object.freeze({
  '小卖铺':{pinyin:'xiǎomàipù',ru:'маленькая лавка',pos:'noun'}, '小卖部':{pinyin:'xiǎomàibù',ru:'маленький магазинчик',pos:'noun'},
  '大声':{pinyin:'dàshēng',ru:'громко; громким голосом',pos:'adverb'}, '呼救':{pinyin:'hūjiù',ru:'звать на помощь',pos:'verb'},
  '三个':{pinyin:'sān ge',ru:'три',pos:'phrase'}, '跑过去':{pinyin:'pǎo guòqù',ru:'подбежать; побежать туда',pos:'verb_phrase'},
  '过去':{pinyin:'guòqù',ru:'прошлое; пройти/перейти туда',pos:'verb'}, '看热闹':{pinyin:'kàn rènao',ru:'смотреть на происшествие/толпу',pos:'verb_phrase'},
  '热闹':{pinyin:'rènao',ru:'оживлённый; шумный; зрелище',pos:'adjective'}, '过了':{pinyin:'guò le',ru:'прошло; спустя',pos:'phrase'},
  '一会儿':{pinyin:'yíhuìr',ru:'немного времени; через некоторое время',pos:'time_phrase'}, '一会':{pinyin:'yíhuì',ru:'немного времени',pos:'time_phrase'},
  '保安':{pinyin:'bǎo’ān',ru:'охранник; охрана',pos:'noun'}, '警察':{pinyin:'jǐngchá',ru:'полиция; полицейский',pos:'noun'},
  '从':{pinyin:'cóng',ru:'из; от; с',pos:'preposition'}, '山下':{pinyin:'shānxià',ru:'под горой; у подножия',pos:'place'},
  '山上':{pinyin:'shānshàng',ru:'на горе',pos:'place'}, '抬出':{pinyin:'tái chū',ru:'вынести, подняв/неся',pos:'verb'},
  '抬出了':{pinyin:'tái chū le',ru:'вынесли',pos:'verb_phrase'}, '用':{pinyin:'yòng',ru:'использовать; при помощи',pos:'verb/prep'},
  '塑料布':{pinyin:'sùliàobù',ru:'пластиковая плёнка/брезент',pos:'noun'}, '塑料':{pinyin:'sùliào',ru:'пластик',pos:'noun'},
  '包裹':{pinyin:'bāoguǒ',ru:'заворачивать; свёрток',pos:'verb/noun'}, '包裹的':{pinyin:'bāoguǒ de',ru:'завёрнутый в...',pos:'phrase'},
  '遗体':{pinyin:'yítǐ',ru:'тело погибшего; останки',pos:'noun'}, '沾着':{pinyin:'zhān zhe',ru:'быть испачканным/покрытым',pos:'verb_phrase'},
  '沾':{pinyin:'zhān',ru:'пачкаться; прилипать',pos:'verb'}, '着':{pinyin:'zhe',ru:'частица длительного состояния',pos:'particle'},
  '血':{pinyin:'xuè',ru:'кровь',pos:'noun'}, '所有人':{pinyin:'suǒyǒu rén',ru:'все люди; все',pos:'noun_phrase'},
  '所有':{pinyin:'suǒyǒu',ru:'все; весь',pos:'determiner'}, '脸色':{pinyin:'liǎnsè',ru:'цвет лица; выражение лица',pos:'noun'},
  '难看':{pinyin:'nánkàn',ru:'выглядеть плохо; некрасивый',pos:'adjective'},
  '尸体':{pinyin:'shītǐ',ru:'труп',pos:'noun'}, '死人':{pinyin:'sǐrén',ru:'мертвец',pos:'noun'}, '死亡':{pinyin:'sǐwáng',ru:'смерть; умереть',pos:'noun/verb'},
  '发现':{pinyin:'fāxiàn',ru:'обнаружить; заметить',pos:'verb'}, '突然':{pinyin:'tūrán',ru:'вдруг; внезапно',pos:'adverb'},
  '马上':{pinyin:'mǎshàng',ru:'сразу; немедленно',pos:'adverb'}, '已经':{pinyin:'yǐjīng',ru:'уже',pos:'adverb'},
  '开始':{pinyin:'kāishǐ',ru:'начинать; начало',pos:'verb/noun'}, '地方':{pinyin:'dìfang',ru:'место',pos:'noun'},
  '旁边':{pinyin:'pángbiān',ru:'рядом; сбоку',pos:'place'}, '里面':{pinyin:'lǐmiàn',ru:'внутри',pos:'place'}, '外面':{pinyin:'wàimiàn',ru:'снаружи',pos:'place'},
  '前面':{pinyin:'qiánmiàn',ru:'впереди',pos:'place'}, '后面':{pinyin:'hòumiàn',ru:'позади',pos:'place'},
  '起来':{pinyin:'qǐlái',ru:'встать; начать действие',pos:'resultative'}, '下去':{pinyin:'xiàqù',ru:'спуститься/продолжать вниз',pos:'verb'},
  '出来':{pinyin:'chūlái',ru:'выйти наружу',pos:'verb'}, '进去':{pinyin:'jìnqù',ru:'войти внутрь',pos:'verb'},
  '一下':{pinyin:'yíxià',ru:'немного; разок',pos:'measure'}, '一下子':{pinyin:'yíxiàzi',ru:'вдруг; сразу',pos:'adverb'},
  '时候':{pinyin:'shíhou',ru:'время; момент',pos:'noun'}, '时候儿':{pinyin:'shíhour',ru:'момент',pos:'noun'},
  '觉得':{pinyin:'juéde',ru:'считать; чувствовать',pos:'verb'}, '好像':{pinyin:'hǎoxiàng',ru:'как будто; похоже',pos:'adverb'},
  '可能':{pinyin:'kěnéng',ru:'возможно; мочь',pos:'adverb/verb'}, '一定':{pinyin:'yídìng',ru:'обязательно; наверняка',pos:'adverb'},
  '不是':{pinyin:'bú shì',ru:'не является; не то',pos:'phrase'}, '就是':{pinyin:'jiùshì',ru:'именно; то есть',pos:'phrase'},
  '为什么':{pinyin:'wèishénme',ru:'почему',pos:'question'}, '怎么办':{pinyin:'zěnme bàn',ru:'что делать?',pos:'phrase'},
  '没有人':{pinyin:'méiyǒu rén',ru:'никого нет; никто',pos:'phrase'}, '没有什么':{pinyin:'méiyǒu shénme',ru:'ничего особенного',pos:'phrase'},
  '看着':{pinyin:'kàn zhe',ru:'смотреть на; глядя',pos:'verb_phrase'}, '听见':{pinyin:'tīngjiàn',ru:'услышать',pos:'verb'},
  '声音':{pinyin:'shēngyīn',ru:'голос; звук',pos:'noun'}, '身上':{pinyin:'shēnshang',ru:'на теле; при себе',pos:'place'},
  '手里':{pinyin:'shǒulǐ',ru:'в руке',pos:'place'}, '心里':{pinyin:'xīnlǐ',ru:'в душе; в сердце',pos:'place'},
  '这时':{pinyin:'zhè shí',ru:'в этот момент',pos:'time_phrase'}, '这时候':{pinyin:'zhè shíhou',ru:'в это время',pos:'time_phrase'},
  '然后':{pinyin:'ránhòu',ru:'потом; затем',pos:'conjunction'}, '以后':{pinyin:'yǐhòu',ru:'после; потом',pos:'time'},
  '以前':{pinyin:'yǐqián',ru:'раньше; до',pos:'time'}, '终于':{pinyin:'zhōngyú',ru:'наконец',pos:'adverb'}
});

function readerLookupChineseLocalEntry(w) {
  const word = readerNormalizeWord(w, 'zh');
  if (!word) return null;
  return READER_ZH_READING_LEXICON[word] || READER_ZH_CORE_LEXICON[word] || readerLookupChineseJsonEntry(word) || null;
}

function readerIsHanToken(word) {
  return /^[㐀-鿿]+$/.test(String(word || ''));
}

function readerHanLength(word) {
  return Array.from(String(word || '')).filter(ch => /[㐀-鿿]/.test(ch)).length;
}

function readerChineseSegScore(words) {
  const arr = Array.isArray(words) ? words : [];
  let score = 0;
  for (const raw of arr) {
    const w = String(raw || '');
    if (!/[㐀-鿿]/.test(w)) continue;
    const len = readerHanLength(w);
    if (len >= 4) score += len * 3.2;
    else if (len >= 2) score += len * 2.2;
    else score -= 0.55;
    if (readerLookupChineseLocalEntry(w)) score += 2.5;
  }
  score -= arr.length * 0.06;
  return score;
}

function readerChooseBestChineseSegmentation(text, remoteWords, localWords) {
  const remote = (Array.isArray(remoteWords) ? remoteWords : []).filter(x => x !== '');
  const local = (Array.isArray(localWords) ? localWords : []).filter(x => x !== '');
  if (!remote.length) return local;
  if (!local.length) return remote;
  const rs = readerChineseSegScore(remote);
  const ls = readerChineseSegScore(local);
  return rs > ls + 1.2 ? remote : local;
}

function loadReaderZhSegmentCache() {
  if (readerZhSegmentCache) return readerZhSegmentCache;
  try { readerZhSegmentCache = JSON.parse(localStorage.getItem(READER_ZH_SEGMENT_CACHE_KEY) || '{}') || {}; }
  catch { readerZhSegmentCache = {}; }
  return readerZhSegmentCache;
}
function saveReaderZhSegmentCache() {
  const cache = loadReaderZhSegmentCache();
  try {
    const keys = Object.keys(cache).sort((a,b) => (cache[b]?.t || 0) - (cache[a]?.t || 0));
    for (const k of keys.slice(READER_ZH_SEGMENT_CACHE_MAX)) delete cache[k];
    localStorage.setItem(READER_ZH_SEGMENT_CACHE_KEY, JSON.stringify(cache));
  } catch(e) { console.warn('[zh segment] cache save failed', e); }
}
function readerTextHash(text) {
  const s = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + '_' + s.length;
}
function loadReaderZhDictCache() {
  if (readerZhDictCache) return readerZhDictCache;
  try { readerZhDictCache = JSON.parse(localStorage.getItem(READER_ZH_DICT_CACHE_KEY) || '{}') || {}; }
  catch { readerZhDictCache = {}; }
  return readerZhDictCache;
}
function saveReaderZhDictCache() {
  const cache = loadReaderZhDictCache();
  try {
    const keys = Object.keys(cache).sort((a,b) => (cache[b]?.t || 0) - (cache[a]?.t || 0));
    for (const k of keys.slice(READER_ZH_DICT_CACHE_MAX)) delete cache[k];
    localStorage.setItem(READER_ZH_DICT_CACHE_KEY, JSON.stringify(cache));
  } catch(e) { console.warn('[zh dict] cache save failed', e); }
}
function readerCleanCedictEnglish(value) {
  return String(value || '')
    .replace(/CL:[^/;]+/g, '')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .trim();
}
function readerNormalizeChineseDictRow(row = {}, surface = '') {
  const word = readerNormalizeWord(row.word || row.simplified || row.simplified_word || row.hanzi || row.zh || row.term || surface, 'zh');
  if (!word) return null;
  const pinyin = String(row.pinyin || row.py || row.pinyin_marked || row.pinyin_tone || row.pronunciation || row.reading || '').trim();
  const ru = String(row.ru || row.russian || row.translation_ru || row.meaning_ru || row.gloss_ru || '').trim();
  const enRaw = row.en || row.english || row.definition || row.definitions || row.meaning || row.gloss || '';
  const en = Array.isArray(enRaw) ? enRaw.join('; ') : readerCleanCedictEnglish(enRaw);
  const pos = row.pos || row.part_of_speech || row.type || 'other';
  const level = row.hsk || row.level || row.hsk_level || '';
  return {
    lang: 'zh', word, surface: surface || word, lemma: word, pos,
    pinyin, ru, translation: ru, meaning: ru,
    en, english: en, level: level || 'CC-CEDICT',
    form_note: pinyin || '',
    note: 'CC-CEDICT',
    _source: 'cc-cedict',
    _note: 'CC-CEDICT / lang_dictionary'
  };
}
async function readerFetchChineseDictEntry(word) {
  const w = readerNormalizeWord(word, 'zh');
  if (!w) return null;
  const cache = loadReaderZhDictCache();
  const key = 'zh:' + w;
  if (cache[key]?.miss && Date.now() - (cache[key]?.t || 0) < 86400000) return null;
  if (cache[key]?.entry) return cache[key].entry;
  try {
    const url = `${READER_ZH_DICT_URL}?language=eq.zh&word=eq.${encodeURIComponent(w)}&select=*&limit=5`;
    const res = await fetch(url, {
      headers: { 'apikey': READER_ZH_DICT_KEY, 'Authorization': `Bearer ${READER_ZH_DICT_KEY}` }
    });
    if (!res.ok) throw new Error('lang_dictionary HTTP ' + res.status);
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    const entry = row ? readerNormalizeChineseDictRow(row, w) : null;
    const c = loadReaderZhDictCache();
    if (entry) {
      c[key] = { entry, t: Date.now() };
      // Сохраняем pinyin/техническую запись в общий lexical cache, чтобы ruby работал без повторного запроса.
      readerPutCachedLexical(w, entry, 'zh');
    } else {
      c[key] = { miss: true, t: Date.now() };
    }
    saveReaderZhDictCache();
    return entry;
  } catch (e) {
    console.warn('[zh dict] lookup failed:', e?.message || e);
    return null;
  }
}
function readerLookupChineseWord(word) {
  const w = readerNormalizeWord(word, 'zh');
  if (!w) return null;
  const cached = readerGetCachedLexical(w, 'zh');
  if (cached) return { ...cached, _source: 'cache', _note: 'из кэша DeepSeek' };
  const hit = readerLookupChineseLocalEntry(w);
  if (!hit) return null;
  const src = READER_ZH_READING_LEXICON[w] ? 'zh_reading' : READER_ZH_CORE_LEXICON[w] ? 'zh_core' : hit._source || 'zh_core_json';
  return { ...hit, word: w, surface: word, lemma: w, pinyin: hit.pinyin || '', _source: src, _note: hit._note || 'локальный китайский словарь' };
}
function readerBuildChineseWordSet() {
  // Dynamic/user words only. The full CC-CEDICT map can be 120k+ entries,
  // so we do NOT copy it into a Set on every paragraph render.
  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: true });
  const dict = new Set([...Object.keys(READER_ZH_CORE_LEXICON), ...Object.keys(READER_ZH_READING_LEXICON)]);
  const lex = loadReaderLexicalCache();
  Object.keys(lex || {}).forEach(k => {
    if (!k.startsWith('zh:')) return;
    const item = lex[k] || {};
    [item.word, item.surface, item.lemma].forEach(x => { const w = readerNormalizeWord(x, 'zh'); if (w) dict.add(w); });
  });
  const states = loadReaderWordState();
  Object.values(states || {}).forEach(st => {
    if (!st || readerCanonicalLang(st.lang) !== 'zh') return;
    const w = readerNormalizeWord(st.word, 'zh');
    if (w) dict.add(w);
  });
  return dict;
}

function readerChineseWordExistsDirect(word, dynamicDict = null) {
  const w = String(word || '');
  return !!(
    (dynamicDict && dynamicDict.has(w)) ||
    READER_ZH_READING_LEXICON[w] ||
    READER_ZH_CORE_LEXICON[w] ||
    (readerZhCoreJson && readerZhCoreJson[w])
  );
}
function readerSegmentChineseLocal(text) {
  const s = String(text || '');
  const dynamicDict = readerBuildChineseWordSet();
  const result = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { result.push(ch); i++; continue; }
    if (!/[㐀-鿿]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && !/\s/.test(s[j]) && !/[㐀-鿿]/.test(s[j])) j++;
      result.push(s.slice(i, j));
      i = j;
      continue;
    }
    let best = '';
    const maxLen = Math.min(12, s.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const slice = s.slice(i, i + len);
      if (len === 1 || readerChineseWordExistsDirect(slice, dynamicDict)) { best = slice; break; }
    }
    result.push(best || ch);
    i += (best || ch).length;
  }
  return result.filter(x => x !== '');
}
async function readerFetchChineseSegmentation(text) {
  const s = String(text || '');
  if (!s.trim() || !/[㐀-鿿]/.test(s)) return null;
  const res = await fetch(READER_ZH_SEGMENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': READER_ZH_SEGMENT_KEY, 'Authorization': `Bearer ${READER_ZH_SEGMENT_KEY}` },
    body: JSON.stringify({ text: s })
  });
  if (!res.ok) throw new Error('segment-text HTTP ' + res.status);
  const data = await res.json();
  const words = Array.isArray(data?.words) ? data.words : [];
  return words.filter(x => x !== '');
}
function readerScheduleChineseSegmentation(text) {
  const s = String(text || '');
  if (!s.trim() || !/[㐀-鿿]/.test(s)) return;
  const key = readerTextHash(s);
  const cache = loadReaderZhSegmentCache();
  if (cache[key]?.words?.length) return;
  if (cache[key]?.failed && Date.now() - (cache[key]?.t || 0) < 3600000) return;
  if (readerZhSegmentInFlight.has(key)) return;
  const p = readerFetchChineseSegmentation(s)
    .then(words => {
      const local = readerSegmentChineseLocal(s);
      const picked = readerChooseBestChineseSegmentation(s, words, local);
      if (Array.isArray(picked) && picked.length) {
        const c = loadReaderZhSegmentCache();
        c[key] = { words: picked, t: Date.now(), source: picked === words ? 'segment-text' : 'local-dict-preferred' };
        saveReaderZhSegmentCache();
        try { if (readerCurrentLang() === 'zh') renderReaderChapter(); } catch {}
      }
    })
    .catch(e => {
      const c = loadReaderZhSegmentCache();
      c[key] = { failed: true, t: Date.now(), source: 'local-fallback' };
      saveReaderZhSegmentCache();
      console.warn('[zh segment] remote failed, local fallback stays active:', e?.message || e);
    })
    .finally(() => readerZhSegmentInFlight.delete(key));
  readerZhSegmentInFlight.set(key, p);
}


function loadReaderWordState() { return readerWordState.load(); }

function saveReaderWordState() {
  const result = readerWordState.save();
  scheduleWordStateCloudSync();
  return result;
}

// ── Облачная синхронизация статусов слов ──
// This used to be a plain debounce (reset on every call) — during continuous
// reading, word-state saves fire constantly (every paragraph view, every
// click), so the timer kept getting pushed back and could go a whole session
// without ever actually firing. A "clear all site data" while that tab stays
// open never gives the app a chance to flush (no JS hook exists for it), so
// the only real defenses are: sync soon after the FIRST pending change no
// matter how much activity follows, and the visibilitychange/pagehide flush
// below for when the tab is backgrounded or closed normally.
let _wordStateSyncTimer = null;
let _wordStateSyncPendingSince = 0;
const WORD_STATE_SYNC_IDLE_MS = 15000;
const WORD_STATE_SYNC_MAX_WAIT_MS = 20000;
function scheduleWordStateCloudSync() {
  const now = Date.now();
  if (!_wordStateSyncPendingSince) _wordStateSyncPendingSince = now;
  clearTimeout(_wordStateSyncTimer);
  const elapsed = now - _wordStateSyncPendingSince;
  const delay = Math.min(WORD_STATE_SYNC_IDLE_MS, Math.max(0, WORD_STATE_SYNC_MAX_WAIT_MS - elapsed));
  _wordStateSyncTimer = setTimeout(() => {
    _wordStateSyncPendingSince = 0;
    syncWordStateToCloud().catch(() => {});
  }, delay);
}

function readerWaitForCloudReady(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (isSupabaseReady?.()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(check, 200);
    })();
  });
}

async function syncWordStateToCloud() {
  const uid = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
  if (!uid) return;
  // See syncWordStateFromCloud below: same init-timing race applies to uploads.
  const ready = isSupabaseReady?.() || await readerWaitForCloudReady();
  if (!ready) return;
  const state = loadReaderWordState();
  if (!state || !Object.keys(state).length) return;
  // fbSaveWordState replaces the whole cloud node (set), so a device with stale
  // state would wipe marks made elsewhere. Merge cloud in first: per word,
  // newer updatedAt wins — upload is then a superset of both devices.
  try {
    const cloud = await fbLoadWordState(uid);
    if (cloud && typeof cloud === 'object') {
      let changed = false;
      for (const [k, v] of Object.entries(cloud)) {
        if (!v || !v.word) continue;
        const mine = state[k];
        if (!mine || new Date(v.updatedAt || 0) > new Date(mine.updatedAt || 0)) {
          state[k] = v;
          changed = true;
        }
      }
      if (changed) {
        try { localStorage.setItem(readerWordStateStorageKey(), JSON.stringify(state)); } catch {}
        try {
          const readingView = document.getElementById('reader-reading-view');
          if (readingView && readingView.style.display !== 'none') readerRefreshParagraphWordClasses();
        } catch {}
      }
    }
  } catch {}
  await fbSaveWordState(uid, state);
}

async function syncWordStateFromCloud() {
  const uid = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
  if (!uid) return;
  // isSupabaseReady() (misnamed — it also gates on Firebase's own init flag)
  // can still be false for a moment right after navigating to the reader/
  // dict screen if that happens early in the session, before init settles.
  // A silent no-op here means "opened a book/screen too soon" would
  // permanently skip pulling cloud word marks for that visit — wait briefly
  // for init instead of giving up immediately.
  const ready = isSupabaseReady?.() || await readerWaitForCloudReady();
  if (!ready) return;
  const cloud = await fbLoadWordState(uid);
  if (!cloud || typeof cloud !== 'object') return;
  const local = loadReaderWordState();
  let changed = false;
  for (const [k, v] of Object.entries(cloud)) {
    if (!v || !v.word) continue;
    const localEntry = local[k];
    if (!localEntry || new Date(v.updatedAt || 0) > new Date(localEntry.updatedAt || 0)) {
      local[k] = v;
      changed = true;
    }
  }
  if (changed) {
    try { localStorage.setItem(readerWordStateStorageKey(), JSON.stringify(local)); } catch {}
    readerWordStateCache = null; // force reload from updated localStorage on next access
    console.log('[word-state] merged', Object.keys(cloud).length, 'words from cloud');
    // Refresh visible reader so cloud-synced word colors appear without page reload
    try {
      const readingView = document.getElementById('reader-reading-view');
      if (readingView && readingView.style.display !== 'none') {
        readerRefreshParagraphWordClasses();
      }
    } catch {}
  }
}

const READER_WORD_COLOR_CLASSES = ['rw-new','rw-seen','rw-faded','rw-saved','rw-known','rw-looked','rw-learning','rw-familiar','rw-problem','rw-sel'];
let readerVisibleParagraphObserver = null;
let readerVisibleParagraphTimers = new Map();

function readerRefreshParagraphWordClasses(index = null) {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const idx = index !== null && index !== undefined ? Number(index) : NaN;
  const base = Number.isFinite(idx)
    ? root.querySelectorAll(`.reader-paragraph[data-p="${idx}"] .reader-word`)
    : root.querySelectorAll('.reader-word');
  base.forEach(span => {
    const word = span.dataset.word || span.textContent || '';
    const lang = span.dataset.lang || readerCurrentLang();
    const visual = readerWordVisual(word, lang);
    span.classList.remove(...READER_WORD_COLOR_CLASSES);
    span.classList.add(visual.cls);
    span.title = visual.title || '';

    // A status change can also change the Chinese pinyin scaffold. Rebuild just this
    // token so yellow / passively faded words lose pinyin immediately instead of keeping
    // a stale ruby element until the whole chapter is rendered again.
    if (readerCanonicalLang(lang) === 'zh') {
      const pinyin = readerInlinePinyinForWord(word, lang);
      span.classList.toggle('rw-pinyin-on', !!pinyin);
      span.innerHTML = pinyin
        ? `<ruby class="reader-zh-ruby"><span class="reader-zh-hanzi">${readerEscape(word)}</span><rt>${readerEscape(pinyin)}</rt></ruby>`
        : readerEscape(word);
    }
  });
}

function readerTrackParagraphIndexSeen(index, opts = {}) {
  const book = readerCurrentBook?.();
  if (!book) return false;
  const ch = book.chapters?.[book.currentChapter || 0];
  const i = Number(index);
  if (!ch || !Number.isFinite(i) || i < 0 || i >= (ch.paragraphs || []).length) return false;
  const changed = readerTrackParagraphWords(book, ch, i, ch.paragraphs[i] || '');
  if (changed && opts.refresh !== false) readerRefreshParagraphWordClasses(i);
  return changed;
}

function readerBindVisibleParagraphTracking(scroller = null) {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  if (readerVisibleParagraphObserver) {
    try { readerVisibleParagraphObserver.disconnect(); } catch {}
  }
  for (const t of readerVisibleParagraphTimers.values()) clearTimeout(t);
  readerVisibleParagraphTimers.clear();

  const items = [...root.querySelectorAll('.reader-paragraph')];
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.slice(0, 4).forEach(el => readerTrackParagraphIndexSeen(Number(el.dataset.p), { refresh: true }));
    return;
  }
  const rdScroller = scroller || document.querySelector('#reader-reading-view .rd-scroll') || null;
  readerVisibleParagraphObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const idx = Number(entry.target?.dataset?.p);
      if (!Number.isFinite(idx)) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.42) {
        if (readerVisibleParagraphTimers.has(idx)) return;
        const timer = setTimeout(() => {
          readerVisibleParagraphTimers.delete(idx);
          readerTrackParagraphIndexSeen(idx, { refresh: true });
        }, 420);
        readerVisibleParagraphTimers.set(idx, timer);
      } else {
        const timer = readerVisibleParagraphTimers.get(idx);
        if (timer) clearTimeout(timer);
        readerVisibleParagraphTimers.delete(idx);
      }
    });
  }, { root: rdScroller, threshold: [0.15, 0.42, 0.65, 0.9] });
  items.forEach(el => readerVisibleParagraphObserver.observe(el));
}

function readerWordStateKey(word, lang = null) { return readerWordState.key(word, lang); }

function readerIsCommonWord(word, lang = null) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  const w = readerNormalizeWord(word, l);
  if (!w) return true;
  if (l === 'zh') return false;
  return w.length <= 1 || READER_COMMON_WORDS.has(w) || READER_COMMON_WORDS.has(w.replace(/^l'/,''));
}

function readerGetWordState(word, lang = null) { return readerWordState.get(word, lang); }

function readerTouchWordState(word, lang = null) { return readerWordState.touch(word, lang); }

function readerTrackParagraphWords(book, ch, paragraphIndex, paragraphText) { return readerWordState.trackParagraph(book, ch, paragraphIndex, paragraphText); }

function readerMarkWordClicked(word, lang = null) { return readerWordState.markClicked(word, lang); }

function readerMarkWordSaved(word, lemma = null, lang = null, ru = '') { return readerWordState.markSaved(word, lemma, lang, ru); }

function readerMarkWordKnown(word, lang = null) { return readerWordState.markKnown(word, lang); }

function readerWordVisual(word, lang = null) { return readerWordState.visual(word, lang); }

function readerWordStatusRu(st) { return readerWordState.statusRu(st); }

function readerExtractPinyin(data = {}) {
  return String(data.pinyin || data.py || data.pinyin_marked || data.pinyinTone || '').trim();
}

function readerShouldShowInlinePinyin(word, lang = null) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  if (l !== 'zh') return false;
  const norm = readerNormalizeWord(word, l);
  if (!norm) return false;
  const st = loadReaderWordState()[readerWordStateKey(norm, l)];
  if (st?.known || st?.status === 'known') return false;

  const mode = readerZhPinyinMode();
  if (mode === 'off') return false;

  const explicitStatus = String(st?.status || '').trim().toLowerCase();
  const hasManualStatus = ['learning', 'problem', 'hard', 'familiar', 'looked', 'known'].includes(explicitStatus);
  const inWork = !!(
    explicitStatus === 'learning' ||
    explicitStatus === 'problem' ||
    explicitStatus === 'hard' ||
    explicitStatus === 'familiar' ||
    explicitStatus === 'looked' ||
    st?.saved ||
    (Number(st?.clicked || 0) > 0)
  );

  // Seen-only words include yellow and passively faded words: met often enough, but not opened/saved/marked.
  // Default state is literally named "new", so it must not be mistaken for an explicit manual status.
  // These words stop using the pinyin scaffold so reading gradually becomes less assisted without pretending
  // the word is learned.
  const seenOnlyYellow = !!(
    Number(st?.seen || 0) >= READER_SEEN_AFTER &&
    !st?.saved &&
    Number(st?.clicked || 0) <= 0 &&
    !hasManualStatus
  );

  if (mode === 'learning') return inWork;
  if (seenOnlyYellow) return false;

  // Default Chinese reading mode: show pinyin for new + in-work words, but not for yellow seen-only words.
  return true;
}

function readerInlinePinyinForWord(word, lang = null) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  if (l !== 'zh' || !readerShouldShowInlinePinyin(word, l)) return '';
  const cached = readerGetCachedLexical(word, l);
  const fromCache = cached ? readerExtractPinyin(cached) : '';
  if (fromCache) return fromCache;
  const local = readerLookupChineseWord(word);
  return local ? readerExtractPinyin(local) : '';
}

function showReaderViewedWords() {
  const store = loadReaderWordState();
  const rows = Object.values(store)
    .filter(st => st && !readerIsCommonWord(st.word))
    .sort((a,b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 220);
  let modal = document.getElementById('reader-viewed-words-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'reader-viewed-words-modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.72);align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;width:100%;max-width:760px;max-height:88vh;overflow:auto">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:1rem;font-weight:700">👀 Просмотренные слова</div>
          <div style="font-size:.78rem;color:var(--text-muted);line-height:1.45">Это локальный след читалки: встречи, клики, сохранения и авто-изучение. Ключ: <code>${READER_WORD_STATE_KEY}</code></div>
        </div>
        <button onclick="closeReaderViewedWords()" style="background:none;border:none;color:var(--text-muted);font-size:1.4rem;cursor:pointer">×</button>
      </div>
      ${rows.length ? `<div style="display:flex;flex-direction:column;gap:6px">
        ${rows.map(st => `
          <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:8px 10px">
            <div style="font-family:'Playfair Display',serif;font-size:1.04rem">${readerEscape(st.word || '')}</div>
            <div style="font-size:.76rem;color:var(--text-muted)">${readerEscape(readerWordStatusRu(st))}</div>
            <div style="font-size:.72rem;color:var(--text-dim)">встреч: ${st.seen || 0}</div>
            <div style="font-size:.72rem;color:var(--text-dim)">кликов: ${st.clicked || 0}</div>
          </div>`).join('')}
      </div>` : `<div style="padding:26px;text-align:center;color:var(--text-muted)">Пока нет просмотренных слов.</div>`}
    </div>`;
  modal.style.display = 'flex';
}

function closeReaderViewedWords() {
  const modal = document.getElementById('reader-viewed-words-modal');
  if (modal) modal.style.display = 'none';
}



function readerEscape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function readerId() {
  return 'book_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// v68.3: языковые рельсы для читалки. Французский остаётся поведением по умолчанию.
const READER_LANG_META = Object.freeze({
  fr: { code: 'fr', label: 'Français', short: 'FR', emoji: '🇫🇷', speech: 'fr-FR' },
  zh: { code: 'zh', label: '中文', short: 'ZH', emoji: '🇨🇳', speech: 'zh-CN' },
  en: { code: 'en', label: 'English', short: 'EN', emoji: '🇬🇧', speech: 'en-US' },
  es: { code: 'es', label: 'Español', short: 'ES', emoji: '🇪🇸', speech: 'es-ES' },
});

function readerCanonicalLang(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn' || raw === 'chinese') return 'zh';
  if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en';
  if (raw === 'es' || raw.startsWith('es-') || raw === 'spanish') return 'es';
  return 'fr';
}

function readerBookLang(book = null) {
  return readerCanonicalLang(book?.lang || book?.sourceLang || 'fr');
}

function readerCurrentLang() {
  return readerBookLang(readerCurrentBook?.() || null);
}

function readerLangMeta(lang) {
  return READER_LANG_META[readerCanonicalLang(lang)] || READER_LANG_META.fr;
}

function readerLangBadge(lang) {
  const m = readerLangMeta(lang);
  return `${m.emoji} ${m.short}`;
}

function readerNormalizeWord(word, lang = null) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  if (l === 'zh') {
    return String(word || '')
      .normalize('NFC')
      .replace(/^[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】\[\]{}…—\-]+|[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】\[\]{}…—\-]+$/g, '')
      .trim();
  }
  // Latin-1 accented range covers French, English and Spanish (á í ó ú ñ Ñ ¿ ¡
  // are stripped as punctuation only when not letters — ñ/Ñ and á/í/ó/ú fall
  // inside À-ÖØ-öø-ÿ, so trimming a Spanish word's edges no longer eats them.
  return String(word || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/^[^a-zà-öø-ÿœæ'-]+|[^a-zà-öø-ÿœæ'-]+$/gi, '')
    .replace(/[’`´]/g, "'")
    .trim();
}

function readerTokenizeChineseParagraph(text) {
  const s = String(text || '');
  if (!s) return [];
  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: true });
  const key = readerTextHash(s);
  const cached = loadReaderZhSegmentCache()[key];
  const local = readerSegmentChineseLocal(s);
  if (Array.isArray(cached?.words) && cached.words.length) {
    return readerChooseBestChineseSegmentation(s, cached.words, local);
  }

  // Remote dictionary segmenter runs in background; reading never blocks.
  readerScheduleChineseSegmentation(s);

  if (local.length) return local;

  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter('zh', { granularity: 'word' });
      return Array.from(seg.segment(s), x => x.segment).filter(x => x !== '');
    }
  } catch {}
  return Array.from(s);
}


function readerTokenizeParagraph(p, lang = null) {
  if (p && typeof p === 'object') return [];
  const l = readerCanonicalLang(lang || readerCurrentLang());
  if (l === 'zh') return readerTokenizeChineseParagraph(p);
  // Keeps words clickable while preserving punctuation/spaces.
  // Supports French forms like n'essaierais-tu, qu'avec, s'arrêta.
  const word = `[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]+)*(?:-[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]+)*)*`;
  return String(p || '').match(new RegExp(`${word}|\\s+|[^\\sA-Za-zÀ-ÖØ-öø-ÿŒœÆæ’'-]+|[’'-]`, 'g')) || [];
}

function readerSplitIntoSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?…。！？]+[.!?…。！？»”"]*|[^.!?…。！？]+$/g) || [clean];
  return parts.map(x => x.trim()).filter(Boolean);
}

function readerChunkLongParagraph(paragraph, maxLen = 380) {
  if (paragraph && typeof paragraph === 'object') return [paragraph];
  const p = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!p) return [];
  const sentences = readerSplitIntoSentences(p);
  if (p.length <= maxLen || sentences.length <= 1) return [p];

  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (!cur) cur = s;
    else if ((cur + ' ' + s).length <= maxLen) cur += ' ' + s;
    else { chunks.push(cur); cur = s; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function readerCleanCorruptedImageParagraphs(book) {
  if (!book || book._v71ImgClean) return false;
  book._v71ImgClean = true;
  let changed = false;
  for (const ch of (book.chapters || [])) {
    const filtered = (ch.paragraphs || []).filter(p => p !== '[object Object]');
    if (filtered.length !== ch.paragraphs.length) { ch.paragraphs = filtered; changed = true; }
  }
  return changed;
}

// Books imported while the EPUB entity-soup bug was live (v76.52–.53) have
// literal tags (</p><p class="p1">) and/or encoded entities (&lt;p&gt;,
// &quot;) baked into their SAVED paragraphs. Heal them when the book is
// opened, so nothing has to be deleted and re-imported. One-shot per book.
function readerCleanEntitySoupParagraphs(book) {
  // v2 flag: the first heal version missed chapter titles — rerun once on
  // books it already touched.
  if (!book || book._v76SoupClean2) return false;
  book._v76SoupClean2 = true;
  const tagRe = /<\/?(?:p|div|span|a|link|html|body|head|h[1-6]|br|img|section|blockquote|li|ul|ol|title|style|meta)\b[^>]*\/?\s*>/gi;
  const entityRe = /&(?:lt|gt|quot|amp|#\d+|#x[0-9a-f]+);/i;
  const hasSoup = (text) => { tagRe.lastIndex = 0; return tagRe.test(text) || entityRe.test(text); };
  const cleanText = (raw) => {
    let text = String(raw || '');
    // Decode entities first (possibly double-encoded) — textarea parsing is
    // RCDATA, so any REAL tags already present stay literal text, untouched.
    for (let i = 0; i < 3 && entityRe.test(text); i++) {
      const ta = document.createElement('textarea');
      ta.innerHTML = text;
      text = ta.value;
    }
    tagRe.lastIndex = 0;
    return text.replace(tagRe, ' ').replace(/\s+/g, ' ').trim();
  };
  const isZh = readerCanonicalLang(book.lang || book.sourceLang || 'fr') === 'zh';
  let changed = false;
  for (const ch of (book.chapters || [])) {
    // Chapter titles are what the library card displays — they were built from
    // the same soup and must be healed too, not just the paragraphs.
    if (typeof ch.title === 'string' && hasSoup(ch.title)) {
      const cleanTitle = cleanText(ch.title).slice(0, 120);
      ch.title = cleanTitle || 'Глава';
      changed = true;
    }
    const paragraphs = ch.paragraphs || [];
    if (!paragraphs.some(p => typeof p === 'string' && hasSoup(p))) continue;
    changed = true;
    if (Array.isArray(ch.paragraphTimestamps) && ch.paragraphTimestamps.length === paragraphs.length) {
      // Audio-synced chapter: clean in place, never split/drop, so the
      // paragraph↔timestamp mapping stays 1:1.
      ch.paragraphs = paragraphs.map(p => (typeof p === 'string' && hasSoup(p)) ? (cleanText(p) || p) : p);
    } else {
      const next = [];
      for (const p of paragraphs) {
        if (typeof p !== 'string' || !hasSoup(p)) { next.push(p); continue; }
        const text = cleanText(p);
        if (text) next.push(...readerChunkLongParagraph(text, isZh ? 150 : 420));
      }
      ch.paragraphs = next;
    }
  }
  if (changed && typeof book.title === 'string' && hasSoup(book.title)) book.title = cleanText(book.title) || book.title;
  return cha…28512 tokens truncated…ss="rg-note">${readerEscape([ch.role, ch.grammar || ch.pinyin].filter(Boolean).join(' · ') || ch.ru || '')}</span>
            </div>`).join('')}
        </div>` : ''}
        ${notes.length ? `<div class="reader-grammar-notes">${notes.slice(0,4).map(n => `<span>${readerEscape(n)}</span>`).join('')}</div>` : ''}
      </div>
    </details>`;
  }

  if (!parts.length && !whys.length && !summary) return '';

  const colors = ['#7eb8f0','#e8a86a','#8fd49c','#c49df0','#f0d46a'];

  const partsHTML = parts.length ? `
    <div class="ra2-map">
      <div class="ra2-map-label">из чего состоит</div>
      ${parts.map((p, idx) => {
        const col  = colors[idx % colors.length];
        const text = readerEscape(p.en || p.fr || p.zh || p.text || '');
        const pinyin = p.pinyin ? `<div class="ra2-pinyin">${readerEscape(p.pinyin)}</div>` : '';
        return `
        <div class="ra2-part" style="border-left-color:${col}">
          <div class="ra2-fr" style="color:${col}">${text}${pinyin}</div>
          <div class="ra2-body">
            <div class="ra2-what">${readerEscape(p.what || '')}</div>
            ${p.why ? `<div class="ra2-why">${readerEscape(p.why)}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  const whysHTML = whys.length ? `
    <div class="ra2-whys">
      ${whys.map(w => `
        <div class="ra2-why-card">
          <div class="ra2-why-q">${readerEscape(w.q || '')}</div>
          <div class="ra2-why-a">${readerEscape(w.a || '')}</div>
        </div>`).join('')}
    </div>` : '';

  const summaryHTML = summary ? `
    <div class="ra2-summary"><span class="ra2-summary-label">суть</span>${readerEscape(summary)}</div>` : '';

  return `
    <details class="reader-help-block reader-sentence-analysis ra2-block">
      <summary>🧩 разбор <span>показать</span></summary>
      <div class="reader-help-body">
        ${partsHTML}${whysHTML}${summaryHTML}
      </div>
    </details>`;
}

// ════════════════════════════════════════════════════════
//  SONG MODE  — render, events, AI strophe meaning
// ════════════════════════════════════════════════════════

function renderSongSection(book, ch, paragraphs, activePi) {
  const typeClass = { chorus: 'song-chorus', bridge: 'song-bridge', intro: 'song-intro', outro: 'song-outro' }[ch.sectionType] || '';
  const stropheKey = ch.id;
  const stropheMeaning = book.songMeanings?.[stropheKey];
  const translations = book.readerTranslations || {};
  const analyses = book.readerAnalyses || {};

  const linesHTML = paragraphs.map((line, i) => {
    const trKey = `${ch.id}:${i}`;
    const tr = translations[trKey];
    const analysis = analyses[trKey];
    const isActive = i === activePi;
    return `
    <div class="reader-paragraph song-line ${isActive ? 'active' : ''}" data-p="${i}">
      <div class="reader-paragraph-text song-line-text">${readerRenderParagraphText(line, i)}</div>
      ${isActive && tr && !readerTranslationsHidden ? renderReaderTranslationBlock(tr) : ''}
      ${isActive && analysis && !readerTranslationsHidden ? renderReaderAnalysisBlock(analysis) : ''}
    </div>`;
  }).join('');

  const meaningHTML = stropheMeaning
    ? renderSongMeaningBlock(stropheMeaning, stropheKey, true)
    : `<div class="song-meaning-placeholder" data-sec="${readerEscape(stropheKey)}"></div>`;

  return `
    <div class="song-section-wrap">
      <div class="song-section-label">${readerEscape(ch.title)}</div>
      <div class="song-verse ${typeClass}">
        ${linesHTML}
      </div>
      <div class="song-strophe-actions">
        <button class="song-meaning-btn ${stropheMeaning ? 'loaded' : ''}" data-sec="${readerEscape(stropheKey)}" onclick="readerToggleSongMeaning(this)">
          ${stropheMeaning ? '💡 Смысл' : '💡 Смысл строфы'}
        </button>
      </div>
      ${meaningHTML}
    </div>`;
}

function renderSongMeaningBlock(data, secKey, visible) {
  const notes = (data.notes || []).map(n => `
    <div class="song-note"><span class="song-note-phrase">${readerEscape(n.phrase)}</span> — ${readerEscape(n.note)}</div>`).join('');
  return `
    <div class="song-meaning-block ${visible ? 'show' : ''}" id="smb-${readerEscape(secKey)}">
      <div class="song-meaning-label">смысл</div>
      <div class="song-meaning-text">${readerEscape(data.meaning || '')}</div>
      ${notes ? `<div class="song-meaning-notes">${notes}</div>` : ''}
    </div>`;
}

function bindSongStropheEvents(book, ch) {
  // nothing extra — onclick on button handles it
}

async function readerToggleSongMeaning(btn) {
  const book = readerCurrentBook();
  if (!book) return;
  const secKey = btn.dataset.sec;
  const ch = (book.chapters || []).find(c => c.id === secKey);

  // If already loaded — just toggle visibility
  const existing = document.getElementById('smb-' + secKey);
  if (existing) { existing.classList.toggle('show'); return; }

  // Load from AI
  btn.disabled = true;
  btn.textContent = '⏳ Разбираю…';

  // Collect all lines of this section
  const lines = ch ? ch.paragraphs.join('\n') : '';
  try {
    const result = await readerAI({ task: 'song_strophe', text: lines, sourceLang: readerBookLang(book), targetLang: 'ru' });
    if (!book.songMeanings) book.songMeanings = {};
    book.songMeanings[secKey] = result;
    saveReaderBooks();
    // Replace placeholder
    const placeholder = document.querySelector(`.song-meaning-placeholder[data-sec="${secKey}"]`);
    if (placeholder) {
      placeholder.outerHTML = renderSongMeaningBlock(result, secKey, true);
    }
    btn.textContent = '💡 Смысл';
    btn.classList.add('loaded');
  } catch (e) {
    btn.textContent = '💡 Смысл строфы';
    showToast('⚠️ Не удалось получить разбор');
  }
  btn.disabled = false;
}

window.readerToggleSongMeaning = readerToggleSongMeaning;


async function readerAnalyzeParagraphAI(i = null) {
  const index = i == null ? (readerCurrentBook()?.currentParagraph || 0) : i;
  const text = readerCurrentParagraphText(index);
  const book = readerCurrentBook();
  const ch = book?.chapters?.[book.currentChapter || 0];
  if (!text || !book || !ch) return;
  showToast('⏳ DeepSeek разбирает предложение...');
  try {
    const d = await readerAI({ task: 'analyze_sentence', text, sourceLang: readerBookLang(book), targetLang: 'ru' });
    const payload = d.data || d;
    book.readerAnalyses = book.readerAnalyses || {};
    book.readerAnalyses[`${ch.id}:${index}`] = payload;
    readerTranslationsHidden = false;
    localStorage.setItem(READER_HIDE_TRANSLATIONS_KEY, '0');
    applyReaderTranslationVisibility();
    book.currentParagraph = index;
    book.updatedAt = new Date().toISOString();
    saveReaderBooks();
    renderReaderChapter();
    showToast('✅ Разбор добавлен под предложением');
  } catch(e) {
    const msg = e?.message || String(e);
    showToast('⚠️ Разбор не сработал');
    alert('DeepSeek не сработал для разбора предложения.\n\nПроверь reader-ai и DEEPSEEK_API_KEY.\n\nОшибка: ' + msg);
  }
}


async function readerTranslateParagraphAI(i = null, opts = {}) {
  const silent = !!opts.silent;
  const index = i == null ? (readerCurrentBook()?.currentParagraph || 0) : i;
  const text = readerCurrentParagraphText(index);
  const book = readerCurrentBook();
  const ch = book?.chapters?.[book.currentChapter || 0];
  if (!text || !book || !ch) return;
  if (!silent) showToast('⏳ DeepSeek переводит абзац...');
  try {
    const d = await readerAI({ task: 'translate_paragraph', text, sourceLang: readerBookLang(book), targetLang: 'ru' });
    const ru = translationValueText(d);
    if (!ru) throw new Error('Пустой ответ от DeepSeek');
    book.readerTranslations = book.readerTranslations || {};
    book.readerTranslations[`${ch.id}:${index}`] = ru;
    readerTranslationsHidden = false;
    localStorage.setItem(READER_HIDE_TRANSLATIONS_KEY, '0');
    applyReaderTranslationVisibility();
    book.currentParagraph = index;
    book.updatedAt = new Date().toISOString();
    saveReaderBooks();
    renderReaderChapter();
    if (!silent) showToast('✅ Перевод добавлен под абзацем');
  } catch(e) {
    // A background auto-translate failing quietly is fine — the 🌐 button
    // still works manually, and a popup mid-read would be far more disruptive
    // than just not having this one paragraph's translation yet.
    if (silent) return;
    const msg = e?.message || String(e);
    showToast('⚠️ DeepSeek не сработал');
    alert('DeepSeek не сработал для перевода абзаца.\n\nСкорее всего, не развернута Supabase Edge Function reader-ai или нет DEEPSEEK_API_KEY.\n\nОшибка: ' + msg);
  }
}

// Auto-translate whichever paragraph is actually ACTIVE (selected), not just
// "the next one" — readerSchedulePrefetch()/readerPrefetchNext() only ever
// warmed the translation for currentParagraph+1, so reading fast, skipping a
// paragraph, or going backward all landed on an untranslated paragraph with
// no fetch in flight for it at all. This runs on every render (paragraph
// selection, next/prev, chapter change) and silently fills in the gap.
const readerAutoTranslateInFlight = new Set();
function readerAutoTranslateActiveParagraph(index) {
  if (readerTranslationsHidden) return;
  if (typeof isGuest !== 'undefined' && isGuest) return;
  const book = readerCurrentBook();
  if (!book) return;
  const ch = book.chapters?.[book.currentChapter || 0];
  if (!ch) return;
  const key = `${ch.id}:${index}`;
  if (book.readerTranslations?.[key]) return;
  if (readerAutoTranslateInFlight.has(key)) return;
  readerAutoTranslateInFlight.add(key);
  readerTranslateParagraphAI(index, { silent: true }).finally(() => readerAutoTranslateInFlight.delete(key));
}

async function readerTranslateWordAI(forceOrOptions = true) {
  const opts = (forceOrOptions && typeof forceOrOptions === 'object') ? forceOrOptions : { force: forceOrOptions };
  const force = opts.force !== false;
  const skipLocal = !!opts.skipLocal;
  const panel = ensureReaderWordPanel();
  const word = readerSelectedWord;
  const st = panel.querySelector('#reader-word-status');
  const contextEl = panel.querySelector('#reader-word-context');

  try {
    if (!word) throw new Error('Слово не выбрано');

    if (force) {
      readerRenderWordLoading('⏳ DeepSeek заново разбирает слово...');
      if (st) { st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = '⏳ DeepSeek готовит разбор...'; }
    } else if (st) {
      st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = skipLocal ? '⏳ DeepSeek добирает русский смысл...' : '⏳ DeepSeek готовит разбор...';
    }

    if (!force && !skipLocal) {
      const local = await readerLookupWord(word);
      if (local) {
        readerRenderWordAnalysis(local, 'local');
        if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = local._note ? `✅ ${local._note}` : '✅ Нашёл в локальной базе.'; }
        return local;
      }
    }

    const cached = !force ? readerGetCachedLexical(word, readerCurrentLang()) : null;
    if (cached && (!skipLocal || readerHasRussianMeaning(cached))) {
      readerRenderWordAnalysis(cached, 'cache');
      if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = '⚡ Из локального кэша'; }
      return cached;
    }

    const context = contextEl?.value || readerSentenceContext(readerCurrentParagraphText(readerSelectedParagraphIndex), word, readerCurrentLang());
    const sourceLang = readerCurrentLang();
    const localZhHint = sourceLang === 'zh' ? (readerLookupChineseWord(word) || readerGetCachedLexical(word, 'zh') || {}) : {};
    const inFlightKey = readerLexicalCacheKey(word, readerCurrentLang()) + '|' + normalizeImportKey(context.slice(0, 80));
    let data;
    if (!force && readerLexicalInFlight.has(inFlightKey)) {
      data = await readerLexicalInFlight.get(inFlightKey);
    } else {
      const p = readerAI({
        task: 'reader_word',
        sourceLang,
        word,
        surface: word,
        context,
        instruction: sourceLang === 'zh'
          ? 'Return JSON only: {pos, lemma, surface, pinyin, ru, level, form_note, note, chars}. For Chinese, give pinyin with tone marks and a short Russian meaning. "chars" is a compact per-character breakdown for 2+ character words (empty for single characters). No gender.'
          : sourceLang === 'en'
            ? 'Return JSON only: {pos:"noun|verb|adjective|adverb|preposition|pronoun|other", lemma, ru, level:"A1|A2|B1|B2", form_note, note}. Give a short Russian meaning in ru. For verbs, lemma is the base/infinitive form. No gender needed.'
            : sourceLang === 'es'
              ? 'Return JSON only: {pos:"noun|verb|adjective|adverb|preposition|pronoun|other", lemma, infinitive, ru, gender:"m|f|", level:"A1|A2|B1|B2", tense, person, number, form_note, note}. For Spanish conjugated verb forms, lemma and infinitive must be the infinitive (reflexive verbs keep "-se"); explain the selected surface form in form_note. For nouns, give gender.'
              : 'Return JSON only: {pos:"noun|verb|adjective|adverb|preposition|pronoun|other", lemma, infinitive, ru, gender:"m|f|", level:"A1|A2|B1|B2", tense, person, number, form_note, note}. For French conjugated verb forms, lemma and infinitive must be the infinitive; explain the selected surface form in form_note. For nouns, give gender.'
      });
      if (!force) readerLexicalInFlight.set(inFlightKey, p);
      try { data = await p; }
      finally { readerLexicalInFlight.delete(inFlightKey); }
    }

    const d = data.data || data;
    const pos = readerSimplifyPos(d.pos || d.type || (d.infinitive || d.inf ? 'verb' : 'noun'));
    const payload = {
      ...d,
      lang: readerCurrentLang(),
      pos,
      lemma: d.lemma || d.infinitive || d.inf || d.fr || word,
      ru: d.ru || d.translations || d.meaning || d.suggestion || '',
      gender: pos === 'noun' ? (d.gender || '') : '',
      level: d.level || (readerCurrentLang() === 'zh' ? 'HSK?' : 'A2'),
      pinyin: d.pinyin || d.py || d.pinyin_marked || localZhHint.pinyin || '',
      en: d.en || d.english || localZhHint.en || localZhHint.english || '',
      traditional: d.traditional || localZhHint.traditional || '',
      form_note: d.form_note || d.pinyin || d.tense || d.note || localZhHint.note || ''
    };
    readerPutCachedLexical(word, payload, readerCurrentLang());
    readerRenderWordAnalysis(payload, 'deepseek');
    if (readerCurrentLang() === 'zh') setTimeout(() => { try { renderReaderChapter(); } catch {} }, 0);
    if (st) {
      st.style.display = 'block';
      st.style.color = 'var(--good)';
      st.textContent = pos === 'verb'
        ? `✅ Глагольная форма: ${payload.lemma}`
        : pos === 'noun'
          ? `✅ Существительное${payload.gender ? ', род: ' + payload.gender : ''}`
          : `✅ ${readerPosRu(pos)}`;
    }
    return payload;
  } catch(e) {
    const msg = e?.message || String(e);
    readerRenderWordError('DeepSeek не сработал: ' + msg);
    if (st) { st.style.display = 'block'; st.style.color = 'var(--bad)'; st.textContent = '❌ DeepSeek не сработал: ' + msg; }
    throw e;
  }
}


// ── Reader window exports ──
window.renderReaderScreen   = renderReaderScreen;
window.showReaderImportModal = showReaderImportModal;
window.closeReaderImportModal = closeReaderImportModal;
window.readerCurrentLang = readerCurrentLang;
window.readerBookLang = readerBookLang;
window.readerTokenizeParagraph = readerTokenizeParagraph;
window.readerImportFromFile = readerImportFromFile;
window.saveReaderImport = saveReaderImport;
window.readerOpenBook = readerOpenBook;
window.readerBackToLibrary = readerBackToLibrary;
window.readerToggleDisplayPanel = readerToggleDisplayPanel;
window.readerCloseDisplayPanel = readerCloseDisplayPanel;
window.rdSetFont  = rdSetFont;
window.rdSetSize  = rdSetSize;
window.rdSetLH    = rdSetLH;
window.rdSetTheme = rdSetTheme;
window.rdSetPageAnimation = rdSetPageAnimation;
window.rdSetVoiceEngine = rdSetVoiceEngine;
window.rdSetVoice = rdSetVoice;
window.readerNextChapter = readerNextChapter;
window.readerPrevChapter = readerPrevChapter;
window.readerOpenToc     = readerOpenToc;
window.readerCloseToc    = readerCloseToc;
window.readerGoToChapter = readerGoToChapter;
window.readerPrevParagraph = readerPrevParagraph;
window.readerNextParagraph = readerNextParagraph;
window.readerSpeakParagraph = readerSpeakParagraph;
window.readerSpeakCurrentParagraph = readerSpeakCurrentParagraph;
window.readerSpeakChapter = readerSpeakChapter;
window.readerSpeakText = readerSpeakText;
window.readerStopSpeech = readerStopSpeech;
window.readerCopyParagraph = readerCopyParagraph;
window.readerCopyCurrentParagraph = readerCopyCurrentParagraph;
window.readerDeleteBook = readerDeleteBook;
window.readerSetComprehension = readerSetComprehension;
window.readerSpeakSelectedWord = readerSpeakSelectedWord;
window.readerSpeakSelectedContext = readerSpeakSelectedContext;
window.readerPrefillAddVerbFromPanel = readerPrefillAddVerbFromPanel;
window.readerSendParagraphToPhrase = readerSendParagraphToPhrase;
window.readerSelectParagraph = readerSelectParagraph;
window.readerOpenWordPanel = readerOpenWordPanel;
window.readerCloseWordPanel = readerCloseWordPanel;
window.closeReaderWordPanel = readerCloseWordPanel;
window.readerSaveWord = readerSaveWord;
window.readerTranslateWordAI = readerTranslateWordAI;
window.readerTranslateParagraphAI = readerTranslateParagraphAI;
window.readerAnalyzeParagraphAI = readerAnalyzeParagraphAI;
window.readerAction = readerAction;

// ── v66 reader: compact controls glue (presentation only) ──
const READER_TTS_RATES = [0.8, 1, 1.25, 1.5, 1.75];
function readerTtsRateLabel(r) {
  return (Math.round(r * 100) / 100).toString().replace(/(\.\d)0$/, '$1') + '×';
}

function readerListenSetBtn(playing) {
  const b = document.getElementById('reader-listen-btn');
  if (b) {
    // The mini-player's own ⏸ already covers stop/pause once playback starts
    // — showing a second "Стоп" button here at the same time was a duplicate
    // control. visibility:hidden (not display:none) keeps its grid column
    // reserved so the bottom bar's other buttons don't reflow into its slot.
    b.style.visibility = playing ? 'hidden' : '';
    b.classList.toggle('playing', playing);
    b.innerHTML = '🔊 Слушать';
  }
  // Persistent mini-player: docked above the bottom bar, only while
  // actually playing/paused-mid-listen — reading without TTS stays exactly
  // as quiet as before.
  const bar = document.getElementById('reader-tts-player');
  if (bar) bar.style.display = playing ? 'flex' : 'none';
  const playBtn = document.getElementById('reader-tts-playpause');
  if (playBtn) playBtn.textContent = playing ? '⏸' : '▶';
  const rateBtn = document.getElementById('reader-tts-rate');
  if (rateBtn) rateBtn.textContent = readerTtsRateLabel(getTtsRate());
  try { window.__rdMeasureChrome?.(); } catch (_) {}
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (_) {}
  }
}

function readerSetupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    const book = readerCurrentBook();
    const chapter = book?.chapters?.[book.currentChapter || 0];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book?.title || 'Reader AI',
      artist: chapter?.title || '',
    });
    navigator.mediaSession.setActionHandler('play', () => readerListenToggle());
    navigator.mediaSession.setActionHandler('pause', () => readerListenToggle());
    navigator.mediaSession.setActionHandler('previoustrack', () => readerTtsSkip(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => readerTtsSkip(1));
  } catch (_) {}
}

// Warm the NEXT paragraph's audio while the current one is being fetched/
// played — Kokoro generation can take up to a minute under provider load,
// and without this that whole wait re-occurred between every two paragraphs.
// Mirrors readerAudio.speakText's exact text preparation (whitespace collapse
// + 900-char cut) so the prefetch fills the exact cache key playback reads.
function readerPrefetchNextParagraphSpeech() {
  try {
    const book = readerCurrentBook();
    if (!book) return;
    const chapter = book.chapters?.[book.currentChapter || 0];
    const paragraphs = chapter?.paragraphs || [];
    let next = (book.currentParagraph || 0) + 1;
    while (next < paragraphs.length && paragraphs[next] && typeof paragraphs[next] === 'object') next++;
    const raw = next < paragraphs.length ? paragraphs[next] : null;
    if (!raw || typeof raw !== 'string') return;
    const clean = raw.replace(/\s+/g, ' ').trim().slice(0, 900);
    if (clean) prefetchSpeech(clean, { lang: readerBookLang(book) });
  } catch (_) {}
}

async function readerAutoPlay() {
  if (readerAutoPlayActive) return;
  readerAutoPlayActive = true;
  readerAutoPlayAbort = false;
  readerSetupMediaSession();
  readerListenSetBtn(true);
  try {
    while (!readerAutoPlayAbort) {
      readerPrefetchNextParagraphSpeech();
      const ok = await readerSpeakCurrentParagraph();
      if (!ok || readerAutoPlayAbort) break;

      // Pause between paragraphs
      await new Promise(r => setTimeout(r, 500));
      if (readerAutoPlayAbort) break;

      // Check if we're at the end of the book
      const book = readerCurrentBook();
      if (!book) break;
      const chapter = book.chapters?.[book.currentChapter || 0];
      const paragraphs = chapter?.paragraphs || [];
      const isLastParagraph = (book.currentParagraph || 0) >= paragraphs.length - 1;
      const isLastChapter = (book.currentChapter || 0) >= (book.chapters?.length || 1) - 1;
      if (isLastParagraph && isLastChapter) {
        showToast('📚 Конец текста');
        break;
      }

      // Advance — handles chapter transitions + scroll automatically
      readerNavigation.nextParagraph();
      readerSetupMediaSession();
      await new Promise(r => setTimeout(r, 150));
    }
  } finally {
    readerAutoPlayActive = false;
    readerAutoPlayAbort = false;
    readerListenSetBtn(false);
  }
}

function readerListenToggle() {
  if (readerAutoPlayActive) {
    readerAutoPlayAbort = true;
    readerStopSpeech(false);
    return;
  }
  readerAutoPlay().catch(e => console.error('[autoplay]', e));
}

// ── Player controls: skip by paragraph, cycle playback speed ──
function readerTtsSkip(delta) {
  const wasPlaying = readerAutoPlayActive;
  if (wasPlaying) { readerAutoPlayAbort = true; readerStopSpeech(false); }
  if (delta > 0) readerNavigation.nextParagraph();
  else readerNavigation.previousParagraph();
  if (wasPlaying) setTimeout(() => readerAutoPlay().catch(e => console.error('[autoplay]', e)), 60);
}
window.readerTtsSkip = readerTtsSkip;

function readerTtsCycleRate() {
  const cur = getTtsRate();
  const idx = READER_TTS_RATES.findIndex(r => Math.abs(r - cur) < 0.001);
  const next = READER_TTS_RATES[(idx + 1 + READER_TTS_RATES.length) % READER_TTS_RATES.length] ?? 1;
  setTtsRate(next);
  const btn = document.getElementById('reader-tts-rate');
  if (btn) btn.textContent = readerTtsRateLabel(next);
}
window.readerTtsCycleRate = readerTtsCycleRate;

// Generation can take up to a minute under provider load — show ⏳ on the
// mini-player's play/pause slot while audio is being generated, so the
// silence reads as "working on it", not "player froze". 'idle' is ignored
// on purpose: it fires between every pair of paragraphs in the autoplay
// loop, and the player's overall visibility is readerListenSetBtn's job.
window.addEventListener('an2-tts-state', (e) => {
  if (!readerAutoPlayActive) return;
  const btn = document.getElementById('reader-tts-playpause');
  if (!btn) return;
  if (e.detail === 'loading') btn.textContent = '⏳';
  else if (e.detail === 'playing') btn.textContent = '⏸';
});

function readerOpenMoreSheet() {
  document.getElementById('reader-sheet-back')?.classList.add('show');
  document.getElementById('reader-more-sheet')?.classList.add('show');
}
function readerCloseMoreSheet() {
  document.getElementById('reader-sheet-back')?.classList.remove('show');
  document.getElementById('reader-more-sheet')?.classList.remove('show');
}
window.readerListenToggle = readerListenToggle;
window.readerOpenMoreSheet = readerOpenMoreSheet;
window.readerCloseMoreSheet = readerCloseMoreSheet;
window.bindReaderParagraphEvents = bindReaderParagraphEvents;
window.toggleReaderTranslations = toggleReaderTranslations;
window.syncReaderCloudNow = syncReaderCloudNow;
window.showReaderViewedWords = showReaderViewedWords;
window.closeReaderViewedWords = closeReaderViewedWords;
window.readerMarkSelectedWordKnown = readerMarkSelectedWordKnown;
window.readerMarkSelectedWordProblem = readerMarkSelectedWordProblem;
window.readerCycleZhPinyinMode = readerCycleZhPinyinMode;
window.readerLookupChineseWord = readerLookupChineseWord;
window.readerEnsureZhCoreJsonLoaded = readerEnsureZhCoreJsonLoaded;
window.readerZhCoreJsonCount = readerZhCoreJsonCount;

// ════════════════════════════════════════════════

const READER_TENSES = [
  ['present', 'Présent'],
  ['passe', 'Passé composé'],
  ['imparfait', 'Imparfait'],
  ['futur', 'Futur simple'],
  ['plus_que_parfait', 'Plus-que-parfait'],
  ['conditionnel', 'Conditionnel'],
  ['subjonctif', 'Subjonctif'],
  ['imperatif', 'Impératif'],
  ['passe_simple', 'Passé simple'],
  ['participe', 'Participe passé'],
];

let readerImportDraftRows = [];

function normalizeReaderText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/[’]/g, "'")
    .replace(/[.,!?;:()\[\]«»\"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFrenchSubject(value) {
  return normalizeReaderText(value)
    .replace(/^j'\s*/i, '')
    .replace(/^j’\s*/i, '')
    .replace(/^(je|tu|il|elle|on|nous|vous|ils|elles)\s+/i, '')
    .trim();
}


const READER_SKIP_WORDS = new Set([
  'je','j','tu','il','elle','on','nous','vous','ils','elles','me','te','se','m','t','s','lui','leur','le','la','les','l','un','une','des','du','de','d','ce','cet','cette','ces','ça','ca','cela','ceci','celui','celle','ceux','celles','mon','ma','mes','ton','ta','tes','son','sa','ses','notre','votre','leur','leurs','qui','que','quoi','dont','où','ou','et','mais','donc','or','ni','car','ne','pas','plus','jamais','rien','tout','tous','toute','toutes','très','tres','bien','mal','ici','là','la','au','aux','en','y'
]);

function cleanImportedLexeme(value) {
  return normalizeReaderText(value)
    .replace(/^l['’]/, '')
    .replace(/^d['’]/, '')
    .replace(/^qu['’]/, '')
    .replace(/^(le|la|les|un|une|des|du|de|d)\s+/i, '')
    .trim();
}

function looksLikeUnknownFrenchVerbForm(value) {
  const w = stripFrenchSubject(cleanImportedLexeme(value));
  if (!w || w.length < 3) return false;
  // типичные личные формы, которые читалка часто отдаёт как "слово": buvait, faisaient, avaient, seraient...
  if (/(ais|ait|aient|ions|iez|erai|eras|era|erons|erez|eront|irai|iras|ira|irons|irez|iront|rai|ras|ra|rons|rez|ront|asse|asses|ât|assions|assiez|assent|isse|isses|ît|issions|issiez|issent)$/i.test(w)) return true;
  // passé simple / participe: fit, eut, fut и прочая книжная мелочь лучше в черновик, не в слова.
  if (/^(fus|fut|fûmes|fûtes|furent|eus|eut|eûmes|eûtes|eurent|fis|fit|fîmes|fîtes|firent)$/i.test(w)) return true;
  return false;
}

function classifyBadReaderWord(value) {
  const raw = normalizeReaderText(value);
  const cleaned = cleanImportedLexeme(raw);
  const bare = stripFrenchSubject(cleaned);
  if (!bare) return { bad:true, reason:'пусто после очистки' };
  if (READER_SKIP_WORDS.has(raw) || READER_SKIP_WORDS.has(cleaned) || READER_SKIP_WORDS.has(bare)) return { bad:true, reason:'служебное слово / местоимение' };
  if (looksLikeUnknownFrenchVerbForm(bare)) return { bad:true, reason:'похоже на форму глагола, но инфинитив не найден' };
  return { bad:false, cleaned: bare };
}

function cleanReaderContext(raw) {
  return String(raw || '')
    .replace(/answer\s*=\s*[^;\n]+/ig, '')
    .replace(/\s+;/g, ';')
    .trim();
}

function splitReaderContext(raw) {
  const examples = parseExamplesFromContext(cleanReaderContext(raw));
  const first = examples[0] || { fr: String(raw || '').trim(), ru: '' };
  return { fr: (first.fr || '').trim(), ru: (first.ru || '').trim() };
}

function escapeRegexLocal(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeGapPhraseFromContext(context, answer, originalForm = '') {
  const ctx = splitReaderContext(context).fr || String(context || '').trim();
  let fr = cleanReaderContext(ctx);
  const ans = String(answer || '').trim();
  const orig = String(originalForm || '').trim();
  if (!fr) return '___';
  if (fr.includes('___')) return fr;

  const attempts = [orig, ans, stripFrenchSubject(orig), stripFrenchSubject(ans)]
    .map(x => String(x || '').trim())
    .filter((x, i, arr) => x && arr.indexOf(x) === i)
    .sort((a,b) => b.length - a.length);

  for (const target of attempts) {
    const safe = escapeRegexLocal(target).replace(/\s+/g, '\\s+');
    const re = new RegExp(safe, 'i');
    if (re.test(fr)) return fr.replace(re, '___');
  }

  // Попытка для j'avais / J'avais: форма без j' внутри слитной записи.
  const bare = stripFrenchSubject(ans || orig);
  if (bare) {
    const reBare = new RegExp(escapeRegexLocal(bare), 'i');
    if (reBare.test(fr)) return fr.replace(reBare, '___');
  }

  // Лучше честный пропуск, чем сохранить фразу без места для ответа.
  return `___ · ${fr}`;
}

function getReaderAnswerFromRow(row, fallbackWord = '') {
  const explicit = pickField(row, ['Ответ','Answer','answer','Réponse','Reponse']);
  if (explicit) return explicit.trim();
  const form = pickField(row, ['Форма','Forme','Form','Слово','Word','word','fr','Французский','French']) || fallbackWord;
  return stripFrenchSubject(form) || String(form || '').trim();
}

function addFormCandidate(index, key, candidate) {
  const norm = normalizeReaderText(key);
  if (!norm || norm.length < 2) return;
  if (!index.has(norm)) index.set(norm, []);
  const bucket = index.get(norm);
  if (!bucket.some(c => c.verbId === candidate.verbId && c.tense === candidate.tense && c.answer === candidate.answer)) {
    bucket.push(candidate);
  }
}

function buildVerbFormIndex() {
  const index = new Map();
  const pronouns = ['je','tu','il','nous','vous','ils'];
  const avoir = ['ai','as','a','avons','avez','ont'];
  const etre = ['suis','es','est','sommes','êtes','sont'];

  for (const v of VERBS || []) {
    if (!v?.id) continue;
    const inf = v.inf || v.id;
    addFormCandidate(index, inf, { verbId:v.id, inf, tense:'infinitif', pronoun:'', answer:inf, label:`${inf} · infinitif` });

    const conj = v.conj || {};
    Object.entries(conj).forEach(([tense, forms]) => {
      if (!Array.isArray(forms)) return;
      forms.forEach((form, i) => {
        if (!form) return;
        const pron = pronouns[i] || '';
        const cand = { verbId:v.id, inf, tense, pronoun:pron, answer:String(form).trim(), label:`${inf} · ${tense}` };
        addFormCandidate(index, form, cand);
        if (pron) addFormCandidate(index, makeFrenchSubjectPhrase(pron, form), cand);
      });
    });

    if (v.pp) {
      const auxForms = v.aux === 'être' ? etre : avoir;
      auxForms.forEach((auxForm, i) => {
        const pron = pronouns[i] || '';
        const answer = `${auxForm} ${v.pp}`.trim();
        const cand = { verbId:v.id, inf, tense:'passe', pronoun:pron, answer, label:`${inf} · passé composé` };
        addFormCandidate(index, answer, cand);
        if (pron) addFormCandidate(index, makeFrenchSubjectPhrase(pron, answer), cand);
      });
      addFormCandidate(index, v.pp, { verbId:v.id, inf, tense:'participe', pronoun:'', answer:v.pp, label:`${inf} · participe passé` });
    }
  }
  return index;
}

function detectReaderCandidates(word, context, index) {
  const directKeys = [word, stripFrenchSubject(word)].filter(Boolean);
  for (const key of directKeys) {
    const hits = index.get(normalizeReaderText(key));
    if (hits?.length) return hits;
  }

  const ctx = normalizeReaderText(splitReaderContext(context).fr || context);
  if (ctx) {
    const hits = [];
    // Ищем самые длинные формы первыми, чтобы ai mangé победило ai.
    const entries = [...index.entries()].filter(([k]) => k.length > 2).sort((a,b) => b[0].length - a[0].length);
    for (const [k, candidates] of entries) {
      const re = new RegExp(`(^|\\s)${escapeRegexLocal(k)}($|\\s)`, 'i');
      if (re.test(ctx)) {
        candidates.forEach(c => { if (!hits.some(h => h.verbId===c.verbId && h.tense===c.tense && h.answer===c.answer)) hits.push(c); });
        if (hits.length >= 4) break;
      }
    }
    if (hits.length) return hits;
  }
  return [];
}

function buildReaderDraftRows(rows) {
  const index = buildVerbFormIndex();
  const verbIds = new Set((VERBS || []).map(v => v.id));
  return (rows || []).map((row, idx) => {
    const word = pickField(row, ['Форма','Forme','Form','Слово','Word','word','fr','Французский','French']).trim();
    if (!word) return null;
    const translation = pickField(row, ['Переводы','Перевод','Translations','Translation','ru','Русский','Meaning']);
    const transcription = pickField(row, ['Транскрипция','Transcription','Pronunciation']);
    const context = pickField(row, ['Контекст','Context','Example','Пример','Sentence','Phrase']);
    const level = pickField(row, ['Уровень','Level']) || 'A2';
    const explicitInf = pickField(row, ['Инфинитив','Infinitif','Infinitive','Verb','Глагол']);
    const explicitTense = pickField(row, ['Время','Tense','Temps']);
    const explicitType = pickField(row, ['Тип','Type']).toLowerCase();
    const answer = getReaderAnswerFromRow(row, word);
    const candidates = detectReaderCandidates(word, context, index);
    let best = candidates[0] || null;
    if (explicitInf) {
      const explicitId = normalizeImportKey(explicitInf);
      const localVerb = (VERBS || []).find(v => v.id === explicitId || normalizeImportKey(v.inf) === explicitId || normalizeReaderText(v.inf) === normalizeReaderText(explicitInf));
      best = { verbId: localVerb?.id || explicitId, inf: localVerb?.inf || explicitInf, tense: explicitTense || 'present', pronoun:'', answer, label:`${explicitInf} · ${explicitTense || 'present'}` };
    }
    let type = 'word';
    let selected = true;
    let importWarning = '';
    const badWord = classifyBadReaderWord(word);
    if (explicitType.includes('prep') || explicitType.includes('предлог') || explicitType.includes('construction') || explicitType.includes('конструк')) type = 'prep';
    else if (explicitType.includes('verb') || explicitType.includes('глаг') || best) type = 'verb_form';
    else if (badWord.bad) {
      type = looksLikeUnknownFrenchVerbForm(word) ? 'verb_form' : 'skip';
      selected = false;
      importWarning = badWord.reason;
    }
    if (best && !verbIds.has(best.verbId)) type = 'verb_form';
    return {
      idx,
      selected,
      source: word,
      translation,
      transcription,
      context,
      level,
      answer: answer || best?.answer || stripFrenchSubject(word),
      type,
      candidates,
      verbId: best?.verbId || '',
      tense: explicitTense || best?.tense || 'present',
      ambiguous: candidates.length > 1,
      knownVerb: !!best,
      importWarning,
    };
  }).filter(Boolean);
}

function ensureReaderDraftModal() {
  let modal = document.getElementById('reader-draft-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'reader-draft-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.76);align-items:center;justify-content:center;padding:12px;';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;width:100%;max-width:1120px;max-height:92vh;overflow:auto;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-size:1rem;font-weight:600;color:var(--text);margin-bottom:4px">📚 Черновик импорта из читалки</div>
          <div style="font-size:.78rem;color:var(--text-muted);line-height:1.45">Глагольные формы не станут отдельными глаголами. Они превратятся во фразы/примеры к инфинитиву. Неуверенные строки можно перекинуть в слова или пропустить.</div>
        </div>
        <button onclick="closeReaderDraftModal()" class="btn btn-secondary" style="padding:7px 10px;font-size:.78rem">×</button>
      </div>
      <div id="reader-draft-summary" style="font-size:.8rem;color:var(--text-muted);margin-bottom:10px"></div>
      <div id="reader-draft-table" style="display:grid;gap:8px"></div>
      <div id="reader-draft-status" style="display:none;font-size:.82rem;margin-top:12px;text-align:center;padding:8px;border-radius:8px;background:var(--surface2)"></div>
      <div style="display:flex;gap:8px;margin-top:14px;position:sticky;bottom:0;background:var(--surface);padding-top:10px">
        <button onclick="closeReaderDraftModal()" class="btn btn-secondary" style="flex:1">Отмена</button>
        <button onclick="saveReaderDraftImport()" class="btn btn-primary" style="flex:1">Сохранить выбранное</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function readerVerbOptions(selectedId = '') {
  const opts = [`<option value="">— не выбран —</option>`];
  [...(VERBS || [])].sort((a,b) => String(a.inf||a.id).localeCompare(String(b.inf||b.id),'fr')).forEach(v => {
    const id = String(v.id || normalizeImportKey(v.inf));
    opts.push(`<option value="${escapeHtmlLocal(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtmlLocal(v.inf || id)} — ${escapeHtmlLocal(v.meaning || '')}</option>`);
  });
  return opts.join('');
}

function readerTenseOptions(selected = 'present') {
  return READER_TENSES.map(([id, label]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function renderReaderDraftModal() {
  const modal = ensureReaderDraftModal();
  const table = modal.querySelector('#reader-draft-table');
  const summary = modal.querySelector('#reader-draft-summary');
  const rows = readerImportDraftRows || [];
  const verbForms = rows.filter(r => r.type === 'verb_form').length;
  const ambiguous = rows.filter(r => r.ambiguous).length;
  if (summary) summary.innerHTML = `Найдено строк: <b>${rows.length}</b> · глагольных форм: <b>${verbForms}</b> · неоднозначных: <b>${ambiguous}</b>`;
  if (!table) return;
  table.innerHTML = rows.map((r, i) => {
    const ctx = splitReaderContext(r.context);
    const warn = r.importWarning ? `⚠️ ${r.importWarning}` : (r.ambiguous ? '⚠️ неоднозначно' : (r.type === 'verb_form' && !r.knownVerb ? '⚠️ инфинитив не найден в базе' : ''));
    return `
      <div class="reader-row" data-i="${i}" style="border:1px solid var(--border);border-radius:12px;background:var(--surface2);padding:10px;display:grid;grid-template-columns:32px 1.15fr 1fr 1fr;gap:10px;align-items:start">
        <label style="display:flex;justify-content:center;padding-top:9px"><input type="checkbox" data-reader="selected" ${r.selected ? 'checked' : ''}></label>
        <div>
          <div style="font-family:'Playfair Display',serif;font-style:italic;font-size:1.05rem;color:var(--text);margin-bottom:4px">${escapeHtmlLocal(r.source)}</div>
          <div style="font-size:.78rem;color:var(--text-muted);margin-bottom:5px">${escapeHtmlLocal(r.translation || 'без перевода')}</div>
          ${warn ? `<div style="font-size:.72rem;color:var(--warn);margin-bottom:4px">${warn}</div>` : ''}
          ${r.candidates?.length ? `<div style="font-size:.72rem;color:var(--text-dim)">варианты: ${r.candidates.slice(0,3).map(c => escapeHtmlLocal(c.label || c.inf)).join('; ')}</div>` : ''}
        </div>
        <div style="display:grid;gap:6px">
          <select data-reader="type" class="select-control"><option value="verb_form" ${r.type==='verb_form'?'selected':''}>форма глагола → фраза</option><option value="word" ${r.type==='word'?'selected':''}>слово</option><option value="prep" ${r.type==='prep'?'selected':''}>предлог/конструкция</option><option value="skip" ${r.type==='skip'?'selected':''}>пропустить</option></select>
          <select data-reader="verbId" class="select-control">${readerVerbOptions(r.verbId)}</select>
          <select data-reader="tense" class="select-control">${readerTenseOptions(r.tense)}</select>
          <input data-reader="answer" value="${escapeHtmlLocal(r.answer || '')}" placeholder="ответ / форма" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem">
        </div>
        <div style="display:grid;gap:6px">
          <input data-reader="translation" value="${escapeHtmlLocal(r.translation || ctx.ru || '')}" placeholder="перевод" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem">
          <textarea data-reader="context" rows="3" placeholder="контекст" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem;resize:vertical">${escapeHtmlLocal(r.context || '')}</textarea>
          <input data-reader="transcription" value="${escapeHtmlLocal(r.transcription || '')}" placeholder="транскрипция/пометка" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem">
        </div>
      </div>`;
  }).join('');
  modal.style.display = 'flex';
}

window.closeReaderDraftModal = function() {
  const modal = document.getElementById('reader-draft-modal');
  if (modal) modal.style.display = 'none';
};

async function runReaderXlsxImportFromRows(rows, statusEl = null) {
  if (!VERBS_LOADED) await loadVerbsFromCloud({ force: true });
  readerImportDraftRows = buildReaderDraftRows(rows);
  if (!readerImportDraftRows.length) throw new Error('Не нашёл строк со столбцом «Слово» или «Форма».');
  if (statusEl) { statusEl.style.color = 'var(--good)'; statusEl.textContent = `✅ Черновик готов: ${readerImportDraftRows.length} строк`; }
  renderReaderDraftModal();
}

window.saveReaderDraftImport = async function() {
  const modal = ensureReaderDraftModal();
  const status = modal.querySelector('#reader-draft-status');
  try {
    if (!window.isAdmin || !window.isAdmin()) throw new Error('Импорт доступен только администратору.');
    const rowEls = [...modal.querySelectorAll('.reader-row')];
    const now = new Date().toISOString();
    const phrases = [];
    const nouns = [];
    const preps = [];
    const verbsToUpdate = new Map();
    let skipped = 0;

    for (const el of rowEls) {
      const selected = el.querySelector('[data-reader="selected"]')?.checked;
      if (!selected) { skipped++; continue; }
      const i = Number(el.dataset.i);
      const base = readerImportDraftRows[i] || {};
      const type = el.querySelector('[data-reader="type"]')?.value || base.type || 'word';
      if (type === 'skip') { skipped++; continue; }
      const source = base.source || '';
      const translation = el.querySelector('[data-reader="translation"]')?.value.trim() || base.translation || '';
      const transcription = el.querySelector('[data-reader="transcription"]')?.value.trim() || base.transcription || '';
      const context = el.querySelector('[data-reader="context"]')?.value.trim() || base.context || '';
      const answer = el.querySelector('[data-reader="answer"]')?.value.trim() || base.answer || stripFrenchSubject(source);
      const level = base.level || 'A2';

      if (type === 'verb_form') {
        const verbId = el.querySelector('[data-reader="verbId"]')?.value || base.verbId || '';
        const tense = el.querySelector('[data-reader="tense"]')?.value || base.tense || 'present';
        if (!verbId) { skipped++; continue; }
        const ctx = splitReaderContext(context);
        const fr = makeGapPhraseFromContext(context || source, answer, source);
        const id = normalizeImportKey(`${verbId}_${tense}_${answer}_${Date.now()}_${phrases.length}`);
        const phrase = { id, verb_id: verbId, tense, fr, answer, ru: translation || ctx.ru || '', level, custom:true, source:'reader_import', original_form: source, context: cleanReaderContext(context), created_at: now, updated_at: now };
        phrases.push(phrase);

        const verb = VERBS.find(v => v.id === verbId);
        if (verb) {
          const next = { ...verb, ex: { ...(verb.ex || {}) }, examples_by_tense: { ...(verb.examples_by_tense || {}) }, updated_at: now };
          const fullFr = fr.replace('___', answer);
          if (!next.ex[tense]) next.ex[tense] = fullFr;
          const arr = Array.isArray(next.examples_by_tense[tense]) ? [...next.examples_by_tense[tense]] : [];
          if (!arr.some(e => e.fr === fullFr)) arr.push({ fr: fullFr, ru: phrase.ru, answer, source:'reader_import', added_at: now });
          next.examples_by_tense[tense] = arr.slice(-12);
          verbsToUpdate.set(verbId, next);
        }
      } else if (type === 'prep') {
        const parsed = parsePrepConstruction(source);
        const id = normalizeImportKey(source);
        const examples = parseExamplesFromContext(context);
        preps.push({ id, fr: source, verb: parsed.verb, ru: translation, transcription, context, examples, level, preps:[{ prep: parsed.prep, meaning: translation, example_fr: examples[0]?.fr || '', example_ru: examples[0]?.ru || '' }], custom:true, source:'reader_import', updated_at: now });
      } else {
        const bad = classifyBadReaderWord(source);
        if (bad.bad) { skipped++; continue; }
        const cleanSource = bad.cleaned || cleanImportedLexeme(source) || source;
        const id = normalizeImportKey(cleanSource);
        const examples = parseExamplesFromContext(context);
        nouns.push({ id, fr: cleanSource, ru: translation, translations: translation, transcription, context, examples, gender:'m', theme:'reader', level, custom:true, source:'reader_import', updated_at: now });
      }
    }

    if (status) { status.style.display = 'block'; status.style.color = 'var(--accent)'; status.textContent = '⏳ Пишу в Firebase...'; }
    if (phrases.length) {
      const { error } = await sb.from('phrases').upsert(phrases);
      if (error) throw error;
    }
    if (nouns.length) {
      const { error } = await sb.from('nouns').upsert(nouns);
      if (error) throw error;
    }
    if (preps.length) {
      const { error } = await sb.from('prepositions').upsert(preps);
      if (error) throw error;
    }
    const verbUpdates = [...verbsToUpdate.values()];
    if (verbUpdates.length) {
      const { error } = await sb.from('verbs').upsert(verbUpdates);
      if (error) throw error;
    }

    if (phrases.length) {
      PHRASES_LOADED = false;
      await loadPhrasesFromCloud({ force: true });
    }
    if (verbUpdates.length) {
      VERBS_LOADED = false;
      await loadVerbsFromCloud({ force: true });
    }
    if (nouns.length) { setNounsLoaded(false); await loadNounsFromCloud(); dictNounsCache = nouns.concat(dictNounsCache.filter(x => !nouns.some(n => n.id === x.id))); }
    if (preps.length) { dictPrepsCache = preps.concat(dictPrepsCache.filter(x => !preps.some(p => p.id === x.id))); }
    try { Object.keys(localStorage).forEach(k => { if (k.startsWith('an2_cache_verbs') || k.startsWith('an2_cache_phrases')) localStorage.removeItem(k); }); } catch {}

    if (status) { status.style.color = 'var(--good)'; status.textContent = `✅ Сохранено: фраз ${phrases.length}, слов ${nouns.length}, конструкций ${preps.length}${skipped ? ` · пропущено ${skipped}` : ''}`; }
    showToast('✅ Импорт из читалки сохранён');
    setTimeout(() => {
      window.closeReaderDraftModal();
      if (phrases.length) { PHRASES_LOADED = false; window.renderPhrasesScreen?.(); }
      if (verbUpdates.length) { dictType = 'verbs'; window.setDictType?.('verbs'); }
      else if (nouns.length) { dictType = 'nouns'; window.setDictType?.('nouns'); }
      else if (preps.length) { dictType = 'preps'; window.setDictType?.('preps'); }
    }, 900);
  } catch(e) {
    if (status) { status.style.display = 'block'; status.style.color = 'var(--bad)'; status.textContent = '❌ ' + (e?.message || e); }
    else showToast('⚠️ ' + (e?.message || e));
  }
};

function ensureXlsxImportModal() {
  let modal = document.getElementById('xlsx-import-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'xlsx-import-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.72);align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:100%;max-width:640px;max-height:90vh;overflow-y:auto;">
      <div style="font-size:1rem;font-weight:600;color:var(--text);margin-bottom:4px">📥 Импорт XLSX</div>
      <div style="font-size:.78rem;color:var(--text-muted);line-height:1.5;margin-bottom:16px">Колонки: <b>Слово/Форма</b>, <b>Переводы</b>, <b>Транскрипция</b>, <b>Контекст</b>. Режим «из читалки» сначала покажет черновик: формы вроде <code>j'avais</code> привязываются к инфинитиву, а не плодятся как отдельные глаголы.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px"><div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Куда импортировать</label><select id="xlsx-import-type" class="select-control" style="width:100%"><option value="reader">Из читалки → черновик</option><option value="verbs">Глаголы</option><option value="nouns">Слова</option><option value="preps">Предлоги / конструкции</option></select></div><div><label style="font-size:.75rem;color:var(--text-muted);display:block;margin-bottom:6px">Файл</label><input id="xlsx-import-file" type="file" accept=".xlsx,.xls,.csv" style="width:100%;font-size:.8rem;color:var(--text-muted)"></div></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:.8rem;color:var(--text-muted);margin-bottom:12px"><input type="checkbox" id="xlsx-context-phrases" checked> Если в контексте есть <code>___</code> и <code>answer=...</code>, создать фразы</label>
      <div id="xlsx-import-status" style="display:none;font-size:.82rem;margin-bottom:12px;text-align:center;padding:8px;border-radius:8px;background:var(--surface2)"></div>
      <div style="display:flex;gap:8px"><button onclick="closeXlsxImportModal()" class="btn btn-secondary" style="flex:1">Отмена</button><button onclick="runXlsxImport()" class="btn btn-primary" style="flex:1">Импортировать</button></div>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

window.showXlsxImportModal = function(type = null) {
  if (window.guardGuest && window.guardGuest('Импорт XLSX')) return;
  if (!window.isAdmin || !window.isAdmin()) { showToast('🔒 Импорт доступен только администратору'); return; }
  const modal = ensureXlsxImportModal();
  const typeEl = modal.querySelector('#xlsx-import-type');
  if (typeEl) typeEl.value = type || (dictType === 'preps' ? 'preps' : dictType === 'verbs' ? 'verbs' : 'nouns');
  const fileEl = modal.querySelector('#xlsx-import-file'); if (fileEl) fileEl.value = '';
  const st = modal.querySelector('#xlsx-import-status'); if (st) { st.style.display = 'none'; st.textContent = ''; }
  modal.style.display = 'flex';
};
window.closeXlsxImportModal = function() { const modal = document.getElementById('xlsx-import-modal'); if (modal) modal.style.display = 'none'; };

window.runXlsxImport = async function() {
  const modal = ensureXlsxImportModal();
  const st = modal.querySelector('#xlsx-import-status');
  try {
    if (!window.XLSX) throw new Error('Библиотека XLSX не загрузилась. Проверь интернет и обнови страницу.');
    const file = modal.querySelector('#xlsx-import-file')?.files?.[0];
    if (!file) throw new Error('Выбери XLSX/CSV файл.');
    const type = modal.querySelector('#xlsx-import-type')?.value || 'nouns';
    const makePhrases = !!modal.querySelector('#xlsx-context-phrases')?.checked;
    if (st) { st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = '⏳ Читаю файл...'; }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) throw new Error('В файле нет строк.');
    if (type === 'reader') {
      await runReaderXlsxImportFromRows(rows, st);
      return;
    }
    const records = [];
    let phraseCount = 0;
    for (const row of rows) {
      const word = pickField(row, ['Слово','Word','word','fr','Французский','French']).trim();
      if (!word) continue;
      const translations = pickField(row, ['Переводы','Перевод','Translations','Translation','ru','Русский']);
      const transcription = pickField(row, ['Транскрипция','Transcription','Pronunciation']);
      const context = pickField(row, ['Контекст','Context','Example','Пример']);
      const level = pickField(row, ['Уровень','Level']) || 'A2';
      const examples = parseExamplesFromContext(context);
      if (type === 'verbs') {
        const id = normalizeImportKey(word);
        const present = parseFormsFlexible(pickField(row, ['Présent','Present','Настоящее','present']));
        const imparfait = parseFormsFlexible(pickField(row, ['Imparfait','imparfait']));
        const futur = parseFormsFlexible(pickField(row, ['Futur','Futur simple','futur']));
        const pp = pickField(row, ['PP','Participe passé','Participe passe','pp']);
        const aux = (pickField(row, ['Aux','Auxiliaire','aux']) || 'avoir').toLowerCase().includes('être') ? 'être' : 'avoir';
        const group = inferVerbGroup(word, pickField(row, ['Группа','Group','group']));
        const conj = {};
        if (present.length) conj.present = present;
        if (imparfait.length) conj.imparfait = imparfait;
        if (futur.length) conj.futur = futur;
        const ex = {};
        if (examples[0]?.fr) ex.present = examples[0].fr;
        const record = { id, inf: word, meaning: translations, translations, transcription, context, examples, group, group_name: group, aux, pp, conj, ex, level, custom:true, source:'xlsx', updated_at:new Date().toISOString() };
        records.push(record);
        if (makePhrases) { const ph = await maybeCreatePhraseFromContext({ context, verbId:id, tense:'present', translation: examples[0]?.ru || translations, level }); if (ph) phraseCount++; }
      } else if (type === 'nouns') {
        const bad = classifyBadReaderWord(word);
        if (bad.bad) continue;
        const cleanWord = bad.cleaned || cleanImportedLexeme(word) || word;
        const id = normalizeImportKey(cleanWord);
        const genderRaw = pickField(row, ['Род','Gender','gender']);
        const theme = pickField(row, ['Тема','Theme','theme']) || 'custom';
        records.push({ id, fr: cleanWord, ru: translations, translations, transcription, context, examples, gender: ['m','f'].includes(genderRaw) ? genderRaw : 'm', theme, level, custom:true, source:'xlsx', updated_at:new Date().toISOString() });
      } else {
        const parsed = parsePrepConstruction(word);
        const id = normalizeImportKey(word);
        records.push({ id, fr: word, verb: parsed.verb, ru: translations, transcription, context, examples, level, preps:[{ prep: parsed.prep, meaning: translations, example_fr: examples[0]?.fr || '', example_ru: examples[0]?.ru || '' }], custom:true, source:'xlsx', updated_at:new Date().toISOString() });
      }
    }
    if (!records.length) throw new Error('Не нашёл строк со столбцом «Слово».');
    const table = type === 'verbs' ? 'verbs' : type === 'nouns' ? 'nouns' : 'prepositions';
    if (st) st.textContent = `⏳ Пишу ${records.length} записей в Firebase...`;
    const { error } = await sb.from(table).upsert(records);
    if (error) throw error;
    if (type === 'verbs') { VERBS_LOADED = false; await loadVerbsFromCloud({ force: true }); dictType = 'verbs'; }
    if (type === 'nouns') { dictNounsCache = records.concat(dictNounsCache.filter(x => !records.some(r => r.id === x.id))); setNounsLoaded(false); await loadNounsFromCloud(); dictType = 'nouns'; }
    if (type === 'preps') { dictPrepsCache = records.concat(dictPrepsCache.filter(x => !records.some(r => r.id === x.id))); records.forEach(r => PREPS_DATA.push({ id:r.id, verb:r.verb, ru:r.ru, prep:r.preps?.[0]?.prep || '', example:r.examples?.[0]?.fr || r.fr, exru:r.examples?.[0]?.ru || r.ru, group:'custom' })); dictType = 'preps'; }
    try { Object.keys(localStorage).forEach(k => { if (k.startsWith('an2_cache_verbs') || k.startsWith('an2_cache_phrases')) localStorage.removeItem(k); }); } catch {}
    if (st) { st.style.color = 'var(--good)'; st.textContent = `✅ Импортировано: ${records.length}${phraseCount ? `, фраз из контекста: ${phraseCount}` : ''}`; }
    showToast('✅ XLSX импортирован');
    setTimeout(() => { window.closeXlsxImportModal(); window.setDictType(dictType); }, 800);
  } catch(e) {
    if (st) { st.style.display = 'block'; st.style.color = 'var(--bad)'; st.textContent = '❌ ' + (e?.message || e); }
    else showToast('⚠️ ' + (e?.message || e));
  }
};

// ════════════════════════════════════════════════
// v66.6 — reader: select words → translate selection,
//          + DeepSeek prefetch (next paragraph) and warm-keep.
//          All isolated and guarded; never throws into the reader.
// ════════════════════════════════════════════════
let readerLastSelection = '';
const readerSelectionCache = new Map();
let readerSelUpdateTimer = null;

function readerEnsureSelectionUI() {
  if (document.getElementById('reader-sel-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'reader-sel-btn';
  btn.type = 'button';
  btn.textContent = '🌐 Перевести';
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); });   // keep the selection alive
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); readerTranslateSelection(); });
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'reader-sel-panel';
  panel.innerHTML = `
    <div class="sel-fr" id="reader-sel-fr"></div>
    <div class="sel-ru" id="reader-sel-ru">—</div>
    <div class="sel-actions">
      <button id="reader-sel-speak" type="button">🔊 Озвучить</button>
      <button id="reader-sel-close" type="button">✕ Закрыть</button>
    </div>`;
  document.body.appendChild(panel);
  panel.querySelector('#reader-sel-speak').addEventListener('click', () => { if (readerLastSelection) readerSpeakText(readerLastSelection); });
  panel.querySelector('#reader-sel-close').addEventListener('click', readerCloseSelectionPanel);
}

function readerHideSelectionButton() {
  document.getElementById('reader-sel-btn')?.classList.remove('show');
}
function readerCloseSelectionPanel() {
  document.getElementById('reader-sel-panel')?.classList.remove('show');
}
function readerHideSelectionUI() {
  readerHideSelectionButton();
  readerCloseSelectionPanel();
}

function readerSelectionNodeInside(root, node) {
  if (!root || !node) return false;
  const el = node.nodeType === 1 ? node : (node.parentElement || node.parentNode);
  return !!(el && root.contains(el));
}

function readerNativeSelectionText() {
  try {
    const root = document.getElementById('reader-chapter-text');
    const view = document.getElementById('reader-reading-view');
    if (!root || !view || view.style.display === 'none') return '';
    const sel = window.getSelection?.();
    const text = sel ? String(sel).replace(/\s+/g, ' ').trim() : '';
    if (!sel || sel.isCollapsed || !text || !sel.rangeCount) return '';
    if (!readerSelectionNodeInside(root, sel.anchorNode) && !readerSelectionNodeInside(root, sel.focusNode)) return '';
    return text;
  } catch { return ''; }
}

function readerHasNativeSelectionInReader() {
  return !!readerNativeSelectionText();
}

function readerUpdateSelectionButton() {
  try {
    const root = document.getElementById('reader-chapter-text');
    const view = document.getElementById('reader-reading-view');
    if (!root || !view || view.style.display === 'none') { readerHideSelectionButton(); return; }
    const sel = window.getSelection?.();
    const text = readerNativeSelectionText();
    if (!sel || !text || !sel.rangeCount) { readerHideSelectionButton(); return; }
    if (text.length > 400) { readerHideSelectionButton(); return; }
    readerLastSelection = text;
    readerEnsureSelectionUI();
    const btn = document.getElementById('reader-sel-btn');
    let rect; try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
    if (!rect || (!rect.width && !rect.height)) { readerHideSelectionButton(); return; }
    const vw = window.innerWidth;
    let x = Math.max(64, Math.min(vw - 64, rect.left + rect.width / 2));
    let y = rect.top - 46;
    if (y < 56) y = rect.bottom + 10;
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    btn.classList.add('show');
  } catch { readerHideSelectionButton(); }
}
function readerScheduleSelUpdate() {
  clearTimeout(readerSelUpdateTimer);
  readerSelUpdateTimer = setTimeout(readerUpdateSelectionButton, 180);
}

async function readerTranslateSelection() {
  const text = (readerLastSelection || '').trim();
  if (!text) return;
  if (typeof isGuest !== 'undefined' && isGuest) { showToast('Перевод доступен после входа'); return; }
  readerHideSelectionButton();
  readerEnsureSelectionUI();
  const panel = document.getElementById('reader-sel-panel');
  const frEl = document.getElementById('reader-sel-fr');
  const ruEl = document.getElementById('reader-sel-ru');
  if (frEl) frEl.textContent = text;
  const key = text.toLowerCase();
  if (readerSelectionCache.has(key)) {
    if (ruEl) ruEl.textContent = readerSelectionCache.get(key);
    panel?.classList.add('show');
    return;
  }
  if (ruEl) ruEl.textContent = '⏳ DeepSeek переводит...';
  panel?.classList.add('show');
  try {
    const d = await readerAI({ task: 'translate_paragraph', text, sourceLang: readerBookLang(readerCurrentBook?.()), targetLang: 'ru' });
    const ru = translationValueText(d);
    if (!ru) throw new Error('пустой ответ');
    readerSelectionCache.set(key, ru);
    if (ruEl) ruEl.textContent = ru;
  } catch (e) {
    if (ruEl) ruEl.textContent = '⚠️ Не удалось перевести. ' + (e?.message || '');
  }
}

function installReaderSelectionTranslate() {
  if (window.__readerSelInstalled) return;
  window.__readerSelInstalled = true;
  readerEnsureSelectionUI();

  // Native browser selection is the main path. The old custom word-range
  // fallback remains below, but it must not kill normal text highlighting.
  document.addEventListener('selectionchange', () => {
    if (readerHasNativeSelectionInReader()) readerScheduleSelUpdate();
    else readerHideSelectionButton();
  });
  document.addEventListener('mouseup', readerScheduleSelUpdate, true);
  document.addEventListener('keyup', readerScheduleSelUpdate, true);
  document.addEventListener('touchend', readerScheduleSelUpdate, true);

  let active = false, decided = false, ranging = false, startWord = null, paraEl = null, sx = 0, sy = 0;
  const getRoot = () => document.getElementById('reader-chapter-text');
  const clearWordSel = () => { getRoot()?.querySelectorAll('.rw-sel').forEach(w => w.classList.remove('rw-sel')); };
  window.readerClearWordSelection = clearWordSel;

  const highlightTo = (curWord) => {
    if (!paraEl || !startWord) return;
    const words = Array.from(paraEl.querySelectorAll('.reader-word'));
    const a = words.indexOf(startWord), b = words.indexOf(curWord);
    if (a < 0 || b < 0) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    clearWordSel();
    for (let i = lo; i <= hi; i++) words[i].classList.add('rw-sel');
  };

  document.addEventListener('pointerdown', (e) => {
    try {
      const root = getRoot();
      const onUI = e.target.closest?.('#reader-sel-btn, #reader-sel-panel');
      const w = root && e.target.closest?.('.reader-word');
      if (!onUI) readerHideSelectionButton();
      if (!onUI && !w) clearWordSel();
      // In pages mode, a page-turn swipe almost always starts on top of a
      // word (most of the page is text) — letting word-range selection
      // engage there swallowed the gesture before bindReaderSwipe's
      // touchend ever saw it (it explicitly skips while __readerRanging is
      // set), which is exactly "страницы не всегда листаются". Selecting a
      // phrase to translate still works fine via native text selection.
      if (!root || !w || !root.contains(w) || readerPagesMode.isEnabled()) { active = false; return; }
      clearWordSel();
      active = true; decided = false; ranging = false; startWord = w;
      paraEl = w.closest('.reader-paragraph'); sx = e.clientX; sy = e.clientY;
    } catch { active = false; }
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!decided) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) { decided = true; ranging = true; window.__readerRanging = true; }
      else if (Math.abs(dy) > 12) { active = false; return; }   // vertical → let it scroll
      else return;
    }
    if (ranging) {
      // Do not preventDefault here: otherwise the browser cannot do normal
      // text selection. We still keep the custom word highlight as a fallback.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cur = el?.closest?.('.reader-word');
      if (cur && paraEl && paraEl.contains(cur)) highlightTo(cur);
    }
  }, { capture: true, passive: false });

  document.addEventListener('pointerup', () => {
    try {
      if (ranging) {
        const root = getRoot();
        const sel = root ? Array.from(root.querySelectorAll('.rw-sel')) : [];
        if (sel.length >= 1) {
          readerLastSelection = sel.map(x => x.textContent).join(' ').replace(/\s+/g, ' ').trim();
          window.__readerSuppressWordTap = true;     // this drag must not open the word panel
          const last = sel[sel.length - 1];
          const rect = last.getBoundingClientRect();
          const btn = document.getElementById('reader-sel-btn');
          if (btn) {
            const vw = window.innerWidth;
            btn.style.left = Math.max(64, Math.min(vw - 64, rect.left + rect.width / 2)) + 'px';
            let y = rect.top - 46; if (y < 56) y = rect.bottom + 10;
            btn.style.top = y + 'px';
            btn.classList.add('show');
          }
        }
      }
    } catch {}
    active = false; decided = false; ranging = false; startWord = null; paraEl = null;
    setTimeout(() => { window.__readerRanging = false; }, 80);
  }, true);
}

// ── DeepSeek prefetch (next paragraph) ──
let readerPrefetchTimer = null;
function readerSchedulePrefetch() {
  clearTimeout(readerPrefetchTimer);
  readerPrefetchTimer = setTimeout(() => { readerPrefetchNext().catch(() => {}); }, 800);
}
async function readerPrefetchNext() {
  try {
    if (typeof isGuest !== 'undefined' && isGuest) return;
    if (readerTranslationsHidden) return;          // only when translations are actively used
    const book = readerCurrentBook?.(); if (!book) return;
    const ch = book.chapters?.[book.currentChapter || 0]; if (!ch) return;
    const paras = ch.paragraphs || [];
    const next = (book.currentParagraph || 0) + 1;
    if (next >= paras.length) return;
    const key = `${ch.id}:${next}`;
    book.readerTranslations = book.readerTranslations || {};
    if (book.readerTranslations[key]) return;       // already cached
    const text = paras[next]; if (!text) return;
    const d = await readerAI({ task: 'translate_paragraph', text, sourceLang: readerBookLang(book), targetLang: 'ru' });
    const ru = translationValueText(d);
    if (ru) { book.readerTranslations[key] = ru; saveReaderBooks(); }
  } catch {}
}

// ── DeepSeek warm-keep disabled ──
// Было: readerAI({ task: 'translate_paragraph', text: 'Bonjour', ... })
// каждые 4 минуты во время чтения. Это съедало дневной лимит переводов.
// Функции оставлены как no-op, чтобы не трогать остальную логику читалки.
let readerWarmTimer = null;
function readerWarmPing() {
  return;
}
function readerStartWarm() {
  readerStopWarm();
}
function readerStopWarm() {
  if (readerWarmTimer) { clearInterval(readerWarmTimer); readerWarmTimer = null; }
}

// Немедленная синхронизация статусов слов при скрытии страницы (переключение вкладки, закрытие)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(_wordStateSyncTimer);
    syncWordStateToCloud().catch(() => {});
    // Reading-time tracker: close the open paragraph timer when the phone
    // locks / the app backgrounds mid-paragraph, same as leaving the reader
    // screen outright — otherwise resuming later and turning the page counts
    // the whole backgrounded stretch as reading time (closeParagraph() would
    // normally just discard it for exceeding the 300s cap, silently losing
    // whatever genuine reading happened before backgrounding too).
    if (document.getElementById('reader-reading-view')?.style.display !== 'none') {
      readerTimeParagraphClose();
    }
  } else if (document.visibilityState === 'visible') {
    if (document.getElementById('reader-reading-view')?.style.display !== 'none') {
      readerTimeParagraphOpen();
    }
    // Pull word marks saved on other devices whenever the app comes back to
    // the foreground (unlock, tab switch back), not just when navigating to
    // a specific screen — otherwise a device left open on e.g. the home
    // screen never sees words saved elsewhere until the user happens to
    // open a book or the dict screen.
    readerPullWordStateAndRepaint();
  }
});
let readerLastVisibleSyncAt = 0;
function readerPullWordStateAndRepaint() {
  // Throttled to avoid hammering the network on rapid visibility flicker /
  // frequent poll ticks.
  const now = Date.now();
  if (readerLastVisibleSyncAt && now - readerLastVisibleSyncAt < 5000) return;
  readerLastVisibleSyncAt = now;
  syncWordStateFromCloud().then(() => {
    try { readerRefreshParagraphWordClasses(); } catch (_) {}
    try {
      if (document.getElementById('screen-dict')?.classList.contains('active') && typeof window.renderReaderWords === 'function') {
        window.renderReaderWords(undefined, document.getElementById('dict-search')?.value || '');
      }
    } catch (_) {}
  }).catch(() => {});
}
// Two devices can both sit open and visible at once (e.g. phone and tablet
// side by side) — neither ever fires visibilitychange in that case, so a
// pull triggered only by foregrounding can miss marks saved on the other
// device indefinitely. Poll on a plain interval as a fallback whenever this
// tab is actually visible, so cross-device sync doesn't depend on the user
// switching tabs/apps at all.
setInterval(() => {
  if (document.visibilityState === 'visible') readerPullWordStateAndRepaint();
}, 20000);
// Extra flush alongside visibilitychange: some browsers fire pagehide on
// real navigation/tab-close without a preceding 'hidden' visibility change.
window.addEventListener('pagehide', () => {
  clearTimeout(_wordStateSyncTimer);
  syncWordStateToCloud().catch(() => {});
});


function readerZhEntryFromSources(word, st = null) {
  const w = readerNormalizeWord(word, 'zh');
  if (!w) return null;
  const cached = readerGetCachedLexical(w, 'zh') || {};
  const local = readerLookupChineseWord(w) || {};
  const data = { ...local, ...cached };
  return {
    word: w,
    lemma: readerNormalizeWord(data.lemma || data.word || w, 'zh') || w,
    pinyin: readerExtractPinyin(data),
    ru: String(data.ru || data.translation || data.meaning_ru || '').trim(),
    en: String(data.en || data.english || data.gloss || '').trim(),
    pos: data.pos || data.partOfSpeech || '',
    level: data.level || data.hsk || '',
    note: data.note || data.form_note || data._note || '',
    source: data._source || (local.pinyin ? 'local' : cached.pinyin ? 'cache' : 'state'),
    state: st || loadReaderWordState()[readerWordStateKey(w, 'zh')] || null
  };
}

function readerSearchZhCoreJson(query, limit = 80) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !readerZhCoreJson) return [];
  const exact = readerLookupChineseJsonEntry(q);
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry?.word || seen.has(entry.word) || out.length >= limit) return;
    seen.add(entry.word);
    out.push({ ...entry, state: loadReaderWordState()[readerWordStateKey(entry.word, 'zh')] || null });
  };
  if (exact) push(exact);
  const isHan = /[㐀-鿿]/.test(q);
  for (const [word, entry] of Object.entries(readerZhCoreJson)) {
    if (out.length >= limit) break;
    if (seen.has(word)) continue;
    if (isHan) {
      if (word.startsWith(q) || word.includes(q)) push(entry);
    } else if (q.length >= 2) {
      const hay = `${entry.pinyin || ''} ${entry.en || entry.english || ''}`.toLowerCase();
      if (hay.includes(q)) push(entry);
    }
  }
  return out;
}

// ════════════════════════════════════════════════
// Exports for app.js and other modules
// ════════════════════════════════════════════════
export {
  // Cloud sync (used by syncWordStateNow in app.js)
  syncWordStateToCloud, syncWordStateFromCloud, scheduleWordStateCloudSync,
  // Auth/profile helpers (used by app.js init/login)
  profileNameStorageKey, getCachedProfileName, setCachedProfileName, setActiveProfileName,
  readerSwitchStorageOwner,
  // Book management
  readerCurrentBook,
  loadReaderBooks, saveReaderBooks, loadReaderBooksFromCloud, hydrateReaderBooksFromIndexedDB,
  scheduleReaderCloudSave, saveReaderBooksToCloud, syncReaderCloudNow,
  readerSplitTextToChapters, readerSplitSongToChapters,
  readerBookProgress, readerContinueBook,
  // Word state
  loadReaderWordState, saveReaderWordState,
  readerGetWordState, readerWordVisual, readerWordStateKey, readerMarkWordSaved,
  readerRefreshParagraphWordClasses,
  // Time tracking
  readerTimeToday, readerTimeParagraphClose,
  // Language helpers (used by app.js + window)
  readerCurrentLang, readerBookLang, readerTokenizeParagraph,
  // UI functions exposed to window
  renderReaderScreen, readerOpenBook, readerBackToLibrary,
  readerNextParagraph, readerPrevParagraph, readerNextChapter, readerPrevChapter,
  readerOpenToc, readerCloseToc, readerGoToChapter,
  readerOpenWordPanel, readerCloseWordPanel,
  readerSpeakParagraph, readerSpeakCurrentParagraph, readerSpeakChapter, readerSpeakText, readerStopSpeech,
  readerCopyParagraph, readerCopyCurrentParagraph,
  readerDeleteBook, readerSetComprehension,
  readerSpeakSelectedWord, readerSpeakSelectedContext,
  readerPrefillAddVerbFromPanel, readerSendParagraphToPhrase, readerSelectParagraph,
  readerSaveWord, readerTranslateWordAI, readerTranslateParagraphAI, readerAnalyzeParagraphAI, readerAction,
  readerListenToggle, readerOpenMoreSheet, readerCloseMoreSheet,
  bindReaderParagraphEvents, toggleReaderTranslations,
  showReaderViewedWords, closeReaderViewedWords,
  readerMarkSelectedWordKnown, readerMarkSelectedWordProblem,
  readerCycleZhPinyinMode, readerLookupChineseWord, readerEnsureZhCoreJsonLoaded, readerZhCoreJsonCount,
  readerSetLibTab, readerSetLibFilter,
  readerImportFromFile, saveReaderImport, showReaderImportModal, closeReaderImportModal,
  readerToggleDisplayPanel, readerCloseDisplayPanel, rdSetFont, rdSetSize, rdSetLH, rdSetTheme, rdSetPageAnimation,
  readerToggleSongMeaning,
};

// Additional exports needed by app.js DICTIONARY / CHINESE DICT sections
export {
  READER_BOOKS_KEY, READER_LANG_META,
  readerCanonicalLang,
  loadReaderLexicalCache, saveReaderLexicalCache,
  readerAI,
  readerLookupChineseJsonEntry,
  readerEscape, readerExtractPinyin,
  readerGetCachedLexical, readerPutCachedLexical, readerLexicalCacheKey,
  readerNormalizeWord, readerPosRu, readerScopedKey,
  readerSearchZhCoreJson, readerZhEntryFromSources,
  readerWordStatusRu,
  readerTouchWordState, renderReaderChapter,
};
