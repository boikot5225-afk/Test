// Reconcile exact EPUB package TOCs with the real saved book.
//
// Source of truth is now toc-registry.js, not a lucky book object. This module
// performs a bounded migration pass: choose the richest matching book, apply
// exact NCX/nav rows to it, and remove only unmistakable 1-chapter failed-import
// stubs. There is deliberately NO permanent 5-second writer loop: the old loop
// could race a user deletion and write a stale snapshot back into the library.

import { getExactTocRecords } from './toc-registry.js?v=1';
import { libraryIdbPut } from './library-idb-store.js?v=1';
import { sb, sbGetCurrentUserId, isSupabaseReady } from '../supabase.js';

const READER_APP_URL = '../reader-app.js?v=77.32';
const BOOKS_BASE_KEY = 'an2_reader_books_v1';
const TOMBSTONES_BASE_KEY = 'an2_reader_book_tombstones_v1';
const MAX_TOMBSTONES = 500;
let appPromise = null;
let running = null;
let scheduled = null;

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

function scopedKey(base) {
  try {
    return typeof window.an2ReaderStorageKey === 'function'
      ? window.an2ReaderStorageKey(base)
      : base;
  } catch { return base; }
}

function readTombstones() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(TOMBSTONES_BASE_KEY)) || '{}') || {};
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeTombstones(value) {
  const compact = Object.entries(value || {})
    .filter(([id]) => !!id)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, MAX_TOMBSTONES);
  try { localStorage.setItem(scopedKey(TOMBSTONES_BASE_KEY), JSON.stringify(Object.fromEntries(compact))); } catch {}
}

function tombstone(ids) {
  if (!ids?.length) return;
  const current = readTombstones();
  const now = Date.now();
  for (const id of ids) if (id) current[String(id)] = now;
  writeTombstones(current);
}

function textOf(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return String(item.text || item.value || item.content || item.caption || item.alt || '');
}

function stats(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  let paragraphs = 0;
  let chars = 0;
  for (const chapter of chapters) {
    for (const item of chapter?.paragraphs || []) {
      paragraphs++;
      chars += clean(textOf(item)).replace(/\s+/g, '').length;
    }
  }
  return { chapters: chapters.length, paragraphs, chars };
}

function sameBookIdentity(book, record) {
  if (!book || key(book.title) !== key(record.title)) return false;
  const wantedAuthor = key(record.author || '');
  const bookAuthor = key(book.author || '');
  // Old broken imports occasionally lost the author; empty must not block the
  // migration, but two different non-empty authors are never merged.
  if (wantedAuthor && bookAuthor && wantedAuthor !== bookAuthor) return false;
  return true;
}

function targetScore(book, tocLength) {
  const s = stats(book);
  const diff = Math.abs(s.chapters - tocLength);
  let score = 0;
  if (diff === 0) score += 2_000_000;
  else if (diff === 1) score += 900_000;
  else if (diff <= 3) score += 400_000 - diff * 60_000;
  else score -= diff * 40_000;
  score += Math.min(300_000, s.paragraphs * 150);
  score += Math.min(180_000, Math.floor(s.chars / 20));
  // Richness wins; recency intentionally does not. The recency bonus was what
  // made the freshly-created El narco 1/1 stub beat the real 44-chapter book.
  return score;
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

function applyRows(target, record) {
  const chapters = Array.isArray(target?.chapters) ? target.chapters : [];
  const rows = cloneRows(record.rows);
  if (!chapters.length || !rows.length) return { ok: false, mapped: 0, rows: rows.length };
  let mapped = 0;

  if (chapters.length === rows.length) {
    // El narco's damaged full copy is exactly this shape: 44 real reading-order
    // chapters already exist, only their labels were replaced with "Глава N".
    // The NCX has the same 44 reading-order targets, so mapping 1:1 is exact.
    for (let i = 0; i < rows.length; i++) {
      rows[i].chapterIndex = i;
      chapters[i].title = rows[i].title;
      if (rows[i].path) chapters[i].sourcePath = rows[i].path;
      mapped++;
    }
  } else {
    // Future correctly imported EPUBs persist sourcePath. Use it when a package
    // has several nav entries into the same XHTML or an old build skipped a
    // structural page. Never guess by raw index when counts differ.
    const byPath = new Map();
    for (let i = 0; i < chapters.length; i++) {
      const path = String(chapters[i]?.sourcePath || '').replace(/^\/+/, '');
      if (path) byPath.set(path, i);
    }
    for (const row of rows) {
      const path = String(row.path || '').replace(/^\/+/, '');
      const ci = byPath.get(path);
      if (!Number.isInteger(ci)) continue;
      row.chapterIndex = ci;
      chapters[ci].title = row.title;
      mapped++;
    }
  }

  if (!mapped) return { ok: false, mapped: 0, rows: rows.length };
  target.toc = rows;
  target.epubTocSource = /^EPUB[23]/i.test(String(record.source || '')) ? record.source : 'EPUB TOC';
  target._epubTocExact = true;
  target._epubTocCount = rows.length;
  if (record.fileName) target._epubTocFile = record.fileName;
  target.updatedAt = new Date().toISOString();
  return { ok: true, mapped, rows: rows.length };
}

function poorStub(candidate, target, tocLength) {
  if (!candidate || candidate === target || !sameBookIdentity(candidate, target)) return false;
  const a = stats(candidate);
  const b = stats(target);
  if (b.chapters < Math.max(10, tocLength * 0.5)) return false;
  const tinyChapters = a.chapters <= 2;
  const tinyParagraphs = a.paragraphs <= Math.max(6, Math.floor(b.paragraphs * 0.03));
  const tinyChars = a.chars <= Math.max(2500, Math.floor(b.chars * 0.03));
  return tinyChapters && tinyParagraphs && tinyChars;
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
      console.warn('[toc-reconcile] cloud stub delete postponed', id, error);
    }
  }
}

