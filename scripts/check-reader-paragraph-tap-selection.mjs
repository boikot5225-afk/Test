import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync('js/reader/interactions.js', 'utf8');

// Regression: a normal tap on paragraph text must select that paragraph.
// In the broken build this branch toggles the reading chrome instead, so the
// renderer never receives a new currentParagraph and .reader-paragraph.active
// never moves to the tapped paragraph.
const paragraphBranch = source.match(
  /const paragraph = target\.closest\('\.reader-paragraph'\);([\s\S]*?)\n\s*}, true\);/
)?.[1] || '';

assert.ok(paragraphBranch, 'paragraph click branch was not found');
assert.match(
  paragraphBranch,
  /const\s+(?:index|idx)\s*=\s*Number\(paragraph\.dataset\.(?:p|readerIndex)\)/,
  'paragraph click must read the tapped paragraph index',
);
assert.match(
  paragraphBranch,
  /selectParagraph\((?:index|idx)\)/,
  'normal paragraph tap must call selectParagraph(index)',
);
assert.doesNotMatch(
  paragraphBranch,
  /toggleChrome\(/,
  'normal paragraph tap must not be consumed by the chrome toggle',
);

console.log('reader paragraph tap selection: PASS');
