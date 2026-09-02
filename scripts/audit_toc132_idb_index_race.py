#!/usr/bin/env python3
import json

from reader_cdp import ReaderCDP

cdp = ReaderCDP(connect_timeout=45)
cdp.connect()
cdp.wait("document.readyState==='complete'", 45)

result = cdp.eval(r"""(async()=>{
  const stamp=Date.now();
  const key=`toc132_idb_index_race_${stamp}`;
  const moduleCount=8;
  const modules=await Promise.all(
    Array.from({length:moduleCount},(_,i)=>import(`./js/reader/library-idb-store.js?toc132-race-${stamp}-${i}`))
  );
  const reader=await import(`./js/reader/library-idb-store.js?toc132-race-reader-${stamp}`);

  const makeBook=(id,offset=0)=>({
    id,
    title:id,
    author:'toc132 race gate',
    lang:'en',
    sourceLang:'en',
    format:'epub',
    source:'toc132-idb-race',
    importKey:id,
    schemaVersion:2,
    createdAt:new Date(stamp+offset).toISOString(),
    updatedAt:new Date(stamp+offset).toISOString(),
    currentChapter:0,
    currentParagraph:0,
    chapters:[{title:'Race',paragraphs:[`payload ${id}`]}],
  });

  const base=makeBook('toc132-race-base',0);
  const writers=Array.from({length:moduleCount},(_,i)=>makeBook(`toc132-race-${i}`,i+1));
  const expected=[base,...writers].map(book=>book.id).sort();

  await reader.libraryIdbPut(key,[base]);

  // Independent query-string imports create independent module state/DB
  // connections, matching the real Reader where ?v=1 and ?v=2 coexist.
  // Every writer starts from the same partial snapshot. Correct storage must
  // merge the latest index INSIDE its serialized readwrite transaction.
  await Promise.all(writers.map((book,i)=>modules[i].libraryIdbPut(key,[base,book])));

  const index=await reader.libraryIdbGetIndex(key);
  const indexIds=index.map(item=>String(item?.id||'')).filter(Boolean).sort();
  const direct=[];
  for(const id of expected){
    const book=await reader.libraryIdbGetBook(key,id);
    direct.push({id,full:!!(book?.chapters?.length),title:String(book?.title||'')});
  }
  const library=await reader.libraryIdbGet(key);
  const libraryIds=(Array.isArray(library)?library:[]).map(book=>String(book?.id||'')).filter(Boolean).sort();

  // Clean the isolated gate key after collecting evidence. An empty index row
  // is harmless and no production library key is touched.
  for(const id of expected){
    await reader.libraryIdbDeleteBook(key,id).catch(()=>false);
  }

  return {key,moduleCount,expected,indexIds,direct,libraryIds};
})()""", 60)

print(json.dumps(result, ensure_ascii=False, indent=2))
if not result:
    raise RuntimeError('IndexedDB race audit returned no result')
expected = result.get('expected') or []
index_ids = result.get('indexIds') or []
library_ids = result.get('libraryIds') or []
if index_ids != expected:
    raise RuntimeError('Concurrent IndexedDB writers lost index entries: ' + repr(result))
if library_ids != expected:
    raise RuntimeError('Concurrent IndexedDB writers made books invisible: ' + repr(result))
if any(not row.get('full') for row in result.get('direct', [])):
    raise RuntimeError('Concurrent IndexedDB writer lost a full book record: ' + repr(result))

cdp.close()
