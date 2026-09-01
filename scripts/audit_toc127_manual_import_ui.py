#!/usr/bin/env python3
import base64
import io
import json
import pathlib
import zipfile

from reader_cdp import ReaderCDP

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
TITLE = 'Manual import regression toc127'
AUTHOR = 'Reader AI gate'


def make_epub_bytes():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as zf:
        zf.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            'META-INF/container.xml',
            '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>''',
        )
        zf.writestr(
            'OEBPS/content.opf',
            f'''<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">manual-toc127</dc:identifier>
    <dc:title>{TITLE}</dc:title>
    <dc:creator>{AUTHOR}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>''',
        )
        zf.writestr(
            'OEBPS/nav.xhtml',
            f'''<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">{TITLE}</a></li></ol></nav></body></html>''',
        )
        zf.writestr(
            'OEBPS/chapter1.xhtml',
            f'''<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{TITLE}</title></head><body>
<h1>{TITLE}</h1>
<p>This is a manual import regression test. The saved EPUB must become visible in the live Reader library immediately.</p>
<p>The test intentionally uses the same Choose File and Save handlers as the normal import dialog instead of Android ACTION_VIEW.</p>
<p>If the semantic importer writes IndexedDB behind reader-app without refreshing canonical readerBooks, this test fails.</p>
</body></html>''',
        )
    return out.getvalue()


payload_b64 = base64.b64encode(make_epub_bytes()).decode('ascii')
cdp = ReaderCDP(connect_timeout=55)
cdp.connect()
cdp.wait("document.readyState==='complete'", 55)

before = cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=1');
  const books=await mod.libraryIdbGet(key)||[];
  return {key,count:books.length,ids:books.map(b=>String(b?.id||'')),titles:books.map(b=>String(b?.title||''))};
})()""", 30)

result = cdp.eval(f"""(async()=>{{
  const title={json.dumps(TITLE)};
  const author={json.dumps(AUTHOR)};
  const waitFor=async(fn,timeout=5000)=>{{
    const start=Date.now();
    while(Date.now()-start<timeout){{ if(fn()) return true; await new Promise(r=>setTimeout(r,80)); }}
    return false;
  }};

  window.showScreen?.('reader');
  if(typeof window.readerBackToLibrary==='function') window.readerBackToLibrary();
  await Promise.resolve(window.renderReaderScreen?.());
  window.showReaderImportModal?.();

  const raw=atob({json.dumps(payload_b64)});
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  const file=new File([bytes], 'manual-toc127.epub', {{type:'application/epub+zip', lastModified:Date.now()}});
  const importHandler=window.readerImportFromFile;
  const saveHandler=window.saveReaderImport;
  if(typeof importHandler!=='function'||typeof saveHandler!=='function') throw new Error('manual import handlers missing');

  await Promise.resolve(importHandler({{target:{{files:[file],value:''}}}}));
  const parseStatus=String(document.getElementById('reader-import-status')?.textContent||'');
  if(parseStatus.startsWith('❌')) throw new Error(parseStatus);
  const lang=document.getElementById('reader-import-lang');
  if(lang){{lang.value='en';lang.dataset.userChanged='1';}}
  const titleEl=document.getElementById('reader-import-title');
  const authorEl=document.getElementById('reader-import-author');
  if(titleEl) titleEl.value=title;
  if(authorEl) authorEl.value=author;

  await Promise.resolve(saveHandler());
  const openedReady=await waitFor(()=>{{
    const reading=document.getElementById('reader-reading-view');
    const modal=document.getElementById('reader-import-modal');
    return reading&&getComputedStyle(reading).display!=='none'&&(!modal||getComputedStyle(modal).display==='none');
  }},8000);

  const app=await import('./js/reader-app.js?v=77.42-zh-reader-quality');
  const opened=app.readerCurrentBook?.();
  const readingDisplay=getComputedStyle(document.getElementById('reader-reading-view')).display;
  const modalAfterSave=document.getElementById('reader-import-modal');
  const modalDisplayAfterSave=modalAfterSave?getComputedStyle(modalAfterSave).display:'none';
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=1');
  const durable=await mod.libraryIdbGet(key)||[];
  const local=JSON.parse(localStorage.getItem(key)||'[]');

  if(typeof window.readerBackToLibrary!=='function') throw new Error('readerBackToLibrary handler missing');
  window.readerBackToLibrary();
  const libraryVisible=await waitFor(()=>{{
    const library=document.getElementById('reader-library-view');
    const reading=document.getElementById('reader-reading-view');
    const modal=document.getElementById('reader-import-modal');
    return library&&reading
      &&getComputedStyle(library).display!=='none'
      &&getComputedStyle(reading).display==='none'
      &&(!modal||getComputedStyle(modal).display==='none');
  }},6000);
  await Promise.resolve(window.renderReaderScreen?.());
  await new Promise(r=>setTimeout(r,500));

  const libraryView=document.getElementById('reader-library-view');
  const readingView=document.getElementById('reader-reading-view');
  const modalView=document.getElementById('reader-import-modal');
  const libraryList=document.getElementById('reader-library-list');
  const libraryText=String(libraryList?.textContent||'');
  const activeBooksTab=[...(libraryList?.querySelectorAll?.('.lib-tab-btn')||[])].find(x=>/Книги\s*\(/.test(x.textContent||''));
  const booksTabText=String(activeBooksTab?.textContent||'').replace(/\s+/g,' ').trim();
  const cardTitles=[...(libraryList?.querySelectorAll?.('.lib-book-title')||[])].map(x=>String(x.textContent||'').trim());

  return {{
    parseStatus,
    toast:String(document.getElementById('toast')?.textContent||''),
    openedReady,
    openedId:String(opened?.id||''),
    openedTitle:String(opened?.title||''),
    openedFull:!!opened?.chapters?.length,
    readingDisplay,
    modalDisplayAfterSave,
    localCount:Array.isArray(local)?local.length:-1,
    localHasTitle:Array.isArray(local)&&local.some(b=>String(b?.title||'')===title),
    durableCount:durable.length,
    durableHasTitle:durable.some(b=>String(b?.title||'')===title&&Array.isArray(b?.chapters)&&b.chapters.length>0),
    libraryVisible,
    libraryDisplay:String(getComputedStyle(libraryView).display||''),
    readingDisplayAfterBack:String(getComputedStyle(readingView).display||''),
    modalDisplayAfterBack:modalView?String(getComputedStyle(modalView).display||''):'none',
    booksTabText,
    cardTitles,
    libraryHasTitle:libraryText.includes(title)&&cardTitles.includes(title),
    canonicalModule:String(globalThis.__readerCanonicalModuleUrl||''),
  }};
}})()""", 55)

summary = {'before': before, 'after': result}
(OUT / 'toc127-manual-import-ui.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)

if not result:
    raise RuntimeError('manual import UI audit returned no result')
if not result['openedReady'] or result['openedTitle'] != TITLE or not result['openedFull']:
    raise RuntimeError('manual EPUB was saved but canonical Reader did not open it cleanly: ' + repr(summary))
if result['readingDisplay'] == 'none' or result['modalDisplayAfterSave'] != 'none':
    raise RuntimeError('manual EPUB save left the import modal open or failed to enter reading view: ' + repr(summary))
if not result['durableHasTitle']:
    raise RuntimeError('manual EPUB missing from durable IndexedDB: ' + repr(summary))
if not result['localHasTitle']:
    raise RuntimeError('manual EPUB missing from lightweight local index: ' + repr(summary))
if result['durableCount'] < before['count'] + 1 or result['localCount'] < before['count'] + 1:
    raise RuntimeError('manual EPUB save did not increase library count: ' + repr(summary))
if not result['libraryVisible'] or result['libraryDisplay'] == 'none' or result['readingDisplayAfterBack'] != 'none' or result['modalDisplayAfterBack'] != 'none':
    raise RuntimeError('back from imported EPUB did not expose a clean library view: ' + repr(summary))
if not result['libraryHasTitle']:
    raise RuntimeError('manual EPUB exists in storage but has no visible library card: ' + repr(summary))
if f"Книги ({before['count'] + 1})" not in result['booksTabText']:
    raise RuntimeError('visible books counter did not increase after manual EPUB import: ' + repr(summary))
if result['canonicalModule'] and '77.42-zh-reader-quality' not in result['canonicalModule']:
    raise RuntimeError('manual import opened through a duplicate Reader module: ' + repr(summary))

cdp.close()
