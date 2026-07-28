import fs from 'node:fs';

const APP_PATH = 'js/app.js';
let source = fs.readFileSync(APP_PATH, 'utf8');

function findFunctionStart(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

function findFunctionEnd(start) {
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`No opening brace after ${start}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`Unclosed function at ${start}`);
}

if (!source.includes("./reader/audio.js")) {
  const anchor = "import { renderHome } from './home.js';";
  if (!source.includes(anchor)) throw new Error('Cannot find reader import anchor');
  source = source.replace(anchor, `import { createReaderAudio } from './reader/audio.js?v=1';\n${anchor}`);
}

if (!source.includes('const readerAudio = createReaderAudio(')) {
  const audioStart = findFunctionStart('readerSpeakText');
  const chapterStart = findFunctionStart('readerSpeakChapter');
  if (audioStart < 0 || chapterStart < 0 || chapterStart < audioStart) {
    throw new Error('Reader audio functions were not found');
  }
  const chapterEnd = findFunctionEnd(chapterStart);

  const replacement = `const readerAudio = createReaderAudio({
  speak,
  stopSpeak,
  showToast,
  getLang: () => readerCurrentLang(),
  getParagraphText: (index) => {
    if (index === '__chapter__') {
      const book = readerCurrentBook();
      const chapter = book?.chapters?.[book.currentChapter || 0];
      return (chapter?.paragraphs || []).join(' ');
    }
    return readerCurrentParagraphText(index);
  },
  onActiveChange: (active) => { readerSpeechActive = active; },
});

async function readerSpeakText(text, opts = {}) {
  return readerAudio.speakText(text, opts);
}

function readerStopSpeech(show = true) {
  return readerAudio.stop(show);
}

function readerSpeakParagraph(index) {
  return readerAudio.speakParagraph(index);
}

function readerSpeakCurrentParagraph() {
  return readerAudio.speakCurrentParagraph();
}

function readerSpeakChapter() {
  return readerAudio.speakChapter();
}
`;

  source = source.slice(0, audioStart) + replacement + source.slice(chapterEnd);
}

fs.writeFileSync(APP_PATH, source);
console.log('Extracted baseline reader audio into js/reader/audio.js');
