export function createReaderTimeTracker({ key = 'an2_reader_time_v1' } = {}) {
  let paragraphStartedAt = null;
  let openId = null;

  function today() {
    try {
      const record = JSON.parse(localStorage.getItem(key) || '{}');
      const date = new Date().toISOString().slice(0, 10);
      return record.date === date ? (record.minutes || 0) : 0;
    } catch {
      return 0;
    }
  }

  function addSeconds(seconds) {
    if (!seconds || seconds < 2) return;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const record = JSON.parse(localStorage.getItem(key) || '{}');
      const minutes = record.date === date ? (record.minutes || 0) : 0;
      localStorage.setItem(key, JSON.stringify({ date, minutes: minutes + seconds / 60 }));
    } catch {}
  }

  // id identifies "which paragraph" (e.g. `${bookId}:${chapterIndex}:${paragraphIndex}`).
  // render() fires on all sorts of incidental re-renders (a translation
  // arriving, pinyin toggling, etc.), not just on actually moving to a new
  // paragraph — calling openParagraph() unconditionally on every one of those
  // used to reset the clock each time, silently discarding whatever reading
  // time had already accumulated on the still-current paragraph. Only reset
  // when id actually changes; otherwise leave the running timer alone.
  function openParagraph(id = null) {
    if (paragraphStartedAt && id != null && id === openId) return;
    if (paragraphStartedAt) closeParagraph();
    openId = id;
    paragraphStartedAt = Date.now();
  }

  function closeParagraph() {
    if (!paragraphStartedAt) return;
    const seconds = (Date.now() - paragraphStartedAt) / 1000;
    paragraphStartedAt = null;
    openId = null;
    if (seconds >= 3 && seconds <= 300) addSeconds(seconds);
  }

  return { today, addSeconds, openParagraph, closeParagraph };
}
