// Reader AI EPUB TOC pipeline.
// The source EPUB is authoritative. We never label a guessed chapter list as
// "restored": exact TOC means nav.xhtml/NCX was parsed from the File itself.

import { readZipEntries, resolveEpubPath } from './epub.js?v=3';

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let pending = null;
let pendingSeq = 0;

function appModule() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function escXml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 0));
}

function stripTags(value) {
  return clean(escXml(String(value || '').replace(/<[^>]+>/g, ' ')));
}

function attrs(tag = '') {
  const out = {};
  String(tag).replace(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g, (_m, key, _q, value) => {
    out[key] = escXml(value);
    return '';
  });
  return out;
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

function parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
    if (doc.getElementsByTagName?.('parsererror')?.length) return null;
    if (doc.getElementsByTagNameNS?.('*', 'parsererror')?.length) return null;
    return doc;
  } catch { return null; }
}

function byLocal(root, name) {
  if (!root) return [];
  try {
    const ns = root.getElementsByTagNameNS?.('*', name);
    if (ns?.length) return [...ns];
  } catch {}
  try { return [...(root.getElementsByTagName?.(name) || [])]; } catch { return []; }
}

function directChildren(node, localName) {
  return [...(node?.children || [])].filter(child => String(child.localName || child.nodeName || '').split(':').pop() === localName);
}

async function locatePackage(entries) {
  let opfPath = '';
  try {
    const container = await entries.get('META-INF/container.xml')?.text();
    opfPath = safeDecode(container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1] || '');
  } catch {}
  if (!opfPath) opfPath = [...entries.keys()].find(path => /\.opf$/i.test(path)) || '';
  if (!opfPath || !entries.has(opfPath)) throw new Error('EPUB: package.opf не найден');

  const opfText = await entries.get(opfPath).text();
  const base = opfPath.split('/').slice(0, -1).join('/');
  const manifest = new Map();
  const spineIds = [];
  let spineTocId = '';

  for (const match of String(opfText).matchAll(/<item\b[^>]*>/gi)) {
    const a = attrs(match[0]);
    const id = a.id || '';
    const href = a.href || '';
    if (!id || !href) continue;
    const resolved = splitHref(base, href).path;
    manifest.set(id, {
      id,
      path: resolved,
      mediaType: a['media-type'] || '',
      properties: a.properties || '',
    });
  }
  const spineTag = String(opfText).match(/<spine\b[^>]*>/i)?.[0] || '';
  spineTocId = attrs(spineTag).toc || '';
  const spineBlock = String(opfText).match(/<spine\b[^>]*>([\s\S]*?)<\/spine\s*>/i)?.[1] || '';
  for (const match of spineBlock.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attrs(match[0]).idref || '';
    if (idref) spineIds.push(idref);
  }

  let navPath = '';
  let ncxPath = '';
  for (const item of manifest.values()) {
    if (/(^|\s)nav(\s|$)/i.test(item.properties)) navPath ||= item.path;
    if (/application\/x-dtbncx\+xml/i.test(item.mediaType) || /\.ncx$/i.test(item.path)) ncxPath ||= item.path;
  }
  if (spineTocId && manifest.get(spineTocId)?.path) ncxPath = manifest.get(spineTocId).path;

  const spine = spineIds.map(id => manifest.get(id)?.path).filter(Boolean);
  const title = stripTags(String(opfText).match(/<(?:\w+:)?title\b[^>]*>([\s\S]*?)<\/(?:\w+:)?title\s*>/i)?.[1] || '');
  const author = stripTags(String(opfText).match(/<(?:\w+:)?creator\b[^>]*>([\s\S]*?)<\/(?:\w+:)?creator\s*>/i)?.[1] || '');
  return { opfPath, base, manifest, spine, navPath, ncxPath, title, author };
}

