#!/usr/bin/env python3
import base64
import io
import json
import pathlib
import zipfile

from reader_cdp import ReaderCDP

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
TITLE = 'Audio then EPUB regression toc128'
AUTHOR = 'Reader AI gate'
CHAPTERS = 49


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
        manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
        spine = []
        nav = []
        for i in range(1, CHAPTERS + 1):
            manifest.append(f'<item id="c{i}" href="chapter{i}.xhtml" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="c{i}"/>')
            nav.append(f'<li><a href="chapter{i}.xhtml">Chapter {i}</a></li>')
            zf.writestr(
                f'OEBPS/chapter{i}.xhtml',
                f'''<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {i}</title></head><body>
<h1>Chapter {i}</h1>
<p>This is chapter {i} of the audio then EPUB isolation regression fixture.</p>
<p>The semantic ZIP parser must run exactly once even if the same file event is delivered twice.</p>
</body></html>''',
            )
        zf.writestr(
            'OEBPS/content.opf',
            f'''<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">audio-epub-toc128</dc:identifier>
    <dc:title>{TITLE}</dc:title>
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


payload_b64 = base64.b64encode(make_epub_bytes()).decode('ascii')
cdp = ReaderCDP(connect_timeout=55)
cdp.connect()
cdp.wait("document.readyState==='complete'", 55)
cdp.wait("window.readerImportFromFile && window.__readerImportIsolationStats", 20)

before = cdp.eval(r"""(async()=>{
  const key=window.an2ReaderStorageKey?.('an2_reader_books_v1')||'an2_reader_books_v1::guest';
  const mod=await import('./js/reader/library-idb-store.js?v=1');
  const books=await mod.libraryIdbGet(key)||[];
  const stats={...(globalThis.__readerImportIsolationStats||{})};
  return {key,count:books.length,ids:books.map(b=>String(b?.id||'')),titles:books.map(b=>String(b?.title||'')),stats};
})()""", 30)

result = cdp.eval(f"""(async()=>{{
  const title={json.dumps(TITLE)};
  const author={json.dumps(AUTHOR)};
  const waitFor=async(fn,timeout=8000)=>{{
    const start=Date.now();
    while(Date.now()-start<timeout){{ if(fn()) return true; await new Promise(r=>setTimeout(r,80)); }}
    return false;
  }};

  window.showScreen?.('reader');
  window.readerBackToLibrary?.();
  await Promise.resolve(window.renderReaderScreen?.());
  window.showReaderImportModal?.();

  // Reproduce the visible residue left by a completed audio transcription.
  const titleEl=document.getElementById('reader-import-title');
  const authorEl=document.getElementById('reader-import-author');
  const preview=document.getElementById('reader-import-text');
  const audioStatus=document.getElementById('reader-import-audio-status');
  const stopBtn=document.getElementById('reader-audio-stop-btn');
  if(titleEl) titleEl.value='Previous audio transcript';
  if(authorEl) authorEl.value='Previous audio author';
  if(preview) preview.value='Old transcript text that must not survive into the EPUB import.';
  if(audioStatus){{
    audioStatus.style.display='inline';
    audioStatus.textContent='✅ Готово: 13 фрагмент(ов) · аудио сохранено · тайм-коды (приблизительно). Проверь текст перед сохранением.';
  }}
  if(stopBtn) stopBtn.style.display='inline-flex';

  const raw=atob({json.dumps(payload_b64)});
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  const file=new File([bytes], 'audio-then-epub-toc128.epub', {{type:'application/epub+zip', lastModified:128}});
  const importHandler=window.readerImportFromFile;
  const saveHandler=window.saveReaderImport;
  if(typeof importHandler!=='function'||typeof saveHandler!=='function') throw new Error('import handlers missing');
  if(!importHandler.__readerAudioEpubIsolationV2) throw new Error('audio→EPUB isolation bridge v2 missing');

  const statsBefore={{...(globalThis.__readerImportIsolationStats||{{}})}};
  const first=Promise.resolve(importHandler({{target:{{files:[file],value:''}}}}));
  const second=Promise.resolve(importHandler({{target:{{files:[file],value:''}}}}));
  await Promise.all([first,second]);

  const statsAfter={{...(globalThis.__readerImportIsolationStats||{{}})}};
  const parseStatus=String(document.getElementById('reader-import-status')?.textContent||'');
  if(parseStatus.startsWith('❌')) throw new Error(parseStatus);

  const staleAudioStatusVisible=!!audioStatus && getComputedStyle(audioStatus).display!=='none' && !!String(audioStatus.textContent||'').trim();
  const staleAudioTitle=String(titleEl?.value||'')==='Previous audio transcript';
  const staleAudioAuthor=String(authorEl?.value||'')==='Previous audio author';
  const staleAudioPreview=String(preview?.value||'').includes('Old transcript text');

  const lang=document.getElementById('reader-import-lang');
  if(lang){{lang.value='en';lang.dataset.userChanged='1';}}
  if(titleEl) titleEl.value=title;
  if(authorEl) authorEl.value=author;

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
  const durableMatches=durable.filter(b=>String(b?.title||'')===title);
  const localMatches=Array.isArray(local)?local.filter(b=>String(b?.title||'')===title):[];

  window.readerBackToLibrary?.();
  await waitFor(()=>{{
    const library=document.getElementById('reader-library-view');
    const reading=document.getElementById('reader-reading-view');
    return library&&reading&&getComputedStyle(library).display!=='none'&&getComputedStyle(reading).display==='none';
  }},6000);
  await Promise.resolve(window.renderReaderScreen?.());
  await new Promise(r=>setTimeout(r,400));
  const libraryList=document.getElementById('reader-library-list');
  const cardTitles=[...(libraryList?.querySelectorAll?.('.lib-book-title')||[])].map(x=>String(x.textContent||'').trim());

  return {{
    parseStatus,
    statsBefore,
    statsAfter,
    epubStartsDelta:Number(statsAfter.epubStarts||0)-Number(statsBefore.epubStarts||0),
    canonicalResetsDelta:Number(statsAfter.canonicalResets||0)-Number(statsBefore.canonicalResets||0),
    dedupedCallsDelta:Number(statsAfter.dedupedCalls||0)-Number(statsBefore.dedupedCalls||0),
    blockedConcurrentDelta:Number(statsAfter.blockedConcurrent||0)-Number(statsBefore.blockedConcurrent||0),
    staleAudioStatusVisible,
    staleAudioTitle,
    staleAudioAuthor,
    staleAudioPreview,
    openedReady,
    openedTitle:String(opened?.title||''),
    openedFull:!!opened?.chapters?.length,
    openedChapterCount:Array.isArray(opened?.chapters)?opened.chapters.length:0,
    openedHasOriginalAudio:!!opened?.hasOriginalAudio,
    openedHasParagraphTimestamps:Array.isArray(opened?.paragraphTimestamps)&&opened.paragraphTimestamps.length>0,
    durableCount:durable.length,
    durableMatches:durableMatches.length,
    durableHasAudio:durableMatches.some(b=>!!b?.hasOriginalAudio),
    durableHasTimestamps:durableMatches.some(b=>Array.isArray(b?.paragraphTimestamps)&&b.paragraphTimestamps.length>0),
    localCount:Array.isArray(local)?local.length:-1,
    localMatches:localMatches.length,
    cardMatches:cardTitles.filter(x=>x===title).length,
    cardTitles,
  }};
}})()""", 70)

summary = {'before': before, 'after': result}
(OUT / 'toc128-audio-epub-reuse.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)

if not result:
    raise RuntimeError('audio→EPUB audit returned no result')
if result['epubStartsDelta'] != 1:
    raise RuntimeError('same EPUB launched semantic parser more than once: ' + repr(summary))
if result['canonicalResetsDelta'] != 1:
    raise RuntimeError('EPUB did not reset canonical pending audio import state exactly once: ' + repr(summary))
if result['dedupedCallsDelta'] < 1:
    raise RuntimeError('duplicate EPUB file event was not deduplicated: ' + repr(summary))
if result['blockedConcurrentDelta'] != 0:
    raise RuntimeError('same-file duplicate was treated as another EPUB instead of same-flight reuse: ' + repr(summary))
if result['staleAudioStatusVisible'] or result['staleAudioTitle'] or result['staleAudioAuthor'] or result['staleAudioPreview']:
    raise RuntimeError('audio import residue remained visible after EPUB takeover: ' + repr(summary))
if not result['openedReady'] or result['openedTitle'] != TITLE or not result['openedFull'] or result['openedChapterCount'] != CHAPTERS:
    raise RuntimeError('EPUB after audio did not open cleanly: ' + repr(summary))
if result['openedHasOriginalAudio'] or result['openedHasParagraphTimestamps']:
    raise RuntimeError('previous audio attachment/timestamps leaked into EPUB book: ' + repr(summary))
if result['durableMatches'] != 1 or result['localMatches'] != 1 or result['cardMatches'] != 1:
    raise RuntimeError('audio→EPUB flow created missing/duplicate book state: ' + repr(summary))
if result['durableHasAudio'] or result['durableHasTimestamps']:
    raise RuntimeError('stale audio metadata leaked into durable EPUB: ' + repr(summary))
if result['durableCount'] < before['count'] + 1 or result['localCount'] < before['count'] + 1:
    raise RuntimeError('audio→EPUB flow did not increase library count: ' + repr(summary))

cdp.close()
