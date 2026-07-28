import fs from 'node:fs';

const path = 'js/app.js';
let source = fs.readFileSync(path, 'utf8');

function range(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Missing ${name}`);
  const start = match.index;
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return { start, end: i + 1 };
  }
  throw new Error(`Unclosed ${name}`);
}

const importLine = "import { readFileAsArrayBuffer as epubReadFileAsArrayBuffer, zipU16 as epubZipU16, zipU32 as epubZipU32, inflateZipData as epubInflateZipData, readZipEntries as epubReadZipEntries, resolveEpubPath as epubResolvePath, cleanEpubText as epubCleanText, looksLikeEpubBoilerplate as epubLooksLikeBoilerplate, htmlToPlainText as epubHtmlToPlainText } from './reader/epub.js?v=1';";
if (!source.includes('epubHtmlToParagraphs')) {
  if (!source.includes(importLine)) throw new Error('EPUB import line missing');
  source = source.replace(importLine, importLine.replace('htmlToPlainText as epubHtmlToPlainText', 'htmlToPlainText as epubHtmlToPlainText, htmlToParagraphs as epubHtmlToParagraphs'));
}

const found = range('readerHtmlToParagraphs');
const wrapper = `function readerHtmlToParagraphs(html, lang = null) {
  return epubHtmlToParagraphs(html, {
    lang,
    canonicalLang: readerCanonicalLang,
    chunkLongParagraph: readerChunkLongParagraph,
  });
}`;
source = source.slice(0, found.start) + wrapper + source.slice(found.end);
fs.writeFileSync(path, source);
