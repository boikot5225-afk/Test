// EPUB table-of-contents upgrade for Reader AI 77.42.
//
// The legacy importer treated every spine XHTML file as an anonymous chapter
// and guessed its title from h1/h2/h3/<title>. Real commercial EPUBs often put
// the authoritative chapter names only in EPUB2 toc.ncx / EPUB3 nav.xhtml and
// use publisher-specific classes such as .tit-capitulo inside the content.
// Result: "Глава 1 / Глава 2 / ...", missing short/image-only sections and a
// flat TOC that ignored PART -> chapter hierarchy.
//
// This module deliberately sits beside the old importer instead of replacing
// it. The old path still does the preview/import (and therefore stays a safe
// fallback for odd books). In parallel we parse the package TOC, rebuild the
// saved EPUB's chapter structure from the package reading order, preserve old
// chapter ids when the prose matches, and make the TOC sheet render the real
// hierarchy. Re-importing an already saved EPUB upgrades that existing copy too.

import {
  readZipEntries,
  resolveEpubPath,
  cleanEpubText,
  htmlToPlainText,
  htmlToMixedItems,
} from './epub.js?v=3';
import { imgStorePut } from './image-store.js?v=1';

const EPUB_NS = 'http://www.idpf.org/2007/ops';
const INSTALL_RETRY_MS = 50;
const INSTALL_RETRY_LIMIT = 240;
let pendingEpubUpgrade = null;
let lastDiagnostics = null;
let installAttempts = 0;
let installed = false;
let readerAppModulePromise = null;

function readerAppModule() {
  if (!readerAppModulePromise) readerAppModulePromise = import('../reader-app.js');
  return readerAppModulePromise;
}

function cleanLabel(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function canonicalLang(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn' || raw === 'chinese') return 'zh';
  if (raw === 'ja' || raw.startsWith('ja-') || raw === 'jp' || raw === 'japanese') return 'ja';
  if (raw === 'en' || raw.startsWith('en-') || raw === 'english') return 'en';
  if (raw === 'es' || raw.startsWith('es-') || raw === 'spanish') return 'es';
  return 'fr';
}

function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return (clean.match(/[^.!?…。！？]+[.!?…。！？»”"]*|[^.!?…。！？]+$/g) || [clean])
    .map(item => item.trim())
    .filter(Boolean);
}

function chunkLongParagraph(paragraph, maxLen = 380) {
  const text = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const sentences = splitSentences(text);
  if (text.length <= maxLen || sentences.length <= 1) return [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) current = sentence;
    else if ((current + ' ' + sentence).length <= maxLen) current += ' ' + sentence;
    else { chunks.push(current); current = sentence; }
  }
  if (current) chunks.push(current);
  return chunks;
}

function safeDecodePath(value) {
  const raw = String(value || '').replace(/^\/+/, '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function splitHref(base, href) {
  const raw = String(href || '').trim();
  const hashAt = raw.indexOf('#');
  const pathPart = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).split('?')[0];
  const fragmentRaw = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  const path = safeDecodePath(resolveEpubPath(base, pathPart));
  let fragment = fragmentRaw;
  try { fragment = decodeURIComponent(fragmentRaw); } catch {}
  return { path, fragment };
}

function localChildren(node, name) {
  return [...(node?.children || [])].filter(child => child.localName === name);
}

function firstLocal(root, name) {
  if (!root) return null;
  if (root.localName === name) return root;
  const ns = root.getElementsByTagNameNS?.('*', name);
  if (ns?.length) return ns[0];
  const plain = root.getElementsByTagName?.(name);
  return plain?.[0] || null;
}

function parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
    if (firstLocal(doc, 'parsererror')) return null;
    return doc;
  } catch { return null; }
}

