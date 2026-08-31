#!/usr/bin/env python3
import base64
import json
import pathlib
import subprocess
import time

import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
EPUB = OUT / 'toc103-pagination.epub'

pages = []
for _ in range(120):
    try:
        pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception:
        pages = []
    if pages:
        break
    time.sleep(.5)
if not pages:
    raise SystemExit('No debuggable Reader AI WebView')
page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url', '')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=25, suppress_origin=True)
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


def wait(code, timeout=45):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = ev(code)
            if last:
                return last
        except Exception as exc:
            last = str(exc)
        time.sleep(.35)
    raise RuntimeError(f'wait timeout: {code}; last={last}')


def save_screen(name):
    with (OUT / name).open('wb') as fh:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=fh, check=True)


def mode_diag():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const scroller=document.querySelector('#reader-reading-view .rd-scroll');
      const button=document.getElementById('reader-view-mode-btn');
      return {
        storedMode:localStorage.getItem('an2_reader_view_mode_v1')||'',
        buttonOn:!!button?.classList.contains('on'),
        scrollerPages:!!scroller?.classList.contains('rd-pages-mode'),
        directPages:root?.querySelectorAll(':scope > .rd-page').length||0,
        directParagraphs:root?.querySelectorAll(':scope > .reader-paragraph').length||0,
        descendantParagraphs:root?.querySelectorAll('.reader-paragraph').length||0,
        childClasses:[...root?.children||[]].slice(0,8).map(x=>x.className||x.tagName),
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
      };
    })()""")


def page_state():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const pages=[...root?.querySelectorAll(':scope > .rd-page')||[]];
      const cur=root?.querySelector(':scope > .rd-page.rd-page-current, :scope > .rd-page.rd-page-show');
      const marker=(cur?.innerText||'').match(/PAGE_TURN_MARKER_\\d+/)?.[0]||'';
      const first=cur?.querySelector('.reader-paragraph');
      return {
        pageCount:pages.length,
        currentIndex:pages.indexOf(cur),
        marker,
        paragraphIndex:first?.dataset?.paragraphIndex||first?.dataset?.index||'',
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
        pagesMode:document.querySelector('#reader-reading-view .rd-scroll')?.classList.contains('rd-pages-mode')||false,
      };
    })()""")


