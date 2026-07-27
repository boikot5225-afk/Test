from pathlib import Path
import sys

root = Path(sys.argv[1])

def replace(path, old, new, count=1):
    p = root / path
    s = p.read_text()
    actual = s.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrences, found {actual}: {old[:100]!r}')
    p.write_text(s.replace(old, new, count))

p = root / 'js/reader/semantic-import-stage1.js'
s = p.read_text()
anchor = "const IMPLICIT_NOTE_ENTRY_RE = /^(\\d{1,4})\\s*[.)]\\s+\\S/;\n"
insert = r'''
const BLOCK_STYLE_TOKEN_START = '\uE002RBS';
const BLOCK_STYLE_TOKEN_END = '\uE003';
const BLOCK_STYLE_TOKEN_RE = /\uE002RBS(\d+)\uE003/g;
const BLOCK_STYLE_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,blockquote,li,figcaption,dd,dt,td,th';
const FOOTNOTE_PLACEHOLDER_BASE = 0xE100;
const FOOTNOTE_PLACEHOLDER_LIMIT = 0xF8FF;

function cssProperty(style, name) {
  return String(style || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim() || '';
}

function safeCssLength(value, { allowNegative = false } = {}) {
  const match = String(value || '').trim().match(/^(-?\d+(?:\.\d+)?)(px|pt|em|rem|%)$/i);
  if (!match) return '';
  let number = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(number) || (!allowNegative && number < 0)) return '';
  const max = { px: 120, pt: 90, em: 8, rem: 8, '%': 40 }[unit] || 0;
  if (!max) return '';
  number = Math.max(allowNegative ? -max : 0, Math.min(max, number));
  const normalized = Number(number.toFixed(4));
  return `${normalized}${unit}`;
}

function safeBlockStyle(node) {
  const raw = String(node?.getAttribute?.('style') || '');
  if (!raw) return null;
  const alignRaw = cssProperty(raw, 'text-align').toLowerCase();
  const align = /^(?:left|right|center|justify|start|end)$/.test(alignRaw) ? alignRaw : '';
  const textIndent = safeCssLength(cssProperty(raw, 'text-indent'), { allowNegative: true });
  const marginTop = safeCssLength(cssProperty(raw, 'margin-top'));
  const marginBottom = safeCssLength(cssProperty(raw, 'margin-bottom'));
  const out = {};
  if (align) out.textAlign = align;
  if (textIndent) out.textIndent = textIndent;
  if (marginTop) out.marginTop = marginTop;
  if (marginBottom) out.marginBottom = marginBottom;
  return Object.keys(out).length ? out : null;
}

function preprocessBlockStyles(doc) {
  const styles = [];
  for (const node of [...doc.querySelectorAll(BLOCK_STYLE_SELECTOR)]) {
    const blockStyle = safeBlockStyle(node);
    if (!blockStyle) continue;
    const index = styles.length;
    styles.push(blockStyle);
    node.insertBefore(doc.createTextNode(`${BLOCK_STYLE_TOKEN_START}${index}${BLOCK_STYLE_TOKEN_END}`), node.firstChild);
  }
  return styles;
}

function restoreBlockStyles(items, blockStyles) {
  return (items || []).map(item => {
    if (!Array.isArray(item?.runs)) return item;
    let styleIndex = -1;
    const runs = item.runs.map(run => {
      const text = String(run?.text || '');
      BLOCK_STYLE_TOKEN_RE.lastIndex = 0;
      const match = BLOCK_STYLE_TOKEN_RE.exec(text);
      if (match && styleIndex < 0) styleIndex = Number(match[1]);
      BLOCK_STYLE_TOKEN_RE.lastIndex = 0;
      return { ...run, text: text.replace(BLOCK_STYLE_TOKEN_RE, '') };
    }).filter(run => String(run?.text || '') || run?.footnote?.target);
    return styleIndex >= 0 && blockStyles?.[styleIndex]
      ? { ...item, runs, blockStyle: blockStyles[styleIndex] }
      : { ...item, runs };
  }).filter(item => item?.type === 'image' || semanticItemText(item).trim() || item?.runs?.some(run => run?.footnote?.target));
}

export function splitSemanticItemChunksPreservingFootnotes(item, options = {}) {
  if (!Array.isArray(item?.runs) || !item.runs.some(run => run?.footnote?.target)) {
    const plainParts = splitSemanticItemChunks(item, options);
    return plainParts.map((part, index) => plainParts.length > 1
      ? { ...part, semanticChunkIndex: index, semanticChunkCount: plainParts.length }
      : part);
  }

  const footnoteRuns = [];
  const encodedRuns = item.runs.map(run => {
    if (!run?.footnote?.target) return run;
    const index = footnoteRuns.length;
    const codePoint = FOOTNOTE_PLACEHOLDER_BASE + index;
    if (codePoint > FOOTNOTE_PLACEHOLDER_LIMIT) return run;
    footnoteRuns.push({ ...run, text: '' });
    const { footnote, ...rest } = run;
    return { ...rest, text: String.fromCharCode(codePoint) };
  });

  if (!footnoteRuns.length) return splitSemanticItemChunks(item, options);
  const encodedParts = splitSemanticItemChunks({ ...item, runs: encodedRuns }, options);
  return encodedParts.map((part, partIndex) => {
    const runs = [];
    for (const run of part.runs || []) {
      let buffer = '';
      for (const char of String(run?.text || '')) {
        const index = char.charCodeAt(0) - FOOTNOTE_PLACEHOLDER_BASE;
        if (index >= 0 && index < footnoteRuns.length) {
          if (buffer) runs.push({ ...run, text: buffer });
          buffer = '';
          runs.push(footnoteRuns[index]);
        } else {
          buffer += char;
        }
      }
      if (buffer) runs.push({ ...run, text: buffer });
    }
    const cleanRuns = runs.filter(run => String(run?.text || '') || run?.footnote?.target);
    return encodedParts.length > 1
      ? { ...part, runs: cleanRuns, semanticChunkIndex: partIndex, semanticChunkCount: encodedParts.length }
      : { ...part, runs: cleanRuns };
  });
}
'''
if anchor not in s:
    raise SystemExit('semantic-import-stage1: constants anchor missing')
