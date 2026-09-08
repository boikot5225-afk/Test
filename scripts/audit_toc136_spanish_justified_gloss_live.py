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

  const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const known=w=>`<span class="reader-word rw-migaku-known" data-word="${esc(w)}" data-lang="es">${esc(w)}</span>`;
  const unknown=(w,ru)=>`<span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="${esc(w)}" data-lang="es">${esc(w)}</span><span class="rw-es-v1-gloss" aria-hidden="true">${esc(ru)}</span></span>`;

  view.style.display='block';
  view.dataset.readerLang='es';
  root.dataset.lang='es';
  view.classList.add('rd-es-pipeline-v1','rd-es-language-active');
  root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div id="toc136-user-fixture" class="reader-paragraph-text" style="display:block;text-align:justify;width:340px;max-width:340px;font-size:32px;margin:20px auto">
    —${known('Pero')} ${known('Emiliano')} ${known('no')} ${known('fue')} ${known('a')} ${known('la')} ${unknown('hacienda','имение')}, ${known('conocía')} ${known('a')} ${known('los')} ${unknown('enemigos','враги')} ${known('y')} ${known('no')} ${known('les')} ${known('confiaba')} ${known('ni')} ${unknown('tantito','столько')}, ${known('mandó')} ${known('a')} ${known('un')} ${unknown('compadre','кум')} ${known('suyo')} ${known('que')} ${known('le')} ${unknown('insistió','настоял')} ${known('mucho')}. ${known('Pa’')} ${known('que')} ${known('se')} ${known('le')} ${known('quitara')} ${known('lo')} ${unknown('jodón','надоеда')}. ${known('Ése')} ${known('fue')} ${known('el')} ${known('que')} ${known('murió')} ${unknown('baleado','застрелен')}: ${known('Emiliano')} ${known('se')} ${unknown('escondió','спрятался')}, ${known('y')} ${unknown('vio','увидел')} ${known('cómo')} ${known('la')} ${known('Revolución')} ${known('se')} ${known('moría')}…
  </div></div>`;

  globalThis.readerSetSpanishGlossMode('unknown');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  await sleep(80);

  const paragraph=document.getElementById('toc136-user-fixture');
  const pStyle=getComputedStyle(paragraph);
  const pr=paragraph.getBoundingClientRect();
  const rr=root.getBoundingClientRect();
  const words=[...paragraph.querySelectorAll('.reader-word')].map((el,index)=>{
    const r=el.getBoundingClientRect();
    return {index,word:el.dataset.word,left:Number(r.left.toFixed(2)),right:Number(r.right.toFixed(2)),top:Number(r.top.toFixed(2)),bottom:Number(r.bottom.toFixed(2)),width:Number(r.width.toFixed(2)),display:getComputedStyle(el).display};
  });
  const lines=[];
  for(const item of words){
    let line=lines.find(x=>Math.abs(x.top-item.top)<=4);
    if(!line){ line={top:item.top,items:[]}; lines.push(line); }
    line.items.push(item);
  }
  lines.sort((a,b)=>a.top-b.top);
  const gaps=[];
  const gapRows=[];
  for(const line of lines){
    line.items.sort((a,b)=>a.left-b.left);
    for(let i=1;i<line.items.length;i++){
      const a=line.items[i-1],b=line.items[i];
      if(b.left>=a.right){
        const gap=Number((b.left-a.right).toFixed(2));
        gaps.push(gap);
        gapRows.push({a:a.word,b:b.word,gap,top:line.top});
      }
    }
  }
  const maxGap=gaps.length?Math.max(...gaps):null;

  const glossGeometry=[...paragraph.querySelectorAll('.rw-es-v1-wrap')].map(wrap=>{
    const word=wrap.querySelector('.reader-word');
    const gloss=wrap.querySelector('.rw-es-v1-gloss');
    const wr=word.getBoundingClientRect(), gr=gloss.getBoundingClientRect();
    return {
      word:word.dataset.word,
      wrapDisplay:getComputedStyle(wrap).display,
      wrapPosition:getComputedStyle(wrap).position,
      glossDisplay:getComputedStyle(gloss).display,
      glossPosition:getComputedStyle(gloss).position,
      centerDelta:Number(Math.abs((wr.left+wr.right)/2-(gr.left+gr.right)/2).toFixed(2)),
      belowDelta:Number((gr.top-wr.bottom).toFixed(2)),
      glossHeight:Number(gr.height.toFixed(2)),
    };
  });

  return {
    textAlign:pStyle.textAlign,
    paragraphDisplay:pStyle.display,
    paragraphWidth:Number(pr.width.toFixed(2)),
    paragraphHeight:Number(pr.height.toFixed(2)),
    rootWidth:Number(rr.width.toFixed(2)),
    fontSize:pStyle.fontSize,
    lineHeight:pStyle.lineHeight,
    whiteSpace:pStyle.whiteSpace,
    wordSpacing:pStyle.wordSpacing,
    lineCount:lines.length,
    wordsCount:words.length,
    maxGap,
    gapsCount:gaps.length,
    gapRows,
    lines:lines.map(l=>({top:l.top,words:l.items.map(x=>x.word),left:l.items[0]?.left,right:l.items[l.items.length-1]?.right})),
    glossGeometry,
    words,
  };
})()""", 40)

print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()

if not result:
    raise RuntimeError('toc136 Spanish justified gloss audit returned no result')
if result.get('textAlign') != 'justify':
    raise RuntimeError('toc136 did not preserve EPUB justification: ' + repr(result))
if result.get('lineCount', 0) < 5 or result.get('gapsCount', 0) < 15:
    raise RuntimeError('toc136 diagnostic fixture geometry is unrealistic: ' + repr(result))
if result.get('maxGap') is None or result.get('maxGap') > 34:
    raise RuntimeError('toc136 Spanish justification spacing failed: ' + repr(result))
for row in result.get('glossGeometry') or []:
    if row.get('wrapDisplay') != 'inline' or row.get('wrapPosition') != 'relative' or row.get('glossPosition') != 'absolute':
        raise RuntimeError('toc136 inline gloss anchor inactive: ' + repr(row))
    if row.get('centerDelta', 999) > 4:
        raise RuntimeError('toc136 gloss is not centered below source word: ' + repr(row))
    if not (-3 <= row.get('belowDelta', 999) <= 16):
        raise RuntimeError('toc136 gloss vertical position is wrong: ' + repr(row))
