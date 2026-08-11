import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync('js/reader/chapter-render-next.js', 'utf8');
const marker = 'if (prevActive === paragraphIndex)';
const start = source.indexOf(marker);
assert.notEqual(start, -1, 'same-active fast-nav branch is missing');
const end = source.indexOf('const oldEl', start);
assert.ok(end > start, 'could not isolate same-active fast-nav branch');
const branch = source.slice(start, end);

// Regression: an async paragraph translation finishes while the user is still
// on the same paragraph. render() takes the fast-nav path. That path MUST sync
// newly available translation/analysis DOM before returning, otherwise the AI
// request succeeds and the spinner disappears but no translation appears until
// some unrelated full render happens later.
assert.match(
  branch,
  /syncParagraphHelpBlocks|renderTranslationBlock/,
  'same-active fast-nav returns before inserting a newly arrived paragraph translation',
);

console.log('reader same-active paragraph help render: PASS');
