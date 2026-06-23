// EPUB parsing helpers extracted from app.js.
// They contain no app state and do not call AI or Firebase.

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
    reader.readAsArrayBuffer(file);
  });
}

export function zipU16(view, offset) {
  return view.getUint16(offset, true);
}

export function zipU32(view, offset) {
  return view.getUint32(offset, true);
}

export async function inflateZipData(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Браузер не поддерживает распаковку EPUB. На Android/Chrome и Edge обычно работает; иначе экспортируй текст в TXT.');
  }
  for (const format of ['deflate-raw', 'deflate']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {}
  }
  throw new Error('Не удалось распаковать EPUB: deflate не поддержан браузером.');
}

export async function readZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 66000); index -= 1) {
    if (zipU32(view, index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error('Это не похоже на ZIP/EPUB: не найден каталог архива.');

  const count = zipU16(view, eocd + 10);
  let offset = zipU32(view, eocd + 16);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();

  for (let number = 0; number < count; number += 1) {
    if (zipU32(view, offset) !== 0x02014b50) break;
    const method = zipU16(view, offset + 10);
    const compressedSize = zipU32(view, offset + 20);
    const nameLength = zipU16(view, offset + 28);
    const extraLength = zipU16(view, offset + 30);
    const commentLength = zipU16(view, offset + 32);
    const localOffset = zipU32(view, offset + 42);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength)).replace(/^\/+/, '');

    if (zipU32(view, localOffset) === 0x04034b50 && !name.endsWith('/')) {
      const localNameLength = zipU16(view, localOffset + 26);
      const localExtraLength = zipU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      entries.set(name, {
        name,
        method,
        async bytes() {
          if (method === 0) return compressed;
          if (method === 8) return inflateZipData(compressed);
          throw new Error('EPUB содержит неподдерживаемый ZIP-метод: ' + method);
        },
        async text() {
          return decoder.decode(await this.bytes());
        },
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function resolveEpubPath(base, href) {
  if (!href) return '';
  if (/^[a-z]+:/i.test(href)) return href;
  const parts = (base ? base.split('/') : []).concat(String(href).split('/'));
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return result.join('/');
}

export function cleanEpubText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeEpubBoilerplate(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized || normalized.length <= 2) return true;
  return /^(contents?|table of contents|目录|目錄|版权|版權|封面|cover|nav|toc)$/i.test(normalized);
}

export function htmlToPlainText(html = '') {
  return cleanEpubText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|pre|tr|td|th)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

export function htmlToParagraphs(html, { lang = null, canonicalLang, chunkLongParagraph }) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,svg,iframe,object,form,noscript').forEach(node => node.remove());
  doc.querySelectorAll('br').forEach(node => node.replaceWith(doc.createTextNode('\n')));

  const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,div,section,article,main,td,th,dd,dt';
  const hardTags = new Set('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre'.split(','));
  const nodes = [...doc.body?.querySelectorAll(blockSelector) || []];
  const paragraphs = [];
  const seen = new Set();
  const isChinese = canonicalLang(lang) === 'zh';

  const pushParagraph = (raw) => {
    const clean = cleanEpubText(raw);
    if (!clean || looksLikeEpubBoilerplate(clean)) return;
    const key = clean.slice(0, 180);
    if (seen.has(key)) return;
    seen.add(key);
    const parts = clean.split(/\n\s*\n+/).map(cleanEpubText).filter(Boolean);
    for (const part of (parts.length ? parts : [clean])) {
      chunkLongParagraph(part.replace(/\n+/g, ' '), isChinese ? 150 : 420).forEach(item => {
        if (item && !looksLikeEpubBoilerplate(item)) paragraphs.push(item);
      });
    }
  };

  nodes.forEach(node => {
    const tag = node.tagName?.toLowerCase() || '';
    const text = node.textContent || '';
    if (!text.trim()) return;
    const childBlocks = [...node.querySelectorAll(blockSelector)].filter(child => child !== node && (child.textContent || '').trim().length > 12);
    if (!hardTags.has(tag) && childBlocks.length) return;
    pushParagraph(text);
  });

  const bodyText = cleanEpubText(doc.body?.textContent || '').replace(/\n+/g, '\n');
  const plainText = htmlToPlainText(html).replace(/\n{3,}/g, '\n\n');
  const bestText = plainText.replace(/\s+/g, '').length > bodyText.replace(/\s+/g, '').length ? plainText : bodyText;
  const bodyChars = bestText.replace(/\s+/g, '').length;
  const paragraphChars = paragraphs.join('').replace(/\s+/g, '').length;

  if (bodyChars > 0 && (paragraphs.length === 0 || paragraphChars < bodyChars * 0.82)) {
    const fallback = [];
    bestText.split(/\n\s*\n+|\n+/).map(cleanEpubText).filter(item => item && !looksLikeEpubBoilerplate(item)).forEach(part => {
      chunkLongParagraph(part, isChinese ? 150 : 420).forEach(item => fallback.push(item));
    });
    if (fallback.join('').replace(/\s+/g, '').length > paragraphChars) return fallback.filter(item => item.length > 1);
  }
  return paragraphs.filter(item => item.length > 1);
}

export function parseAttrs(tag = '') {
  const attrs = {};
  String(tag || '').replace(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g, (_, key, _quote, value) => {
    attrs[key] = value;
    return '';
  });
  return attrs;
}

export function extractManifestAndSpine(opfText, base) {
  const manifest = {};
  const spine = [];
  const addItem = (id, href, media = '') => {
    if (!id || !href) return;
    if (/xhtml|html|xml/i.test(media) || /\.(xhtml|html|htm)$/i.test(href)) manifest[id] = resolveEpubPath(base, href);
  };
  try {
    const xml = new DOMParser().parseFromString(opfText, 'application/xml');
    xml.querySelectorAll('manifest item').forEach(item => addItem(item.getAttribute('id'), item.getAttribute('href'), item.getAttribute('media-type') || ''));
    xml.querySelectorAll('spine itemref').forEach(ref => {
      const path = manifest[ref.getAttribute('idref')];
      if (path) spine.push(path);
    });
  } catch (_) {}
  if (!Object.keys(manifest).length) {
    for (const match of String(opfText || '').matchAll(/<item\b[^>]*>/gi)) {
      const attrs = parseAttrs(match[0]);
      addItem(attrs.id, attrs.href, attrs['media-type'] || '');
    }
    for (const match of String(opfText || '').matchAll(/<itemref\b[^>]*>/gi)) {
      const attrs = parseAttrs(match[0]);
      const path = manifest[attrs.idref];
      if (path) spine.push(path);
    }
  }
  const allHtml = Object.values(manifest).filter(Boolean);
  return { manifest, spine: spine.length ? spine : allHtml, allHtml };
}

export function extractEpubMeta(opfText, fallbackTitle) {
  const get = (tag) => {
    const pattern = new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*${tag}>`, 'i');
    const match = String(opfText || '').match(pattern);
    return match ? match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  };
  return { title: get('title') || fallbackTitle, author: get('creator') || '' };
}
