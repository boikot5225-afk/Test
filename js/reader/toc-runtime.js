// Single runtime owner for Reader AI TOC.
// Older 77.42 experiments installed several competing readerOpenToc handlers.
// This module is the only user-facing TOC path: every tap resolves the CURRENT
// saved book again, so a stale object from a pre-import render can never hide a
// freshly attached EPUB nav/NCX outline.

import { applyCapturedEpubToc, repairBookTocFromContent } from './toc-direct.js?v=1';

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let visibleBookId = '';
let visibleTitle = '';
let saveWrapTimer = null;

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
  return String(item.text || item.value || item.content || item.caption || '');
}

function fallbackTitle(book, chapter, index) {
  const current = clean(chapter?.title);
  if (current && !genericTitle(current)) return current;
  const skip = new Set([clean(book?.title).toLowerCase(), clean(book?.author).toLowerCase()]);
  for (const item of chapter?.paragraphs || []) {
    const text = clean(itemText(item));
    if (!text || skip.has(text.toLowerCase())) continue;
    if (text.length <= 110) return text;
    const cut = text.slice(0, 78).replace(/\s+\S*$/, '').trim();
    if (cut) return `${cut}…`;
  }
  if (index === 0 && book?.source === 'epub') return 'Обложка';
  return current || `Раздел ${index + 1}`;
}

export function setTocVisibleBook(book) {
  if (!book) return;
  visibleBookId = String(book.id || visibleBookId || '');
  visibleTitle = clean(book.title || visibleTitle || '');
}

