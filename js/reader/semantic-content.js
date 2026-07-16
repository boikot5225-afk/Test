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
  // EPUB adaptations often keep a whole dialogue in one <p> and separate
  // speakers with <br>. The parser stores those as \n; render real <br>
  // elements so WebView does not collapse all replies into one visual line.
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
