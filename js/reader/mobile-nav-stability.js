// Android WebView compositor guard for the fixed bottom navigation.
//
// On Galaxy A54 / Android WebView the combination of position:fixed +
// translucent background + backdrop-filter causes the bottom navigation layer
// to be intermittently dropped/recomposited during kinetic scrolling. The
// screen recording shows exactly that: content keeps moving while the nav
// disappears, then the nav pops back once scrolling settles.
//
// Keep the web/PWA look unchanged. Inside the native APK use an opaque layer
// with no backdrop blur and pin it to its own compositor layer.

const isNativeAndroidShell = location.hostname === 'appassets.androidplatform.net';

if (isNativeAndroidShell) {
  document.documentElement.classList.add('reader-native-android');

  if (!document.getElementById('reader-native-bottom-nav-stability')) {
    const style = document.createElement('style');
    style.id = 'reader-native-bottom-nav-stability';
    style.textContent = `
      html.reader-native-android,
      html.reader-native-android body {
        overscroll-behavior-y: none;
      }

      html.reader-native-android .bottom-nav {
        position: fixed !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        z-index: 1000 !important;

        /* Critical: backdrop blur on a fixed translucent layer flickers in
           Android WebView while the page is being composited during scroll. */
        background: var(--bg) !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;

        /* Give the nav one stable compositor layer instead of letting WebView
           repeatedly merge/drop it with the scrolling page. */
        transform: translate3d(0, 0, 0) !important;
        -webkit-transform: translate3d(0, 0, 0) !important;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        will-change: transform;
        isolation: isolate;
      }

      /* Do not let scrolling content show through the navigation background. */
      html.reader-native-android .bottom-nav::before {
        content: '';
        position: absolute;
        inset: 0;
        background: var(--bg);
        z-index: -1;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }
}

console.info('[reader mobile] bottom-nav compositor guard', { native: isNativeAndroidShell });
