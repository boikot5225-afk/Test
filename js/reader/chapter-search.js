const STYLE_ID = 'reader-chapter-search-style';
const PANEL_ID = 'reader-chapter-search-panel';
const MAX_MATCHES = 1000;

let installed = false;
let getCurrentBook = () => null;
let matches = [];
let activeIndex = -1;
let query = '';
let inputTimer = null;

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      position: absolute;
      top: calc(var(--rd-top-h, 64px) + 7px);
      left: 10px;
      right: 10px;
      z-index: 18;
      display: none;
      grid-template-columns: minmax(0, 1fr) auto auto auto auto;
      align-items: center;
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 13px;
      background: color-mix(in srgb, var(--surface) 96%, transparent);
      box-shadow: 0 9px 30px rgba(32, 23, 15, .22);
      backdrop-filter: blur(10px);
      font-family: 'IBM Plex Sans', sans-serif;
    }
    #${PANEL_ID}.open { display: grid; }
    #${PANEL_ID} input {
      width: 100%;
      min-width: 0;
      height: 38px;
      padding: 7px 10px;
      border: 1px solid var(--border);
      border-radius: 9px;
      outline: none;
      background: var(--bg);
      color: var(--text);
      font: inherit;
      font-size: .88rem;
    }
    #${PANEL_ID} input:focus { border-color: var(--accent); }
    #${PANEL_ID} .reader-search-count {
      min-width: 48px;
      color: var(--text-muted);
      font-size: .74rem;
      text-align: center;
      white-space: nowrap;
    }
    #${PANEL_ID} button {
      width: 38px;
      height: 38px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: var(--bg);
      color: var(--text);
      font: inherit;
      font-size: 1rem;
      cursor: pointer;
    }
    #${PANEL_ID} button:disabled { opacity: .4; cursor: default; }
    #reader-reading-view.rd-search-open .rd-top {
      transform: none !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    #reader-chapter-text mark.reader-search-hit {
      padding: 0;
      border-radius: .18em;
      background: color-mix(in srgb, #ffd54a 58%, transparent);
      color: inherit;
      box-shadow: 0 0 0 1px color-mix(in srgb, #b98500 28%, transparent);
    }
    #reader-chapter-text mark.reader-search-hit.current {
      background: color-mix(in srgb, #ff9f1c 76%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, #9b4f00 45%, transparent);
    }
    #reader-chapter-text .reader-search-current-paragraph {
      border-left-color: var(--accent) !important;
    }
    @media (max-width: 520px) {
      #${PANEL_ID} {
        left: 6px;
        right: 6px;
        grid-template-columns: minmax(0, 1fr) auto auto auto;
        gap: 5px;
      }
      #${PANEL_ID} .reader-search-count {
        grid-column: 1 / -1;
        grid-row: 2;
        min-width: 0;
        text-align: left;
        padding: 0 4px 1px;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensurePanel() {
  ensureStyles();
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  const view = document.getElementById('reader-reading-view');
  if (!view) return null;
  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'search');
  panel.setAttribute('aria-label', 'Поиск в текущей главе');
  panel.innerHTML = `
    <input type="search" autocomplete="off" enterkeyhint="search" placeholder="Слово или фраза в этой главе" aria-label="Текст для поиска">
    <span class="reader-search-count" aria-live="polite">0/0</span>
    <button type="button" class="reader-search-prev" title="Предыдущее совпадение" aria-label="Предыдущее совпадение">↑</button>
    <button type="button" class="reader-search-next" title="Следующее совпадение" aria-label="Следующее совпадение">↓</button>
    <button type="button" class="reader-search-close" title="Закрыть поиск" aria-label="Закрыть поиск">×</button>`;
  view.appendChild(panel);

  const input = panel.querySelector('input');
  input?.addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => runChapterSearch(input.value), 90);
  });
  input?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeChapterSearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      moveChapterSearch(event.shiftKey ? -1 : 1);
    }
  });
  panel.querySelector('.reader-search-prev')?.addEventListener('click', () => moveChapterSearch(-1));
  panel.querySelector('.reader-search-next')?.addEventListener('click', () => moveChapterSearch(1));
  panel.querySelector('.reader-search-close')?.addEventListener('click', closeChapterSearch);
  return panel;
}

