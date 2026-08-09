import {
  readFileAsArrayBuffer,
  readZipEntries,
} from './epub.js?v=3';
import {
  extractEpubPackageInfo,
  htmlToSemanticItems,
  semanticItemText,
} from './epub-stage1-real.js?v=2';
import { splitSemanticItemChunks } from './semantic-content.js?v=4';
import { parseSemanticEpubFile } from './semantic-import-stage1.js?v=5';
import {
  extractCanonicalEpubToc,
  mapEpubTocToChapters,
  applyCanonicalTocTitles,
} from './epub-toc.js?v=1';

function cleanPath(value) {
  let out = String(value || '').replace(/^\/+/, '').replace(/\\/g, '/');
  try { out = decodeURIComponent(out); } catch {}
  return out;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function findPackage(entries) {
  let opfPath = '';
  try {
    const container = await entries.get('META-INF/container.xml')?.text();
    opfPath = container?.match(/full-path=["']([^"']+)["']/i)?.[1] || '';
  } catch {}
  if (!opfPath) opfPath = [...entries.keys()].find(path => /\.opf$/i.test(path)) || '';
  opfPath = cleanPath(opfPath);
  if (!opfPath || !entries.has(opfPath)) return null;
  const opfText = await entries.get(opfPath).text();
  return {
    opfPath,
    packageInfo: extractEpubPackageInfo(opfText, { opfPath }),
  };
}

function firstTocTitleForPath(toc, sourcePath, fallback) {
  const path = cleanPath(sourcePath);
  return cleanText((toc || []).find(item => cleanPath(item?.sourcePath) === path)?.title) || fallback;
}

function hasReadableContent(items = []) {
  return items.some(item => item?.type === 'image' || semanticItemText(item).trim().length > 1);
}

async function recoverMissingTocDocuments(entries, chapters, toc) {
  const existing = new Set((chapters || []).map(ch => cleanPath(ch?.sourcePath)).filter(Boolean));
  const paths = [];
  for (const item of toc || []) {
    const path = cleanPath(item?.sourcePath);
    if (!path || existing.has(path) || paths.includes(path)) continue;
    if (!entries.has(path) || !/\.(?:xhtml|html|htm|xml)$/i.test(path)) continue;
    paths.push(path);
  }

  for (const path of paths) {
    try {
      const html = await entries.get(path).text();
      const basePath = path.split('/').slice(0, -1).join('/');
      const parsed = htmlToSemanticItems(html, { basePath })
        .flatMap(item => splitSemanticItemChunks(item));
      if (!hasReadableContent(parsed)) continue;
      chapters.push({
        id: `toc_recovered_${chapters.length}`,
        sourcePath: path,
        title: firstTocTitleForPath(toc, path, `Раздел ${chapters.length + 1}`),
        paragraphs: parsed,
        tocRecovered: true,
      });
      existing.add(path);
    } catch (error) {
      console.warn('[reader epub toc] canonical document recovery failed', path, error?.message || error);
    }
  }
}

function sortChaptersBySpine(chapters, packageInfo) {
  const rank = new Map();
  (packageInfo?.spinePaths || []).forEach((path, index) => {
    const clean = cleanPath(path);
    if (clean && !rank.has(clean)) rank.set(clean, index);
  });
  const originalOrder = new Map((chapters || []).map((chapter, index) => [chapter, index]));
  chapters.sort((a, b) => {
    const aPath = cleanPath(a?.sourcePath);
    const bPath = cleanPath(b?.sourcePath);
    const ar = rank.has(aPath) ? rank.get(aPath) : Number.MAX_SAFE_INTEGER;
    const br = rank.has(bPath) ? rank.get(bPath) : Number.MAX_SAFE_INTEGER;
    return ar - br || (originalOrder.get(a) || 0) - (originalOrder.get(b) || 0);
  });
  return chapters;
}

export async function parseSemanticEpubFileWithToc(file, options = {}) {
  const result = await parseSemanticEpubFile(file, options);

  try {
    options.onProgress?.('Читаю оглавление EPUB...');
    const entries = await readZipEntries(await readFileAsArrayBuffer(file));
    const pkg = await findPackage(entries);
    if (!pkg) return result;

    const canonical = await extractCanonicalEpubToc(entries, pkg.packageInfo);
    if (!canonical.length) {
      result.toc = mapEpubTocToChapters([], result.chapters || []);
      result.diagnostics = {
        ...(result.diagnostics || {}),
        tocEntries: result.toc.length,
        tocCanonical: false,
        tocMapped: result.toc.length,
        tocUnavailable: 0,
      };
      return result;
    }

    const chapters = result.chapters || [];
    const legacyChapterCount = chapters.length;
    await recoverMissingTocDocuments(entries, chapters, canonical);
    sortChaptersBySpine(chapters, pkg.packageInfo);

    const mapped = mapEpubTocToChapters(canonical, chapters);
    applyCanonicalTocTitles(chapters, mapped);

    result.schemaVersion = 4;
    result.chapters = chapters;
    result.toc = mapped;
    result.diagnostics = {
      ...(result.diagnostics || {}),
      chapters: chapters.length,
      tocEntries: mapped.length,
      tocCanonical: true,
      tocMapped: mapped.filter(item => Number.isInteger(item.chapterIndex)).length,
      tocUnavailable: mapped.filter(item => !Number.isInteger(item.chapterIndex)).length,
      legacyChapterCount,
    };
    return result;
  } catch (error) {
    console.warn('[reader epub toc] canonical TOC pass failed; keeping parsed chapters', error?.message || error);
    result.toc = mapEpubTocToChapters([], result.chapters || []);
    result.diagnostics = {
      ...(result.diagnostics || {}),
      tocEntries: result.toc.length,
      tocCanonical: false,
      tocMapped: result.toc.length,
      tocUnavailable: 0,
      tocError: String(error?.message || error),
    };
    return result;
  }
}
