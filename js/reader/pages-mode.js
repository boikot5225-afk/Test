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
  let pages = [];
  let currentPageIndex = 0;
  let animating = false;
  let resizeBound = false;
  let resizeTimer = null;
  let lastMeasuredWidth = 0;
  let lastMeasuredHeight = 0;
  // After a real chapter measurement, hint/data changes and Android system-bar
  // height noise must not reshuffle paragraph boundaries. Explicit full renders
  // and real width changes still invalidate the freeze.
  let paginationFrozen = false;
  // Every full chapter/pagination rebuild invalidates callbacks captured by an
  // older page-turn animation. Android WebView can finish transitionend/timeout
  // after a TOC jump has already replaced the entire chapter DOM; without a
  // generation check that stale callback writes an old page cursor into the new
  // chapter and triggers a render back at the previous reading position.
  let paginationGeneration = 0;
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

    // Long chapters first paint only a small window and leave lightweight
    // paragraph shells to be filled during idle time. Empty shells have no real
    // height, so measuring them would cram hundreds into one fake page and then
    // let that page explode as text arrives. Until back-fill finishes, use one
    // paragraph per temporary page: stable, cheap, and immediately navigable.
    // chapter-render-next asks for one proper repagination after the last shell
    // is filled, at which point the normal height-based grouping below takes over.
    if (paragraphs.some((el) => el.dataset.readerPending === '1')) {
      lastMeasuredWidth = scroller.clientWidth;
      lastMeasuredHeight = scroller.clientHeight;
      return {
        ranges: paragraphs.map((_, index) => ({ start: index, end: index })),
        paragraphs,
      };
    }

    const cs = getComputedStyle(scroller);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const avail = Math.max(120, scroller.clientHeight - padTop - padBot);
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top - scroller.scrollTop;

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
    try {
      window.dispatchEvent(new CustomEvent('reader:pagechange', {
        detail: { pageIndex: currentPageIndex, pageCount: pages.length },
      }));
    } catch {}
  }

  function rebuild() {
    // Invalidate any transitionend/timeout callback that was created against
    // the previous wrappers before touching the DOM.
    paginationGeneration += 1;
    const chapterText = getChapterText();
    const scroller = getScroller();
    if (!chapterText || !scroller) return;
    const readingView = scroller.closest('#reader-reading-view');
    scroller.dataset.rdPageAnimation = animation;

    unwrap(chapterText);
    // Chinese annotation slots must exist before getBoundingClientRect() is ever
    // used for page grouping. Later hint text is out-of-flow and cannot resize it.
    try { globalThis.readerPrepareZhStableSlots?.(chapterText); } catch (error) {
      console.warn('[reader pages] stable Chinese slot preparation failed', error?.message || error);
    }
    // English uses the same rule: reserve the translation lane before measuring
    // page ranges. The helper is a no-op for every non-English book.
    try { globalThis.readerPrepareEnStableSlots?.(chapterText); } catch (error) {
      console.warn('[reader pages] stable English slot preparation failed', error?.message || error);
    }
    if (!enabled) {
      scroller.classList.remove('rd-pages-mode');
      readingView?.classList.remove('rd-pages-active');
      pages = [];
      currentPageIndex = 0;
      animating = false;
      paginationFrozen = false;
      return;
    }

    const { ranges, paragraphs } = measurePageRanges(chapterText, scroller) || {};
    if (!ranges || !ranges.length) {
      pages = [];
      currentPageIndex = 0;
      animating = false;
      scroller.classList.remove('rd-pages-mode');
      readingView?.classList.remove('rd-pages-active');
      return;
    }

    pages = buildPageElements(chapterText, ranges, paragraphs);
    scroller.classList.add('rd-pages-mode');
    readingView?.classList.add('rd-pages-active');
    animating = false;
    paginationFrozen = true;
    showPageInstant(pageIndexForParagraph(getActiveParagraphIndex()));
  }

  // A TOC jump rebuilds the chapter DOM wholesale. On the real Android build
  // there was a race where the visible DOM had already switched to the new
  // chapter while this object still held `.rd-page` nodes from the previous
  // one. `next()` then saw an apparently valid pages array, tried to animate
  // detached elements, returned false, and every press of ▶ became a no-op.
  // Validate the live DOM at the moment of the turn instead of trusting cached
  // wrappers from the previous render.
  function ensureLivePagesForTurn() {
    if (!enabled) return;
    const chapterText = getChapterText();
    if (!chapterText) return;

    const livePages = [...chapterText.querySelectorAll(':scope > .rd-page')];
    const cachedDisconnected = pages.some((page) => !page?.el?.isConnected || page.el.parentElement !== chapterText);
    const currentConnected = pages[currentPageIndex]?.el?.isConnected;
    if (!pages.length || livePages.length !== pages.length || cachedDisconnected || !currentConnected) {
      paginationFrozen = false;
      rebuild();
    }

    // Defensive fallback for a second failure mode: if WebView reports a bogus
    // oversized scroller height, height-based pagination can collapse a long
    // chapter into one giant page. That makes ▶/◀ look dead even though the
    // chapter contains hundreds of paragraphs. A one-paragraph temporary pager
    // is always correct and remains fully interactive; a later normal rebuild
    // can regroup the paragraphs when geometry becomes sane again.
    if (pages.length <= 1) {
      unwrap(chapterText);
      const paragraphs = [...chapterText.querySelectorAll(':scope > .reader-paragraph')];
      if (paragraphs.length > 1) {
        paginationGeneration += 1;
        const ranges = paragraphs.map((_, index) => ({ start: index, end: index }));
        pages = buildPageElements(chapterText, ranges, paragraphs);
        animating = false;
        showPageInstant(pageIndexForParagraph(getActiveParagraphIndex()));
        console.warn('[reader pages] recovered collapsed single-page chapter', { paragraphs: paragraphs.length });
      } else if (paragraphs.length === 1 && !pages.length) {
        paginationGeneration += 1;
        pages = buildPageElements(chapterText, [{ start: 0, end: 0 }], paragraphs);
        animating = false;
        showPageInstant(0);
      }
    }

    // A transition has its own timeout, but if its old DOM was replaced while
    // it was running the timeout can leave `animating` true until much later.
    // No live transition classes means there is nothing left to wait for.
    if (animating && !chapterText.querySelector('.rd-page-out, .rd-page-in-active')) {
      animating = false;
    }
  }

  function resync() {
    if (!enabled || !pages.length) return;
    const target = pageIndexForParagraph(getActiveParagraphIndex());
    if (target !== currentPageIndex) showPageInstant(target);
  }

  function syncAfterRender({ full = false, queryOnly = false } = {}) {
    if (queryOnly) return enabled;
    if (full) {
      // A real chapter/font/layout render is allowed to establish a new frozen map.
      paginationFrozen = false;
      rebuild();
    } else resync();
    return enabled;
  }

  function turn(delta) {
    if (!enabled) return false;
    ensureLivePagesForTurn();
    if (animating) return false;

    const target = currentPageIndex + delta;
    if (target < 0 || target >= pages.length) return false;
    const curPage = pages[currentPageIndex];
    const nextPage = pages[target];
    if (!curPage?.el || !nextPage?.el || !curPage.el.isConnected || !nextPage.el.isConnected) {
      rebuild();
      return false;
    }

    const turnGeneration = paginationGeneration;
    const turnPages = pages;
    const turnChapterText = getChapterText();
    const directionClass = delta > 0 ? 'rd-page-forward' : 'rd-page-backward';
    const finishTurn = () => {
      // Never let an animation that started on an older chapter/re-pagination
      // write into the live reader. This is the exact race visible in the A54
      // recording: the correct new page begins animating, then the old timeout
      // fires and the reader jumps back to the pre-TOC position.
      const stale =
        turnGeneration !== paginationGeneration ||
        pages !== turnPages ||
        getChapterText() !== turnChapterText ||
        !curPage.el.isConnected ||
        !nextPage.el.isConnected ||
        curPage.el.parentElement !== turnChapterText ||
        nextPage.el.parentElement !== turnChapterText;
      if (stale) {
        clearTurnClasses(curPage.el);
        clearTurnClasses(nextPage.el);
        console.warn('[reader pages] ignored stale page-turn callback', {
          turnGeneration,
          currentGeneration: paginationGeneration,
        });
        return;
      }

      curPage.el.classList.remove('rd-page-show', 'rd-page-current');
      clearTurnClasses(curPage.el);
      clearTurnClasses(nextPage.el);
      nextPage.el.classList.add('rd-page-show', 'rd-page-current');
      currentPageIndex = target;
      animating = false;
      onPageChange?.(currentPageIndex, pages.length);
      try {
        window.dispatchEvent(new CustomEvent('reader:pagechange', {
          detail: { pageIndex: currentPageIndex, pageCount: pages.length },
        }));
      } catch {}
      // Use the page object captured when the gesture began. Looking up
      // pages[target] here is unsafe because a rebuild can replace the array
      // while CSS animation is still in flight.
      setActiveParagraphIndex(nextPage.start);
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

      void nextPage.el.offsetWidth;
      requestAnimationFrame(() => {
        // The DOM may have been rebuilt between the gesture and this RAF.
        if (turnGeneration !== paginationGeneration || pages !== turnPages) return;
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
      const dw = Math.abs(scroller.clientWidth - lastMeasuredWidth);
      const dh = Math.abs(scroller.clientHeight - lastMeasuredHeight);
      if (lastMeasuredWidth && lastMeasuredHeight && dw < 8 && dh < 24) return;
      // Android WebView frequently changes only viewport height when system/reader
      // chrome settles. Keep the already measured page boundaries in that case.
      if (paginationFrozen && lastMeasuredWidth && dw < 8) {
        lastMeasuredHeight = scroller.clientHeight;
        return;
      }
      if (animating) {
        handleResize();
        return;
      }
      paginationFrozen = false;
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