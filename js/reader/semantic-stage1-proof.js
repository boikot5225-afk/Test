import {
  libraryIdbGet,
  libraryIdbPut,
} from './library-idb-store.js?v=1';
import { imgStoreDeleteBook } from './image-store.js?v=1';

const TEST_SUFFIX = ' [S2 TEST]';
const INSTALL_LIMIT = 240;
let activeBook = null;
let rootObserver = null;

function storageKey() {
  try {
    return window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1';
  } catch {
    return 'an2_reader_books_v1';
  }
}

function readLocalBooks(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
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

function semanticImportIsReady() {
  const status = String(document.getElementById('reader-import-status')?.textContent || '');
  const preview = document.getElementById('reader-import-text');
  return status.includes('EPUB проверен:')
    || String(preview?.placeholder || '').includes('семантическим импортёром');
}

function ensureTestTitle() {
  if (!semanticImportIsReady()) return '';
  const input = document.getElementById('reader-import-title');
  if (!input) return '';
  const base = String(input.value || '').replace(/\s*\[S2(?: TEST)?\]\s*$/i, '').trim();
  if (!base) return '';
  const next = `${base}${TEST_SUFFIX}`;
  if (input.value !== next) input.value = next;
  return base;
}

async function readDurableBooks(key) {
  try {
    const value = await libraryIdbGet(key);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
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

async function removePreviousStage1Copies(baseTitle) {
  const wanted = normalizeTitle(baseTitle);
  if (!wanted) return [];
  const key = storageKey();
  const all = mergeById(await readDurableBooks(key), readLocalBooks(key));
  const removed = all.filter(book =>
    String(book?.source || '').startsWith('epub-semantic-stage1')
    && normalizeTitle(book?.title) === wanted
  );
  if (!removed.length) return [];

  const keep = all.filter(book => !removed.some(old => old.id === book.id));
  try { localStorage.setItem(key, JSON.stringify(keep)); } catch {}
  try { await libraryIdbPut(key, keep); } catch {}
  await Promise.all(removed.map(book => imgStoreDeleteBook(book.id).catch(() => {})));
  return removed;
}

function newestStage1Book(baseTitle = '') {
  const wanted = normalizeTitle(baseTitle);
  return readLocalBooks(storageKey())
    .filter(book => String(book?.source || '').startsWith('epub-semantic-stage1'))
    .filter(book => !wanted || normalizeTitle(book?.title) === wanted)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0] || null;
}

function ensureProofBadge() {
  const root = document.getElementById('reader-chapter-text');
  if (!root || !activeBook) return;
  let badge = root.querySelector(':scope > .reader-stage1-proof');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'reader-stage1-proof';
    badge.style.cssText = [
      'margin:0 0 12px',
      'padding:8px 10px',
      'border:1px solid #9a4c2b',
      'border-radius:9px',
      'background:#fff4e8',
      'color:#7d351f',
      "font:700 12px/1.35 'IBM Plex Sans',sans-serif",
      'letter-spacing:.02em',
    ].join(';');
    root.prepend(badge);
  }
  const diag = activeBook.epubDiagnostics || {};
  const currentChapter = Number(activeBook.currentChapter || 0) + 1;
  const itemCount = activeBook.chapters?.[activeBook.currentChapter || 0]?.paragraphs?.length || 0;
  badge.textContent = `S2 TEST · ${diag.chapters || activeBook.chapters?.length || 0} глав · ${diag.images || 0} изображений · глава ${currentChapter} · ${itemCount} элементов`;
  root.dataset.semanticStage = '2-test';
}

function observeReaderRoot() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  if (rootObserver) rootObserver.disconnect();
  rootObserver = new MutationObserver(() => {
    if (!root.querySelector(':scope > .reader-stage1-proof')) ensureProofBadge();
  });
  rootObserver.observe(root, { childList: true });
  ensureProofBadge();
}

function installTitleMarker() {
  const status = document.getElementById('reader-import-status');
  if (!status || status.dataset.s2ProofObserved === '1') return false;
  status.dataset.s2ProofObserved = '1';
  new MutationObserver(() => ensureTestTitle()).observe(status, { childList: true, characterData: true, subtree: true });
  return true;
}

function installSaveWrapper() {
  const original = window.saveReaderImport;
  if (typeof original !== 'function' || !original.__semanticStage1) return false;
  if (original.__semanticStage1Proof) return true;

  const wrapped = async (...args) => {
    if (!semanticImportIsReady()) return original(...args);
    const baseTitle = ensureTestTitle();
    await removePreviousStage1Copies(baseTitle);
    const result = await original(...args);
    activeBook = newestStage1Book(baseTitle);
    if (activeBook) {
      setTimeout(() => {
        observeReaderRoot();
        window.showToast?.(`S2 TEST: ${activeBook.epubDiagnostics?.chapters || activeBook.chapters?.length || 0} глав, ${activeBook.epubDiagnostics?.images || 0} изображений`);
      }, 80);
    }
    return result;
  };
  wrapped.__semanticStage1 = true;
  wrapped.__semanticStage1Proof = true;
  window.saveReaderImport = wrapped;
  return true;
}

export function installSemanticStage1Proof() {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    installTitleMarker();
    const done = installSaveWrapper();
    if (done || attempts >= INSTALL_LIMIT) clearInterval(timer);
  }, 50);
}

installSemanticStage1Proof();
