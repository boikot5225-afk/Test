// Single user-facing TOC runtime.
//
// The exact EPUB TOC belongs to the source package, not to a transient saved
// book id. Older 77.42 builds could leave two books with the same title and then
// delete/re-dedupe the one that was still visible. The old runtime required the
// visible id to survive OR the title to be unique, so a perfectly visible book
// could produce "Не нашёл открытую книгу". This runtime resolves by logical
// identity and content richness, then applies the durable NCX/nav registry on
// demand before drawing the sheet.

import { getExactTocRecords } from './toc-registry.js?v=1';

const READER_APP_URL = '../reader-app.js?v=77.42-zh-reader-quality';
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

function key(value) {
  const raw = clean(value).normalize?.('NFKC') || clean(value);
  try { return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
  catch { return raw.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
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
    if (text.length <= 100) return text;
    break;
  }
  return current || `Раздел ${index + 1}`;
}

function exactRows(book) {
  const rows = Array.isArray(book?.toc) ? book.toc : [];
  const exact = !!book?._epubTocExact && rows.length > 0 && /^EPUB[23]/i.test(String(book.epubTocSource || ''));
  return exact ? rows : null;
}

function bookStats(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  let paragraphs = 0;
  let chars = 0;
  for (const chapter of chapters) {
    for (const item of chapter?.paragraphs || []) {
      paragraphs++;
      chars += clean(itemText(item)).replace(/\s+/g, '').length;
    }
  }
  return { chapters: chapters.length, paragraphs, chars };
}

function sameIdentity(book, record) {
  if (!book || !record || key(book.title) !== key(record.title)) return false;
  const a = key(book.author || '');
  const b = key(record.author || '');
  return !a || !b || a === b;
}

function recordForBook(book) {
  const records = (getExactTocRecords?.() || []).filter(record => sameIdentity(book, record) && record?.rows?.length);
  if (!records.length) return null;
  const chapters = Array.isArray(book?.chapters) ? book.chapters.length : 0;
  records.sort((a, b) => {
    const da = Math.abs((a.rows?.length || 0) - chapters);
    const db = Math.abs((b.rows?.length || 0) - chapters);
    if (da !== db) return da - db;
    const aa = key(a.author || '') === key(book.author || '') ? 1 : 0;
    const ab = key(b.author || '') === key(book.author || '') ? 1 : 0;
    if (aa !== ab) return ab - aa;
    return Number(b.savedAt || 0) - Number(a.savedAt || 0);
  });
  return records[0];
}

function cloneRows(rows) {
  return (rows || []).map((row, index) => ({
    title: clean(row?.title) || `Раздел ${index + 1}`,
    path: String(row?.path || ''),
    fragment: String(row?.fragment || ''),
    depth: Math.max(0, Number(row?.depth) || 0),
    hasChildren: row?.hasChildren === true || Number(rows?.[index + 1]?.depth || 0) > Number(row?.depth || 0),
    order: index,
    chapterIndex: null,
  }));
}

function attachExactRecord(book, record) {
  if (!book?.chapters?.length || !record?.rows?.length) return false;
  const rows = cloneRows(record.rows);
  const chapters = book.chapters;
  let mapped = 0;

  if (chapters.length === rows.length) {
    for (let i = 0; i < rows.length; i++) {
      rows[i].chapterIndex = i;
      chapters[i].title = rows[i].title;
      if (rows[i].path) chapters[i].sourcePath = rows[i].path;
      mapped++;
    }
  } else {
    const byPath = new Map();
    for (let i = 0; i < chapters.length; i++) {
      const path = String(chapters[i]?.sourcePath || '').replace(/^\/+/, '');
      if (path) byPath.set(path, i);
    }
    for (const row of rows) {
      const ci = byPath.get(String(row.path || '').replace(/^\/+/, ''));
      if (!Number.isInteger(ci)) continue;
      row.chapterIndex = ci;
      chapters[ci].title = row.title;
      mapped++;
    }
  }

  if (!mapped) return false;
  book.toc = rows;
  book.epubTocSource = /^EPUB[23]/i.test(String(record.source || '')) ? record.source : 'EPUB TOC';
  book._epubTocExact = true;
  book._epubTocCount = rows.length;
  if (record.fileName) book._epubTocFile = record.fileName;
  book.updatedAt = new Date().toISOString();
  return true;
}

function candidateScore(book, title, record) {
  const s = bookStats(book);
  let score = s.chapters * 10000 + Math.min(100000, s.paragraphs * 20) + Math.min(50000, Math.floor(s.chars / 100));
  if (exactRows(book)) score += 5_000_000;
  if (record?.rows?.length) {
    const diff = Math.abs(s.chapters - record.rows.length);
    if (diff === 0) score += 4_000_000;
    else if (diff === 1) score += 1_000_000;
    else score -= diff * 50000;
  }
  if (key(book.title) === key(title)) score += 1000;
  return score;
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
  if (!Array.isArray(books) || !books.length) return null;

  let current = null;
  try { current = app.readerCurrentBook?.() || null; } catch {}
  const domTitle = clean(document.getElementById('reader-book-title')?.textContent || '');
  const title = domTitle || visibleTitle || clean(current?.title || '');

  const byVisibleId = visibleBookId ? books.find(book => String(book?.id || '') === visibleBookId) : null;
  const byCurrentId = current?.id ? books.find(book => String(book?.id || '') === String(current.id)) : null;
  const matches = title ? books.filter(book => key(book?.title) === key(title)) : [];

  // Duplicates are expected after the broken imports. Never require title
  // uniqueness: select the copy that best fits the exact package TOC / richest
  // content. This is the central fix for the screenshot where a visible El narco
  // produced "Не нашёл открытую книгу".
  const pool = matches.length ? matches : [byVisibleId, byCurrentId].filter(Boolean);
  if (!pool.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const book of pool) {
    const record = recordForBook(book);
    const score = candidateScore(book, title, record);
    if (score > bestScore) { bestScore = score; best = book; }
  }
  if (!best) return null;

  const record = recordForBook(best);
  if (!exactRows(best) && record && attachExactRecord(best, record)) {
    try { app.saveReaderBooks?.(); } catch {}
  }

  const oldCurrentId = String(current?.id || '');
  setTocVisibleBook(best);
  // If a migration removed the book that is still painted on screen, re-anchor
  // readerCurrentBookId to the surviving logical book before navigation/TOC.
  if (document.getElementById('reader-reading-view')?.style.display === 'flex'
      && String(best.id || '') && oldCurrentId !== String(best.id || '')) {
    try { await app.readerOpenBook?.(best.id); } catch (error) {
      console.warn('[toc-runtime] re-anchor visible book failed', error);
    }
  }
  return best;
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
    window.showToast?.('⚠️ Открытая книга потеряла связь с библиотекой');
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
    const title = clean(row.title) || fallbackTitle(book, chapter, ci ?? i);
    const inside = `<span class="rd-toc-num">${icon}</span><span class="rd-toc-indent" style="--toc-indent:${depth * 18}px"></span><span class="rd-toc-title">${esc(title)}</span><span class="rd-toc-count">${count ? `${count} абз.` : ''}</span>`;
    return mapped
      ? `<button class="${cls}" data-depth="${depth}" data-toc-chapter="${ci}">${inside}</button>`
      : `<div class="${cls}" data-depth="${depth}">${inside}</div>`;
  }).join('');

  if (!exact) {
    list.insertAdjacentHTML('afterbegin', '<div class="rd-toc-legacy-note">У этой записи нет сохранённого NCX/nav. Для EPUB приложение больше не угадывает названия из текста.</div>');
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
  console.info('[toc-runtime] open v3', {
    book: book.title,
    id: book.id,
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

function refresh() { installOpen(); }
for (const delay of [0, 50, 150, 400, 1000, 2500]) setTimeout(refresh, delay);
window.addEventListener('pageshow', refresh);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
refreshTimer = setInterval(refresh, 10000);
window.addEventListener('pagehide', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
});

console.info('[toc-runtime] loaded v3');
