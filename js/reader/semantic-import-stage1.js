import {
  readFileAsArrayBuffer,
  readZipEntries,
} from './epub.js?v=3';
import {
  extractEpubPackageInfo,
  htmlToSemanticItems,
  resolveEpubPath,
  semanticItemText,
  semanticItemsDiagnostics,
} from './epub-stage1-real.js?v=2';
import {
  splitSemanticItemChunks,
  splitSemanticItemLines,
} from './semantic-content.js?v=4';
import { imgStorePut } from './image-store.js?v=1';

const FOOTNOTE_TOKEN_START = '\uE000RFN';
const FOOTNOTE_TOKEN_END = '\uE001';
const FOOTNOTE_TOKEN_RE = /\uE000RFN(\d+)\uE001/g;
const NOTE_NAME_RE = /(?:^|[-_\s])(footnote|endnote|fn|nota|note[-_ ]?(?:text|body|item))(?=$|[-_\s])/i;
const IMPLICIT_NOTES_PATH_RE = /(?:^|[/_.\-\s])(notas?|notes?|footnotes?|endnotes?)(?=$|[/_.\-\s])/i;
const IMPLICIT_CHAPTER_HEADING_RE = /^(?:cap[ií]tulo|chapter|chapitre|kapitel)\s+(\d{1,4})\b/i;
const IMPLICIT_NOTE_ENTRY_RE = /^(\d{1,4})\s*[.)]\s+\S/;

const BLOCK_STYLE_TOKEN_START = '\uE002RBS';
const BLOCK_STYLE_TOKEN_END = '\uE003';
const BLOCK_STYLE_TOKEN_RE = /\uE002RBS(\d+)\uE003/g;
const BLOCK_STYLE_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,blockquote,li,figcaption,dd,dt,td,th';
const FOOTNOTE_PLACEHOLDER_BASE = 0xE100;
const FOOTNOTE_PLACEHOLDER_LIMIT = 0xF8FF;

function cssProperty(style, name) {
  return String(style || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim() || '';
}

function safeCssLength(value, { allowNegative = false } = {}) {
  const match = String(value || '').trim().match(/^(-?\d+(?:\.\d+)?)(px|pt|em|rem|%)$/i);
  if (!match) return '';
  let number = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(number) || (!allowNegative && number < 0)) return '';
  const max = { px: 120, pt: 90, em: 8, rem: 8, '%': 40 }[unit] || 0;
  if (!max) return '';
  number = Math.max(allowNegative ? -max : 0, Math.min(max, number));
  const normalized = Number(number.toFixed(4));
  return `${normalized}${unit}`;
}

function safeBlockStyle(node) {
  const raw = String(node?.getAttribute?.('style') || '');
  if (!raw) return null;
  const alignRaw = cssProperty(raw, 'text-align').toLowerCase();
  const align = /^(?:left|right|center|start|end)$/.test(alignRaw) ? alignRaw : '';
  const textIndent = safeCssLength(cssProperty(raw, 'text-indent'), { allowNegative: true });
  const marginTop = safeCssLength(cssProperty(raw, 'margin-top'));
  const marginBottom = safeCssLength(cssProperty(raw, 'margin-bottom'));
  const out = {};
  if (align) out.textAlign = align;
  if (textIndent) out.textIndent = textIndent;
  if (marginTop) out.marginTop = marginTop;
  if (marginBottom) out.marginBottom = marginBottom;
  return Object.keys(out).length ? out : null;
}

function preprocessBlockStyles(doc) {
  const styles = [];
  for (const node of [...doc.querySelectorAll(BLOCK_STYLE_SELECTOR)]) {
    const blockStyle = safeBlockStyle(node);
    if (!blockStyle) continue;
    const index = styles.length;
    styles.push(blockStyle);
    node.insertBefore(doc.createTextNode(`${BLOCK_STYLE_TOKEN_START}${index}${BLOCK_STYLE_TOKEN_END}`), node.firstChild);
  }
  return styles;
}

