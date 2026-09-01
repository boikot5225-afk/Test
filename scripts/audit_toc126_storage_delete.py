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

book_id = cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  return books.find(b=>b?.title==='Audit mémoire toc126')?.id||'';
})()""", 30)
if not book_id:
    raise RuntimeError('imported book missing before delete gate')

cdp.eval("window.confirm=()=>true; true")
cdp.eval(f"window.readerDeleteBook?.({json.dumps(book_id)}); true")
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

result={'ok':True,'afterDelete':after}
(OUT/'toc126-storage-delete.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
cdp.close()
