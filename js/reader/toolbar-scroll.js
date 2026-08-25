// Horizontal swipe for the Reader top toolbar.
// The toolbar intentionally keeps every action at its normal tap size; when
// there are more controls than fit on a phone, the bar itself becomes a native
// horizontal scroller instead of clipping the rightmost controls (e.g. Pinyin).
const STYLE_ID = 'rd-toolbar-horizontal-scroll-style';

function installToolbarScrollStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view .rd-top {
      overflow-x: auto !important;
      overflow-y: hidden !important;
      flex-wrap: nowrap !important;
      justify-content: flex-start !important;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      -ms-overflow-style: none;
      overscroll-behavior-x: contain;
      touch-action: pan-x;
      scroll-padding-inline: 12px;
    }
    #reader-reading-view .rd-top::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    #reader-reading-view .rd-top > .rd-icon,
    #reader-reading-view .rd-top > button {
      flex-shrink: 0 !important;
    }
  `;
  document.head.appendChild(style);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installToolbarScrollStyle, { once: true });
} else {
  installToolbarScrollStyle();
}

export { installToolbarScrollStyle };
