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


def wait_value(code, predicate=lambda x: bool(x), timeout=25, delay=.12):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = ev(code)
        if predicate(last):
            return last
        time.sleep(delay)
    raise RuntimeError(f'wait timeout: {code}; last={last!r}')


def screenshot(name):
    with (OUT / name).open('wb') as fh:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=fh, check=True)


def adb_ui_xml():
    remote = '/sdcard/toc124-window.xml'
    subprocess.run(['adb', 'shell', 'uiautomator', 'dump', remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    proc = subprocess.run(['adb', 'shell', 'cat', remote], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
    return proc.stdout or ''


def tap_wait_button(xml_text):
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return False
    for node in root.iter('node'):
        text = str(node.attrib.get('text', '')).strip().lower()
        if text != 'wait':
            continue
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.attrib.get('bounds', ''))
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        subprocess.run(['adb', 'shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)], check=False)
        return True
    return False


def dismiss_emulator_anr_overlay():
    dismissed = False
    for _ in range(4):
        xml_text = adb_ui_xml()
        if not re.search(r"(?:isn't|is not|not)\s+responding|quickstep", xml_text, re.I):
            return dismissed
        if not tap_wait_button(xml_text):
            subprocess.run(['adb', 'shell', 'input', 'keyevent', '4'], check=False)
        dismissed = True
        time.sleep(.55)
    return dismissed


def page_state():
    return ev("""(()=>{const s=document.querySelector('#reader-reading-view .rd-scroll');const root=document.getElementById('reader-chapter-text');const ps=[...root?.querySelectorAll(':scope > .rd-page')||[]];const cur=root?.querySelector(':scope > .rd-page.rd-page-current,:scope > .rd-page.rd-page-show');const r=(cur||root)?.getBoundingClientRect();return {mode:!!s?.classList.contains('rd-pages-mode'),count:ps.length,index:ps.indexOf(cur),rect:r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null};})()""")


def paragraph_tokens(needles):
    needles_json = json.dumps([str(x).lower() for x in needles], ensure_ascii=False)
    return ev(f"""(()=>{{const needles={needles_json};for(const p of document.querySelectorAll('#reader-chapter-text .reader-paragraph')){{const els=[...p.querySelectorAll('.reader-word[data-word]')];const src=els.map(el=>String(el.dataset.word||el.textContent||'').trim().toLocaleLowerCase('fr-FR'));if(!needles.every(n=>src.includes(n)))continue;return els.map((el,i)=>({{i,s:String(el.dataset.word||el.textContent||'').trim(),lemma:window.readerFrenchLemmaFor?.(el.dataset.word||el.textContent||'')||'',unknown:el.classList.contains('rw-migaku-unknown'),gloss:el.parentElement?.classList.contains('rw-fr-v2-wrap')?(el.parentElement.querySelector(':scope > .rw-fr-v2-gloss')?.textContent?.trim()||''):'',provider:el.parentElement?.dataset?.frProvider||''}}));}}return null;}})()""")


def find_token(tokens, predicate, label):
    if not tokens:
        raise RuntimeError(f'Paragraph missing for {label}')
    for token in tokens:
        if predicate(str(token.get('s', '')).lower(), str(token.get('lemma', '')).lower()):
            return token
    raise RuntimeError(f'Token {label} missing: ' + json.dumps(tokens, ensure_ascii=False))


def install_touch_probe():
    ev("""(()=>{window.__toc124TouchProbe=[];if(!window.__toc124TouchProbeBound){window.__toc124TouchProbeBound=true;for(const type of ['touchstart','touchend','touchcancel'])document.addEventListener(type,e=>{const root=document.getElementById('reader-chapter-text');const t=e.changedTouches?.[0]||e.touches?.[0];window.__toc124TouchProbe.push({type,inside:!!(root&&e.target&&root.contains(e.target)),x:t?.clientX??null,y:t?.clientY??null});},true);}return true;})()""")


def physical_swipe(x1, y1, x2, y2, expected_index, label):
    global_dismissed = False
    for attempt in range(1, 4):
        global_dismissed = dismiss_emulator_anr_overlay() or global_dismissed
        ev('window.__toc124TouchProbe=[]; true')
        subprocess.run([
            'adb', 'shell', 'input', 'touchscreen', 'swipe',
            str(x1), str(y1), str(x2), str(y2), '350'
        ], check=True)
        time.sleep(.95)
        state = page_state()
        events = ev('window.__toc124TouchProbe||[]') or []
        reached_start = any(e.get('type') == 'touchstart' and e.get('inside') for e in events)
        reached_end = any(e.get('type') == 'touchend' and e.get('inside') for e in events)
        if state['index'] == expected_index and reached_start and reached_end:
            return state['index'], events, global_dismissed

        overlay = dismiss_emulator_anr_overlay()
        global_dismissed = overlay or global_dismissed
        # If Android delivered the complete gesture to Reader and Reader still
        # did not turn the page, this is a genuine regression: never retry it
        # away. Retries are only for host/Quickstep gestures that never reached
        # the WebView.
        if reached_start and reached_end:
            raise RuntimeError(
                f'Frozen toc119 {label} swipe reached Reader but failed: '
                f'{state["index"]}, expected {expected_index}; events=' +
                json.dumps(events, ensure_ascii=False)
            )
        if attempt < 3:
            time.sleep(.45)
            continue
        screenshot(f'toc124-swipe-infrastructure-failure-{label}.png')
        raise RuntimeError(
            f'Physical {label} swipe never fully reached Reader after 3 attempts; '
            f'lastIndex={state["index"]}; events=' + json.dumps(events, ensure_ascii=False)
        )


cdp('Runtime.enable')
cdp('Page.enable')
wait_value("document.readyState==='complete'")
lang = ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||document.getElementById('reader-chapter-text')?.dataset?.lang||''")
if lang != 'fr':
    raise RuntimeError(f'Expected French Reader, got {lang!r}')
wait_value("!!window.__readerFrPipelineV2", timeout=8)
wait_value("typeof window.readerLoadFrenchVocabularyData==='function'", timeout=8)

# Deterministic all-Unknown profile through the real persisted profile format.
ev("""(()=>{const owner=localStorage.getItem('an2_reader_active_owner_v1')||'guest';localStorage.setItem(`an2_reader_vocab_estimate_fr_v1::${owner}`,JSON.stringify({language:'fr',version:1,estimate:0,listLength:63548,conservativeKnownCount:0,updatedAt:new Date().toISOString()}));window.readerFrenchRefresh?.('audit-profile',true);return owner;})()""")
wait_value("document.querySelectorAll('#reader-chapter-text .reader-word.rw-migaku-unknown').length>20", timeout=12)
wait_value("document.querySelectorAll('#reader-chapter-text .rw-fr-v2-wrap .rw-fr-v2-gloss').length>10", timeout=12)

first = paragraph_tokens(['tendre', 'joue', 'veux-tu'])
tendre = find_token(first, lambda s, l: s == 'tendre' or l == 'tendre', 'tendre')
joue = find_token(first, lambda s, l: s == 'joue' or l == 'joue', 'joue')
veux = find_token(first, lambda s, l: 'veux' in s or l == 'vouloir', 'veux-tu')
ennuie = find_token(first, lambda s, l: 'ennui' in s or l == 'ennuyer', "t'ennuiera")
if tendre.get('gloss') != 'подставить':
    raise RuntimeError('Tendre la joue context failed: ' + json.dumps(tendre, ensure_ascii=False))
if joue.get('gloss') != 'щёку':
    raise RuntimeError('joue context failed: ' + json.dumps(joue, ensure_ascii=False))
if not re.search(r'хоч', str(veux.get('gloss', '')), re.I):
    raise RuntimeError('veux-tu context failed: ' + json.dumps(veux, ensure_ascii=False))
if not re.search(r'скуч|надоед', str(ennuie.get('gloss', '')), re.I):
    raise RuntimeError("t'ennuiera context failed: " + json.dumps(ennuie, ensure_ascii=False))

second = paragraph_tokens(['tend', 'corde', 'nœud'])
tend = find_token(second, lambda s, l: s == 'tend' or l == 'tendre', 'tend la corde')
if not str(tend.get('gloss', '')).strip():
    raise RuntimeError('contrastive tendre usage has blank gloss: ' + json.dumps(tend, ensure_ascii=False))
if tend.get('gloss') == 'подставить':
    raise RuntimeError('occurrence context leaked globally from tendre la joue: ' + json.dumps(tend, ensure_ascii=False))

courant_tokens = paragraph_tokens(['mec', 'courant', 'présent', 'faut'])
courant = find_token(courant_tokens, lambda s, l: s == 'courant' or l == 'courant', 'au courant')
faut = find_token(courant_tokens, lambda s, l: s == 'faut' or l == 'falloir', 'il faut')
if courant.get('gloss') != 'в курсе':
    raise RuntimeError('au courant context failed: ' + json.dumps(courant, ensure_ascii=False))
if faut.get('gloss') != 'нужно':
    raise RuntimeError('il faut context failed: ' + json.dumps(faut, ensure_ascii=False))

layout = ev("""(()=>({old:document.querySelectorAll('#reader-chapter-text .rw-fr-gloss-wrap').length,v2:document.querySelectorAll('#reader-chapter-text .rw-fr-v2-wrap').length,nested:document.querySelectorAll('#reader-chapter-text .rw-fr-v2-wrap .rw-fr-v2-wrap').length,blank:[...document.querySelectorAll('#reader-chapter-text .reader-word.rw-migaku-unknown')].filter(el=>{const w=el.parentElement;return w?.classList.contains('rw-fr-v2-wrap')&&!String(w.querySelector(':scope > .rw-fr-v2-gloss')?.textContent||'').trim();}).length}))()""")
if layout['old'] != 0 or layout['nested'] != 0:
    raise RuntimeError('French wrapper architecture invalid: ' + json.dumps(layout))

perf = ev("""(async()=>{const t0=performance.now();await window.readerFrenchPipelineV2RefreshNow?.('perf-force',true);const forced=performance.now()-t0;const t1=performance.now();await window.readerFrenchPipelineV2RefreshNow?.('perf-noop',false);const noop=performance.now()-t1;return {forced,noop,wraps:document.querySelectorAll('#reader-chapter-text .rw-fr-v2-wrap').length,nested:document.querySelectorAll('#reader-chapter-text .rw-fr-v2-wrap .rw-fr-v2-wrap').length};})()""")
if perf['forced'] > 900:
    raise RuntimeError('French forced refresh too slow: ' + json.dumps(perf))
if perf['noop'] > 120:
    raise RuntimeError('French no-op refresh too slow: ' + json.dumps(perf))
if perf['nested'] != 0:
    raise RuntimeError('Repeated refresh nested wrappers: ' + json.dumps(perf))
screenshot('toc124-01-context-glosses.png')

# Physical swipe uses the unchanged toc119 path. The touch probe prevents a
# Quickstep/host ANR overlay from being misreported as a Reader regression.
ev("window.readerCloseWordPanel?.(); true")
time.sleep(.2)
dismissed_anr = dismiss_emulator_anr_overlay()
state = None
for _ in range(2):
    state = page_state()
    if state['mode'] and state['count'] >= 2 and state['index'] >= 0:
        break
    ev("window.readerTogglePagesMode?.(); true")
    time.sleep(.8)
state = page_state()
if not state['mode'] or state['count'] < 2 or state['index'] < 0 or not state['rect']:
    raise RuntimeError('Frozen toc119 page mode did not initialize: ' + json.dumps(state, ensure_ascii=False))

install_touch_probe()
dismissed_anr = dismiss_emulator_anr_overlay() or dismissed_anr
dpr = float(ev('window.devicePixelRatio||1'))
r = state['rect']
y_css = max(r['top'] + 70, min(r['bottom'] - 70, (r['top'] + r['bottom']) / 2))
x_right = max(r['left'] + 120, r['right'] - 55)
x_left = min(r['right'] - 120, r['left'] + 55)
y = int(round(y_css * dpr))
x1 = int(round(x_right * dpr))
x2 = int(round(x_left * dpr))
inside = ev(f"""(()=>{{const root=document.getElementById('reader-chapter-text');return [[{x_right},{y_css}],[{(x_right+x_left)/2},{y_css}],[{x_left},{y_css}]].every(([x,y])=>{{const hit=document.elementFromPoint(x,y);return !!(root&&hit&&root.contains(hit));}});}})()""")
if not inside:
    dismissed_anr = dismiss_emulator_anr_overlay() or dismissed_anr
    inside = ev(f"""(()=>{{const root=document.getElementById('reader-chapter-text');return [[{x_right},{y_css}],[{(x_right+x_left)/2},{y_css}],[{x_left},{y_css}]].every(([x,y])=>{{const hit=document.elementFromPoint(x,y);return !!(root&&hit&&root.contains(hit));}});}})()""")
if not inside:
    raise RuntimeError('Physical swipe path not inside Reader after dismissing system overlays')

before = state['index']
after, left_events, left_dismissed = physical_swipe(x1, y, x2, y, before + 1, 'left')
dismissed_anr = left_dismissed or dismissed_anr
wait_value("document.querySelectorAll('#reader-chapter-text .rd-page-current .rw-fr-v2-wrap,#reader-chapter-text .rd-page-show .rw-fr-v2-wrap').length>0", timeout=6)
back, right_events, right_dismissed = physical_swipe(x2, y, x1, y, before, 'right')
dismissed_anr = right_dismissed or dismissed_anr
screenshot('toc124-02-after-swipe-roundtrip.png')

result = {
    'ok': True,
    'lang': lang,
    'context': {
        'tendre': tendre,
        'joue': joue,
        'veux': veux,
        'ennuie': ennuie,
        'contrastTend': tend,
        'courant': courant,
        'faut': faut,
    },
    'layout': layout,
    'perfMs': perf,
    'pages': state['count'],
    'swipe': [before, after, back],
    'leftTouchEvents': len(left_events),
    'rightTouchEvents': len(right_events),
    'dismissedEmulatorAnr': dismissed_anr,
    'core': 'frozen toc119 navigation',
}
(OUT / 'toc124-fr-pipeline-v2-live-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
ws.close()
