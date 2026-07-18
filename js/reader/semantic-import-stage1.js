import {
  readFileAsArrayBuffer,
  readZipEntries,
} from './epub.js?v=3';
import {
  extractEpubPackageInfo,
  htmlToSemanticItems,
  semanticItemText,
  semanticItemsDiagnostics,
} from './epub-stage1-real.js?v=2';
import {
  splitSemanticItemChunks,
  splitSemanticItemLines,
} from './semantic-content.js?v=4';
import { imgStorePut } from './image-store.js?v=1';

function cleanPath(value) {
  return String(value || '').replace(/^\/+/, '').replace(/\\/g, '/');
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

  const chapters = [];
  const imageBlobs = new Map();
  const missingImages = [];
  const diagnostics = [];
  let totalTextChars = 0;

  for (let index = 0; index < htmlPaths.length; index += 1) {
    const path = htmlPaths[index];
    onProgress?.(`Разбираю главу ${index + 1}/${htmlPaths.length}...`);
    try {
      const html = await entries.get(path).text();
      const basePath = path.split('/').slice(0, -1).join('/');
      const parsed = htmlToSemanticItems(html, { basePath })
        .flatMap(item => splitSemanticItemLines(item))
        .flatMap(item => splitSemanticItemChunks(item));
      const items = await resolveImageItems(parsed, entries, bookId, imageBlobs, missingImages);
      const diag = semanticItemsDiagnostics(items);
      diagnostics.push({ path, ...diag });
      if (!diag.hasRenderableContent) continue;

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
    schemaVersion: 2,
    bookId,
    title: packageInfo.title || fallbackTitle,
    author: packageInfo.author || '',
    lang: packageInfo.language || '',
    coverPath,
    coverKey,
    chapters,
    diagnostics: {
      files: entries.size,
      htmlFiles: htmlPaths.length,
      chapters: chapters.length,
      images: imageBlobs.size + (coverKey && !imageBlobs.has(coverKey) ? 1 : 0),
      missingImages: [...new Set(missingImages.filter(Boolean))],
      textChars: totalTextChars,
      details: diagnostics,
    },
  };
}
