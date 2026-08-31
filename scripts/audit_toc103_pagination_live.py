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
      const rect=root?.getBoundingClientRect();
      return {
        storedMode:localStorage.getItem('an2_reader_view_mode_v1')||'',
        buttonOn:!!button?.classList.contains('on'),
        scrollerPages:!!scroller?.classList.contains('rd-pages-mode'),
        directPages:root?.querySelectorAll(':scope > .rd-page').length||0,
        directParagraphs:root?.querySelectorAll(':scope > .reader-paragraph').length||0,
        descendantParagraphs:root?.querySelectorAll('.reader-paragraph').length||0,
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
        rootRect:rect?{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}:null,
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
        paragraphIndex:first?.dataset?.p||first?.dataset?.paragraphIndex||first?.dataset?.index||'',
        boundSwipe:root?.dataset?.boundReaderSwipe||'',
        pagesMode:document.querySelector('#reader-reading-view .rd-scroll')?.classList.contains('rd-pages-mode')||false,
      };
    })()""")


def install_swipe_probe():
    return ev("""(()=>{
      const root=document.getElementById('reader-chapter-text');
      const surface=root?.querySelector(':scope > .rd-page.rd-page-current, :scope > .rd-page.rd-page-show')||root;
      const rect=surface?.getBoundingClientRect();
      const dpr=window.devicePixelRatio||1;
      window.__toc103SwipeProbe=[];
      if(!window.__toc103SwipeProbeInstalled){
        window.__toc103SwipeProbeInstalled=true;
        for(const type of ['touchstart','touchmove','touchend','touchcancel']){
          document.addEventListener(type,(event)=>{
            const t=event.touches?.[0]||event.changedTouches?.[0]||null;
            const rootNow=document.getElementById('reader-chapter-text');
            if(window.__toc103SwipeProbe.length<60){
              window.__toc103SwipeProbe.push({
                type,
                x:t?.clientX??null,
                y:t?.clientY??null,
                target:event.target?.className||event.target?.id||event.target?.tagName||'',
                insideRoot:!!(rootNow&&event.target&&rootNow.contains(event.target)),
                readerRanging:!!window.__readerRanging,
                at:Date.now(),
              });
            }
          },true);
        }
      }
      if(!rect||rect.width<120||rect.height<120) return {ok:false, reason:'reader surface not visible', rect};
      const y=Math.max(rect.top+50, Math.min(rect.bottom-50, window.innerHeight*0.50));
      const startX=Math.max(rect.left+80, Math.min(rect.right-35, window.innerWidth-35));
      const endX=Math.min(rect.right-80, Math.max(rect.left+35, 35));
      const hit=document.elementFromPoint((startX+endX)/2,y);
      return {
        ok:true,
        innerWidth:window.innerWidth,
        innerHeight:window.innerHeight,
        devicePixelRatio:dpr,
        readerRanging:!!window.__readerRanging,
        surfaceRect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},
        midpointHit:hit?.className||hit?.id||hit?.tagName||'',
        midpointInsideRoot:!!(root&&hit&&root.contains(hit)),
        left:{x1:Math.round(startX*dpr),y1:Math.round(y*dpr),x2:Math.round(endX*dpr),y2:Math.round(y*dpr)},
        right:{x1:Math.round(endX*dpr),y1:Math.round(y*dpr),x2:Math.round(startX*dpr),y2:Math.round(y*dpr)},
      };
    })()""")


def swipe_probe_state(environment):
    return ev("""(()=>({
      environment:%s,
      readerRanging:!!window.__readerRanging,
      events:window.__toc103SwipeProbe||[],
      selection:String(window.getSelection?.()||''),
    }))()""" % json.dumps(environment))


def physical_swipe(coords):
    subprocess.run([
        'adb','shell','input','touchscreen','swipe',
        str(coords['x1']),str(coords['y1']),str(coords['x2']),str(coords['y2']),'320'
    ], check=True)


cdp('Runtime.enable')
cdp('Page.enable')
wait("document.readyState==='complete'", 30)

if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = wait("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()", 60)
    if not clicked:
        raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'", 30)
wait("typeof window.showScreen==='function' && typeof window.readerImportFromFile==='function' && typeof window.saveReaderImport==='function'", 30)

# The previous harness imported a book while the app was still on Home. The
# reader DOM existed in memory, so DOM-only assertions passed, but adb swiped the
# Home candidate card. Enter the Reader screen first, exactly as the bottom-nav
# action does, then import and open the fixture.
ev("window.showScreen('reader'); true")
time.sleep(.8)

b64 = base64.b64encode(EPUB.read_bytes()).decode('ascii')
status = ev(f"""(async()=>{{
  window.showReaderImportModal?.();
  const bytes=Uint8Array.from(atob({json.dumps(b64)}),c=>c.charCodeAt(0));
  const file=new File([bytes],'toc103-pagination.epub',{{type:'application/epub+zip'}});
  await window.readerImportFromFile({{target:{{files:[file]}}}});
  return document.getElementById('reader-import-status')?.textContent||'';
}})()""") or ''
if 'EPUB' not in status:
    raise RuntimeError('EPUB parser did not accept fixture: ' + status)

ev("(()=>{const t=document.getElementById('reader-import-title');if(t)t.value='Pagination Acceptance';return window.saveReaderImport?.()})()")

# Require the actual book surface to be visible on screen, not merely present in
# a hidden Reader subtree.
wait("""(()=>{
  const v=document.getElementById('reader-reading-view');
  const root=document.getElementById('reader-chapter-text');
  const r=root?.getBoundingClientRect();
  return !!(v&&getComputedStyle(v).display!=='none'&&root&&root.querySelectorAll('.reader-paragraph').length>=10&&r&&r.width>120&&r.height>120);
})()""", 45)
time.sleep(1.5)
ev("window.rdSetPageAnimation?.('none', null); true")
save_screen('00-reader-open.png')

# Reach page mode using the public toggle. toc103 may initially collapse the
# fixture into one .rd-page; that is allowed because the production turn path is
# responsible for recovering it on the first gesture.
diags = [mode_diag()]
for _ in range(2):
    state = diags[-1]
    if state['scrollerPages'] and state['directPages'] >= 1 and state['descendantParagraphs'] >= 2:
        break
    ev("window.readerTogglePagesMode(); true")
    time.sleep(1.0)
    diags.append(mode_diag())

(OUT / 'page-mode-diagnostics.json').write_text(json.dumps(diags, ensure_ascii=False, indent=2), encoding='utf-8')
final_mode = diags[-1]
if not final_mode['scrollerPages'] or final_mode['directPages'] < 1 or final_mode['descendantParagraphs'] < 2:
    raise RuntimeError('PAGE MODE DID NOT MATERIALIZE: ' + json.dumps(diags, ensure_ascii=False))
if not final_mode.get('rootRect') or final_mode['rootRect']['width'] < 120 or final_mode['rootRect']['height'] < 120:
    raise RuntimeError('READER PAGE IS NOT VISIBLE: ' + json.dumps(final_mode, ensure_ascii=False))
wait("document.getElementById('reader-chapter-text')?.dataset?.boundReaderSwipe==='1'", 10)

before = page_state()
if not before['pagesMode'] or before['pageCount'] < 1 or before['currentIndex'] < 0 or not before['marker']:
    raise RuntimeError('Pagination did not produce a swipeable current page: ' + json.dumps(before, ensure_ascii=False))

probe_environment = install_swipe_probe()
(OUT / 'swipe-environment.json').write_text(json.dumps(probe_environment, ensure_ascii=False, indent=2), encoding='utf-8')
if not probe_environment.get('ok') or not probe_environment.get('midpointInsideRoot'):
    raise RuntimeError('SWIPE TARGET IS NOT THE READER PAGE: ' + json.dumps(probe_environment, ensure_ascii=False))
save_screen('01-before-swipe.png')

physical_swipe(probe_environment['left'])
time.sleep(1.2)
after_next = page_state()
gesture = swipe_probe_state(probe_environment)
(OUT / 'swipe-events.json').write_text(json.dumps(gesture, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('02-after-left-swipe.png')

left_events = gesture.get('events') or []
if not any(e.get('type') == 'touchstart' and e.get('insideRoot') for e in left_events):
    raise RuntimeError('ANDROID SWIPE DID NOT REACH READER ROOT: ' + json.dumps(gesture, ensure_ascii=False))
if not any(e.get('type') == 'touchend' and e.get('insideRoot') for e in left_events):
    raise RuntimeError('ANDROID SWIPE DID NOT COMPLETE IN READER ROOT: ' + json.dumps(gesture, ensure_ascii=False))
if after_next['pageCount'] < 2 or after_next['currentIndex'] <= before['currentIndex'] or after_next['marker'] == before['marker']:
    raise RuntimeError('PHYSICAL SWIPE DID NOT TURN PAGE: ' + json.dumps({'before':before,'after':after_next,'gesture':gesture,'mode':diags}, ensure_ascii=False))

ev("window.__toc103SwipeProbe=[]; true")
physical_swipe(probe_environment['right'])
time.sleep(1.2)
after_prev = page_state()
reverse_gesture = swipe_probe_state(probe_environment)
(OUT / 'reverse-swipe-events.json').write_text(json.dumps(reverse_gesture, ensure_ascii=False, indent=2), encoding='utf-8')
save_screen('03-after-right-swipe.png')

right_events = reverse_gesture.get('events') or []
if not any(e.get('type') == 'touchstart' and e.get('insideRoot') for e in right_events):
    raise RuntimeError('REVERSE ANDROID SWIPE DID NOT REACH READER ROOT: ' + json.dumps(reverse_gesture, ensure_ascii=False))
if after_prev['currentIndex'] != before['currentIndex'] or after_prev['marker'] != before['marker']:
    raise RuntimeError('REVERSE PHYSICAL SWIPE DID NOT RETURN PAGE: ' + json.dumps({'before':before,'after':after_prev,'gesture':reverse_gesture}, ensure_ascii=False))

result = {
    'ok': True,
    'fixture': str(EPUB),
    'modeDiagnostics': diags,
    'probeEnvironment': probe_environment,
    'before': before,
    'after_next': after_next,
    'after_prev': after_prev,
    'assertions': [
        'Reader screen and book surface are physically visible',
        'Android touchscreen left swipe reaches Reader root and advances',
        'Android touchscreen right swipe reaches Reader root and returns',
    ],
}
(OUT / 'pagination-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
