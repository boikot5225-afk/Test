// Experimental EPUB semantic parser (stage 1).
// Keeps document order and a small, controlled formatting model instead of raw EPUB HTML.

const BLOCK_TAGS = new Set([
  'h1','h2','h3','h4','h5','h6','p','blockquote','pre','li','ul','ol',
  'div','section','article','main','figure','figcaption','table','tr','td','th','dd','dt'
]);

const DROP_SELECTOR = 'script,style,nav,header,footer,iframe,object,form,noscript,canvas';

function defaultResolvePath(base, href) {
  if (!href) return '';
  if (/^(?:data|blob|https?):/i.test(href)) return href;
  const parts = (base ? String(base).split('/') : []).concat(String(href).split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isBoilerplate(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized || normalized.length <= 1) return true;
  return /^(contents?|table of contents|目录|目錄|版权|版權|封面|cover|nav|toc)$/i.test(normalized);
}

function firstSrcsetCandidate(value) {
  const first = String(value || '').split(',')[0]?.trim() || '';
  return first.split(/\s+/)[0] || '';
}

function imageSource(node) {
  if (!node?.getAttribute) return '';
  const tag = node.tagName?.toLowerCase();
  if (tag === 'image') {
    return node.getAttribute('href') || node.getAttribute('xlink:href') || '';
  }
  return node.getAttribute('src')
    || node.getAttribute('data-src')
    || firstSrcsetCandidate(node.getAttribute('srcset'))
    || '';
}

function mergeMarks(base, extra) {
  const next = new Set(base || []);
  for (const mark of extra || []) next.add(mark);
  return [...next];
}

function marksForElement(node, marks) {
  const tag = node.tagName?.toLowerCase();
  const extra = [];
  if (tag === 'strong' || tag === 'b') extra.push('bold');
  if (tag === 'em' || tag === 'i') extra.push('italic');
  if (tag === 'u') extra.push('underline');
  if (tag === 'code' || tag === 'kbd' || tag === 'samp') extra.push('code');
  return mergeMarks(marks, extra);
}

function appendRun(runs, text, marks = [], href = '') {
  const value = String(text || '');
  if (!value) return;
  const prev = runs[runs.length - 1];
  const markKey = marks.join('|');
  const prevKey = prev?.marks?.join('|') || '';
  if (prev && prevKey === markKey && (prev.href || '') === href) {
    prev.text += value;
    return;
  }
  runs.push({ text: value, marks: [...marks], ...(href ? { href } : {}) });
}

function normalizedRuns(runs) {
  const out = [];
  for (const run of runs || []) {
    let text = String(run?.text || '').replace(/\u00a0/g, ' ');
    if (!text) continue;
    if (!run.marks?.includes('code')) text = text.replace(/[ \t]+/g, ' ');
    appendRun(out, text, run.marks || [], run.href || '');
  }
  if (!out.length) return [];
  out[0].text = out[0].text.replace(/^\s+/, '');
  out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  return out.filter(run => run.text.length > 0);
}

function runsText(runs) {
  return cleanText((runs || []).map(run => run.text || '').join(''));
}

function hasBlockChildren(node) {
  return [...(node?.children || [])].some(child => BLOCK_TAGS.has(child.tagName?.toLowerCase()));
}

function makeTextItem(type, runs, extra = {}) {
  const normalized = normalizedRuns(runs);
  const text = runsText(normalized);
  if (!text || isBoilerplate(text)) return null;
  return { type, runs: normalized, ...extra };
}

function makeImageItem(node, { basePath, resolvePath, caption = '' }) {
  const src = imageSource(node);
  if (!src || /^data:/i.test(src)) return null;
  const path = resolvePath(basePath, src);
  if (!path) return null;
  const alt = cleanText(node.getAttribute?.('alt') || node.getAttribute?.('title') || '');
  return {
    type: 'image',
    path,
    alt,
    ...(caption ? { caption: cleanText(caption) } : {}),
  };
}

function parseInlineFlow(node, options, itemFactory) {
  const items = [];
  let runs = [];

  const flush = () => {
    const item = itemFactory(runs);
    if (item) items.push(item);
    runs = [];
  };

  const visit = (child, marks = [], href = '') => {
    if (!child) return;
    if (child.nodeType === Node.TEXT_NODE) {
      appendRun(runs, child.nodeValue || '', marks, href);
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;

    const tag = child.tagName?.toLowerCase();
    if (tag === 'br') {
      appendRun(runs, '\n', marks, href);
      return;
    }
    if (tag === 'img' || tag === 'image') {
      flush();
      const image = makeImageItem(child, options);
      if (image) items.push(image);
      return;
    }
    if (tag === 'picture') {
      const imageNode = child.querySelector('img');
      if (imageNode) {
        flush();
        const image = makeImageItem(imageNode, options);
        if (image) items.push(image);
      }
      return;
    }
    if (tag === 'svg') {
      const imageNode = child.querySelector('image');
      if (imageNode) {
        flush();
        const image = makeImageItem(imageNode, options);
        if (image) items.push(image);
      }
      return;
    }

    const nextMarks = marksForElement(child, marks);
    const nextHref = tag === 'a' ? (child.getAttribute('href') || href) : href;
    for (const grandChild of child.childNodes || []) visit(grandChild, nextMarks, nextHref);
  };

  for (const child of node.childNodes || []) visit(child, [], '');
  flush();
  return items;
}

function parseFigure(node, options) {
  const caption = cleanText(node.querySelector(':scope > figcaption')?.textContent || node.querySelector('figcaption')?.textContent || '');
  const items = [];
  for (const child of node.childNodes || []) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName?.toLowerCase();
    if (tag === 'figcaption') continue;
    if (tag === 'img' || tag === 'image') {
      const image = makeImageItem(child, { ...options, caption });
      if (image) items.push(image);
      continue;
    }
    if (tag === 'picture') {
      const image = makeImageItem(child.querySelector('img'), { ...options, caption });
      if (image) items.push(image);
      continue;
    }
    items.push(...parseBlock(child, options));
  }
  if (!items.some(item => item.type === 'image')) {
    const imageNode = node.querySelector('img,image');
    const image = makeImageItem(imageNode, { ...options, caption });
    if (image) items.unshift(image);
  }
  if (caption && !items.some(item => item.type === 'image')) {
    const captionItem = makeTextItem('caption', [{ text: caption, marks: [] }]);
    if (captionItem) items.push(captionItem);
  }
  return items;
}

function parseBlock(node, options) {
  if (!node) return [];
  if (node.nodeType === Node.TEXT_NODE) {
    const item = makeTextItem('paragraph', [{ text: node.nodeValue || '', marks: [] }]);
    return item ? [item] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];

  const tag = node.tagName?.toLowerCase();
  if (tag === 'figure') return parseFigure(node, options);
  if (tag === 'img' || tag === 'image') {
    const image = makeImageItem(node, options);
    return image ? [image] : [];
  }
  if (tag === 'picture') {
    const image = makeImageItem(node.querySelector('img'), options);
    return image ? [image] : [];
  }
  if (/^h[1-6]$/.test(tag)) {
    return parseInlineFlow(node, options, runs => makeTextItem('heading', runs, { level: Number(tag[1]) }));
  }
  if (tag === 'blockquote') {
    return parseInlineFlow(node, options, runs => makeTextItem('quote', runs));
  }
  if (tag === 'pre') {
    const text = String(node.textContent || '').replace(/\r/g, '').trim();
    return text ? [{ type: 'pre', runs: [{ text, marks: ['code'] }] }] : [];
  }
  if (tag === 'li') {
    const ordered = node.parentElement?.tagName?.toLowerCase() === 'ol';
    return parseInlineFlow(node, options, runs => makeTextItem('list-item', runs, { ordered }));
  }
  if (tag === 'p' || tag === 'figcaption' || tag === 'dd' || tag === 'dt' || tag === 'td' || tag === 'th') {
    const type = tag === 'figcaption' ? 'caption' : 'paragraph';
    return parseInlineFlow(node, options, runs => makeTextItem(type, runs));
  }
  if (tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tr') {
    const items = [];
    for (const child of node.children || []) items.push(...parseBlock(child, options));
    return items;
  }

  if (hasBlockChildren(node)) {
    const items = [];
    let looseRuns = [];
    const flushLoose = () => {
      const item = makeTextItem('paragraph', looseRuns);
      if (item) items.push(item);
      looseRuns = [];
    };
    for (const child of node.childNodes || []) {
      if (child.nodeType === Node.TEXT_NODE) {
        appendRun(looseRuns, child.nodeValue || '', []);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childTag = child.tagName?.toLowerCase();
      if (BLOCK_TAGS.has(childTag) || childTag === 'img' || childTag === 'picture' || childTag === 'svg') {
        flushLoose();
        items.push(...parseBlock(child, options));
      } else {
        const inlineItems = parseInlineFlow(child, options, runs => makeTextItem('paragraph', runs));
        if (inlineItems.length === 1 && inlineItems[0].type === 'paragraph') {
          looseRuns.push(...inlineItems[0].runs);
        } else {
          flushLoose();
          items.push(...inlineItems);
        }
      }
    }
    flushLoose();
    return items;
  }

  return parseInlineFlow(node, options, runs => makeTextItem('paragraph', runs));
}

export function htmlToSemanticItems(html, {
  basePath = '',
  resolvePath = defaultResolvePath,
} = {}) {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser недоступен');
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll(DROP_SELECTOR).forEach(node => node.remove());
  const options = { basePath, resolvePath };
  const items = [];
  for (const child of doc.body?.childNodes || []) items.push(...parseBlock(child, options));

  // Remove exact adjacent duplicates caused by malformed nested wrappers, but never
  // deduplicate images globally: the same illustration can legitimately repeat.
  const compact = [];
  for (const item of items) {
    const text = item.type === 'image' ? '' : runsText(item.runs);
    const prev = compact[compact.length - 1];
    const prevText = prev && prev.type !== 'image' ? runsText(prev.runs) : '';
    if (text && prev?.type === item.type && prevText === text) continue;
    compact.push(item);
  }
  return compact;
}

export function semanticItemText(item) {
  return item?.type === 'image' ? '' : runsText(item?.runs || []);
}

export function semanticItemsDiagnostics(items = []) {
  const counts = {};
  let textChars = 0;
  for (const item of items) {
    counts[item?.type || 'unknown'] = (counts[item?.type || 'unknown'] || 0) + 1;
    textChars += semanticItemText(item).replace(/\s+/g, '').length;
  }
  return {
    total: items.length,
    textChars,
    images: counts.image || 0,
    counts,
    hasRenderableContent: textChars > 0 || (counts.image || 0) > 0,
  };
}
