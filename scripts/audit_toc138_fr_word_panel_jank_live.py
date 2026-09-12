#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc138 French word-panel audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const screen=document.getElementById('screen-reader');
  const library=document.getElementById('reader-library-view');
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!screen||!view||!root)throw new Error('Reader DOM missing');

  document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('active',el===screen));
  screen.style.display='block';
  if(library)library.style.display='none';
  view.style.display='block';
  view.dataset.readerLang='fr';
  root.dataset.lang='fr';
  root.dataset.readerBookId='toc138-fr-panel-jank';
  root.dataset.renderedChapter='138-panel-jank';
  root.innerHTML='<div class="reader-paragraph active" data-p="0"><div class="reader-paragraph-text">Vous <span class="reader-word" data-word="pourriez" data-lang="fr">pourriez</span> donner votre nom.</div></div>';
  window.dispatchEvent(new CustomEvent('an2:languagechange'));

  for(let i=0;i<40&&!window.readerOpenWordPanel?.__toc138FrenchSmoothPanel;i++)await sleep(50);
  const installed=!!window.readerOpenWordPanel?.__toc138FrenchSmoothPanel;
  if(!installed)throw new Error('toc138 French word-panel wrapper not installed');

  const before=Number(window.__toc138FrenchSuppressedChapterRepaints||0);
  const started=performance.now();
  let pending=null;
  try{pending=window.readerOpenWordPanel('pourriez',0);}catch(error){throw new Error('readerOpenWordPanel threw synchronously: '+String(error?.message||error));}
  const dispatchMs=performance.now()-started;
  if(pending&&typeof pending.catch==='function')pending.catch(()=>{});
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const firstFrameMs=performance.now()-started;
  await sleep(30);
  const after=Number(window.__toc138FrenchSuppressedChapterRepaints||0);
  const panel=document.getElementById('reader-word-panel');

  return {
    installed,
    before,
    after,
    suppressed:after-before,
    dispatchMs:Number(dispatchMs.toFixed(2)),
    firstFrameMs:Number(firstFrameMs.toFixed(2)),
    panelExists:!!panel,
    panelOpen:!!panel?.classList.contains('open'),
    title:String(document.getElementById('reader-word-title')?.textContent||'').trim(),
  };
})()""", 25)

print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()

if not result:
    raise RuntimeError('toc138 French word-panel audit returned no result')
if not result.get('installed'):
    raise RuntimeError('toc138 French word-panel wrapper missing: ' + repr(result))
if result.get('suppressed', 0) < 1:
    raise RuntimeError('French word tap still schedules a full chapter repaint: ' + repr(result))
if result.get('dispatchMs', 999) > 120:
    raise RuntimeError('French word-card open blocks tap dispatch: ' + repr(result))
if result.get('firstFrameMs', 999) > 180:
    raise RuntimeError('French word-card open misses the next responsive frame: ' + repr(result))
if not result.get('panelExists'):
    raise RuntimeError('French word panel was not created: ' + repr(result))