async function persist(app, books, removedIds) {
  if (removedIds.length) tombstone(removedIds);
  const deleted = new Set(Object.keys(readTombstones()));
  const kept = books.filter(book => !deleted.has(String(book?.id || '')));
  books.splice(0, books.length, ...kept);

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

    // Respect manual deletions before doing ANY migration. This prevents this
    // module itself from resurrecting a stale snapshot.
    const deleted = new Set(Object.keys(readTombstones()));
    if (deleted.size) {
      const kept = books.filter(book => !deleted.has(String(book?.id || '')));
      if (kept.length !== books.length) books.splice(0, books.length, ...kept);
    }

    const records = [...getExactTocRecords()];
    // Also salvage exact TOCs that old builds managed to attach to the wrong
    // book. No source==='epub' requirement: a broken wrapper could mislabel the
    // stub as manual_text while its NCX rows are still perfectly valid.
    for (const book of books) {
      if (!Array.isArray(book?.toc) || !book.toc.length) continue;
      if (!book?._epubTocExact && !/^EPUB[23]/i.test(String(book?.epubTocSource || ''))) continue;
      records.push({
        title: book.title,
        author: book.author,
        source: book.epubTocSource || 'EPUB TOC',
        fileName: book._epubTocFile || '',
        rows: book.toc,
        savedAt: new Date(book.updatedAt || 0).getTime() || 0,
      });
    }

    // Newest durable record wins for the same title+author; migration records
    // have savedAt=1 and therefore only fill a hole left by the broken builds.
    const byRecord = new Map();
    for (const record of records) {
      if (!record?.rows?.length || !key(record.title)) continue;
      const rk = `${key(record.title)}|${key(record.author)}`;
      const old = byRecord.get(rk);
      if (!old || Number(record.savedAt || 0) >= Number(old.savedAt || 0)) byRecord.set(rk, record);
    }

    let changed = false;
    let repaired = 0;
    const removedIds = [];

    for (const record of byRecord.values()) {
      const candidates = books.filter(book => sameBookIdentity(book, record));
      if (!candidates.length) continue;
      const target = [...candidates].sort((a, b) => targetScore(b, record.rows.length) - targetScore(a, record.rows.length))[0];
      if (!target?.chapters?.length) continue;

      const alreadyExact = target._epubTocExact === true
        && /^EPUB[23]/i.test(String(target.epubTocSource || ''))
        && Array.isArray(target.toc)
        && target.toc.length === record.rows.length
        && target.chapters.length === record.rows.length
        && target.chapters.every((chapter, index) => clean(chapter?.title) === clean(record.rows[index]?.title));

      if (!alreadyExact) {
        const applied = applyRows(target, record);
        if (applied.ok) {
          repaired++;
          changed = true;
          console.info('[toc-reconcile] exact TOC applied to richest copy', {
            title: target.title,
            targetId: target.id,
            targetChapters: target.chapters.length,
            rows: applied.rows,
            mapped: applied.mapped,
            source: record.source,
          });
        }
      }

      for (const candidate of candidates) {
        if (!poorStub(candidate, target, record.rows.length)) continue;
        const id = String(candidate.id || '');
        if (id && !removedIds.includes(id)) removedIds.push(id);
      }
    }

    if (removedIds.length) {
      const remove = new Set(removedIds);
      const kept = books.filter(book => !remove.has(String(book?.id || '')));
      books.splice(0, books.length, ...kept);
      changed = true;
    }

    if (changed || deleted.size) {
      await persist(app, books, removedIds);
      if (render && document.getElementById('reader-reading-view')?.style.display !== 'flex') {
        try { await app.renderReaderScreen?.(); } catch {}
      }
      if (repaired || removedIds.length) {
        window.showToast?.(removedIds.length
          ? '📚 Оглавление исправлено · сломанный дубль удалён'
          : '📚 Оглавление EPUB исправлено');
      }
    }
    return { changed, repaired, removed: removedIds.length };
  })().finally(() => { running = null; });
  return running;
}

function schedule(delay = 0) {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    reconcileExactTocDuplicates({ render: true }).catch(error => console.warn('[toc-reconcile] skipped', error));
  }, delay);
}

// Bounded startup retries cover IndexedDB/cloud hydration. After that we only
// run on meaningful events; no permanent writer loop.
for (const delay of [250, 1200, 3500, 8000]) setTimeout(() => schedule(0), delay);
window.addEventListener('reader-exact-toc-saved', () => schedule(50));
window.addEventListener('pageshow', () => schedule(150));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') schedule(150);
});

try { window.readerReconcileExactTocDuplicates = reconcileExactTocDuplicates; } catch {}
console.info('[toc-reconcile] loaded v2');
