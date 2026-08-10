// Reader AI 77.42-toc6: direct EPUB TOC pipeline.
//
// The previous TOC experiments sat around the importer and depended on runtime
// handler replacement. On Android that is fragile: a File can go through a
// synthetic event and a stale handler can still win. This module owns the EPUB
// file directly, parses nav/NCX before the legacy importer touches it, and is
// called explicitly by android-external-import.js after the book is saved.
//
// It also repairs already-saved EPUBs whose chapter titles are still generic
// "Глава N" by reading the heading-like text that the importer already kept in
// each chapter. That is not a substitute for package TOC, but it means an old
// book no longer has to show 43 useless generic labels while waiting for a
// re-import.

import { readZipEntries, resolveEpubPath } from './epub.js?v=3';

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let pending = null;
let pendingSeq = 0;
let repairTimer = null;

function appModule() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeDecode(value) {
  const raw = String(value || '').replace(/^\/+/, '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function splitHref(base, href) {
  const raw = String(href || '').trim();
  const hashAt = raw.indexOf('#');
  const pathPart = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).split('?')[0];
  const fragmentRaw = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  const path = safeDecode(resolveEpubPath(base, pathPart));
  let fragment = fragmentRaw;
  try { fragment = decodeURIComponent(fragmentRaw); } catch {}
  return { path, fragment };
}

function firstLocal(root, name) {
  if (!root) return null;
  if (root.localName === name) return root;
  const ns = root.getElementsByTagNameNS?.('*', name);
  if (ns?.length) return ns[0];
  return root.getElementsByTagName?.(name)?.[0] || null;
}

function localChildren(node, name) {
  return [...(node?.children || [])].filter(child => child.localName === name);
}

function parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
    return firstLocal(doc, 'parsererror') ? null : doc;
  } catch { return null; }
}

function parseHtml(text) {
  try {
    const xml = new DOMParser().parseFromString(String(text || ''), 'application/xhtml+xml');
    if (!firstLocal(xml, 'parsererror')) return xml;
  } catch {}
  try { return new DOMParser().parseFromString(String(text || ''), 'text/html'); }
  catch { return null; }
}

async function locatePackage(entries) {
  let opfPath = '';
  try {
    const containerText = await entries.get('META-INF/container.xml')?.text();
    const container = parseXml(containerText);
    opfPath = safeDecode(firstLocal(container, 'rootfile')?.getAttribute?.('full-path') || '');
    if (!opfPath) opfPath = safeDecode(String(containerText || '').match(/full-path=["']([^"']+)["']/i)?.[1] || '');
  } catch {}
  if (!opfPath) opfPath = [...entries.keys()].find(path => /\.opf$/i.test(path)) || '';
  if (!opfPath || !entries.has(opfPath)) throw new Error('EPUB: package.opf не найден');

  const opfText = await entries.get(opfPath).text();
  const doc = parseXml(opfText);
  const base = opfPath.split('/').slice(0, -1).join('/');
  const manifest = new Map();
  const spine = [];
  let navPath = '';
  let ncxPath = '';
  let spineTocId = '';

  if (doc) {
    const manifestRoot = firstLocal(doc, 'manifest');
    for (const item of localChildren(manifestRoot, 'item')) {
      const id = item.getAttribute('id') || '';
      const href = item.getAttribute('href') || '';
      const mediaType = item.getAttribute('media-type') || '';
      const properties = item.getAttribute('properties') || '';
      const path = splitHref(base, href).path;
      if (!id || !path) continue;
      manifest.set(id, { id, path, mediaType, properties });
      if ((` ${properties} `).includes(' nav ')) navPath = path;
      if (/application\/x-dtbncx\+xml/i.test(mediaType) || /\.ncx$/i.test(path)) ncxPath ||= path;
    }
    const spineRoot = firstLocal(doc, 'spine');
    spineTocId = spineRoot?.getAttribute?.('toc') || '';
    for (const ref of localChildren(spineRoot, 'itemref')) {
      const item = manifest.get(ref.getAttribute('idref') || '');
      if (item?.path) spine.push(item.path);
    }
  }

  // Fallback for malformed but still readable OPF files.
  if (!manifest.size) {
    for (const match of String(opfText || '').matchAll(/<item\b[^>]*>/gi)) {
      const tag = match[0];
      const attr = name => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] || '';
      const id = attr('id'), href = attr('href'), mediaType = attr('media-type'), properties = attr('properties');
      const path = splitHref(base, href).path;
      if (!id || !path) continue;
      manifest.set(id, { id, path, mediaType, properties });
      if ((` ${properties} `).includes(' nav ')) navPath = path;
      if (/application\/x-dtbncx\+xml/i.test(mediaType) || /\.ncx$/i.test(path)) ncxPath ||= path;
    }
    spineTocId = String(opfText || '').match(/<spine\b[^>]*\btoc=["']([^"']+)["']/i)?.[1] || '';
    for (const match of String(opfText || '').matchAll(/<itemref\b[^>]*\bidref=["']([^"']+)["'][^>]*>/gi)) {
      const item = manifest.get(match[1]);
      if (item?.path) spine.push(item.path);
    }
  }
  if (spineTocId && manifest.get(spineTocId)?.path) ncxPath = manifest.get(spineTocId).path;

  const metadata = firstLocal(doc, 'metadata') || doc;
  const metaText = name => clean(firstLocal(metadata, name)?.textContent || '');
  return {
    opfPath, base, manifest, spine, navPath, ncxPath,
    title: metaText('title'),
    author: metaText('creator'),
  };
}

