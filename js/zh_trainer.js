// ════════════════════════════════════════════════
// zh_trainer.js — SRS-тренажёр по прочитанным ZH словам v70.2
// ════════════════════════════════════════════════

let zhQueue = [];       // текущая очередь карточек
let zhCurrent = null;   // текущая карточка
let zhSessionGood = 0;
let zhSessionAgain = 0;
let zhRevealed = false;

// ── Сборка очереди ──────────────────────────────
function zhBuildQueue() {
  const scopedKey = typeof globalThis.an2ReaderStorageKey === 'function'
    ? globalThis.an2ReaderStorageKey
    : (k) => k;

  let wordState = {};
  try { wordState = JSON.parse(localStorage.getItem(scopedKey('an2_reader_word_state_v1')) || '{}') || {}; }
  catch { wordState = {}; }

  const entries = Object.values(wordState).filter(w =>
    w && w.word &&
    String(w.lang || '').slice(0,2) === 'zh' &&
    /[\u3400-\u9FFF]/.test(w.word) &&
    !w.known &&
    ((w.clicked || 0) > 0 || w.saved || w.status === 'learning' || w.status === 'familiar')
  );

  // Сортировка: сначала saved+learning, затем по дате последнего просмотра (старые вперёд)
  entries.sort((a, b) => {
    const aScore = (a.saved ? 2 : 0) + (a.status === 'learning' ? 1 : 0);
    const bScore = (b.saved ? 2 : 0) + (b.status === 'learning' ? 1 : 0);
    if (bScore !== aScore) return bScore - aScore;
    return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
  });

  return entries.slice(0, 30); // макс 30 карточек за сессию
}

// ── Получить контекстное предложение из книги ──
function zhGetContext(wordEntry) {
  if (!wordEntry?.places) return null;
  const placeKeys = Object.keys(wordEntry.places);
  if (!placeKeys.length) return null;

  let books = [];
  try {
    const scopedKey = typeof globalThis.an2ReaderStorageKey === 'function'
      ? globalThis.an2ReaderStorageKey : (k) => k;
    books = JSON.parse(localStorage.getItem(scopedKey('an2_reader_books_v1')) || '[]') || [];
  } catch { return null; }

  // Ищем первый placeKey у которого есть книга в localStorage
  for (const pk of placeKeys) {
    const [bookId, chapterId, paragIdx] = pk.split(':');
    const book = books.find(b => b.id === bookId);
    if (!book) continue;

    const ch = book.chapters?.find(c => (c.id || '') === chapterId)
      || book.chapters?.[parseInt(chapterId, 10)];
    if (!ch) continue;

    const para = ch.paragraphs?.[parseInt(paragIdx, 10)];
    if (!para) continue;

    // Вытащить предложение с этим словом
    const sentences = para.split(/(?<=[。！？!?…])/g).filter(Boolean);
    const word = wordEntry.word;
    const sent = sentences.find(s => s.includes(word)) || sentences[0] || para;
    return { sentence: sent.trim(), bookTitle: book.title || '—', para };
  }
  return null;
}

// ── Получить перевод ──
function zhGetTranslation(wordEntry) {
  const word = wordEntry.word;
  // 1. Из word_state.ru (сохранённый через DeepSeek)
  if (wordEntry.ru) return wordEntry.ru;
  // 2. Из lexical cache
  try {
    if (typeof readerGetCachedLexical === 'function') {
      const cached = readerGetCachedLexical(word, 'zh');
      if (cached?.ru) return cached.ru;
    }
  } catch {}
  // 3. Из CC-CEDICT (локальный словарь)
  try {
    if (typeof readerLookupChineseWord === 'function') {
      const entry = readerLookupChineseWord(word);
      if (entry?.ru) return entry.ru;
      if (entry?.en) return entry.en; // fallback английский
    }
  } catch {}
  return null;
}

// ── Получить pinyin ──
function zhGetPinyin(wordEntry) {
  const word = wordEntry.word;
  try {
    if (typeof readerGetCachedLexical === 'function') {
      const c = readerGetCachedLexical(word, 'zh');
      if (c?.pinyin) return c.pinyin;
    }
  } catch {}
  try {
    if (typeof readerLookupChineseWord === 'function') {
      const e = readerLookupChineseWord(word);
      if (e?.pinyin) return e.pinyin;
    }
  } catch {}
  return wordEntry.reading || wordEntry.pinyin || '';
}

// ── Рендер карточки ──────────────────────────────
export function renderZhTrainer() {
  zhQueue = zhBuildQueue();
  zhSessionGood = 0;
  zhSessionAgain = 0;
  zhAdvance();
}

