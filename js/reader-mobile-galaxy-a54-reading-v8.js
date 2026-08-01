/* Reader AI reading-screen diagnostics and layout v0.8 — Galaxy A54 / Android 15 */
(() => {
  'use strict';

  const $ = (selector, root = document) => root?.querySelector?.(selector) || null;
  const phone = () => window.innerWidth <= 700;
  const visible = node => !!node && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  const nativeInsets = new URLSearchParams(location.search).get('nativeInsets') === '1';

  let timer = 0;
  let interval = 0;
  let resizeObserver = null;
  let mutationObserver = null;
  let observedTop = null;
  let observedBottom = null;

  function installStyles() {
    if ($('#reader-a54-reading-v8-style')) return;
    const style = document.createElement('style');
    style.id = 'reader-a54-reading-v8-style';
    style.textContent = `
      @media (max-width:700px) {
        body.reader-a54-reading #reader-reading-view {
          --a54-top-fallback: 26px;
          width:100%!important;
          max-width:100%!important;
          height:100%!important;
          min-height:100%!important;
          isolation:isolate;
        }
        html.a54-native-insets body.reader-a54-reading #reader-reading-view {
          --a54-top-fallback: 0px;
        }
        body.reader-a54-reading #reader-reading-view .rd-top {
          min-height:56px!important;
          padding-top:max(8px,env(safe-area-inset-top),var(--a54-top-fallback))!important;
          padding-right:7px!important;
          padding-bottom:7px!important;
          padding-left:7px!important;
          gap:4px!important;
          overflow:hidden!important;
          background:color-mix(in srgb,var(--bg) 97%,transparent)!important;
          border-bottom:1px solid var(--border)!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-icon {
          flex:0 0 36px!important;
          width:36px!important;
          height:36px!important;
          min-width:36px!important;
          border-radius:9px!important;
          font-size:.93rem!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-head {
          flex:1 1 76px!important;
          min-width:76px!important;
          overflow:hidden!important;
          padding:1px 2px!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-book {
          font-size:.88rem!important;
          line-height:1.12!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-chap {
          margin-top:3px!important;
          font-size:.57rem!important;
          line-height:1.15!important;
          letter-spacing:0!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-scroll {
          box-sizing:border-box!important;
          padding-top:calc(var(--rd-top-h,82px) + var(--rd-audio-h,0px) + 12px)!important;
          padding-right:16px!important;
          padding-bottom:calc(var(--rd-bot-h,66px) + var(--rd-tts-h,0px) + 34px)!important;
          padding-left:16px!important;
          scroll-padding-top:calc(var(--rd-top-h,82px) + var(--rd-audio-h,0px) + 14px)!important;
          scroll-padding-bottom:calc(var(--rd-bot-h,66px) + var(--rd-tts-h,0px) + 36px)!important;
          overscroll-behavior-y:contain!important;
        }
        body.reader-a54-reading #reader-reading-view #reader-chapter-text {
          width:100%!important;
          max-width:660px!important;
          margin:0 auto!important;
          padding:0 4px calc(var(--rd-bot-h,66px) + 22px)!important;
        }
        body.reader-a54-reading #reader-reading-view .reader-paragraph {
          scroll-margin-top:calc(var(--rd-top-h,82px) + var(--rd-audio-h,0px) + 14px)!important;
          scroll-margin-bottom:calc(var(--rd-bot-h,66px) + var(--rd-tts-h,0px) + 30px)!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-bot {
          min-height:60px!important;
          grid-template-columns:42px minmax(0,1fr) 42px 42px!important;
          gap:5px!important;
          padding-top:6px!important;
          padding-right:8px!important;
          padding-bottom:max(7px,env(safe-area-inset-bottom))!important;
          padding-left:8px!important;
          background:color-mix(in srgb,var(--bg) 98%,transparent)!important;
          border-top:1px solid var(--border)!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-nav,
        body.reader-a54-reading #reader-reading-view .rd-more {
          width:42px!important;
          min-width:42px!important;
          height:46px!important;
          min-height:46px!important;
          padding:0!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-listen {
          width:100%!important;
          min-width:0!important;
          height:46px!important;
          min-height:46px!important;
          padding:0 12px!important;
          border-radius:24px!important;
          font-size:.88rem!important;
          white-space:nowrap!important;
          overflow:hidden!important;
          text-overflow:ellipsis!important;
        }
        body.reader-a54-reading #reader-reading-view #reader-tts-player {
          bottom:var(--rd-bot-h,66px)!important;
        }
        body.reader-a54-reading #reader-reading-view #reader-orig-audio-wrap {
          top:var(--rd-top-h,82px)!important;
        }
        body.reader-a54-reading #reader-reading-view .rd-display-panel,
        body.reader-a54-reading #reader-reading-view .rd-sheet {
          max-height:calc(100% - 12px)!important;
          padding-bottom:max(18px,env(safe-area-inset-bottom))!important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function px(node) {
    if (!visible(node)) return 0;
    return Math.max(0, Math.ceil(node.getBoundingClientRect().height));
  }

  function observeBars(top, bottom) {
    if (!('ResizeObserver' in window)) return;
    if (!resizeObserver) resizeObserver = new ResizeObserver(schedule);
    if (top && top !== observedTop) {
      if (observedTop) resizeObserver.unobserve(observedTop);
      resizeObserver.observe(top);
      observedTop = top;
    }
    if (bottom && bottom !== observedBottom) {
      if (observedBottom) resizeObserver.unobserve(observedBottom);
      resizeObserver.observe(bottom);
      observedBottom = bottom;
    }
  }

  function measure() {
    installStyles();
    document.documentElement.classList.toggle('a54-native-insets', nativeInsets);

    const view = $('#reader-reading-view');
    if (!phone() || !visible(view)) return;

    const top = $('.rd-top', view);
    const bottom = $('.rd-bot', view);
    const tts = $('#reader-tts-player', view) || $('#reader-tts-player');
    const originalAudio = $('#reader-orig-audio-wrap', view) || $('#reader-orig-audio-wrap');

    observeBars(top, bottom);

    const topHeight = px(top);
    const bottomHeight = px(bottom);
    const ttsHeight = px(tts);
    const audioHeight = px(originalAudio);

    if (topHeight) view.style.setProperty('--rd-top-h', `${topHeight}px`);
    if (bottomHeight) view.style.setProperty('--rd-bot-h', `${bottomHeight}px`);
    view.style.setProperty('--rd-tts-h', `${ttsHeight}px`);
    view.style.setProperty('--rd-audio-h', `${audioHeight}px`);
    view.dataset.a54ReadingLayout = 'v8';
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(measure, 36);
  }

  function boot() {
    installStyles();
    measure();
    mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    interval = setInterval(measure, 400);
    addEventListener('resize', schedule, { passive: true });
    addEventListener('orientationchange', schedule, { passive: true });
    document.addEventListener('click', schedule, true);
    addEventListener('pagehide', () => {
      clearInterval(interval);
      clearTimeout(timer);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    }, { once: true });
    console.info('[reader mobile] Galaxy A54 reading layout v0.8 loaded');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