s = s.replace(anchor, anchor + insert, 1)

old = """  return {\n    html: doc.documentElement?.outerHTML || String(html || ''),\n    footnotes,\n    references,\n  };\n"""
new = """  const blockStyles = preprocessBlockStyles(doc);\n  return {\n    html: doc.documentElement?.outerHTML || String(html || ''),\n    footnotes,\n    references,\n    blockStyles,\n  };\n"""
if s.count(old) != 1:
    raise SystemExit('preprocess return anchor mismatch')
s = s.replace(old, new, 1)

old = """      const parsedBeforeRefs = htmlToSemanticItems(prepared.html, { basePath })\n        .flatMap(item => splitSemanticItemLines(item))\n        .flatMap(item => splitSemanticItemChunks(item));\n      const parsed = restoreFootnoteRuns(parsedBeforeRefs, prepared.references);\n      const items = await resolveImageItems(parsed, entries, bookId, imageBlobs, missingImages);\n"""
new = """      const parsedBase = htmlToSemanticItems(prepared.html, { basePath });\n      const parsedWithFootnotes = restoreFootnoteRuns(parsedBase, prepared.references);\n      const parsedWithStyles = restoreBlockStyles(parsedWithFootnotes, prepared.blockStyles);\n      const parsed = parsedWithStyles.flatMap(item => splitSemanticItemChunksPreservingFootnotes(item));\n      const items = await resolveImageItems(parsed, entries, bookId, imageBlobs, missingImages);\n"""
if s.count(old) != 1:
    raise SystemExit('main parse block mismatch')
s = s.replace(old, new, 1)
p.write_text(s)