function parseNcx(text, path) {
  const doc = parseXml(text);
  const navMap = firstLocal(doc, 'navMap');
  if (!navMap) return [];
  const base = path.split('/').slice(0, -1).join('/');
  const rows = [];
  const walk = (point, depth) => {
    const label = clean(firstLocal(firstLocal(point, 'navLabel'), 'text')?.textContent || '');
    const href = firstLocal(point, 'content')?.getAttribute?.('src') || '';
    const resolved = splitHref(base, href);
    if (label || resolved.path) rows.push({ title: label || 'Раздел', depth, ...resolved });
    for (const child of localChildren(point, 'navPoint')) walk(child, depth + 1);
  };
  for (const point of localChildren(navMap, 'navPoint')) walk(point, 0);
  return rows;
}

function parseNav(text, path) {
  const doc = parseHtml(text);
  if (!doc) return [];
  const navs = [...(doc.getElementsByTagNameNS?.('*', 'nav') || [])];
  const EPUB_NS = 'http://www.idpf.org/2007/ops';
  const nav = navs.find(node => {
    const type = node.getAttribute('epub:type') || node.getAttributeNS?.(EPUB_NS, 'type') || '';
    const role = node.getAttribute('role') || '';
    return /(^|\s)toc(\s|$)/i.test(type) || /doc-toc/i.test(role);
  }) || navs[0];
  if (!nav) return [];
  const base = path.split('/').slice(0, -1).join('/');
  const direct = (node, names) => [...(node?.children || [])].find(child => names.includes(child.localName));
  const rows = [];
  const walk = (list, depth) => {
    for (const li of localChildren(list, 'li')) {
      const labelEl = direct(li, ['a', 'span']) || li;
      const anchor = labelEl.localName === 'a' ? labelEl : direct(li, ['a']);
      const title = clean(labelEl.textContent || '');
      const resolved = splitHref(base, anchor?.getAttribute?.('href') || '');
      if (title || resolved.path) rows.push({ title: title || 'Раздел', depth, ...resolved });
      const nested = direct(li, ['ol']);
      if (nested) walk(nested, depth + 1);
    }
  };
  const root = direct(nav, ['ol']) || firstLocal(nav, 'ol');
  if (root) walk(root, 0);
  return rows;
}

