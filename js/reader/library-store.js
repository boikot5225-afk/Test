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
  // localStorage caps out around 5MB/origin — a library with enough transcripts
  // and cached AI translations/analyses can exceed that, and both the normal and
  // slim-retry writes below then fail silently, quietly rolling everything back
  // to the last snapshot that fit. IndexedDB has a much larger practical quota,
  // so it's used as the durable backing store; idbGet/idbPut are optional so this
  // module still works (minus the durability) if they aren't wired up.
  idbGet = async () => null,
  idbPut = async () => {},
}) {
  // Reading positions live in a tiny sidecar key so they survive even when the
  // main library JSON outgrows the localStorage quota and its writes start failing.
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
        positions[book.id] = { c: book.currentChapter || 0, p: book.currentParagraph || 0, t: book.updatedAt || '' };
      }
      localStorage.setItem(positionsKey(), JSON.stringify(positions));
    } catch (error) {
      onError('[reader] positions save failed', error);
      onSaveError?.(error);
    }
  }

  // localStorage may hold a stale copy when quota blocks writes; never let it
  // roll back books that are fresher in memory (e.g. reading position) — and
  // never DROP memory books the snapshot doesn't contain at all. That drop was
  // how the library kept shrinking on every tab switch: the IndexedDB hydrate
  // restored the full list to memory, its localStorage write-back silently
  // failed on quota, and the next load() truncated memory right back to the
  // stale snapshot's subset.
  function mergeNewerFromMemory(fromStorage) {
    const inMemory = getBooks();
    if (!Array.isArray(inMemory) || !inMemory.length) return fromStorage;
    const byId = new Map(fromStorage.map(book => [book.id, book]));
    for (const mem of inMemory) {
      if (!mem?.id) continue;
      const stored = byId.get(mem.id);
      if (!stored || new Date(mem.updatedAt || 0) >= new Date(stored.updatedAt || 0)) byId.set(mem.id, mem);
    }
    return dedupeBooks([...byId.values()]);
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
      const deduped = dedupeBooks(books);
      if (deduped.length !== books.length) localStorage.setItem(storageKey(), JSON.stringify(deduped));
      books = deduped;
    } catch (_) {
      books = [];
    }
    books = mergeNewerFromMemory(books);
    applyPositions(books);
    setBooks(books);
    return books;
  }

  function save({ schedule = true } = {}) {
    let books = dedupeBooks(getBooks() || []);
    setBooks(books);
    savePositions(books);
    // localStorage is only the fast in-session cache now — IndexedDB below is
    // the durable store (no ~5MB ceiling) and cloud sync mirrors it. A quota
    // failure here alone doesn't endanger the data, so it's logged, not surfaced.
    let localOk = true;
    try {
      localStorage.setItem(storageKey(), JSON.stringify(books));
    } catch (error) {
      onError('[reader] library localStorage cache write failed', error);
      // Quota is full: retry without per-book AI caches (translations/analyses are
      // re-fetchable; reading position and word progress are not).
      try {
        const slim = books.map(({ readerAnalyses, readerTranslations, ...rest }) => rest);
        localStorage.setItem(storageKey(), JSON.stringify(slim));
        onError('[reader] saved slim library without AI caches');
      } catch (retryError) {
        localOk = false;
        onError('[reader] slim retry also failed (IndexedDB still holds the data)', retryError);
        // Even the slim copy doesn't fit — this multi-MB key is exactly what
        // starves every OTHER localStorage write (word colors, positions,
        // caches) of quota, while the library itself is already durable in
        // IndexedDB + cloud. Drop it: load() falls back to memory + the
        // IndexedDB hydrate, and the rest of the app gets its quota back.
        try {
          localStorage.removeItem(storageKey());
          onError('[reader] removed oversized library key from localStorage to free quota');
        } catch (_) {}
      }
    }
    // The durable write. Only when BOTH this and localStorage fail is the data
    // actually at risk (in-memory + cloud only) — that's the case worth a toast.
    writeThroughToIndexedDB(books).catch(error => {
      onError('[reader] library IndexedDB save failed', error);
      if (!localOk) onSaveError?.(error);
    });
    if (schedule) scheduleCloudSave();
    return books;
  }

  // Until hydrateFromIndexedDB has merged the durable copy into memory once,
  // a blind put() would overwrite IndexedDB's full library with whatever
  // subset this session happens to hold (e.g. a save firing right after boot
  // from a quota-truncated localStorage snapshot) — that's exactly how books
  // were "randomly disappearing" and only coming back when cloud sync ran.
  // Before hydration: read-merge-write (newer-wins by updatedAt, same rule as
  // hydrate/cloud). After hydration memory is a superset, plain put is safe.
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
        books = dedupeBooks([...byId.values()]);
      }
    }
    await idbPut(storageKey(), books);
  }

  // Call once when the reader UI opens (or on app start) to recover from a
  // localStorage snapshot that's stale or missing books due to a past quota
  // failure. Newer-wins merge by updatedAt, same rule used for cloud sync.
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

    const merged = dedupeBooks([...byId.values()]);
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
      const merged = dedupeBooks([...byId.values()]);
      applyPositions(merged);
      setBooks(merged);
      try { localStorage.setItem(storageKey(), JSON.stringify(merged)); } catch (_) {}
      // Persist the cloud-recovered list durably too, so books restored from
      // the cloud survive the next offline start instead of vanishing again.
      writeThroughToIndexedDB(merged).catch(error => onError('[reader] IndexedDB save after cloud load failed', error));
      setCloudLoadedOnce(true);

      if (merged.length !== byId.size) {
        setTimeout(() => saveToCloud({ replaceAll: true }).catch(error => onError('[reader cloud] duplicate cleanup skipped:', error?.message || error)), 0);
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
    }, 1200));
  }

  async function saveToCloud(options = {}) {
    const userId = getCloudUserId();
    if (!userId || !isCloudReady() || getCloudSaving()) return false;

    const books = dedupeBooks(getBooks() || []);
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
        const book = { ...raw, importKey: bookImportKey(raw), updatedAt: raw.updatedAt || new Date().toISOString() };
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
    return [...books].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
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