function dedupeRows(rows) {
  const out = [];
  const seen = new Set();
  for (const raw of rows || []) {
    const title = clean(raw.title);
    const path = safeDecode(raw.path);
    const depth = Math.max(0, Number(raw.depth) || 0);
    if (!title && !path) continue;
    const key = `${path}#${raw.fragment || ''}|${title}|${depth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title || 'Раздел',
      path,
      fragment: raw.fragment || '',
      depth,
      order: out.length,
    });
  }
  for (let i = 0; i < out.length; i++) {
    out[i].hasChildren = Number(out[i + 1]?.depth || 0) > Number(out[i].depth || 0);
  }
  return out;
}

function parseNcxDom(text, ncxPath) {
  const doc = parseXml(text);
  if (!doc) return [];
  const navMap = byLocal(doc, 'navMap')[0];
  if (!navMap) return [];
  const base = ncxPath.split('/').slice(0, -1).join('/');
  const rows = [];
  const walk = (point, depth) => {
    const labelNode = byLocal(point, 'navLabel')[0];
    const textNode = labelNode ? byLocal(labelNode, 'text')[0] : null;
    const content = byLocal(point, 'content')[0];
    const title = clean(textNode?.textContent || '');
    const target = splitHref(base, content?.getAttribute?.('src') || '');
    if (title || target.path) rows.push({ title: title || 'Раздел', depth, ...target });
    for (const child of directChildren(point, 'navPoint')) walk(child, depth + 1);
  };
  for (const point of directChildren(navMap, 'navPoint')) walk(point, 0);
  return rows;
}

function parseNcxTokens(text, ncxPath) {
  const base = ncxPath.split('/').slice(0, -1).join('/');
  const rows = [];
  const stack = [];
  const tokenRe = /<navPoint\b[^>]*>|<\/navPoint\s*>|<navLabel\b[^>]*>[\s\S]*?<\/navLabel\s*>|<content\b[^>]*>/gi;
  for (const match of String(text || '').matchAll(tokenRe)) {
    const token = match[0];
    const lower = token.toLowerCase();
    if (lower.startsWith('<navpoint')) {
      const row = { title: '', depth: stack.length, path: '', fragment: '' };
      rows.push(row);
      stack.push(row);
      continue;
    }
    if (lower.startsWith('</navpoint')) {
      stack.pop();
      continue;
    }
    const row = stack[stack.length - 1];
    if (!row) continue;
    if (lower.startsWith('<navlabel')) {
      const label = token.match(/<text\b[^>]*>([\s\S]*?)<\/text\s*>/i)?.[1] || '';
      row.title = stripTags(label);
    } else if (lower.startsWith('<content')) {
      const target = splitHref(base, attrs(token).src || '');
      row.path = target.path;
      row.fragment = target.fragment;
    }
  }
  return rows.filter(row => row.title || row.path);
}

function parseNcx(text, ncxPath) {
  const dom = dedupeRows(parseNcxDom(text, ncxPath));
  const token = dedupeRows(parseNcxTokens(text, ncxPath));
  return token.length > dom.length ? token : dom;
}

function parseNav(text, navPath) {
  let doc = null;
  try { doc = new DOMParser().parseFromString(String(text || ''), 'text/html'); } catch {}
  if (!doc) return [];
  const navs = [...doc.querySelectorAll?.('nav') || []];
  const nav = navs.find(node => {
    const type = node.getAttribute('epub:type') || node.getAttribute('type') || '';
    const role = node.getAttribute('role') || '';
    return /(^|\s)toc(\s|$)/i.test(type) || /doc-toc/i.test(role);
  }) || navs[0];
  if (!nav) return [];
  const base = navPath.split('/').slice(0, -1).join('/');
  const rows = [];
  const walk = (list, depth) => {
    const lis = [...(list?.children || [])].filter(el => String(el.tagName || '').toLowerCase() === 'li');
    for (const li of lis) {
      const anchor = [...li.children].find(el => /^(a|span)$/i.test(el.tagName || '')) || li.querySelector?.('a');
      const title = clean(anchor?.textContent || li.firstChild?.textContent || '');
      const href = anchor?.tagName?.toLowerCase() === 'a' ? anchor.getAttribute('href') || '' : '';
      const target = splitHref(base, href);
      if (title || target.path) rows.push({ title: title || 'Раздел', depth, ...target });
      const nested = [...li.children].find(el => /^(ol|ul)$/i.test(el.tagName || ''));
      if (nested) walk(nested, depth + 1);
    }
  };
  const root = [...nav.children].find(el => /^(ol|ul)$/i.test(el.tagName || '')) || nav.querySelector?.('ol,ul');
  if (root) walk(root, 0);
  return dedupeRows(rows);
}

function fingerprint(value) {
  const normalized = clean(value).normalize?.('NFKC') || clean(value);
  try { return normalized.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 1400); }
  catch { return normalized.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 1400); }
}

function htmlText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll?.('script,style,noscript,svg,nav').forEach(node => node.remove());
    return clean(doc.body?.textContent || doc.documentElement?.textContent || '');
  } catch {
    return stripTags(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
  }
}

function itemText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return String(item.text || item.value || item.content || item.caption || item.alt || '');
}

function chapterFingerprint(chapter) {
  let text = '';
  for (const item of chapter?.paragraphs || []) {
    const value = clean(itemText(item));
    if (!value) continue;
    text += (text ? ' ' : '') + value;
    if (text.length >= 1800) break;
  }
  return fingerprint(text);
}

function matchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1000;
  const lengths = [220, 140, 90, 60, 40];
  const scores = [900, 760, 620, 480, 320];
  for (let i = 0; i < lengths.length; i++) {
    const n = lengths[i];
    if (a.length >= n && b.length >= n && a.slice(0, n) === b.slice(0, n)) return scores[i];
  }
  const a80 = a.slice(0, 80), b80 = b.slice(0, 80);
  if (a80.length > 45 && b80.length > 45 && (a.includes(b80) || b.includes(a80))) return 250;
  return 0;
}

async function parseOutline(file) {
  const entries = await readZipEntries(await file.arrayBuffer());
  const pkg = await locatePackage(entries);

  let rows = [];
  let source = '';
  if (pkg.navPath && entries.has(pkg.navPath)) {
    rows = parseNav(await entries.get(pkg.navPath).text(), pkg.navPath);
    if (rows.length) source = 'EPUB3 nav';
  }
  if (!rows.length && pkg.ncxPath && entries.has(pkg.ncxPath)) {
    rows = parseNcx(await entries.get(pkg.ncxPath).text(), pkg.ncxPath);
    if (rows.length) source = 'EPUB2 NCX';
  }
  if (!rows.length) throw new Error('EPUB не содержит читаемого nav/NCX оглавления');

  const wanted = new Set([...pkg.spine, ...rows.map(row => row.path)].filter(Boolean));
  const fingerprints = new Map();
  for (const path of wanted) {
    if (!entries.has(path) || !/\.(?:xhtml|html|htm)$/i.test(path)) continue;
    try { fingerprints.set(path, fingerprint(htmlText(await entries.get(path).text()))); } catch {}
  }
  return { rows, source, pkg, fingerprints, entryCount: entries.size };
}

export function captureEpubTocFile(file) {
  if (!file || !/\.epub$/i.test(String(file.name || ''))) return null;
  const record = {
    seq: ++pendingSeq,
    fileName: String(file.name || 'book.epub'),
    startedAt: Date.now(),
    promise: parseOutline(file),
    appliedResult: null,
  };
  pending = record;
  record.promise
    .then(parsed => {
      console.info('[toc-direct] exact EPUB TOC parsed', {
        file: record.fileName,
        rows: parsed.rows.length,
        source: parsed.source,
        first: parsed.rows.slice(0, 6).map(row => row.title),
      });
      const status = document.getElementById('reader-import-status');
      if (status && status.style.display !== 'none') {
        status.dataset.epubTocReady = '1';
        status.title = `${parsed.source}: ${parsed.rows.map(row => row.title).join(' · ')}`;
      }
    })
    .catch(error => console.warn('[toc-direct] exact EPUB TOC parse failed', error));
  return record;
}

function titleKey(value) {
  return fingerprint(value).slice(0, 220);
}

async function findSavedBook(app, hint, parsed) {
  const wantedTitle = titleKey(hint?.title || parsed?.pkg?.title || '');
  const wantedAuthor = titleKey(hint?.author || parsed?.pkg?.author || '');
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidates = [];
    try {
      const current = app.readerCurrentBook?.();
      if (current) candidates.push(current);
    } catch {}
    try { candidates.push(...(app.loadReaderBooks?.() || [])); } catch {}
    const unique = [...new Map(candidates.filter(book => book?.id).map(book => [book.id, book])).values()];
    let best = null;
    let bestScore = -1e9;
    for (const book of unique) {
      const bt = titleKey(book.title || '');
      const ba = titleKey(book.author || '');
      if (wantedTitle && bt !== wantedTitle) continue;
      let score = 0;
      if (wantedTitle && bt === wantedTitle) score += 1000;
      if (wantedAuthor && ba === wantedAuthor) score += 300;
      else if (wantedAuthor && ba && ba !== wantedAuthor) score -= 120;
      if (book.source === 'epub') score += 120;
      if (Array.isArray(book.chapters) && book.chapters.length) score += 80;
      score += Math.min(60, Math.max(0, Date.now() - new Date(book.updatedAt || 0).getTime()) < 120000 ? 60 : 0);
      if (score > bestScore) { bestScore = score; best = book; }
    }
    if (best) return best;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

function mapRowsToBook(book, parsed) {
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const rows = parsed.rows.map(row => ({ ...row, chapterIndex: null }));
  const chapterFps = chapters.map(chapterFingerprint);
  const usedChapters = new Set();
  const pathToChapter = new Map();

  for (const [path, fp] of parsed.fingerprints) {
    if (!fp) continue;
    let bestIndex = -1;
    let best = 0;
    for (let ci = 0; ci < chapterFps.length; ci++) {
      if (usedChapters.has(ci)) continue;
      const score = matchScore(chapterFps[ci], fp);
      if (score > best) { best = score; bestIndex = ci; }
    }
    if (bestIndex >= 0 && best >= 250) {
      pathToChapter.set(path, bestIndex);
      usedChapters.add(bestIndex);
      chapters[bestIndex].sourcePath = path;
    }
  }

  for (let ci = 0; ci < chapters.length; ci++) {
    const path = safeDecode(chapters[ci]?.sourcePath || '');
    if (path) pathToChapter.set(path, ci);
  }

  for (const row of rows) {
    const ci = pathToChapter.get(row.path);
    if (Number.isInteger(ci)) row.chapterIndex = ci;
  }

  const named = new Set();
  for (const row of rows) {
    const ci = row.chapterIndex;
    if (!Number.isInteger(ci) || named.has(ci) || !chapters[ci]) continue;
    const title = clean(row.title);
    if (!title) continue;
    chapters[ci].title = title;
    named.add(ci);
  }
  return rows;
}

export async function applyCapturedEpubToc({ title = '', author = '', record = pending } = {}) {
  if (!record) return { ok: false, reason: 'no-epub-file' };
  if (record.appliedResult?.ok) return record.appliedResult;

  let parsed;
  try { parsed = await record.promise; }
  catch (error) {
    const message = `EPUB TOC: ${error?.message || error}`;
    window.showToast?.(`⚠️ ${message}`);
    return { ok: false, reason: 'parse', error };
  }

  const app = await appModule();
  const book = await findSavedBook(app, { title, author }, parsed);
  if (!book) {
    window.showToast?.('⚠️ Оглавление EPUB прочитано, но сохранённая книга не найдена');
    return { ok: false, reason: 'book-not-found', rows: parsed.rows.length, source: parsed.source };
  }

  book.toc = mapRowsToBook(book, parsed);
  book.epubTocSource = parsed.source;
  book._epubTocExact = true;
  book._epubTocFile = record.fileName;
  book._epubTocCount = parsed.rows.length;
  book.updatedAt = new Date().toISOString();

  try { app.saveReaderBooks?.(); } catch (error) {
    console.warn('[toc-direct] save exact TOC failed', error);
  }

  const mapped = book.toc.filter(row => Number.isInteger(row.chapterIndex)).length;
  const result = {
    ok: true,
    book,
    bookId: book.id,
    rows: book.toc.length,
    mapped,
    source: parsed.source,
    firstTitles: book.toc.slice(0, 8).map(row => row.title),
  };
  record.appliedResult = result;
  if (pending === record) pending = null;

  window.showToast?.(`📚 ${parsed.source}: ${book.toc.length} пунктов`);
  console.info('[toc-direct] exact TOC attached', {
    book: book.title,
    rows: result.rows,
    mapped,
    source: result.source,
    first: result.firstTitles,
  });
  return result;
}

export async function repairBookTocFromContent() {
  return false;
}

document.addEventListener('change', event => {
  try { captureEpubTocFile(event?.target?.files?.[0]); } catch {}
}, true);

try {
  window.readerCaptureEpubTocFile = captureEpubTocFile;
  window.readerApplyCapturedEpubToc = applyCapturedEpubToc;
} catch {}

console.info('[toc-direct] loaded');
