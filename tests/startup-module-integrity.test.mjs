import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const readerAppPath = new URL('../js/reader-app.js', import.meta.url);
const source = readFileSync(readerAppPath, 'utf8');
const lineCount = source.split(/\r?\n/).length;

assert.ok(
  !source.startsWith('Warning: truncated output'),
  'reader-app.js contains a captured tool-output truncation header',
);
assert.ok(
  !source.includes('Total output lines:'),
  'reader-app.js contains captured terminal output instead of source code',
);
assert.ok(
  lineCount > 5000,
  `reader-app.js is unexpectedly short (${lineCount} lines)`,
);

for (const marker of [
  'function readerNormalizeBookChunks(',
  'function readerSentenceContext(',
  'async function readerAI(',
  'function renderReaderChapter(',
]) {
  assert.ok(source.includes(marker), `reader-app.js is missing startup marker: ${marker}`);
}

const syntax = spawnSync(process.execPath, ['--check', readerAppPath.pathname], {
  encoding: 'utf8',
});
assert.equal(
  syntax.status,
  0,
  `reader-app.js syntax check failed:\n${syntax.stderr || syntax.stdout}`,
);

console.log(`startup module integrity: ok (${lineCount} lines)`);
