#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc138 Spanish performance audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const twoFrames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const screen=document.getElementById('screen-reader');
  const library=document.getElementById('reader-library-view');
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!screen||!view||!root) throw new Error('Reader DOM missing');
  if(typeof globalThis.readerSetSpanishGlossMode!=='function') throw new Error('Spanish gloss mode owner missing');
  if(typeof globalThis.readerOpenWordPanel!=='function') throw new Error('Reader word panel opener missing');

  document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('active',el===screen));
  screen.style.display='block';
  if(library) library.style.display='none';
  view.style.display='block';

  const originalHtml=root.innerHTML;
  const originalViewClass=view.className;
  const originalLang=view.dataset.readerLang||'';
  const originalRootLang=root.dataset.lang||'';
  const originalBook=root.dataset.readerBookId||'';
  const originalChapter=root.dataset.renderedChapter||'';

  const owner=localStorage.getItem('an2_reader_active_owner_v1') ||
    (localStorage.getItem('an2_guest')==='1'?'guest':'anon');
  const profileKey=`an2_reader_vocab_estimate_es_v1::${owner}`;
  const oldProfile=localStorage.getItem(profileKey);
  localStorage.setItem(profileKey,JSON.stringify({
    language:'es',version:1,estimate:0,conservativeKnownCount:0,
    listLength:54386,updatedAt:new Date().toISOString(),audit:true,
  }));

  const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const known=w=>`<span class="reader-word rw-migaku-known" data-word="${esc(w)}" data-lang="es">${esc(w)}</span>`;
  const unknown=(w,ru)=>`<span class="rw-es-v1-wrap" data-es-pipeline="v1"><span class="reader-word rw-migaku-unknown" data-word="${esc(w)}" data-lang="es">${esc(w)}</span><span class="rw-es-v1-gloss" aria-hidden="true">${esc(ru)}</span></span>`;

  try {
    view.dataset.readerLang='es';
    root.dataset.lang='es';
    root.dataset.readerBookId='toc138-es-layout-performance-audit';
    root.dataset.renderedChapter='138';
    view.classList.add('rd-es-pipeline-v1','rd-es-language-active');
    window.dispatchEvent(new CustomEvent('an2:languagechange',{detail:{lang:'es'}}));
    await sleep(120);

    if(!view.classList.contains('rd-es-smooth-v1')) throw new Error('toc138 Spanish smooth layer did not activate');

    root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div id="toc138-es-fixture" class="reader-paragraph-text" style="display:block;width:340px;max-width:340px;font-size:30px;margin:20px auto">
      —${known('Pero')} ${known('Emiliano')} ${known('no')} ${known('fue')} ${known('a')} ${known('la')} ${unknown('hacienda','имение')}, ${known('conocía')} ${known('a')} ${known('los')} ${unknown('enemigos','враги')} ${known('y')} ${known('no')} ${known('les')} ${unknown('reposaban','отдыхали')} ${known('ni')} ${unknown('tantito','столько')}, ${known('mandó')} ${known('a')} ${known('un')} ${unknown('compadre','кум')} ${known('suyo')} ${known('que')} ${known('le')} ${unknown('insistió','настоял')} ${known('mucho')}. ${known('Ése')} ${known('fue')} ${known('el')} ${unknown('baleado','застрелен')} ${known('y')} ${unknown('vio','увидел')} ${known('cómo')} ${known('moría')}…
    </div></div>`;

    const paragraph=document.getElementById('toc138-es-fixture');
    const measure=()=>{
      const style=getComputedStyle(paragraph);
      const words=[...paragraph.querySelectorAll('.reader-word')].map(el=>{
        const r=el.getBoundingClientRect();
        return {word:el.dataset.word,left:Number(r.left.toFixed(2)),right:Number(r.right.toFixed(2)),top:Number(r.top.toFixed(2)),width:Number(r.width.toFixed(2))};
      });
      const lineWords=[];
      for(const item of words){
        let line=lineWords.find(row=>Math.abs(row.top-item.top)<=4);
        if(!line){line={top:item.top,words:[]};lineWords.push(line);}
        line.words.push(item.word);
      }
      return {textAlign:style.textAlign,lineHeight:style.lineHeight,words,lineWords:lineWords.map(x=>x.words)};
    };

    globalThis.readerSetSpanishGlossMode('off');
    await twoFrames();
    const ordinary=measure();
    const ordinaryGlossDisplays=[...paragraph.querySelectorAll('.rw-es-v1-gloss')].map(el=>getComputedStyle(el).display);

    globalThis.readerSetSpanishGlossMode('unknown');
    await twoFrames();
    await sleep(50);
    const annotated=measure();
    const geometry=[...paragraph.querySelectorAll('.rw-es-v1-wrap')].map(wrap=>{
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
      };
    });

    const deltas=[];
    for(let i=0;i<Math.min(ordinary.words.length,annotated.words.length);i++){
      const a=ordinary.words[i],b=annotated.words[i];
      deltas.push(Math.max(Math.abs(a.left-b.left),Math.abs(a.right-b.right),Math.abs(a.width-b.width)));
    }
    const maxHorizontalDelta=deltas.length?Number(Math.max(...deltas).toFixed(2)):999;
    const lineBreaksEqual=JSON.stringify(ordinary.lineWords)===JSON.stringify(annotated.lineWords);

    // The old hot path replaced/rebuilt the whole chapter on the animation frame
    // following a lookup. Hold the exact DOM identity across a real production
    // readerOpenWordPanel call; toc138 must keep it alive.
    const wordBefore=paragraph.querySelector('[data-word="reposaban"]');
    const paragraphBefore=wordBefore.closest('.reader-paragraph');
    const openStarted=performance.now();
    const openPromise=globalThis.readerOpenWordPanel('reposaban',0);
    await twoFrames();
    await sleep(70);
    const openFrameMs=Number((performance.now()-openStarted).toFixed(2));
    const wordAfter=root.querySelector('[data-word="reposaban"]');
    const paragraphAfter=wordAfter?.closest('.reader-paragraph');
    const identityPreserved=wordAfter===wordBefore && paragraphAfter===paragraphBefore && wordBefore.isConnected;
    // Let lexical lookup finish, but don't turn network latency into a tap-jank metric.
    try { await Promise.race([Promise.resolve(openPromise),sleep(1200)]); } catch {}
    await sleep(100);

    const panel=document.getElementById('reader-word-panel');
    if(!panel) throw new Error('Spanish word panel missing after real open');
    const knownBtn=panel.querySelector('#reader-es-known-btn');
    const unknownBtn=panel.querySelector('#reader-es-unknown-btn');
    const status=panel.querySelector('#reader-es-knowledge-source');
    if(!knownBtn||!unknownBtn||!status) throw new Error('toc137 Known/Unknown card status disappeared in toc138');

    const clickMeasure=async(button,expected)=>{
      const t0=performance.now();
      button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
      const dispatchMs=Number((performance.now()-t0).toFixed(2));
      await new Promise(r=>requestAnimationFrame(r));
      const afterFrameMs=Number((performance.now()-t0).toFixed(2));
      const text=String(status.textContent||'').trim();
      if(!text.startsWith(expected)) throw new Error(`Spanish status did not update immediately to ${expected}: ${text}`);
      return {dispatchMs,afterFrameMs,text};
    };

    const knownTiming=await clickMeasure(knownBtn,'Знаю');
    const knownWord=root.querySelector('[data-word="reposaban"]');
    const knownClass=knownWord?.classList.contains('rw-migaku-known')||false;
    const knownIdentity=knownWord===wordBefore;

    const unknownTiming=await clickMeasure(unknownBtn,'Не знаю');
    await sleep(420);
    const unknownWord=root.querySelector('[data-word="reposaban"]');
    const unknownClass=unknownWord?.classList.contains('rw-migaku-unknown')||false;
    const unknownIdentity=unknownWord===wordBefore;

    let state=null;
    try {
      const store=globalThis.an2ReaderWordStateSnapshot?.()||{};
      state=store['es:reposaban']||store['es:reposar']||null;
    } catch {}

    return {
      smoothClass:view.classList.contains('rd-es-smooth-v1'),
      ordinary,
      annotated,
      ordinaryGlossDisplays,
      lineBreaksEqual,
      maxHorizontalDelta,
      geometry,
      openFrameMs,
      identityPreserved,
      cardMarker:panel.dataset.migakuKnowledge||'',
      knownTiming,
      unknownTiming,
      knownClass,
      unknownClass,
      knownIdentity,
      unknownIdentity,
      persistedManualKnowledge:state?.manualKnowledge||'',
    };
  } finally {
    root.innerHTML=originalHtml;
    view.className=originalViewClass;
    if(originalLang)view.dataset.readerLang=originalLang;else delete view.dataset.readerLang;
    if(originalRootLang)root.dataset.lang=originalRootLang;else delete root.dataset.lang;
    if(originalBook)root.dataset.readerBookId=originalBook;else delete root.dataset.readerBookId;
    if(originalChapter)root.dataset.renderedChapter=originalChapter;else delete root.dataset.renderedChapter;
    if(oldProfile===null)localStorage.removeItem(profileKey);else localStorage.setItem(profileKey,oldProfile);
  }
})()""", 60)

print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()

if not result:
    raise RuntimeError('toc138 Spanish layout/performance audit returned no result')
if not result.get('smoothClass'):
    raise RuntimeError('toc138 Spanish smooth layer inactive: ' + repr(result))
if (result.get('ordinary') or {}).get('textAlign') != 'justify' or (result.get('annotated') or {}).get('textAlign') != 'justify':
    raise RuntimeError('toc138 Spanish text is not justified in both modes: ' + repr(result))
if any(x != 'none' for x in result.get('ordinaryGlossDisplays') or []):
    raise RuntimeError('toc138 ordinary mode leaked Russian glosses: ' + repr(result))
if not result.get('lineBreaksEqual') or result.get('maxHorizontalDelta', 999) > 1.5:
    raise RuntimeError('toc138 glosses changed Spanish horizontal layout: ' + repr(result))
for row in result.get('geometry') or []:
    if row.get('wrapDisplay') != 'inline' or row.get('wrapPosition') != 'relative' or row.get('glossPosition') != 'absolute':
        raise RuntimeError('toc138 Spanish gloss anchor is not inline/absolute: ' + repr(row))
    if row.get('glossDisplay') == 'none' or row.get('centerDelta', 999) > 4:
        raise RuntimeError('toc138 Spanish gloss is not visibly centered: ' + repr(row))
if not result.get('identityPreserved') or not result.get('knownIdentity') or not result.get('unknownIdentity'):
    raise RuntimeError('toc138 Spanish tap/manual knowledge rebuilt the chapter DOM: ' + repr(result))
if result.get('cardMarker') != 'es1':
    raise RuntimeError('toc137 Spanish card ownership regressed: ' + repr(result))
if not result.get('knownClass') or not result.get('unknownClass'):
    raise RuntimeError('toc138 Spanish manual knowledge did not repaint the visible word: ' + repr(result))
for key in ('knownTiming','unknownTiming'):
    timing=result.get(key) or {}
    if timing.get('dispatchMs',9999) > 120:
        raise RuntimeError(f'toc138 {key} synchronous click path is too slow: {timing!r}')
    if timing.get('afterFrameMs',9999) > 260:
        raise RuntimeError(f'toc138 {key} missed responsive next-frame budget: {timing!r}')
if result.get('persistedManualKnowledge') != 'unknown':
    raise RuntimeError('toc138 Spanish manual status did not persist in canonical live state: ' + repr(result))
