#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found for French asset audit')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(async()=>{
  const view=document.getElementById('reader-reading-view');
  const chapter=document.getElementById('reader-chapter-text');
  if(view) view.dataset.readerLang='fr';
  if(chapter) chapter.dataset.lang='fr';

  await import('./js/reader/fr-vocab-estimate.js?v=77.42-toc130-fr-assets-audit');
  if(typeof globalThis.readerLoadFrenchVocabularyData!=='function') {
    throw new Error('French vocabulary loader global missing');
  }

  const data=await globalThis.readerLoadFrenchVocabularyData();
  const first5=(data?.entries||[]).slice(0,5).map(x=>String(x?.word||''));
  const probes={};
  for(const surface of ['est','suis','étaient','ai','avait']) {
    probes[surface]=String(data?.lemma?.get(surface)||'');
  }

  const assetBase=new URL('../frreader/', location.href);
  const names=['fr_vocab_frequency.tsv','fr_vocab_lemma.tsv','fr_ru_core.json','fr_ru_senses.json'];
  const assets={};
  for(const name of names) {
    const response=await fetch(new URL(name, assetBase), {cache:'no-store'});
    const text=await response.text();
    assets[name]={status:response.status,ok:response.ok,bytes:new Blob([text]).size};
    if(name==='fr_ru_core.json' && response.ok) {
      const parsed=JSON.parse(text);
      assets[name].entries=Object.keys(parsed||{}).length;
      assets[name].etre=String(parsed?.['être']||'');
    }
    if(name==='fr_ru_senses.json' && response.ok) {
      const parsed=JSON.parse(text);
      assets[name].entries=Object.keys(parsed||{}).length;
    }
  }

  globalThis.readerOpenFrenchVocabularyEstimate?.();
  await new Promise(r=>setTimeout(r,250));
  const modal=document.getElementById('reader-vocab-estimate-modal');
  const modalText=String(modal?.textContent||'').replace(/\s+/g,' ').trim();
  const summary={
    listLength:Number(data?.entries?.length||0),
    first5,
    probes,
    assets,
    modalExists:!!modal,
    modalText,
    modalHasLoadError:/Не удалось загрузить данные|HTTP\s+404/i.test(modalText),
    modalHasDashboard:/French vocabulary|Measure my level/i.test(modalText),
  };
  modal?.remove();
  return summary;
})()""", 45)

print(json.dumps(result, ensure_ascii=False, indent=2))

if not result:
    raise RuntimeError('French asset audit returned no result')
if result['listLength'] < 50_000:
    raise RuntimeError('French frequency list is missing/too small: ' + repr(result))
if result['first5'] != ['le', 'être', 'de', 'un', 'je']:
    raise RuntimeError('French frequency order mismatch: ' + repr(result))
expected = {'est':'être','suis':'être','étaient':'être','ai':'avoir','avait':'avoir'}
if result['probes'] != expected:
    raise RuntimeError('French morphology probes failed: ' + repr(result))
for name in ['fr_vocab_frequency.tsv','fr_vocab_lemma.tsv','fr_ru_core.json','fr_ru_senses.json']:
    item = result['assets'].get(name) or {}
    if item.get('status') != 200 or not item.get('ok') or item.get('bytes', 0) <= 0:
        raise RuntimeError(f'French APK asset unavailable: {name}: ' + repr(result))
if result['assets']['fr_ru_core.json'].get('entries', 0) < 20_000:
    raise RuntimeError('French-Russian core dictionary unexpectedly small: ' + repr(result))
if not result['modalExists'] or result['modalHasLoadError'] or not result['modalHasDashboard']:
    raise RuntimeError('French vocabulary modal still fails at runtime: ' + repr(result))

cdp.close()
