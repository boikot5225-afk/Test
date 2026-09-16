// Japanese reading aid: the kana reading stays above the word, a short Russian
// equivalent goes below it.
//
// Layout contract:
//   - the reading above is Reader's own furigana scaffold, untouched. It is
//     already placed correctly — over the kanji head only, not over the kana
//     tail — and repainting it here would lose that;
//   - this module owns exactly one thing: the Russian row under the word;
//   - only a word that still needs help gets one, by the same verdict that
//     decides whether the furigana shows at all;
//   - the row reserves its own width instead of painting across neighbours;
//   - English is never rendered. JMdict glosses in English, and routing that
//     through a second dictionary to reach Russian is what produced nonsense
//     for Chinese (title -> заглавие).
//
// Russian comes from the caches a word card already fills: opening a word
// resolves it once through DeepSeek and stores the answer. A word never opened
// keeps its furigana and simply has no second row yet. Reader's own core is
// frozen, so this module reads those caches the same way the Chinese layer
// does — straight out of storage, by the same keys.

import { normalizeImportKey } from '../utils.js';

const STYLE_ID = 'reader-ja-readable-inline-v1';
const MODE_KEY = 'an2_reader_ja_unknown_gloss_mode_v1';
const LEXICAL_CACHE_KEY = 'an2_reader_lexical_cache_v1';
const INSTANT_CACHE_KEY = 'an2_instant_translate_word_cache_v1';
const MAX_MEANING_CHARS = 36;

// A word wearing one of these has stopped needing help: learned, a service word
// the reader never annotates, or one that has been met often enough to be
// weaned off its reading scaffold. Keeping the translation after the furigana
// above it is gone would be the odd half-state.
const SETTLED_CLASSES = ['rw-known', 'rw-migaku-known', 'rw-seen', 'rw-faded'];

let observer = null;
let observedRoot = null;
let scanTimer = 0;
// The chosen mode lives here, not in storage: a device that denies localStorage
// would otherwise have a toggle that silently does nothing. Storage is only
// where it is remembered between sessions.
let currentMode = null;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasRussian(value) {
  return /[Ѐ-ԯ]/.test(String(value || ''));
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'japanese' || raw === 'ja' || raw === 'jp' || raw.startsWith('ja-') ? 'ja' : raw;
}

function mode() {
  if (currentMode) return currentMode;
  let stored = '';
  try { stored = localStorage.getItem(MODE_KEY) || ''; } catch {}
  currentMode = stored === 'off' ? 'off' : 'meaning';
  return currentMode;
}

function enabled() {
  return mode() !== 'off' && currentLang() === 'ja';
}

