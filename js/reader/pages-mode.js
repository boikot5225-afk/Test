// Book-like page-flip reading mode — a display option alongside the default
// continuous scroll (never replaces it). The same live paragraph DOM nodes
// that scroll mode renders (translations, word taps, everything already
// bound to them) get grouped into `.rd-page` wrapper divs sized to the real
// rendered content height, and shown one at a time with a page-flip
// animation. Switching back to scroll mode unwraps everything to a flat
// list, exactly as it was.

const MODE_KEY = 'an2_reader_view_mode_v1';
const ANIMATION_KEY = 'an2_reader_page_animation_v1';
const PAGE_ANIMATIONS = new Set(['flip', 'slide', 'stack', 'fade', 'none']);

export function normalizePageAnimation(value) {
  const normalized = String(value || 'flip').trim().toLowerCase();
  return PAGE_ANIMATIONS.has(normalized) ? normalized : 'flip';
}

function loadMode() {
  try { return localStorage.getItem(MODE_KEY) || 'scroll'; } catch { return 'scroll'; }
}
function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
}
function loadAnimation() {
  try { return normalizePageAnimation(localStorage.getItem(ANIMATION_KEY)); }
  catch { return 'flip'; }
}
function saveAnimation(animation) {
  try { localStorage.setItem(ANIMATION_KEY, normalizePageAnimation(animation)); } catch {}
}
function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
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
  let animation = loadAnimation();
  let pages = []; // [{ start, end, el }]
  let currentPageIndex = 0;
  let animating = false;
  let resizeBound = false;
  let resizeTimer = null;
  let lastMeasuredWidth = 0;
  let lastMeasuredHeight = 0;
  const turnClasses = [
    'rd-page-in', 'rd-page-in-active', 'rd-page-out',
    'rd-page-forward', 'rd-page-backward', 'rd-page-flip',
  ];

  function isEnabled() { return enabled; }
  function getAnimation() { return animation; }

  function clearTurnClasses(element) {
    element?.classList.remove(...turnClasses);
  }

  function unwrap(chapterText) {
    const wraps = [...chapterText.querySelectorAll(':scope > .rd-page')];
    if (!wraps.length) return;
    const frag = document.createDocumentFragment();
    wraps.forEach((wrap) => {
      [...wrap.querySelectorAll(':scope > .reader-paragraph')].forEach((p) => frag.appendChild(p));
    });
    chapterText.replaceChildren(frag);
  }

  function measurePageRanges(chapterText, scroller) {
    const paragraphs = [...chapterText.querySelectorAll(':scope > .reader-paragraph')];
    if (!paragraphs.length) return [];
    const cs = getComputedStyle(scroller);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const avail = Math.max(120, scroller.clientHeight - padTop - padBot);
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top - scroller.scrollTop;

    // One geometry read per paragraph. The previous implementation called
    // getBoundingClientRect() two or three times for the same node; on a large
    // WebView DOM that needlessly multiplied layout-query overhead.
    const rects = paragraphs.map((el) => {
      const rect = el.getBoundingClientRect();
      const top = rect.top - scrollerTop;
      return { top, bottom: top + rect.height };
    });

    const ranges = [];
    let start = 0;
    let startTop = rects[0].top;
    for (let i = 0; i < paragraphs.length; i++) {
      const bottom = rects[i].bottom;
      if (i > start && bottom - startTop > avail) {
        ranges.push({ start, end: i - 1 });
        start = i;
        startTop = rects[i].top;
      }
    }
    ranges.push({ start, end: paragraphs.length - 1 });
    lastMeasuredWidth = scroller.clientWidth;
    lastMeasuredHeight = scroller.clientHeight;
    return { ranges, paragraphs };
  }

  function buildPageElements(chapterText, ranges, paragraphs) {
    const fragment = document.createDocumentFragment();
    const nextPages = ranges.map(({ start, end }) => {
      const wrap = document.createElement('div');
      wrap.className = 'rd-page';
      for (let i = start; i <= end; i++) wrap.appendChild(paragraphs[i]);
      const fold = document.createElement('div');
      fold.className = 'rd-page-fold';
      wrap.appendChild(fold);
      fragment.appendChild(wrap);
      return { start, end, el: wrap };
    });
    // One connected-tree insertion instead of appending every page wrapper
    // separately. Paragraphs are moved while wrappers are detached.
    chapterText.appendChild(fragment);
    return nextPages;
  }

  function pageIndexForParagraph(idx) {
    const found = pages.findIndex((p) => idx >= p.start && idx <= p.end);
    return found === -1 ? 0 : found;
  }

  function showPageInstant(index) {
    pages.forEach((p, i) => {
      p.el.classList.toggle('rd-page-show', i === index);
      p.el.classList.toggle('rd-page-current', i === index);
      clearTurnClasses(p.el);
    });
    currentPageIndex = index;
    onPageChange?.(currentPageIndex, pages.length);
  }

  function rebuild() {
    const chapterText = getChapterText();
    const scroller = getScroller();
    if (!chapterText || !scroller) return;
    const readingView = scroller.closest('#reader-reading-view');
    scroller.dataset.rdPageAnimation = animation;

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
    if (!curPage?.el || !nextPage?.el) return false;
    const directionClass = delta > 0 ? 'rd-page-forward' : 'rd-page-backward';
    const finishTurn = () => {
      curPage.el.classList.remove('rd-page-show', 'rd-page-current');
      clearTurnClasses(curPage.el);
      clearTurnClasses(nextPage.el);
      nextPage.el.classList.add('rd-page-show', 'rd-page-current');
      currentPageIndex = target;
      animating = false;
      onPageChange?.(currentPageIndex, pages.length);
      setActiveParagraphIndex(pages[target].start);
    };

    animating = true;
    try {
      clearTurnClasses(curPage.el);
      clearTurnClasses(nextPage.el);
      curPage.el.classList.add(directionClass);
      nextPage.el.classList.add('rd-page-show', 'rd-page-in', directionClass);

      if (animation === 'none' || prefersReducedMotion()) {
        finishTurn();
        return true;
      }

      // One intentional layout read to commit the incoming page's starting
      // transform before activating both transitions.
      void nextPage.el.offsetWidth;
      requestAnimationFrame(() => {
        curPage.el.classList.add('rd-page-out');
        nextPage.el.classList.add('rd-page-in-active');
      });
      const timeout = animation === 'flip' ? 620 : animation === 'fade' ? 380 : 500;
      onceTransitionOrTimeout(curPage.el, finishTurn, timeout);
    } catch (_) {
      animating = false;
      clearTurnClasses(curPage.el);
      clearTurnClasses(nextPage.el);
      nextPage.el.classList.remove('rd-page-show', 'rd-page-current');
      curPage.el.classList.add('rd-page-show', 'rd-page-current');
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

  function setAnimation(value) {
    animation = normalizePageAnimation(value);
    saveAnimation(animation);
    const scroller = getScroller();
    if (scroller) scroller.dataset.rdPageAnimation = animation;
    return animation;
  }

  function handleResize() {
    if (!enabled) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const scroller = getScroller();
      if (!scroller) return;
      // Ignore tiny viewport jitter from browser/UI chrome. A real rotate,
      // window resize or keyboard change is still large enough to repaginate.
      const dw = Math.abs(scroller.clientWidth - lastMeasuredWidth);
      const dh = Math.abs(scroller.clientHeight - lastMeasuredHeight);
      if (lastMeasuredWidth && lastMeasuredHeight && dw < 8 && dh < 24) return;
      if (animating) {
        handleResize();
        return;
      }
      rebuild();
    }, 240);
  }
  function bindResize() {
    if (resizeBound) return;
    resizeBound = true;
    window.addEventListener('resize', handleResize);
  }
  bindResize();

  return { isEnabled, getAnimation, syncAfterRender, next, prev, setMode, toggleMode, setAnimation, handleResize };
}
