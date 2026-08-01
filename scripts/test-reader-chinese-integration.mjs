import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const source = await fs.readFile(new URL('js/reader/chinese-context.js', root), 'utf8');
const { resolveChinesePinyin } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const payload = JSON.parse(await fs.readFile(new URL('data/zh_dict_core.json', root), 'utf8'));
const dict = payload.map;

function segment(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!/[\u3400-\u9fff]/.test(ch)) {
      out.push({ token: ch, start: i });
      i++;
      continue;
    }
    let best = ch;
    for (let len = Math.min(12, text.length - i); len >= 2; len--) {
      const slice = text.slice(i, i + len);
      if (dict[slice]) { best = slice; break; }
    }
    out.push({ token: best, start: i });
    i += best.length;
  }
  return out;
}

function reading(text) {
  return segment(text)
    .filter(x => /[\u3400-\u9fff]/.test(x.token))
    .map(x => ({
      ...x,
      pinyin: resolveChinesePinyin(x.token, {
        text,
        start: x.start,
        dictionaryPinyin: dict[x.token]?.[0] || '',
      }),
    }));
}

function expectReading(text, token, expected, occurrence = 0) {
  const rows = reading(text).filter(x => x.token === token);
  assert.ok(rows[occurrence], `token ${token}#${occurrence} missing in ${text}: ${JSON.stringify(reading(text))}`);
  assert.equal(rows[occurrence].pinyin, expected, `${text}: ${token} expected ${expected}, got ${rows[occurrence].pinyin}`);
}

expectReading('银行行长说这个方案可行。', '银行', 'yín háng');
expectReading('银行行长说这个方案可行。', '行长', 'háng zhǎng');
expectReading('银行行长说这个方案可行。', '可行', 'kě xíng');
expectReading('他还有一本书要还给老师。', '还有', 'hái yǒu');
expectReading('他还有一本书要还给老师。', '书', 'shū');
expectReading('他还有一本书要还给老师。', '要', 'yào');
expectReading('他还有一本书要还给老师。', '还给老师', 'huán gěi lǎo shī');
expectReading('孩子长大以后，头发会很长。', '长大', 'zhǎng dà');
expectReading('孩子长大以后，头发会很长。', '长', 'cháng');
expectReading('请重新检查这个重要问题。', '重新', 'chóng xīn');
expectReading('请重新检查这个重要问题。', '重要', 'zhòng yào');
expectReading('他跑得很快，所以我得追上去。', '得很', 'de hěn');
expectReading('他跑得很快，所以我得追上去。', '得', 'děi');
expectReading('她认真地学习这个地方的历史。', '地', 'de', 0);
expectReading('她认真地学习这个地方的历史。', '地方', 'dì fāng');
expectReading('孩子看着窗外，后来睡着了。', '着', 'zhe', 0);
expectReading('孩子看着窗外，后来睡着了。', '睡着', 'shuì zháo');

const app = await fs.readFile(new URL('js/reader-app.js', root), 'utf8');
const css = await fs.readFile(new URL('css/style.css', root), 'utf8');
const renderer = await fs.readFile(new URL('js/reader/chapter-render-next.js', root), 'utf8');

assert.match(app, /await readerEnsureZhCoreJsonLoaded\(\{ rerender: false \}\)/);
assert.match(app, /const readerZhStableSegments = new Map\(\)/);
assert.match(app, /readerRefreshParagraphWordClasses\(\);\n  const panel = ensureReaderWordPanel/);
assert.doesNotMatch(app, /try \{ if \(readerCurrentLang\(\) === 'zh'\) renderReaderChapter\(\); \} catch \{\}/);
assert.match(app, /data-reader-offset=/);
assert.match(app, /resolveChinesePinyin/);
assert.match(app, /function readerRenderChapterAnchored\(\)/);
assert.match(app, /readerRenderChapterAnchored\(\);\n    if \(!silent\) showToast/);
assert.doesNotMatch(app, /readerCloseWordPanel\(\);\n  renderReaderChapter\(\);\n  showToast\('✓/);
assert.match(css, /\.reader-word\.rw-pinyin-slot/);
assert.match(css, /color:transparent !important/);
assert.match(renderer, /ensureZhCoreLoaded\(\{ rerender: false \}\)/);

console.log('Chinese reader integration: segmentation, context and stability checks passed');
