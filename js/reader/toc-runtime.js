// Single user-facing TOC runtime.
// It renders exact package navigation only when nav.xhtml/NCX was attached from
// the source EPUB. Old generic "Глава N" data is shown as legacy, never called
// "restored".

import { applyCapturedEpubToc } from './toc-direct.js?v=2';

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let visibleBookId = '';
let visibleTitle = '';
let refreshTimer = null;

function appModule() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function genericTitle(value) {
  return /^(?:глава|chapter|cap[ií]tulo|chapitre)\s*\d+$/i.test(clean(value));
}

function itemText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return String(item.text || item.value || item.content || item.caption || item.alt || '');
}

function fallbackTitle(book, chapter, index) {
  const current = clean(chapter?.title);
  if (current && !genericTitle(current)) return current;
  for (const item of chapter?.paragraphs || []) {
    const text = clean(itemText(item));
    if (!text) continue;
    if (text.toLowerCase() === clean(book?.title).toLowerCase()) continue;
    if (text.toLowerCase() === clean(book?.author).toLowerCase()) continue;
    const numbered = text.match(/^(\d{1,3})\s+(.{1,70}?)(?=\s+[A-ZÁÉÍÓÚÑÜ][\p{Ll}áéíóúñü])/u);
    if (numbered) return `${numbered[1]}. ${clean(numbered[2])}`;
    if (text.length <= 100) return text;
    break;
  }
  return current || `Раздел ${index + 1}`;
}

export function setTocVisibleBook(book) {
  if (!book) return;
  visibleBookId = String(book.id || visibleBookId || '');
  visibleTitle = clean(book.title || visibleTitle || '');
}

async function freshBook() {
  const app = await appModule();
  let books = [];
  try { books = app.loadReaderBooks?.() || []; } catch {}
  if (visibleBookId) {
    const byId = books.find(book => String(book?.id || '') === visibleBookId);
    if (byId?.chapters?.length) return byId;
  }
  try {
    const current = app.readerCurrentBook?.();
    if (current?.chapters?.length) return current;
  } catch {}
  const title = clean(document.getElementById('reader-book-title')?.textContent || visibleTitle);
  if (title) {
    const matches = books.filter(book => clean(book?.title) === title);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function ensureStyle() {
  if (document.getElementById('reader-toc-runtime-style')) return;
  const style = document.createElement('style');
  style.id = 'reader-toc-runtime-style';
  style.textContent = `
    #reader-toc-header{display:flex;align-items:center;justify-content:space-between;gap:10px}
    #reader-toc-header .rd-toc-meta{font-family:'IBM Plex Sans',sans-serif;font-size:.68rem;font-weight:400;color:var(--text-muted);text-align:right}
    .rd-toc-item[data-depth="1"]{background:color-mix(in srgb,var(--surface2) 35%,transparent)}
    .rd-toc-item[data-depth="2"]{background:color-mix(in srgb,var(--surface2) 55%,transparent)}
    .rd-toc-item.toc-parent .rd-toc-title{font-weight:700}
    .rd-toc-item.toc-unmapped{opacity:.55}
    .rd-toc-indent{display:inline-block;flex:0 0 auto;width:var(--toc-indent,0px)}
    .rd-toc-title{word-break:break-word}
    .rd-toc-count:empty{display:none}
    .rd-toc-legacy-note{padding:10px 18px 12px;font:500 .76rem/1.45 'IBM Plex Sans',sans-serif;color:var(--text-muted);border-bottom:1px solid var(--border)}
  `;
  document.head.appendChild(style);
}

function exactRows(book) {
  const rows = Array.isArray(book?.toc) ? book.toc : [];
  const exact = !!book?._epubTocExact && rows.length > 0 && /^EPUB[23]/i.test(String(book.epubTocSource || ''));
  return exact ? rows : null;
}

function legacyRows(book) {
  return (book.chapters || []).map((chapter, index) => ({
    title: fallbackTitle(book, chapter, index),
    depth: 0,
    chapterIndex: index,
    hasChildren: false,
  }));
}

async function goTo(book, chapterIndex) {
  const app = await appModule();
  const ci = Math.max(0, Math.min(Number(chapterIndex) || 0, Math.max(0, (book.chapters || []).length - 1)));
  book.currentChapter = ci;
  book.currentParagraph = 0;
  book.updatedAt = new Date().toISOString();
  try { app.saveReaderBooks?.(); } catch {}
  try { await app.readerOpenBook?.(book.id); }
  catch (error) { console.warn('[toc-runtime] open chapter failed', error); }
}

export async function openToc() {
  const book = await freshBook();
  if (!book?.chapters?.length) {
    window.showToast?.('⚠️ Не нашёл открытую книгу в библиотеке');
    return false;
  }
  setTocVisibleBook(book);
  ensureStyle();

  const list = document.getElementById('reader-toc-list');
  const back = document.getElementById('reader-toc-back');
  const sheet = document.getElementById('reader-toc-sheet');
  const header = document.getElementById('reader-toc-header');
  if (!list || !back || !sheet) return false;

  const exact = exactRows(book);
  const rows = exact || legacyRows(book);
  const cur = Math.max(0, Number(book.currentChapter) || 0);
  const source = exact ? clean(book.epubTocSource) : 'без исходного TOC';
  if (header) {
    header.innerHTML = `<span>Оглавление</span><span class="rd-toc-meta">${rows.length} пунктов · ${esc(source)}</span>`;
  }

  list.innerHTML = rows.map((row, i) => {
    const raw = row.chapterIndex;
    const ci = raw === null || raw === undefined ? null : Number(raw);
    const mapped = Number.isInteger(ci) && ci >= 0 && ci < book.chapters.length;
    const current = mapped && ci === cur;
    const done = mapped && ci < cur;
    const depth = Math.max(0, Math.min(6, Number(row.depth) || 0));
    const parent = row.hasChildren === true || Number(rows[i + 1]?.depth || 0) > depth;
    const chapter = mapped ? book.chapters[ci] : null;
    const count = chapter ? (chapter.paragraphs || []).length : 0;
    const icon = done ? '✓' : current ? '▶' : parent ? '▸' : '•';
    const cls = `rd-toc-item${current ? ' current' : ''}${done ? ' done' : ''}${parent ? ' toc-parent' : ''}${mapped ? '' : ' toc-unmapped'}`;
    const title = clean(row.title) || fallbackTitle(book, chapter, ci ?? i);
    const inside = `<span class="rd-toc-num">${icon}</span><span class="rd-toc-indent" style="--toc-indent:${depth * 18}px"></span><span class="rd-toc-title">${esc(title)}</span><span class="rd-toc-count">${count ? `${count} абз.` : ''}</span>`;
    return mapped
      ? `<button class="${cls}" data-depth="${depth}" data-toc-chapter="${ci}">${inside}</button>`
      : `<div class="${cls}" data-depth="${depth}">${inside}</div>`;
  }).join('');

  if (!exact) {
    list.insertAdjacentHTML('afterbegin',
      '<div class="rd-toc-legacy-note">В этой старой записи EPUB-оглавление не сохранилось. Повторный импорт исходного EPUB обновит эту же книгу и подставит настоящее NCX/nav-оглавление.</div>');
  }

  list.querySelectorAll('[data-toc-chapter]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      back.classList.remove('show');
      sheet.classList.remove('show');
      await goTo(book, Number(button.dataset.tocChapter));
    });
  });

  back.classList.add('show');
  sheet.classList.add('show');
  setTimeout(() => list.querySelector('.current')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 50);
  console.info('[toc-runtime] open', {
    book: book.title,
    rows: rows.length,
    exact: !!exact,
    source: book.epubTocSource || '',
    first: rows.slice(0, 8).map(row => row.title),
  });
  return true;
}