function clearHighlights() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const parents = new Set();
  for (const mark of [...root.querySelectorAll('mark.reader-search-hit')]) {
    const parent = mark.parentNode;
    if (parent) parents.add(parent);
    mark.replaceWith(...mark.childNodes);
  }
  parents.forEach(parent => parent.normalize?.());
  root.querySelectorAll('.reader-search-current-paragraph').forEach(node => node.classList.remove('reader-search-current-paragraph'));
}

function eligibleTextNodes(root) {
  const walker = document.createTreeWalker(root, window.NodeFilter?.SHOW_TEXT ?? 4);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!node.nodeValue || !parent) continue;
    if (parent.closest('button,script,style,mark.reader-search-hit,.reader-footnote-ref')) continue;
    nodes.push(node);
  }
  return nodes;
}

function foldedParagraph(root) {
  let folded = '';
  const positions = [];
  let previousWasSpace = false;
  for (const node of eligibleTextNodes(root)) {
    const value = String(node.nodeValue || '');
    for (let offset = 0; offset < value.length;) {
      const point = value.codePointAt(offset);
      const char = String.fromCodePoint(point);
      const width = char.length;
      const isSpace = /\s/u.test(char);
      if (isSpace) {
        if (!previousWasSpace) {
          folded += ' ';
          positions.push({ node, start: offset, end: offset + width });
          previousWasSpace = true;
        }
        offset += width;
        continue;
      }
      const normalized = char.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
      for (let i = 0; i < normalized.length; i += 1) {
        folded += normalized[i];
        positions.push({ node, start: offset, end: offset + width });
      }
      previousWasSpace = false;
      offset += width;
    }
  }
  return { folded, positions };
}

function segmentsForMatch(positions, start, end) {
  const segments = [];
  for (let i = start; i < end; i += 1) {
    const position = positions[i];
    if (!position) continue;
    const previous = segments[segments.length - 1];
    if (previous?.node === position.node) {
      previous.end = Math.max(previous.end, position.end);
    } else {
      segments.push({ ...position });
    }
  }
  return segments;
}

function collectMatches(needle) {
  const root = document.getElementById('reader-chapter-text');
  if (!root || !needle) return [];
  const found = [];
  for (const paragraph of [...root.querySelectorAll('.reader-paragraph')]) {
    const textRoot = paragraph.querySelector('.reader-paragraph-text') || paragraph;
    const { folded, positions } = foldedParagraph(textRoot);
    let cursor = 0;
    while (cursor <= folded.length - needle.length && found.length < MAX_MATCHES) {
      const index = folded.indexOf(needle, cursor);
      if (index < 0) break;
      const segments = segmentsForMatch(positions, index, index + needle.length);
      if (segments.length) {
        found.push({
          id: String(found.length),
          paragraphIndex: Number(paragraph.dataset.p),
          segments,
        });
      }
      cursor = index + Math.max(needle.length, 1);
    }
    if (found.length >= MAX_MATCHES) break;
  }
  return found;
}

function renderHighlights(found) {
  const byNode = new Map();
  for (const hit of found) {
    for (const segment of hit.segments) {
      const rows = byNode.get(segment.node) || [];
      rows.push({ ...segment, hitId: hit.id });
      byNode.set(segment.node, rows);
    }
  }
  for (const [node, segments] of byNode) {
    segments.sort((a, b) => b.start - a.start || b.end - a.end);
    for (const segment of segments) {
      if (!node.isConnected || segment.end <= segment.start) continue;
      const range = document.createRange();
      range.setStart(node, segment.start);
      range.setEnd(node, segment.end);
      const mark = document.createElement('mark');
      mark.className = 'reader-search-hit';
      mark.dataset.readerSearchHit = segment.hitId;
      try { range.surroundContents(mark); } catch {}
    }
  }
}

function updateControls() {
  const panel = ensurePanel();
  if (!panel) return;
  const count = panel.querySelector('.reader-search-count');
  if (count) {
    if (!query) count.textContent = 'Введите слово или фразу';
    else if (!matches.length) count.textContent = 'Не найдено';
    else count.textContent = `${activeIndex + 1}/${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}`;
  }
  const disabled = !matches.length;
  const prev = panel.querySelector('.reader-search-prev');
  const next = panel.querySelector('.reader-search-next');
  if (prev) prev.disabled = disabled;
  if (next) next.disabled = disabled;
}