function zhAdvance() {
  const body = document.getElementById('zh-trainer-body');
  const countEl = document.getElementById('zh-tr-count');
  if (!body) return;

  if (!zhQueue.length) {
    zhRenderDone(body);
    if (countEl) countEl.textContent = '';
    return;
  }

  zhCurrent = zhQueue.shift();
  zhRevealed = false;
  const remaining = zhQueue.length + 1;
  if (countEl) countEl.textContent = remaining + ' осталось';
  zhRenderCard(body, zhCurrent);
}

function zhRenderCard(body, entry) {
  const ctx = zhGetContext(entry);
  const sentence = ctx?.sentence || '';
  const bookTitle = ctx?.bookTitle || '';

  // Подсветить слово в предложении
  const highlighted = sentence
    ? sentence.replace(entry.word, `<mark class="zh-tr-mark">${esc(entry.word)}</mark>`)
    : '';

  body.innerHTML = `
    <div class="zh-card">
      <div class="zh-card-word">${esc(entry.word)}</div>

      ${sentence ? `
        <div class="zh-card-context">
          <div class="zh-card-sent">${highlighted || esc(sentence)}</div>
          ${bookTitle ? `<div class="zh-card-source">— ${esc(bookTitle)}</div>` : ''}
        </div>
      ` : `<div class="zh-card-no-ctx">контекст не найден</div>`}

      <div id="zh-card-answer" class="zh-card-answer zh-hidden"></div>

      <div class="zh-card-actions">
        <button class="zh-btn zh-btn-reveal" id="zh-btn-reveal" onclick="zhReveal()">
          Показать перевод
        </button>
        <div class="zh-btn-row" id="zh-btn-row" style="display:none">
          <button class="zh-btn zh-btn-again" onclick="zhGrade('again')">Ещё раз</button>
          <button class="zh-btn zh-btn-good" onclick="zhGrade('good')">Знаю ✓</button>
        </div>
      </div>
    </div>

    <div class="zh-session-bar">
      <span class="zh-s-good">✓ ${zhSessionGood}</span>
      <span class="zh-s-again">↻ ${zhSessionAgain}</span>
    </div>
  `;
}

function zhReveal() {
  if (zhRevealed) return;
  zhRevealed = true;

  const entry = zhCurrent;
  const pinyin = zhGetPinyin(entry);
  const ru = zhGetTranslation(entry);

  const answerEl = document.getElementById('zh-card-answer');
  const revealBtn = document.getElementById('zh-btn-reveal');
  const btnRow = document.getElementById('zh-btn-row');

  if (answerEl) {
    answerEl.classList.remove('zh-hidden');
    answerEl.innerHTML = `
      ${pinyin ? `<div class="zh-card-pinyin">${esc(pinyin)}</div>` : ''}
      <div class="zh-card-ru">${ru ? esc(ru) : '<span class="zh-no-ru">перевод не найден — открой слово в тексте</span>'}</div>
      ${entry.status ? `<div class="zh-card-status">${zhStatusRu(entry)}</div>` : ''}
    `;
  }
  if (revealBtn) revealBtn.style.display = 'none';
  if (btnRow) btnRow.style.display = 'flex';
}

function zhGrade(grade) {
  if (!zhCurrent) return;
  if (grade === 'good') {
    zhSessionGood++;
    // Пометить как known если много раз знаю подряд — пока просто двигаем дальше
  } else {
    zhSessionAgain++;
    // Вернуть в конец очереди
    zhQueue.push(zhCurrent);
    if (zhQueue.length > 15) zhQueue = zhQueue.slice(-15); // не раздувать
  }
  zhAdvance();
}

function zhRenderDone(body) {
  const total = zhSessionGood + zhSessionAgain;
  body.innerHTML = `
    <div class="zh-done">
      <div class="zh-done-icon">🀄</div>
      <div class="zh-done-title">Сессия завершена</div>
      <div class="zh-done-stats">
        <span class="zh-s-good">✓ ${zhSessionGood} знаю</span>
        <span class="zh-s-again">↻ ${zhSessionAgain} повторить</span>
      </div>
      ${total === 0 ? `<div class="zh-done-hint">Читай тексты на китайском — слова появятся здесь автоматически.</div>` : ''}
      <button class="zh-btn zh-btn-reveal" onclick="renderZhTrainer()" style="margin-top:20px">
        Ещё раз
      </button>
    </div>
  `;
}

function zhStatusRu(entry) {
  if (entry.status === 'learning') return 'изучаю';
  if (entry.status === 'familiar') return 'закрепляется';
  if (entry.saved) return 'в словаре';
  return 'просмотрено';
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Expose to window
window.renderZhTrainer = renderZhTrainer;
window.zhReveal = zhReveal;
window.zhGrade = zhGrade;
