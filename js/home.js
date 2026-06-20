// ════════════════════════════════════════════════
// home.js — reader-first главный экран v69.5
// ════════════════════════════════════════════════

export async function renderHome() {
  const $ = (id) => document.getElementById(id);
  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  const escape = (s) => String(s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  const scopedKey = (base) =>
    typeof globalThis.an2ReaderStorageKey === 'function'
      ? globalThis.an2ReaderStorageKey(base)
      : base;

  // ── Дата и имя ──
  const username = globalThis.an2CurrentProfileName || '—';
  const avatarEl = $('home-username-avatar');
  if (avatarEl) avatarEl.textContent = username.slice(0, 1).toUpperCase() || '?';
  try {
    setText('home-date', new Date().toLocaleDateString('ru-RU', {
      weekday: 'short', day: 'numeric', month: 'long'
    }));
  } catch { setText('home-date', 'сегодня'); }

  // ── Книги ──
  let books = [];
  try {
    books = JSON.parse(localStorage.getItem(scopedKey('an2_reader_books_v1')) || '[]') || [];
  } catch { books = []; }
  if (!Array.isArray(books)) books = [];

  const bookProgress = (book) => {
    const chapters = book?.chapters || [];
    const total = chapters.reduce((n, ch) => n + (ch.paragraphs?.length || 0), 0) || 1;
    let done = 0;
    const ci = book.currentChapter || 0;
    for (let i = 0; i < Math.min(ci, chapters.length); i++) done += chapters[i].paragraphs?.length || 0;
    done += Math.min(book.currentParagraph || 0, chapters[ci]?.paragraphs?.length || 0);
    return Math.max(0, Math.min(100, Math.round(done / total * 100)));
  };

  const langFlag = (lang) => ({ fr: '🇫🇷', zh: '🇨🇳', en: '🇬🇧', de: '🇩🇪', es: '🇪🇸' }[String(lang || 'fr').slice(0,2)] || '🌐');
  const formatIcon = (book) => book.format === 'song' ? '🎵' : '📖';

  // Сортируем по дате обновления — самые свежие сверху
  const sorted = [...books].sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const recent = sorted.slice(0, 3); // показываем до 3 карточек

  const section = $('home-continue-section');
  if (section) {
    if (!recent.length) {
      section.innerHTML = `
        <div class="home-section-label">начать</div>
        <button onclick="showScreen('reader');setTimeout(()=>showReaderImportModal(),120)" class="home-add-card">
          <span style="font-size:1.6rem">📖</span>
          <div>
            <b>Добавить первый текст</b>
            <small>вставка, TXT, EPUB или URL</small>
          </div>
        </button>`;
    } else {
      section.innerHTML = `
        <div class="home-section-label">продолжить</div>
        ${recent.map((book, idx) => {
          const pct = bookProgress(book);
          const chInfo = (() => {
            const ch = book.chapters?.[book.currentChapter || 0];
            const pi = book.currentParagraph || 0;
            const total = ch?.paragraphs?.length || 0;
            return ch ? `${escape(ch.title || `Гл. ${(book.currentChapter||0)+1}`)} · абзац ${pi+1}/${total}` : '';
          })();
          const isPrimary = idx === 0;
          return `
          <div class="home-continue-card-v2 ${isPrimary ? 'primary' : ''}">
            <div class="hcc-top">
              <div class="hcc-icon">${formatIcon(book)} ${langFlag(book.lang || book.sourceLang)}</div>
              <div class="hcc-meta">
                <div class="hcc-title">${escape(book.title || 'Текст')}</div>
                <div class="hcc-sub">${escape(book.author ? book.author + ' · ' : '')}${escape(chInfo)}</div>
              </div>
              <div class="hcc-pct">${pct}%</div>
            </div>
            <div class="hcc-bar"><div class="hcc-fill" style="width:${pct}%"></div></div>
            <div class="hcc-actions">
              <button class="hcc-btn primary" onclick="showScreen('reader');setTimeout(()=>readerOpenBook('${escape(book.id)}'),120)">
                📖 Читать
              </button>
              <button class="hcc-btn" onclick="showScreen('reader');setTimeout(()=>{readerOpenBook('${escape(book.id)}');setTimeout(()=>readerSpeakCurrentParagraph(),300)},120)">
                🔊 Слушать
              </button>
            </div>
          </div>`;
        }).join('')}
        ${books.length > 3 ? `
          <button class="home-lib-link" onclick="showScreen('reader')">
            Все тексты (${books.length}) →
          </button>` : ''}`;
    }
  }

  // ── Статистика ──
  let wordState = {};
  try {
    wordState = JSON.parse(localStorage.getItem(scopedKey('an2_reader_word_state_v1')) || '{}') || {};
  } catch { wordState = {}; }
  const words = Object.values(wordState).filter(w => w && w.word);
  const savedCount = words.filter(w => w.saved).length;
  const openedToday = words.filter(w => {
    if (!w.updatedAt) return false;
    const d = new Date(w.updatedAt);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }).length;

  setText('home-stat-words', openedToday || words.filter(w => (w.clicked || 0) > 0).length);
  setText('home-stat-chapters', (() => {
    const total = books.reduce((n, b) => n + (b.currentParagraph || 0), 0);
    return total > 0 ? total : 0;
  })());
  const readMinutes = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('an2_reader_time_v1') || '{}');
      const today = new Date().toISOString().slice(0, 10);
      return raw.date === today ? Math.round(raw.minutes || 0) : 0;
    } catch { return 0; }
  })();
  setText('home-stat-minutes', readMinutes > 0 ? readMinutes : '—');

  // Обновляем legacy-совместимые поля
  setText('home-books-count', books.length);
  setText('home-books-count-new', books.length + ' ' + plural(books.length, 'текст', 'текста', 'текстов'));
  setText('home-saved-words-new', savedCount ? savedCount + ' сохранено' : 'сохранённые');

  // ── Последние слова ──
  const recentWords = $('home-recent-reader-words');
  if (recentWords) {
    const rows = words
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 10);
    if (!rows.length) {
      recentWords.innerHTML = `<div class="home-empty-note">Слова появятся здесь когда начнёшь читать.</div>`;
    } else {
      recentWords.innerHTML = rows.map(w => {
        const status = w.saved ? 'сохранено' : w.known ? 'знаю' : 'открыто';
        return `<span class="home-word-chip ${w.saved ? 'saved' : ''}">
          <b>${escape(w.word)}</b><small>${escape(status)}</small>
        </span>`;
      }).join('');
    }
  }
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
