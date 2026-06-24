export function createReaderTimeTracker({ key = 'an2_reader_time_v1' } = {}) {
  let paragraphStartedAt = null;

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

  function openParagraph() {
    paragraphStartedAt = Date.now();
  }

  function closeParagraph() {
    if (!paragraphStartedAt) return;
    const seconds = (Date.now() - paragraphStartedAt) / 1000;
    paragraphStartedAt = null;
    if (seconds >= 3 && seconds <= 300) addSeconds(seconds);
  }

  return { today, addSeconds, openParagraph, closeParagraph };
}
