#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for toc137 Spanish card-status audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const view=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  if(!view||!root) throw new Error('Reader DOM missing');

  view.style.display='block';
  view.dataset.readerLang='es';
  root.dataset.lang='es';
  root.dataset.readerBookId='toc137-es-card-status-audit';
  root.dataset.renderedChapter='137';

  const owner=localStorage.getItem('an2_reader_active_owner_v1') ||
    (localStorage.getItem('an2_guest')==='1'?'guest':'anon');
  const profileKey=`an2_reader_vocab_estimate_es_v1::${owner}`;
  const oldProfile=localStorage.getItem(profileKey);
  localStorage.setItem(profileKey,JSON.stringify({
    language:'es',version:1,estimate:0,conservativeKnownCount:0,
    listLength:54386,updatedAt:new Date().toISOString(),audit:true,
  }));

  const originalHtml=root.innerHTML;
  const existingPanel=document.getElementById('reader-word-panel');
  if(existingPanel) existingPanel.remove();

  root.innerHTML=`<div class="reader-paragraph active" data-p="0"><div class="reader-paragraph-text">
    Se <span class="reader-word" data-word="reposaban" data-lang="es">reposaban</span> en silencio.
  </div></div>`;

  try {
    // Reproduce the real startup order that caused the bug: the French owner has
    // already claimed its document-level hook before the first Spanish word tap.
    document.documentElement.dataset.readerFrVocabPanelHook='1';
    delete document.documentElement.dataset.readerEsVocabPanelHook;

    if(typeof globalThis.readerSpanishPipelineV1RefreshNow!=='function') {
      throw new Error('Spanish reader pipeline missing');
    }

    // Prime Spanish while the production word panel is still absent. This is
    // exactly the lazy-panel path the old toc136 audit accidentally skipped.
    await globalThis.readerSpanishPipelineV1RefreshNow('toc137-before-panel',true);
    await sleep(80);

    if(document.documentElement.dataset.readerEsVocabPanelHook!=='1') {
      throw new Error('Spanish panel hook was not independently installed after French hook');
    }

    const panelModuleUrl=new URL('js/reader/word-panel.js?v=5',document.baseURI).href;
    const {createReaderWordPanel}=await import(panelModuleUrl);
    const panelOwner=createReaderWordPanel({
      escape:value=>String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
      canonicalLang:()=> 'es',
      currentLang:()=> 'es',
      extractPinyin:()=>'',
      extractReading:()=>'',
      getSelectedWord:()=>String(document.getElementById('reader-word-title')?.textContent||'').trim(),
    });
    const panel=panelOwner.ensure();
    panel.style.display='block';

    // Reproduce the second collision too: the same shared panel may previously
    // have been decorated by French in the current session.
    panel.dataset.migakuKnowledge='fr1';
    const actions=panel.querySelector('.reader-word-actions');
    const fake=document.createElement('div');
    fake.className='rwp-migaku-knowledge';
    fake.innerHTML='<button id="reader-fr-unknown-btn">Не знаю</button><button id="reader-fr-known-btn">Знаю</button><div id="reader-fr-knowledge-source">French marker</div>';
    actions.before(fake);

    const title=panel.querySelector('#reader-word-title');
    title.textContent='reposaban';
    const word=root.querySelector('[data-word="reposaban"]');
    if(!word) throw new Error('Spanish audit word missing');

    // Do NOT call readerSpanishPipelineV1RefreshNow after creating the panel.
    // The user only taps a word; the Spanish click hook must decorate the lazy
    // panel and publish the current Known/Unknown status on its own.
    word.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    await sleep(140);

    const known=panel.querySelector('#reader-es-known-btn');
    const unknown=panel.querySelector('#reader-es-unknown-btn');
    const source=panel.querySelector('#reader-es-knowledge-source');
    const statusText=String(source?.textContent||'').trim();
    const snapshot={
      hookFr:document.documentElement.dataset.readerFrVocabPanelHook||'',
      hookEs:document.documentElement.dataset.readerEsVocabPanelHook||'',
      panelMarker:panel.dataset.migakuKnowledge||'',
      knownExists:!!known,
      unknownExists:!!unknown,
      knownActive:!!known?.classList.contains('is-active'),
      unknownActive:!!unknown?.classList.contains('is-active'),
      statusText,
      frenchBlockStillPresent:!!panel.querySelector('#reader-fr-knowledge-source'),
    };

    if(snapshot.panelMarker!=='es1') throw new Error('Spanish did not take ownership of shared word panel: '+JSON.stringify(snapshot));
    if(!snapshot.knownExists||!snapshot.unknownExists) throw new Error('Spanish Known/Unknown controls missing after real lazy-panel tap: '+JSON.stringify(snapshot));
    if(!statusText) throw new Error('Spanish current knowledge status is blank: '+JSON.stringify(snapshot));
    if(snapshot.frenchBlockStillPresent) throw new Error('French panel decoration survived Spanish takeover: '+JSON.stringify(snapshot));
    if(!snapshot.knownActive&&!snapshot.unknownActive) throw new Error('Spanish card shows no current Known/Unknown selection: '+JSON.stringify(snapshot));

    return snapshot;
  } finally {
    root.innerHTML=originalHtml;
    document.getElementById('reader-word-panel')?.remove();
    if(oldProfile===null)localStorage.removeItem(profileKey);else localStorage.setItem(profileKey,oldProfile);
  }
})()""", 55)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('toc137 Spanish card-status audit returned no result')
if result.get('hookEs') != '1':
    raise RuntimeError('toc137 Spanish hook isolation failed: ' + repr(result))
if result.get('panelMarker') != 'es1':
    raise RuntimeError('toc137 Spanish panel ownership failed: ' + repr(result))
if not result.get('statusText'):
    raise RuntimeError('toc137 Spanish current status missing: ' + repr(result))
if not (result.get('knownActive') or result.get('unknownActive')):
    raise RuntimeError('toc137 Spanish current status selection missing: ' + repr(result))

cdp.close()