def install_swipe_probe():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const rect=root?.getBoundingClientRect();
      window.__toc103SwipeProbe=[];
      if(!window.__toc103SwipeProbeInstalled){
        window.__toc103SwipeProbeInstalled=true;
        for(const type of ['touchstart','touchmove','touchend','touchcancel']){
          document.addEventListener(type,(event)=>{
            const t=event.touches?.[0]||event.changedTouches?.[0]||null;
            if(window.__toc103SwipeProbe.length<40){
              window.__toc103SwipeProbe.push({
                type,
                x:t?.clientX??null,
                y:t?.clientY??null,
                target:event.target?.className||event.target?.id||event.target?.tagName||'',
                readerRanging:!!window.__readerRanging,
                at:Date.now(),
              });
            }
          },true);
        }
      }
      const hit=document.elementFromPoint(window.innerWidth/2,window.innerHeight/2);
      return {
        innerWidth:window.innerWidth,
        innerHeight:window.innerHeight,
        devicePixelRatio:window.devicePixelRatio,
        readerRanging:!!window.__readerRanging,
        rootRect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}:null,
        centerHit:hit?.className||hit?.id||hit?.tagName||'',
      };
    })()""")


def swipe_probe_state(environment):
    return ev("""(()=>({
      environment:%s,
      readerRanging:!!window.__readerRanging,
      events:window.__toc103SwipeProbe||[],
      selection:String(window.getSelection?.()||''),
    }))()""" % json.dumps(environment))


cdp('Runtime.enable')
cdp('Page.enable')
wait("document.readyState==='complete'", 30)

if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = wait("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()", 60)
    if not clicked:
        raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'", 30)
wait("typeof window.readerImportFromFile==='function' && typeof window.saveReaderImport==='function'", 30)

b64 = base64.b64encode(EPUB.read_bytes()).decode('ascii')
expr = f"""(async()=>{{
  window.showReaderImportModal?.();
  const bytes=Uint8Array.from(atob({json.dumps(b64)}),c=>c.charCodeAt(0));
  const file=new File([bytes],'toc103-pagination.epub',{{type:'application/epub+zip'}});
  await window.readerImportFromFile({{target:{{files:[file]}}}});
  return document.getElementById('reader-import-status')?.textContent||'';
}})()"""
status = ev(expr) or ''
if 'EPUB' not in status:
    raise RuntimeError('EPUB parser did not accept fixture: ' + status)
ev("(()=>{const t=document.getElementById('reader-import-title');if(t)t.value='Pagination Acceptance';return window.saveReaderImport?.()})()")

wait("(()=>{const v=document.getElementById('reader-reading-view');return !!(v&&getComputedStyle(v).display!=='none'&&document.querySelectorAll('#reader-chapter-text .reader-paragraph').length>=10)})()", 45)
time.sleep(2.0)
ev("window.rdSetPageAnimation?.('none', null); true")

# A page-mode object can legitimately remember `pages` while a just-rendered
# chapter has not yet been wrapped. Do not assume one toggle means "enable".
# Observe the actual UI/DOM state and allow at most two public user toggles to
# reach page mode. IMPORTANT: toc103 deliberately tolerates a single collapsed
# `.rd-page` here. Its real page-turn path calls ensureLivePagesForTurn(), which
# recovers bogus WebView geometry by rebuilding long chapters as one paragraph
# per temporary page. Requiring >=2 wrappers before the physical swipe prevents
# that production recovery path from ever running and tests the harness instead
# of Reader AI.
diags = [mode_diag()]
for _ in range(2):
    state = diags[-1]
    if state['scrollerPages'] and state['directPages'] >= 1 and state['descendantParagraphs'] >= 2:
        break
    ev("window.readerTogglePagesMode(); true")
    time.sleep(1.2)
    diags.append(mode_diag())

(OUT / 'page-mode-diagnostics.json').write_text(json.dumps(diags, ensure_ascii=False, indent=2), encoding='utf-8')
final_mode = diags[-1]
if not final_mode['scrollerPages'] or final_mode['directPages'] < 1 or final_mode['descendantParagraphs'] < 2:
    raise RuntimeError('PAGE MODE DID NOT MATERIALIZE: ' + json.dumps(diags, ensure_ascii=False))
wait("document.getElementById('reader-chapter-text')?.dataset?.boundReaderSwipe==='1'", 10)

before = page_state()
if not before['pagesMode'] or before['pageCount'] < 1 or before['currentIndex'] < 0 or not before['marker']:
    raise RuntimeError('Pagination did not produce a swipeable current page: ' + json.dumps(before, ensure_ascii=False))

# Install capture-only telemetry before the real Android gesture. It changes no
# reader state and does not call navigation methods. This tells us whether adb
# input truly reaches WebView as touch events, what element it hits, and whether
# Reader's selection/ranging guard suppresses touchend navigation.
probe_environment = install_swipe_probe()
(OUT / 'swipe-environment.json').write_text(json.dumps(probe_environment, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('01-before-swipe.png')

# Actual Android touch input. No direct next()/prev() JS calls are accepted.
# Explicitly request the touchscreen source to remove ambiguity in `input`.
# If WebView collapsed the chapter to one giant wrapper, this first real gesture
# must trigger toc103's ensureLivePagesForTurn() recovery and then advance.
subprocess.run(['adb','shell','input','touchscreen','swipe','900','1150','180','1150','320'], check=True)
time.sleep(1.2)
after_next = page_state()
gesture = swipe_probe_state(probe_environment)
(OUT / 'swipe-events.json').write_text(json.dumps(gesture, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('02-after-left-swipe.png')
if after_next['pageCount'] < 2 or after_next['currentIndex'] <= before['currentIndex'] or after_next['marker'] == before['marker']:
    raise RuntimeError('PHYSICAL SWIPE DID NOT TURN PAGE: ' + json.dumps({'before': before, 'after': after_next, 'gesture': gesture, 'mode': diags}, ensure_ascii=False))

# Reset capture telemetry only; navigation remains entirely physical.
ev("window.__toc103SwipeProbe=[]; true")
subprocess.run(['adb','shell','input','touchscreen','swipe','180','1150','900','1150','320'], check=True)
time.sleep(1.2)
after_prev = page_state()
reverse_gesture = swipe_probe_state(probe_environment)
(OUT / 'reverse-swipe-events.json').write_text(json.dumps(reverse_gesture, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('03-after-right-swipe.png')
if after_prev['currentIndex'] != before['currentIndex'] or after_prev['marker'] != before['marker']:
    raise RuntimeError('REVERSE PHYSICAL SWIPE DID NOT RETURN PAGE: ' + json.dumps({'before': before, 'after': after_prev, 'gesture': reverse_gesture}, ensure_ascii=False))

result = {
    'ok': True,
    'fixture': str(EPUB),
    'modeDiagnostics': diags,
    'probeEnvironment': probe_environment,
    'leftSwipeEvents': gesture,
    'rightSwipeEvents': reverse_gesture,
    'before': before,
    'after_next': after_next,
    'after_prev': after_prev,
    'assertions': [
        'page mode is active before input',
        'Android touchscreen left swipe reaches WebView and advances',
        'Android touchscreen right swipe reaches WebView and returns',
    ],
}
(OUT / 'pagination-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
