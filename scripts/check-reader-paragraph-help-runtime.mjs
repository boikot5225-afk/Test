import assert from 'node:assert/strict';

// Keep handler-bridge's background timers inert while importing the renderer.
globalThis.window = globalThis;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.addEventListener = () => {};

const textDiv = {
  insertAdjacentHTML(_where, html) {
    paragraph.inserted += String(html || '');
  },
};

const paragraph = {
  dataset: { p: '0' },
  inserted: '',
  classList: { add() {}, remove() {}, toggle() {} },
  querySelector(selector) {
    if (selector === '.reader-paragraph-text') return textDiv;
    if (selector === '.reader-translation-block') return this.inserted.includes('reader-translation-block') ? {} : null;
    if (selector === '.reader-sentence-analysis') return this.inserted.includes('reader-sentence-analysis') ? {} : null;
    return null;
  },
};

const chapterText = {
  dataset: {
    renderedChapter: '0',
    renderedParCount: '1',
    renderedHidden: 'false',
    renderedZhCore: 'false',
    renderedJaCore: 'false',
    activeParagraph: '0',
  },
  lang: '',
  isConnected: true,
  querySelector(selector) {
    if (selector.includes('.reader-paragraph[data-p="0"]')) return paragraph;
    return null;
  },
};

const readingView = { dataset: {}, lang: '' };
const generic = () => ({
  textContent: '',
  style: {},
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
});
const elements = new Map([
  ['reader-reading-view', readingView],
  ['reader-chapter-text', chapterText],
  ['reader-book-title', generic()],
  ['reader-chapter-title', generic()],
  ['reader-progress-bar', generic()],
  ['reader-progress-text', generic()],
  ['reader-comprehension-note', generic()],
  ['reader-help-btn', generic()],
  ['rd-free-prog-fill', generic()],
]);

globalThis.document = {
  visibilityState: 'visible',
  getElementById(id) { return elements.get(id) || null; },
  querySelector(selector) {
    if (selector === '#reader-reading-view .rd-scroll') return { scrollTop: 0 };
    return null;
  },
  addEventListener() {},
};

globalThis.getSelection = () => null;

const { createReaderChapterRenderer } = await import('../js/reader/chapter-render-next.js?runtime-paragraph-test=1');

const book = {
  id: 'book-1',
  title: 'Test',
  lang: 'fr',
  currentChapter: 0,
  currentParagraph: 0,
  chapters: [{ id: 'ch0', title: 'Chapitre 1', paragraphs: ['Bonjour'] }],
  readerTranslations: {},
  readerAnalyses: {},
};
let saves = 0;

const renderer = createReaderChapterRenderer({
  getCurrentBook: () => book,
  getBookLang: () => 'fr',
  canonicalLang: (lang) => lang,
  ensureZhCoreLoaded: async () => {},
  needsZhCoreLoad: () => false,
  isZhCoreLoaded: () => false,
  ensureJaCoreLoaded: async () => {},
  needsJaCoreLoad: () => false,
  isJaCoreLoaded: () => false,
  trackParagraphSeen: () => {},
  getBookProgress: () => 1,
  langBadge: () => 'FR',
  getTranslationsHidden: () => false,
  updatePinyinButton: () => {},
  renderSongSection: () => '',
  bindSongStropheEvents: () => {},
  renderParagraphText: (text) => text,
  renderTranslationBlock: (text) => `<div class="reader-translation-block">${text}</div>`,
  renderAnalysisBlock: () => '<div class="reader-sentence-analysis"></div>',
  bindVisibleParagraphTracking: () => {},
  saveBooks: () => { saves += 1; },
  schedulePrefetch: () => {},
  openParagraphTimer: () => {},
  loadEpubImages: () => {},
  syncPagesMode: () => false,
  autoTranslateActive: () => {},
});

// This mirrors the real async completion: navigation did not move, only the
// stored translation changed between renders.
const beforeChapter = book.currentChapter;
const beforeParagraph = book.currentParagraph;
book.readerTranslations['ch0:0'] = 'Привет';
renderer.render();

assert.match(paragraph.inserted, /reader-translation-block/, 'new translation must be inserted into the already-active paragraph');
assert.match(paragraph.inserted, /Привет/, 'inserted block must contain the new translation');
assert.equal(book.currentChapter, beforeChapter, 'translation render must not change chapter');
assert.equal(book.currentParagraph, beforeParagraph, 'translation render must not change paragraph');
assert.ok(saves >= 1, 'fast render should preserve normal save behavior');

console.log('reader active paragraph translation runtime: PASS');
