#!/usr/bin/env python3
import base64
import io
import json
import pathlib
import zipfile

from reader_cdp import ReaderCDP

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
FIRST_TITLE = 'Superseded EPUB regression toc129'
SECOND_TITLE = 'Latest EPUB wins regression toc129'
AUTHOR = 'Reader AI import gate'
FIRST_CHAPTERS = 80
SECOND_CHAPTERS = 49


def make_epub_bytes(title, chapters, marker, identifier):
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
        manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
        spine = []
        nav = []
        for i in range(1, chapters + 1):
            manifest.append(f'<item id="c{i}" href="chapter{i}.xhtml" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="c{i}"/>')
            nav.append(f'<li><a href="chapter{i}.xhtml">Chapter {i}</a></li>')
            repeated = ' '.join([f'{marker} paragraph {i} semantic import work.'] * 24)
            zf.writestr(
                f'OEBPS/chapter{i}.xhtml',
                f'''<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {i}</title></head><body>
<h1>Chapter {i}</h1>
<p>{repeated}</p>
<p>{marker} must remain authoritative only when this is the latest selected EPUB.</p>
</body></html>''',
            )
        zf.writestr(
            'OEBPS/content.opf',
            f'''<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{identifier}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{AUTHOR}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>{''.join(manifest)}</manifest>
  <spine>{''.join(spine)}</spine>
</package>''',
        )
        zf.writestr(
            'OEBPS/nav.xhtml',
            f'''<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>{''.join(nav)}</ol></nav></body></html>''',
        )
    return out.getvalue()


first_b64 = base64.b64encode(
    make_epub_bytes(FIRST_TITLE, FIRST_CHAPTERS, 'FIRST-SHOULD-DIE', 'toc129-first')
).decode('ascii')
second_b64 = base64.b64encode(
    make_epub_bytes(SECOND_TITLE, SECOND_CHAPTERS, 'SECOND-MUST-WIN', 'toc129-second')
).decode('ascii')

cdp = ReaderCDP(connect_timeout=55)
cdp.connect()
cdp.wait("document.readyState==='complete'", 55)
cdp.wait("window.readerImportFromFile && window.__readerImportIsolationStats", 20)

before = cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=1');
  const books=await mod.libraryIdbGet(key)||[];
  return {
    key,
    count:books.length,
    ids:books.map(b=>String(b?.id||'')),
    titles:books.map(b=>String(b?.title||'')),
    isolation:{...(globalThis.__readerImportIsolationStats||{})},
  };
})()""", 30)

result = cdp.eval(f"""(async()=>{{
  const firstTitle={json.dumps(FIRST_TITLE)};
  const secondTitle={json.dumps(SECOND_TITLE)};
  const author={json.dumps(AUTHOR)};
  const waitFor=async(fn,timeout=10000)=>{{
    const start=Date.now();
    while(Date.now()-start<timeout){{
      if(fn()) return true;
      await new Promise(r=>setTimeout(r,20));
    }}
    return false;
  }};
  const decode=(payload,name,lastModified)=>{{
    const raw=atob(payload);
    const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
    return new File([bytes],name,{{type:'application/epub+zip',lastModified}});
  }};

  window.showScreen?.('reader');
  window.readerBackToLibrary?.();
  await Promise.resolve(window.renderReaderScreen?.());
  window.showReaderImportModal?.();

  // Reproduce residue from a finished audio transcription.
  const titleEl=document.getElementById('reader-import-title');
  const authorEl=document.getElementById('reader-import-author');
  const preview=document.getElementById('reader-import-text');
  const audioStatus=document.getElementById('reader-import-audio-status');
  const stopBtn=document.getElementById('reader-audio-stop-btn');
  if(titleEl) titleEl.value='Previous audio transcript';
  if(authorEl) authorEl.value='Previous audio author';
  if(preview) preview.value='Old transcript text that must not survive into EPUB import.';
  if(audioStatus){{
    audioStatus.style.display='inline';
    audioStatus.textContent='✅ Готово: 13 фрагмент(ов) · аудио сохранено · тайм-коды (приблизительно). Проверь текст перед сохранением.';
  }}
  if(stopBtn) stopBtn.style.display='inline-flex';

  const firstFile=decode({json.dumps(first_b64)},'first-slow-toc129.epub',12901);
  const secondFile=decode({json.dumps(second_b64)},'second-final-toc129.epub',12902);
  const importHandler=window.readerImportFromFile;
  const saveHandler=window.saveReaderImport;
  if(typeof importHandler!=='function'||typeof saveHandler!=='function') throw new Error('import handlers missing');
  if(!importHandler.__readerAudioEpubIsolationV3) throw new Error('audio→EPUB isolation bridge v3 missing');

  const isolationBefore={{...(globalThis.__readerImportIsolationStats||{{}})}};

  // Start a real EPUB parse. Wait for the wrapper's monotonic start counter,
  // not for transient UI text: a fast parse can replace ⏳ with ✅ between two
  // 20 ms CDP polls even though the parser unquestionably started.
  const first=Promise.resolve(importHandler({{target:{{files:[firstFile],value:''}}}}));
  const firstStarted=await waitFor(()=>{{
    const stats=globalThis.__readerImportIsolationStats||{{}};
    return Number(stats.epubStarts||0)>Number(isolationBefore.epubStarts||0);
  }},5000);
  if(!firstStarted) throw new Error('first manual EPUB parser start counter did not advance');

  const second=Promise.resolve(importHandler({{target:{{files:[secondFile],value:''}}}}));
  // Android/WebView file delivery can duplicate the same selection. The second
  // delivery must share the queued SECOND promise rather than launch a third parse.
  const duplicateSecond=Promise.resolve(importHandler({{target:{{files:[secondFile],value:''}}}}));
  await Promise.allSettled([first,second,duplicateSecond]);

  const isolationAfter={{...(globalThis.__readerImportIsolationStats||{{}})}};
  const parseStatus=String(document.getElementById('reader-import-status')?.textContent||'');
  if(parseStatus.startsWith('❌')) throw new Error(parseStatus);

  const staleAudioStatusVisible=!!audioStatus && getComputedStyle(audioStatus).display!=='none' && !!String(audioStatus.textContent||'').trim();
  const staleAudioTitle=String(titleEl?.value||'')==='Previous audio transcript';
  const staleAudioAuthor=String(authorEl?.value||'')==='Previous audio author';
  const staleAudioPreview=String(preview?.value||'').includes('Old transcript text');
  const finalUiTitle=String(titleEl?.value||'');
  const finalUiAuthor=String(authorEl?.value||'');
  const finalPreview=String(preview?.value||'');

  const lang=document.getElementById('reader-import-lang');
  if(lang){{lang.value='en';lang.dataset.userChanged='1';}}
  await Promise.resolve(saveHandler());
  const openedReady=await waitFor(()=>{{
    const reading=document.getElementById('reader-reading-view');
    const modal=document.getElementById('reader-import-modal');
    return reading&&getComputedStyle(reading).display!=='none'&&(!modal||getComputedStyle(modal).display==='none');
  }},10000);

  const app=await import('./js/reader-app.js?v=77.42-zh-reader-quality');
  const opened=app.readerCurrentBook?.();
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=1');
  const durable=await mod.libraryIdbGet(key)||[];
  const local=JSON.parse(localStorage.getItem(key)||'[]');
  const finalDurable=durable.filter(b=>String(b?.title||'')===secondTitle);
  const staleDurable=durable.filter(b=>String(b?.title||'')===firstTitle);
  const finalLocal=Array.isArray(local)?local.filter(b=>String(b?.title||'')===secondTitle):[];
  const staleLocal=Array.isArray(local)?local.filter(b=>String(b?.title||'')===firstTitle):[];
  const hasChapterTimestamps=(book)=>Array.isArray(book?.chapters)&&book.chapters.some(ch=>Array.isArray(ch?.paragraphTimestamps)&&ch.paragraphTimestamps.length>0);

  window.readerBackToLibrary?.();
  await waitFor(()=>{{
    const library=document.getElementById('reader-library-view');
    const reading=document.getElementById('reader-reading-view');
    return library&&reading&&getComputedStyle(library).display!=='none'&&getComputedStyle(reading).display==='none';
  }},6000);
  await Promise.resolve(window.renderReaderScreen?.());
  await new Promise(r=>setTimeout(r,350));
  const libraryList=document.getElementById('reader-library-list');
  const cardTitles=[...(libraryList?.querySelectorAll?.('.lib-book-title')||[])].map(x=>String(x.textContent||'').trim());

  return {{
    parseStatus,
    isolationBefore,
    isolationAfter,
    isolationStartsDelta:Number(isolationAfter.epubStarts||0)-Number(isolationBefore.epubStarts||0),
    canonicalResetsDelta:Number(isolationAfter.canonicalResets||0)-Number(isolationBefore.canonicalResets||0),
    dedupedCallsDelta:Number(isolationAfter.dedupedCalls||0)-Number(isolationBefore.dedupedCalls||0),
    blockedConcurrentDelta:Number(isolationAfter.blockedConcurrent||0)-Number(isolationBefore.blockedConcurrent||0),
    supersededCallsDelta:Number(isolationAfter.supersededCalls||0)-Number(isolationBefore.supersededCalls||0),
    staleAudioStatusVisible,
    staleAudioTitle,
    staleAudioAuthor,
    staleAudioPreview,
    finalUiTitle,
    finalUiAuthor,
    finalPreviewHasSecond:finalPreview.includes('SECOND-MUST-WIN'),
    finalPreviewHasFirst:finalPreview.includes('FIRST-SHOULD-DIE'),
    openedReady,
    openedTitle:String(opened?.title||''),
    openedFull:!!opened?.chapters?.length,
    openedChapterCount:Array.isArray(opened?.chapters)?opened.chapters.length:0,
    openedHasOriginalAudio:!!opened?.hasOriginalAudio,
    openedHasParagraphTimestamps:hasChapterTimestamps(opened),
    durableCount:durable.length,
    finalDurableMatches:finalDurable.length,
    staleDurableMatches:staleDurable.length,
    durableHasAudio:finalDurable.some(b=>!!b?.hasOriginalAudio),
    durableHasTimestamps:finalDurable.some(hasChapterTimestamps),
    localCount:Array.isArray(local)?local.length:-1,
    finalLocalMatches:finalLocal.length,
    staleLocalMatches:staleLocal.length,
    finalCardMatches:cardTitles.filter(x=>x===secondTitle).length,
    staleCardMatches:cardTitles.filter(x=>x===firstTitle).length,
    cardTitles,
  }};
}})()""", 90)

summary = {'before': before, 'after': result}
(OUT / 'toc129-import-supersede.json').write_text(
    json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8'
)
print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)

if not result:
    raise RuntimeError('import supersede audit returned no result')
if result['isolationStartsDelta'] != 2:
    raise RuntimeError('expected exactly first + newest queued EPUB starts: ' + repr(summary))
if result['canonicalResetsDelta'] != 2:
    raise RuntimeError('each distinct manual EPUB did not reset stale audio state exactly once: ' + repr(summary))
if result['dedupedCallsDelta'] < 1:
    raise RuntimeError('duplicate newest EPUB event was not deduplicated: ' + repr(summary))
if result['blockedConcurrentDelta'] != 0:
    raise RuntimeError('new EPUB was handled by the obsolete blocking branch: ' + repr(summary))
# supersededCalls is diagnostic only. On a fast WebView the first parser may
# complete between the start-counter observation and delivery of the second
# selection, so there is no still-active promise to mark as superseded. The
# correctness invariant is observable below: the second selection owns the UI,
# opens successfully, is stored exactly once, and the first selection is absent
# from durable/local/card state.
if result['staleAudioStatusVisible'] or result['staleAudioTitle'] or result['staleAudioAuthor'] or result['staleAudioPreview']:
    raise RuntimeError('audio import residue remained visible after EPUB takeover: ' + repr(summary))
if result['finalUiTitle'] != SECOND_TITLE or result['finalUiAuthor'] != AUTHOR or not result['finalPreviewHasSecond'] or result['finalPreviewHasFirst']:
    raise RuntimeError('first EPUB remained authoritative after selecting second EPUB: ' + repr(summary))
if not result['openedReady'] or result['openedTitle'] != SECOND_TITLE or not result['openedFull'] or result['openedChapterCount'] != SECOND_CHAPTERS:
    raise RuntimeError('newest selected EPUB did not open cleanly: ' + repr(summary))
if result['openedHasOriginalAudio'] or result['openedHasParagraphTimestamps']:
    raise RuntimeError('previous audio attachment/timestamps leaked into newest EPUB: ' + repr(summary))
if result['finalDurableMatches'] != 1 or result['finalLocalMatches'] != 1 or result['finalCardMatches'] != 1:
    raise RuntimeError('newest EPUB created missing/duplicate durable state: ' + repr(summary))
if result['staleDurableMatches'] or result['staleLocalMatches'] or result['staleCardMatches']:
    raise RuntimeError('superseded first EPUB was accidentally saved or rendered: ' + repr(summary))
if result['durableHasAudio'] or result['durableHasTimestamps']:
    raise RuntimeError('stale audio metadata leaked into durable newest EPUB: ' + repr(summary))
if result['durableCount'] < before['count'] + 1 or result['localCount'] < before['count'] + 1:
    raise RuntimeError('newest EPUB did not increase library count: ' + repr(summary))

cdp.close()
