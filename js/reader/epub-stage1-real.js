// Stage 1 compatibility layer for real-world EPUB markup.
// Keeps the original experimental parser small and adds safe normalization for
// inline typography, figure-like wrappers and OPF cover metadata.

import {
  htmlToSemanticItems as parseSemanticBase,
  semanticItemText,
  semanticItemsDiagnostics,
} from './epub-stage1.js?v=1';

export { semanticItemText, semanticItemsDiagnostics };

const FIGURE_RE = /(?:^|[-_\s])(figure|figura|illustration|image|photo|plate)(?:[-_\s]|$)/i;
const CAPTION_RE = /caption|figcaption|legend|legende|pie[-_\s]*(?:de[-_\s]*)?figur|figur.*pie|image.*caption|photo.*caption/i;

export function resolveEpubPath(base, href) {
  if (!href) return '';
  const raw = String(href).trim().replace(/\\/g, '/');
  if (/^(?:data|blob|https?):/i.test(raw)) return raw;
  const clean = raw.split('#')[0].split('?')[0];
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch {}
  const parts = (base ? String(base).split('/') : []).concat(decoded.split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function classText(node) {
  return `${node?.getAttribute?.('class') || ''} ${node?.getAttribute?.('id') || ''}`.trim();
}

function styleMarks(node) {
  const style = String(node?.getAttribute?.('style') || '').toLowerCase();
  if (!style) return [];
  const marks = [];
  const prop = name => style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1]?.trim() || '';
  const fontStyle = prop('font-style');
  const weight = prop('font-weight');
  const decoration = prop('text-decoration(?:-line)?');
  if (/italic|oblique/.test(fontStyle)) marks.push('italic');
  if (/bold|bolder/.test(weight) || Number.parseInt(weight, 10) >= 600) marks.push('bold');
  if (/underline/.test(decoration)) marks.push('underline');
  if (/line-through/.test(decoration)) marks.push('strike');
  return marks;
}

function wrapChildren(doc, node, tag) {
  const wrapper = doc.createElement(tag);
  while (node.firstChild) wrapper.appendChild(node.firstChild);
  node.appendChild(wrapper);
}

function normalizeInlineStyles(doc) {
  for (const node of [...doc.querySelectorAll('[style]')]) {
    const marks = styleMarks(node);
    // Nest in a stable order so the base parser inherits all marks.
    if (marks.includes('strike')) wrapChildren(doc, node, 's');
    if (marks.includes('underline')) wrapChildren(doc, node, 'u');
    if (marks.includes('italic')) wrapChildren(doc, node, 'em');
    if (marks.includes('bold')) wrapChildren(doc, node, 'strong');
  }
}

function captionNodeFor(container) {
  const explicit = container.querySelector('figcaption');
  if (explicit) return explicit;
  return [...container.querySelectorAll('p,div,span,small')]
    .find(node => CAPTION_RE.test(classText(node))) || null;
}

function normalizeFigureWrappers(doc) {
  const candidates = [...doc.querySelectorAll('figure,[class],[id]')]
    .filter(node => {
      if (!node.querySelector('img,image')) return false;
      if (node.tagName?.toLowerCase() === 'figure') return true;
      return FIGURE_RE.test(classText(node)) || !!captionNodeFor(node);
    })
    // Deepest first: avoid converting an outer anchor wrapper before its real figure.
    .sort((a, b) => {
      const depth = node => { let n = 0; for (let p = node; p; p = p.parentElement) n += 1; return n; };
      return depth(b) - depth(a);
    });

  for (const container of candidates) {
    if (!container.isConnected) continue;
    if (container.closest('figure') && container.tagName?.toLowerCase() !== 'figure') continue;
    const images = [...container.querySelectorAll('img,image')];
    if (!images.length) continue;
    const captionNode = captionNodeFor(container);
    const caption = String(captionNode?.textContent || '').replace(/\s+/g, ' ').trim();
    const figure = doc.createElement('figure');
    for (const image of images) figure.appendChild(image.cloneNode(true));
    if (caption) {
      const figcaption = doc.createElement('figcaption');
      figcaption.textContent = caption;
      figure.appendChild(figcaption);
    }
    container.replaceWith(figure);
  }
}

export function normalizeRealWorldEpubHtml(html) {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser недоступен');
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,iframe,object,form,noscript,canvas').forEach(node => node.remove());
  normalizeInlineStyles(doc);
  normalizeFigureWrappers(doc);
  return doc.documentElement?.outerHTML || String(html || '');
}

export function htmlToSemanticItems(html, options = {}) {
  return parseSemanticBase(normalizeRealWorldEpubHtml(html), {
    ...options,
    resolvePath: options.resolvePath || resolveEpubPath,
  });
}

function text(root, selector) {
  return String(root.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
}

export function extractEpubPackageInfo(opfText, { opfPath = '' } = {}) {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser недоступен');
  const doc = new DOMParser().parseFromString(String(opfText || ''), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Некорректный OPF');
  const base = String(opfPath || '').split('/').slice(0, -1).join('/');
  const manifest = {};
  for (const item of doc.querySelectorAll('manifest item')) {
    const id = item.getAttribute('id') || '';
    const href = item.getAttribute('href') || '';
    if (!id || !href) continue;
    manifest[id] = {
      id,
      href: resolveEpubPath(base, href),
      mediaType: item.getAttribute('media-type') || '',
      properties: (item.getAttribute('properties') || '').split(/\s+/).filter(Boolean),
    };
  }
  const spine = [...doc.querySelectorAll('spine itemref')]
    .map(node => manifest[node.getAttribute('idref') || ''])
    .filter(Boolean);
  const coverId = [...doc.querySelectorAll('metadata meta')]
    .find(node => String(node.getAttribute('name') || '').toLowerCase() === 'cover')
    ?.getAttribute('content') || '';
  const cover = Object.values(manifest).find(item => item.properties.includes('cover-image'))
    || manifest[coverId]
    || manifest['cover-image']
    || Object.values(manifest).find(item => /^image\//i.test(item.mediaType) && /(?:^|[/_-])cover(?:[/_.-]|$)/i.test(item.href));
  const metadata = doc.querySelector('metadata') || doc;
  return {
    title: text(metadata, 'title') || text(metadata, 'dc\\:title'),
    author: text(metadata, 'creator') || text(metadata, 'dc\\:creator'),
    language: (text(metadata, 'language') || text(metadata, 'dc\\:language')).toLowerCase().split(/[-_]/)[0],
    manifest,
    spine,
    spinePaths: spine.map(item => item.href),
    htmlPaths: Object.values(manifest)
      .filter(item => /xhtml|html|xml/i.test(item.mediaType) || /\.(?:xhtml|html|htm|xml)$/i.test(item.href))
      .map(item => item.href),
    coverPath: cover?.href || '',
  };
}
