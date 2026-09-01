#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked:
        raise RuntimeError('Guest button not found')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 20)

result = cdp.eval(r"""(()=>{
  const key = window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1::guest';
  const huge = ('ancien texte français pour migration. ').repeat(72000);
  const now = new Date(Date.now()-86400000).toISOString();
  const legacy = [{
    id:'legacy_seed_toc126', title:'Legacy seed toc126', author:'Reader AI',
    lang:'fr', sourceLang:'fr', format:'text', source:'legacy-test',
    importKey:'legacy-seed-toc126', createdAt:now, updatedAt:now,
    currentChapter:0, currentParagraph:0,
    chapters:[{id:'ch_0',title:'Ancienne bibliothèque',paragraphs:[huge]}]
  }];
  localStorage.setItem(key, JSON.stringify(legacy));
  // Storage/migration test only: do not let hundreds of synthetic French words
  // start DeepSeek while we are measuring import behavior and memory.
  localStorage.setItem('an2_reader_vocab_estimate_fr_v1::guest', JSON.stringify({
    language:'fr',version:1,estimate:63548,listLength:63548,
    conservativeKnownCount:63548,updatedAt:new Date().toISOString()
  }));
  const raw=localStorage.getItem(key)||'';
  return {key,bytes:new Blob([raw]).size,hasChapters:/\"chapters\"/.test(raw),guest:localStorage.getItem('an2_guest')};
})()""", 30)
if not result or result.get('bytes', 0) < 1_500_000 or not result.get('hasChapters'):
    raise RuntimeError('legacy full library seed failed: ' + repr(result))
print(json.dumps(result, ensure_ascii=False, indent=2))
cdp.close()
