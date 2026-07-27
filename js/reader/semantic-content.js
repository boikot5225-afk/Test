// Compatibility helpers for semantic EPUB content.
// Legacy books keep plain strings; new EPUB imports may store structured items.

export function isImageContentItem(item) {
  return !!item && typeof item === 'object' && item.type === 'image';
}

export function isSemanticTextItem(item) {
  return !!item && typeof item === 'object' && item.type !== 'image' && Array.isArray(item.runs);
}

export function contentItemText(item) {
  if (item == null || isImageContentItem(item)) return '';
  if (typeof item === 'string') return item;
  if (Array.isArray(item.runs)) return item.runs.map(run => String(run?.text || '')).join('');
  if (typeof item.text === 'string') return item.text;
  return '';
}

export function chapterContentText(items = [], separator = ' ') {
  return (items || []).map(contentItemText).filter(Boolean).join(separator);
}

export function firstReadableContentIndex(items = [], from = 0) {
  for (let i = Math.max(0, from); i < items.length; i += 1) {
    if (contentItemText(items[i]).trim()) return i;
  }
  return items.length ? Math.min(Math.max(0, from), items.length - 1) : 0;
}

export function lastReadableContentIndex(items = [], from = null) {
  const start = from == null ? items.length - 1 : Math.min(from, items.length - 1);
  for (let i = start; i >= 0; i -= 1) {
    if (contentItemText(items[i]).trim()) return i;
  }
  return items.length ? 0 : 0;
}

function trimLineRuns(runs = []) {
  const out = runs
    .map(run => ({ ...run, text: String(run?.text || '') }))
    .filter(run => run.text.length > 0);
  if (!out.length) return [];
  out[0].text = out[0].text.replace(/^\s+/, '');
  out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  return out.filter(run => run.text.length > 0);
}

export function splitSemanticItemLines(item) {
  if (!isSemanticTextItem(item)) return [item];
  const type = String(item.type || 'paragraph');
  if (type !== 'paragraph' && type !== 'quote') return [item];
  if (!/[\r\n]/.test(contentItemText(item))) return [item];

  const parts = [];
  let currentRuns = [];
  const flush = () => {
    const runs = trimLineRuns(currentRuns);
    currentRuns = [];
    if (!runs.length) return;
    parts.push({ ...item, runs });
  };

  for (const run of item.runs || []) {
    const pieces = String(run?.text || '').replace(/\r\n?/g, '\n').split('\n');
    pieces.forEach((piece, index) => {
      if (piece) currentRuns.push({ ...run, text: piece });
      if (index < pieces.length - 1) flush();
    });
  }
  flush();
  return parts.length ? parts : [item];
}

function sliceSemanticRuns(runs = [], start = 0, end = 0) {
  const out = [];
  let cursor = 0;
  for (const run of runs || []) {
    const text = String(run?.text || '');
    const runStart = cursor;
    const runEnd = cursor + text.length;
    cursor = runEnd;
    if (runEnd <= start || runStart >= end) continue;
    const from = Math.max(start, runStart) - runStart;
    const to = Math.min(end, runEnd) - runStart;
    const piece = text.slice(from, to);
    if (piece) out.push({ ...run, text: piece });
  }
  return trimLineRuns(out);
}

function collectSemanticBoundaries(text, pattern) {
  const positions = [];
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let match;
  while ((match = regex.exec(text))) {
    positions.push(match.index + match[0].length);
    if (!match[0].length) regex.lastIndex += 1;
  }
  return positions;
}

function lastBoundaryBetween(positions, minEnd, maxEnd) {
  let picked = -1;
  for (const pos of positions) {
    if (pos < minEnd) continue;
    if (pos > maxEnd) break;
    picked = pos;
  }
  return picked;
}