function restoreBlockStyles(items, blockStyles) {
  return (items || []).map(item => {
    if (!Array.isArray(item?.runs)) return item;
    let styleIndex = -1;
    const runs = item.runs.map(run => {
      const text = String(run?.text || '');
      BLOCK_STYLE_TOKEN_RE.lastIndex = 0;
      const match = BLOCK_STYLE_TOKEN_RE.exec(text);
      if (match && styleIndex < 0) styleIndex = Number(match[1]);
      BLOCK_STYLE_TOKEN_RE.lastIndex = 0;
      return { ...run, text: text.replace(BLOCK_STYLE_TOKEN_RE, '') };
    }).filter(run => String(run?.text || '') || run?.footnote?.target);
    return styleIndex >= 0 && blockStyles?.[styleIndex]
      ? { ...item, runs, blockStyle: blockStyles[styleIndex] }
      : { ...item, runs };
  }).filter(item => item?.type === 'image' || semanticItemText(item).trim() || item?.runs?.some(run => run?.footnote?.target));
}

export function splitSemanticItemChunksPreservingFootnotes(item, options = {}) {
  if (!Array.isArray(item?.runs) || !item.runs.some(run => run?.footnote?.target)) {
    const plainParts = splitSemanticItemChunks(item, options);
    return plainParts.map((part, index) => plainParts.length > 1
      ? { ...part, semanticChunkIndex: index, semanticChunkCount: plainParts.length }
      : part);
  }

  const footnoteRuns = [];
  const encodedRuns = item.runs.map(run => {
    if (!run?.footnote?.target) return run;
    const index = footnoteRuns.length;
    const codePoint = FOOTNOTE_PLACEHOLDER_BASE + index;
    if (codePoint > FOOTNOTE_PLACEHOLDER_LIMIT) return run;
    footnoteRuns.push({ ...run, text: '' });
    const { footnote, ...rest } = run;
    return { ...rest, text: String.fromCharCode(codePoint) };
  });

  if (!footnoteRuns.length) return splitSemanticItemChunks(item, options);
  const encodedParts = splitSemanticItemChunks({ ...item, runs: encodedRuns }, options);
  return encodedParts.map((part, partIndex) => {
    const runs = [];
    for (const run of part.runs || []) {
      let buffer = '';
      for (const char of String(run?.text || '')) {
        const index = char.charCodeAt(0) - FOOTNOTE_PLACEHOLDER_BASE;
        if (index >= 0 && index < footnoteRuns.length) {
          if (buffer) runs.push({ ...run, text: buffer });
          buffer = '';
          runs.push(footnoteRuns[index]);
        } else {
          buffer += char;
        }
      }
      if (buffer) runs.push({ ...run, text: buffer });
    }
    const cleanRuns = runs.filter(run => String(run?.text || '') || run?.footnote?.target);
    return encodedParts.length > 1
      ? { ...part, runs: cleanRuns, semanticChunkIndex: partIndex, semanticChunkCount: encodedParts.length }
      : { ...part, runs: cleanRuns };
  });
}

function cleanPath(value) {
  return String(value || '').replace(/^\/+/, '').replace(/\\/g, '/');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mimeForPath(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
  }[ext] || 'application/octet-stream';
}

function titleFromItems(items, fallback) {
  const heading = (items || []).find(item => item?.type === 'heading' && semanticItemText(item).trim());
  return semanticItemText(heading).replace(/\s+/g, ' ').trim().slice(0, 140) || fallback;
}

