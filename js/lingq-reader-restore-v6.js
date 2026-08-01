/* Reader AI + LingQ layout restore v0.10 — event driven */
(() => {
  'use strict';
  const $ = (s, r = document) => r?.querySelector?.(s) || null;
  const $$ = (s, r = document) => [...(r?.querySelectorAll?.(s) || [])];
  const MODE_KEY = 'reader_ai_lingq_sentence_mode_v1';
  let frame = 0;
  let observer = null;

  const sentenceMode = () => {
    try { return localStorage.getItem(MODE_KEY) === '1'; }
    catch { return false; }
  };

  function styles() {
    if ($('#lingq-restore-v6-style')) return;
    const el = document.createElement('style');
    el.id = 'lingq-restore-v6-style';
    el.textContent = `
      #reader-reading-view .lqv2-top,
      #reader-reading-view .lqv2-bottom{display:none!important}
      #reader-reading-view.lqv2>.rd-top{display:flex!important}
      #reader-reading-view.lqv2>.rd-bot{display:grid!important}
      #reader-reading-view.lqv2>.rd-free-prog{display:block!important}
      #reader-reading-view.lqv2>.rd-scroll{
        position:relative!important;inset:auto!important;flex:1 1 auto!important;
        min-height:0!important;overflow-y:auto!important;
        padding-top:calc(var(--rd-top-h,64px) + var(--rd-audio-h,0px) + 10px)!important;
        padding-right:16px!important;
        padding-bottom:calc(var(--rd-bot-h,70px) + var(--rd-tts-h,0px) + 18px)!important;
        padding-left:16px!important;
        background-color:var(--bg)!important;background-image:var(--rd-bg-image)!important;
        background-size:var(--rd-bg-size)!important}
      #reader-reading-view.lqv2 #reader-chapter-text{
        width:auto!important;max-width:660px!important;margin:0 auto!important;padding:0 8px!important}
      #reader-reading-view.lqv2 .reader-paragraph{
        padding:3px 2px 3px 14px!important;margin:0 0 .9em!important;border-radius:0!important}
      #reader-reading-view.lqv2 .reader-paragraph.active{
        background:color-mix(in srgb,var(--accent) 6%,transparent)!important;border-left-color:var(--accent)!important}
      #reader-reading-view.lqv2:not(.rd-marks-on) .reader-paragraph.active{background:transparent!important}
      #reader-reading-view.lqv2:not(.rd-marks-on) .reader-word{
        background:transparent!important;box-shadow:none!important;border-bottom-color:transparent!important}
      #reader-reading-view.lqv2:not(.rd-marks-on) .reader-word.rw-saved,
      #reader-reading-view.lqv2:not(.rd-marks-on) .reader-word.rw-learning,
      #reader-reading-view.lqv2:not(.rd-marks-on) .reader-word.rw-familiar{
        border-bottom:1.5px dotted color-mix(in srgb,var(--accent) 65%,transparent)!important}
      #reader-reading-view.lqv2:not(.rd-marks-on) .reader-word.rw-problem{
        border-bottom:2px solid rgba(255,69,58,.65)!important}
      #reader-reading-view .lqf4-sentence-body{
        font-family:var(--rd-font)!important;font-size:var(--rd-size)!important;
        line-height:var(--rd-lh)!important;color:var(--text)!important}
      #reader-reading-view .lqf4-card,#reader-reading-view .lqf4-actions button,
      #reader-reading-view .lqf4-chip{background:var(--surface)!important;color:var(--text)!important;border-color:var(--border)!important}
      .lqv6-menu-state{margin-left:auto;padding:3px 8px;border-radius:999px;background:var(--surface2);color:var(--text-muted);font-size:.65rem}
      .lqv6-menu-state.on{color:var(--accent)}
      @media(min-width:760px){#reader-reading-view.lqv2>.rd-scroll{
        padding-right:max(16px,calc((100% - 720px)/2))!important;
        padding-left:max(16px,calc((100% - 720px)/2))!important}}
    `;
    document.head.appendChild(el);
  }

  function menu() {
    const sheet = $('#reader-more-sheet');
    if (!sheet || $('#lqv6-native-menu', sheet)) return;
    const block = document.createElement('div');
    block.id = 'lqv6-native-menu';
    block.innerHTML = `
      <div class="rd-sect">обучение по тексту</div>
      <button class="rd-menu" data-lqv2-menu="sentence"><span class="ic">▤</span><span>Режим предложений<small>одна фраза, перевод и озвучка</small></span><i class="lqv6-menu-state">выкл</i></button>
      <button class="rd-menu" data-lqv2-menu="words"><span class="ic">★</span><span>Слова этой книги<small>частота и переход к контексту</small></span></button>
      <div class="rd-divider"></div>`;
    const grab = $('.rd-grab', sheet);
    grab?.after(block);
  }

  function routeNativeButtons(event) {
    if (!sentenceMode()) return;
    const button = event.target.closest('#reader-reading-view .rd-bot button');
    if (!button) return;
    const navs = $$('#reader-reading-view .rd-bot .rd-nav');
    let action = '';
    if (button === navs[0]) action = 'prev';
    else if (button === navs[navs.length - 1]) action = 'next';
    else if (button.id === 'reader-listen-btn') action = 'listen';
    else if ((button.getAttribute('onclick') || '').includes("'translate'")) action = 'translate';
    else if ((button.getAttribute('onclick') || '').includes("'analyze'")) action = 'analysis';
    if (!action) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
    if (action === 'analysis') return $('.lqf4-sentence-stage [data-lqf4-action="analyze"]')?.click();
    $(`.lqv2-bottom [data-lqv2="${action}"]`)?.click();
  }

  function sync() {
    frame = 0;
    styles();
    menu();
    const badge = $('.lqv6-menu-state');
    if (badge) {
      const on = sentenceMode();
      if (badge.textContent !== (on ? 'вкл' : 'выкл')) badge.textContent = on ? 'вкл' : 'выкл';
      badge.classList.toggle('on', on);
    }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(sync);
  }

  function boot() {
    styles();
    schedule();
    document.addEventListener('click', (event) => {
      routeNativeButtons(event);
      schedule();
    }, true);
    addEventListener('storage', (event) => { if (event.key === MODE_KEY) schedule(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });

    // Only structural changes matter. The old 300 ms timer queried the whole
    // reader forever, even while the page was perfectly still.
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    addEventListener('pagehide', () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    }, { once: true });
    console.info('[lingq reader] restore/layout v0.10 loaded');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
