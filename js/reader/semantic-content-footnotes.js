import {
  contentItemText,
  isImageContentItem,
} from './semantic-content.js?v=4';

export * from './semantic-content.js?v=4';

function defaultEscape(value) {
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
  const align = /^(?:left|right|center|start|end)$/.test(String(block.textAlign || '')) ? block.textAlign : '';
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

function renderRun(run, paragraphIndex, renderLegacy, escape) {
  if (run?.footnote?.target) {
    const label = String(run.footnote.label || '※').trim() || '※';
    const target = String(run.footnote.target || '');
    return `<button type="button" class="reader-footnote-ref" data-reader-footnote-target="${escape(target)}" data-reader-footnote-label="${escape(label)}" aria-label="Открыть сноску ${escape(label)}" title="Открыть сноску">${escape(label)}</button>`;
  }

  const lines = String(run?.text || '').replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map(line => wrapMarks(renderLegacy(line, paragraphIndex), run?.marks || []))
    .join('<br>');
}

export function renderContentItem(item, paragraphIndex, {
  renderLegacy,
  escape = defaultEscape,
} = {}) {
  if (typeof renderLegacy !== 'function') throw new Error('renderLegacy is required');
  if (typeof item === 'string' || item == null) return renderLegacy(item || '', paragraphIndex);

  if (isImageContentItem(item)) {
    const caption = String(item.caption || '').trim();
    const alt = String(item.alt || caption || '').trim();
    return `<figure class="reader-figure"><img data-img-key="${escape(item.key || '')}" alt="${escape(alt)}" class="epub-img">${caption ? `<figcaption>${escape(caption)}</figcaption>` : ''}</figure>`;
  }

  const runs = Array.isArray(item.runs) ? item.runs : [{ text: contentItemText(item), marks: [] }];
  const body = runs.map(run => renderRun(run, paragraphIndex, renderLegacy, escape)).join('');
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
  return `<span ${semanticLayout(item, escape)}>${body}</span>`;
}
