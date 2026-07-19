// ════════════════════════════════════════════════
// home.js — reader-first главный экран v70.1
// ════════════════════════════════════════════════

import { libraryIdbGet } from './reader/library-idb-store.js?v=1';
import {
  buildWordCandidates,
  installWordCandidateBridge,
  setCandidateStatus,
} from './reader/word-candidates.js?v=1';

installWordCandidateBridge();
let currentHomeCandidates = [];

function homeEscape(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function ensureCandidateModal() {
  let modal = document.getElementById('reader-candidate-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'reader-candidate-modal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:1200;background:rgba(35,25,15,.48);align-items:flex-end;justify-content:center;padding:0;';
  modal.addEventListener('click', event => {
    if (event.target === modal) window.closeReaderCandidateModal?.();
  });
  document.body.appendChild(modal);
  return modal;
}

window.closeReaderCandidateModal = function closeReaderCandidateModal() {
  const modal = document.getElementById('reader-candidate-modal');
  if (modal) modal.style.display = 'none';
};

window.readerCandidateAction = async function readerCandidateAction(index, status) {
  const candidate = currentHomeCandidates[Number(index)];
  if (!candidate) return;
  await setCandidateStatus(candidate, status);
  window.closeReaderCandidateModal?.();
  await renderHome();
  try {
    globalThis.showToast?.(status === 'known' ? '✓ Убрано как знакомое' : '＋ Добавлено в изучение');
  } catch {}
};

window.openReaderCandidate = function openReaderCandidate(index) {
  const candidate = currentHomeCandidates[Number(index)];
  if (!candidate) return;
  const modal = ensureCandidateModal();
  const variants = candidate.variants?.length
    ? `<div style="font-size:.76rem;color:var(--text-muted);margin-top:4px">формы: ${candidate.variants.map(homeEscape).join(', ')}</div>`
    : '';
  const contexts = candidate.contexts.slice(0, 5).map((row, rowIndex) => `
    <div style="padding:11px 12px;border:1px solid var(--border);border-radius:11px;background:var(--surface2)">
      <div style="font-size:.68rem;color:var(--text-dim);margin-bottom:5px">${homeEscape(row.bookTitle || 'текст')}${row.chapterTitle ? ' · ' + homeEscape(row.chapterTitle) : ''}${row.form && row.form !== candidate.lemma ? ' · форма ' + homeEscape(row.form) : ''}</div>
      <div style="font-family:'Lora',serif;font-size:.94rem;line-height:1.55;color:var(--text)">${homeEscape(row.text || 'Контекст не сохранён')}</div>
    </div>`).join('');
  modal.innerHTML = `
    <section style="width:100%;max-width:620px;max-height:88vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:20px 20px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -14px 38px rgba(30,20,10,.24)">
      <div style="width:42px;height:4px;border-radius:4px;background:var(--border);margin:0 auto 15px"></div>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div>
          <div style="font-family:'Playfair Display',serif;font-size:1.65rem;font-weight:600;color:var(--text)">${homeEscape(candidate.lemma)}</div>
          <div style="font-size:.76rem;color:var(--accent);margin-top:3px">${candidate.contextCount} разных контекста за 30 дней</div>
          ${variants}
        </div>
        <button onclick="closeReaderCandidateModal()" style="border:none;background:none;color:var(--text-muted);font-size:1.5rem;cursor:pointer">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin:15px 0">${contexts}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
        <button onclick="readerCandidateAction(${Number(index)},'learning')" class="btn btn-primary" style="padding:11px 12px">＋ В изучение</button>
        <button onclick="readerCandidateAction(${Number(index)},'known')" class="btn btn-secondary" style="padding:11px 12px">✓ Уже знаю</button>
      </div>
    </section>`;
  modal.style.display = 'flex';
};

export async function renderHome() {
  const $ = (id) => document.getElementById(id);
  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  const escape = homeEscape;

  const scopedKey = (base) =>
    typeof globalThis.an2ReaderStorageKey === 'function'
      ? globalThis.an2ReaderStorageKey(base)
      : base;

  const lang = globalThis.AN2_LANG || 'fr';
  const isZh = lang === 'zh';

  // ── Обновить UI переключателя языка ──
  if (typeof globalThis.updateLangUI === 'function') globalThis.updateLangUI();
  else {
    const btnFr = $('hlb-fr'); const btnEn = $('hlb-en'); const btnZh = $('hlb-zh'); const btnEs = $('hlb-es');
    if (btnFr) btnFr.classList.toggle('active', lang === 'fr');
    if (btnEn) btnEn.classList.toggle('active', lang === 'en');
    if (btnZh) btnZh.classList.toggle('active', isZh);
    if (btnEs) btnEs.classList.toggle('active', lang === 'es');
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

  const sorted = [...langBooks].sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const primary = sorted[0] || null;
  const coverClass = (book) => {
    const l = String(book.lang || book.sourceLang || 'fr').slice(0, 2);
    return ['fr', 'en', 'zh'].includes(l) ? l : 'de';
  };

  const section = $('home-continue-section');
  if (section) {
    if (!primary) {
      // Nothing to continue — the persistent "Добавить текст" button below
      // already covers this case, no need for a second add prompt here.
      section.innerHTML = '';
    } else {
      const pct = bookProgress(primary);
      const chInfo = (() => {
        const ch = primary.chapters?.[primary.currentChapter || 0];
        const pi = primary.currentParagraph || 0;
        const total = ch?.paragraphs?.length || 0;
        return ch ? `${escape(ch.title || `Гл. ${(primary.currentChapter||0)+1}`)} · абзац ${pi+1}/${total}` : `${pct}%`;
      })();
      const letter = escape((primary.title || '?').trim().slice(0, 1).toUpperCase());
      section.innerHTML = `
        <div class="home-section-label">продолжить</div>
        <div class="lib-cont-card">
          <div class="lib-cover lib-cover-${coverClass(primary)}">${letter}</div>
          <div class="lib-cont-body" onclick="showScreen('reader');readerOpenBook('${escape(primary.id)}')">
            <div class="lib-cont-title">${escape(primary.title || 'Текст')}</div>
            <div class="lib-cont-meta">${langFlag(primary.lang || primary.sourceLang)} ${escape(chInfo)}</div>
            <div class="lib-prog-bar"><div class="lib-prog-fill" style="width:${pct}%"></div></div>
          </div>
          <button class="lib-cont-go" onclick="showScreen('reader');readerOpenBook('${escape(primary.id)}')">Читать</button>
        </div>
        ${langBooks.length > 1 ? `
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
  const readMinutes = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('an2_reader_time_v1') || '{}');
      const today = new Date().toISOString().slice(0, 10);
      return raw.date === today ? Math.round(raw.minutes || 0) : 0;
    } catch { return 0; }
  })();
  setText('home-stat-minutes', readMinutes > 0 ? readMinutes : '—');

  // Legacy
  setText('home-books-count', books.length);
  setText('home-books-count-new', langBooks.length);
  setText('home-saved-words-new', savedCount ? savedCount + ' сохранено' : 'сохранённые');

  // ── Новости: один компактный линк, без отдельных карточек ──
  const newsSection = document.getElementById('home-news-section');
  if (newsSection) {
    const newsCount = books.filter(b => b.format === 'news' && String(b.lang || b.sourceLang || 'fr').slice(0,2) === lang).length;
    newsSection.innerHTML = newsCount
      ? `<button class="home-lib-link" onclick="showScreen('reader');setTimeout(()=>readerSetLibTab('news'),120)">📰 Новости (${newsCount}) →</button>`
      : `<button class="home-lib-link" onclick="showScreen('reader');setTimeout(()=>readerSetLibTab('news'),120)">📰 Добавить новость</button>`;
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

  // ── Кандидаты на запоминание ──
  // Only distinct paragraph contexts from the last 30 days count. Inflected
  // forms are grouped by lemma after the word lookup returns its analysis.
  const topSection = $('home-top-clicked-section');
  const topWords = $('home-top-clicked-words');
  if (topSection && topWords) {
    currentHomeCandidates = buildWordCandidates(wordState, {
      lang,
      days: 30,
      minContexts: 2,
      limit: 10,
    });
    const label = topSection.querySelector('.home-section-label');
    if (label) label.textContent = '🔥 кандидаты на запоминание';
    if (!currentHomeCandidates.length) {
      topSection.style.display = 'none';
    } else {
      topSection.style.display = '';
      topWords.innerHTML = currentHomeCandidates.map((candidate, index) => `
        <button type="button" class="home-word-chip" onclick="openReaderCandidate(${index})" style="text-align:left;cursor:pointer">
          <b>${escape(candidate.lemma)}</b>
          <small>${candidate.contextCount} конт.</small>
        </button>`).join('');
    }
  }
}