function uniqueExistingPaths(paths, entries) {
  const seen = new Set();
  return (paths || [])
    .map(cleanPath)
    .filter(path => path && entries.has(path) && !seen.has(path) && seen.add(path));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function implicitChapterKeyFromPath(sourcePath) {
  const name = cleanPath(sourcePath).split('/').pop()?.replace(/\.[^.]+$/, '') || '';
  const match = name.match(/^0*(\d{1,4})(?=__|[-_.\s]|$)/);
  return match ? String(Number(match[1])) : '';
}

function implicitChapterKey(doc, sourcePath) {
  const fromPath = implicitChapterKeyFromPath(sourcePath);
  if (fromPath) return fromPath;
  const candidates = [...doc.querySelectorAll('h1,h2,h3,h4,p')].slice(0, 12);
  for (const node of candidates) {
    const match = cleanText(node.textContent || '').match(IMPLICIT_CHAPTER_HEADING_RE);
    if (match) return String(Number(match[1]));
  }
  return '';
}

function stripImplicitNoteLabel(items, label) {
  const prefix = new RegExp(`^\\s*${escapeRegExp(label)}\\s*[.)]\\s*`);
  let removed = false;
  return (items || []).map(item => {
    if (removed || !Array.isArray(item?.runs)) return item;
    const runs = item.runs.map(run => {
      if (removed || !String(run?.text || '')) return run;
      const text = String(run.text || '');
      if (!prefix.test(text)) return run;
      removed = true;
      return { ...run, text: text.replace(prefix, '') };
    }).filter(run => String(run?.text || '') || run?.footnote);
    return { ...item, runs };
  }).filter(item => semanticItemText(item).trim() || item?.type === 'image');
}

function collectImplicitEndnotes(htmlDocuments) {
  const notesByChapter = new Map();
  const documentPaths = new Set();

  for (const [sourcePath, html] of htmlDocuments) {
    if (!IMPLICIT_NOTES_PATH_RE.test(cleanPath(sourcePath))) continue;
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const basePath = sourcePath.split('/').slice(0, -1).join('/');
    const found = [];
    let chapterKey = '';

    for (const paragraph of [...doc.querySelectorAll('p')]) {
      const text = cleanText(paragraph.textContent || '');
      const heading = text.match(IMPLICIT_CHAPTER_HEADING_RE);
      if (heading) {
        chapterKey = String(Number(heading[1]));
        continue;
      }
      const entry = text.match(IMPLICIT_NOTE_ENTRY_RE);
      if (!chapterKey || !entry) continue;
      const label = String(Number(entry[1]));
      const rawItems = htmlToSemanticItems(`<html><body>${paragraph.outerHTML}</body></html>`, { basePath })
        .flatMap(item => splitSemanticItemLines(item));
      const items = stripImplicitNoteLabel(rawItems, label);
      if (!items.some(item => semanticItemText(item).trim())) continue;
      found.push({ chapterKey, label, items });
    }

    if (found.length < 2) continue;
    documentPaths.add(sourcePath);
    for (const note of found) {
      const chapterNotes = notesByChapter.get(note.chapterKey) || new Map();
      const target = `${sourcePath}#reader-implicit-c${note.chapterKey}-n${note.label}`;
      chapterNotes.set(note.label, {
        id: `reader-implicit-c${note.chapterKey}-n${note.label}`,
        sourcePath,
        implicit: true,
        items: note.items,
        target,
      });
      notesByChapter.set(note.chapterKey, chapterNotes);
    }
  }

  return { notesByChapter, documentPaths };
}

function epubType(node) {
  return cleanText(node?.getAttribute?.('epub:type') || node?.getAttribute?.('type') || '').toLowerCase();
}

function roleText(node) {
  return cleanText(node?.getAttribute?.('role') || '').toLowerCase();
}

function classAndId(node) {
  return `${node?.getAttribute?.('class') || ''} ${node?.getAttribute?.('id') || ''}`.trim();
}

function hasNoteAncestor(node) {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    const type = epubType(parent);
    const role = roleText(parent);
    const name = classAndId(parent);
    if (/\b(?:footnotes|endnotes|rearnotes)\b/i.test(type) || /doc-(?:footnotes|endnotes)/i.test(role) || NOTE_NAME_RE.test(name)) return true;
  }
  return false;
}

function isFootnoteNode(node) {
  const id = cleanText(node?.getAttribute?.('id') || '');
  if (!id) return false;
  const type = epubType(node);
  const role = roleText(node);
  const name = classAndId(node);
  if (/\b(?:footnote|endnote|rearnote)\b/i.test(type)) return true;
  if (/doc-(?:footnote|endnote)/i.test(role)) return true;
  if (NOTE_NAME_RE.test(name)) {
    const tag = node.tagName?.toLowerCase();
    if (!['section', 'ol', 'ul'].includes(tag) || !node.querySelector?.('[id]')) return true;
  }
  return hasNoteAncestor(node) && ['li', 'p', 'div', 'aside', 'dd'].includes(node.tagName?.toLowerCase());
}

function noteNodes(doc) {
  return [...doc.querySelectorAll('[id]')]
    .filter(isFootnoteNode)
    .sort((a, b) => {
      const depth = node => { let count = 0; for (let p = node; p; p = p.parentElement) count += 1; return count; };
      return depth(b) - depth(a);
    });
}

