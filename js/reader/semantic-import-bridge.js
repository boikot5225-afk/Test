import {
  libraryIdbGet,
  libraryIdbPut,
} from './library-idb-store.js?v=2';
import { imgStoreDeleteBook } from './image-store.js?v=1';
import {
  chapterContentText,
  firstReadableContentIndex,
} from './semantic-content.js?v=4';
import { parseSemanticEpubFile } from './semantic-import-stage1.js?v=6-storage';

let pendingImport = null;
let bridgeStarted = false;

function newBookId() {
  return `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function storageKey() {
  try {
    return window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1';
  } catch {
    return 'an2_reader_books_v1';
  }
}

function readStoredBooks(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeBookLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const book of Array.isArray(list) ? list : []) {
      if (!book?.id) continue;
      const previous = byId.get(book.id);
      const previousFull = Array.isArray(previous?.chapters) && previous.chapters.length;
      const currentFull = Array.isArray(book?.chapters) && book.chapters.length;
      if (!previous || (currentFull && !previousFull)
          || (currentFull === previousFull && new Date(book.updatedAt || 0) >= new Date(previous.updatedAt || 0))) {
        byId.set(book.id, book);
      }
    }
  }
  return [...byId.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function paragraphCount(book = {}) {
  return (book.chapters || []).reduce((sum, chapter) => sum + (chapter?.paragraphs?.length || 0), 0);
}

function progressPct(book = {}) {
  const chapters = book.chapters || [];
  const total = paragraphCount(book) || 1;
  let done = 0;
  const chapterIndex = Math.max(0, Number(book.currentChapter) || 0);
  for (let index = 0; index < Math.min(chapterIndex, chapters.length); index += 1) {
    done += chapters[index]?.paragraphs?.length || 0;
  }
  done += Math.min(Math.max(0, Number(book.currentParagraph) || 0), chapters[chapterIndex]?.paragraphs?.length || 0);
  return Math.max(0, Math.min(100, Math.round(done / total * 100)));
}

function indexEntry(book = {}) {
  return {
    _libraryIndexV2: 2,
    id: String(book.id || ''),
    title: book.title || 'Без названия',
    author: book.author || '',
    lang: book.lang || '',
    sourceLang: book.sourceLang || '',
    level: book.level || '',
    format: book.format || 'text',
    source: book.source || '',
    importKey: book.importKey || '',
    schemaVersion: Number(book.schemaVersion || 0),
    coverKey: book.coverKey || '',
    coverPath: book.coverPath || '',
    createdAt: book.createdAt || '',
    updatedAt: book.updatedAt || '',
    currentChapter: Math.max(0, Number(book.currentChapter) || 0),
    currentParagraph: Math.max(0, Number(book.currentParagraph) || 0),
    chapterCount: Array.isArray(book.chapters) ? book.chapters.length : Number(book.chapterCount || 0),
    paragraphCount: Array.isArray(book.chapters) ? paragraphCount(book) : Number(book.paragraphCount || 0),
    _progressPct: Array.isArray(book.chapters) ? progressPct(book) : Number(book._progressPct || 0),
  };
}

function writeLocalIndex(key, books) {
  const index = (Array.isArray(books) ? books : []).filter(book => book?.id).map(indexEntry);
  localStorage.setItem(key, JSON.stringify(index));
  return index;
}

function statusElement() {
  return document.getElementById('reader-import-status');
}

function setStatus(text, kind = 'progress') {
  const element = statusElement();
  if (!element) return;
  element.style.display = 'block';
  element.style.color = kind === 'error'
    ? 'var(--bad)'
    : kind === 'ok'
      ? 'var(--good)'
      : 'var(--accent)';
  element.textContent = text;
}

function setInputValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  element.value = value || '';
}

function buildPreview(result) {
  return (result.chapters || []).slice(0, 5).map(chapter => {
    const text = chapterContentText(chapter.paragraphs || [], '\n\n');
    return `${chapter.title}\n\n${text.slice(0, 1400)}`.trim();
  }).join('\n\n---\n\n');
}

async function handleSemanticEpub(event, originalImport) {
  const file = event?.target?.files?.[0];
  if (!file || !String(file.name || '').toLowerCase().endsWith('.epub')) {
    return originalImport(event);
  }

  pendingImport = null;
  const preview = document.getElementById('reader-import-text');
  if (preview) preview.value = '';

  try {
    const result = await parseSemanticEpubFile(file, {
      bookId: newBookId(),
      onProgress: message => setStatus(`⏳ ${message}`),
    });
    pendingImport = result;

    setInputValue('reader-import-title', result.title);
    setInputValue('reader-import-author', result.author);
    const languageSelect = document.getElementById('reader-import-lang');
    const validMetadataLang = ['fr', 'en', 'zh', 'es', 'ja'].includes(result.lang);
    if (languageSelect && validMetadataLang && languageSelect.dataset.userChanged !== '1') {
      languageSelect.value = result.lang;
    }
    if (preview) {
      preview.value = buildPreview(result);
      preview.placeholder = 'EPUB разобран семантическим импортёром. При сохранении используется полная структура книги.';
    }

    const diag = result.diagnostics || {};
    const missing = diag.missingImages?.length || 0;
    const footnotePart = diag.footnotes ? ` · ${diag.footnotes} сносок` : '';
    setStatus(
      `✅ EPUB проверен: ${diag.chapters || 0} глав · ${diag.images || 0} изображений${footnotePart} · ${diag.textChars || 0} знаков${missing ? ` · не найдено изображений: ${missing}` : ''}. Нажми «Сохранить».`,
      missing ? 'progress' : 'ok',
    );
  } catch (error) {
    pendingImport = null;
    setStatus(`❌ EPUB не импортировался: ${String(error?.message || error)}`, 'error');
  }
}

async function readDurableBooks(key) {
  try {
    const value = await libraryIdbGet(key);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.warn('[semantic epub] IndexedDB read failed', error);
    return [];
  }
}

async function savePendingSemanticBook(originalSave) {
  if (!pendingImport) return originalSave();

  const language = String(document.getElementById('reader-import-lang')?.value || pendingImport.lang || '').trim();
  if (!language) {
    setStatus('Выбери язык текста перед сохранением.', 'error');
    return;
  }

  const title = String(document.getElementById('reader-import-title')?.value || pendingImport.title || 'Без названия').trim();
  const author = String(document.getElementById('reader-import-author')?.value || pendingImport.author || '').trim();
  const level = String(document.getElementById('reader-import-level')?.value || 'original');
  const now = new Date().toISOString();
  const chapters = pendingImport.chapters || [];
  const footnotes = pendingImport.footnotes || {};
  const firstItems = chapters[0]?.paragraphs || [];
  const charCount = Number(pendingImport.diagnostics?.textChars || 0);
  const footnoteCount = Object.keys(footnotes).length;
  const importKey = `semantic-v3:${language}:${hashText(`${title}|${author}|${chapters.length}|${charCount}|${footnoteCount}`)}`;

  const book = {
    id: pendingImport.bookId,
    schemaVersion: 3,
    title,
    author,
    level,
    lang: language,
    sourceLang: language,
    format: 'text',
    source: 'epub-semantic-stage1',
    importKey,
    coverKey: pendingImport.coverKey || '',
    coverPath: pendingImport.coverPath || '',
    createdAt: now,
    updatedAt: now,
    currentChapter: 0,
    currentParagraph: firstReadableContentIndex(firstItems),
    chapters,
    footnotes,
    _semanticLineItemsV1: true,
    _semanticTextChunksV1: true,
    epubDiagnostics: pendingImport.diagnostics,
  };

  const key = storageKey();
  const localIndex = readStoredBooks(key);
  const durableBooks = await readDurableBooks(key);
  const books = mergeBookLists(durableBooks, localIndex);
  const existing = books.find(item => item?.importKey === importKey && Array.isArray(item?.chapters));
  const next = existing
    ? books
    : mergeBookLists([book], books.filter(item => item?.id !== book.id));

  // Full content has exactly one local authority: IndexedDB. Do not close the
  // import modal and do not shrink the legacy localStorage snapshot until this
  // write succeeds.
  try {
    setStatus('⏳ Сохраняю книгу…');
    await libraryIdbPut(key, next);
  } catch (error) {
    console.error('[semantic epub] durable save failed', error);
    setStatus(`❌ Книга разобрана, но не сохранилась в IndexedDB: ${String(error?.message || error)}. Импорт оставлен открытым — можно повторить.`, 'error');
    return;
  }

  try {
    writeLocalIndex(key, next);
  } catch (error) {
    // The durable book is safe. A tiny index failure must not make us write the
    // huge book back into localStorage; Reader will rebuild the index from IDB.
    console.warn('[semantic epub] lightweight local index write failed', error);
    try { localStorage.removeItem(key); } catch {}
  }

  const importedBookId = pendingImport.bookId;
  const target = existing || book;
  pendingImport = null;

  if (existing && importedBookId !== existing.id) {
    await imgStoreDeleteBook(importedBookId).catch(() => {});
  }

  window.closeReaderImportModal?.();
  await window.renderReaderScreen?.();
  await window.readerOpenBook?.(target.id);

  window.showToast?.(existing
    ? '📚 Такая книга уже есть — открыта существующая'
    : '📖 EPUB добавлен');
}

function realHandler(name) {
  const saved = window[`__real_${name}`];
  if (typeof saved === 'function' && !saved.__isStub) return saved;
  const direct = window[name];
  if (typeof direct === 'function' && !direct.__isStub) return direct;
  return null;
}

function publishHandler(name, handler) {
  window[name] = handler;
  window[`__real_${name}`] = handler;
}

function installWhenReady() {
  const originalImport = realHandler('readerImportFromFile');
  const originalSave = realHandler('saveReaderImport');
  if (typeof originalImport !== 'function' || typeof originalSave !== 'function') return false;

  if (originalImport.__semanticStage1 && originalSave.__semanticStage1) {
    publishHandler('readerImportFromFile', originalImport);
    publishHandler('saveReaderImport', originalSave);
    return true;
  }

  const wrappedImport = event => handleSemanticEpub(event, originalImport);
  wrappedImport.__semanticStage1 = true;
  wrappedImport.__semanticOriginal = originalImport;
  publishHandler('readerImportFromFile', wrappedImport);

  const wrappedSave = () => savePendingSemanticBook(originalSave);
  wrappedSave.__semanticStage1 = true;
  wrappedSave.__semanticOriginal = originalSave;
  publishHandler('saveReaderImport', wrappedSave);
  return true;
}

export function installSemanticRouteNow() {
  return installWhenReady();
}

export function installSemanticImportBridge() {
  if (bridgeStarted) return;
  bridgeStarted = true;
  if (installWhenReady()) return;

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (installWhenReady() || attempts >= 200) clearInterval(timer);
  }, 50);
}
