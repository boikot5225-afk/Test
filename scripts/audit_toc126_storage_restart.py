#!/usr/bin/env python3
import json
import pathlib
import time

from reader_cdp import ReaderCDP

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
cdp = ReaderCDP(connect_timeout=50)
cdp.connect()
cdp.wait("document.readyState==='complete'", 50)
if not cdp.eval("document.getElementById('main-app')?.style.display!=='none'"):
    clicked=cdp.eval("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    if not clicked: raise RuntimeError('Guest button not found after restart')
cdp.wait("document.getElementById('main-app')?.style.display!=='none'",20)

state=cdp.eval(r"""(async()=>{
  window.showScreen?.('reader');
  await window.renderReaderScreen?.();
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const imported=books.find(b=>b?.title==='Audit mémoire toc126');
  const raw=localStorage.getItem(key)||'';
  return {key,id:imported?.id||'',paragraph:Number(imported?.currentParagraph||0),chapters:imported?.chapters?.length||0,localBytes:new Blob([raw]).size,localHasChapters:/\"chapters\"/.test(raw),count:books.length};
})()""", 40)
if not state or not state['id'] or state['chapters'] != 12 or state['paragraph'] < 1:
    raise RuntimeError('book/position did not survive process restart: '+repr(state))
if state['localBytes'] > 50_000 or state['localHasChapters']:
    raise RuntimeError('localStorage grew back into a full book snapshot after restart: '+repr(state))

book_id=json.dumps(state['id'])
cdp.eval(f"window.readerOpenBook?.({book_id}); true")
cdp.wait("document.querySelectorAll('#reader-chapter-text .reader-word').length>20",30)
opened=cdp.eval("(()=>({title:String(document.getElementById('reader-book-title')?.textContent||''),p:Number(document.getElementById('reader-chapter-text')?.dataset?.activeParagraph||document.querySelector('#reader-chapter-text .reader-paragraph.active')?.dataset?.p||0)}))()")
if 'Audit mémoire toc126' not in opened.get('title',''):
    raise RuntimeError('durable book could not be reopened after restart: '+repr(opened))

# Deletion must update per-book IDB records and the small local index without
# resurrecting the old full snapshot.
cdp.eval("window.confirm=()=>true; true")
cdp.eval(f"window.readerDeleteBook?.({book_id}); true")
time.sleep(2.0)
after=cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const raw=localStorage.getItem(key)||'';
  return {count:books.length,hasImported:books.some(b=>b?.title==='Audit mémoire toc126'),hasLegacy:books.some(b=>b?.id==='legacy_seed_toc126'),localBytes:new Blob([raw]).size,localHasChapters:/\"chapters\"/.test(raw)};
})()""", 30)
if after['hasImported'] or not after['hasLegacy']:
    raise RuntimeError('per-book delete failed or removed unrelated book: '+repr(after))
if after['localBytes'] > 50_000 or after['localHasChapters']:
    raise RuntimeError('delete re-expanded localStorage: '+repr(after))

result={'ok':True,'beforeRestart':state,'opened':opened,'afterDelete':after}
(OUT/'toc126-storage-restart.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
cdp.close()