p = root / 'js/reader/semantic-content-footnotes.js'
s = p.read_text()
anchor = "function renderRun(run, paragraphIndex, renderLegacy, escape) {\n"
insert = r'''
function safeLayoutValue(value) {
  const text = String(value || '').trim();
  return /^-?\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/i.test(text) ? text : '';
}

function semanticLayout(item, escape) {
  const block = item?.blockStyle || {};
  const count = Math.max(1, Number(item?.semanticChunkCount) || 1);
  const index = Math.max(0, Math.min(count - 1, Number(item?.semanticChunkIndex) || 0));
  const first = index === 0;
  const last = index === count - 1;
  const styles = ['display:block'];
  const align = /^(?:left|right|center|justify|start|end)$/.test(String(block.textAlign || '')) ? block.textAlign : '';
  if (align) styles.push(`text-align:${align}`);
  const indent = safeLayoutValue(block.textIndent);
  if (indent) styles.push(`text-indent:${first ? indent : '0'}`);
  const marginTop = safeLayoutValue(block.marginTop);
  const marginBottom = safeLayoutValue(block.marginBottom);
  if (marginTop || count > 1) styles.push(`margin-top:${first ? (marginTop || '0') : '0'}`);
  if (marginBottom || count > 1) styles.push(`margin-bottom:${last ? (marginBottom || '0') : '0'}`);

  const classes = ['reader-semantic-paragraph'];
  if (item?.blockStyle) classes.push('reader-semantic-block-style');
  if (count > 1) {
    classes.push('reader-semantic-chunk');
    if (first) classes.push('reader-semantic-chunk-first');
    else classes.push('reader-semantic-chunk-continuation');
    if (last) classes.push('reader-semantic-chunk-last');
  }
  return `class="${classes.join(' ')}" style="${escape(styles.join(';'))}"`;
}

'''
if anchor not in s:
    raise SystemExit('semantic renderer anchor missing')
s = s.replace(anchor, insert + anchor, 1)
old = "  return `<span class=\"reader-semantic-paragraph\">${body}</span>`;\n"
new = "  return `<span ${semanticLayout(item, escape)}>${body}</span>`;\n"
if s.count(old) != 1:
    raise SystemExit('semantic paragraph return mismatch')
s = s.replace(old, new, 1)
p.write_text(s)

p = root / 'js/reader/chapter-render-stage1.js'
s = p.read_text()
old_css = """    #reader-reading-view #reader-chapter-text .reader-paragraph-text {\n      overflow-wrap: anywhere;\n    }\n"""
new_css = """    #reader-reading-view #reader-chapter-text .reader-paragraph-text {\n      overflow-wrap: anywhere;\n    }\n    #reader-reading-view #reader-chapter-text .reader-paragraph.reader-semantic-layout,\n    #reader-reading-view #reader-chapter-text .reader-paragraph.reader-semantic-layout.active {\n      margin-top: 0 !important;\n      margin-bottom: 0 !important;\n    }\n"""
if s.count(old_css) != 1:
    raise SystemExit('stage1 CSS anchor mismatch')
s = s.replace(old_css, new_css, 1)
anchor = "function stampContextRoot(deps) {\n"
insert = r'''
function stampSemanticLayoutClasses() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  for (const paragraph of root.querySelectorAll('.reader-paragraph.reader-semantic-layout')) {
    paragraph.classList.remove('reader-semantic-layout');
  }
  for (const semantic of root.querySelectorAll('.reader-semantic-block-style, .reader-semantic-chunk')) {
    semantic.closest('.reader-paragraph')?.classList.add('reader-semantic-layout');
  }
}

'''
if anchor not in s:
    raise SystemExit('stage1 function anchor missing')
s = s.replace(anchor, insert + anchor, 1)
old = """        result = base.render();\n        stampContextRoot(deps);\n"""
new = """        result = base.render();\n        stampContextRoot(deps);\n        stampSemanticLayoutClasses();\n"""
if s.count(old) != 1:
    raise SystemExit('stage1 render anchor mismatch')
s = s.replace(old, new, 1)
p.write_text(s)

replace('js/reader/semantic-import-bridge.js', "./semantic-import-stage1.js?v=3", "./semantic-import-stage1.js?v=4")
replace('js/reader/chapter-render-stage1.js', "./semantic-content-footnotes.js?v=1", "./semantic-content-footnotes.js?v=2")
replace('js/reader/chapter-render-stage1.js', "./semantic-import-bridge.js?v=3", "./semantic-import-bridge.js?v=4")
replace('js/reader/chapter-render-dialogue.js', "./chapter-render-stage1.js?v=8", "./chapter-render-stage1.js?v=9")
replace('js/reader/chapter-render.js', "./chapter-render-dialogue.js?v=6", "./chapter-render-dialogue.js?v=7")
replace('js/reader-app.js', "./reader/chapter-render.js?v=8", "./reader/chapter-render.js?v=9")
replace('js/app.js', "./reader-app.js?v=77.29", "./reader-app.js?v=77.30")
replace('index.html', "v77.29-open-with-stable-context", "v77.30-footnotes-formatting-test")
replace('index.html', "js/app.js?v=77.29", "js/app.js?v=77.30")
replace('sw.js', "v77.29-open-with-stable-context", "v77.30-footnotes-formatting-test")

print('patched', root)
