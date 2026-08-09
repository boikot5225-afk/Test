import { resolveEpubPath } from './epub-stage1-real.js?v=2';

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanPath(value) {
  let out = String(value || '').replace(/^\/+/, '').replace(/\\/g, '/');
  try { out = decodeURIComponent(out); } catch {}
  return out;
}

function localName(node) {
  return String(node?.localName || node?.tagName || '').toLowerCase();
}

function directChildren(node, name) {
  const wanted = String(name || '').toLowerCase();
  return [...(node?.children || [])].filter(child => localName(child) === wanted);
}

function firstDescendantByLocalName(node, name) {
  if (!node) return null;
  const wanted = String(name || '').toLowerCase();
  for (const child of [...(node.children || [])]) {
    if (localName(child) === wanted) return child;
    const nested = firstDescendantByLocalName(child, wanted);
    if (nested) return nested;
  }
  return null;
}

function splitHref(rawHref, navigationPath) {
  const raw = String(rawHref || '').trim().replace(/\\/g, '/');
  if (!raw || /^(?:https?:|mailto:|tel:|javascript:|data:|blob:)/i.test(raw)) {
    return { href: raw, sourcePath: '', fragment: '', external: !!raw };
  }

  const hashIndex = raw.indexOf('#');
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const rawFragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';
  const pathPart = beforeHash.split('?')[0];
  const base = cleanPath(navigationPath).split('/').slice(0, -1).join('/');
  const sourcePath = pathPart
    ? cleanPath(resolveEpubPath(base, pathPart))
    : cleanPath(navigationPath);
  let fragment = rawFragment;
  try { fragment = decodeURIComponent(fragment); } catch {}

  return {
    href: raw,
    sourcePath,
    fragment: fragment.trim(),
    external: false,
  };
}

