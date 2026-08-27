// toc51/toc52 — device-only stability fixes confirmed by the 2026-08-27 A54 recordings.
//
// Keep this layer deliberately isolated from vocabulary state/segmentation. It
// only fixes geometry/compositing after the normal EN Unknown and pages-mode
// modules have done their work.
const STYLE_ID = 'rd-toc51-stability-style';
const NATIVE_ANDROID_HOST = 'appassets.androidplatform.net';

function canInstall() {
  return typeof document !== 'undefined'
    && typeof document.getElementById === 'function'
    && typeof document.createElement === 'function'
    && !!document.head
    && typeof document.head.appendChild === 'function';
}

function isNativeAndroidShell() {
  try {
    return typeof location !== 'undefined'
      && String(location.hostname || '').toLowerCase() === NATIVE_ANDROID_HOST;
  } catch {
    return false;
  }
}

function markNativeAndroid() {
  if (!isNativeAndroidShell()) return false;
  try {
    document.documentElement?.classList?.add('rd-native-android');
    return true;
  } catch {
    return false;
  }
}

function installToc51Stability() {
  if (!canInstall()) return false;
  markNativeAndroid();
  if (document.getElementById(STYLE_ID)) return true;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* EN Unknown: the network result must never change the inline box width.
       en-unknown-gloss.js reserves every wrapper before pagination, but its
       inline-grid/max-content column used ::after text when calculating width.
       A late Russian gloss could therefore widen the English word and reflow
       the whole page. Keep the wrapper width owned only by the source word;
       reserve the lower lane up front and paint the gloss absolutely inside it. */
    html body #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap[data-en-gloss="1"] {
      display:inline-block !important;
      vertical-align:-.34em !important;
      line-height:1 !important;
      margin:0 .025em !important;
      padding:0 0 .52em !important;
      position:relative !important;
      overflow:visible !important;
      white-space:nowrap !important;
    }
    html body #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap[data-en-gloss="1"] > .reader-word {
      display:inline !important;
      margin:0 !important;
      padding:0 1px !important;
      line-height:1.04 !important;
      white-space:nowrap !important;
      word-break:keep-all !important;
      overflow-wrap:normal !important;
    }
    html body #reader-reading-view.rd-en-unknown-gloss[data-reader-lang="en"] .rw-en-gloss-wrap[data-en-gloss="1"]::after {
      position:absolute !important;
      left:0 !important;
      right:0 !important;
      top:auto !important;
      bottom:0 !important;
      width:auto !important;
      min-width:0 !important;
      max-width:100% !important;
      height:auto !important;
      overflow:hidden !important;
      white-space:nowrap !important;
      text-align:center !important;
      pointer-events:none !important;
    }

    /* Android System WebView: avoid two simultaneously rasterized 3D text
       layers. The recorded ghost/double text happens during rotateY flip while
       the incoming live page is already visible underneath. On the native APK,
       keep the same "flip" preference but render it as one opaque sheet sliding
       away over the already prepared next page. Only the outgoing page moves;
       its opacity stays 1, so old/new glyphs never occupy the same pixels. */
    html.rd-native-android #reader-reading-view .rd-scroll[data-rd-page-animation="flip"] .rd-page {
      transition:transform .30s cubic-bezier(.22,.72,.2,1) !important;
      backface-visibility:visible !important;
      transform-style:flat !important;
      opacity:1 !important;
    }
    html.rd-native-android #reader-reading-view .rd-scroll[data-rd-page-animation="flip"] .rd-page.rd-page-in,
    html.rd-native-android #reader-reading-view .rd-scroll[data-rd-page-animation="flip"] .rd-page.rd-page-in-active {
      transform:none !important;
      opacity:1 !important;
    }
    html.rd-native-android #reader-reading-view .rd-scroll[data-rd-page-animation="flip"] .rd-page.rd-page-forward.rd-page-out {
      transform:translateX(-104%) !important;
      opacity:1 !important;
    }
    html.rd-native-android #reader-reading-view .rd-scroll[data-rd-page-animation="flip"] .rd-page.rd-page-backward.rd-page-out {
      transform:translateX(104%) !important;
      opacity:1 !important;
    }
    html.rd-native-android #reader-reading-view .rd-scroll[data-rd-page-animation="flip"] .rd-page.rd-page-out .rd-page-fold {
      display:none !important;
    }
  `;
  document.head.appendChild(style);
  return true;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installToc51Stability, { once: true });
  } else {
    installToc51Stability();
  }
}

export { installToc51Stability, isNativeAndroidShell };
