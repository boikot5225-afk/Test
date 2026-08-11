// Reader library storage and sync.
// UI rendering and import stay outside this module.

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

  function sameBookKey(a, b) {
    if (!a || !b) return false;
    try { return String(bookImportKey(a) || '') === String(bookImportKey(b) || ''); }
    catch { return false; }
  }

  // Dedupe used to choose the duplicate with the greatest historical progress.
  // That is reasonable for an offline cleanup, but catastrophically wrong while
  // somebody is actively reading: an explicit TOC jump backwards/elsewhere is a
  // NEW navigation decision, not "lost progress". The next render calls save(),
  // dedupe resurrects the farther-ahead duplicate, and the reader teleports to
  // exactly the place it came from.
  //
  // While a book is open, its id + currentChapter/currentParagraph are therefore
  // authoritative. Duplicates may still contribute richer content/annotations via
  // dedupeBooks(), but they can never replace the live reading cursor or its id.
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
    const authoritative = inInput || live;

    const deduped = dedupeBooks(input);
    if (!currentId || !authoritative?.id || !Array.isArray(deduped) || !deduped.length) {
      return deduped;
    }

    let index = deduped.findIndex(book => String(book?.id || '') === currentId);
    if (index < 0) index = deduped.findIndex(book => sameBookKey(book, authoritative));
    if (index < 0) return deduped;

    const winner = deduped[index];
    const winnerId = String(winner?.id || '');
    const wantedId = String(authoritative.id || '');
    const beforeChapter = Number(winner?.currentChapter || 0);
    const beforeParagraph = Number(winner?.currentParagraph || 0);
    const wantedChapter = Math.max(0, Number(authoritative.currentChapter) || 0);
    const wantedParagraph = Math.max(0, Number(authoritative.currentParagraph) || 0);

    winner.id = authoritative.id;
    winner.currentChapter = wantedChapter;
    winner.currentParagraph = wantedParagraph;
    if (authoritative.updatedAt) winner.updatedAt = authoritative.updatedAt;

    if (winnerId !== wantedId || beforeChapter !== wantedChapter || beforeParagraph !== wantedParagraph) {
      console.warn('[reader library] blocked stale duplicate position rollback', {
        bookId: wantedId,
        from: [beforeChapter, beforeParagraph],
        to: [wantedChapter, wantedParagraph],
      });
    }
    return deduped;
  }

  // localStorage may hold a stale copy when quota blocks writes; never let it
  // roll back books that are fresher in memory or drop memory-only books.
  function mergeNewerFromMemory(fromStorage) {
    const inMemory = getBooks();
    if (!Array.isArray(inMemory) || !inMemory.length) return fromStorage;
    const byId = new Map(fromStorage.map(book => [book.id, book]));
    for (const mem of inMemory) {
      if (!mem?.id) continue;
      const stored = byId.get(mem.id);
      if (!stored || new Date(mem.updatedAt || 0) >= new Date(stored.updatedAt || 0)) {
        byId.set(mem.id, mem);
      }
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
      const deduped = dedupePreservingOpenBook(books);
      if (deduped.length !== books.length) {
        localStorage.setItem(storageKey(), JSON.stringify(deduped));
      }
      books = deduped;
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

    let books = dedupePreservingOpenBook(getBooks() || []);
    setBooks(books);
    savePositions(books);

    let localOk = true;
    try {
      localStorage.setItem(storageKey(), JSON.stringify(books));
    } catch (error) {
      onError('[reader] library localStorage cache write failed', error);
      try {
        const slim = books.map(({ readerAnalyses, readerTranslations, ...rest }) => rest);
        localStorage.setItem(storageKey(), JSON.stringify(slim));
        onError('[reader] saved slim library without AI caches');
      } catch (retryError) {
        localOk = false;
        onError('[reader] slim retry also failed (IndexedDB still holds the data)', retryError);
        try {
          localStorage.removeItem(storageKey());
          onError('[reader] removed oversized library key from localStorage to free quota');
        } catch (_) {}
      }
    }

    writeThroughToIndexedDB(books).catch(error => {
      onError('[reader] library IndexedDB save failed', error);
      if (!localOk) onSaveError?.(error);
    });
    return books;
  }

  function save({ schedule = true } = {}) {
    const books = dedupePreservingOpenBook(getBooks() || []);
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
    if (!idbHydratedOnce) {
      let existing = null;
      try { existing = await idbGet(storageKey()); } catch (_) {}
      if (Array.isArray(existing) && existing.length) {
        const byId = new Map(books.map(book => [book.id, book]));
        for (const idbBook of existing) {
          if (!idbBook?.id) continue;
          const mine = byId.get(idbBook.id);
          if (!mine || new Date(idbBook.updatedAt || 0) > new Date(mine.updatedAt || 0)) {
            byId.set(idbBook.id, idbBook);
          }
        }
        books = dedupePreservingOpenBook([...byId.values()]);
      }
    }
    await idbPut(storageKey(), books);
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
    if (!Array.isArray(fromIdb) || !fromIdb.length) return false;

    const current = getBooks() || [];
    const byId = new Map(current.map(book => [book.id, book]));
    let changed = false;
    for (const idbBook of fromIdb) {
      if (!idbBook?.id) continue;
      const local = byId.get(idbBook.id);
      if (!local || new Date(idbBook.updatedAt || 0) > new Date(local.updatedAt || 0)) {
        byId.set(idbBook.id, idbBook);
        changed = true;
      }
    }
    if (!changed) return false;

    const merged = dedupePreservingOpenBook([...byId.values()]);
    applyPositions(merged);
    setBooks(merged);
    try { localStorage.setItem(storageKey(), JSON.stringify(merged)); } catch (_) {}
    return true;
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
      const byId = new Map((getBooks() || []).map(book => [book.id, book]));
      for (const remote of remoteBooks) {
        const local = byId.get(remote.id);
        if (!local || new Date(remote.updatedAt || remote.updated_at || 0) > new Date(local.updatedAt || 0)) {
          byId.set(remote.id, remote);
        }
      }
      const merged = dedupePreservingOpenBook([...byId.values()]);
      applyPositions(merged);
      setBooks(merged);
      try { localStorage.setItem(storageKey(), JSON.stringify(merged)); } catch (_) {}
      writeThroughToIndexedDB(merged).catch(error => {
        onError('[reader] IndexedDB save after cloud load failed', error);
      });
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

    const books = dedupePreservingOpenBook(getBooks() || []);
    setBooks(books);
    if (!books.length) {
      if (options.replaceAll) await db().from('reader_books').delete().eq('user_id', userId);
      return false;
    }

    setCloudSaving(true);
    try {
      if (options.replaceAll) {
        try {
          await db().from('reader_books').delete().eq('user_id', userId);
        } catch (error) {
          onError('[reader cloud] replaceAll delete skipped:', error?.message || error);
        }
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

  function progress(book) {
    const chapters = book?.chapters || [];
    const total = chapters.reduce((sum, chapter) => sum + (chapter.paragraphs?.length || 0), 0) || 1;
    let done = 0;
    const chapterIndex = book.currentChapter || 0;
    for (let index = 0; index < Math.min(chapterIndex, chapters.length); index += 1) {
      done += chapters[index].paragraphs?.length || 0;
    }
    done += Math.min(book.currentParagraph || 0, chapters[chapterIndex]?.paragraphs?.length || 0);
    return Math.max(0, Math.min(100, Math.round(done / total * 100)));
  }

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
