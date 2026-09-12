#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc138 French audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const twoFrames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const screen=document.getElementById('screen-reader');
  const library=document.getElementById('reader-library-view');
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!screen||!view||!root) throw new Error('Reader DOM missing');
  if(!window.__readerFrSmoothV1) throw new Error('toc138 French smooth owner missing');

  document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('active',el===screen));
  screen.style.display='block';
  if(library) library.style.display='none';
  view.style.display='block';
  view.dataset.readerLang='fr';
  root.dataset.lang='fr';
  root.dataset.readerBookId='toc138-fr-layout-performance';
  root.dataset.renderedChapter='138';
  view.classList.add('rd-fr-pipeline-v2','rd-fr-smooth-v1');
  window.dispatchEvent(new CustomEvent('an2:languagechange'));
  await twoFrames();

  const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const token=w=>`<span class="reader-word rw-migaku-known" data-word="${esc(w)}" data-lang="fr">${esc(w)}</span>`;
  const sentence=[
    '—','Vous','feriez','mieux','de','vous','appeler','monsieur','Bouillon,','déclara','Treuffais,',"s’adressant",'à','son','levier','de','vitesses.','Vous','pourriez','donner','votre','nom','à','votre','institution',':','Le','Cours','Bouillon.'
  ];
  const unknownRu=new Map([
    ['mieux','лучше'],['déclara','заявил'],["s’adressant",'обращаясь'],['levier','рычаг'],['vitesses.','передачи'],['pourriez','могли бы'],['institution','учреждение']
  ]);

  root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div id="toc138-fr-fixture" class="reader-paragraph-text" style="display:block;width:340px;max-width:340px;font-size:31px;margin:18px auto">${sentence.map(token).join(' ')}</div></div>`;
  const paragraph=document.getElementById('toc138-fr-fixture');

  const measure=()=>{
    const pr=paragraph.getBoundingClientRect();
    const style=getComputedStyle(paragraph);
    const words=[...paragraph.querySelectorAll('.reader-word')].map((el,index)=>{
      const r=el.getBoundingClientRect();
      return {index,word:el.dataset.word,left:Number(r.left.toFixed(2)),right:Number(r.right.toFixed(2)),top:Number(r.top.toFixed(2)),width:Number(r.width.toFixed(2))};
    });
    const lines=[];
    for(const item of words){
      let line=lines.find(x=>Math.abs(x.top-item.top)<=4);
      if(!line){line={top:item.top,items:[]};lines.push(line);}
      line.items.push(item);
    }
    lines.sort((a,b)=>a.top-b.top);
    for(const line of lines)line.items.sort((a,b)=>a.left-b.left);
    const edgeDeltas=lines.slice(0,-1).map(line=>Number((pr.right-(line.items.at(-1)?.right||pr.left)).toFixed(2)));
    const gaps=[];
    for(const line of lines){
      for(let i=1;i<line.items.length;i++){
        const a=line.items[i-1],b=line.items[i];
        if(b.left>=a.right)gaps.push(Number((b.left-a.right).toFixed(2)));
      }
    }
    return {
      textAlign:style.textAlign,textAlignLast:style.textAlignLast,
      width:Number(pr.width.toFixed(2)),height:Number(pr.height.toFixed(2)),lineHeight:style.lineHeight,
      words,lineWords:lines.map(l=>l.items.map(x=>x.word)),edgeDeltas,gaps,maxGap:gaps.length?Math.max(...gaps):null,
    };
  };

  await twoFrames();
  const ordinary=measure();

  for(const el of [...paragraph.querySelectorAll('.reader-word')]){
    const ru=unknownRu.get(el.dataset.word);
    if(!ru)continue;
    el.classList.remove('rw-migaku-known');
    el.classList.add('rw-migaku-unknown');
    const wrap=document.createElement('span');
    wrap.className='rw-fr-v2-wrap';
    wrap.dataset.frPipeline='v2';
    el.parentNode.insertBefore(wrap,el);
    wrap.appendChild(el);
    const gloss=document.createElement('span');
    gloss.className='rw-fr-v2-gloss';
    gloss.setAttribute('aria-hidden','true');
    gloss.textContent=ru;
    wrap.appendChild(gloss);
  }
  await twoFrames();
  await sleep(50);
  const annotated=measure();

  const deltas=[];
  for(let i=0;i<Math.min(ordinary.words.length,annotated.words.length);i++){
    const a=ordinary.words[i],b=annotated.words[i];
    deltas.push(Math.max(Math.abs(a.left-b.left),Math.abs(a.right-b.right),Math.abs(a.width-b.width)));
  }
  const maxHorizontalDelta=deltas.length?Number(Math.max(...deltas).toFixed(2)):null;
  const lineBreaksEqual=JSON.stringify(ordinary.lineWords)===JSON.stringify(annotated.lineWords);
  const glossGeometry=[...paragraph.querySelectorAll('.rw-fr-v2-wrap')].map(wrap=>{
    const word=wrap.querySelector('.reader-word'),gloss=wrap.querySelector('.rw-fr-v2-gloss');
    const wr=word.getBoundingClientRect(),gr=gloss.getBoundingClientRect();
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

  // Now stress the exact interaction from the user's recording. The old French
  // button handler synchronously walked the whole rendered chapter, then fired a
  // forced pipeline refresh. toc138 owns the click in capture phase and updates
  // only the visible occurrence before deferred persistence/reconciliation.
  const owner=localStorage.getItem('an2_reader_active_owner_v1') || (localStorage.getItem('an2_guest')==='1'?'guest':'anon');
  const profileKey=`an2_reader_vocab_estimate_fr_v1::${owner}`;
  const oldProfile=localStorage.getItem(profileKey);
  localStorage.setItem(profileKey,JSON.stringify({language:'fr',version:1,estimate:2500,conservativeKnownCount:1500,listLength:60000,updatedAt:new Date().toISOString(),audit:true}));

  const rows=[];
  for(let p=0;p<22;p++){
    const words=[];
    for(let i=0;i<82;i++){
      const w=(p===0&&i===17)?'pourriez':(['vous','faire','avec','temps','livre','regarder','venir','petit','jour','encore'][i%10]);
      words.push(`<span class="reader-word" data-word="${w}" data-lang="fr">${w}</span>`);
    }
    rows.push(`<div class="reader-paragraph${p===0?' active':''}" data-p="${p}"><div class="reader-paragraph-text">${words.join(' ')}</div></div>`);
  }
  root.innerHTML=rows.join('');
  root.dataset.renderedChapter='138-performance';

  if(typeof globalThis.readerFrenchPipelineV2RefreshNow!=='function')throw new Error('French pipeline refresh owner missing');
  await globalThis.readerFrenchPipelineV2RefreshNow('toc138-prime',true);
  await sleep(140);

  // Wait for the late owner to replace the expensive batch API after the legacy
  // vocabulary module has been dynamically materialized by the French pipeline.
  for(let i=0;i<30&&!globalThis.readerApplyFrenchVocabularyEstimate?.__toc138Smooth;i++)await sleep(60);
  const smoothApplyInstalled=!!globalThis.readerApplyFrenchVocabularyEstimate?.__toc138Smooth;

  document.getElementById('reader-word-panel')?.remove();
  const panelModuleUrl=new URL('js/reader/word-panel.js?v=5',document.baseURI).href;
  const {createReaderWordPanel}=await import(panelModuleUrl);
  const panelOwner=createReaderWordPanel({
    escape:value=>String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'),
    canonicalLang:()=> 'fr',currentLang:()=> 'fr',extractPinyin:()=>'',extractReading:()=>'',
    getSelectedWord:()=>String(document.getElementById('reader-word-title')?.textContent||'').trim(),
  });
  const panel=panelOwner.ensure();
  panel.style.display='block';
  panel.querySelector('#reader-word-title').textContent='pourriez';
  const target=root.querySelector('[data-word="pourriez"]');
  target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch'}));
  target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  await sleep(90);

  const unknown=panel.querySelector('#reader-fr-unknown-btn');
  const known=panel.querySelector('#reader-fr-known-btn');
  const source=panel.querySelector('#reader-fr-knowledge-source');
  if(!unknown||!known||!source)throw new Error('French Known/Unknown controls missing in performance audit');

  const timings=[];
  const runTap=async(button,label)=>{
    const start=performance.now();
    button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    const dispatchMs=performance.now()-start;
    await new Promise(resolve=>requestAnimationFrame(()=>resolve(performance.now()-start)));
    const rafMs=performance.now()-start;
    timings.push({label,dispatchMs:Number(dispatchMs.toFixed(2)),rafMs:Number(rafMs.toFixed(2)),status:String(source.textContent||'').trim(),knownActive:known.classList.contains('is-active'),unknownActive:unknown.classList.contains('is-active'),targetKnown:target.classList.contains('rw-migaku-known'),targetUnknown:target.classList.contains('rw-migaku-unknown')});
    await sleep(60);
  };
  await runTap(unknown,'unknown');
  await runTap(known,'known');

  // Give deferred IDB/local reconciliation a chance to run; the card must stay
  // responsive and semantically correct after the deferred work too.
  await sleep(450);
  const finalInfo=globalThis.readerFrenchVocabularyKnowledgeFor?.('pourriez')||null;
  const performanceSnapshot={
    renderedWords:root.querySelectorAll('.reader-word[data-word]').length,
    smoothApplyInstalled,
    timings,
    finalStatus:String(source.textContent||'').trim(),
    finalKnown:!!known.classList.contains('is-active'),
    finalUnknown:!!unknown.classList.contains('is-active'),
    finalKnowledge:finalInfo?.value||'',
  };

  if(oldProfile===null)localStorage.removeItem(profileKey);else localStorage.setItem(profileKey,oldProfile);

  return {ordinary,annotated,lineBreaksEqual,maxHorizontalDelta,deltas,glossGeometry,performance:performanceSnapshot};
})()""", 70)

print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()

if not result:
    raise RuntimeError('toc138 French audit returned no result')
ordinary=result.get('ordinary') or {}
annotated=result.get('annotated') or {}
if ordinary.get('textAlign')!='justify' or annotated.get('textAlign')!='justify':
    raise RuntimeError('toc138 French text is not justified: '+repr(result))
if len(ordinary.get('lineWords') or []) < 4 or len(annotated.get('lineWords') or []) < 4:
    raise RuntimeError('toc138 French fixture did not form book lines: '+repr(result))
if not result.get('lineBreaksEqual'):
    raise RuntimeError('French glosses changed source line breaks: '+repr(result))
if result.get('maxHorizontalDelta') is None or result.get('maxHorizontalDelta') > 1.5:
    raise RuntimeError('French glosses changed horizontal source metrics: '+repr(result))
# Non-final justified lines should visually reach the right book margin. Allow
# punctuation outside word boxes and sub-pixel/font differences on the emulator.
if any(delta > 24 for delta in annotated.get('edgeDeltas') or []):
    raise RuntimeError('French paragraph still has a ragged right edge: '+repr(annotated.get('edgeDeltas')))
for row in result.get('glossGeometry') or []:
    if row.get('wrapDisplay')!='inline' or row.get('wrapPosition')!='relative' or row.get('glossPosition')!='absolute':
        raise RuntimeError('French inline gloss anchor inactive: '+repr(row))
    if row.get('centerDelta',999)>4 or not (-3 <= row.get('belowDelta',999) <= 16):
        raise RuntimeError('French gloss geometry wrong: '+repr(row))

perf=result.get('performance') or {}
if not perf.get('smoothApplyInstalled'):
    raise RuntimeError('toc138 smooth French batch owner was not installed: '+repr(perf))
if perf.get('renderedWords',0) < 1700:
    raise RuntimeError('toc138 jank fixture is too small: '+repr(perf))
for row in perf.get('timings') or []:
    if row.get('dispatchMs',999) > 120:
        raise RuntimeError('French manual status blocks the tap frame: '+repr(row))
    if row.get('rafMs',999) > 180:
        raise RuntimeError('French manual status misses the next responsive frame: '+repr(row))
    if not row.get('status'):
        raise RuntimeError('French manual status text disappeared: '+repr(row))
if perf.get('finalKnowledge')!='known' or not perf.get('finalKnown'):
    raise RuntimeError('French deferred reconciliation lost final Known state: '+repr(perf))