function nextSemanticChunkEnd(text, start, maxChars, minChars) {
  const maxEnd = Math.min(text.length, start + maxChars);
  if (maxEnd >= text.length) return text.length;
  const minEnd = Math.min(maxEnd, start + minChars);

  const strong = collectSemanticBoundaries(text, /[.!?…]+(?:["'»”’\)\]]*)?(?=\s|$)/g);
  const medium = collectSemanticBoundaries(text, /[;:](?=\s|$)/g);
  const commas = collectSemanticBoundaries(text, /,(?=\s|$)/g);

  let cut = lastBoundaryBetween(strong, minEnd, maxEnd);
  if (cut < 0) cut = lastBoundaryBetween(medium, minEnd, maxEnd);
  if (cut < 0) cut = lastBoundaryBetween(commas, minEnd, maxEnd);
  if (cut < 0) {
    const whitespace = text.lastIndexOf(' ', maxEnd);
    cut = whitespace >= minEnd ? whitespace : maxEnd;
  }
  return Math.max(start + 1, cut);
}

export function splitSemanticItemChunks(item, {
  maxChars = 280,
  minChars = 120,
} = {}) {
  if (!isSemanticTextItem(item)) return [item];
  const type = String(item.type || 'paragraph');
  if (type !== 'paragraph' && type !== 'quote') return [item];

  const text = contentItemText(item);
  const max = Math.max(100, Number(maxChars) || 280);
  const min = Math.max(50, Math.min(max - 20, Number(minChars) || 120));
  if (text.trim().length <= max) return [item];

  const parts = [];
  let start = 0;
  while (start < text.length) {
    while (start < text.length && /\s/.test(text[start])) start += 1;
    if (start >= text.length) break;
    const end = nextSemanticChunkEnd(text, start, max, min);
    const runs = sliceSemanticRuns(item.runs, start, end);
    if (runs.length) parts.push({ ...item, runs });
    start = end;
  }
  return parts.length > 1 ? parts : [item];
}

export function normalizeSemanticBookLineItems(book) {
  if (!book || book._semanticLineItemsV1) return false;
  const currentChapter = Math.max(0, Number(book.currentChapter) || 0);
  const oldCurrentParagraph = Math.max(0, Number(book.currentParagraph) || 0);
  let mappedCurrentParagraph = oldCurrentParagraph;
  let changed = false;

  for (let chapterIndex = 0; chapterIndex < (book.chapters || []).length; chapterIndex += 1) {
    const chapter = book.chapters[chapterIndex];
    const items = Array.isArray(chapter?.paragraphs) ? chapter.paragraphs : [];
    const next = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const parts = splitSemanticItemLines(items[itemIndex]);
      if (parts.length !== 1 || parts[0] !== items[itemIndex]) changed = true;
      if (chapterIndex === currentChapter && itemIndex === oldCurrentParagraph) {
        mappedCurrentParagraph = next.length;
      }
      next.push(...parts);
    }

    if (next.length !== items.length || next.some((item, index) => item !== items[index])) {
      chapter.paragraphs = next;
    }
  }

  if (changed && book.chapters?.[currentChapter]?.paragraphs?.length) {
    book.currentParagraph = Math.min(mappedCurrentParagraph, book.chapters[currentChapter].paragraphs.length - 1);
  }
  book._semanticLineItemsV1 = true;
  return changed;
}

export function normalizeSemanticBookTextChunks(book, options = {}) {
  if (!book || book._semanticTextChunksV1) return false;
  const currentChapter = Math.max(0, Number(book.currentChapter) || 0);
  const oldCurrentParagraph = Math.max(0, Number(book.currentParagraph) || 0);
  let mappedCurrentParagraph = oldCurrentParagraph;
  let changed = false;

  for (let chapterIndex = 0; chapterIndex < (book.chapters || []).length; chapterIndex += 1) {
    const chapter = book.chapters[chapterIndex];
    const items = Array.isArray(chapter?.paragraphs) ? chapter.paragraphs : [];
    const next = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const parts = splitSemanticItemChunks(items[itemIndex], options);
      if (parts.length !== 1 || parts[0] !== items[itemIndex]) changed = true;
      if (chapterIndex === currentChapter && itemIndex === oldCurrentParagraph) {
        mappedCurrentParagraph = next.length;
      }
      next.push(...parts);
    }

    if (next.length !== items.length || next.some((item, index) => item !== items[index])) {
      chapter.paragraphs = next;
    }
  }

  if (changed && book.chapters?.[currentChapter]?.paragraphs?.length) {
    book.currentParagraph = Math.min(mappedCurrentParagraph, book.chapters[currentChapter].paragraphs.length - 1);
  }
  book._semanticTextChunksV1 = true;
  return changed;
}

const BAD_OBJECT_TEXT = /^\s*\[?\s*(?:object|объект)\s+(?:object|объект)\s*\]?\s*$/i;
const TRANSLATION_VALUE_KEYS = [
  'ru', 'translation', 'translatedText', 'translated_text', 'text',
  'result', 'output', 'content', 'message', 'data',
];

export function translationValueText(value, seen = new Set()) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    return BAD_OBJECT_TEXT.test(text) ? '' : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(item => translationValueText(item, seen)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  for (const key of TRANSLATION_VALUE_KEYS) {
    if (!(key in value)) continue;
    const text = translationValueText(value[key], seen);
    if (text) return text;
  }

  const values = Object.values(value);
  if (values.length === 1) return translationValueText(values[0], seen);
  return '';
}

export function normalizeSemanticBookTranslations(book, { reindexed = false } = {}) {
  if (!book || Number(book.schemaVersion || 0) < 2) return false;
  let changed = false;

  if (reindexed) {
    if (Object.keys(book.readerTranslations || {}).length) {
      book.readerTranslations = {};
      changed = true;
    }
    if (Object.keys(book.readerAnalyses || {}).length) {
      book.readerAnalyses = {};
      changed = true;
    }
  }

  if (!book._semanticTranslationKeysV3) {
    book._semanticTranslationKeysV3 = true;
    changed = true;
  }

  const translations = book.readerTranslations || {};
  const normalized = {};
  for (const [key, value] of Object.entries(translations)) {
    const text = translationValueText(value);
    if (!text) {
      changed = true;
      continue;
    }
    normalized[key] = text;
    if (value !== text) changed = true;
  }
  if (changed) book.readerTranslations = normalized;
  return changed;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapMarks(html, marks = []) {
  const set = new Set(marks || []);
  let out = html;
  if (set.has('code')) out = `<code class="reader-semantic-code">${out}</code>`;
  if (set.has('bold')) out = `<strong>${out}</strong>`;
  if (set.has('italic')) out = `<em>${out}</em>`;
  if (set.has('underline')) out = `<u>${out}</u>`;
  if (set.has('strike')) out = `<s>${out}</s>`;
  return out;
}

function renderRunWithLineBreaks(run, paragraphIndex, renderLegacy) {
  // Safety net for books imported before line-based semantic normalization.
  const lines = String(run?.text || '').replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map(line => wrapMarks(renderLegacy(line, paragraphIndex), run?.marks || []))
    .join('<br>');
}

export function renderContentItem(item, paragraphIndex, {
  renderLegacy,
  escape = escapeHtml,
} = {}) {
  if (typeof renderLegacy !== 'function') throw new Error('renderLegacy is required');
  if (typeof item === 'string' || item == null) return renderLegacy(item || '', paragraphIndex);

  if (isImageContentItem(item)) {
    const caption = String(item.caption || '').trim();
    const alt = String(item.alt || caption || '').trim();
    return `<figure class="reader-figure"><img data-img-key="${escape(item.key || '')}" alt="${escape(alt)}" class="epub-img">${caption ? `<figcaption>${escape(caption)}</figcaption>` : ''}</figure>`;
  }

  const runs = Array.isArray(item.runs) ? item.runs : [{ text: contentItemText(item), marks: [] }];
  const body = runs.map(run => renderRunWithLineBreaks(run, paragraphIndex, renderLegacy)).join('');
  const type = String(item.type || 'paragraph');

  if (type === 'heading') {
    const level = Math.max(1, Math.min(6, Number(item.level) || 2));
    return `<h${level} class="reader-semantic-heading reader-semantic-heading-${level}">${body}</h${level}>`;
  }
  if (type === 'quote') return `<blockquote class="reader-semantic-quote">${body}</blockquote>`;
  if (type === 'caption') return `<div class="reader-semantic-caption">${body}</div>`;
  if (type === 'pre') return `<pre class="reader-semantic-pre">${escape(contentItemText(item))}</pre>`;
  if (type === 'list-item') {
    const marker = item.ordered ? `${Math.max(1, Number(item.number) || 1)}.` : '•';
    return `<div class="reader-semantic-list-item"><span class="reader-semantic-list-marker" aria-hidden="true">${escape(marker)}</span><span>${body}</span></div>`;
  }
  return `<span class="reader-semantic-paragraph">${body}</span>`;
}
