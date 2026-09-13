#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc137 Spanish status audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!view||!root) throw new Error('Reader DOM missing');
  view.style.display='block';
  view.dataset.readerLang='es';
  root.dataset.lang='es';
  root.dataset.readerBookId='toc137-es-status-audit';
  root.dataset.renderedChapter='17';

  const owner=localStorage.getItem('an2_reader_active_owner_v1') ||
    (localStorage.getItem('an2_guest')==='1'?'guest':'anon');
  const profileKey=`an2_reader_vocab_estimate_es_v1::${owner}`;
  const oldProfile=localStorage.getItem(profileKey);
  localStorage.setItem(profileKey,JSON.stringify({
    language:'es',version:1,estimate:0,conservativeKnownCount:0,
    listLength:54386,updatedAt:new Date().toISOString(),audit:true,
  }));

  const originalHtml=root.innerHTML;
  let panel=document.getElementById('reader-word-panel');
  let createdPanel=false;
  if(!panel){
    const panelModuleUrl=new URL('js/reader/word-panel.js?v=5',document.baseURI).href;
    const {createReaderWordPanel}=await import(panelModuleUrl);
    const panelOwner=createReaderWordPanel({
      escape:value=>String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
      canonicalLang:()=> 'es', currentLang:()=> 'es', extractPinyin:()=>'', extractReading:()=>'',
      getSelectedWord:()=>String(document.getElementById('reader-word-title')?.textContent||'').trim(),
    });
    panel=panelOwner.ensure();
    createdPanel=true;
  }
  const title=document.getElementById('reader-word-title');
  if(!panel||!title) throw new Error('Production word panel unavailable');
  const oldPanelDisplay=panel.style.display ?? '';
  const oldTitle=title.textContent ?? '';

  root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div class="reader-paragraph-text">Ellos <span class="reader-word rw-sel" data-word="reposaban" data-lang="es">reposaban</span> después del viaje.</div></div>`;

  try {
    if(typeof globalThis.readerSpanishPipelineV1RefreshNow!=='function') throw new Error('Spanish pipeline missing');
    await globalThis.readerSpanishPipelineV1RefreshNow('toc137-status-initial',true);
    await sleep(120);
    panel.style.display='block';
    title.textContent='reposaban';
    document.dispatchEvent(new CustomEvent('reader-word-analysis-ready',{detail:{surface:'reposaban',lang:'es',lemma:'reposar',source:'local'}}));
    await sleep(280);

    if(typeof globalThis.readerSpanishKnowledgeStatusSync!=='function') throw new Error('toc137 knowledge status module missing');
    globalThis.readerSpanishKnowledgeStatusSync({surface:'reposaban',lang:'es'});
    let chip=document.getElementById('reader-es-current-knowledge');
    const initial={
      text:String(chip?.textContent||'').trim(),
      knowledge:String(chip?.dataset?.knowledge||''),
      source:String(chip?.dataset?.source||''),
      display:chip?getComputedStyle(chip).display:'missing',
    };
    if(!chip || initial.knowledge!=='unknown' || !/НЕ ЗНАЮ/.test(initial.text) || initial.display==='none') {
      throw new Error('Unknown current-state marker missing: '+JSON.stringify(initial));
    }

    let knownBtn=document.getElementById('reader-es-known-btn');
    let unknownBtn=document.getElementById('reader-es-unknown-btn');
    if(!knownBtn||!unknownBtn) {
      await globalThis.readerSpanishPipelineV1RefreshNow('toc137-status-controls',true);
      await sleep(120);
      knownBtn=document.getElementById('reader-es-known-btn');
      unknownBtn=document.getElementById('reader-es-unknown-btn');
    }
    if(!knownBtn||!unknownBtn) throw new Error('Spanish manual controls missing during status audit');

    knownBtn.click();
    await sleep(180);
    globalThis.readerSpanishKnowledgeStatusSync({surface:'reposaban',lang:'es'});
    chip=document.getElementById('reader-es-current-knowledge');
    const afterKnown={
      text:String(chip?.textContent||'').trim(),
      knowledge:String(chip?.dataset?.knowledge||''),
      owner:String(globalThis.readerSpanishVocabularyKnowledgeFor?.('reposaban')?.value||''),
    };
    if(afterKnown.knowledge!=='known' || !/ЗНАЮ/.test(afterKnown.text) || /НЕ ЗНАЮ/.test(afterKnown.text) || afterKnown.owner!=='known') {
      throw new Error('Known marker did not follow canonical state: '+JSON.stringify(afterKnown));
    }

    unknownBtn=document.getElementById('reader-es-unknown-btn');
    if(!unknownBtn) throw new Error('Unknown control disappeared');
    unknownBtn.click();
    await sleep(180);
    globalThis.readerSpanishKnowledgeStatusSync({surface:'reposaban',lang:'es'});
    chip=document.getElementById('reader-es-current-knowledge');
    const afterUnknown={
      text:String(chip?.textContent||'').trim(),
      knowledge:String(chip?.dataset?.knowledge||''),
      owner:String(globalThis.readerSpanishVocabularyKnowledgeFor?.('reposaban')?.value||''),
    };
    if(afterUnknown.knowledge!=='unknown' || !/НЕ ЗНАЮ/.test(afterUnknown.text) || afterUnknown.owner!=='unknown') {
      throw new Error('Unknown marker did not follow canonical state: '+JSON.stringify(afterUnknown));
    }

    panel.style.display='none';
    await sleep(20);
    panel.style.display='block';
    title.textContent='reposaban';
    globalThis.readerSpanishKnowledgeStatusSync({surface:'reposaban',lang:'es'});
    chip=document.getElementById('reader-es-current-knowledge');
    const reopened={text:String(chip?.textContent||'').trim(),knowledge:String(chip?.dataset?.knowledge||'')};
    if(reopened.knowledge!=='unknown' || !/НЕ ЗНАЮ/.test(reopened.text)) throw new Error('Status did not survive panel reopen: '+JSON.stringify(reopened));

    return {owner,initial,afterKnown,afterUnknown,reopened};
  } finally {
    root.innerHTML=originalHtml;
    if(createdPanel) panel.remove();
    else { panel.style.display=oldPanelDisplay; title.textContent=oldTitle; }
    if(oldProfile===null)localStorage.removeItem(profileKey);else localStorage.setItem(profileKey,oldProfile);
  }
})()""", 55)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('toc137 Spanish status audit returned no result')
if result.get('initial', {}).get('knowledge') != 'unknown':
    raise RuntimeError('toc137 initial Unknown state failed: ' + repr(result))
if result.get('afterKnown', {}).get('knowledge') != 'known':
    raise RuntimeError('toc137 Known transition failed: ' + repr(result))
if result.get('afterUnknown', {}).get('knowledge') != 'unknown':
    raise RuntimeError('toc137 Unknown transition failed: ' + repr(result))
if result.get('reopened', {}).get('knowledge') != 'unknown':
    raise RuntimeError('toc137 reopen persistence failed: ' + repr(result))

cdp.close()
