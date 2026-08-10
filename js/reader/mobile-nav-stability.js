// Android WebView bottom-navigation stabilizer.
//
// The screen recording exposed the actual problem: app.js still contains an old
// emergency workaround called an2PinBottomNavManually(). It changes the mobile
// bar from position:fixed to position:absolute and rewrites its `top` from
// scrollY/visualViewport on every scroll, resize and every 400 ms. During
// Android kinetic scrolling those values are not synchronized with the
// compositor, so the bar visibly disappears, reappears and jumps through the
// document. That workaround is now worse than the bug it was meant to hide.
//
// This module is imported through reader-app before app.js reaches the legacy
// registration block. In the native APK only, suppress registration of that one
// obsolete callback, then restore the browser APIs immediately after app.js has
// had a chance to register its listeners. A MutationObserver also neutralizes
// the one direct call made by updateBottomNav() by restoring true fixed
// geometry before the next paint.

const isNativeAndroidShell = location.hostname === 'appassets.androidplatform.net';
const LEGACY_PIN_NAME = 'an2PinBottomNavManually';

function isLegacyPinCallback(callback) {
  return typeof callback === 'function' && callback.name === LEGACY_PIN_NAME;
}

if (isNativeAndroidShell) {
  document.documentElement.classList.add('reader-native-android');

  // Intercept only the obsolete pin callback while the parent app module is
  // executing synchronously. Every other event listener / interval passes
  // through untouched.
  const originalWindowAdd = window.addEventListener.bind(window);
  const originalSetInterval = window.setInterval.bind(window);
  const visualViewport = window.visualViewport || null;
  const originalVisualAdd = visualViewport?.addEventListener?.bind(visualViewport) || null;

  window.addEventListener = function patchedWindowAdd(type, callback, options) {
    if (isLegacyPinCallback(callback) && (type === 'scroll' || type === 'resize')) {
      console.info('[reader mobile] suppressed legacy bottom-nav listener', type);
      return;
    }
    return originalWindowAdd(type, callback, options);
  };

  window.setInterval = function patchedSetInterval(callback, delay, ...args) {
    if (isLegacyPinCallback(callback)) {
      console.info('[reader mobile] suppressed legacy bottom-nav interval', delay);
      return 0;
    }
    return originalSetInterval(callback, delay, ...args);
  };

  if (visualViewport && originalVisualAdd) {
    visualViewport.addEventListener = function patchedVisualAdd(type, callback, options) {
      if (isLegacyPinCallback(callback) && (type === 'scroll' || type === 'resize')) {
        console.info('[reader mobile] suppressed legacy visualViewport pin', type);
        return;
      }
      return originalVisualAdd(type, callback, options);
    };
  }

  // app.js continues in the same module-evaluation task after its imports. A
  // microtask therefore runs after its synchronous listener-registration block.
  queueMicrotask(() => {
    window.addEventListener = originalWindowAdd;
    window.setInterval = originalSetInterval;
    if (visualViewport && originalVisualAdd) visualViewport.addEventListener = originalVisualAdd;
  });

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
        z-index: 2147483000 !important;

        /* A fixed translucent backdrop-filter layer can flicker in Android
           WebView even after the bad absolute-position workaround is gone. */
        background: var(--bg) !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;

        transform: translate3d(0, 0, 0) !important;
        -webkit-transform: translate3d(0, 0, 0) !important;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        isolation: isolate;
      }

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

  let enforcing = false;
  function enforceFixedBottomNav() {
    const bar = document.getElementById('bottom-nav');
    if (!bar || enforcing) return;

    // Do not change display: reader mode and auth intentionally hide the bar.
    const position = bar.style.getPropertyValue('position');
    const top = bar.style.getPropertyValue('top');
    const bottom = bar.style.getPropertyValue('bottom');
    if (position !== 'absolute' && !top && bottom !== 'auto') return;

    enforcing = true;
    try {
      bar.style.removeProperty('top');
      bar.style.setProperty('position', 'fixed', 'important');
      bar.style.setProperty('left', '0', 'important');
      bar.style.setProperty('right', '0', 'important');
      bar.style.setProperty('bottom', '0', 'important');
      bar.style.setProperty('z-index', '2147483000', 'important');
    } finally {
      enforcing = false;
    }
  }

  const installObserver = () => {
    const bar = document.getElementById('bottom-nav');
    if (!bar || bar.dataset.an2FixedNavObserved === '1') return;
    bar.dataset.an2FixedNavObserved = '1';
    const observer = new MutationObserver(enforceFixedBottomNav);
    observer.observe(bar, { attributes: true, attributeFilter: ['style'] });
    enforceFixedBottomNav();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installObserver, { once: true });
  } else {
    installObserver();
  }

  // an2SyncBottomNav may re-parent the bar later; the observer follows the
  // element itself, so no scroll-time work is needed.
  window.addEventListener('pageshow', () => {
    installObserver();
    enforceFixedBottomNav();
  });
}

console.info('[reader mobile] bottom-nav stability loaded', { native: isNativeAndroidShell });