function parseHtmlDocument(text) {
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
    const rootfile = firstLocal(container, 'rootfile');
    opfPath = safeDecodePath(rootfile?.getAttribute?.('full-path') || '');
    if (!opfPath) opfPath = safeDecodePath(String(containerText || '').match(/full-path=["']([^"']+)["']/i)?.[1] || '');
  } catch {}
  if (!opfPath) opfPath = [...entries.keys()].find(path => /\.opf$/i.test(path)) || '';
  if (!opfPath || !entries.has(opfPath)) throw new Error('EPUB: OPF package не найден');

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
    for (const ref of localChildren(spineRoot, 'itemref')) {
      const idref = ref.getAttribute('idref') || '';
      const item = manifest.get(idref);
      if (item?.path) spine.push(item.path);
    }
  }

  // Broken-package fallback. Keep it deliberately narrow: just enough to
  // recover common hand-made EPUBs without inventing a second XML parser.
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

  const metadata = firstLocal(opf, 'metadata');
  const textOf = name => cleanLabel(firstLocal(metadata || opf, name)?.textContent || '');
  const language = canonicalLang(textOf('language'));
  const title = textOf('title');
  const creator = textOf('creator');
  const identifier = textOf('identifier');

  return { opfPath, opfText, base, manifest, spine, navPath, ncxPath, title, creator, language, identifier };
}

function parseNcxToc(text, ncxPath) {
  const doc = parseXml(text);
  const navMap = firstLocal(doc, 'navMap');
  if (!navMap) return [];
  const base = ncxPath.split('/').slice(0, -1).join('/');
  const rows = [];
  let order = 0;

  const walk = (point, depth) => {
    const navLabel = localChildren(point, 'navLabel')[0] || firstLocal(point, 'navLabel');
    const label = cleanLabel(firstLocal(navLabel, 'text')?.textContent || '');
    const content = localChildren(point, 'content')[0] || firstLocal(point, 'content');
    const href = content?.getAttribute?.('src') || '';
    const { path, fragment } = splitHref(base, href);
    if (label || path) rows.push({ title: label || 'Раздел', depth, path, fragment, order: order++ });
    for (const child of localChildren(point, 'navPoint')) walk(child, depth + 1);
  };
  for (const point of localChildren(navMap, 'navPoint')) walk(point, 0);
  return rows;
}

function parseNavToc(text, navPath) {
  const doc = parseHtmlDocument(text);
  if (!doc) return [];
  const navs = [...(doc.getElementsByTagNameNS?.('*', 'nav') || [])];
  let nav = navs.find(node => {
    const type = node.getAttribute('epub:type') || node.getAttributeNS?.(EPUB_NS, 'type') || '';
    const role = node.getAttribute('role') || '';
    return /(^|\s)toc(\s|$)/i.test(type) || /doc-toc/i.test(role);
  }) || navs[0];
  if (!nav) return [];
  const base = navPath.split('/').slice(0, -1).join('/');
  const rows = [];
  let order = 0;

  const directChild = (node, names) => [...(node?.children || [])].find(child => names.includes(child.localName));
  const walkList = (list, depth) => {
    for (const li of localChildren(list, 'li')) {
      const labelEl = directChild(li, ['a', 'span']) || li;
      const anchor = labelEl.localName === 'a' ? labelEl : directChild(li, ['a']);
      const label = cleanLabel(labelEl.textContent || '');
      const href = anchor?.getAttribute?.('href') || '';
      const { path, fragment } = splitHref(base, href);
      if (label || path) rows.push({ title: label || 'Раздел', depth, path, fragment, order: order++ });
      const nested = directChild(li, ['ol']);
      if (nested) walkList(nested, depth + 1);
    }
  };
  const rootList = directChild(nav, ['ol']) || firstLocal(nav, 'ol');
  if (rootList) walkList(rootList, 0);
  return rows;
}

function parseHtmlToc(text, tocPath) {
  const doc = parseHtmlDocument(text);
  if (!doc) return [];
  const base = tocPath.split('/').slice(0, -1).join('/');
  const rows = [];
  let order = 0;
  for (const anchor of [...(doc.getElementsByTagNameNS?.('*', 'a') || [])]) {
    const href = anchor.getAttribute('href') || '';
    const title = cleanLabel(anchor.textContent || '');
    if (!href || !title) continue;
    const { path, fragment } = splitHref(base, href);
    if (!path) continue;
    let depth = 0;
    let parent = anchor.parentElement;
    while (parent && parent !== doc.body) {
      const cls = String(parent.getAttribute?.('class') || '');
      const level = cls.match(/(?:toc|level)[-_ ]?(\d+)/i)?.[1] || cls.match(/(\d+)[-_ ]?level/i)?.[1];
      if (level) { depth = Math.max(0, Number(level) - 1); break; }
      parent = parent.parentElement;
    }
    rows.push({ title, depth, path, fragment, order: order++ });
  }
  return rows;
}

