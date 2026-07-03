// ════════════════════════════════════════════════
// home.js — reader-first главный экран v70.1
// ════════════════════════════════════════════════

import { libraryIdbGet } from './reader/library-idb-store.js?v=1';

export async function renderHome() {
  const $ = (id) => document.getElementById(id);
  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  const escape = (s) => String(s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  const scopedKey = (base) =>
    typeof globalThis.an2ReaderStorageKey === 'function'
      ? globalThis.an2ReaderStorageKey(base)
      : base;

  const lang = globalThis.AN2_LANG || 'fr';
  const isZh = lang === 'zh';

  // ── Обновить UI переключателя языка ──
  if (typeof globalThis.updateLangUI === 'function') globalThis.updateLangUI();
  else {
    const btnFr = $('hlb-fr'); const btnEn = $('hlb-en'); const btnZh = $('hlb-zh');
    if (btnFr) btnFr.classList.toggle('active', lang === 'fr');
    if (btnEn) btnEn.classList.toggle('active', lang === 'en');
    if (btnZh) btnZh.classList.toggle('active', isZh);
    const icon = $('bn-practice-icon'); const label = $('bn-practice-label');
    if (icon) icon.textContent = isZh ? '🀄' : '⚡';
    if (label) label.textContent = isZh ? 'Символы' : 'Глаголы';
  }

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

  // Same recovery the reader library itself does: a past localStorage quota
  // failure can silently drop books from this snapshot (this reads localStorage
  // directly, not through readerLibrary's hydrate) even though they're still
  // safe in IndexedDB — merge them back in so the home screen doesn't undercount
  // books the reader can still open just fine.
  try {
    const fromIdb = await libraryIdbGet(scopedKey('an2_reader_books_v1'));
    if (Array.isArray(fromIdb) && fromIdb.length) {
      const byId = new Map(books.map(b => [b.id, b]));
      for (const idbBook of fromIdb) {
        if (!idbBook?.id) continue;
        const local = byId.get(idbBook.id);
        if (!local || new Date(idbBook.updatedAt || 0) > new Date(local.updatedAt || 0)) {
          byId.set(idbBook.id, idbBook);
        }
      }
      books = [...byId.values()];
    }
  } catch (_) {}

  // Фильтрация по текущему языку
  const langBooks = books.filter(b => {
    const bl = String(b.lang || b.sourceLang || 'fr').slice(0, 2);
    return bl === lang;
  });

  const bookProgress = (book) => {
    const chapters = book?.chapters || [];
    const total = chapters.reduce((n, ch) => n + (ch.paragraphs?.length || 0), 0) || 1;
    let done = 0;
    const ci = book.currentChapter || 0;
    for (let i = 0; i < Math.min(ci, chapters.length); i++) done += chapters[i].paragraphs?.length || 0;
    done += Math.min(book.currentParagraph || 0, chapters[ci]?.paragraphs?.length || 0);
    return Math.max(0, Math.min(100, Math.round(done / total * 100)));
  };

  const langFlag = (l) => ({ fr: '🇫🇷', zh: '🇨🇳', en: '🇬🇧', de: '🇩🇪', es: '🇪🇸' }[String(l || 'fr').slice(0,2)] || '🌐');
  const formatIcon = (book) => book.format === 'song' ? '🎵' : '📖';

  const sorted = [...langBooks].sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const recent = sorted.slice(0, 3);

  const section = $('home-continue-section');
  if (section) {
    if (!recent.length) {
      const langLabel = isZh ? 'китайский текст' : 'текст';
      section.innerHTML = `
        <div class="home-section-label">начать</div>
        <button onclick="showScreen('reader');setTimeout(()=>showReaderImportModal(),120)" class="home-add-card">
          <span style="font-size:1.6rem">${isZh ? '🀄' : '📖'}</span>
          <div>
            <b>Добавить ${langLabel}</b>
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
              <button class="hcc-btn" onclick="showScreen('reader');setTimeout(()=>{readerOpenBook('${escape(book.id)}');setTimeout(()=>readerListenToggle(),300)},120)">
                🔊 Слушать
              </button>
            </div>
          </div>`;
        }).join('')}
        ${langBooks.length > 3 ? `
          <button class="home-lib-link" onclick="showScreen('reader')">
            Все тексты (${langBooks.length}) →
          </button>` : ''}`;
    }
  }

  // ── Статистика ──
  let wordState = {};
  try {
    wordState = JSON.parse(localStorage.getItem(scopedKey('an2_reader_word_state_v1')) || '{}') || {};
  } catch { wordState = {}; }
  const words = Object.values(wordState).filter(w => w && w.word);

  // Фильтруем слова по языку
  const langWords = words.filter(w => {
    const wl = String(w.lang || 'fr').slice(0, 2);
    return wl === lang;
  });

  const savedCount = langWords.filter(w => w.saved).length;
  const openedToday = langWords.filter(w => {
    if (!w.updatedAt) return false;
    const d = new Date(w.updatedAt);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }).length;

  setText('home-stat-words', openedToday || langWords.filter(w => (w.clicked || 0) > 0).length);
  setText('home-stat-chapters', (() => {
    const total = langBooks.reduce((n, b) => n + (b.currentParagraph || 0), 0);
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

  // Лейблы статов — разные для языков
  const statChLabel = document.querySelector('#home-stats-row-new .home-stat-card:nth-child(2) .home-stat-lbl');
  if (statChLabel) statChLabel.textContent = isZh ? 'абзацев' : 'глав';
  const statWLabel = document.querySelector('#home-stats-row-new .home-stat-card:nth-child(3) .home-stat-lbl');
  if (statWLabel) statWLabel.textContent = isZh ? 'иероглифов' : 'слов открыто';

  // Legacy
  setText('home-books-count', books.length);
  setText('home-books-count-new', langBooks.length + ' ' + plural(langBooks.length, 'текст', 'текста', 'текстов'));
  setText('home-saved-words-new', savedCount ? savedCount + ' сохранено' : 'сохранённые');

  // ── Новости секция ──
  const newsSection = document.getElementById('home-news-section');
  if (newsSection) {
    const newsBooks = books
      .filter(b => b.format === 'news' && String(b.lang || b.sourceLang || 'fr').slice(0,2) === lang)
      .sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0))
      .slice(0, 3);

    if (!newsBooks.length) {
      newsSection.innerHTML = `
        <div class="home-section-label">новости</div>
        <button onclick="showScreen('reader');setTimeout(()=>{readerSetLibTab('news');},120)" class="home-add-card">
          <span style="font-size:1.4rem">📰</span>
          <div><b>Добавить новость</b><small>URL, Wikipedia или текст</small></div>
        </button>`;
    } else {
      newsSection.innerHTML = `
        <div class="home-section-label">новости</div>
        ${newsBooks.map(b => {
          const done = (b.chapters||[]).every((ch,ci) =>
            (b.currentChapter||0) > ci ||
            ((b.currentChapter||0) === ci && (b.currentParagraph||0) >= (ch.paragraphs?.length||1)-1));
          const dateStr = b.newsDate || b.createdAt
            ? new Date(b.newsDate || b.createdAt).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})
            : '';
          const src = b.newsSource || b.author || 'вставка';
          const isNew = !done;
          return `
            <div class="home-news-card${done?' read':''}" onclick="showScreen('reader');setTimeout(()=>readerOpenBook('${escape(b.id)}'),120)">
              ${isNew ? '<div class="home-news-dot"></div>' : ''}
              <div class="home-news-body">
                <div class="home-news-source">📰 ${escape(src)}</div>
                <div class="home-news-title">${escape(b.title)}</div>
                <div class="home-news-meta">${escape(dateStr)}${done?' · прочитано':''}</div>
              </div>
              <button class="home-news-speak" onclick="event.stopPropagation();showScreen('reader');setTimeout(()=>{readerOpenBook('${escape(b.id)}');setTimeout(()=>readerListenToggle(),400)},120)">🔊</button>
            </div>`;
        }).join('')}
        ${newsBooks.length >= 3 ? `<button class="home-lib-link" onclick="showScreen('reader');setTimeout(()=>readerSetLibTab('news'),120)">Все новости →</button>` : ''}`;
    }
  }

  // ── Quick access ──
  const quickGrid = document.querySelector('.home-quick-grid');
  if (quickGrid) {
    quickGrid.innerHTML = `
      <button class="home-quick-card" onclick="showScreen('reader')">
        <i class="hq-icon">📚</i>
        <b>Библиотека</b>
        <small id="home-books-count-new">${langBooks.length} ${plural(langBooks.length,'текст','текста','текстов')}</small>
      </button>
      <button class="home-quick-card" onclick="showScreen('dict')">
        <i class="hq-icon">🔤</i>
        <b>Словарь</b>
        <small>мои слова</small>
      </button>`;
  }

  // ── Последние слова / иероглифы ──
  const recentWords = $('home-recent-reader-words');
  if (recentWords) {
    const rows = langWords
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 10);
    if (!rows.length) {
      const hint = isZh ? 'Иероглифы появятся здесь когда начнёшь читать.' : 'Слова появятся здесь когда начнёшь читать.';
      recentWords.innerHTML = `<div class="home-empty-note">${hint}</div>`;
    } else if (isZh) {
      // Для ZH — карточки с иероглифом и пиньинем
      recentWords.innerHTML = rows.map(w => {
        const pinyin = w.pinyin || w.reading || '';
        return `<span class="home-word-chip zh-chip" onclick="showScreen('dict');setTimeout(()=>window.renderDictWords&&renderDictWords('zh','${escape(w.word)}'),80)">
          <b style="font-size:1.1rem;line-height:1">${escape(w.word)}</b>
          ${pinyin ? `<small style="font-size:.65rem;opacity:.7">${escape(pinyin)}</small>` : ''}
        </span>`;
      }).join('');
    } else {
      recentWords.innerHTML = rows.map(w => {
        const status = w.saved ? 'сохранено' : w.known ? 'знаю' : 'открыто';
        return `<span class="home-word-chip ${w.saved ? 'saved' : ''}">
          <b>${escape(w.word)}</b><small>${escape(status)}</small>
        </span>`;
      }).join('');
    }
  }

  // Секция лейбл
  const recentLabel = document.querySelector('.home-recent-section .home-section-label');
  if (recentLabel) recentLabel.textContent = isZh ? 'последние иероглифы' : 'последние слова';
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
