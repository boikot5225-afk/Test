import { imgStoreGet } from './image-store.js?v=1';
import { libraryIdbGet } from './library-idb-store.js?v=1';

const STYLE_ID = 'reader-stage1-library-cover-style';
const coverUrlCache = new Map();
let observer = null;
let decorateQueued = false;
let booksCache = [];
let booksCacheAt = 0;

export function extractReaderOpenBookId(onclick = '') {
  const match = String(onclick || '').match(/readerOpenBook\(\s*(['"])(.*?)\1\s*\)/);
  return match ? match[2] : '';
}

export function mergeBooksById(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const book of Array.isArray(list) ? list : []) {
      if (!book?.id) continue;
      const previous = byId.get(book.id);
      if (!previous || new Date(book.updatedAt || 0) >= new Date(previous.updatedAt || 0)) {
        byId.set(book.id, book);
      }
    }
  }
  return [...byId.values()];
}

function storageKey() {
  try {
    return window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1';
  } catch {
    return 'an2_reader_books_v1';
  }
}

function readLocalBooks(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadBooks() {
  const now = Date.now();
  if (booksCache.length && now - booksCacheAt < 750) return booksCache;
  const key = storageKey();
  const local = readLocalBooks(key);
  let durable = [];
  try {
    const value = await libraryIdbGet(key);
    if (Array.isArray(value)) durable = value;
  } catch (_) {}
  booksCache = mergeBooksById(durable, local);
  booksCacheAt = now;
  return booksCache;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .lib-cover.lib-cover-image {
      position: relative;
      overflow: hidden;
      padding: 0 !important;
      color: transparent !important;
      background: var(--surface2);
    }
    .lib-cover.lib-cover-image > img {
      display: block;
      width: 100%;
      height: 100%;
      min-width: 100%;
      min-height: 100%;
      object-fit: cover;
      object-position: center;
    }
  `;
  document.head.appendChild(style);
}

function cardBookId(card) {
  const opener = card?.querySelector?.('[onclick*="readerOpenBook("]');
  return extractReaderOpenBookId(opener?.getAttribute?.('onclick') || '');
}

async function resolveCoverUrl(key) {
  if (!key) return '';
  if (coverUrlCache.has(key)) return coverUrlCache.get(key);
  const blob = await imgStoreGet(key).catch(() => null);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  coverUrlCache.set(key, url);
  return url;
}

async function decorateCard(card, booksById) {
  const id = cardBookId(card);
  if (!id) return;
  const book = booksById.get(id);
  if (!book?.coverKey) return;

  const cover = card.querySelector('.lib-cover');
  if (!cover || cover.dataset.semanticCoverKey === book.coverKey) return;

  const url = await resolveCoverUrl(book.coverKey);
  if (!url || !cover.isConnected) return;

  const fallback = cover.textContent || '';
  const image = document.createElement('img');
  image.alt = book.title ? `Обложка: ${book.title}` : 'Обложка книги';
  image.decoding = 'async';
  image.loading = card.classList.contains('lib-cont-card') ? 'eager' : 'lazy';
  image.src = url;
  image.addEventListener('error', () => {
    cover.classList.remove('lib-cover-image');
    cover.removeAttribute('data-semantic-cover-key');
    cover.textContent = fallback;
  }, { once: true });

  cover.replaceChildren(image);
  cover.classList.add('lib-cover-image');
  cover.dataset.semanticCoverKey = book.coverKey;
}

export async function decorateSemanticLibraryCovers(root = document) {
  ensureStyles();
  const books = await loadBooks();
  if (!books.length) return;
  const booksById = new Map(books.map(book => [book.id, book]));
  const cards = root.querySelectorAll?.('.lib-book-card, .lib-cont-card') || [];
  await Promise.all([...cards].map(card => decorateCard(card, booksById)));
}

function scheduleDecorate() {
  if (decorateQueued) return;
  decorateQueued = true;
  requestAnimationFrame(() => {
    decorateQueued = false;
    decorateSemanticLibraryCovers(document).catch(() => {});
  });
}

export function installSemanticLibraryCovers() {
  if (observer || typeof MutationObserver === 'undefined') return;
  const start = () => {
    ensureStyles();
    observer = new MutationObserver(scheduleDecorate);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleDecorate();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
