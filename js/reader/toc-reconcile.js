// Reconcile exact EPUB package TOC with the real saved book.
//
// Why this exists: 77.42-toc9 parsed NCX correctly, but when a re-import made a
// tiny duplicate first, toc-direct picked the newest matching title and attached
// the 44-row NCX to that 1-chapter duplicate. The real 44-chapter book therefore
// kept "Глава N" even though the exact TOC was already present in the library.
//
// This module fixes the DATA, not the sheet. For books with the same title /
// author / language it finds an exact EPUB2/3 TOC, moves it to the richest book
// whose chapter count actually fits that TOC, renames those chapters 1:1 when
// counts match, and removes only catastrophically-poor duplicates produced by
// the failed import path. Removed ids get the same durable tombstone used by
// delete-fix, so cloud/IndexedDB cannot resurrect them.

import { libraryIdbPut } from './library-idb-store.js?v=1';
import { sb, sbGetCurrentUserId, isSupabaseReady } from '../supabase.js';

const READER_APP_URL = '../reader-app.js?v=77.31';
const BOOKS_BASE_KEY = 'an2_reader_books_v1';
const TOMBSTONES_BASE_KEY = 'an2_reader_book_tombstones_v1';
const MAX_TOMBSTONES = 500;
let appPromise = null;
let running = null;
let timer = null;

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

function groupKey(book) {
  const title = key(book?.title || '');
  if (!title) return '';
  const author = key(book?.author || '');
  const lang = key(book?.lang || book?.sourceLang || '');
  return `${title}|${author}|${lang}`;
}

function exactRows(book) {
  const rows = Array.isArray(book?.toc) ? book.toc : [];
  const source = String(book?.epubTocSource || '');
  return rows.length >= 2 && (/^EPUB[23]/i.test(source) || book?._epubTocExact === true)
    ? rows
    : null;
}

function textOf(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return String(item.text || item.value || item.content || item.caption || item.alt || '');
}

function bookStats(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  let paragraphs = 0;
  let chars = 0;
  for (const chapter of chapters) {
    for (const item of chapter?.paragraphs || []) {
      paragraphs++;
      const text = clean(textOf(item));
      if (text) chars += text.replace(/\s+/g, '').length;
    }
  }
  return { chapters: chapters.length, paragraphs, chars };
}

function targetScore(book, tocLength) {
  const s = bookStats(book);
  const diff = Math.abs(s.chapters - tocLength);
  let score = 0;
  if (diff === 0) score += 1_000_000;
  else if (diff === 1) score += 500_000;
  else if (diff <= 3) score += 250_000 - diff * 20_000;
  else score -= diff * 15_000;
  // Content richness breaks ties. Recency intentionally does NOT: that was the
  // toc9 bug (the just-created 1/1 duplicate won merely because it was newest).
  score += Math.min(120_000, s.paragraphs * 120);
  score += Math.min(80_000, Math.floor(s.chars / 25));
  if (book?.source === 'epub') score += 20_000;
  return score;
}

function cloneRows(rows) {
  return rows.map((row, index) => ({
    ...row,
    title: clean(row?.title) || `Раздел ${index + 1}`,
    depth: Math.max(0, Number(row?.depth) || 0),
    hasChildren: row?.hasChildren === true || Number(rows[index + 1]?.depth || 0) > Number(row?.depth || 0),
  }));
}

function applyRowsToTarget(source, target) {
  const sourceRows = exactRows(source);
  if (!sourceRows || !target?.chapters?.length) return { ok: false, mapped: 0 };
  const rows = cloneRows(sourceRows);
  const chapters = target.chapters;
  let mapped = 0;

  // This is the important path for El narco and for any sane importer: when
  // package TOC and saved chapter counts agree, they are the same reading-order
  // units. Map directly instead of trying to infer titles from paragraph text.
  if (chapters.length === rows.length) {
    for (let i = 0; i < rows.length; i++) {
      rows[i].chapterIndex = i;
      chapters[i].title = rows[i].title;
      if (rows[i].path && !chapters[i].sourcePath) chapters[i].sourcePath = rows[i].path;
      mapped++;
    }
  } else {
    // Fallback for books imported by older builds that skipped cover/map/part
    // pages. Prefer explicit sourcePath matches and keep unmapped TOC parents
    // visible rather than lying about a target.
    const byPath = new Map();
    for (let i = 0; i < chapters.length; i++) {
      const path = String(chapters[i]?.sourcePath || '').replace(/^\/+/, '');
      if (path) byPath.set(path, i);
    }
    for (const row of rows) {
      const path = String(row?.path || '').replace(/^\/+/, '');
      const ci = byPath.get(path);
      if (!Number.isInteger(ci)) { row.chapterIndex = null; continue; }
      row.chapterIndex = ci;
      chapters[ci].title = row.title;
      mapped++;
    }
  }

  target.toc = rows;
  target.epubTocSource = source.epubTocSource || 'EPUB TOC';
  target._epubTocExact = true;
  target._epubTocCount = rows.length;
  if (source._epubTocFile) target._epubTocFile = source._epubTocFile;
  target.updatedAt = new Date().toISOString();
  return { ok: mapped > 0, mapped, rows: rows.length };
}

function scopedKey(base) {
  try {
    return typeof window.an2ReaderStorageKey === 'function'
      ? window.an2ReaderStorageKey(base)
      : base;
  } catch { return base; }
}

function tombstone(ids) {
  if (!ids?.length) return;
  const k = scopedKey(TOMBSTONES_BASE_KEY);
  let existing = {};
  try { existing = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch {}
  const now = Date.now();
  for (const id of ids) if (id) existing[String(id)] = now;
  const compact = Object.entries(existing)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, MAX_TOMBSTONES);
  try { localStorage.setItem(k, JSON.stringify(Object.fromEntries(compact))); } catch {}
}

