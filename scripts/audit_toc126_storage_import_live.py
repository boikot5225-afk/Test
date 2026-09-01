#!/usr/bin/env python3
import json
import pathlib
import time

from reader_cdp import ReaderCDP

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
cdp = ReaderCDP(connect_timeout=55)
cdp.connect()
cdp.wait("document.readyState==='complete'", 55)

# ACTION_VIEW can cold-start or replace the WebView target while the external
# import bridge is coming up. ReaderCDP follows that target replacement; this
# UI fallback still reproduces the user's guest action if no remembered guest
# session exists at all.
main_visible = bool(cdp.eval("document.getElementById('main-app')?.style.display!=='none'"))
if not main_visible:
    clicked = cdp.eval("""(()=>{
      const button=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));
      if(!button)return false;
      button.click();
      return true;
    })()""")
    if not clicked:
        raise RuntimeError('external-import cold start is on auth screen but guest button was not found')
    cdp.wait("document.getElementById('main-app')?.style.display!=='none'", 25)

cdp.wait("document.getElementById('reader-reading-view') && getComputedStyle(document.getElementById('reader-reading-view')).display!=='none'", 80)
cdp.wait("document.querySelectorAll('#reader-chapter-text .reader-word').length>20", 40)

summary = cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const raw=localStorage.getItem(key)||'';
  let local=[]; try{local=JSON.parse(raw)||[]}catch(e){}
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const durableIndex=await mod.libraryIdbGetIndex(key).catch(()=>[]);
  const legacyDirect=await mod.libraryIdbGetBook(key,'legacy_seed_toc126').catch(()=>null);
  let books=[];
  let durableGetError='';
  try { books=await mod.libraryIdbGet(key)||[]; }
  catch (error) { durableGetError=String(error?.message||error); }
  const imported=books.find(b=>b?.title==='Audit mémoire toc126')
    || await mod.libraryIdbGetBook(key, durableIndex.find(x=>x?.title==='Audit mémoire toc126')?.id||'').catch(()=>null);
  const legacy=books.find(b=>b?.id==='legacy_seed_toc126') || legacyDirect;
  return {
    key,
    localBytes:new Blob([raw]).size,
    localCount:local.length,
    localIds:local.map(b=>String(b?.id||'')),
    localAllIndex:local.every(b=>b?._libraryIndexV2===2&&!Object.prototype.hasOwnProperty.call(b,'chapters')),
    localHasChapters:/\"chapters\"/.test(raw),
    durableGetError,
    durableIndexCount:durableIndex.length,
    durableIndexIds:durableIndex.map(b=>String(b?.id||'')),
    durableIndexLegacy:durableIndex.find(b=>b?.id==='legacy_seed_toc126')||null,
    durableCount:books.length,
    durableIds:books.map(b=>String(b?.id||'')),
    legacyDirectExists:!!legacyDirect,
    legacyDirectHasChapters:!!legacyDirect?.chapters?.length,
    legacyDirectParagraphChars:String(legacyDirect?.chapters?.[0]?.paragraphs?.[0]||'').length,
    durableImportedChapters:imported?.chapters?.length||0,
    durableImportedParagraphs:(imported?.chapters||[]).reduce((n,ch)=>n+(ch?.paragraphs?.length||0),0),
    durableLegacyFull:!!legacy?.chapters?.[0]?.paragraphs?.[0],
    importedId:imported?.id||'',
    tocRows:imported?.toc?.length||0,
    tocSource:imported?.epubTocSource||'',
    tocExact:!!imported?._epubTocExact,
    imageCount:imported?.epubDiagnostics?.images||0,
    status:String(document.getElementById('reader-import-status')?.textContent||''),
    toast:String(document.getElementById('toast')?.textContent||''),
    canonicalModule:String(globalThis.__readerCanonicalModuleUrl||''),
    guest:localStorage.getItem('an2_guest')||'',
  };
})()""", 45)

if not summary:
    raise RuntimeError('empty storage summary')
# Always persist evidence BEFORE the first assertion. A red run must tell us
# exactly whether the local index, IDB index or full per-book record is missing.
(OUT / 'toc126-storage-import-live.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)

if summary['guest'] != '1':
    raise RuntimeError('guest storage owner was not restored before import: ' + json.dumps(summary, ensure_ascii=False))
if summary['durableGetError']:
    raise RuntimeError('durable library read failed: ' + summary['durableGetError'])
if summary['localBytes'] > 50_000:
    raise RuntimeError(f"localStorage library index is still huge: {summary['localBytes']} bytes")
if summary['localHasChapters'] or not summary['localAllIndex']:
    raise RuntimeError('full book content survived in localStorage: ' + json.dumps(summary, ensure_ascii=False))
if summary['durableImportedChapters'] != 12 or summary['durableImportedParagraphs'] < 300:
    raise RuntimeError('full imported book missing from IndexedDB: ' + json.dumps(summary, ensure_ascii=False))
if not summary['durableLegacyFull']:
    raise RuntimeError('legacy localStorage book was not migrated durably: ' + json.dumps(summary, ensure_ascii=False))
if summary['tocRows'] != 12 or not summary['tocExact'] or summary['tocSource'] != 'EPUB3 nav':
    raise RuntimeError('exact TOC was not persisted from the single semantic parse: ' + json.dumps(summary, ensure_ascii=False))
if summary['imageCount'] != 12:
    raise RuntimeError('streamed image count mismatch: ' + json.dumps(summary, ensure_ascii=False))
if 'localStorage переполнен' in (summary['status'] + summary['toast']):
    raise RuntimeError('obsolete localStorage quota warning is still user-visible')
if summary['canonicalModule'] and '77.42-zh-reader-quality' not in summary['canonicalModule']:
    raise RuntimeError('runtime handler bridge is bound to a second reader-app module')

# Move the real reading cursor and give the debounced durable save time to land.
cdp.eval("window.readerSelectParagraph?.(6); true")
time.sleep(1.8)
position = cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const book=books.find(b=>b?.title==='Audit mémoire toc126');
  return {id:book?.id||'',chapter:Number(book?.currentChapter||0),paragraph:Number(book?.currentParagraph||0)};
})()""", 30)
if not position or position['paragraph'] < 1:
    raise RuntimeError('reading position was not persisted to IndexedDB: ' + repr(position))

summary['savedPosition'] = position
(OUT / 'toc126-storage-import-live.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
cdp.close()
