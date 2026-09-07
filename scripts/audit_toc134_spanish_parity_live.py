#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc134 Spanish parity audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!view||!root) throw new Error('Reader DOM missing');
  view.style.display='block';
  view.dataset.readerLang='es';
  root.dataset.lang='es';
  root.dataset.readerBookId='toc134-es-parity-audit';
  root.dataset.renderedChapter='14';

  const owner=localStorage.getItem('an2_reader_active_owner_v1') ||
    (localStorage.getItem('an2_guest')==='1'?'guest':'anon');
  const profileKey=`an2_reader_vocab_estimate_es_v1::${owner}`;
  const oldProfile=localStorage.getItem(profileKey);
  const modeKey='an2_reader_es_unknown_gloss_mode_v1';
  const oldMode=localStorage.getItem(modeKey);
  localStorage.setItem(profileKey,JSON.stringify({
    language:'es',version:1,estimate:0,conservativeKnownCount:0,
    listLength:54386,updatedAt:new Date().toISOString(),audit:true,
  }));
  localStorage.setItem(modeKey,'unknown');

  const originalHtml=root.innerHTML;
  root.innerHTML=`
    <div class="reader-paragraph active" data-p="0"><div class="reader-paragraph-text">
      No hay tantos crímenes como dicen, aunque sobran razones para
      <span class="reader-word" data-word="cometerlos" data-lang="es">cometerlos</span>.
      Pero el hombre es bueno por ser natural y no se atreve a tanto.
    </div></div>
    <div class="reader-paragraph" data-p="1"><div class="reader-paragraph-text">
      Me <span class="reader-word" data-word="bastaron" data-lang="es">bastaron</span> las razones.
    </div></div>`;

  try {
    if(typeof globalThis.readerSpanishPipelineV1RefreshNow!=='function') throw new Error('Spanish reader pipeline missing');
    await globalThis.readerSpanishPipelineV1RefreshNow('toc134-parity',true);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await sleep(80);

    if(typeof globalThis.readerSpanishLexicalAnalysisFor!=='function') throw new Error('Spanish lexical owner missing');
    const cometer=await globalThis.readerSpanishLexicalAnalysisFor('cometerlos');
    const bastaron=await globalThis.readerSpanishLexicalAnalysisFor('bastaron');
    if(!cometer || cometer.lemma!=='cometer') throw new Error('cometerlos did not resolve to Spanish lemma cometer: '+JSON.stringify(cometer));
    if(!bastaron || bastaron.lemma!=='bastar') throw new Error('bastaron did not resolve to Spanish lemma bastar: '+JSON.stringify(bastaron));
    if(String(cometer._source||'').includes('fr') || String(bastaron._source||'').includes('fr')) throw new Error('Spanish word card leaked into French lexical source');

    if(typeof globalThis.readerSpanishGlossMode!=='function' || typeof globalThis.readerSetSpanishGlossMode!=='function') {
      throw new Error('Spanish English-parity gloss controls missing');
    }
    globalThis.readerSetSpanishGlossMode('unknown');
    await sleep(20);
    const word=root.querySelector('[data-word="cometerlos"]');
    const wrap=word?.parentElement?.classList?.contains('rw-es-v1-wrap')?word.parentElement:null;
    const gloss=wrap?.querySelector('.rw-es-v1-gloss');
    if(!word||!wrap||!gloss||!String(gloss.textContent||'').trim()) throw new Error('Spanish Unknown inline gloss missing');
    const enabledStyle={
      wrapDisplay:getComputedStyle(wrap).display,
      wrapPosition:getComputedStyle(wrap).position,
      glossDisplay:getComputedStyle(gloss).display,
      glossPosition:getComputedStyle(gloss).position,
      glossBottom:getComputedStyle(gloss).bottom,
      paragraphLineHeight:getComputedStyle(word.closest('.reader-paragraph-text')).lineHeight,
    };
    if(enabledStyle.wrapDisplay!=='inline-block' || enabledStyle.wrapPosition!=='relative' || enabledStyle.glossPosition!=='absolute' || enabledStyle.glossDisplay==='none') {
      throw new Error('Spanish enabled layout diverged from English geometry: '+JSON.stringify(enabledStyle));
    }

    globalThis.readerSetSpanishGlossMode('off');
    await sleep(20);
    const disabledStyle={
      wrapDisplay:getComputedStyle(wrap).display,
      wrapPosition:getComputedStyle(wrap).position,
      glossDisplay:getComputedStyle(gloss).display,
    };
    if(disabledStyle.wrapDisplay!=='inline' || disabledStyle.wrapPosition!=='static' || disabledStyle.glossDisplay!=='none') {
      throw new Error('Spanish ordinary-text mode still reserves interlinear layout: '+JSON.stringify(disabledStyle));
    }
    globalThis.readerSetSpanishGlossMode('unknown');

    // Aa must expose the same two-state control as English.
    const aaRow=document.getElementById('rd-dp-es-unknown-gloss-row');
    if(!aaRow || getComputedStyle(aaRow).display==='none') throw new Error('Spanish Unknown-word row is missing from Aa');
    const aaModes=[...aaRow.querySelectorAll('.rd-es-gloss-mode')].map(b=>({mode:b.dataset.mode,text:(b.textContent||'').trim(),active:b.classList.contains('rd-dp-active')}));
    if(aaModes.length!==2 || !aaModes.some(x=>x.mode==='off') || !aaModes.some(x=>x.mode==='unknown')) throw new Error('Spanish Aa mode buttons malformed: '+JSON.stringify(aaModes));

    // Only the Spanish vocabulary W may remain visible while ES is active.
    // If another language module has not created its button yet, that is fine;
    // any existing foreign W must be hidden.
    const vocabIds=['reader-vocab-btn','reader-en-vocab-btn','reader-fr-vocab-btn','reader-es-vocab-btn'];
    const vocabButtons=vocabIds.map(id=>{
      const el=document.getElementById(id);
      return {id,exists:!!el,display:el?getComputedStyle(el).display:'missing'};
    });
    const esButton=document.getElementById('reader-es-vocab-btn');
    if(!esButton || getComputedStyle(esButton).display==='none') throw new Error('Spanish vocabulary W is not visible: '+JSON.stringify(vocabButtons));
    for(const row of vocabButtons) {
      if(row.id!=='reader-es-vocab-btn' && row.exists && row.display!=='none') throw new Error('Foreign vocabulary W visible in Spanish: '+JSON.stringify(vocabButtons));
    }

    // Open the real Reader word panel. The local card must be Spanish and the
    // generated Known/Unknown controls must decorate the same panel.
    if(typeof globalThis.readerOpenWordPanel==='function') {
      await globalThis.readerOpenWordPanel('cometerlos',0);
      await globalThis.readerSpanishPipelineV1RefreshNow('toc134-panel',true);
      await sleep(80);
    }
    const panel=document.getElementById('reader-word-panel');
    const knownBtn=document.getElementById('reader-es-known-btn');
    const unknownBtn=document.getElementById('reader-es-unknown-btn');
    const panelSnapshot={
      title:String(document.getElementById('reader-word-title')?.textContent||'').trim(),
      visible:!!panel && getComputedStyle(panel).display!=='none',
      known:!!knownBtn,
      unknown:!!unknownBtn,
      text:String(panel?.textContent||'').replace(/\s+/g,' ').trim().slice(0,900),
    };
    if(!knownBtn || !unknownBtn) throw new Error('Spanish manual Known/Unknown controls missing from word panel: '+JSON.stringify(panelSnapshot));
    if(!/cometer/i.test(panelSnapshot.text) || /forme du verbe|verbe français|français/i.test(panelSnapshot.text)) {
      throw new Error('Spanish panel is not owned by Spanish lexical data: '+JSON.stringify(panelSnapshot));
    }

    // Real manual transitions: Unknown -> Known removes the inline gloss owner;
    // Known -> Unknown restores it after the event-driven ES refresh.
    knownBtn.click();
    await sleep(80);
    await globalThis.readerSpanishPipelineV1RefreshNow('toc134-manual-known',true);
    const afterKnown={known:word.classList.contains('rw-migaku-known'),unknown:word.classList.contains('rw-migaku-unknown'),wrapped:word.parentElement?.classList?.contains('rw-es-v1-wrap')||false};
    if(!afterKnown.known || afterKnown.unknown || afterKnown.wrapped) throw new Error('Spanish manual Known did not remove Unknown/gloss: '+JSON.stringify(afterKnown));

    // Reopen because a Reader rerender/panel state may replace DOM nodes.
    if(typeof globalThis.readerOpenWordPanel==='function') await globalThis.readerOpenWordPanel('cometerlos',0);
    await globalThis.readerSpanishPipelineV1RefreshNow('toc134-panel-again',true);
    await sleep(60);
    document.getElementById('reader-es-unknown-btn')?.click();
    await sleep(80);
    await globalThis.readerSpanishPipelineV1RefreshNow('toc134-manual-unknown',true);
    const word2=root.querySelector('[data-word="cometerlos"]');
    const afterUnknown={known:word2?.classList.contains('rw-migaku-known')||false,unknown:word2?.classList.contains('rw-migaku-unknown')||false,wrapped:word2?.parentElement?.classList?.contains('rw-es-v1-wrap')||false,ru:String(word2?.parentElement?.querySelector?.('.rw-es-v1-gloss')?.textContent||'').trim()};
    if(afterUnknown.known || !afterUnknown.unknown || !afterUnknown.wrapped || !afterUnknown.ru) throw new Error('Spanish manual Unknown did not restore inline gloss: '+JSON.stringify(afterUnknown));

    return {owner,cometer,bastaron,enabledStyle,disabledStyle,aaModes,vocabButtons,panelSnapshot,afterKnown,afterUnknown};
  } finally {
    root.innerHTML=originalHtml;
    if(oldProfile===null)localStorage.removeItem(profileKey);else localStorage.setItem(profileKey,oldProfile);
    if(oldMode===null)localStorage.removeItem(modeKey);else localStorage.setItem(modeKey,oldMode);
  }
})()""", 55)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('toc134 Spanish parity audit returned no result')
if result.get('cometer', {}).get('lemma') != 'cometer':
    raise RuntimeError('toc134 Spanish clitic lemma parity failed: ' + repr(result))
if result.get('bastaron', {}).get('lemma') != 'bastar':
    raise RuntimeError('toc134 Spanish conjugation lemma parity failed: ' + repr(result))
if result.get('enabledStyle', {}).get('wrapDisplay') != 'inline-block':
    raise RuntimeError('toc134 Spanish inline layout parity failed: ' + repr(result))
if result.get('disabledStyle', {}).get('glossDisplay') != 'none':
    raise RuntimeError('toc134 Spanish ordinary-text mode failed: ' + repr(result))
if not result.get('afterKnown', {}).get('known') or result.get('afterKnown', {}).get('wrapped'):
    raise RuntimeError('toc134 Spanish Known transition failed: ' + repr(result))
if not result.get('afterUnknown', {}).get('unknown') or not result.get('afterUnknown', {}).get('ru'):
    raise RuntimeError('toc134 Spanish Unknown transition failed: ' + repr(result))

cdp.close()
