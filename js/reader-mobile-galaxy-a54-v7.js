/* Reader AI mobile layout fixes v0.10 — Galaxy A54 / narrow Android phones */
(() => {
  'use strict';
  const $=(s,r=document)=>r?.querySelector?.(s)||null;
  const $$=(s,r=document)=>[...(r?.querySelectorAll?.(s)||[])];
  let frame=0,observer=null,observedRoot=null;
  const phone=()=>innerWidth<=700;
  const shown=n=>!!n&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden';

  function addStyles(){
    if($('#reader-a54-v7-style'))return;
    const s=document.createElement('style');s.id='reader-a54-v7-style';s.textContent=`
@media(max-width:700px){
html,body{width:100%;max-width:100%;overflow-x:hidden}
body.reader-a54-screen #main-app{padding-top:0!important}
body.reader-a54-screen #screen-reader{width:100%!important;max-width:none!important;margin:0!important;padding:max(10px,env(safe-area-inset-top)) 0 calc(76px + env(safe-area-inset-bottom))!important;min-height:100dvh!important;overflow-x:hidden!important}
body.reader-a54-library #screen-reader .reader-shell{width:100%!important;max-width:none!important;margin:0!important;padding:0 12px calc(88px + env(safe-area-inset-bottom))!important}
body.reader-a54-library #reader-library-view{width:100%;max-width:100%;overflow-x:hidden}
body.reader-a54-library .reader-hero{margin:0 0 12px!important;padding:12px 13px!important;border-radius:16px!important;box-shadow:none!important}
body.reader-a54-library .reader-hero>div{gap:8px!important;align-items:center!important}
body.reader-a54-library .reader-title{font-size:1.62rem!important;line-height:1.05!important;letter-spacing:-.025em!important;min-width:0!important;white-space:nowrap!important}
body.reader-a54-library .reader-hero .btn{min-height:42px!important;padding:8px 12px!important;font-size:.78rem!important;border-radius:10px!important;white-space:nowrap!important}
body.reader-a54-library .reader-hero .btn.btn-secondary{width:42px!important;padding:0!important}
body.reader-a54-library #reader-continue-card{margin:0 0 12px!important}
body.reader-a54-library .lib-cont-card{min-height:96px!important;gap:11px!important;padding:11px!important;border-radius:16px!important;box-shadow:0 4px 14px rgba(80,55,30,.06)!important}
body.reader-a54-library .lib-cont-card .lib-cover{width:46px!important;height:66px!important;font-size:1.25rem!important}
body.reader-a54-library .lib-cont-title{font-size:.98rem!important;line-height:1.25!important;white-space:normal!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:2!important;overflow:hidden!important}
body.reader-a54-library .lib-cont-meta{margin:3px 0 7px!important;font-size:.70rem!important;line-height:1.35!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
body.reader-a54-library .lib-cont-go{padding:9px 12px!important;font-size:.76rem!important;min-width:72px!important}
body.reader-a54-library .lqv2-library-tools{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:8px!important;margin:0 0 12px!important}
body.reader-a54-library .lqv2-library-search{min-width:0!important;height:48px!important;padding:0 13px!important;border-radius:12px!important;font-size:16px!important;line-height:48px!important}
body.reader-a54-library .lqv2-library-count{min-width:78px!important;height:48px!important;padding:0 10px!important;border-radius:12px!important;font-size:.70rem!important;justify-content:center!important}
body.reader-a54-library #reader-library-list{gap:0!important;margin-bottom:0!important;width:100%!important;max-width:100%!important}
body.reader-a54-library .lib-tabs-row{margin:0 0 8px!important}
body.reader-a54-library .lib-tab-btn{min-height:44px!important;padding:8px 5px 9px!important;font-size:.76rem!important;white-space:nowrap!important}
body.reader-a54-library .lib-book-card{position:relative!important;display:grid!important;grid-template-columns:minmax(0,1fr) 42px!important;width:100%!important;min-height:98px!important;margin:0!important;border:none!important;border-bottom:1px solid color-mix(in srgb,var(--border) 72%,transparent)!important;border-radius:0!important;background:transparent!important;overflow:visible!important;opacity:1!important}
body.reader-a54-library .lib-book-card.a54-continue-duplicate{display:none!important}
body.reader-a54-library .lib-book-main{grid-column:1!important;grid-row:1!important;display:flex!important;align-items:flex-start!important;gap:11px!important;min-width:0!important;padding:12px 5px 11px 2px!important}
body.reader-a54-library .lib-cover{width:44px!important;height:64px!important;border-radius:9px!important;font-size:1.14rem!important;margin-top:1px!important}
body.reader-a54-library .lib-book-body{min-width:0!important;padding-top:0!important}
body.reader-a54-library .lib-book-title{margin:0 0 3px!important;font-size:.96rem!important;line-height:1.28!important;white-space:normal!important;overflow:hidden!important;text-overflow:clip!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:2!important;overflow-wrap:anywhere!important}
body.reader-a54-library .lib-book-meta{margin:0 0 7px!important;font-size:.69rem!important;line-height:1.45!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:2!important;overflow:hidden!important;overflow-wrap:anywhere!important}
body.reader-a54-library .lib-book-pct{position:absolute!important;right:48px!important;top:12px!important;font-size:.70rem!important;background:color-mix(in srgb,var(--bg) 88%,transparent)!important;padding-left:5px!important}
body.reader-a54-library .lib-prog-bar{height:3px!important;margin-right:2px!important}
body.reader-a54-library .lib-book-actions{grid-column:2!important;grid-row:1!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:flex-end!important;gap:4px!important;padding:8px 1px 10px!important;border:none!important}
body.reader-a54-library .lib-book-actions .lib-action-btn{flex:none!important;width:36px!important;height:36px!important;min-width:36px!important;padding:0!important;border:0!important;border-radius:10px!important;display:grid!important;place-items:center!important;font-size:1rem!important;line-height:1!important}
body.reader-a54-library .lib-book-actions .lib-action-btn:active{background:var(--surface2)!important}
body.reader-a54-library .lib-empty-tab{padding:28px 12px!important}
body.reader-a54-reading #screen-reader{padding:0!important}
body.reader-a54-reading #screen-reader .reader-shell{padding:0!important;margin:0!important;width:100%!important}
body.reader-a54-reading #reader-reading-view{width:100%!important;max-width:100%!important;height:100dvh!important;min-height:100dvh!important;overflow:hidden!important}
body.reader-a54-reading #reader-reading-view .rd-top{min-height:58px!important;padding:max(7px,env(safe-area-inset-top)) 8px 7px!important;gap:4px!important}
body.reader-a54-reading #reader-reading-view .rd-icon{width:38px!important;height:38px!important;min-width:38px!important;font-size:.84rem!important}
body.reader-a54-reading #reader-reading-view .rd-head{min-width:0!important}
body.reader-a54-reading #reader-reading-view .rd-book,body.reader-a54-reading #reader-reading-view .rd-chap{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
body.reader-a54-reading #reader-reading-view .rd-scroll{padding-left:14px!important;padding-right:14px!important;overscroll-behavior:contain!important}
body.reader-a54-reading #reader-reading-view #reader-chapter-text{width:100%!important;max-width:100%!important;padding:0!important}
body.reader-a54-reading #reader-reading-view .rd-bot{padding:7px 9px max(7px,env(safe-area-inset-bottom))!important;gap:5px!important}
body.reader-a54-reading #reader-reading-view .rd-nav,body.reader-a54-reading #reader-reading-view .rd-more{min-width:38px!important;width:38px!important}
body.reader-a54-reading #reader-reading-view .rd-listen{min-width:0!important}
body.reader-a54-reading #reader-reading-view .rd-display-panel,body.reader-a54-reading #reader-reading-view .rd-sheet{width:100%!important;max-width:100%!important;left:0!important;right:0!important;bottom:0!important;border-radius:20px 20px 0 0!important}
}`;document.head.appendChild(s);
  }

  function bookId(node){const raw=node?.getAttribute?.('onclick')||'';return raw.match(/readerOpenBook\(['"]([^'"]+)['"]\)/)?.[1]||''}
  function tab(list){return $('.lib-tab-btn.active',list)?.textContent?.includes('Новости')?'news':'books'}

  function filterLibrary(){
    const list=$('#reader-library-list'),tools=$('.lqv2-library-tools');if(!list||!tools)return;
    const input=$('.lqv2-library-search',tools),count=$('.lqv2-library-count',tools);
    const q=String(input?.value||'').trim().toLocaleLowerCase(),active=tab(list);
    const cards=active==='news'?$$('.lib-news-card',list):$$('.lib-book-card',list);
    const cont=$('#reader-continue-card'),contId=bookId($('.lib-cont-body',cont));let found=0;
    cards.forEach(card=>{
      const duplicate=active==='books'&&!q&&contId&&bookId($('.lib-book-main',card))===contId&&shown(cont);
      card.classList.toggle('a54-continue-duplicate',!!duplicate);
      const match=!q||String(card.textContent||'').toLocaleLowerCase().includes(q);
      if(card.hidden===match)card.hidden=!match;
      if(match&&!duplicate)found++;
    });
    if(cont){const next=q||active!=='books'?'none':(cont.dataset.a54Display||'flex');if(cont.style.display!==next)cont.style.display=next}
    if(count){const n=q?found:cards.length;const text=`${n} ${active==='news'?(n===1?'новость':'новостей'):(n===1?'книга':n>=2&&n<=4?'книги':'книг')}`;if(count.textContent!==text)count.textContent=text}
  }

  function syncLibrary(){
    const list=$('#reader-library-list');if(!list)return;
    const cont=$('#reader-continue-card');if(cont&&cont.style.display!=='none')cont.dataset.a54Display=cont.style.display||'flex';
    const input=$('.lqv2-library-search');if(input&&!input.dataset.a54Bound){input.dataset.a54Bound='1';input.addEventListener('input',filterLibrary)}
    filterLibrary();
  }

  function sync(){
    frame=0;addStyles();const screen=$('#screen-reader'),library=$('#reader-library-view'),reading=$('#reader-reading-view');
    const open=phone()&&shown(screen);
    const libraryOpen=open&&shown(library),readingOpen=open&&shown(reading);
    document.body.classList.toggle('reader-a54-screen',open);
    document.body.classList.toggle('reader-a54-library',libraryOpen);
    document.body.classList.toggle('reader-a54-reading',readingOpen);
    if(libraryOpen)syncLibrary();
    observeScreen(screen);
  }

  function schedule(){if(frame)return;frame=requestAnimationFrame(sync)}

  function observeScreen(screen){
    const root=screen||document.body;if(root===observedRoot)return;
    observer?.disconnect();observer=new MutationObserver(schedule);observer.observe(root,{childList:true,subtree:true});observedRoot=root;
  }

  function boot(){
    addStyles();sync();
    addEventListener('resize',schedule,{passive:true});
    addEventListener('orientationchange',schedule,{passive:true});
    document.addEventListener('click',schedule,true);
    document.addEventListener('input',schedule,true);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule()});
    addEventListener('pagehide',()=>{observer?.disconnect();if(frame)cancelAnimationFrame(frame)},{once:true});
    console.info('[reader mobile] Galaxy A54 layout v0.10 loaded');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
