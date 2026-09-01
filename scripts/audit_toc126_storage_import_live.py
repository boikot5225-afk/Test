#!/usr/bin/env python3
import json
import pathlib
import time
import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
pages = []
for _ in range(160):
    try:
        pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception:
        pages = []
    if pages:
        break
    time.sleep(.35)
if not pages:
    raise SystemExit('No debuggable Reader AI WebView')
page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url', '')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
seq = 0

def cdp(method, params=None):
    global seq
    seq += 1
    ident = seq
    ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get('id') == ident:
            if 'error' in msg:
                raise RuntimeError(msg['error'])
            return msg.get('result', {})

def ev(code):
    result = cdp('Runtime.evaluate', {
        'expression': code,
        'awaitPromise': True,
        'returnByValue': True,
        'userGesture': True,
    })
    if result.get('exceptionDetails'):
        raise RuntimeError(str(result['exceptionDetails']))
    return result.get('result', {}).get('value')

def wait(code, timeout=60, delay=.3):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = ev(code)
        if last:
            return last
        time.sleep(delay)
    raise RuntimeError(f'timeout: {code}; last={last!r}')

cdp('Runtime.enable')
wait("document.readyState==='complete'")

# ACTION_VIEW may cold-start a fresh WebView before the guest-session restore has
# finished. The native external-import bridge deliberately waits for main-app,
# so make the test's guest precondition explicit instead of timing out on the
# login screen. This only reproduces the same user action used during seeding.
main_visible = bool(ev("document.getElementById('main-app')?.style.display!=='none'"))
if not main_visible:
    clicked = ev("""(()=>{
      const button=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));
      if(!button)return false;
      button.click();
      return true;
    })()""")
    if not clicked:
        raise RuntimeError('external-import cold start is on auth screen but guest button was not found')
    wait("document.getElementById('main-app')?.style.display!=='none'", 25)

wait("document.getElementById('reader-reading-view') && getComputedStyle(document.getElementById('reader-reading-view')).display!=='none'", 80)
wait("document.querySelectorAll('#reader-chapter-text .reader-word').length>20", 40)

summary = ev(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const raw=localStorage.getItem(key)||'';
  let index=[]; try{index=JSON.parse(raw)||[]}catch(e){}
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const imported=books.find(b=>b?.title==='Audit mémoire toc126');
  const legacy=books.find(b=>b?.id==='legacy_seed_toc126');
  return {
    key,
    localBytes:new Blob([raw]).size,
    localCount:index.length,
    localAllIndex:index.every(b=>b?._libraryIndexV2===2&&!Object.prototype.hasOwnProperty.call(b,'chapters')),
    localHasChapters:/\"chapters\"/.test(raw),
    durableCount:books.length,
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
})()""")

if not summary:
    raise RuntimeError('empty storage summary')
if summary['guest'] != '1':
    raise RuntimeError('guest storage owner was not restored before import: ' + json.dumps(summary, ensure_ascii=False))
if summary['localBytes'] > 50_000:
    raise RuntimeError(f"localStorage library index is still huge: {summary['localBytes']} bytes")
if summary['localHasChapters'] or not summary['localAllIndex']:
    raise RuntimeError('full book content survived in localStorage: ' + json.dumps(summary, ensure_ascii=False))
if summary['durableImportedChapters'] != 12 or summary['durableImportedParagraphs'] < 300:
    raise RuntimeError('full imported book missing from IndexedDB: ' + json.dumps(summary, ensure_ascii=False))
if not summary['durableLegacyFull']:
    raise RuntimeError('legacy localStorage book was not migrated durably')
if summary['tocRows'] != 12 or not summary['tocExact'] or summary['tocSource'] != 'EPUB3 nav':
    raise RuntimeError('exact TOC was not persisted from the single semantic parse: ' + json.dumps(summary, ensure_ascii=False))
if summary['imageCount'] != 12:
    raise RuntimeError('streamed image count mismatch: ' + json.dumps(summary, ensure_ascii=False))
if 'localStorage переполнен' in (summary['status'] + summary['toast']):
    raise RuntimeError('obsolete localStorage quota warning is still user-visible')
if summary['canonicalModule'] and '77.42-zh-reader-quality' not in summary['canonicalModule']:
    raise RuntimeError('runtime handler bridge is bound to a second reader-app module')

# Move the real reading cursor and give the debounced durable save time to land.
ev("window.readerSelectParagraph?.(6); true")
time.sleep(1.8)
position = ev(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=2');
  const books=await mod.libraryIdbGet(key)||[];
  const book=books.find(b=>b?.title==='Audit mémoire toc126');
  return {id:book?.id||'',chapter:Number(book?.currentChapter||0),paragraph:Number(book?.currentParagraph||0)};
})()""")
if not position or position['paragraph'] < 1:
    raise RuntimeError('reading position was not persisted to IndexedDB: ' + repr(position))

summary['savedPosition'] = position
(OUT / 'toc126-storage-import-live.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
ws.close()
