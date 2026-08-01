/* Keeps library structure visible after the legacy LingQ search handler runs.
 * v0.10: event driven — no 300 ms polling loop on the phone. */
(() => {
  'use strict';

  let frame = 0;
  let observer = null;

  const fix = () => {
    frame = 0;
    if (innerWidth > 700 || !document.body.classList.contains('reader-a54-library')) return;
    const list = document.getElementById('reader-library-list');
    if (!list) return;
    const tabs = list.querySelector('.lib-tabs-row');
    if (tabs && tabs.style.display !== 'flex') tabs.style.display = 'flex';
    const addNews = list.querySelector('.lib-add-news-btn');
    if (addNews && addNews.style.display === 'none') addNews.style.display = '';
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(fix);
  };

  const observeLibrary = () => {
    observer?.disconnect();
    const list = document.getElementById('reader-library-list');
    if (!list) return;
    observer = new MutationObserver(schedule);
    observer.observe(list, { childList: true, subtree: true });
  };

  document.addEventListener('input', (event) => {
    if (event.target?.classList?.contains('lqv2-library-search')) schedule();
  }, true);
  document.addEventListener('click', schedule, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { observeLibrary(); schedule(); }
  });
  addEventListener('resize', schedule, { passive: true });
  addEventListener('pagehide', () => {
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
  }, { once: true });

  observeLibrary();
  schedule();
  console.info('[reader mobile] Galaxy A54 library search v0.10 loaded');
})();
