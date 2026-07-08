// Book-like page-flip reading mode — a display option alongside the default
// continuous scroll (never replaces it). The same live paragraph DOM nodes
// that scroll mode renders (translations, word taps, everything already
// bound to them) get grouped into `.rd-page` wrapper divs sized to the real
// rendered content height, and shown one at a time with a page-flip
// animation. Switching back to scroll mode unwraps everything to a flat
// list, exactly as it was.

const MODE_KEY = 'an2_reader_view_mode_v1';

function loadMode() {
  try { return localStorage.getItem(MODE_KEY) || 'scroll'; } catch { return 'scroll'; }
}
function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
}

// Race a transitionend against a timeout so a dropped/never-fired event
// (backgrounded tab, missed frame) can't leave the turn stuck forever.
function onceTransitionOrTimeout(el, handler, timeoutMs = 650) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', onEnd);
    clearTimeout(timer);
    handler();
  };
  const onEnd = (e) => { if (e.target === el && e.propertyName === 'transform') finish(); };
  el.addEventListener('transitionend', onEnd);
  const timer = setTimeout(finish, timeoutMs);
}

export function createReaderPagesMode({
  getChapterText,
  getScroller,
  getActiveParagraphIndex,
  setActiveParagraphIndex,
  onPageChange,
}) {
  let enabled = loadMode() === 'pages';
  let pages = []; // [{ start, end, el }]
  let currentPageIndex = 0;
  let animating = false;
  let resizeBound = false;
  let resizeTimer = null;

  function isEnabled() { return enabled; }

  function unwrap(chapterText) {
    const wraps = [...chapterText.querySelectorAll(':scope > .rd-page')];
    if (!wraps.length) return;
    const frag = document.createDocumentFragment();
    wraps.forEach((wrap) => {
      [...wrap.querySelectorAll(':scope > .reader-paragraph')].forEach((p) => frag.appendChild(p));
    });
    chapterText.innerHTML = '';
    chapterText.appendChild(frag);
  }

  function measurePageRanges(chapterText, scroller) {
    const paragraphs = [...chapterText.querySelectorAll(':scope > .reader-paragraph')];
    if (!paragraphs.length) return [];
    const cs = getComputedStyle(scroller);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const avail = Math.max(120, scroller.clientHeight - padTop - padBot);
    const scrollerTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const topOf = (el) => el.getBoundingClientRect().top - scrollerTop;

    const ranges = [];
    let start = 0;
    let startTop = topOf(paragraphs[0]);
    for (let i = 0; i < paragraphs.length; i++) {
      const bottom = topOf(paragraphs[i]) + paragraphs[i].getBoundingClientRect().height;
      if (i > start && bottom - startTop > avail) {
        ranges.push({ start, end: i - 1 });
        start = i;
        startTop = topOf(paragraphs[i]);
      }
    }
    ranges.push({ start, end: paragraphs.length - 1 });
    return { ranges, paragraphs };
  }

  function buildPageElements(chapterText, ranges, paragraphs) {
    return ranges.map(({ start, end }) => {
      const wrap = document.createElement('div');
      wrap.className = 'rd-page';
      for (let i = start; i <= end; i++) wrap.appendChild(paragraphs[i]);
      const fold = document.createElement('div');
      fold.className = 'rd-page-fold';
      wrap.appendChild(fold);
      chapterText.appendChild(wrap);
      return { start, end, el: wrap };
    });
  }

  function pageIndexForParagraph(idx) {
    const found = pages.findIndex((p) => idx >= p.start && idx <= p.end);
    return found === -1 ? 0 : found;
  }

  function showPageInstant(index) {
    pages.forEach((p, i) => {
      p.el.classList.toggle('rd-page-show', i === index);
      p.el.classList.toggle('rd-page-current', i === index);
      p.el.classList.remove('rd-page-flip');
    });
    currentPageIndex = index;
    onPageChange?.(currentPageIndex, pages.length);
  }

  function rebuild() {
    const chapterText = getChapterText();
    const scroller = getScroller();
    if (!chapterText || !scroller) return;
    const readingView = scroller.closest('#reader-reading-view');

    unwrap(chapterText);
    if (!enabled) {
      scroller.classList.remove('rd-pages-mode');
      readingView?.classList.remove('rd-pages-active');
      return;
    }

    const { ranges, paragraphs } = measurePageRanges(chapterText, scroller) || {};
    if (!ranges || !ranges.length) { scroller.classList.remove('rd-pages-mode'); readingView?.classList.remove('rd-pages-active'); return; }

    pages = buildPageElements(chapterText, ranges, paragraphs);
    scroller.classList.add('rd-pages-mode');
    readingView?.classList.add('rd-pages-active');
    animating = false;
    showPageInstant(pageIndexForParagraph(getActiveParagraphIndex()));
  }

  // Cheap path for renders that only moved the active paragraph within the
  // same already-built page structure (fast-nav) — no re-measure needed,
  // just jump to whichever page now contains the active paragraph.
  function resync() {
    if (!enabled || !pages.length) return;
    const target = pageIndexForParagraph(getActiveParagraphIndex());
    if (target !== currentPageIndex) showPageInstant(target);
  }

  function syncAfterRender({ full }) {
    if (full) rebuild();
    else resync();
  }

  function turn(delta) {
    if (!enabled || animating) return false;
    const target = currentPageIndex + delta;
    if (target < 0 || target >= pages.length) return false;
    const curPage = pages[currentPageIndex];
    const nextPage = pages[target];
    // Guard against a stale `pages` array (e.g. a rebuild landed between this
    // call being scheduled and running) — without this, a missing .el would
    // throw after `animating` is already true, leaving it stuck forever and
    // every future tap/swipe silently doing nothing ("иногда не листается").
    if (!curPage?.el || !nextPage?.el) return false;
    animating = true;
    try {
      nextPage.el.classList.add('rd-page-show');
      requestAnimationFrame(() => curPage.el.classList.add('rd-page-flip'));
      onceTransitionOrTimeout(curPage.el, () => {
        curPage.el.classList.remove('rd-page-show', 'rd-page-current', 'rd-page-flip');
        nextPage.el.classList.add('rd-page-current');
        currentPageIndex = target;
        animating = false;
        onPageChange?.(currentPageIndex, pages.length);
        setActiveParagraphIndex(pages[target].start);
      });
    } catch (_) {
      animating = false;
      return false;
    }
    return true;
  }

  function next() { return turn(1); }
  function prev() { return turn(-1); }

  function setMode(mode) {
    enabled = mode === 'pages';
    saveMode(mode);
    rebuild();
    return enabled;
  }
  function toggleMode() { return setMode(enabled ? 'scroll' : 'pages'); }

  function handleResize() {
    if (!enabled) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 150);
  }
  function bindResize() {
    if (resizeBound) return;
    resizeBound = true;
    window.addEventListener('resize', handleResize);
  }
  bindResize();

  return { isEnabled, syncAfterRender, next, prev, setMode, toggleMode, handleResize };
}
