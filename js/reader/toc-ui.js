import { libraryIdbGet } from './library-idb-store.js?v=1';

let started = false;
let originalOpenToc = null;
let originalCloseToc = null;
let originalGoToChapter = null;

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

function currentMarker() {
  const root = document.getElementById('reader-chapter-text');
  return {
    bookId: String(root?.dataset?.readerBookId || ''),
    chapterKey: String(root?.dataset?.readerChapterKey || ''),
  };
}

function findBook(list, marker) {
  if (!marker?.bookId) return null;
  return (Array.isArray(list) ? list : []).find(book =>
    String(book?.id || '') === marker.bookId
    || String(book?.importKey || '') === marker.bookId
    || String(book?.title || '') === marker.bookId
  ) || null;
}

async function currentBookFromStorage() {
  const marker = currentMarker();
  if (!marker.bookId) return null;
  const key = storageKey();
  const local = findBook(readLocalBooks(key), marker);
  if (local?.toc?.length) return local;
  try {
    const durable = await libraryIdbGet(key);
    const fromIdb = findBook(durable, marker);
    return fromIdb || local || null;
  } catch {
    return local || null;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureStyles() {
  if (document.getElementById('reader-canonical-toc-style')) return;
  const style = document.createElement('style');
  style.id = 'reader-canonical-toc-style';
  style.textContent = `
    #reader-toc-list .rd-toc-item.rd-toc-canonical {
      padding-left: calc(16px + var(--toc-indent, 0px));
      min-height: 44px;
    }
    #reader-toc-list .rd-toc-item.rd-toc-canonical .rd-toc-num {
      flex-basis: 22px;
      font-size: .72rem;
    }
    #reader-toc-list .rd-toc-item.rd-toc-parent .rd-toc-title {
      font-weight: 600;
    }
    #reader-toc-list .rd-toc-item.rd-toc-unavailable {
      opacity: .55;
      cursor: default;
    }
    #reader-toc-list .rd-toc-item.rd-toc-unavailable:hover {
      background: none;
    }
    #reader-toc-list .rd-toc-count:empty { display:none; }
  `;
  document.head.appendChild(style);
}

function chapterParagraphCount(book, chapterIndex) {
  const chapter = book?.chapters?.[chapterIndex];
  if (!chapter) return 0;
  return (chapter.paragraphs || []).filter(item => !(item && typeof item === 'object' && item.type === 'image')).length;
}

function currentChapterIndex(book, marker) {
  const byPath = (book?.chapters || []).findIndex(chapter =>
    String(chapter?.sourcePath || chapter?.id || '') === String(marker?.chapterKey || '')
  );
  if (byPath >= 0) return byPath;
  return Math.max(0, Number(book?.currentChapter) || 0);
}

function currentTocIndex(book, marker, chapterIndex) {
  const toc = book?.toc || [];
  const byPath = toc.findIndex(item =>
    item?.sourcePath && String(item.sourcePath) === String(marker?.chapterKey || '')
  );
  if (byPath >= 0) return byPath;
  return toc.findIndex(item => Number.isInteger(item?.chapterIndex) && item.chapterIndex === chapterIndex);
}

function showSheet() {
  document.getElementById('reader-toc-back')?.classList.add('show');
  document.getElementById('reader-toc-sheet')?.classList.add('show');
}

function renderCanonicalToc(book) {
  const toc = Array.isArray(book?.toc) ? book.toc : [];
  const list = document.getElementById('reader-toc-list');
  const header = document.getElementById('reader-toc-header');
  if (!toc.length || !list) return false;

  ensureStyles();
  const marker = currentMarker();
  const curChapter = currentChapterIndex(book, marker);
  const curToc = currentTocIndex(book, marker, curChapter);

  if (header) header.textContent = `Оглавление · ${toc.length}`;
  list.innerHTML = toc.map((item, index) => {
    const chapterIndex = item?.chapterIndex;
    const mapped = Number.isInteger(chapterIndex) && chapterIndex >= 0 && chapterIndex < (book.chapters || []).length;
    const isCurrent = index === curToc || (curToc < 0 && mapped && chapterIndex === curChapter);
    const isDone = mapped && chapterIndex < curChapter;
    const depth = Math.max(0, Math.min(5, Number(item?.depth) || 0));
    const count = mapped ? chapterParagraphCount(book, chapterIndex) : 0;
    const markerText = isCurrent ? '▶' : isDone ? '✓' : item?.hasChildren ? '▾' : '•';
    const classes = [
      'rd-toc-item',
      'rd-toc-canonical',
      isCurrent ? 'current' : '',
      isDone ? 'done' : '',
      item?.hasChildren ? 'rd-toc-parent' : '',
      mapped ? '' : 'rd-toc-unavailable',
    ].filter(Boolean).join(' ');
    const click = mapped ? `onclick="readerGoToTocItem(${index})"` : 'disabled';
    const countLabel = mapped && count ? `${count} абз.` : '';
    return `<button class="${classes}" style="--toc-indent:${depth * 18}px" ${click}>
      <span class="rd-toc-num">${markerText}</span>
      <span class="rd-toc-title">${escapeHtml(item?.title || `Раздел ${index + 1}`)}</span>
      <span class="rd-toc-count">${escapeHtml(countLabel)}</span>
    </button>`;
  }).join('');

  showSheet();
  setTimeout(() => {
    list.querySelector('.current')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, 80);
  return true;
}

async function openCanonicalToc() {
  const book = await currentBookFromStorage();
  if (book?.toc?.length && renderCanonicalToc(book)) return;
  return originalOpenToc?.();
}

async function goToTocItem(index) {
  const book = await currentBookFromStorage();
  const item = book?.toc?.[Number(index)];
  const chapterIndex = item?.chapterIndex;
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
    window.showToast?.('Этот пункт оглавления не содержит отдельного текста');
    return;
  }
  originalCloseToc?.();
  return originalGoToChapter?.(chapterIndex);
}

function installWhenReady() {
  const open = window.readerOpenToc;
  const close = window.readerCloseToc;
  const go = window.readerGoToChapter;
  if (typeof open !== 'function' || typeof close !== 'function' || typeof go !== 'function') return false;
  if (open.__canonicalEpubToc) return true;

  originalOpenToc = open;
  originalCloseToc = close;
  originalGoToChapter = go;

  const wrappedOpen = () => openCanonicalToc();
  wrappedOpen.__canonicalEpubToc = true;
  wrappedOpen.__canonicalOriginal = open;
  window.readerOpenToc = wrappedOpen;
  window.readerGoToTocItem = goToTocItem;
  return true;
}

export function installCanonicalTocUi() {
  if (started) return;
  started = true;
  if (installWhenReady()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (installWhenReady() || attempts >= 240) clearInterval(timer);
  }, 50);
}
