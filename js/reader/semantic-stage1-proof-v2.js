import {
  libraryIdbGet,
  libraryIdbPut,
} from './library-idb-store.js?v=1';
import { imgStoreDeleteBook } from './image-store.js?v=1';

const TEST_SUFFIX = ' [S2 TEST]';
let installed = false;
let activeBook = null;
let badgeObserver = null;

function storageKey() {
  try {
    return window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1';
  } catch {
    return 'an2_reader_books_v1';
  }
}

function readLocalBooks(key = storageKey()) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function readDurableBooks(key = storageKey()) {
  try {
    const value = await libraryIdbGet(key);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/\s*\[S2(?: TEST)?\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function mergeById(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const book of Array.isArray(list) ? list : []) {
      if (!book?.id) continue;
      const previous = map.get(book.id);
      if (!previous || new Date(book.updatedAt || 0) >= new Date(previous.updatedAt || 0)) {
        map.set(book.id, book);
      }
    }
  }
  return [...map.values()];
}

async function writeBooks(books) {
  const key = storageKey();
  try { localStorage.setItem(key, JSON.stringify(books)); } catch {}
  try { await libraryIdbPut(key, books); } catch {}
}

function semanticImportIsReady() {
  const status = String(document.getElementById('reader-import-status')?.textContent || '');
  const preview = document.getElementById('reader-import-text');
  return status.includes('EPUB проверен:')
    || String(preview?.placeholder || '').includes('семантическим импортёром');
}

function baseTitleFromInput() {
  const input = document.getElementById('reader-import-title');
  const base = String(input?.value || '')
    .replace(/\s*\[S2(?: TEST)?\]\s*$/i, '')
    .trim();
  return base;
}

function applyTestTitle() {
  if (!semanticImportIsReady()) return '';
  const input = document.getElementById('reader-import-title');
  if (!input) return '';
  const base = baseTitleFromInput();
  if (!base) return '';
  input.value = `${base}${TEST_SUFFIX}`;
  return base;
}

async function removeOldTestCopies(baseTitle) {
  const wanted = normalizeTitle(baseTitle);
  if (!wanted) return;
  const all = mergeById(await readDurableBooks(), readLocalBooks());
  const removed = all.filter(book =>
    String(book?.source || '').startsWith('epub-semantic-stage1')
    && normalizeTitle(book?.title) === wanted
  );
  if (!removed.length) return;
  const keep = all.filter(book => !removed.some(old => old.id === book.id));
  await writeBooks(keep);
  await Promise.all(removed.map(book => imgStoreDeleteBook(book.id).catch(() => {})));
}

function newestSemanticBook(baseTitle = '') {
  const wanted = normalizeTitle(baseTitle);
  return readLocalBooks()
    .filter(book => String(book?.source || '').startsWith('epub-semantic-stage1'))
    .filter(book => !wanted || normalizeTitle(book?.title) === wanted)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
}

function firstImagePosition(book) {
  for (let chapterIndex = 0; chapterIndex < (book?.chapters || []).length; chapterIndex += 1) {
    const items = book.chapters[chapterIndex]?.paragraphs || [];
    const itemIndex = items.findIndex(item => item && typeof item === 'object' && item.type === 'image');
    if (itemIndex >= 0) return { chapterIndex, itemIndex };
  }
  return null;
}

async function moveBookToFirstImage(book) {
  const position = firstImagePosition(book);
  if (!position) return null;
  book.currentChapter = position.chapterIndex;
  book.currentParagraph = position.itemIndex;
  book.updatedAt = new Date().toISOString();

  const all = mergeById(await readDurableBooks(), readLocalBooks());
  const next = all.map(item => item.id === book.id ? book : item);
  await writeBooks(next);
  return position;
}

function proofText(book) {
  const diag = book?.epubDiagnostics || {};
  const position = firstImagePosition(book);
  const location = position
    ? `первая картинка: глава ${position.chapterIndex + 1}, элемент ${position.itemIndex + 1}`
    : 'картинок в структуре не найдено';
  return `S2 TEST · ${diag.chapters || book?.chapters?.length || 0} глав · ${diag.images || 0} изображений · ${location}`;
}

function ensureBadge() {
  const root = document.getElementById('reader-chapter-text');
  if (!root || !activeBook) return;
  let badge = root.querySelector(':scope > .reader-stage1-proof-v2');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'reader-stage1-proof-v2';
    badge.style.cssText = [
      'margin:0 0 12px',
      'padding:9px 11px',
      'border:2px solid #9a4c2b',
      'border-radius:9px',
      'background:#fff0df',
      'color:#7d351f',
      "font:700 12px/1.4 'IBM Plex Sans',sans-serif",
    ].join(';');
    root.prepend(badge);
  }
  badge.textContent = proofText(activeBook);
  root.dataset.semanticStage = '2-proof-v2';
}

function watchReaderRoot() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  badgeObserver?.disconnect();
  badgeObserver = new MutationObserver(() => {
    if (!root.querySelector(':scope > .reader-stage1-proof-v2')) ensureBadge();
  });
  badgeObserver.observe(root, { childList: true });
  ensureBadge();
}

function installFreshFileReset() {
  document.addEventListener('change', event => {
    const file = event.target?.files?.[0];
    if (!file || !/\.epub$/i.test(String(file.name || ''))) return;
    activeBook = null;
    const title = document.getElementById('reader-import-title');
    const author = document.getElementById('reader-import-author');
    const preview = document.getElementById('reader-import-text');
    if (title) title.value = '';
    if (author) author.value = '';
    if (preview) preview.value = '';
  }, true);
}

function installTitleObserver() {
  const status = document.getElementById('reader-import-status');
  if (!status || status.dataset.s2ProofV2 === '1') return false;
  status.dataset.s2ProofV2 = '1';
  new MutationObserver(() => applyTestTitle())
    .observe(status, { childList: true, characterData: true, subtree: true });
  return true;
}

function installSaveWrapper() {
  const original = window.saveReaderImport;
  if (typeof original !== 'function' || !original.__semanticStage1) return false;
  if (original.__semanticStage1ProofV2) return true;

  const wrapped = async (...args) => {
    if (!semanticImportIsReady()) return original(...args);
    const baseTitle = applyTestTitle();
    await removeOldTestCopies(baseTitle);
    const result = await original(...args);
    activeBook = newestSemanticBook(baseTitle);
    if (!activeBook) {
      window.showToast?.('S2 TEST: новая семантическая книга не найдена');
      return result;
    }

    const position = await moveBookToFirstImage(activeBook);
    await window.readerOpenBook?.(activeBook.id);
    setTimeout(() => {
      watchReaderRoot();
      window.showToast?.(position
        ? `S2 TEST: открыта первая картинка — глава ${position.chapterIndex + 1}`
        : 'S2 TEST: в EPUB не найдено изображений');
    }, 100);
    return result;
  };
  wrapped.__semanticStage1 = true;
  wrapped.__semanticStage1ProofV2 = true;
  window.saveReaderImport = wrapped;
  return true;
}

export function installSemanticStage1ProofV2() {
  if (installed) return;
  installed = true;
  installFreshFileReset();
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    installTitleObserver();
    if (installSaveWrapper() || attempts >= 240) clearInterval(timer);
  }, 50);
}

installSemanticStage1ProofV2();