async function deleteCloud(ids) {
  if (!ids?.length) return;
  let userId = null;
  try { userId = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null; } catch {}
  if (!userId || !isSupabaseReady?.()) return;
  for (const id of ids) {
    try {
      const { error } = await sb.from('reader_books').delete().eq('user_id', userId).eq('id', id);
      if (error) throw error;
    } catch (error) {
      console.warn('[toc-reconcile] cloud duplicate cleanup postponed', id, error);
    }
  }
}

function copyUsefulMetadata(from, to) {
  // Failed re-imports sometimes carried a cover the older, richer copy did not.
  // Keep harmless cover metadata if it is directly portable; never overwrite
  // reading position, ids, chapters, timestamps or progress.
  for (const [name, value] of Object.entries(from || {})) {
    if (!/cover/i.test(name)) continue;
    if (to[name] == null || to[name] === '') to[name] = value;
  }
}

function poorDuplicate(candidate, target, tocLength) {
  if (!candidate || candidate === target) return false;
  const a = bookStats(candidate);
  const b = bookStats(target);
  // Only delete an unmistakable failed-import stub. Two legitimate editions
  // with similar amounts of content are left alone.
  const tinyChapters = a.chapters <= Math.max(2, Math.floor(tocLength * 0.12));
  const targetFits = Math.abs(b.chapters - tocLength) <= 1;
  const tinyContent = a.paragraphs <= Math.max(5, Math.floor(b.paragraphs * 0.08))
    && a.chars <= Math.max(3000, Math.floor(b.chars * 0.08));
  return targetFits && tinyChapters && tinyContent;
}

async function persist(app, books, removedIds) {
  if (removedIds.length) tombstone(removedIds);
  const storageKey = scopedKey(BOOKS_BASE_KEY);
  try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch {}
  try { await libraryIdbPut(storageKey, books); }
  catch (error) { console.warn('[toc-reconcile] IndexedDB write failed', error); }
  try { app.saveReaderBooks?.(); } catch {}
  if (removedIds.length) deleteCloud(removedIds).catch(() => {});
}

export async function reconcileExactTocDuplicates({ render = true } = {}) {
  if (running) return running;
  running = (async () => {
    const app = await appModule();
    const books = app.loadReaderBooks?.() || [];
    if (!Array.isArray(books) || !books.length) return { changed: false, repaired: 0, removed: 0 };

    const groups = new Map();
    for (const book of books) {
      if (!book || book.source !== 'epub') continue;
      const gk = groupKey(book);
      if (!gk) continue;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(book);
    }

    let changed = false;
    let repaired = 0;
    const removedIds = [];

    for (const group of groups.values()) {
      const sources = group.filter(book => exactRows(book));
      if (!sources.length) continue;
      // Prefer the source with the largest exact outline. A failed 1/1 duplicate
      // can still be the source of truth for labels even though it is a terrible
      // reading target.
      sources.sort((a, b) => exactRows(b).length - exactRows(a).length);
      const source = sources[0];
      const tocLength = exactRows(source).length;
      const target = [...group].sort((a, b) => targetScore(b, tocLength) - targetScore(a, tocLength))[0];
      if (!target?.chapters?.length) continue;

      const targetAlreadyExact = exactRows(target)?.length === tocLength
        && target.chapters.length === tocLength
        && target.chapters.every((chapter, i) => clean(chapter?.title) === clean(exactRows(target)[i]?.title));
      if (!targetAlreadyExact) {
        const applied = applyRowsToTarget(source, target);
        if (applied.ok) {
          copyUsefulMetadata(source, target);
          repaired++;
          changed = true;
          console.info('[toc-reconcile] exact TOC moved to real book', {
            title: target.title,
            rows: applied.rows,
            mapped: applied.mapped,
            sourceId: source.id,
            targetId: target.id,
            targetChapters: target.chapters.length,
          });
        }
      }

      for (const candidate of group) {
        if (!poorDuplicate(candidate, target, tocLength)) continue;
        if (!removedIds.includes(String(candidate.id))) removedIds.push(String(candidate.id));
      }
    }

    if (removedIds.length) {
      const removeSet = new Set(removedIds);
      const kept = books.filter(book => !removeSet.has(String(book?.id || '')));
      books.splice(0, books.length, ...kept);
      changed = true;
    }

    if (changed) {
      await persist(app, books, removedIds);
      if (render && document.getElementById('reader-reading-view')?.style.display !== 'flex') {
        try { await app.renderReaderScreen?.(); } catch {}
      }
      window.showToast?.(removedIds.length
        ? `📚 Оглавление EPUB исправлено · лишняя копия удалена`
        : `📚 Оглавление EPUB исправлено`);
    }
    return { changed, repaired, removed: removedIds.length };
  })().finally(() => { running = null; });
  return running;
}

function schedule(delay = 0) {
  setTimeout(() => reconcileExactTocDuplicates({ render: true }).catch(error => {
    console.warn('[toc-reconcile] skipped', error);
  }), delay);
}

// Repair current toc9 damage immediately after upgrading, then catch the exact
// moment a future import finishes and attaches its NCX to the wrong duplicate.
for (const delay of [250, 900, 2500, 6000]) schedule(delay);
timer = setInterval(() => schedule(0), 5000);
window.addEventListener('pageshow', () => schedule(150));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') schedule(150);
});
window.addEventListener('pagehide', () => {
  if (timer) clearInterval(timer);
  timer = null;
});

try { window.readerReconcileExactTocDuplicates = reconcileExactTocDuplicates; } catch {}
console.info('[toc-reconcile] loaded');