function markActiveMatch({ selectParagraph = false } = {}) {
  const root = document.getElementById('reader-chapter-text');
  const hit = matches[activeIndex];
  if (!root || !hit) {
    updateControls();
    return false;
  }

  root.querySelectorAll('mark.reader-search-hit.current').forEach(node => node.classList.remove('current'));
  root.querySelectorAll('.reader-search-current-paragraph').forEach(node => node.classList.remove('reader-search-current-paragraph'));

  if (selectParagraph && Number.isFinite(hit.paragraphIndex)) {
    const book = getCurrentBook?.();
    if (Number(book?.currentParagraph) !== hit.paragraphIndex) {
      try { window.readerSelectParagraph?.(hit.paragraphIndex); } catch {}
    }
  }

  const liveRoot = document.getElementById('reader-chapter-text');
  const selector = `mark.reader-search-hit[data-reader-search-hit="${hit.id}"]`;
  const marks = [...(liveRoot?.querySelectorAll(selector) || [])];
  marks.forEach(node => node.classList.add('current'));
  const paragraph = marks[0]?.closest('.reader-paragraph')
    || liveRoot?.querySelector(`.reader-paragraph[data-p="${hit.paragraphIndex}"]`);
  paragraph?.classList.add('reader-search-current-paragraph');
  setTimeout(() => (marks[0] || paragraph)?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' }), 20);
  updateControls();
  return true;
}

export function runChapterSearch(value, { preserveIndex = false, navigate = true } = {}) {
  clearTimeout(inputTimer);
  const previousIndex = activeIndex;
  clearHighlights();
  query = foldText(value);
  matches = query ? collectMatches(query) : [];
  renderHighlights(matches);
  activeIndex = matches.length ? (preserveIndex ? Math.max(0, Math.min(previousIndex, matches.length - 1)) : 0) : -1;
  updateControls();
  if (activeIndex >= 0) markActiveMatch({ selectParagraph: navigate });
  return matches.length;
}

export function moveChapterSearch(delta = 1) {
  if (!matches.length) return false;
  activeIndex = (activeIndex + (delta < 0 ? -1 : 1) + matches.length) % matches.length;
  return markActiveMatch({ selectParagraph: true });
}

export function openChapterSearch() {
  const panel = ensurePanel();
  const view = document.getElementById('reader-reading-view');
  if (!panel || !view) return false;
  view.classList.remove('rd-chrome-hidden');
  view.classList.add('rd-search-open');
  document.getElementById('reader-search-btn')?.classList.add('on');
  panel.classList.add('open');
  const input = panel.querySelector('input');
  requestAnimationFrame(() => {
    input?.focus();
    input?.select();
  });
  if (input?.value) runChapterSearch(input.value, { preserveIndex: true, navigate: false });
  else updateControls();
  return true;
}

export function closeChapterSearch() {
  clearTimeout(inputTimer);
  const panel = document.getElementById(PANEL_ID);
  const input = panel?.querySelector('input');
  if (input) input.value = '';
  panel?.classList.remove('open');
  document.getElementById('reader-reading-view')?.classList.remove('rd-search-open');
  document.getElementById('reader-search-btn')?.classList.remove('on');
  query = '';
  matches = [];
  activeIndex = -1;
  clearHighlights();
  updateControls();
}

export function toggleChapterSearch() {
  const panel = ensurePanel();
  if (!panel) return false;
  if (panel.classList.contains('open')) {
    closeChapterSearch();
    return false;
  }
  return openChapterSearch();
}

export function refreshChapterSearchAfterRender() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel?.classList.contains('open') || !query) return;
  const input = panel.querySelector('input');
  runChapterSearch(input?.value || query, { preserveIndex: true, navigate: false });
}

export function installChapterSearch(options = {}) {
  if (typeof options.getCurrentBook === 'function') getCurrentBook = options.getCurrentBook;
  ensurePanel();
  if (installed) return;
  installed = true;
  window.readerToggleChapterSearch = toggleChapterSearch;
  window.readerOpenChapterSearch = openChapterSearch;
  window.readerCloseChapterSearch = closeChapterSearch;
  window.readerMoveChapterSearch = moveChapterSearch;
}

export function chapterSearchDebugState() {
  return { query, matchCount: matches.length, activeIndex };
}
