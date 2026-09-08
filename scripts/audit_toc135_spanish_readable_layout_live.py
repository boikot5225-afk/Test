#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc135 Spanish layout audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!view||!root) throw new Error('Reader DOM missing');
  if(typeof globalThis.readerSetSpanishGlossMode!=='function') throw new Error('Spanish gloss mode owner missing');

  const modeKey='an2_reader_es_unknown_gloss_mode_v1';
  const oldMode=localStorage.getItem(modeKey);
  const oldHtml=root.innerHTML;
  const oldViewClass=view.className;
  const oldViewDisplay=view.style.display;
  const oldViewLang=view.dataset.readerLang;
  const oldRootLang=root.dataset.lang;

  const wrap=(word,ru)=>`<span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="${word}" data-lang="es">${word}</span><span class="rw-es-v1-gloss" aria-hidden="true">${ru}</span></span>`;

  try {
    view.style.display='block';
    view.dataset.readerLang='es';
    root.dataset.lang='es';
    view.classList.add('rd-es-pipeline-v1','rd-es-language-active');
    root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div id="toc135-justify-fixture" class="reader-paragraph-text" style="text-align:justify;width:320px;max-width:320px;font-size:32px">
      ${wrap('Pidió','просил')} ${wrap('otra','другую')} ${wrap('cuba','куба')} ${wrap('libre','свободный')} ${wrap('y','и')} ${wrap('repitió','повторил')} ${wrap('el','арт')} ${wrap('proceso','процесс')} ${wrap('de','из')} ${wrap('arrojar','выливать')} ${wrap('el','арт')} ${wrap('ron','ром')} ${wrap('al','к')} ${wrap('piso','пол')}.
    </div></div>`;

    globalThis.readerSetSpanishGlossMode('unknown');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await sleep(30);

    const paragraph=document.getElementById('toc135-justify-fixture');
    if(!paragraph) throw new Error('toc135 justified fixture missing');
    const enabled=getComputedStyle(paragraph);
    const enabledState={
      inlineTextAlign:paragraph.style.textAlign,
      textAlign:enabled.textAlign,
      textAlignLast:enabled.textAlignLast,
      wordSpacing:enabled.wordSpacing,
      lineHeight:enabled.lineHeight,
    };
    if(paragraph.style.textAlign!=='justify') throw new Error('fixture lost source EPUB justification');
    if(!['start','left'].includes(enabled.textAlign)) throw new Error('Spanish interlinear mode still honors justification: '+JSON.stringify(enabledState));

    const rects=[...paragraph.querySelectorAll(':scope > .rw-es-v1-wrap')].map((el,index)=>({index,...(()=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}})()}));
    const gaps=[];
    for(let i=1;i<rects.length;i++){
      const a=rects[i-1],b=rects[i];
      if(Math.abs(a.top-b.top)<=4 && b.left>=a.right) gaps.push(Number((b.left-a.right).toFixed(2)));
    }
    const maxGap=gaps.length?Math.max(...gaps):null;
    if(gaps.length<2) throw new Error('toc135 layout fixture did not produce enough same-line word gaps: '+JSON.stringify(rects));
    if(maxGap>36) throw new Error('Spanish interlinear word gaps are still stretched: '+JSON.stringify({maxGap,gaps,enabledState}));

    globalThis.readerSetSpanishGlossMode('off');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const disabled=getComputedStyle(paragraph);
    const disabledState={textAlign:disabled.textAlign,wordSpacing:disabled.wordSpacing};
    if(disabled.textAlign!=='justify') throw new Error('Ordinary-text mode no longer restores EPUB justification: '+JSON.stringify(disabledState));
    const firstWrap=paragraph.querySelector('.rw-es-v1-wrap');
    const firstGloss=paragraph.querySelector('.rw-es-v1-gloss');
    if(getComputedStyle(firstWrap).display!=='inline' || getComputedStyle(firstGloss).display!=='none') {
      throw new Error('Ordinary-text geometry regressed while fixing alignment');
    }

    globalThis.readerSetSpanishGlossMode('unknown');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const restored=getComputedStyle(paragraph).textAlign;
    if(!['start','left'].includes(restored)) throw new Error('Spanish readable alignment did not restore after mode toggle: '+restored);

    return {enabledState,disabledState,restored,maxGap,gaps,wrapCount:rects.length};
  } finally {
    root.innerHTML=oldHtml;
    view.className=oldViewClass;
    view.style.display=oldViewDisplay;
    if(oldViewLang===undefined) delete view.dataset.readerLang; else view.dataset.readerLang=oldViewLang;
    if(oldRootLang===undefined) delete root.dataset.lang; else root.dataset.lang=oldRootLang;
    if(oldMode===null) localStorage.removeItem(modeKey); else localStorage.setItem(modeKey,oldMode);
    try { globalThis.readerSetSpanishGlossMode?.(oldMode==='off'?'off':'unknown'); } catch {}
  }
})()""", 40)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('toc135 Spanish readable layout audit returned no result')
if result.get('enabledState', {}).get('textAlign') not in ('start', 'left'):
    raise RuntimeError('toc135 Spanish interlinear alignment failed: ' + repr(result))
if result.get('disabledState', {}).get('textAlign') != 'justify':
    raise RuntimeError('toc135 ordinary-text EPUB alignment restore failed: ' + repr(result))
if result.get('maxGap') is None or result.get('maxGap') > 36:
    raise RuntimeError('toc135 Spanish word spacing failed: ' + repr(result))

cdp.close()
