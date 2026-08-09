// Reader AI EPUB TOC authority.
//
// This module deliberately does NOT rely on the old readerOpenToc / import
// monkey-patch chain. It captures the EPUB file itself, parses package
// navigation, attaches the outline to the saved book, remembers the exact book
// object currently being rendered, and intercepts TOC taps in capture phase.
// That makes the TOC independent of stale __real_* handlers and of a transient
// readerCurrentBookId reset while the book is still visibly open.

import { readZipEntries, resolveEpubPath } from './epub.js?v=3';

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let visibleBook = null;
let pendingImport = null;
let pendingSeq = 0;
let lastCapturedFile = null;
let wrappersTimer = null;

function appModule() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    const text = await entries.get('META-INF/container.xml')?.text();
    const doc = parseXml(text);
    opfPath = safeDecode(firstLocal(doc, 'rootfile')?.getAttribute?.('full-path') || '');
    if (!opfPath) opfPath = safeDecode(String(text || '').match(/full-path=["']([^"']+)["']/i)?.[1] || '');
  } catch {}
  if (!opfPath) opfPath = [...entries.keys()].find(path => /\.opf$/i.test(path)) || '';
  if (!opfPath || !entries.has(opfPath)) throw new Error('EPUB: package.opf не найден');

  const opfText = await entries.get(opfPath).text();
  const opf = parseXml(opfText);
  const base = opfPath.split('/').slice(0, -1).join('/');
  const manifest = new Map();
  const spine = [];
  let navPath = '';
  let ncxPath = '';
  let spineTocId = '';

  if (opf) {
    const manifestRoot = firstLocal(opf, 'manifest');
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
    const spineRoot = firstLocal(opf, 'spine');
    spineTocId = spineRoot?.getAttribute?.('toc') || '';
    for (const itemref of localChildren(spineRoot, 'itemref')) {
      const item = manifest.get(itemref.getAttribute('idref') || '');
      if (item?.path) spine.push(item.path);
    }
  }

  // Narrow fallback for malformed OPF files.
  if (!manifest.size) {
    for (const match of String(opfText || '').matchAll(/<item\b[^>]*>/gi)) {
      const tag = match[0];
      const attr = name => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] || '';
      const id = attr('id');
      const href = attr('href');
      const mediaType = attr('media-type');
      const properties = attr('properties');
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

  const metadata = firstLocal(opf, 'metadata') || opf;
  const metaText = name => clean(firstLocal(metadata, name)?.textContent || '');
  return {
    opfPath, base, manifest, spine, navPath, ncxPath,
    title: metaText('title'),
    author: metaText('creator'),
  };
}

function parseNcx(text, ncxPath) {
  const doc = parseXml(text);
  const navMap = firstLocal(doc, 'navMap');
  if (!navMap) return [];
  const base = ncxPath.split('/').slice(0, -1).join('/');
  const rows = [];
  const walk = (point, depth) => {
    const label = clean(firstLocal(firstLocal(point, 'navLabel'), 'text')?.textContent || '');
    const href = firstLocal(point, 'content')?.getAttribute?.('src') || '';
    const { path, fragment } = splitHref(base, href);
    if (label || path) rows.push({ title: label || 'Раздел', depth, path, fragment });
    for (const child of localChildren(point, 'navPoint')) walk(child, depth + 1);
  };
  for (const point of localChildren(navMap, 'navPoint')) walk(point, 0);
  return rows;
}

