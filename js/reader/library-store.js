import { repairBookCursorFromRenderedState } from './navigation-position-guard.js?v=1';

// Reader library storage and sync.
// v2 rule: full book content lives in IndexedDB/cloud; localStorage contains
// only a tiny library index plus positions/settings. A legacy full localStorage
// snapshot is never removed until a successful IndexedDB write has completed.

export function createReaderLibraryStore({
  getBooks,
  setBooks,
  storageKey,
  dedupeBooks,
  getCloudUserId,
  isCloudReady,
  db,
  bookImportKey,
  getCloudLoadedOnce,
  setCloudLoadedOnce,
  getCloudSaving,
  setCloudSaving,
  getCloudSaveTimer,
  setCloudSaveTimer,
  getCurrentBookId,
  onError = console.warn,
  onSaveError = null,
  idbGet = async () => null,
  idbPut = async () => {},
}) {
  const INDEX_VERSION = 2;
  let localContainsLegacyFullBooks = false;

  function positionsKey() { return storageKey() + '_pos'; }

  function loadPositions() {
    try { return JSON.parse(localStorage.getItem(positionsKey()) || '{}') || {}; }
    catch { return {}; }
  }

  function savePositions(books) {
    try {
      const positions = {};
      for (const book of books) {
        if (!book?.id) continue;
        positions[book.id] = {
          c: book.currentChapter || 0,
          p: book.currentParagraph || 0,
          t: book.updatedAt || '',
        };
      }
      localStorage.setItem(positionsKey(), JSON.stringify(positions));
    } catch (error) {
      onError('[reader] positions save failed', error);
      onSaveError?.(error);
    }
  }

  function paragraphCount(book = {}) {
    if (!Array.isArray(book.chapters)) return Number(book.paragraphCount || 0);
    return book.chapters.reduce((sum, chapter) => sum + (chapter?.paragraphs?.length || 0), 0);
  }

  function progressValue(book = {}) {
    const chapters = book?.chapters || [];
    if (!chapters.length) return Math.max(0, Math.min(100, Number(book._progressPct || 0)));
    const total = chapters.reduce((sum, chapter) => sum + (chapter.paragraphs?.length || 0), 0) || 1;
    let done = 0;
    const chapterIndex = Math.max(0, Number(book.currentChapter) || 0);
    for (let index = 0; index < Math.min(chapterIndex, chapters.length); index += 1) {
      done += chapters[index].paragraphs?.length || 0;
    }
    done += Math.min(Math.max(0, Number(book.currentParagraph) || 0), chapters[chapterIndex]?.paragraphs?.length || 0);
    return Math.max(0, Math.min(100, Math.round(done / total * 100)));
  }

  function libraryIndexEntry(book = {}) {
    return {
      _libraryIndexV2: INDEX_VERSION,
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
      paragraphCount: paragraphCount(book),
      _progressPct: progressValue(book),
    };
  }

  function isIndexOnlyBook(book) {
    return Number(book?._libraryIndexV2 || 0) >= INDEX_VERSION && !Array.isArray(book?.chapters);
  }

  function writeLocalIndex(books) {
    const index = (Array.isArray(books) ? books : []).filter(book => book?.id).map(libraryIndexEntry);
    localStorage.setItem(storageKey(), JSON.stringify(index));
    localContainsLegacyFullBooks = false;
    return index;
  }

  // Async translation/analysis callbacks in reader-app were written when the
  // requested paragraph was still the active one. They await the network and
  // then assign book.currentParagraph = capturedIndex before save(). If the user
  // has meanwhile jumped through the TOC and kept reading, that late assignment
  // is stale. The DOM is still showing the paragraph the user actually chose,
  // so repair the cursor from the rendered surface BEFORE dedupe/persistence.
  function repairOpenBookCursorFromRenderedDom(source) {
    const books = Array.isArray(source) ? source : [];
    const currentId = String(getCurrentBookId?.() || '');
    if (!currentId || typeof document === 'undefined') return books;

    const book = books.find(item => String(item?.id || '') === currentId);
    const root = document.getElementById('reader-chapter-text');
    if (!book || !root) return books;

    const active = root.dataset.activeParagraph
      ?? root.querySelector?.('.reader-paragraph.active')?.dataset?.p;
    const result = repairBookCursorFromRenderedState({
      book,
      currentBookId: currentId,
      renderedBookId: root.dataset.readerBookId || '',
      renderedChapter: root.dataset.renderedChapter,
      renderedParagraph: active,
      explicitNavigation: Number(globalThis.__readerExplicitNavigationDepth || 0) > 0,
    });

    if (result.changed) {
      console.warn('[reader library] blocked stale async paragraph rollback', {
        bookId: currentId,
        from: result.from,
        to: result.to,
      });
    }
    return books;
  }

  function sameBookKey(a, b) {
    if (!a || !b) return false;
    try { return String(bookImportKey(a) || '') === String(bookImportKey(b) || ''); }
    catch { return false; }
  }

  function preferRicherBook(a, b) {
    if (!a) return b;
    if (!b) return a;
    const aFull = Array.isArray(a.chapters) && a.chapters.length;
    const bFull = Array.isArray(b.chapters) && b.chapters.length;
    if (aFull && !bFull) return a;
    if (bFull && !aFull) return b;
    return new Date(a.updatedAt || 0) >= new Date(b.updatedAt || 0) ? a : b;
  }

  // While a book is open, its id + currentChapter/currentParagraph are
  // authoritative. Duplicates can never roll the cursor backwards.
  function dedupePreservingOpenBook(source) {
    const input = Array.isArray(source) ? source : [];
    const currentId = String(getCurrentBookId?.() || '');
    const liveBooks = getBooks() || [];
    const live = currentId
      ? liveBooks.find(book => String(book?.id || '') === currentId) || null
      : null;
    const inInput = currentId
      ? input.find(book => String(book?.id || '') === currentId) || null
      : null;
    const authoritative = preferRicherBook(inInput, live);

    const deduped = dedupeBooks(input);
    if (!currentId || !authoritative?.id || !Array.isArray(deduped) || !deduped.length) return deduped;

    let index = deduped.findIndex(book => String(book?.id || '') === currentId);
    if (index < 0) index = deduped.findIndex(book => sameBookKey(book, authoritative));
    if (index < 0) return deduped;

    const winner = preferRicherBook(deduped[index], authoritative);
    const wantedChapter = Math.max(0, Number(authoritative.currentChapter) || 0);
    const wantedParagraph = Math.max(0, Number(authoritative.currentParagraph) || 0);
    winner.id = authoritative.id;
    winner.currentChapter = wantedChapter;
    winner.currentParagraph = wantedParagraph;
    if (authoritative.updatedAt) winner.updatedAt = authoritative.updatedAt;
    deduped[index] = winner;
    return deduped;
  }

  // A lightweight local index must never replace a full in-memory/IDB book.
  function mergeNewerFromMemory(fromStorage) {
    const inMemory = getBooks();
    if (!Array.isArray(inMemory) || !inMemory.length) return fromStorage;
    const byId = new Map((fromStorage || []).filter(book => book?.id).map(book => [book.id, book]));
    for (const mem of inMemory) {
      if (!mem?.id) continue;
      const stored = byId.get(mem.id);
      byId.set(mem.id, preferRicherBook(mem, stored));
    }
    return dedupePreservingOpenBook([...byId.values()]);
  }

  function applyPositions(books) {
    const positions = loadPositions();
    for (const book of books) {
      const pos = positions[book?.id];
      if (!pos) continue;
      if (new Date(pos.t || 0) > new Date(book.updatedAt || 0)) {
        book.currentChapter = pos.c || 0;
        book.currentParagraph = pos.p || 0;
        book.updatedAt = pos.t;
      }
    }
    return books;
  }

  function load() {
    let books = [];
    try {
      const raw = localStorage.getItem(storageKey());
      books = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(books)) books = [];
      localContainsLegacyFullBooks = books.some(book => Array.isArray(book?.chapters));
      books = dedupePreservingOpenBook(books);
    } catch (_) {
      books = [];
    }
    books = mergeNewerFromMemory(books);
    applyPositions(books);
    setBooks(books);
    return books;
  }

  let localCommitTimer = null;
  let localIdleHandle = null;
  let localCommitPending = false;

  function cancelScheduledLocalCommit() {
    if (localCommitTimer) clearTimeout(localCommitTimer);
    localCommitTimer = null;
    if (localIdleHandle != null && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(localIdleHandle); } catch {}
    }
    localIdleHandle = null;
  }

  function scheduleLocalCommit(delay = 550) {
    localCommitPending = true;
    cancelScheduledLocalCommit();
    localCommitTimer = setTimeout(() => {
      localCommitTimer = null;
      const run = () => {
        localIdleHandle = null;
        commitLocalSnapshot();
      };
      if (typeof requestIdleCallback === 'function') {
        localIdleHandle = requestIdleCallback(run, { timeout: 1800 });
      } else {
        setTimeout(run, 0);
      }
    }, delay);
  }

  function commitLocalSnapshot() {
    cancelScheduledLocalCommit();
    if (!localCommitPending) return getBooks() || [];
    localCommitPending = false;

    const current = repairOpenBookCursorFromRenderedDom(getBooks() || []);
    const books = dedupePreservingOpenBook(current);
    setBooks(books);
    savePositions(books);

    // Durable content first. Only after it succeeds may the legacy full
    // localStorage snapshot be replaced by the tiny index.
    writeThroughToIndexedDB(books)
      .then(() => {
        try { writeLocalIndex(books); }
        catch (error) { onError('[reader] library index save failed', error); }
      })
      .catch(error => {
        onError('[reader] library IndexedDB save failed; keeping previous local snapshot', error);
        onSaveError?.(error);
      });
    return books;
  }

  function save({ schedule = true } = {}) {
    const current = repairOpenBookCursorFromRenderedDom(getBooks() || []);
    const books = dedupePreservingOpenBook(current);
    setBooks(books);
    savePositions(books);
    localCommitPending = true;
    scheduleLocalCommit(550);
    if (schedule) scheduleCloudSave();
    return books;
  }

  try {
    globalThis.addEventListener?.('pagehide', () => {
      if (localCommitPending) commitLocalSnapshot();
    });
  } catch {}

  let idbHydratedOnce = false;
  async function writeThroughToIndexedDB(books) {
    let mergedBooks = Array.isArray(books) ? books : [];
    if (!idbHydratedOnce) {
      let existing = null;
      try { existing = await idbGet(storageKey()); } catch (_) {}
      if (Array.isArray(existing) && existing.length) {
        const byId = new Map(mergedBooks.filter(book => book?.id).map(book => [book.id, book]));
        for (const idbBook of existing) {
          if (!idbBook?.id) continue;
          const mine = byId.get(idbBook.id);
          byId.set(idbBook.id, preferRicherBook(mine, idbBook));
        }
        mergedBooks = dedupePreservingOpenBook([...byId.values()]);
        setBooks(mergedBooks);
      }
    }
    await idbPut(storageKey(), mergedBooks);
    idbHydratedOnce = true;
    return mergedBooks;
  }

  async function hydrateFromIndexedDB() {
    let fromIdb;
    try {
      fromIdb = await idbGet(storageKey());
    } catch (error) {
      onError('[reader] IndexedDB hydrate read failed', error);
      return false;
    }
    idbHydratedOnce = true;

    const current = getBooks() || [];
    if (!Array.isArray(fromIdb) || !fromIdb.length) {
      // First v2 launch can have a valid legacy localStorage library but no IDB
      // data. Migrate it before shrinking the local key.
      const fullLocal = current.filter(book => Array.isArray(book?.chapters));
      if (fullLocal.length) {
        try {
          await idbPut(storageKey(), fullLocal);
          writeLocalIndex(fullLocal);
          return true;
        } catch (error) {
          onError('[reader] legacy localStorage migration deferred', error);
        }
      }
      return false;
    }

    const byId = new Map(current.filter(book => book?.id).map(book => [book.id, book]));
    let changed = false;
    // libraryIdbGet() can fold a legacy book's still-available payload
    // straight into its result even before that book has actually round-
    // tripped through IndexedDB book-records (see _idbPendingMigration in
    // library-idb-store.js). That keeps the rest of the library visible, but
    // localStorage is that book's only other full copy — never let it be
    // compacted away to a chapters-less index until migration truly lands.
    let hasPendingMigration = false;
    for (const idbBook of fromIdb) {
      if (!idbBook?.id) continue;
      if (idbBook._idbPendingMigration) hasPendingMigration = true;
      const local = byId.get(idbBook.id);
      const winner = preferRicherBook(idbBook, local);
      if (winner !== local || isIndexOnlyBook(local)) changed = true;
      byId.set(idbBook.id, winner);
    }

    const merged = dedupePreservingOpenBook([...byId.values()])
      .map(book => (book._idbPendingMigration ? (({ _idbPendingMigration, ...rest }) => rest)(book) : book));
    applyPositions(merged);
    setBooks(merged);
    if (hasPendingMigration) return changed || localContainsLegacyFullBooks;
    try { writeLocalIndex(merged); }
    catch (error) { onError('[reader] library index refresh failed', error); }
    return changed || localContainsLegacyFullBooks;
  }

  async function loadFromCloud(force = false) {
    if (getCloudLoadedOnce() && !force) return false;
    const userId = getCloudUserId();
    if (!userId || !isCloudReady()) {
      setCloudLoadedOnce(true);
      return false;
    }

    try {
      const { data, error } = await db().from('reader_books')
        .select('id,title,updated_at,data')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (error) throw error;

      const remoteBooks = (data || []).map(row => row.data || {}).filter(book => book.id);
      const byId = new Map((getBooks() || []).filter(book => book?.id).map(book => [book.id, book]));
      for (const remote of remoteBooks) {
        const local = byId.get(remote.id);
        byId.set(remote.id, preferRicherBook(remote, local));
      }
      const merged = dedupePreservingOpenBook([...byId.values()]);
      applyPositions(merged);
      setBooks(merged);
      writeThroughToIndexedDB(merged)
        .then(() => { try { writeLocalIndex(merged); } catch (_) {} })
        .catch(error => onError('[reader] IndexedDB save after cloud load failed', error));
      setCloudLoadedOnce(true);

      if (merged.length !== byId.size) {
        setTimeout(() => saveToCloud({ replaceAll: true }).catch(error => {
          onError('[reader cloud] duplicate cleanup skipped:', error?.message || error);
        }), 0);
      }
      return true;
    } catch (error) {
      setCloudLoadedOnce(true);
      onError('[reader cloud] load skipped:', error?.message || error);
      return false;
    }
  }

  function scheduleCloudSave() {
    const timer = getCloudSaveTimer();
    if (timer) clearTimeout(timer);
    setCloudSaveTimer(setTimeout(() => {
      saveToCloud().catch(error => onError('[reader cloud] save skipped:', error?.message || error));
    }, 2200));
  }

  async function saveToCloud(options = {}) {
    const userId = getCloudUserId();
    if (!userId || !isCloudReady() || getCloudSaving()) return false;

    const current = repairOpenBookCursorFromRenderedDom(getBooks() || []);
    const books = dedupePreservingOpenBook(current).filter(book => Array.isArray(book?.chapters));
    setBooks(dedupePreservingOpenBook(current));
    if (!books.length) {
      if (options.replaceAll) await db().from('reader_books').delete().eq('user_id', userId);
      return false;
    }

    setCloudSaving(true);
    try {
      if (options.replaceAll) {
        try { await db().from('reader_books').delete().eq('user_id', userId); }
        catch (error) { onError('[reader cloud] replaceAll delete skipped:', error?.message || error); }
      }

      const rows = books.map(raw => {
        const book = {
          ...raw,
          importKey: bookImportKey(raw),
          updatedAt: raw.updatedAt || new Date().toISOString(),
        };
        return {
          id: book.id,
          user_id: userId,
          title: book.title || 'Без названия',
          updated_at: book.updatedAt,
          data: book,
        };
      });
      const { error } = await db().from('reader_books').upsert(rows, { onConflict: 'id' });
      if (error) throw error;
      return true;
    } finally {
      setCloudSaving(false);
    }
  }

  function currentBook() {
    let books = getBooks() || [];
    if (!books.length) books = load();
    return books.find(book => book.id === getCurrentBookId()) || null;
  }

  function progress(book) { return progressValue(book); }

  function continueBook() {
    const books = getBooks() || [];
    if (!books.length) return null;
    return [...books].sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
    )[0];
  }

  return {
    load,
    save,
    loadFromCloud,
    hydrateFromIndexedDB,
    scheduleCloudSave,
    saveToCloud,
    currentBook,
    progress,
    continueBook,
  };
}
