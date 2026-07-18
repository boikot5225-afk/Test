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

function preprocessFootnotes(html, sourcePath, knownTargets) {
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
    footnotes[key] = {
      id,
      sourcePath,
      items: noteItems,
    };
    node.remove();
  }

  const references = [];
  for (const link of [...doc.querySelectorAll('a[href*="#"]')]) {
    const target = resolveFootnoteTarget(sourcePath, link.getAttribute('href') || '');
    if (!target || !knownTargets.has(target)) continue;
    const label = cleanText(link.textContent || '') || String(references.length + 1);
    const index = references.length;
    references.push({ label, target });
    link.replaceWith(doc.createTextNode(`${FOOTNOTE_TOKEN_START}${index}${FOOTNOTE_TOKEN_END}`));
  }

  return {
    html: doc.documentElement?.outerHTML || String(html || ''),
    footnotes,
    references,
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
      if (!found) {
        runs.push(run);
      } else {
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

async function resolveImageItems(items, entries, bookId, imageBlobs, missingImages) {
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
    if (!imageBlobs.has(key)) {
      const bytes = await entries.get(path).bytes();
      imageBlobs.set(key, new Blob([bytes], { type: mimeForPath(path) }));
    }
    resolved.push({
      ...item,
      key,
      path,
    });
  }
  return resolved;
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

  const htmlDocuments = new Map();
  const knownFootnoteTargets = new Set();
  for (const path of htmlPaths) {
    try {
      const html = await entries.get(path).text();
      htmlDocuments.set(path, html);
      for (const target of collectFootnoteTargets(html, path)) knownFootnoteTargets.add(target);
    } catch {}
  }

  const chapters = [];
  const footnotes = {};
  const imageBlobs = new Map();
  const missingImages = [];
  const diagnostics = [];
  let totalTextChars = 0;

  for (let index = 0; index < htmlPaths.length; index += 1) {
    const path = htmlPaths[index];
    onProgress?.(`Разбираю главу ${index + 1}/${htmlPaths.length}...`);
    try {
      const html = htmlDocuments.get(path) ?? await entries.get(path).text();
      const basePath = path.split('/').slice(0, -1).join('/');
      const prepared = preprocessFootnotes(html, path, knownFootnoteTargets);
      const parsedBeforeRefs = htmlToSemanticItems(prepared.html, { basePath })
        .flatMap(item => splitSemanticItemLines(item))
        .flatMap(item => splitSemanticItemChunks(item));
      const parsed = restoreFootnoteRuns(parsedBeforeRefs, prepared.references);
      const items = await resolveImageItems(parsed, entries, bookId, imageBlobs, missingImages);

      for (const [key, note] of Object.entries(prepared.footnotes)) {
        footnotes[key] = {
          ...note,
          items: await resolveImageItems(note.items || [], entries, bookId, imageBlobs, missingImages),
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

  onProgress?.(`Сохраняю ${imageBlobs.size} изображений...`);
  for (const [key, blob] of imageBlobs) await imgStorePut(key, blob);

  const coverPath = cleanPath(packageInfo.coverPath);
  const coverKey = coverPath && entries.has(coverPath) ? `${bookId}::${coverPath}` : '';
  if (coverKey && !imageBlobs.has(coverKey)) {
    const bytes = await entries.get(coverPath).bytes();
    await imgStorePut(coverKey, new Blob([bytes], { type: mimeForPath(coverPath) }));
  }

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
    diagnostics: {
      files: entries.size,
      htmlFiles: htmlPaths.length,
      chapters: chapters.length,
      images: imageBlobs.size + (coverKey && !imageBlobs.has(coverKey) ? 1 : 0),
      footnotes: Object.keys(footnotes).length,
      missingImages: [...new Set(missingImages.filter(Boolean))],
      textChars: totalTextChars,
      details: diagnostics,
    },
  };
}