function installOpen() {
  openToc.__tocRuntime = true;
  window.readerOpenToc = openToc;
  window.__real_readerOpenToc = openToc;
}

function installSaveWrapper() {
  const fn = window.saveReaderImport;
  if (typeof fn !== 'function' || fn.__isStub || fn.__tocRuntimeSaveV2) return;
  const wrapped = function saveReaderImportWithExactToc(...args) {
    const title = clean(document.getElementById('reader-import-title')?.value || '');
    const author = clean(document.getElementById('reader-import-author')?.value || '');
    const result = fn.apply(this, args);
    Promise.resolve(result)
      .then(() => applyCapturedEpubToc({ title, author }))
      .then(applied => {
        if (applied?.ok) {
          visibleBookId = String(applied.bookId || visibleBookId);
          visibleTitle = clean(applied.book?.title || visibleTitle);
        }
      })
      .catch(error => console.warn('[toc-runtime] exact EPUB TOC post-save failed', error));
    return result;
  };
  wrapped.__tocRuntimeSaveV2 = true;
  wrapped.__wrapped = fn;
  window.saveReaderImport = wrapped;
  window.__real_saveReaderImport = wrapped;
}

document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  const trigger = target?.closest?.('.rd-head,[onclick*="readerOpenToc"]');
  if (!trigger || !document.getElementById('reader-reading-view')?.contains(trigger)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openToc().catch(error => {
    console.error('[toc-runtime] open failed', error);
    window.showToast?.(`⚠️ Оглавление: ${error?.message || error}`);
  });
}, true);

function refresh() {
  installOpen();
  installSaveWrapper();
}

for (const delay of [0, 50, 150, 400, 1000, 2500, 6000]) setTimeout(refresh, delay);
window.addEventListener('pageshow', refresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
refreshTimer = setInterval(refresh, 10000);
window.addEventListener('pagehide', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
});

console.info('[toc-runtime] loaded');