// A reading hint is an equivalent, not a dictionary article: a definition under
// a word costs more attention than it returns. Anything that reads like prose
// is dropped and the word keeps just its furigana.
function compactRussian(value) {
  let text = clean(value)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '');
  if (!text) return '';
  text = text.split(/\s*(?:[;；/|·•]|[.!?。！？]|[,，])\s*/)[0] || text;
  text = text
    .replace(/\s*[（(][^()（）]{0,100}[）)]/g, ' ')
    .replace(/\s*[（(].*$/, '')
    .replace(/^[—–-]\s*/, '')
    .replace(/[;；,.，。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || !hasRussian(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3 || text.length > MAX_MEANING_CHARS) return '';
  return text;
}

function isJapaneseWord(el) {
  return !!el?.classList?.contains('reader-word')
    && el.dataset?.lang === 'ja'
    && /[぀-ヿ㐀-䶿一-鿿々〆]/.test(String(el.dataset?.word || ''));
}

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function readJson(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// The same key Reader's core builds for a cached lookup: NFC, edge punctuation
// trimmed (the katakana prolonged mark ー stays — it is a letter inside コーヒー),
// then the shared import normalization.
function cacheKeyFor(word) {
  const trimmed = String(word || '')
    .normalize('NFC')
    .replace(/^[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】「」『』〔〕・〜～\[\]{}…—\-]+|[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】「」『』〔〕・〜～\[\]{}…—\-]+$/g, '')
    .trim();
  return trimmed ? normalizeImportKey(trimmed) : '';
}

// DeepSeek answers arrive under whichever field its reply happened to use, and
// the card stores them as it got them, so read the same spread the Chinese
// layer does rather than `ru` alone. An array is a list of senses; the first
// one is the equivalent.
function russianOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const raw = entry.ru ?? entry.translation_ru ?? entry.russian ?? entry.meaning_ru
    ?? entry.translation ?? entry.meaning ?? '';
  const value = Array.isArray(raw) ? raw.find(x => clean(x)) || '' : raw;
  return clean(value);
}

function russianFor(word) {
  const key = cacheKeyFor(word);
  if (!key) return '';
  const lexical = readJson(scopedKey(LEXICAL_CACHE_KEY))[`ja:${key}`] || null;
  const instant = readJson(INSTANT_CACHE_KEY)[`ja:${String(word || '').trim().toLowerCase()}`] || null;
  // An explicit Instant translation is the reader's own most recent answer for
  // this word, so it outranks whatever the card cached earlier.
  return russianOf(instant) || russianOf(lexical);
}

function wrapperFor(el) {
  const parent = el?.parentElement;
  return parent?.classList?.contains('rw-ja-gloss-wrap') ? parent : null;
}

function wordForWrapper(wrap) {
  return wrap?.querySelector?.(':scope > .reader-word') || null;
}

// What this word should show, if anything. Returns '' when the word is done
// being helped, when the reader has not resolved a Russian meaning for it yet,
// or when that meaning is too long to belong under a line of text.
function meaningFor(el) {
  const surface = clean(el?.dataset?.word || el?.textContent || '');
  if (!surface) return '';
  if (SETTLED_CLASSES.some(cls => el.classList.contains(cls))) return '';
  return compactRussian(russianFor(surface));
}

function ensureWrapper(el) {
  let wrap = wrapperFor(el);
  if (!wrap) {
    if (!el.parentNode) return null;
    wrap = document.createElement('span');
    wrap.className = 'rw-ja-gloss-wrap';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
  }
  return wrap;
}

// Taking the row down puts the token back exactly where it was, so switching
// the mode off leaves nothing behind in the flow.
function unwrap(wrap) {
  if (!wrap?.parentNode) return;
  const word = wordForWrapper(wrap);
  wrap.querySelector(':scope > .rw-ja-readable-meaning')?.remove();
  if (word) wrap.parentNode.insertBefore(word, wrap);
  wrap.remove();
}

function setMeaning(wrap, ru) {
  let node = wrap.querySelector(':scope > .rw-ja-readable-meaning');
  if (!node) {
    node = document.createElement('span');
    node.className = 'rw-ja-readable-meaning';
    node.setAttribute('aria-hidden', 'true');
    wrap.appendChild(node);
  }
  if (clean(node.textContent) !== ru) node.textContent = ru;
  wrap.dataset.jaGloss = '1';
}

function syncWord(el) {
  if (!isJapaneseWord(el)) return;
  const ru = enabled() ? meaningFor(el) : '';
  if (!ru) {
    const existing = wrapperFor(el);
    if (existing) unwrap(existing);
    return;
  }
  const wrap = ensureWrapper(el);
  if (wrap) setMeaning(wrap, ru);
}

function syncAll() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return 0;
  // The grid that puts the row under the word only applies while the view wears
  // rd-ja-gloss. A chapter that renders after install would otherwise get rows
  // with no grid to size them — full-size Russian inline in the text, which is
  // the flash the Chinese layer had. Re-assert the class on every pass so the
  // row can never exist without the style that shapes it.
  syncControl();
  // Existing rows first: a mode switch or a word marked known has to be able to
  // take one down even when the word no longer qualifies for a new one.
  root.querySelectorAll('.rw-ja-gloss-wrap').forEach(wrap => {
    const word = wordForWrapper(wrap);
    if (!word) { unwrap(wrap); return; }
    syncWord(word);
  });
  if (!enabled()) return 0;
  const words = root.querySelectorAll('.reader-word[data-lang="ja"][data-word]');
  words.forEach(syncWord);
  return words.length;
}

function schedule(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(syncAll, Math.max(0, Number(delay) || 0));
}

function ensureControl() {
  const panel = document.getElementById('rd-display-panel');
  if (!panel) return null;
  let row = document.getElementById('rd-dp-ja-gloss-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'rd-dp-ja-gloss-row';
    row.className = 'rd-dp-row';
    row.style.display = 'none';
    row.innerHTML = `
      <span class="rd-dp-label">Японский · незнакомые слова</span>
      <div class="rd-dp-pills">
        <button type="button" class="rd-dp-pill rd-ja-gloss-mode" data-mode="off">Обычный текст</button>
        <button type="button" class="rd-dp-pill rd-ja-gloss-mode" data-mode="meaning">Перевод под словом</button>
      </div>`;
    row.querySelectorAll('.rd-ja-gloss-mode').forEach(button => {
      button.addEventListener('click', () => setMode(button.dataset.mode || 'off'));
    });
    panel.appendChild(row);
  }
  return row;
}

function syncControl() {
  const row = ensureControl();
  const view = document.getElementById('reader-reading-view');
  if (!view) return;
  const isJa = currentLang() === 'ja';
  if (row) {
    row.style.display = isJa ? 'flex' : 'none';
    row.querySelectorAll('.rd-ja-gloss-mode').forEach(button => {
      button.classList.toggle('rd-dp-active', button.dataset.mode === mode());
    });
  }
  view.classList.toggle('rd-ja-gloss', isJa && mode() !== 'off');
}

function setMode(next) {
  currentMode = next === 'off' ? 'off' : 'meaning';
  try { localStorage.setItem(MODE_KEY, currentMode); } catch {}
  syncControl();
  schedule(0);
}

function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Room for a row under the line. The furigana above already has its own. */
    #reader-reading-view.rd-ja-gloss[data-reader-lang="ja"] .reader-paragraph-text {
      line-height: 2.35 !important;
      word-break: normal !important;
      overflow-wrap: normal !important;
    }

    /* A wrapper with no meaning in it must not disturb the flow at all. */
    #reader-reading-view.rd-ja-gloss[data-reader-lang="ja"] .rw-ja-gloss-wrap {
      display: contents !important;
    }

    /* Word over meaning. max-content keeps the unit exactly as wide as its
       widest row, so a long gloss reserves space instead of running under the
       neighbouring words. */
    #reader-reading-view.rd-ja-gloss[data-reader-lang="ja"]
    .rw-ja-gloss-wrap[data-ja-gloss="1"] {
      display: inline-grid !important;
      grid-template-rows: auto auto !important;
      grid-template-columns: max-content !important;
      align-items: start !important;
      justify-items: center !important;
      vertical-align: baseline !important;
      line-height: 1 !important;
      margin: 0 .04em !important;
      padding: 0 !important;
      width: auto !important;
      max-width: none !important;
      overflow: visible !important;
      break-inside: avoid !important;
      white-space: nowrap !important;
    }

    #reader-reading-view.rd-ja-gloss[data-reader-lang="ja"]
    .rw-ja-gloss-wrap[data-ja-gloss="1"] > .reader-word {
      grid-row: 1 !important;
      grid-column: 1 !important;
      align-self: end !important;
      justify-self: center !important;
      position: static !important;
      margin: 0 !important;
      padding: 0 1px !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
    }

    #reader-reading-view.rd-ja-gloss[data-reader-lang="ja"]
    .rw-ja-gloss-wrap[data-ja-gloss="1"] > .rw-ja-readable-meaning {
      grid-row: 2 !important;
      grid-column: 1 !important;
      align-self: start !important;
      justify-self: center !important;
      display: block !important;
      width: max-content !important;
      min-width: 1.8em !important;
      max-width: 6.4em !important;
      margin: .12em 0 0 !important;
      padding: 0 !important;
      overflow: visible !important;
      text-align: center !important;
      white-space: normal !important;
      word-break: normal !important;
      overflow-wrap: normal !important;
      hyphens: none !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .38em !important;
      font-weight: 400 !important;
      line-height: 1.1 !important;
      letter-spacing: 0 !important;
      color: var(--text-muted) !important;
      pointer-events: none !important;
      user-select: none !important;
    }
  `;
  document.head.appendChild(style);
}

function bindObserver() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(bindObserver, 180);
    return;
  }
  if (observer && observedRoot === root) return;
  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(records => {
    let relevant = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target;
        if (el instanceof Element && el.classList.contains('reader-word')) {
          relevant = true;
          // Marking a word known has to take its row down in the same frame as
          // the class change. Left to the debounced pass below, the row would
          // still be in the DOM for a frame or two after the grid that sizes it
          // stopped applying — which renders as full-size plain text.
          if (isJapaneseWord(el) && !meaningFor(el)) {
            const wrap = wrapperFor(el);
            if (wrap) unwrap(wrap);
          }
          continue;
        }
        if (el instanceof Element && el.classList.contains('rw-ja-gloss-wrap')) {
          relevant = true;
          continue;
        }
        continue;
      }
      for (const node of record.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('rw-ja-readable-meaning')) continue;
        if (node.matches?.('.reader-word,.rw-ja-gloss-wrap') || node.querySelector?.('.reader-word,.rw-ja-gloss-wrap')) {
          relevant = true;
          break;
        }
      }
    }
    if (relevant) schedule(20);
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-word', 'data-lang'],
  });
}

function install() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  installStyle();
  ensureControl();
  syncControl();
  bindObserver();
  schedule(0);
}

if (typeof window !== 'undefined') {
  window.readerSetJaGlossMode = setMode;
  window.readerGetJaGlossMode = mode;
  window.readerSyncJaReadableInline = syncAll;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { installStyle(); bindObserver(); schedule(20); });
  window.addEventListener('an2:languagechange', () => { syncControl(); schedule(0); });
  window.addEventListener('reader:pagechange', () => schedule(10));
  window.addEventListener('reader:chromechange', () => schedule(15));
  // A word card resolves Russian through DeepSeek and caches it, so the row
  // under that word can appear as soon as the answer lands. The word panel
  // fires this one on document without bubbling, so it has to be caught there.
  document.addEventListener('reader-word-analysis-ready', () => schedule(30));
  window.addEventListener('scroll', () => schedule(70), { passive: true });
}

export { mode, enabled, compactRussian, syncAll, syncWord };
