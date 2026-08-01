/* Keeps library structure visible after the legacy LingQ search handler runs. */
(() => {
  'use strict';
  const fix = () => {
    if (innerWidth > 700 || !document.body.classList.contains('reader-a54-library')) return;
    const list = document.getElementById('reader-library-list');
    if (!list) return;
    const tabs = list.querySelector('.lib-tabs-row');
    if (tabs) tabs.style.display = 'flex';
    const addNews = list.querySelector('.lib-add-news-btn');
    if (addNews) addNews.style.display = '';
  };
  document.addEventListener('input', (event) => {
    if (event.target?.classList?.contains('lqv2-library-search')) setTimeout(fix, 0);
  }, true);
  document.addEventListener('click', () => setTimeout(fix, 0), true);
  const timer = setInterval(fix, 300);
  addEventListener('pagehide', () => clearInterval(timer), { once:true });
  fix();
})();