function dedupeRows(rows) {
  const out = [];
  const seen = new Set();
  for (const raw of rows || []) {
    const title = clean(raw.title);
    const path = safeDecode(raw.path);
    if (!title && !path) continue;
    const depth = Math.max(0, Number(raw.depth) || 0);
    const key = `${path}#${raw.fragment || ''}|${title}|${depth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title || 'Раздел', path, fragment: raw.fragment || '', depth, order: out.length });
  }
  return out;
}

function fingerprint(value) {
  return clean(value)
    .normalize?.('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 700) || '';
}

function htmlFingerprint(html) {
  const doc = parseHtml(html);
  if (!doc) return '';
  try { doc.querySelectorAll?.('script,style,noscript,svg,nav').forEach(node => node.remove()); } catch {}
  return fingerprint(doc.body?.textContent || doc.documentElement?.textContent || '');
}

function itemText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return String(item.text || item.value || item.content || item.caption || '');
}

function chapterFingerprint(chapter) {
  const parts = [];
  for (const item of chapter?.paragraphs || []) {
    const text = clean(itemText(item));
    if (text) parts.push(text);
    if (parts.join(' ').length > 900) break;
  }
  return fingerprint(parts.join(' '));
}

async function parseOutline(file) {
  const entries = await readZipEntries(await file.arrayBuffer());
  const pkg = await locatePackage(entries);
  let rows = [];
  let source = '';
  if (pkg.navPath && entries.has(pkg.navPath)) {
    rows = dedupeRows(parseNav(await entries.get(pkg.navPath).text(), pkg.navPath));
    if (rows.length) source = 'EPUB3 nav';
  }
  if (!rows.length && pkg.ncxPath && entries.has(pkg.ncxPath)) {
    rows = dedupeRows(parseNcx(await entries.get(pkg.ncxPath).text(), pkg.ncxPath));
    if (rows.length) source = 'EPUB2 NCX';
  }
  if (!rows.length) throw new Error('EPUB не содержит читаемого nav/NCX оглавления');

  const paths = new Set([...pkg.spine, ...rows.map(row => row.path)].filter(Boolean));
  const fingerprints = new Map();
  for (const path of paths) {
    if (!entries.has(path) || !/\.(?:xhtml|html|htm)$/i.test(path)) continue;
    try { fingerprints.set(path, htmlFingerprint(await entries.get(path).text())); } catch {}
  }
  return { rows, source, pkg, fingerprints };
}

export function captureEpubTocFile(file) {
  if (!file || !/\.epub$/i.test(String(file.name || ''))) return null;
  const record = {
    seq: ++pendingSeq,
    fileName: String(file.name || 'book.epub'),
    startedAt: Date.now(),
    promise: parseOutline(file),
  };
  pending = record;
  record.promise
    .then(parsed => console.info('[toc-direct] parsed', { file: record.fileName, rows: parsed.rows.length, source: parsed.source }))
    .catch(error => console.warn('[toc-direct] parse failed', error));
  return record;
}

function scoreFingerprint(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 120;
  const a100 = a.slice(0, 100), b100 = b.slice(0, 100);
  if (a100.length > 45 && (a.includes(b100) || b.includes(a100))) return 95;
  const a60 = a.slice(0, 60), b60 = b.slice(0, 60);
  if (a60.length > 30 && (a.includes(b60) || b.includes(a60))) return 72;
  return 0;
}

function mapRowsToBook(book, parsed) {
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const rows = parsed.rows.map(row => ({ ...row, chapterIndex: null }));
  const pathToChapter = new Map();
  const usedPaths = new Set();
  const usedChapters = new Set();
  const chapterFps = chapters.map(chapterFingerprint);

  // First align by content. This is resilient to cover/map/photo pages that the
  // old importer skipped because they were too short or image-only.
  for (let ci = 0; ci < chapters.length; ci++) {
    let bestPath = '';
    let bestScore = 0;
    for (const [path, fp] of parsed.fingerprints) {
      if (usedPaths.has(path)) continue;
      const score = scoreFingerprint(chapterFps[ci], fp);
      if (score > bestScore) { bestScore = score; bestPath = path; }
    }
    if (bestPath && bestScore >= 72) {
      pathToChapter.set(bestPath, ci);
      usedPaths.add(bestPath);
      usedChapters.add(ci);
    }
  }

  // Then preserve reading order for remaining content files. Do NOT count nav,
  // toc or cover package files as readable chapters; they are still allowed to
  // remain as unmapped TOC rows, which is preferable to lying about a target.
  const spine = parsed.pkg.spine.filter(path =>
    /\.(?:xhtml|html|htm)$/i.test(path) && !/\b(nav|toc|cover)\b/i.test(path)
  );
  let ci = 0;
  for (const path of spine) {
    if (pathToChapter.has(path)) continue;
    while (ci < chapters.length && usedChapters.has(ci)) ci++;
    if (ci >= chapters.length) break;
    pathToChapter.set(path, ci);
    usedChapters.add(ci);
    ci++;
  }

  for (const row of rows) {
    const mapped = pathToChapter.get(row.path);
    if (Number.isInteger(mapped)) row.chapterIndex = mapped;
  }
  for (let i = 0; i < rows.length; i++) {
    rows[i].hasChildren = Number(rows[i + 1]?.depth || 0) > Number(rows[i].depth || 0);
  }

  // Package labels are authoritative. Rename a chapter only once, using the
  // first TOC row that actually points at it.
  const renamed = new Set();
  for (const row of rows) {
    const index = row.chapterIndex;
    if (!Number.isInteger(index) || renamed.has(index) || !chapters[index]) continue;
    const title = clean(row.title);
    if (!title) continue;
    chapters[index].title = title;
    renamed.add(index);
  }
  return rows;
}

function genericTitle(value) {
  const title = clean(value);
  return !title || /^(?:глава|chapter|cap[ií]tulo|chapitre)\s*\d+$/i.test(title);
}

function shortHeadingCandidate(text, book) {
  const value = clean(text);
  if (!value || value.length > 105) return '';
  const fp = fingerprint(value);
  if (!fp) return '';
  if (fp === fingerprint(book?.title || '') || fp === fingerprint(book?.author || '')) return '';
  if (/^(?:https?:\/\/|www\.)/i.test(value)) return '';
  if (/[.!?]$/.test(value) && value.split(/\s+/).length > 9) return '';
  return value;
}

function deriveChapterTitle(book, chapter, index) {
  const current = clean(chapter?.title);
  if (!genericTitle(current)) return current;
  const text = [];
  for (const item of chapter?.paragraphs || []) {
    const value = clean(itemText(item));
    if (!value) continue;
    if (fingerprint(value) === fingerprint(book?.title || '') || fingerprint(value) === fingerprint(book?.author || '')) continue;
    text.push(value);
    if (text.length >= 8) break;
  }
  if (!text.length) return index === 0 && book?.source === 'epub' ? 'Обложка' : current || `Глава ${index + 1}`;

  const first = shortHeadingCandidate(text[0], book);
  const second = shortHeadingCandidate(text[1], book);
  if (/^\d{1,3}[.)]?$/u.test(first) && second) return `${first.replace(/[.)]+$/, '')}. ${second}`;
  if (/^[IVXLCDM]{1,8}[.)]?$/i.test(first) && second) return `${first.replace(/[.)]+$/, '')}. ${second}`;
  if (/^(?:(?:PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[EÉ]PTIMA|OCTAVA|NOVENA|D[EÉ]CIMA)\s+PARTE|PARTE\s+[IVXLCDM\d]+|PART\s+[IVXLCDM\d]+|BOOK\s+[IVXLCDM\d]+)$/i.test(first) && second) {
    return `${first}. ${second}`;
  }
  if (first) return first;
  if (second) return second;
  return current || `Глава ${index + 1}`;
}

function isPartHeading(title) {
  return /^(?:(?:PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[EÉ]PTIMA|OCTAVA|NOVENA|D[EÉ]CIMA)\s+PARTE|PARTE\s+[IVXLCDM\d]+|PART\s+[IVXLCDM\d]+|BOOK\s+[IVXLCDM\d]+)/i.test(clean(title));
}

function isNumberedChapter(title) {
  return /^(?:\d{1,3}|[IVXLCDM]{1,8})[.):-]?\s+/i.test(clean(title)) || /^\d{1,3}\.[\s\S]+/u.test(clean(title));
}

function buildRecoveredRows(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const titles = chapters.map((chapter, index) => deriveChapterTitle(book, chapter, index));
  let insidePart = false;
  const rows = titles.map((title, index) => {
    const part = isPartHeading(title);
    if (part) insidePart = true;
    const depth = !part && insidePart && (isNumberedChapter(title) || /^\d{1,3}\b/.test(title)) ? 1 : 0;
    return { title, depth, chapterIndex: index, hasChildren: part };
  });
  // If an unnumbered back-matter item appears after numbered chapters, stop
  // indenting. Part pages themselves remain visible as parents.
  return rows;
}

export async function repairBookTocFromContent(book, { save = true } = {}) {
  if (!book?.chapters?.length) return false;
  const hasRealPackageToc = Array.isArray(book.toc) && book.toc.length && /^EPUB[23]/i.test(String(book.epubTocSource || ''));
  if (hasRealPackageToc) return false;
  const before = (book.chapters || []).map(ch => clean(ch.title));
  const rows = buildRecoveredRows(book);
  const useful = rows.some((row, index) => clean(row.title) && clean(row.title) !== before[index]);
  if (!useful && Array.isArray(book.toc) && book.toc.length) return false;
  for (const row of rows) {
    const chapter = book.chapters[row.chapterIndex];
    if (chapter && genericTitle(chapter.title) && !genericTitle(row.title)) chapter.title = row.title;
  }
  book.toc = rows;
  book.epubTocSource = useful ? 'Восстановлено из текста' : (book.epubTocSource || 'Главы');
  book.updatedAt = new Date().toISOString();
  if (save) {
    try { (await appModule()).saveReaderBooks?.(); } catch {}
  }
  return true;
}

function titleKey(value) { return fingerprint(value).slice(0, 180); }

async function findSavedBook(app, hint, parsed) {
  const title = titleKey(hint?.title || parsed?.pkg?.title || '');
  const author = titleKey(hint?.author || parsed?.pkg?.author || '');
  for (let attempt = 0; attempt < 45; attempt++) {
    const candidates = [];
    const current = app.readerCurrentBook?.();
    if (current) candidates.push(current);
    try { candidates.push(...(app.loadReaderBooks?.() || [])); } catch {}
    const unique = [...new Map(candidates.filter(Boolean).map(book => [book.id, book])).values()];
    const matches = unique.filter(book => {
      if (book.source !== 'epub') return false;
      if (title && titleKey(book.title) !== title) return false;
      if (author && titleKey(book.author) && titleKey(book.author) !== author) return false;
      return true;
    }).sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    if (matches[0]) return matches[0];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

export async function applyCapturedEpubToc({ title = '', author = '', record = pending } = {}) {
  if (!record) return { ok: false, reason: 'no-pending-epub' };
  let parsed;
  try { parsed = await record.promise; }
  catch (error) {
    window.showToast?.(`⚠️ EPUB-оглавление не прочитано: ${error?.message || error}`);
    return { ok: false, reason: 'parse', error };
  }
  const app = await appModule();
  const book = await findSavedBook(app, { title, author }, parsed);
  if (!book) {
    window.showToast?.('⚠️ EPUB сохранён, но книга для оглавления не найдена');
    return { ok: false, reason: 'book-not-found' };
  }
  book.toc = mapRowsToBook(book, parsed);
  book.epubTocSource = parsed.source;
  book._tocDirectSignature = `${record.fileName}|${parsed.source}|${parsed.rows.length}`;
  book.updatedAt = new Date().toISOString();
  try { app.saveReaderBooks?.(); } catch {}
  const mapped = book.toc.filter(row => Number.isInteger(row.chapterIndex)).length;
  window.showToast?.(`📚 Оглавление EPUB: ${book.toc.length} пунктов · ${mapped} переходов`);
  console.info('[toc-direct] applied', { book: book.title, rows: book.toc.length, mapped, source: parsed.source });
  return { ok: true, book, rows: book.toc.length, mapped, source: parsed.source };
}

async function repairVisibleGenericBook() {
  try {
    const reading = document.getElementById('reader-reading-view');
    if (!reading || reading.style.display === 'none') return;
    const app = await appModule();
    let book = app.readerCurrentBook?.();
    if (!book?.chapters?.length) {
      const title = clean(document.getElementById('reader-book-title')?.textContent || '');
      const books = app.loadReaderBooks?.() || [];
      const matches = books.filter(item => clean(item?.title) === title);
      if (matches.length === 1) book = matches[0];
    }
    if (!book?.chapters?.length || book.source !== 'epub') return;
    const needsRepair = !(Array.isArray(book.toc) && book.toc.length)
      || (book.chapters || []).some(chapter => genericTitle(chapter.title));
    if (needsRepair) await repairBookTocFromContent(book);
  } catch (error) {
    console.warn('[toc-direct] legacy title repair skipped', error);
  }
}

// Regular browser/file-picker path. Android additionally calls the exported
// function explicitly, so it does not depend on this DOM event firing.
document.addEventListener('change', event => {
  try { captureEpubTocFile(event?.target?.files?.[0]); } catch {}
}, true);

for (const delay of [250, 900, 2500, 6000]) setTimeout(repairVisibleGenericBook, delay);
window.addEventListener('pageshow', () => setTimeout(repairVisibleGenericBook, 250));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(repairVisibleGenericBook, 250);
});
repairTimer = setInterval(repairVisibleGenericBook, 5000);
window.addEventListener('pagehide', () => {
  if (repairTimer) clearInterval(repairTimer);
  repairTimer = null;
});

try {
  window.readerCaptureEpubTocFile = captureEpubTocFile;
  window.readerApplyCapturedEpubToc = applyCapturedEpubToc;
  window.readerRepairBookTocFromContent = repairBookTocFromContent;
} catch {}

console.info('[toc-direct] loaded');
