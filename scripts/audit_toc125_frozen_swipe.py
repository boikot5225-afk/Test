#!/usr/bin/env python3
import json
import pathlib
import re
import subprocess
import time
import xml.etree.ElementTree as ET
import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
pages = []
for _ in range(120):
    try:
        pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception:
        pages = []
    if pages:
        break
    time.sleep(.3)
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

def screenshot(name):
    with (OUT / name).open('wb') as fh:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=fh, check=True)

def adb_ui_xml():
    remote = '/sdcard/toc125-window.xml'
    subprocess.run(['adb', 'shell', 'uiautomator', 'dump', remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return subprocess.run(['adb', 'shell', 'cat', remote], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False).stdout or ''

def has_anr(xml=None):
    xml = adb_ui_xml() if xml is None else xml
    return bool(re.search(r"(?:isn't|is not|not)\s+responding|quickstep", xml, re.I))

def dismiss_anr():
    dismissed = False
    for _ in range(5):
        xml = adb_ui_xml()
        if not has_anr(xml):
            return dismissed
        try:
            root = ET.fromstring(xml)
        except Exception:
            root = None
        tapped = False
        if root is not None:
            for node in root.iter('node'):
                if str(node.attrib.get('text', '')).strip().lower() != 'wait':
                    continue
                match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.attrib.get('bounds', ''))
                if not match:
                    continue
                x1, y1, x2, y2 = map(int, match.groups())
                subprocess.run(['adb', 'shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)], check=False)
                tapped = True
                break
        if not tapped:
            subprocess.run(['adb', 'shell', 'input', 'keyevent', '4'], check=False)
        dismissed = True
        time.sleep(.7)
    return dismissed

def state():
    return ev("""(()=>{
      const s=document.querySelector('#reader-reading-view .rd-scroll');
      const root=document.getElementById('reader-chapter-text');
      const ps=[...root?.querySelectorAll(':scope > .rd-page')||[]];
      const cur=root?.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');
      const r=(cur||root)?.getBoundingClientRect();
      const modal=document.getElementById('reader-import-modal');
      return {
        mode:!!s?.classList.contains('rd-pages-mode'),
        count:ps.length,
        index:ps.indexOf(cur),
        rect:r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:null,
        ranging:!!window.__readerRanging,
        swipeBound:root?.dataset?.boundReaderSwipe||'',
        delegationBound:root?.dataset?.boundReaderDelegation||'',
        importModalVisible:!!(modal&&getComputedStyle(modal).display!=='none'&&modal.getBoundingClientRect().width>0&&modal.getBoundingClientRect().height>0),
        canonicalModule:String(globalThis.__readerCanonicalModuleUrl||''),
      };
    })()""")

def write_debug(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def wait_ranging_clear(timeout=4.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not bool(ev('!!window.__readerRanging')):
            return True
        time.sleep(.15)
    return False

def touch_delivered(events):
    return (
        any(x.get('type') == 'touchstart' and x.get('inside') for x in events)
        and any(x.get('type') == 'touchend' and x.get('inside') for x in events)
    )

def physical_swipe_with_delivery_retry(start_x, end_x, y, expected_index, label, max_attempts=3):
    """Retry only Android/emulator delivery failures, never a delivered Reader failure.

    An attempt is eligible for retry when Android produces no usable start/end
    sequence (empty events, partial delivery, or touchcancel) and the page did
    not move. Once a complete physical touchstart+touchend reaches Reader, the
    caller receives it immediately and must enforce the expected page turn.
    """
    attempts = []
    for attempt in range(1, max_attempts + 1):
        if not wait_ranging_clear():
            raise RuntimeError(f'reader ranging guard remained active before {label} swipe attempt {attempt}')
        dismissed_here = dismiss_anr()
        if has_anr():
            raise RuntimeError(f'Android system ANR overlay remained before {label} swipe attempt {attempt}')

        ev('window.__toc125Touch=[]; window.__toc125PageChanges=[]; true')
        subprocess.run([
            'adb', 'shell', 'input', 'touchscreen', 'swipe',
            str(start_x), str(y), str(end_x), str(y), '350'
        ], check=True)
        time.sleep(1.15)

        after_state = state()
        events = ev('window.__toc125Touch||[]') or []
        page_changes = ev('window.__toc125PageChanges||[]') or []
        delivered = touch_delivered(events)
        cancelled = any(x.get('type') == 'touchcancel' for x in events)
        attempts.append({
            'attempt': attempt,
            'beforeIndex': expected_index,
            'afterIndex': after_state.get('index'),
            'eventCount': len(events),
            'delivered': delivered,
            'cancelled': cancelled,
            'dismissedAnr': dismissed_here,
        })

        # A complete physical gesture reached Reader. Do not retry merely
        # because Reader did not turn the page; that would hide a real bug.
        if delivered:
            return after_state, events, page_changes, attempts

        # If the page somehow moved without a complete observed sequence, do
        # not replay another gesture and accidentally advance twice. Return it
        # to the strict caller, which will fail on missing delivery evidence.
        if after_state.get('index') != expected_index:
            return after_state, events, page_changes, attempts

        if attempt < max_attempts:
            # GitHub's Android emulator occasionally drops the entire adb input
            # stream while the GPU surface settles. Give the same unchanged
            # physical path another chance; no JS gesture is synthesized.
            time.sleep(.7)

    return after_state, events, page_changes, attempts

cdp('Runtime.enable')
if ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||''") != 'fr':
    raise RuntimeError('swipe gate is not in French Reader')

# Remove only UI overlays owned by Reader itself; this does not touch reader state,
# pagination code or gesture handlers.
ev("window.readerCloseWordPanel?.(); window.closeReaderImportModal?.(); true")
ev("window.readerSelectParagraph?.(0); true")
time.sleep(.8)
dismissed = dismiss_anr()
if has_anr():
    screenshot('toc125-swipe-anr-stuck.png')
    raise RuntimeError('Android system ANR overlay remained before swipe gate')
if not wait_ranging_clear():
    diag = {'phase': 'setup', 'state': state(), 'ui': adb_ui_xml()[:5000]}
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-ranging-stuck.png')
    raise RuntimeError('reader ranging guard remained active before swipe')

for _ in range(2):
    s = state()
    if s['mode'] and s['count'] >= 2 and s['index'] >= 0:
        break
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(1.0)
s = state()
if not s['mode'] or s['count'] < 2 or s['index'] < 0 or not s['rect']:
    raise RuntimeError('frozen toc119 page mode unavailable: ' + json.dumps(s))
if s['index'] >= s['count'] - 1:
    ev("window.readerSelectParagraph?.(0); true")
    time.sleep(.8)
    s = state()
if s['importModalVisible']:
    raise RuntimeError('Reader import modal is still visible before swipe')
if s['swipeBound'] != '1':
    raise RuntimeError('frozen swipe listener is not bound to chapter root: ' + json.dumps(s))

# Observe only. The listeners below never cancel, mutate or replace Reader events.
ev("""(()=>{
  window.__toc125Touch=[];
  window.__toc125PageChanges=[];
  if(!window.__toc125TouchBound){
    window.__toc125TouchBound=true;
    for(const type of ['touchstart','touchmove','touchend','touchcancel']){
      document.addEventListener(type,e=>{
        const root=document.getElementById('reader-chapter-text');
        const t=e.touches?.[0]||e.changedTouches?.[0]||null;
        window.__toc125Touch.push({
          type,
          inside:!!(root&&e.target&&root.contains(e.target)),
          x:t?.clientX??null,
          y:t?.clientY??null,
          ranging:!!window.__readerRanging,
          at:Math.round(performance.now()),
        });
      },true);
    }
    window.addEventListener('reader:pagechange',e=>window.__toc125PageChanges.push({
      pageIndex:Number(e.detail?.pageIndex??-1),
      pageCount:Number(e.detail?.pageCount??-1),
      at:Math.round(performance.now()),
    }));
  }
  return true;
})()""")

# The release gate is the physical gesture itself. A synthetic direct-handler
# preflight used to abort before any ADB touch was injected, so it could neither
# prove nor disprove the user's swipe path.
if not wait_ranging_clear():
    raise RuntimeError('reader ranging guard remained active before physical swipe')
dismissed = dismiss_anr() or dismissed
if has_anr():
    screenshot('toc125-swipe-anr-before-gesture.png')
    raise RuntimeError('Android system ANR overlay returned before physical swipe')

s = state()
dpr = float(ev('window.devicePixelRatio||1'))
r = s['rect']
ycss = max(r['top'] + 70, min(r['bottom'] - 70, (r['top'] + r['bottom']) / 2))
xr = max(r['left'] + 120, r['right'] - 55)
xl = min(r['right'] - 120, r['left'] + 55)
inside = ev(f"""(()=>{{
  const root=document.getElementById('reader-chapter-text');
  return [[{xr},{ycss}],[{(xr+xl)/2},{ycss}],[{xl},{ycss}]].every(([x,y])=>{{
    const hit=document.elementFromPoint(x,y);
    return !!(root&&hit&&root.contains(hit));
  }});
}})()""")
if not inside:
    dismissed = dismiss_anr() or dismissed
    inside = ev(f"""(()=>{{
      const root=document.getElementById('reader-chapter-text');
      return [[{xr},{ycss}],[{(xr+xl)/2},{ycss}],[{xl},{ycss}]].every(([x,y])=>{{
        const hit=document.elementFromPoint(x,y);
        return !!(root&&hit&&root.contains(hit));
      }});
    }})()""")
if not inside:
    raise RuntimeError('swipe path is not inside Reader')

x1 = int(round(xr * dpr))
x2 = int(round(xl * dpr))
y = int(round(ycss * dpr))
before = s['index']
screenshot('toc125-swipe-before-left.png')
after_state, left, left_pages, left_attempts = physical_swipe_with_delivery_retry(
    x1, x2, y, before, 'left'
)
after = after_state['index']
if not touch_delivered(left):
    diag = {
        'phase': 'left-touch-delivery',
        'before': s,
        'after': after_state,
        'events': left,
        'pageChanges': left_pages,
        'attempts': left_attempts,
        'anr': has_anr(),
    }
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-left-not-delivered.png')
    raise RuntimeError('left swipe did not reach Reader after delivery retries: ' + json.dumps(diag, ensure_ascii=False))
if after != before + 1:
    diag = {
        'phase': 'left-no-turn',
        'before': s,
        'after': after_state,
        'events': left,
        'pageChanges': left_pages,
        'attempts': left_attempts,
        'anr': has_anr(),
    }
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-left-no-turn.png')
    raise RuntimeError(f'frozen toc119 left swipe failed: {before}->{after}; diag={json.dumps(diag, ensure_ascii=False)}')

if not wait_ranging_clear():
    raise RuntimeError('reader ranging guard remained active before right swipe')
dismissed = dismiss_anr() or dismissed
if has_anr():
    raise RuntimeError('Android system ANR overlay returned before right physical swipe')
back_state, right, right_pages, right_attempts = physical_swipe_with_delivery_retry(
    x2, x1, y, after, 'right'
)
back = back_state['index']
if not touch_delivered(right):
    diag = {
        'phase': 'right-touch-delivery',
        'afterLeft': after_state,
        'afterRight': back_state,
        'events': right,
        'pageChanges': right_pages,
        'attempts': right_attempts,
        'anr': has_anr(),
    }
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-right-not-delivered.png')
    raise RuntimeError('right swipe did not reach Reader after delivery retries: ' + json.dumps(diag, ensure_ascii=False))
if back != before:
    diag = {
        'phase': 'right-no-turn',
        'afterLeft': after_state,
        'afterRight': back_state,
        'events': right,
        'pageChanges': right_pages,
        'attempts': right_attempts,
        'anr': has_anr(),
    }
    write_debug('toc125-swipe-failure.json', diag)
    screenshot('toc125-swipe-right-no-turn.png')
    raise RuntimeError(f'frozen toc119 right swipe failed: {after}->{back}; diag={json.dumps(diag, ensure_ascii=False)}')

screenshot('toc125-frozen-swipe.png')
result = {
    'ok': True,
    'pages': s['count'],
    'swipe': [before, after, back],
    'leftEvents': left,
    'rightEvents': right,
    'leftPageChanges': left_pages,
    'rightPageChanges': right_pages,
    'leftAttempts': left_attempts,
    'rightAttempts': right_attempts,
    'dismissedAnr': dismissed,
    'canonicalModule': s['canonicalModule'],
}
write_debug('toc125-frozen-swipe.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
ws.close()