function dedupeToc(rows) {
  const out = [];
  const seen = new Set();
  for (const raw of rows || []) {
    const title = cleanLabel(raw.title);
    const path = safeDecodePath(raw.path);
    if (!title && !path) continue;
    const key = `${path}#${raw.fragment || ''}|${title}|${raw.depth || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title || 'Раздел', path, fragment: raw.fragment || '', depth: Math.max(0, Number(raw.depth) || 0), order: out.length });
  }
  return out;
}

async function extractPackageToc(entries, pkg) {
  if (pkg.navPath && entries.has(pkg.navPath)) {
    try {
      const rows = dedupeToc(parseNavToc(await entries.get(pkg.navPath).text(), pkg.navPath));
      if (rows.length) return { rows, source: 'EPUB3 nav' };
    } catch (error) { console.warn('[reader toc] EPUB3 nav parse failed', error); }
  }
  if (pkg.ncxPath && entries.has(pkg.ncxPath)) {
    try {
      const rows = dedupeToc(parseNcxToc(await entries.get(pkg.ncxPath).text(), pkg.ncxPath));
      if (rows.length) return { rows, source: 'EPUB2 NCX' };
    } catch (error) { console.warn('[reader toc] NCX parse failed', error); }
  }
  const htmlToc = [...entries.keys()].find(path => /(?:^|\/)(?:toc|contents?)(?:\.[^.]+)?\.(?:xhtml|html|htm)$/i.test(path))
    || [...entries.keys()].find(path => /(?:^|\/)(?:toc|contents?)\.(?:xhtml|html|htm)$/i.test(path));
  if (htmlToc) {
    try {
      const rows = dedupeToc(parseHtmlToc(await entries.get(htmlToc).text(), htmlToc));
      if (rows.length) return { rows, source: 'HTML contents' };
    } catch (error) { console.warn('[reader toc] HTML contents parse failed', error); }
  }
  return { rows: [], source: 'spine' };
}

function usefulTitleFromHtml(html, path, tocTitle = '') {
  if (cleanLabel(tocTitle)) return cleanLabel(tocTitle);
  const doc = parseHtmlDocument(html);
  if (doc) {
    const selectors = [
      '.tit-capitulo', '.chapter-title', '.chapter_title', '.chapterTitle',
      '[class*="tit-cap"]', '[class*="chapter-title"]', '[class*="chapter_title"]',
      'h1', 'h2', 'h3', 'h4', 'title',
    ];
    for (const selector of selectors) {
      let node = null;
      try { node = doc.querySelector?.(selector); } catch {}
      const value = cleanLabel(node?.textContent || '');
      if (value && value !== '&nbsp;' && !/^untitled$/i.test(value)) {
        // Publishers often split "7" and "Señores de la guerra" into two
        // sibling paragraphs. If this is the title paragraph, prefix the direct
        // number/part marker when it is short and meaningful.
        if (/tit-cap|chapter-title|chapter_title/i.test(selector)) {
          let number = '';
          try { number = cleanLabel(doc.querySelector?.('.num-capitulo,.chapter-number,.chapter_number')?.textContent || ''); } catch {}
          if (number && !value.toLowerCase().startsWith(number.toLowerCase())) return `${number}. ${value}`.replace(/\.\s*\./g, '.');
        }
        return value;
      }
    }
  }
  const file = String(path || '').split('/').pop()?.replace(/\.(?:xhtml|html|htm)$/i, '') || '';
  const cleaned = cleanLabel(file.replace(/_+/g, ' ').replace(/\bText\b/gi, ' '));
  return cleaned || 'Раздел';
}

function decodeEntityEncodedHtml(sourceHtml) {
  let out = String(sourceHtml || '');
  for (let pass = 0; pass < 3 && /&(?:amp;)*lt;\s*\/?\s*[a-z]/i.test(out); pass++) {
    const ta = document.createElement('textarea');
    ta.innerHTML = out;
    out = ta.value;
  }
  return out;
}

function textCharCount(items) {
  return (items || []).filter(item => typeof item === 'string').join('').replace(/\s+/g, '').length;
}

function parseContentItems(html, lang, basePath) {
  let used = String(html || '');
  let items = htmlToMixedItems(used, {
    lang,
    canonicalLang,
    chunkLongParagraph,
    basePath,
  });
  let chars = textCharCount(items);

  if (chars < 12 && /&(?:amp;)*lt;\s*\/?\s*[a-z]/i.test(used)) {
    const decoded = decodeEntityEncodedHtml(used);
    if (decoded !== used) {
      const decodedItems = htmlToMixedItems(decoded, { lang, canonicalLang, chunkLongParagraph, basePath });
      if (textCharCount(decodedItems) > chars) { items = decodedItems; chars = textCharCount(items); used = decoded; }
    }
  }

  // Fallback for old/odd XHTML consisting mostly of spans or table text.
  const plain = cleanEpubText(htmlToPlainText(used));
  const plainChars = plain.replace(/\s+/g, '').length;
  if (plainChars > Math.max(20, chars * 1.12)) {
    const images = items.filter(item => item && typeof item === 'object' && item.type === 'image');
    const chunks = plain.split(/\n\s*\n+|\n+/)
      .map(part => cleanLabel(part))
      .filter(Boolean)
      .flatMap(part => chunkLongParagraph(part, ['zh', 'ja'].includes(canonicalLang(lang)) ? 150 : 380));
    items = [...images, ...chunks];
  }
  return items;
}

function isHtmlManifestItem(item) {
  return !!item && (/xhtml|html/i.test(item.mediaType || '') || /\.(?:xhtml|html|htm)$/i.test(item.path || ''));
}

function isCoverPath(path, item = null) {
  const props = ` ${item?.properties || ''} `;
  if (props.includes(' cover-image ')) return true;
  return /(?:^|\/)(?:cover|coverpage|frontcover)(?:\.|_|-|\/|$)/i.test(String(path || ''));
}

function chapterFingerprint(chapter) {
  const text = (chapter?.paragraphs || [])
    .filter(item => typeof item === 'string')
    .slice(0, 4)
    .join(' ')
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[^a-zà-öø-ÿ0-9一-鿿ぁ-ヿ ]/gi, '')
    .trim();
  return text.slice(0, 220);
}

function titleFingerprint(title) {
  return cleanLabel(title).toLowerCase().normalize('NFC').replace(/[^a-zà-öø-ÿ0-9一-鿿ぁ-ヿ]+/gi, ' ').trim();
}

async function parseEpubUpgrade(file) {
  const startedAt = performance.now?.() || Date.now();
  const entries = await readZipEntries(await file.arrayBuffer());
  const pkg = await locatePackage(entries);
  const tocInfo = await extractPackageToc(entries, pkg);
  const tocRows = tocInfo.rows;
  const tocTitleByPath = new Map();
  for (const row of tocRows) if (row.path && !tocTitleByPath.has(row.path)) tocTitleByPath.set(row.path, row.title);

  const manifestByPath = new Map([...pkg.manifest.values()].map(item => [item.path, item]));
  const candidates = [];
  const seen = new Set();
  const pushPath = path => {
    path = safeDecodePath(path);
    const item = manifestByPath.get(path);
    if (!path || seen.has(path) || !entries.has(path) || !isHtmlManifestItem(item || { path })) return;
    if (isCoverPath(path, item) && !tocTitleByPath.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };

  // The package spine is the reading order. TOC-only targets not present in a
  // broken spine are appended in TOC order rather than silently disappearing.
  pkg.spine.forEach(pushPath);
  tocRows.forEach(row => pushPath(row.path));
  [...pkg.manifest.values()].filter(isHtmlManifestItem).forEach(item => {
    if (tocTitleByPath.has(item.path)) pushPath(item.path);
  });

  const chapters = [];
  for (const path of candidates) {
    const html = await entries.get(path).text();
    const basePath = path.split('/').slice(0, -1).join('/');
    const items = parseContentItems(html, pkg.language, basePath);
    const tocTitle = tocTitleByPath.get(path) || '';
    const title = usefulTitleFromHtml(html, path, tocTitle);
    const hasImage = items.some(item => item && typeof item === 'object' && item.type === 'image');
    const chars = textCharCount(items);
    const isTocTarget = tocTitleByPath.has(path);
    if (!items.length && isTocTarget) items.push(title);
    if (!items.length) continue;
    // A real TOC target is authoritative even when it is just "Fotos" or a
    // full-page map. Non-TOC boilerplate still needs actual prose/image content.
    if (!isTocTarget && !hasImage && chars < 20) continue;
    chapters.push({
      id: `epub_${chapters.length}`,
      sourcePath: path,
      title,
      paragraphs: items,
    });
  }

  const chapterIndexByPath = new Map(chapters.map((chapter, index) => [chapter.sourcePath, index]));
  const toc = tocRows.map((row, index) => ({
    title: row.title,
    depth: row.depth,
    sourcePath: row.path,
    fragment: row.fragment || '',
    chapterIndex: chapterIndexByPath.has(row.path) ? chapterIndexByPath.get(row.path) : null,
    order: index,
    hasChildren: Number(tocRows[index + 1]?.depth || 0) > Number(row.depth || 0),
  }));

  // If the book has no formal TOC at all, make a faithful flat TOC from the
  // spine titles rather than falling back to Russian "Глава N" labels.
  if (!toc.length) {
    chapters.forEach((chapter, index) => toc.push({
      title: chapter.title,
      depth: 0,
      sourcePath: chapter.sourcePath,
      fragment: '',
      chapterIndex: index,
      order: index,
      hasChildren: false,
    }));
  }

  const elapsed = Math.round((performance.now?.() || Date.now()) - startedAt);
  const mapped = toc.filter(row => Number.isInteger(row.chapterIndex)).length;
  lastDiagnostics = {
    file: file.name,
    tocSource: tocInfo.source,
    tocEntries: toc.length,
    mappedEntries: mapped,
    chapters: chapters.length,
    spine: pkg.spine.length,
    language: pkg.language,
    title: pkg.title,
    identifier: pkg.identifier,
    elapsedMs: elapsed,
  };
  console.info('[reader toc] parsed', lastDiagnostics);
  return { entries, pkg, chapters, toc, diagnostics: lastDiagnostics };
}

function paragraphImageKey(bookId, path) {
  return `${bookId}::${path}`;
}

async function materializeChapterImages(bookId, chapters, entries) {
  const written = new Set();
  const out = [];
  for (const chapter of chapters) {
    const paragraphs = [];
    for (const item of chapter.paragraphs || []) {
      if (!item || typeof item !== 'object' || item.type !== 'image') {
        paragraphs.push(item);
        continue;
      }
      const path = safeDecodePath(item.path || '');
      const key = paragraphImageKey(bookId, path);
      if (path && entries.has(path) && !written.has(path)) {
        written.add(path);
        try {
          const bytes = await entries.get(path).bytes();
          const ext = path.split('.').pop()?.toLowerCase() || '';
          const mime = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
            webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
          }[ext] || 'application/octet-stream';
          await imgStorePut(key, new Blob([bytes], { type: mime }));
        } catch (error) { console.warn('[reader toc] image persist skipped', path, error); }
      }
      paragraphs.push({ type: 'image', key, alt: item.alt || '' });
    }
    out.push({ ...chapter, paragraphs });
  }
  return out;
}

function matchOldChapter(newChapter, oldChapters, usedOldIndexes) {
  const fp = chapterFingerprint(newChapter);
  const titleFp = titleFingerprint(newChapter.title);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < oldChapters.length; i++) {
    if (usedOldIndexes.has(i)) continue;
    const old = oldChapters[i];
    const oldFp = chapterFingerprint(old);
    const oldTitle = titleFingerprint(old.title);
    let score = 0;
    if (fp && oldFp) {
      if (fp === oldFp) score += 100;
      else if (fp.length > 50 && oldFp.length > 50 && (fp.startsWith(oldFp.slice(0, 80)) || oldFp.startsWith(fp.slice(0, 80)))) score += 70;
      else if (fp.slice(0, 50) && oldFp.includes(fp.slice(0, 50))) score += 45;
    }
    if (titleFp && oldTitle && titleFp === oldTitle) score += 35;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return bestScore >= 35 ? best : -1;
}

function bestCurrentChapter(oldBook, newChapters) {
  const oldIndex = Math.max(0, Math.min(Number(oldBook.currentChapter) || 0, Math.max(0, (oldBook.chapters || []).length - 1)));
  const current = oldBook.chapters?.[oldIndex];
  if (!current) return Math.min(oldIndex, Math.max(0, newChapters.length - 1));
  const currentFp = chapterFingerprint(current);
  if (currentFp) {
    const exact = newChapters.findIndex(chapter => chapterFingerprint(chapter) === currentFp);
    if (exact >= 0) return exact;
    const prefix = currentFp.slice(0, 70);
    if (prefix.length > 30) {
      const close = newChapters.findIndex(chapter => chapterFingerprint(chapter).includes(prefix));
      if (close >= 0) return close;
    }
  }
  const title = titleFingerprint(current.title);
  if (title && !/^глава\s+\d+$/i.test(title)) {
    const byTitle = newChapters.findIndex(chapter => titleFingerprint(chapter.title) === title);
    if (byTitle >= 0) return byTitle;
  }
  return Math.min(oldIndex, Math.max(0, newChapters.length - 1));
}

async function findBookForUpgrade(app, hint) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = app.readerCurrentBook?.();
    if (current && (!hint.title || titleFingerprint(current.title) === titleFingerprint(hint.title))) return current;
    const books = app.loadReaderBooks?.() || [];
    const matches = books.filter(book => {
      if (book.source !== 'epub') return false;
      if (hint.title && titleFingerprint(book.title) !== titleFingerprint(hint.title)) return false;
      if (hint.author && titleFingerprint(book.author) && titleFingerprint(book.author) !== titleFingerprint(hint.author)) return false;
      return true;
    }).sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    if (matches[0]) return matches[0];
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  return null;
}

async function applyEpubUpgrade(upgrade, hint = {}) {
  if (!upgrade?.chapters?.length) throw new Error('TOC parser не нашёл читаемых разделов');
  const app = await readerAppModule();
  const book = await findBookForUpgrade(app, hint);
  if (!book) throw new Error('Не нашёл только что сохранённый EPUB в библиотеке');

  const oldChapters = Array.isArray(book.chapters) ? book.chapters : [];
  const oldCurrentParagraph = Number(book.currentParagraph) || 0;
  const nextCurrentChapter = bestCurrentChapter(book, upgrade.chapters);
  const usedOld = new Set();
  const chapterIdBySource = new Map();
  const chaptersWithStableIds = upgrade.chapters.map((chapter, index) => {
    const oldIndex = matchOldChapter(chapter, oldChapters, usedOld);
    let id = `epub_${index}_${Math.abs(hashString(chapter.sourcePath)).toString(36)}`;
    if (oldIndex >= 0) {
      usedOld.add(oldIndex);
      id = oldChapters[oldIndex]?.id || id;
    }
    chapterIdBySource.set(chapter.sourcePath, id);
    return { ...chapter, id };
  });
  const finalChapters = await materializeChapterImages(book.id, chaptersWithStableIds, upgrade.entries);

  book.chapters = finalChapters;
  book.toc = upgrade.toc.map(row => ({ ...row }));
  book.epubTocSource = upgrade.diagnostics?.tocSource || 'EPUB';
  book.epubSourceIdentifier = upgrade.pkg?.identifier || book.epubSourceIdentifier || '';
  book._v7742EpubToc = true;
  book.currentChapter = nextCurrentChapter;
  book.currentParagraph = Math.min(oldCurrentParagraph, Math.max(0, (finalChapters[nextCurrentChapter]?.paragraphs || []).length - 1));
  book.updatedAt = new Date().toISOString();
  app.saveReaderBooks?.();

  const mapped = book.toc.filter(row => Number.isInteger(row.chapterIndex)).length;
  try { await window.readerOpenBook?.(book.id); } catch {}
  window.showToast?.(`📚 Оглавление восстановлено: ${book.toc.length} пунктов · ${mapped} переходов`);
  console.info('[reader toc] applied', { book: book.title, chapters: finalChapters.length, toc: book.toc.length, mapped });
  return book;
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function healGenericChapterTitles(book) {
  if (!book?.chapters?.length) return false;
  let changed = false;
  for (let i = 0; i < book.chapters.length; i++) {
    const chapter = book.chapters[i];
    const current = cleanLabel(chapter.title);
    if (current && !/^глава\s+\d+$/i.test(current) && !/^chapter\s+\d+$/i.test(current)) continue;
    const texts = (chapter.paragraphs || []).filter(item => typeof item === 'string').map(cleanLabel).filter(Boolean).slice(0, 4);
    if (!texts.length) continue;
    let title = '';
    if (texts[0].length <= 30 && texts[1]?.length <= 90) {
      if (/^(?:\d+|[IVXLCDM]+|(?:PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA)\s+PARTE)$/i.test(texts[0])) {
        title = `${texts[0]}${/^\d+$/.test(texts[0]) ? '.' : '.'} ${texts[1]}`;
      }
    }
    if (!title && texts[0].length <= 100) title = texts[0];
    if (title && title !== current) { chapter.title = title; changed = true; }
  }
  return changed;
}

function injectTocStyles() {
  if (document.getElementById('reader-toc-v7742-style')) return;
  const style = document.createElement('style');
  style.id = 'reader-toc-v7742-style';
  style.textContent = `
    #reader-toc-header{display:flex;align-items:center;justify-content:space-between;gap:10px}
    #reader-toc-header .rd-toc-meta{font-family:'IBM Plex Sans',sans-serif;font-size:.68rem;letter-spacing:0;text-transform:none;font-weight:400;color:var(--text-muted)}
    .rd-toc-item[data-depth="1"]{background:color-mix(in srgb,var(--surface2) 35%,transparent)}
    .rd-toc-item[data-depth="2"]{background:color-mix(in srgb,var(--surface2) 55%,transparent)}
    .rd-toc-item.toc-parent .rd-toc-title{font-weight:700;letter-spacing:.01em}
    .rd-toc-item.toc-parent:not(.current){margin-top:5px}
    .rd-toc-item.toc-unmapped{opacity:.58;cursor:default}
    .rd-toc-indent{display:inline-block;flex:0 0 auto;width:var(--toc-indent,0px)}
    .rd-toc-item .rd-toc-title{word-break:break-word}
    .rd-toc-item .rd-toc-count:empty{display:none}
  `;
  document.head.appendChild(style);
}

async function openUpgradedToc() {
  const app = await readerAppModule();
  const book = app.readerCurrentBook?.();
  if (!book?.chapters?.length) { window.showToast?.('Нет оглавления'); return; }
  if (!book.toc?.length && healGenericChapterTitles(book)) {
    book.updatedAt = new Date().toISOString();
    app.saveReaderBooks?.();
  }
  injectTocStyles();
  const list = document.getElementById('reader-toc-list');
  const back = document.getElementById('reader-toc-back');
  const sheet = document.getElementById('reader-toc-sheet');
  const header = document.getElementById('reader-toc-header');
  if (!list || !back || !sheet) return;

  const curCh = Number(book.currentChapter) || 0;
  const rows = Array.isArray(book.toc) && book.toc.length
    ? book.toc
    : book.chapters.map((chapter, index) => ({
        title: chapter.title || `Глава ${index + 1}`,
        depth: 0,
        chapterIndex: index,
        order: index,
        hasChildren: false,
      }));
  const mappedCount = rows.filter(row => Number.isInteger(Number(row.chapterIndex))).length;
  if (header) header.innerHTML = `<span>Оглавление</span><span class="rd-toc-meta">${rows.length} пунктов${book.epubTocSource ? ` · ${escapeHtml(book.epubTocSource)}` : ''}</span>`;

  list.innerHTML = rows.map((row, tocIndex) => {
    const chapterIndex = row.chapterIndex === null || row.chapterIndex === undefined ? null : Number(row.chapterIndex);
    const mapped = Number.isInteger(chapterIndex) && chapterIndex >= 0 && chapterIndex < book.chapters.length;
    const current = mapped && chapterIndex === curCh;
    const done = mapped && chapterIndex < curCh;
    const depth = Math.max(0, Math.min(6, Number(row.depth) || 0));
    const hasChildren = row.hasChildren === true || Number(rows[tocIndex + 1]?.depth || 0) > depth;
    const chapter = mapped ? book.chapters[chapterIndex] : null;
    const pCount = chapter ? (chapter.paragraphs || []).filter(item => typeof item === 'string').length : 0;
    const icon = done ? '✓' : current ? '▶' : hasChildren ? '▸' : '•';
    const cls = `rd-toc-item${current ? ' current' : ''}${done ? ' done' : ''}${hasChildren ? ' toc-parent' : ''}${mapped ? '' : ' toc-unmapped'}`;
    const inside = `<span class="rd-toc-num">${icon}</span><span class="rd-toc-indent" style="--toc-indent:${depth * 18}px"></span><span class="rd-toc-title">${escapeHtml(row.title || chapter?.title || `Глава ${(chapterIndex ?? tocIndex) + 1}`)}</span><span class="rd-toc-count">${pCount ? `${pCount} абз.` : ''}</span>`;
    if (!mapped) return `<div class="${cls}" data-depth="${depth}">${inside}</div>`;
    return `<button class="${cls}" data-depth="${depth}" aria-current="${current ? 'true' : 'false'}" onclick="readerGoToChapter(${chapterIndex});readerCloseToc()">${inside}</button>`;
  }).join('');

  back.classList.add('show');
  sheet.classList.add('show');
  setTimeout(() => {
    const current = list.querySelector('.current');
    current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, 100);
  console.info('[reader toc] open', { rows: rows.length, mapped: mappedCount, currentChapter: curCh });
}

function appendImportStatus(message) {
  const status = document.getElementById('reader-import-status');
  if (!status || !message) return;
  const base = cleanLabel(status.textContent || '');
  if (!base) return;
  status.textContent = `${base} · ${message}`;
}

function install() {
  if (installed) return;
  const originalImport = window.readerImportFromFile;
  const originalSave = window.saveReaderImport;
  const originalOpenToc = window.readerOpenToc;
  if (typeof originalImport !== 'function' || typeof originalSave !== 'function' || typeof originalOpenToc !== 'function') {
    installAttempts += 1;
    if (installAttempts < INSTALL_RETRY_LIMIT) setTimeout(install, INSTALL_RETRY_MS);
    return;
  }

  installed = true;
  injectTocStyles();

  window.readerImportFromFile = async function readerImportFromFileWithToc(event) {
    const file = event?.target?.files?.[0] || null;
    pendingEpubUpgrade = null;
    const result = await originalImport.call(this, event);
    if (!file || !/\.epub$/i.test(file.name || '')) return result;

    const token = Symbol('epubTocImport');
    const record = { token, fileName: file.name, promise: null };
    pendingEpubUpgrade = record;
    record.promise = parseEpubUpgrade(file)
      .then(upgrade => {
        if (pendingEpubUpgrade?.token === token) {
          appendImportStatus(`TOC: ${upgrade.toc.length} · главы: ${upgrade.chapters.length} · ${upgrade.diagnostics.tocSource}`);
        }
        return upgrade;
      })
      .catch(error => {
        console.warn('[reader toc] upgrade parse failed; legacy EPUB import stays usable', error);
        if (pendingEpubUpgrade?.token === token) appendImportStatus(`TOC-парсер: ${error?.message || error}`);
        throw error;
      });
    return result;
  };

  window.saveReaderImport = function saveReaderImportWithToc(...args) {
    const pending = pendingEpubUpgrade;
    const hint = {
      title: document.getElementById('reader-import-title')?.value?.trim() || '',
      author: document.getElementById('reader-import-author')?.value?.trim() || '',
    };
    const result = originalSave.apply(this, args);
    if (pending?.promise) {
      pendingEpubUpgrade = null;
      pending.promise
        .then(upgrade => applyEpubUpgrade(upgrade, hint))
        .catch(error => {
          console.warn('[reader toc] post-save upgrade failed', error);
          window.showToast?.(`⚠️ Книга сохранена, но оглавление не обновилось: ${error?.message || error}`);
        });
    }
    return result;
  };

  window.readerOpenToc = openUpgradedToc;
  window.readerTocDiagnostics = () => lastDiagnostics;
  console.info('[reader toc] 77.42 upgrade installed');
}

setTimeout(install, 0);
