#!/usr/bin/env python3
import json
import pathlib
import time
import requests
import websocket

OUT = pathlib.Path('runtime-audit')
OUT.mkdir(exist_ok=True)
pages = []
for _ in range(100):
    try:
        pages = requests.get('http://127.0.0.1:9222/json/list', timeout=2).json()
    except Exception:
        pages = []
    if pages:
        break
    time.sleep(.2)
if not pages:
    raise SystemExit('No debuggable Reader AI WebView')
page = next((p for p in pages if 'appassets.androidplatform.net' in p.get('url', '')), pages[0])
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=20, suppress_origin=True)
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

def wait(code, predicate=lambda x: bool(x), timeout=18):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = ev(code)
        if predicate(last):
            return last
        time.sleep(.15)
    raise RuntimeError(f'wait timeout: {code}; last={last!r}')

cdp('Runtime.enable')
wait("document.readyState==='complete'")
if ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||''") != 'fr':
    raise RuntimeError('quality gate is not in French reader')
wait("!!window.__readerFrContextRefineV2", timeout=8)
bridge = ev("!!window.ReaderFrenchContextTranslate && typeof window.ReaderFrenchContextTranslate.translate==='function'")
if not bridge:
    raise RuntimeError('native ReaderFrenchContextTranslate bridge is missing')

ev("window.readerFrenchQualityRefresh?.('quality-gate'); true")

state_js = """(()=>{const root=document.getElementById('reader-chapter-text');const unknown=[...root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')];const rows=unknown.map(el=>{const wrap=el.parentElement?.classList.contains('rw-fr-v2-wrap')?el.parentElement:null;return {s:String(el.dataset.word||el.textContent||'').trim(),gloss:String(wrap?.querySelector(':scope > .rw-fr-v2-gloss')?.textContent||'').trim(),provider:String(wrap?.dataset.frProvider||''),wrapped:!!wrap};});return {wrapped:rows.filter(x=>x.wrapped).length,blank:rows.filter(x=>x.wrapped&&!x.gloss).length,pending:rows.filter(x=>x.provider==='context-pending').length,blankWords:rows.filter(x=>x.wrapped&&!x.gloss).map(x=>x.s),pendingWords:rows.filter(x=>x.provider==='context-pending').map(x=>x.s)};})()"""
quality = wait(state_js, lambda x: isinstance(x, dict) and x.get('wrapped', 0) > 20 and x.get('blank') == 0 and x.get('pending') == 0, timeout=20)

def token_in_paragraph(needle_words, target):
    needle = json.dumps([w.lower() for w in needle_words], ensure_ascii=False)
    target_json = json.dumps(target.lower(), ensure_ascii=False)
    return ev(f"""(()=>{{const needle={needle};const ps=[...document.querySelectorAll('#reader-chapter-text .reader-paragraph')];for(const p of ps){{const words=[...p.querySelectorAll('.reader-word[data-word]')];const src=words.map(el=>String(el.dataset.word||el.textContent||'').trim().toLocaleLowerCase('fr-FR'));let contains=true;for(const n of needle)if(!src.includes(n))contains=false;if(!contains)continue;const el=words.find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==={target_json});if(!el)continue;const wrap=el.parentElement?.classList.contains('rw-fr-v2-wrap')?el.parentElement:null;return {{surface:String(el.dataset.word||el.textContent||'').trim(),gloss:String(wrap?.querySelector(':scope > .rw-fr-v2-gloss')?.textContent||'').trim(),provider:String(wrap?.dataset.frProvider||'')}};}}return null;}})()""")

mec = token_in_paragraph(['mec', 'courant', 'présent'], 'mec')
present = token_in_paragraph(['mec', 'courant', 'présent'], 'présent')
quil = token_in_paragraph(['faut', "qu'il", 'ventre'], "qu'il")
joli = token_in_paragraph(['tendre', 'joue', 'joli'], 'joli')

if not mec or mec.get('gloss') != 'парень':
    raise RuntimeError('mec quality regression: ' + json.dumps(mec, ensure_ascii=False))
if not present or present.get('gloss') not in ('сейчас', 'теперь'):
    raise RuntimeError('à présent quality regression: ' + json.dumps(present, ensure_ascii=False))
if not quil or quil.get('gloss') != 'что':
    raise RuntimeError("qu'il quality regression: " + json.dumps(quil, ensure_ascii=False))
if not joli or joli.get('gloss') != 'милый':
    raise RuntimeError('joli quality regression: ' + json.dumps(joli, ensure_ascii=False))

result = {
    'ok': True,
    'blankUnknown': quality['blank'],
    'pendingUnknown': quality['pending'],
    'nativeContextBridge': bridge,
    'qualityCases': {'mec': mec, 'present': present, 'quil': quil, 'joli': joli},
}
(OUT / 'toc124-fr-quality-gate.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
ws.close()