function resolveFootnoteTarget(sourcePath, href) {
  const raw = String(href || '').trim();
  if (!raw || /^(?:https?:|mailto:|tel:|javascript:)/i.test(raw) || !raw.includes('#')) return '';
  const hashIndex = raw.indexOf('#');
  const pathPart = raw.slice(0, hashIndex).split('?')[0];
  let fragment = raw.slice(hashIndex + 1);
  try { fragment = decodeURIComponent(fragment); } catch {}
  fragment = fragment.trim();
  if (!fragment) return '';
  const basePath = sourcePath.split('/').slice(0, -1).join('/');
  const resolvedPath = pathPart ? resolveEpubPath(basePath, pathPart) : sourcePath;
  return `${cleanPath(resolvedPath)}#${fragment}`;
}

function collectFootnoteTargets(html, sourcePath) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const targets = [];
  for (const node of noteNodes(doc)) {
    const id = cleanText(node.getAttribute('id') || '');
    if (id) targets.push(`${sourcePath}#${id}`);
  }
  return targets;
}

function removeBacklinks(node) {
  for (const link of [...node.querySelectorAll('a[href]')]) {
    const type = epubType(link);
    const role = roleText(link);
    const text = cleanText(link.textContent || '');
    if (/\bbacklink\b/i.test(type) || /doc-backlink/i.test(role) || /^[↩↵↑←]+$/.test(text)) link.remove();
  }
}

function preprocessFootnotes(html, sourcePath, knownTargets, implicitEndnotes = null) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const basePath = sourcePath.split('/').slice(0, -1).join('/');
  const footnotes = {};

  for (const node of noteNodes(doc)) {
    if (!node.isConnected) continue;
    const id = cleanText(node.getAttribute('id') || '');
    if (!id) continue;
    const key = `${sourcePath}#${id}`;
    const clone = node.cloneNode(true);
    removeBacklinks(clone);
    const noteItems = htmlToSemanticItems(`<html><body>${clone.innerHTML}</body></html>`, { basePath })
      .flatMap(item => splitSemanticItemLines(item));
    footnotes[key] = { id, sourcePath, items: noteItems };
    node.remove();
  }

  const references = [];
  const chapterKey = implicitChapterKey(doc, sourcePath);
  const implicitChapterNotes = chapterKey ? implicitEndnotes?.notesByChapter?.get(chapterKey) : null;
  if (implicitChapterNotes?.size) {
    for (const marker of [...doc.querySelectorAll('sup')]) {
      if (marker.closest?.('a[href]')) continue;
      const rawLabel = cleanText(marker.textContent || '');
      if (!/^\d{1,4}$/.test(rawLabel)) continue;
      const label = String(Number(rawLabel));
      const note = implicitChapterNotes.get(label);
      if (!note?.target) continue;
      const index = references.length;
      references.push({ label: rawLabel, target: note.target, implicit: true });
      footnotes[note.target] = {
        id: note.id,
        sourcePath: note.sourcePath,
        implicit: true,
        items: note.items,
      };
      marker.replaceWith(doc.createTextNode(`${FOOTNOTE_TOKEN_START}${index}${FOOTNOTE_TOKEN_END}`));
    }
  }

  for (const link of [...doc.querySelectorAll('a[href*="#"]')]) {
    const target = resolveFootnoteTarget(sourcePath, link.getAttribute('href') || '');
    if (!target || !knownTargets.has(target)) continue;
    const label = cleanText(link.textContent || '') || String(references.length + 1);
    const index = references.length;
    references.push({ label, target });
    link.replaceWith(doc.createTextNode(`${FOOTNOTE_TOKEN_START}${index}${FOOTNOTE_TOKEN_END}`));
  }

  const blockStyles = preprocessBlockStyles(doc);
  return {
    html: doc.documentElement?.outerHTML || String(html || ''),
    footnotes,
    references,
    blockStyles,
  };
}

function restoreFootnoteRuns(items, references) {
  return (items || []).map(item => {
    if (!Array.isArray(item?.runs)) return item;
    const runs = [];
    for (const run of item.runs) {
      const text = String(run?.text || '');
      FOOTNOTE_TOKEN_RE.lastIndex = 0;
      let match;
      let cursor = 0;
      let found = false;
      while ((match = FOOTNOTE_TOKEN_RE.exec(text))) {
        found = true;
        const before = text.slice(cursor, match.index);
        if (before) runs.push({ ...run, text: before });
        const ref = references[Number(match[1])];
        if (ref?.target) {
          runs.push({
            text: '',
            marks: [...(run.marks || [])],
            footnote: { label: ref.label, target: ref.target },
          });
        }
        cursor = match.index + match[0].length;
      }
      if (!found) runs.push(run);
      else {
        const after = text.slice(cursor);
        if (after) runs.push({ ...run, text: after });
      }
    }
    return { ...item, runs };
  });
}

