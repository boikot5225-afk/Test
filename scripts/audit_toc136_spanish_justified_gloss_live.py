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
  const screen=document.getElementById('screen-reader');
  const library=document.getElementById('reader-library-view');
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!screen||!view||!root) throw new Error('Reader DOM missing');
  if(typeof globalThis.readerSetSpanishGlossMode!=='function') throw new Error('Spanish gloss mode owner missing');

  // The reader screen itself is normally hidden until a real book is opened.
  // A hidden ancestor makes getBoundingClientRect() return 0x0 and turns the
  // layout audit into a fake pass/fail. Activate the actual reader hierarchy
  // before inserting the diagnostic paragraph so Chromium performs real line
  // layout at the emulated handset width.
  document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('active',el===screen));
  screen.style.display='block';
  if(library) library.style.display='none';
  view.style.display='block';

  const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const known=w=>`<span class="reader-word rw-migaku-known" data-word="${esc(w)}" data-lang="es">${esc(w)}</span>`;
  const unknown=(w,ru)=>`<span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="${esc(w)}" data-lang="es">${esc(w)}</span><span class="rw-es-v1-gloss" aria-hidden="true">${esc(ru)}</span></span>`;

  view.dataset.readerLang='es';
  root.dataset.lang='es';
  view.classList.add('rd-es-pipeline-v1','rd-es-language-active');
  root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div id="toc136-user-fixture" class="reader-paragraph-text" style="display:block;text-align:justify;width:340px;max-width:340px;font-size:32px;margin:20px auto">
    —${known('Pero')} ${known('Emiliano')} ${known('no')} ${known('fue')} ${known('a')} ${known('la')} ${unknown('hacienda','имение')}, ${known('conocía')} ${known('a')} ${known('los')} ${unknown('enemigos','враги')} ${known('y')} ${known('no')} ${known('les')} ${known('confiaba')} ${known('ni')} ${unknown('tantito','столько')}, ${known('mandó')} ${known('a')} ${known('un')} ${unknown('compadre','кум')} ${known('suyo')} ${known('que')} ${known('le')} ${unknown('insistió','настоял')} ${known('mucho')}. ${known('Pa’')} ${known('que')} ${known('se')} ${known('le')} ${known('quitara')} ${known('lo')} ${unknown('jodón','надоеда')}. ${known('Ése')} ${known('fue')} ${known('el')} ${known('que')} ${known('murió')} ${unknown('baleado','застрелен')}: ${known('Emiliano')} ${known('se')} ${unknown('escondió','спрятался')}, ${known('y')} ${unknown('vio','увидел')} ${known('cómo')} ${known('la')} ${known('Revolución')} ${known('se')} ${known('moría')}…
  </div></div>`;

  const paragraph=document.getElementById('toc136-user-fixture');
  const measure=()=>{
    const pStyle=getComputedStyle(paragraph);
    const pr=paragraph.getBoundingClientRect();
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
    for(const line of lines){
      line.items.sort((a,b)=>a.left-b.left);
      for(let i=1;i<line.items.length;i++){
        const a=line.items[i-1],b=line.items[i];
        if(b.left>=a.right) gaps.push(Number((b.left-a.right).toFixed(2)));
      }
    }
    return {
      textAlign:pStyle.textAlign,
      display:pStyle.display,
      width:Number(pr.width.toFixed(2)),
      height:Number(pr.height.toFixed(2)),
      lineHeight:pStyle.lineHeight,
      lineWords:lines.map(l=>l.items.map(x=>x.word)),
      lines:lines.map(l=>({top:l.top,left:l.items[0]?.left,right:l.items[l.items.length-1]?.right,words:l.items.map(x=>x.word)})),
      words,
      gaps,
      maxGap:gaps.length?Math.max(...gaps):null,
    };
  };

  // Ordinary mode is the ground truth. The annotation layer is allowed to add
  // vertical room, but must not change Spanish line breaks or horizontal metrics.
  globalThis.readerSetSpanishGlossMode('off');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  await sleep(40);
  const ordinary=measure();

  globalThis.readerSetSpanishGlossMode('unknown');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  await sleep(80);
  const annotated=measure();

  const horizontalDeltas=[];
  for(let i=0;i<Math.min(ordinary.words.length,annotated.words.length);i++){
    const a=ordinary.words[i], b=annotated.words[i];
    horizontalDeltas.push(Math.max(Math.abs(a.left-b.left),Math.abs(a.right-b.right),Math.abs(a.width-b.width)));
  }
  const maxHorizontalDelta=horizontalDeltas.length?Number(Math.max(...horizontalDeltas).toFixed(2)):null;
  const lineBreaksEqual=JSON.stringify(ordinary.lineWords)===JSON.stringify(annotated.lineWords);

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
    ordinary,
    annotated,
    lineBreaksEqual,
    maxHorizontalDelta,
    horizontalDeltas,
    glossGeometry,
  };
})()""", 40)

print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()

if not result:
    raise RuntimeError('toc136 Spanish justified gloss audit returned no result')
ordinary = result.get('ordinary') or {}
annotated = result.get('annotated') or {}
if ordinary.get('textAlign') != 'justify' or annotated.get('textAlign') != 'justify':
    raise RuntimeError('toc136 did not preserve EPUB justification: ' + repr(result))
if len(ordinary.get('lineWords') or []) < 5 or len(annotated.get('lineWords') or []) < 5:
    raise RuntimeError('toc136 diagnostic fixture did not form book lines: ' + repr(result))
if not result.get('lineBreaksEqual'):
    raise RuntimeError('Spanish annotations changed source line breaks: ' + repr(result))
if result.get('maxHorizontalDelta') is None or result.get('maxHorizontalDelta') > 1.5:
    raise RuntimeError('Spanish annotations changed horizontal source metrics: ' + repr(result))
for row in result.get('glossGeometry') or []:
    if row.get('wrapDisplay') != 'inline' or row.get('wrapPosition') != 'relative' or row.get('glossPosition') != 'absolute':
        raise RuntimeError('toc136 inline gloss anchor inactive: ' + repr(row))
    if row.get('centerDelta', 999) > 4:
        raise RuntimeError('toc136 gloss is not centered below source word: ' + repr(row))
    if not (-3 <= row.get('belowDelta', 999) <= 16):
        raise RuntimeError('toc136 gloss vertical position is wrong: ' + repr(row))