async function freshBook() {
  const app = await appModule();
  const current = app.readerCurrentBook?.();
  let books = [];
  try { books = app.loadReaderBooks?.() || []; } catch {}

  // Prefer the freshly loaded library object, not a cached object captured by a
  // previous renderer. That is what was making 43 old "Глава N" rows survive
  // even after the re-import had already saved a real EPUB outline.
  if (visibleBookId) {
    const byId = books.find(book => String(book?.id || '') === visibleBookId);
    if (byId?.chapters?.length) return byId;
  }
  if (current?.chapters?.length) return current;
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
    #reader-toc-header .rd-toc-meta{font-family:'IBM Plex Sans',sans-serif;font-size:.68rem;font-weight:400;color:var(--text-muted)}
    .rd-toc-item[data-depth="1"]{background:color-mix(in srgb,var(--surface2) 35%,transparent)}
    .rd-toc-item[data-depth="2"]{background:color-mix(in srgb,var(--surface2) 55%,transparent)}
    .rd-toc-item.toc-parent .rd-toc-title{font-weight:700}
    .rd-toc-item.toc-unmapped{opacity:.58}
    .rd-toc-indent{display:inline-block;flex:0 0 auto;width:var(--toc-indent,0px)}
    .rd-toc-title{word-break:break-word}
    .rd-toc-count:empty{display:none}
  `;
  document.head.appendChild(style);
}

function rowsForBook(book) {
  const real = Array.isArray(book.toc) && book.toc.length && /^EPUB[23]/i.test(String(book.epubTocSource || ''));
  if (real) return { rows: book.toc, exact: true };
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const rows = (Array.isArray(book.toc) && book.toc.length ? book.toc : chapters.map((chapter, index) => ({ chapterIndex: index, depth: 0 })))
    .map((row, index) => {
      const raw = row.chapterIndex;
      const ci = raw === null || raw === undefined ? index : Number(raw);
      const chapter = Number.isInteger(ci) ? chapters[ci] : null;
      const title = clean(row.title);
      return {
        ...row,
        chapterIndex: Number.isInteger(ci) ? ci : null,
        title: !title || genericTitle(title) ? fallbackTitle(book, chapter, ci) : title,
      };
    });
  return { rows, exact: false };
}

async function goTo(book, chapterIndex) {
  const app = await appModule();
  const ci = Math.max(0, Math.min(Number(chapterIndex) || 0, Math.max(0, (book.chapters || []).length - 1)));
  book.currentChapter = ci;
  book.currentParagraph = 0;
  book.updatedAt = new Date().toISOString();
  try { app.saveReaderBooks?.(); } catch {}
  try { await app.readerOpenBook?.(book.id); } catch (error) { console.warn('[toc-runtime] open chapter failed', error); }
}

export async function openToc() {
  let book = await freshBook();
  if (!book?.chapters?.length) {
    window.showToast?.('⚠️ Не нашёл открытую книгу в библиотеке');
    return false;
  }
  setTocVisibleBook(book);

  // Repair generic legacy labels before rendering. This mutates the book before
  // its first await, so the current sheet immediately sees the repaired labels.
  try { await repairBookTocFromContent(book); } catch (error) { console.warn('[toc-runtime] fallback repair failed', error); }
  // Re-resolve once: a direct EPUB re-import may have replaced the stored object
  // while the old reading surface stayed visible.
  book = await freshBook() || book;

  const list = document.getElementById('reader-toc-list');
  const back = document.getElementById('reader-toc-back');
  const sheet = document.getElementById('reader-toc-sheet');
  const header = document.getElementById('reader-toc-header');
  if (!list || !back || !sheet) return false;
  ensureStyle();

  const { rows, exact } = rowsForBook(book);
  const cur = Math.max(0, Number(book.currentChapter) || 0);
  const source = exact ? clean(book.epubTocSource) : 'восстановлено из текста';
  if (header) header.innerHTML = `<span>Оглавление</span><span class="rd-toc-meta">${rows.length} пунктов · ${esc(source)}</span>`;

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
    const inside = `<span class="rd-toc-num">${icon}</span><span class="rd-toc-indent" style="--toc-indent:${depth * 18}px"></span><span class="rd-toc-title">${esc(row.title || fallbackTitle(book, chapter, ci ?? i))}</span><span class="rd-toc-count">${count ? `${count} абз.` : ''}</span>`;
    return mapped
      ? `<button class="${cls}" data-depth="${depth}" data-toc-chapter="${ci}">${inside}</button>`
      : `<div class="${cls}" data-depth="${depth}">${inside}</div>`;
  }).join('');

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
  console.info('[toc-runtime] open', { book: book.title, rows: rows.length, exact, source: book.epubTocSource || '' });
  return true;
}

function installOpen() {
  openToc.__tocRuntime = true;
  window.readerOpenToc = openToc;
  window.__real_readerOpenToc = openToc;
}

function installSaveWrapper() {
  const fn = window.saveReaderImport;
  if (typeof fn !== 'function' || fn.__isStub || fn.__tocRuntimeSave) return;
  const wrapped = function saveReaderImportWithDirectToc(...args) {
    const title = clean(document.getElementById('reader-import-title')?.value || '');
    const author = clean(document.getElementById('reader-import-author')?.value || '');
    const result = fn.apply(this, args);
    Promise.resolve(result).then(() => applyCapturedEpubToc({ title, author })).catch(error => console.warn('[toc-runtime] post-save EPUB TOC apply failed', error));
    return result;
  };
  wrapped.__tocRuntimeSave = true;
  wrapped.__wrapped = fn;
  window.saveReaderImport = wrapped;
  window.__real_saveReaderImport = wrapped;
}

// Capture phase prevents any legacy inline readerOpenToc implementation from
// firing. Unlike toc5/toc7 there is no second competing capture listener loaded.
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

for (const delay of [0, 50, 150, 400, 1000, 2500, 6000]) setTimeout(() => { installOpen(); installSaveWrapper(); }, delay);
window.addEventListener('pageshow', () => { installOpen(); installSaveWrapper(); });
saveWrapTimer = setInterval(() => { installOpen(); installSaveWrapper(); }, 10000);
window.addEventListener('pagehide', () => { if (saveWrapTimer) clearInterval(saveWrapTimer); saveWrapTimer = null; });

console.info('[toc-runtime] loaded');