function normalizeEntries(items) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const title = cleanText(raw?.title);
    if (!title) continue;
    const depth = Math.max(0, Number(raw?.depth) || 0);
    const sourcePath = cleanPath(raw?.sourcePath);
    const fragment = String(raw?.fragment || '').trim();
    const key = `${depth}|${title}|${sourcePath}|${fragment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `toc_${out.length}`,
      title,
      href: String(raw?.href || ''),
      sourcePath,
      fragment,
      depth,
      hasChildren: !!raw?.hasChildren,
      external: !!raw?.external,
    });
  }
  return out;
}

function navType(node) {
  return cleanText(
    node?.getAttribute?.('epub:type')
    || node?.getAttribute?.('type')
    || node?.getAttribute?.('role')
    || '',
  ).toLowerCase();
}

function parseEpub3Nav(html, navigationPath) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const navs = [...(doc.querySelectorAll?.('nav') || [])];
  if (!navs.length) return [];
  const tocNav = navs.find(nav => /(?:^|\s)(?:toc|doc-toc)(?:\s|$)/.test(navType(nav))) || navs[0];
  const firstOl = directChildren(tocNav, 'ol')[0] || firstDescendantByLocalName(tocNav, 'ol');
  if (!firstOl) return [];

  const rows = [];
  function walkList(ol, depth) {
    for (const li of directChildren(ol, 'li')) {
      const ownChildren = [...(li.children || [])];
      let labelNode = ownChildren.find(node => localName(node) === 'a' && node.hasAttribute?.('href'))
        || ownChildren.find(node => ['span', 'a'].includes(localName(node)))
        || null;
      if (!labelNode) {
        labelNode = firstDescendantByLocalName(li, 'a') || firstDescendantByLocalName(li, 'span');
      }
      const title = cleanText(labelNode?.textContent || '');
      const href = labelNode?.getAttribute?.('href') || '';
      const childLists = directChildren(li, 'ol');
      if (title) {
        rows.push({
          title,
          depth,
          hasChildren: childLists.length > 0,
          ...splitHref(href, navigationPath),
        });
      }
      for (const child of childLists) walkList(child, depth + 1);
    }
  }
  walkList(firstOl, 0);
  return normalizeEntries(rows);
}

function firstXmlChild(node, name) {
  const wanted = String(name || '').toLowerCase();
  return [...(node?.children || [])].find(child => localName(child) === wanted) || null;
}

function firstXmlDescendant(node, name) {
  if (!node) return null;
  const all = node.getElementsByTagNameNS?.('*', name);
  return all?.[0] || firstDescendantByLocalName(node, name);
}

function parseNcx(xmlText, navigationPath) {
  const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml');
  if (doc.querySelector?.('parsererror')) return [];
  const navMap = doc.getElementsByTagNameNS?.('*', 'navMap')?.[0]
    || firstDescendantByLocalName(doc.documentElement, 'navmap');
  if (!navMap) return [];

  const rows = [];
  function walkPoint(point, depth) {
    const navLabel = firstXmlChild(point, 'navlabel') || firstXmlDescendant(point, 'navlabel');
    const label = firstXmlDescendant(navLabel || point, 'text');
    const content = firstXmlChild(point, 'content') || firstXmlDescendant(point, 'content');
    const title = cleanText(label?.textContent || '');
    const href = content?.getAttribute?.('src') || '';
    const children = directChildren(point, 'navpoint');
    if (title) {
      rows.push({
        title,
        depth,
        hasChildren: children.length > 0,
        ...splitHref(href, navigationPath),
      });
    }
    for (const child of children) walkPoint(child, depth + 1);
  }
  for (const point of directChildren(navMap, 'navpoint')) walkPoint(point, 0);
  return normalizeEntries(rows);
}

function inferredHtmlDepth(link) {
  for (let node = link; node; node = node.parentElement) {
    const cls = String(node.getAttribute?.('class') || '');
    const match = cls.match(/(?:toc|contents?)[-_\s]*(\d+)(?:[-_\s]*level)?/i)
      || cls.match(/(?:level|lvl)[-_\s]*(\d+)/i);
    if (match) return Math.max(0, Number(match[1]) - 1);
  }
  let listDepth = 0;
  for (let node = link.parentElement; node; node = node.parentElement) {
    if (['ol', 'ul'].includes(localName(node))) listDepth += 1;
  }
  return Math.max(0, listDepth - 1);
}

function parseHtmlToc(html, navigationPath) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const rows = [];
  for (const link of [...(doc.querySelectorAll?.('a[href]') || [])]) {
    const title = cleanText(link.textContent || '');
    const href = link.getAttribute('href') || '';
    if (!title || !href || /^(?:https?:|mailto:|tel:|javascript:)/i.test(href)) continue;
    rows.push({
      title,
      depth: inferredHtmlDepth(link),
      hasChildren: false,
      ...splitHref(href, navigationPath),
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    rows[index].hasChildren = index + 1 < rows.length && rows[index + 1].depth > rows[index].depth;
  }
  return normalizeEntries(rows);
}

function navigationCandidates(packageInfo = {}) {
  const manifest = Object.values(packageInfo.manifest || {});
  const nav = manifest.filter(item => (item.properties || []).includes('nav'));
  const ncx = manifest.filter(item => /application\/x-dtbncx\+xml/i.test(item.mediaType || '') || /\.ncx$/i.test(item.href || ''));
  const html = manifest.filter(item => {
    const href = String(item.href || '');
    const id = String(item.id || '');
    const isHtml = /xhtml|html/i.test(item.mediaType || '') || /\.(?:xhtml|html|htm)$/i.test(href);
    return isHtml && /(?:^|[/_.-])(?:toc|contents?|navigation|nav)(?:[/_.-]|$)/i.test(`${id}/${href}`);
  });
  return { nav, ncx, html };
}

export async function extractCanonicalEpubToc(entries, packageInfo = {}) {
  if (!entries || typeof DOMParser === 'undefined') return [];
  const { nav, ncx, html } = navigationCandidates(packageInfo);

  for (const item of nav) {
    const path = cleanPath(item.href);
    if (!path || !entries.has(path)) continue;
    try {
      const parsed = parseEpub3Nav(await entries.get(path).text(), path);
      if (parsed.length) return parsed;
    } catch (error) {
      console.warn('[reader epub toc] EPUB3 nav parse failed', path, error?.message || error);
    }
  }

  for (const item of ncx) {
    const path = cleanPath(item.href);
    if (!path || !entries.has(path)) continue;
    try {
      const parsed = parseNcx(await entries.get(path).text(), path);
      if (parsed.length) return parsed;
    } catch (error) {
      console.warn('[reader epub toc] NCX parse failed', path, error?.message || error);
    }
  }

  for (const item of html) {
    const path = cleanPath(item.href);
    if (!path || !entries.has(path)) continue;
    try {
      const parsed = parseHtmlToc(await entries.get(path).text(), path);
      if (parsed.length) return parsed;
    } catch (error) {
      console.warn('[reader epub toc] HTML TOC parse failed', path, error?.message || error);
    }
  }
  return [];
}

export function mapEpubTocToChapters(toc = [], chapters = []) {
  const byPath = new Map();
  (chapters || []).forEach((chapter, index) => {
    const path = cleanPath(chapter?.sourcePath);
    if (path && !byPath.has(path)) byPath.set(path, index);
  });

  const mapped = (toc || []).map((item, index) => {
    const path = cleanPath(item?.sourcePath);
    const chapterIndex = path && byPath.has(path) ? byPath.get(path) : null;
    return {
      id: item?.id || `toc_${index}`,
      title: cleanText(item?.title) || `Раздел ${index + 1}`,
      href: String(item?.href || ''),
      sourcePath: path,
      fragment: String(item?.fragment || ''),
      depth: Math.max(0, Number(item?.depth) || 0),
      hasChildren: !!item?.hasChildren,
      external: !!item?.external,
      chapterIndex,
      unavailable: chapterIndex == null && !!path,
    };
  });

  return mapped.length ? mapped : fallbackTocFromChapters(chapters);
}

export function fallbackTocFromChapters(chapters = []) {
  return (chapters || []).map((chapter, chapterIndex) => ({
    id: `toc_fallback_${chapterIndex}`,
    title: cleanText(chapter?.title) || `Глава ${chapterIndex + 1}`,
    href: '',
    sourcePath: cleanPath(chapter?.sourcePath),
    fragment: '',
    depth: 0,
    hasChildren: false,
    external: false,
    chapterIndex,
    unavailable: false,
  }));
}

export function applyCanonicalTocTitles(chapters = [], toc = []) {
  const firstByChapter = new Map();
  for (const item of toc || []) {
    const chapterIndex = item?.chapterIndex;
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= chapters.length) continue;
    if (!firstByChapter.has(chapterIndex) && cleanText(item?.title)) firstByChapter.set(chapterIndex, cleanText(item.title));
  }
  for (const [chapterIndex, title] of firstByChapter) {
    chapters[chapterIndex].title = title;
    chapters[chapterIndex].tocTitle = title;
  }
  return chapters;
}