function parseNav(text, navPath) {
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
  const base = navPath.split('/').slice(0, -1).join('/');
  const rows = [];
  const direct = (node, names) => [...(node?.children || [])].find(child => names.includes(child.localName));
  const walk = (list, depth) => {
    for (const li of localChildren(list, 'li')) {
      const labelEl = direct(li, ['a', 'span']) || li;
      const anchor = labelEl.localName === 'a' ? labelEl : direct(li, ['a']);
      const title = clean(labelEl.textContent || '');
      const { path, fragment } = splitHref(base, anchor?.getAttribute?.('href') || '');
      if (title || path) rows.push({ title: title || 'Раздел', depth, path, fragment });
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
    const key = `${path}#${raw.fragment || ''}|${title}|${Number(raw.depth) || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title || 'Раздел',
      path,
      fragment: raw.fragment || '',
      depth: Math.max(0, Number(raw.depth) || 0),
      order: out.length,
    });
  }
  return out;
}

function fingerprint(value) {
  return clean(value)
    .normalize?.('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 420) || '';
}

function htmlFingerprint(html) {
  const doc = parseHtml(html);
  if (!doc) return '';
  try { doc.querySelectorAll?.('script,style,noscript,svg').forEach(node => node.remove()); } catch {}
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
    if (parts.join(' ').length > 650) break;
  }
  return fingerprint(parts.join(' '));
}

async function parseEpubOutline(file) {
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

  const relevantPaths = new Set([
    ...pkg.spine,
    ...rows.map(row => row.path),
  ].filter(Boolean));
  const fingerprints = new Map();
  for (const path of relevantPaths) {
    if (!entries.has(path) || !/\.(?:xhtml|html|htm)$/i.test(path)) continue;
    try { fingerprints.set(path, htmlFingerprint(await entries.get(path).text())); }
    catch {}
  }
  return { rows, source, pkg, fingerprints };
}

function captureEpubFile(file) {
  if (!file || !/\.epub$/i.test(String(file.name || ''))) return null;
  if (file === lastCapturedFile && pendingImport) return pendingImport;
  lastCapturedFile = file;
  const seq = ++pendingSeq;
  const record = {
    seq,
    fileName: file.name || 'book.epub',
    startedAt: Date.now(),
    promise: parseEpubOutline(file),
  };
  pendingImport = record;
  record.promise
    .then(parsed => console.info('[reader toc authority] parsed', { file: record.fileName, rows: parsed.rows.length, source: parsed.source }))
    .catch(error => console.warn('[reader toc authority] parse failed', error));
  return record;
}

function currentHint() {
  return {
    title: clean(document.getElementById('reader-import-title')?.value || ''),
    author: clean(document.getElementById('reader-import-author')?.value || ''),
  };
}

function titleKey(value) {
  return fingerprint(value).slice(0, 180);
}

async function findSavedEpub(app, hint, parsed) {
  const title = titleKey(hint.title || parsed?.pkg?.title || '');
  const author = titleKey(hint.author || parsed?.pkg?.author || '');
  for (let attempt = 0; attempt < 60; attempt++) {
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

function scoreFingerprint(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const a80 = a.slice(0, 80), b80 = b.slice(0, 80);
  if (a80.length > 35 && (a.includes(b80) || b.includes(a80))) return 82;
  const a45 = a.slice(0, 45), b45 = b.slice(0, 45);
  if (a45.length > 25 && (a.includes(b45) || b.includes(a45))) return 60;
  return 0;
}

function mapOutlineToBook(book, parsed) {
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const rows = parsed.rows.map(row => ({ ...row, chapterIndex: null }));
  const pathToChapter = new Map();
  const usedPaths = new Set();
  const chapterFps = chapters.map(chapterFingerprint);

  // First pass: prose fingerprint matching. This survives skipped cover/nav
  // files and short publisher pages, unlike a blind spineIndex === chapterIndex.
  for (let ci = 0; ci < chapters.length; ci++) {
    let bestPath = '';
    let bestScore = 0;
    for (const [path, fp] of parsed.fingerprints) {
      if (usedPaths.has(path)) continue;
      const score = scoreFingerprint(chapterFps[ci], fp);
      if (score > bestScore) { bestScore = score; bestPath = path; }
    }
    if (bestPath && bestScore >= 60) {
      pathToChapter.set(bestPath, ci);
      usedPaths.add(bestPath);
    }
  }

  // Second pass: align remaining chapters with the same filtered spine order
  // used by the legacy importer. This covers very short chapters whose prose
  // fingerprint is too small to be distinctive.
  const spine = parsed.pkg.spine.filter(path =>
    /\.(?:xhtml|html|htm)$/i.test(path) && !/\b(nav|toc|cover)\b/i.test(path)
  );
  let nextCi = 0;
  for (const path of spine) {
    if (pathToChapter.has(path)) {
      nextCi = Math.max(nextCi, pathToChapter.get(path) + 1);
      continue;
    }
    while (nextCi < chapters.length && [...pathToChapter.values()].includes(nextCi)) nextCi++;
    if (nextCi >= chapters.length) break;
    pathToChapter.set(path, nextCi++);
  }

  for (const row of rows) {
    const index = pathToChapter.get(row.path);
    if (Number.isInteger(index)) row.chapterIndex = index;
  }

  // Real EPUB labels become the chapter labels in the reading header too.
  const named = new Set();
  for (const row of rows) {
    const ci = row.chapterIndex;
    if (!Number.isInteger(ci) || named.has(ci) || !chapters[ci]) continue;
    const title = clean(row.title);
    if (!title) continue;
    chapters[ci].title = title;
    named.add(ci);
  }

  // A parent row can legitimately point to the same chapter as its first child.
  // Mark hierarchy explicitly for the renderer; no flattening.
  for (let i = 0; i < rows.length; i++) {
    rows[i].hasChildren = Number(rows[i + 1]?.depth || 0) > Number(rows[i].depth || 0);
  }
  return rows;
}

async function applyPendingImport(record, hint) {
  if (!record || record !== pendingImport) return false;
  let parsed;
  try { parsed = await record.promise; }
  catch (error) {
    window.showToast?.(`⚠️ EPUB-оглавление не прочитано: ${error?.message || error}`);
    return false;
  }
  const app = await appModule();
  const book = await findSavedEpub(app, hint, parsed);
  if (!book) {
    window.showToast?.('⚠️ EPUB сохранён, но запись книги для оглавления не найдена');
    return false;
  }

  const signature = `${record.fileName}|${parsed.source}|${parsed.rows.length}`;
  if (book._tocAuthoritySignature === signature && Array.isArray(book.toc) && book.toc.length) return true;
  book.toc = mapOutlineToBook(book, parsed);
  book.epubTocSource = parsed.source;
  book._tocAuthoritySignature = signature;
  book.updatedAt = new Date().toISOString();
  try { app.saveReaderBooks?.(); } catch {}
  if (visibleBook?.id === book.id) visibleBook = book;
  const mapped = book.toc.filter(row => Number.isInteger(row.chapterIndex)).length;
  window.showToast?.(`📚 Оглавление: ${book.toc.length} пунктов · ${mapped} переходов`);
  console.info('[reader toc authority] applied', { book: book.title, rows: book.toc.length, mapped, source: parsed.source });
  return true;
}

function installImportSaveWrappers() {
  const importFn = window.readerImportFromFile;
  if (typeof importFn === 'function' && !importFn.__isStub && !importFn.__tocAuthorityImport) {
    const wrappedImport = function readerImportFromFileTocAuthority(event, ...rest) {
      try { captureEpubFile(event?.target?.files?.[0]); } catch {}
      return importFn.call(this, event, ...rest);
    };
    wrappedImport.__tocAuthorityImport = true;
    wrappedImport.__wrapped = importFn;
    window.readerImportFromFile = wrappedImport;
    window.__real_readerImportFromFile = wrappedImport;
  }

  const saveFn = window.saveReaderImport;
  if (typeof saveFn === 'function' && !saveFn.__isStub && !saveFn.__tocAuthoritySave) {
    const wrappedSave = function saveReaderImportTocAuthority(...args) {
      const record = pendingImport;
      const hint = currentHint();
      const result = saveFn.apply(this, args);
      Promise.resolve(result)
        .catch(() => null)
        .then(() => applyPendingImport(record, hint))
        .catch(error => console.warn('[reader toc authority] post-save apply failed', error));
      return result;
    };
    wrappedSave.__tocAuthoritySave = true;
    wrappedSave.__wrapped = saveFn;
    window.saveReaderImport = wrappedSave;
    window.__real_saveReaderImport = wrappedSave;
  }
}

export function setTocVisibleBook(book) {
  if (book?.chapters?.length) visibleBook = book;
}

async function resolveVisibleBook() {
  if (visibleBook?.chapters?.length) return visibleBook;
  const app = await appModule();
  const current = app.readerCurrentBook?.();
  if (current?.chapters?.length) {
    visibleBook = current;
    return current;
  }

  let books = [];
  try { books = app.loadReaderBooks?.() || []; } catch {}
  const root = document.getElementById('reader-chapter-text');
  const renderedId = clean(root?.dataset?.readerBookId || '');
  const title = clean(document.getElementById('reader-book-title')?.textContent || '');
  let book = renderedId ? books.find(item => String(item?.id || '') === renderedId) : null;
  if (!book && title) {
    const matches = books.filter(item => clean(item?.title) === title);
    if (matches.length === 1) book = matches[0];
  }
  if (book?.chapters?.length) visibleBook = book;
  return book || null;
}

function ensureTocStyles() {
  if (document.getElementById('reader-toc-authority-style')) return;
  const style = document.createElement('style');
  style.id = 'reader-toc-authority-style';
  style.textContent = `
    #reader-toc-header{display:flex;align-items:center;justify-content:space-between;gap:10px}
    #reader-toc-header .rd-toc-meta{font-family:'IBM Plex Sans',sans-serif;font-size:.68rem;letter-spacing:0;text-transform:none;font-weight:400;color:var(--text-muted)}
    .rd-toc-item[data-depth="1"]{background:color-mix(in srgb,var(--surface2) 35%,transparent)}
    .rd-toc-item[data-depth="2"]{background:color-mix(in srgb,var(--surface2) 55%,transparent)}
    .rd-toc-item.toc-parent .rd-toc-title{font-weight:700}
    .rd-toc-item.toc-unmapped{opacity:.6}
    .rd-toc-indent{display:inline-block;flex:0 0 auto;width:var(--toc-indent,0px)}
    .rd-toc-title{word-break:break-word}
    .rd-toc-count:empty{display:none}
  `;
  document.head.appendChild(style);
}

async function goToBookChapter(book, chapterIndex) {
  const app = await appModule();
  const index = Math.max(0, Math.min(Number(chapterIndex) || 0, Math.max(0, (book.chapters || []).length - 1)));
  book.currentChapter = index;
  book.currentParagraph = 0;
  book.updatedAt = new Date().toISOString();
  try { app.saveReaderBooks?.(); } catch {}
  try { await app.readerOpenBook?.(book.id); }
  catch (error) { console.warn('[reader toc authority] chapter open failed', error); }
}

export async function openTocAuthority() {
  const book = await resolveVisibleBook();
  if (!book?.chapters?.length) {
    window.showToast?.('⚠️ Книга видна, но её данные не найдены. Вернись в библиотеку и открой её снова.');
    return false;
  }
  ensureTocStyles();
  const list = document.getElementById('reader-toc-list');
  const back = document.getElementById('reader-toc-back');
  const sheet = document.getElementById('reader-toc-sheet');
  const header = document.getElementById('reader-toc-header');
  if (!list || !back || !sheet) return false;

  const cur = Math.max(0, Number(book.currentChapter) || 0);
  const rows = Array.isArray(book.toc) && book.toc.length
    ? book.toc
    : (book.chapters || []).map((chapter, index) => ({
        title: clean(chapter.title) || `Глава ${index + 1}`,
        depth: 0,
        chapterIndex: index,
        hasChildren: false,
      }));
  const mapped = rows.filter(row => Number.isInteger(Number(row.chapterIndex))).length;
  if (header) {
    header.innerHTML = `<span>Оглавление</span><span class="rd-toc-meta">${rows.length} пунктов${book.epubTocSource ? ` · ${escapeHtml(book.epubTocSource)}` : ''}</span>`;
  }

  list.innerHTML = rows.map((row, i) => {
    const rawIndex = row.chapterIndex;
    const ci = rawIndex === null || rawIndex === undefined ? null : Number(rawIndex);
    const isMapped = Number.isInteger(ci) && ci >= 0 && ci < book.chapters.length;
    const current = isMapped && ci === cur;
    const done = isMapped && ci < cur;
    const depth = Math.max(0, Math.min(6, Number(row.depth) || 0));
    const hasChildren = row.hasChildren === true || Number(rows[i + 1]?.depth || 0) > depth;
    const chapter = isMapped ? book.chapters[ci] : null;
    const pCount = chapter ? (chapter.paragraphs || []).length : 0;
    const icon = done ? '✓' : current ? '▶' : hasChildren ? '▸' : '•';
    const cls = `rd-toc-item${current ? ' current' : ''}${done ? ' done' : ''}${hasChildren ? ' toc-parent' : ''}${isMapped ? '' : ' toc-unmapped'}`;
    const inside = `<span class="rd-toc-num">${icon}</span><span class="rd-toc-indent" style="--toc-indent:${depth * 18}px"></span><span class="rd-toc-title">${escapeHtml(row.title || chapter?.title || `Глава ${(ci ?? i) + 1}`)}</span><span class="rd-toc-count">${pCount ? `${pCount} абз.` : ''}</span>`;
    if (!isMapped) return `<div class="${cls}" data-depth="${depth}">${inside}</div>`;
    return `<button class="${cls}" data-depth="${depth}" data-toc-chapter="${ci}">${inside}</button>`;
  }).join('');

  for (const button of list.querySelectorAll('[data-toc-chapter]')) {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const ci = Number(button.dataset.tocChapter);
      back.classList.remove('show');
      sheet.classList.remove('show');
      await goToBookChapter(book, ci);
    });
  }

  back.classList.add('show');
  sheet.classList.add('show');
  setTimeout(() => list.querySelector('.current')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 80);
  console.info('[reader toc authority] open', { book: book.title, rows: rows.length, mapped });
  return true;
}

function installOpenAuthority() {
  const fn = openTocAuthority;
  fn.__tocAuthorityOpen = true;
  window.readerOpenToc = fn;
  window.__real_readerOpenToc = fn;
}

// Normal file picker: capture the EPUB independently of whichever inline/window
// handler happens to be active in this build.
document.addEventListener('change', event => {
  try { captureEpubFile(event?.target?.files?.[0]); } catch {}
}, true);

// Capture phase wins even if an old inline onclick or __real_* function is still
// around. This is the actual user-facing authority for both the title and menu.
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  const trigger = target?.closest?.('.rd-head,[onclick*="readerOpenToc"]');
  if (!trigger) return;
  if (!document.getElementById('reader-reading-view')?.contains(trigger)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openTocAuthority().catch(error => {
    console.error('[reader toc authority] open failed', error);
    window.showToast?.(`⚠️ Оглавление: ${error?.message || error}`);
  });
}, true);

function refreshWrappers() {
  installOpenAuthority();
  installImportSaveWrappers();
}

for (const delay of [0, 50, 150, 400, 1000, 2500, 6000, 12000]) setTimeout(refreshWrappers, delay);
window.addEventListener('pageshow', refreshWrappers);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshWrappers();
});
wrappersTimer = setInterval(refreshWrappers, 15000);
window.addEventListener('pagehide', () => {
  if (wrappersTimer) clearInterval(wrappersTimer);
  wrappersTimer = null;
});

console.info('[reader toc authority] loaded');
