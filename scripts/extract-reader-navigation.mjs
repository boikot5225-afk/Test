import fs from 'node:fs';

const APP_PATH = 'js/app.js';
let source = fs.readFileSync(APP_PATH, 'utf8');

function functionRange(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Function ${name} not found`);
  const start = match.index;
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

if (!source.includes("./reader/navigation.js")) {
  const anchor = "import { renderHome } from './home.js';";
  if (!source.includes(anchor)) throw new Error('Cannot find navigation import anchor');
  source = source.replace(anchor, `import { createReaderNavigation } from './reader/navigation.js?v=1';\n${anchor}`);
}

if (!source.includes('const readerNavigation = createReaderNavigation(')) {
  const anchor = "const readerAudio = createReaderAudio({";
  if (!source.includes(anchor)) throw new Error('Cannot find reader audio controller anchor');
  const setup = `const readerNavigation = createReaderNavigation({
  getBook: () => readerCurrentBook(),
  render: () => renderReaderChapter(),
  closeParagraphTime: () => readerTimeParagraphClose(),
  scrollActiveParagraph: () => readerScrollActiveParagraph(),
  showToast,
});

`;
  source = source.replace(anchor, setup + anchor);
}

const replacements = {
  readerSelectParagraph: `function readerSelectParagraph(index) {\n  return readerNavigation.selectParagraph(index);\n}`,
  readerNextParagraph: `function readerNextParagraph() {\n  return readerNavigation.nextParagraph();\n}`,
  readerPrevParagraph: `function readerPrevParagraph() {\n  return readerNavigation.previousParagraph();\n}`,
  readerCurrentParagraphText: `function readerCurrentParagraphText(index = null) {\n  return readerNavigation.currentParagraphText(index);\n}`,
  readerNextChapter: `function readerNextChapter() {\n  return readerNavigation.nextChapter();\n}`,
  readerPrevChapter: `function readerPrevChapter() {\n  return readerNavigation.previousChapter();\n}`,
};

for (const [name, replacement] of Object.entries(replacements)) {
  const range = functionRange(name);
  source = source.slice(0, range.start) + replacement + source.slice(range.end);
}

fs.writeFileSync(APP_PATH, source);
console.log('Extracted reader navigation into js/reader/navigation.js');
