import {
  libraryIdbGet,
  libraryIdbPut,
} from './library-idb-store.js?v=1';
import { imgStoreDeleteBook } from './image-store.js?v=1';
import {
  chapterContentText,
  firstReadableContentIndex,
} from './semantic-content.js?v=1';
import { parseSemanticEpubFile } from './semantic-import-stage1.js?v=1';

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
      if (!previous || new Date(book.updatedAt || 0) >= new Date(previous.updatedAt || 0)) {
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

function setInputValue(id, value, onlyWhenEmpty = false) {
  const element = document.getElementById(id);
  if (!element) return;
  if (onlyWhenEmpty && String(element.value || '').trim()) return;
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

    setInputValue('reader-import-title', result.title, true);
    setInputValue('reader-import-author', result.author, true);
    const languageSelect = document.getElementById('reader-import-lang');
    const validMetadataLang = ['fr', 'en', 'zh', 'es'].includes(result.lang);
    // The modal may prefill the current app language automatically. EPUB metadata
    // should beat that automatic default, but never overwrite a manual user pick.
    if (languageSelect && validMetadataLang && languageSelect.dataset.userChanged !== '1') {
      languageSelect.value = result.lang;
    }
    if (preview) {
      preview.value = buildPreview(result);
      preview.placeholder = 'EPUB разобран семантическим импортёром. При сохранении используется полная структура книги.';
    }

    const diag = result.diagnostics || {};
    const missing = diag.missingImages?.length || 0;
    setStatus(
      `✅ EPUB проверен: ${diag.chapters || 0} глав · ${diag.images || 0} изображений · ${diag.textChars || 0} знаков${missing ? ` · не найдено изображений: ${missing}` : ''}. Нажми «Сохранить».`,
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
    console.warn('[semantic epub] IndexedDB read failed; preserving local snapshot', error);
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
  const firstItems = chapters[0]?.paragraphs || [];
  const charCount = Number(pendingImport.diagnostics?.textChars || 0);
  const importKey = `semantic-v2:${language}:${hashText(`${title}|${author}|${chapters.length}|${charCount}`)}`;

  const book = {
    id: pendingImport.bookId,
    schemaVersion: 2,
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
    epubDiagnostics: pendingImport.diagnostics,
  };

  const key = storageKey();
  const localBooks = readStoredBooks(key);
  const durableBooks = await readDurableBooks(key);
  const books = mergeBookLists(durableBooks, localBooks);
  const existing = books.find(item => item?.importKey === importKey);
  const next = existing
    ? books
    : mergeBookLists([book], books.filter(item => item?.id !== book.id));

  let localSaved = false;
  let durableSaved = false;
  try {
    localStorage.setItem(key, JSON.stringify(next));
    localSaved = true;
  } catch (error) {
    console.warn('[semantic epub] localStorage write failed', error);
  }
  try {
    await libraryIdbPut(key, next);
    durableSaved = true;
  } catch (error) {
    console.warn('[semantic epub] IndexedDB write failed', error);
  }

  if (!localSaved && !durableSaved) {
    setStatus('Не удалось сохранить книгу ни в localStorage, ни в IndexedDB. Импорт не закрыт — можно повторить.', 'error');
    return;
  }

  const importedBookId = pendingImport.bookId;
  const target = existing || book;
  pendingImport = null;

  // A duplicate was parsed under a temporary id, so remove its just-created
  // local image blobs instead of leaving unreachable data in IndexedDB.
  if (existing && importedBookId !== existing.id) {
    await imgStoreDeleteBook(importedBookId).catch(() => {});
  }

  window.closeReaderImportModal?.();
  await window.renderReaderScreen?.();
  await window.readerOpenBook?.(target.id);

  if (existing) {
    window.showToast?.('📚 Такая книга уже есть — открыта существующая');
  } else if (localSaved && durableSaved) {
    window.showToast?.('📖 EPUB добавлен в тестовом семантическом формате');
  } else if (durableSaved) {
    window.showToast?.('📖 EPUB сохранён в IndexedDB; localStorage переполнен');
  } else {
    window.showToast?.('📖 EPUB сохранён локально; резервная запись IndexedDB не сработала');
  }
}

function installWhenReady() {
  const originalImport = window.readerImportFromFile;
  const originalSave = window.saveReaderImport;
  if (typeof originalImport !== 'function' || typeof originalSave !== 'function') return false;
  if (originalImport.__semanticStage1) return true;

  const wrappedImport = event => handleSemanticEpub(event, originalImport);
  wrappedImport.__semanticStage1 = true;
  window.readerImportFromFile = wrappedImport;

  const wrappedSave = () => savePendingSemanticBook(originalSave);
  wrappedSave.__semanticStage1 = true;
  window.saveReaderImport = wrappedSave;
  return true;
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
