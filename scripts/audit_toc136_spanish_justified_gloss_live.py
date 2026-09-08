#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc136 Spanish layout audit')
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

  const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const known=w=>`<span class="reader-word rw-migaku-known" data-word="${esc(w)}" data-lang="es">${esc(w)}</span>`;
  const unknown=(w,ru)=>`<span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="${esc(w)}" data-lang="es">${esc(w)}</span><span class="rw-es-v1-gloss" aria-hidden="true">${esc(ru)}</span></span>`;

  try {
    view.style.display='block';
    view.dataset.readerLang='es';
    root.dataset.lang='es';
    view.classList.add('rd-es-pipeline-v1','rd-es-language-active');
    root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div id="toc136-user-fixture" class="reader-paragraph-text" style="text-align:justify;width:340px;max-width:340px;font-size:32px">
      —${known('Pero')} ${known('Emiliano')} ${known('no')} ${known('fue')} ${known('a')} ${known('la')} ${unknown('hacienda','имение')}, ${known('conocía')} ${known('a')} ${known('los')} ${unknown('enemigos','враги')} ${known('y')} ${known('no')} ${known('les')} ${known('confiaba')} ${known('ni')} ${unknown('tantito','столько')}, ${known('mandó')} ${known('a')} ${known('un')} ${unknown('compadre','кум')} ${known('suyo')} ${known('que')} ${known('le')} ${unknown('insistió','настоял')} ${known('mucho')}. ${known('Pa’')} ${known('que')} ${known('se')} ${known('le')} ${known('quitara')} ${known('lo')} ${unknown('jodón','надоеда')}. ${known('Ése')} ${known('fue')} ${known('el')} ${known('que')} ${known('murió')} ${unknown('baleado','застрелен')}: ${known('Emiliano')} ${known('se')} ${unknown('escondió','спрятался')}, ${known('y')} ${unknown('vio','увидел')} ${known('cómo')} ${known('la')} ${known('Revolución')} ${known('se')} ${known('moría')}…
    </div></div>`;

    globalThis.readerSetSpanishGlossMode('unknown');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await sleep(40);

    const paragraph=document.getElementById('toc136-user-fixture');
    const pStyle=getComputedStyle(paragraph);
    if(paragraph.style.textAlign!=='justify' || pStyle.textAlign!=='justify') {
      throw new Error('Spanish gloss mode no longer preserves EPUB justification: '+JSON.stringify({inline:paragraph.style.textAlign,computed:pStyle.textAlign}));
    }

    const words=[...paragraph.querySelectorAll('.reader-word')].map((el,index)=>{
      const r=el.getBoundingClientRect();
      return {index,word:el.dataset.word,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};
    });
    const lines=[];
    for(const item of words){
      let line=lines.find(x=>Math.abs(x.top-item.top)<=3);
      if(!line){ line={top:item.top,items:[]}; lines.push(line); }
      line.items.push(item);
    }
    lines.sort((a,b)=>a.top-b.top);
    const gaps=[];
    for(const line of lines){
      line.items.sort((a,b)=>a.left-b.left);
      for(let i=1;i<line.items.length;i++){
        const a=line.items[i-1],b=line.items[i];
        if(b.left>=a.right) gaps.push(Number((b.left-a.right).toFixed(2)));
      }
    }
    const maxGap=gaps.length?Math.max(...gaps):null;
    if(lines.length<5 || gaps.length<15) throw new Error('toc136 fixture did not form realistic book lines');
    if(maxGap===null || maxGap>34) throw new Error('Justified Spanish still has giant inter-word gaps: '+JSON.stringify({maxGap,gaps,lines:lines.map(l=>l.items.map(x=>x.word))}));

    const glossGeometry=[...paragraph.querySelectorAll('.rw-es-v1-wrap')].map(wrap=>{
      const word=wrap.querySelector('.reader-word');
      const gloss=wrap.querySelector('.rw-es-v1-gloss');
      const wr=word.getBoundingClientRect(), gr=gloss.getBoundingClientRect();
      return {
        word:word.dataset.word,
        wrapDisplay:getComputedStyle(wrap).display,
        wrapPosition:getComputedStyle(wrap).position,
        glossPosition:getComputedStyle(gloss).position,
        centerDelta:Number(Math.abs((wr.left+wr.right)/2-(gr.left+gr.right)/2).toFixed(2)),
        belowDelta:Number((gr.top-wr.bottom).toFixed(2)),
        glossHeight:Number(gr.height.toFixed(2)),
      };
    });
    for(const row of glossGeometry){
      if(row.wrapDisplay!=='inline' || row.wrapPosition!=='relative' || row.glossPosition!=='absolute') throw new Error('toc136 inline gloss anchor inactive: '+JSON.stringify(row));
      if(row.centerDelta>4) throw new Error('toc136 gloss is not centered below source word: '+JSON.stringify(row));
      if(row.belowDelta < -3 || row.belowDelta > 16) throw new Error('toc136 gloss vertical position is wrong: '+JSON.stringify(row));
    }

    globalThis.readerSetSpanishGlossMode('off');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const offStyle=getComputedStyle(paragraph);
    const firstWrap=paragraph.querySelector('.rw-es-v1-wrap');
    const firstGloss=paragraph.querySelector('.rw-es-v1-gloss');
    if(offStyle.textAlign!=='justify') throw new Error('Ordinary mode lost EPUB justification');
    if(getComputedStyle(firstWrap).display!=='inline' || getComputedStyle(firstWrap).position!=='static' || getComputedStyle(firstGloss).display!=='none') {
      throw new Error('Ordinary mode geometry regressed');
    }

    return {
      textAlign:pStyle.textAlign,
      lineHeight:pStyle.lineHeight,
      lineCount:lines.length,
      maxGap,
      gaps,
      lines:lines.map(l=>l.items.map(x=>x.word)),
      glossGeometry,
      offTextAlign:offStyle.textAlign,
    };
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
    raise RuntimeError('toc136 Spanish justified gloss audit returned no result')
if result.get('textAlign') != 'justify' or result.get('offTextAlign') != 'justify':
    raise RuntimeError('toc136 did not preserve EPUB justification: ' + repr(result))
if result.get('maxGap') is None or result.get('maxGap') > 34:
    raise RuntimeError('toc136 Spanish justification spacing failed: ' + repr(result))

cdp.close()
