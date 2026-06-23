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
}) {
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
    setBooks(books);
    return books;
  }

  function save({ schedule = true } = {}) {
    let books = dedupeBooks(getBooks() || []);
    setBooks(books);
    try {
      localStorage.setItem(storageKey(), JSON.stringify(books));
    } catch (error) {
      onError('[reader] save failed', error);
    }
    if (schedule) scheduleCloudSave();
    return books;
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
      setBooks(merged);
      localStorage.setItem(storageKey(), JSON.stringify(merged));
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
    scheduleCloudSave,
    saveToCloud,
    currentBook,
    progress,
    continueBook,
  };
}
