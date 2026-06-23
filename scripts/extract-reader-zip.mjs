import fs from 'node:fs';

const path = 'js/app.js';
let source = fs.readFileSync(path, 'utf8');

function range(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
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

function replace(name, code) {
  const found = range(name);
  source = source.slice(0, found.start) + code + source.slice(found.end);
}

if (!source.includes('epubReadZipEntries')) {
  const anchor = "import { renderHome } from './home.js';";
  const imp = "import { readFileAsArrayBuffer as epubReadFileAsArrayBuffer, zipU16 as epubZipU16, zipU32 as epubZipU32, inflateZipData as epubInflateZipData, readZipEntries as epubReadZipEntries } from './reader/epub.js?v=1';\n";
  if (!source.includes(anchor)) throw new Error('Import anchor missing');
  source = source.replace(anchor, imp + anchor);
}

replace('readerReadFileAsArrayBuffer', "function readerReadFileAsArrayBuffer(file) { return epubReadFileAsArrayBuffer(file); }");
replace('readerZipU16', "function readerZipU16(view, offset) { return epubZipU16(view, offset); }");
replace('readerZipU32', "function readerZipU32(view, offset) { return epubZipU32(view, offset); }");
replace('readerInflateZipData', "async function readerInflateZipData(bytes) { return epubInflateZipData(bytes); }");
replace('readerReadZipEntries', "async function readerReadZipEntries(arrayBuffer) { return epubReadZipEntries(arrayBuffer); }");

fs.writeFileSync(path, source);