function hasSubstantiveChapterContent(items = []) {
  return items.some(item => item?.type === 'image' || (item?.type !== 'heading' && semanticItemText(item).trim()));
}

// Store an image as soon as it is encountered. The old importer kept every
// decompressed image Blob in a Map until the whole book finished, multiplying
// peak RAM on image-heavy EPUBs.
async function resolveImageItems(items, entries, bookId, savedImageKeys, missingImages) {
  const resolved = [];
  for (const item of items || []) {
    if (item?.type !== 'image') {
      resolved.push(item);
      continue;
    }

    const path = cleanPath(item.path);
    if (!path || !entries.has(path)) {
      missingImages.push(path || item.path || '(пустой путь)');
      resolved.push({ ...item, key: '', missing: true });
      continue;
    }

    const key = `${bookId}::${path}`;
    if (!savedImageKeys.has(key)) {
      const bytes = await entries.get(path).bytes();
      await imgStorePut(key, new Blob([bytes], { type: mimeForPath(path) }));
      savedImageKeys.add(key);
    }
    resolved.push({ ...item, key, path });
  }
  return resolved;
}

function directChildren(node, localName) {
  return [...(node?.children || [])].filter(child => String(child.localName || child.nodeName || '').split(':').pop() === localName);
}

function splitTocHref(basePath, href) {
  const raw = String(href || '').trim();
  const hashIndex = raw.indexOf('#');
  const pathPart = (hashIndex >= 0 ? raw.slice(0, hashIndex) : raw).split('?')[0];
  let fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';
  try { fragment = decodeURIComponent(fragment); } catch {}
  return {
    path: cleanPath(resolveEpubPath(basePath, pathPart)),
    fragment,
  };
}

function normalizeTocRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const title = cleanText(row.title) || 'Раздел';
    const path = cleanPath(row.path);
    const depth = Math.max(0, Number(row.depth) || 0);
    if (!path) continue;
    const key = `${path}#${row.fragment || ''}|${title}|${depth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, path, fragment: row.fragment || '', depth, order: out.length });
  }
  for (let index = 0; index < out.length; index += 1) {
    out[index].hasChildren = Number(out[index + 1]?.depth || 0) > Number(out[index].depth || 0);
  }
  return out;
}

async function parsePackageToc(entries, packageInfo) {
  const manifest = Object.values(packageInfo?.manifest || {});
  const navItem = manifest.find(item => Array.isArray(item?.properties) && item.properties.includes('nav'));
  const ncxItem = manifest.find(item => /application\/x-dtbncx\+xml/i.test(item?.mediaType || '') || /\.ncx$/i.test(item?.href || ''));

  if (navItem?.href && entries.has(navItem.href)) {
    try {
      const html = await entries.get(navItem.href).text();
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const navs = [...doc.querySelectorAll('nav')];
      const nav = navs.find(node => /(^|\s)toc(\s|$)/i.test(node.getAttribute('epub:type') || node.getAttribute('type') || '')
        || /doc-toc/i.test(node.getAttribute('role') || '')) || navs[0];
      const base = navItem.href.split('/').slice(0, -1).join('/');
      const rows = [];
      const walk = (list, depth) => {
        for (const li of [...(list?.children || [])].filter(node => String(node.tagName || '').toLowerCase() === 'li')) {
          const anchor = [...li.children].find(node => /^(a|span)$/i.test(node.tagName || '')) || li.querySelector('a');
          const target = splitTocHref(base, anchor?.tagName?.toLowerCase() === 'a' ? anchor.getAttribute('href') || '' : '');
          if (target.path) rows.push({ title: cleanText(anchor?.textContent || '') || 'Раздел', depth, ...target });
          const nested = [...li.children].find(node => /^(ol|ul)$/i.test(node.tagName || ''));
          if (nested) walk(nested, depth + 1);
        }
      };
      const root = [...(nav?.children || [])].find(node => /^(ol|ul)$/i.test(node.tagName || '')) || nav?.querySelector?.('ol,ul');
      if (root) walk(root, 0);
      const normalized = normalizeTocRows(rows);
      if (normalized.length) return { source: 'EPUB3 nav', rows: normalized };
    } catch (error) {
      console.warn('[semantic epub] nav.xhtml parse failed', error);
    }
  }

  if (ncxItem?.href && entries.has(ncxItem.href)) {
    try {
      const xml = await entries.get(ncxItem.href).text();
      const doc = new DOMParser().parseFromString(String(xml || ''), 'application/xml');
      const navMap = [...doc.getElementsByTagNameNS?.('*', 'navMap') || []][0] || doc.querySelector('navMap');
      const base = ncxItem.href.split('/').slice(0, -1).join('/');
      const rows = [];
      const walkPoint = (point, depth) => {
        const label = [...point.getElementsByTagNameNS?.('*', 'navLabel') || []][0];
        const textNode = label ? [...label.getElementsByTagNameNS?.('*', 'text') || []][0] : null;
        const content = [...point.getElementsByTagNameNS?.('*', 'content') || []][0];
        const target = splitTocHref(base, content?.getAttribute?.('src') || '');
        if (target.path) rows.push({ title: cleanText(textNode?.textContent || '') || 'Раздел', depth, ...target });
        for (const child of directChildren(point, 'navPoint')) walkPoint(child, depth + 1);
      };
      for (const point of directChildren(navMap, 'navPoint')) walkPoint(point, 0);
      const normalized = normalizeTocRows(rows);
      if (normalized.length) return { source: 'EPUB2 NCX', rows: normalized };
    } catch (error) {
      console.warn('[semantic epub] NCX parse failed', error);
    }
  }
  return { source: '', rows: [] };
}

function attachTocToChapters(tocRows, chapters) {
  const pathToChapter = new Map();
  for (let index = 0; index < (chapters || []).length; index += 1) {
    const path = cleanPath(chapters[index]?.sourcePath || '');
    if (path && !pathToChapter.has(path)) pathToChapter.set(path, index);
  }
  const named = new Set();
  return (tocRows || []).map(row => {
    const chapterIndex = pathToChapter.has(cleanPath(row.path)) ? pathToChapter.get(cleanPath(row.path)) : null;
    if (Number.isInteger(chapterIndex) && !named.has(chapterIndex) && chapters[chapterIndex]) {
      chapters[chapterIndex].title = cleanText(row.title) || chapters[chapterIndex].title;
      named.add(chapterIndex);
    }
    return { ...row, chapterIndex };
  });
}

export async function parseSemanticEpubFile(file, {
  bookId,
  onProgress = null,
} = {}) {
  if (!file) throw new Error('EPUB-файл не выбран');
  if (!bookId) throw new Error('Для импорта нужен bookId');

  onProgress?.('Распаковываю EPUB...');
  const entries = await readZipEntries(await readFileAsArrayBuffer(file));

  let opfPath = '';
  try {
    const container = await entries.get('META-INF/container.xml')?.text();
    opfPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1] || '';
  } catch {}
  if (!opfPath) opfPath = [...entries.keys()].find(path => /\.opf$/i.test(path)) || '';
  opfPath = cleanPath(opfPath);
  if (!opfPath || !entries.has(opfPath)) throw new Error('В EPUB не найден OPF-файл');

  const opfText = await entries.get(opfPath).text();
  const packageInfo = extractEpubPackageInfo(opfText, { opfPath });
  const fallbackTitle = String(file.name || 'EPUB').replace(/\.epub$/i, '');
  const packageToc = await parsePackageToc(entries, packageInfo);

  const preferredPaths = uniqueExistingPaths(packageInfo.spinePaths, entries);
  const extraPaths = uniqueExistingPaths(packageInfo.htmlPaths, entries)
    .filter(path => !preferredPaths.includes(path));
  let htmlPaths = [...preferredPaths, ...extraPaths]
    .filter(path => !/(?:^|[/_.-])(nav|toc)(?:[/_.-]|$)/i.test(path));
  if (!htmlPaths.length) {
    htmlPaths = [...entries.keys()]
      .filter(path => /\.(?:xhtml|html|htm|xml)$/i.test(path))
      .filter(path => !/(?:^|[/_.-])(nav|toc)(?:[/_.-]|$)/i.test(path))
      .sort();
  }

  // First pass gathers only note IDs. Keep HTML strings only for standalone
  // notes/endnotes documents; normal chapter HTML is allowed to die immediately.
  const notesDocuments = new Map();
  const knownFootnoteTargets = new Set();
  for (const path of htmlPaths) {
    try {
      const html = await entries.get(path).text();
      for (const target of collectFootnoteTargets(html, path)) knownFootnoteTargets.add(target);
      if (IMPLICIT_NOTES_PATH_RE.test(cleanPath(path))) notesDocuments.set(path, html);
    } catch {}
  }
  const implicitEndnotes = collectImplicitEndnotes(notesDocuments);

  const chapters = [];
  const footnotes = {};
  const savedImageKeys = new Set();
  const missingImages = [];
  const diagnostics = [];
  let totalTextChars = 0;

  for (let index = 0; index < htmlPaths.length; index += 1) {
    const path = htmlPaths[index];
    onProgress?.(`Разбираю главу ${index + 1}/${htmlPaths.length}...`);
    try {
      const html = notesDocuments.get(path) ?? await entries.get(path).text();
      if (implicitEndnotes.documentPaths.has(path)) {
        diagnostics.push({ path, implicitEndnotes: true, skippedAsNotesDocument: true });
        continue;
      }
      const basePath = path.split('/').slice(0, -1).join('/');
      const prepared = preprocessFootnotes(html, path, knownFootnoteTargets, implicitEndnotes);
      const parsedBase = htmlToSemanticItems(prepared.html, { basePath });
      const parsedWithFootnotes = restoreFootnoteRuns(parsedBase, prepared.references);
      const parsedWithStyles = restoreBlockStyles(parsedWithFootnotes, prepared.blockStyles);
      const parsed = parsedWithStyles.flatMap(item => splitSemanticItemChunksPreservingFootnotes(item));
      const items = await resolveImageItems(parsed, entries, bookId, savedImageKeys, missingImages);

      for (const [key, note] of Object.entries(prepared.footnotes)) {
        footnotes[key] = {
          ...note,
          items: await resolveImageItems(note.items || [], entries, bookId, savedImageKeys, missingImages),
        };
      }

      const diag = semanticItemsDiagnostics(items);
      diagnostics.push({ path, footnotes: Object.keys(prepared.footnotes).length, references: prepared.references.length, ...diag });
      if (!diag.hasRenderableContent || (Object.keys(prepared.footnotes).length && !hasSubstantiveChapterContent(items))) continue;

      totalTextChars += diag.textChars || 0;
      chapters.push({
        id: `ch_${chapters.length}`,
        sourcePath: path,
        title: titleFromItems(items, `Глава ${chapters.length + 1}`),
        paragraphs: items,
      });
    } catch (error) {
      diagnostics.push({ path, error: String(error?.message || error) });
    }
  }

  if (!chapters.length) {
    const firstErrors = diagnostics.filter(item => item.error).slice(0, 4).map(item => `${item.path}: ${item.error}`);
    throw new Error(`Не найдено читаемых глав${firstErrors.length ? ': ' + firstErrors.join(' · ') : ''}`);
  }

  const coverPath = cleanPath(packageInfo.coverPath);
  const coverKey = coverPath && entries.has(coverPath) ? `${bookId}::${coverPath}` : '';
  if (coverKey && !savedImageKeys.has(coverKey)) {
    const bytes = await entries.get(coverPath).bytes();
    await imgStorePut(coverKey, new Blob([bytes], { type: mimeForPath(coverPath) }));
    savedImageKeys.add(coverKey);
  }

  const toc = attachTocToChapters(packageToc.rows, chapters);
  onProgress?.('Завершаю импорт...');

  return {
    schemaVersion: 3,
    bookId,
    title: packageInfo.title || fallbackTitle,
    author: packageInfo.author || '',
    lang: packageInfo.language || '',
    coverPath,
    coverKey,
    chapters,
    footnotes,
    toc,
    epubTocSource: packageToc.source,
    _epubTocExact: !!(packageToc.source && toc.length),
    diagnostics: {
      files: entries.size,
      htmlFiles: htmlPaths.length,
      chapters: chapters.length,
      images: savedImageKeys.size,
      footnotes: Object.keys(footnotes).length,
      tocRows: toc.length,
      tocSource: packageToc.source,
      missingImages: [...new Set(missingImages.filter(Boolean))],
      textChars: totalTextChars,
      details: diagnostics,
    },
  };
}
