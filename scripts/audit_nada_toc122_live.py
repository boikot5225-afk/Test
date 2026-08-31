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
    time.sleep(.4)
if not pages:
    raise SystemExit('No debuggable WebView page')
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


def click_word(word):
    q = json.dumps(word.lower(), ensure_ascii=False)
    return ev(f"(()=>{{const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')==={q});if(!e)return 'MISSING';e.click();return e.dataset.word}})()")


def mark_unknown(word):
    if click_word(word) == 'MISSING':
        return False
    q = json.dumps(word.lower(), ensure_ascii=False)
    wait(f"document.querySelector('#reader-word-title')?.textContent?.toLocaleLowerCase('fr-FR')==={q}", 10)
    ev("document.querySelector('#reader-fr-unknown-btn')?.click();true")
    time.sleep(.45)
    return True


cdp('Runtime.enable')
cdp('Page.enable')
audit = {'page': page, 'steps': {}, 'bugs': []}
wait("document.readyState==='complete'")
audit['steps']['initial'] = ev("document.body.innerText.slice(0,1800)")

# Cold clean install starts on auth. Enter the supported guest mode, then allow
# the ACTION_VIEW import queued by MainActivity to continue.
if not ev("document.getElementById('main-app')?.style.display!=='none'"):
    clicked = ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&/Продолжить без регистрации/i.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    audit['steps']['guest_click'] = clicked
    if not clicked:
        raise RuntimeError('Guest button not found')
wait("document.getElementById('main-app')?.style.display!=='none'", 20)

reading_ready = "(()=>{const v=document.querySelector('#reader-reading-view');return !!(v&&getComputedStyle(v).display!=='none'&&document.querySelectorAll('#reader-chapter-text .reader-word').length>30)})()"
# The native import may first populate the import preview and require Save.
end = time.time() + 30
while time.time() < end and not ev(reading_ready):
    status = ev("document.querySelector('#reader-import-status')?.textContent||''") or ''
    if 'EPUB загружен' in status:
        ev("(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent);const b=bs.find(x=>/^Сохранить$/i.test((x.textContent||'').trim()))||bs.find(x=>/Сохранить/.test(x.textContent||''));if(!b)return false;b.click();return true})()")
    time.sleep(.5)

native_status = ev("document.querySelector('#reader-import-status')?.textContent||''") or ''
audit['steps']['native_action_view_status'] = native_status
audit['steps']['native_reading_ready'] = bool(ev(reading_ready))
if not audit['steps']['native_reading_ready']:
    audit['bugs'].append('native ACTION_VIEW EPUB did not reach the reader')
    raise RuntimeError('native ACTION_VIEW EPUB import failed: ' + native_status)

wait(reading_ready, 20)
time.sleep(2)
ev("window.readerSetFrUnknownGlossMode?.('unknown'); true")
audit['steps']['reader_lang'] = ev("document.getElementById('reader-reading-view')?.dataset?.readerLang||document.getElementById('reader-chapter-text')?.dataset?.lang||''")
audit['steps']['reading_text'] = ev("document.querySelector('#reader-chapter-text')?.innerText?.slice(0,5000)||''")
audit['steps']['word_count'] = ev("document.querySelectorAll('#reader-chapter-text .reader-word').length")
audit['steps']['globals'] = ev("({lemma:typeof window.readerFrenchLemmaFor,lex:typeof window.readerFrenchLexicalAnalysisFor,proper:typeof window.readerFrenchIsProperWord,knowledge:typeof window.readerFrenchVocabularyKnowledgeFor})")

wait("typeof window.readerFrenchLemmaFor==='function' && window.readerFrenchLemmaFor('était')==='être'", 30)
# Ambiguous standalone forms must stay standalone until context explicitly
# resolves them. Unambiguous inflections still normalize normally.
words = ['fumant','raccrocha','était','fumait','puait','parvenait','leva','appeler','fini','composer','former','avait','courant','personne','rapportait','rangeait','sentait']
audit['lemmas'] = ev("(()=>{const ws=" + json.dumps(words, ensure_ascii=False) + ";return Object.fromEntries(ws.map(w=>[w,window.readerFrenchLemmaFor?.(w)||null]))})()")
for word, expected in {'courant':'courant','personne':'personne','fini':'fini','fumant':'fumant','était':'être','fumait':'fumer','raccrocha':'raccrocher','sentait':'sentir'}.items():
    if audit['lemmas'].get(word) != expected:
        audit['bugs'].append(f'lemma regression: {word} -> {audit["lemmas"].get(word)} != {expected}')

lex = {}
for word in ['fumant','raccrocha','composer','former','pièce','arrêt','mec','courant','poule','fond','foutue','personne','rapportait','rangeait','sentait','mauvais']:
    lex[word] = ev(f"(async()=>await window.readerFrenchLexicalAnalysisFor?.({json.dumps(word,ensure_ascii=False)})||null)()")
audit['lexical'] = lex
for word, expected in {'courant':'courant','personne':'personne'}.items():
    if (lex.get(word) or {}).get('lemma') != expected:
        audit['bugs'].append(f'lexical owner corrupted standalone {word}: {(lex.get(word) or {}).get("lemma")}')

# Names must be neutral learning UI without requiring a tap/AI call.
audit['proper_names'] = ev("(()=>{const ws=['Treuffais','Buenaventura','Épaulard','Catalan','Longuevache'];return Object.fromEntries(ws.map(w=>{const es=[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return [w,{proper:window.readerFrenchIsProperWord?.(w),knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),classes:es.map(e=>e.className)}]}))})()")
for name, item in audit['proper_names'].items():
    if item.get('classes') and not item.get('proper'):
        audit['bugs'].append(f'proper name not recognized locally: {name}')
    for classes in item.get('classes') or []:
        if any(cls in classes.split() for cls in ['rw-new','rw-looked','rw-learning','rw-problem','rw-migaku-unknown']):
            audit['bugs'].append(f'proper name still painted as learning vocabulary: {name} -> {classes}')

# Reproduce the user's exact manual Unknown sequence.
mark_unknown('fumant')
audit['fumant_first'] = ev("(()=>{const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLowerCase()==='fumant');return {class:e?.className||'',manual:e?.dataset?.readerManualKnowledge||'',knowledge:window.readerFrenchVocabularyKnowledgeFor?.('fumant')}})()")
mark_unknown('pièce')
time.sleep(1.0)
audit['after_second_unknown'] = ev("(()=>{function s(w){const e=[...document.querySelectorAll('.reader-word[data-word]')].find(x=>(x.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return {class:e?.className||'',manual:e?.dataset?.readerManualKnowledge||'',knowledge:window.readerFrenchVocabularyKnowledgeFor?.(w),gloss:e?.parentElement?.querySelector('.rw-fr-gloss-text')?.textContent||''}}return {fumant:s('fumant'),piece:s('pièce')}})()")
fum = audit['after_second_unknown']['fumant']
if fum.get('manual') != 'unknown' or 'rw-migaku-unknown' not in fum.get('class',''):
    audit['bugs'].append('manual Unknown disappeared after selecting/marking another word')

# Inspect the actual store for toc121-style cross-word pollution.
audit['fr_state'] = ev("(()=>{const s=window.an2ReaderWordStateSnapshot?.()||{};return Object.fromEntries(Object.entries(s).filter(([k,v])=>k.startsWith('fr:')&&(k.includes('fum')||k.includes('pièce')||k.includes('piece'))))})()")
for key, state in audit['fr_state'].items():
    if state.get('variants'):
        audit['bugs'].append(f'French state still carries merged variants: {key} -> {state.get("variants")}')
    for ctx in (state.get('clickContexts') or {}).values():
        form = str((ctx or {}).get('form') or '').lower()
        if 'fum' in key and 'pièce' in form:
            audit['bugs'].append(f'pièce click leaked into fumer/fumant state: {key}')

# Force several context-sensitive words Unknown. v3 should replace raw WikDict
# sense #1 with the translation of the exact marked target from ML Kit.
for word in ['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais']:
    mark_unknown(word)

# Let the offline model download/queue drain. Stop early once most targets have a
# v3 provider so the test doesn't spend time sleeping unnecessarily.
for _ in range(90):
    providers = ev("(()=>[...document.querySelectorAll('.rw-fr-gloss-wrap')].map(w=>w.dataset.frContextProvider||'').filter(Boolean))()") or []
    if sum(1 for p in providers if p in ['mlkit-target-marked','mlkit-target-fallback','deepseek-context']) >= 6:
        break
    time.sleep(.5)

audit['context_words'] = ev("(()=>{const ws=['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais'];return Object.fromEntries(ws.map(w=>{const es=[...document.querySelectorAll('.reader-word[data-word]')].filter(e=>(e.dataset.word||'').toLocaleLowerCase('fr-FR')===w.toLocaleLowerCase('fr-FR'));return [w,es.map(e=>({class:e.className,gloss:e.parentElement?.querySelector('.rw-fr-gloss-text')?.textContent||'',provider:e.parentElement?.dataset?.frContextProvider||''}))]}))})()")

def first_gloss(word):
    rows = audit['context_words'].get(word) or []
    return (rows[0].get('gloss') if rows else '') or ''

checks = {
    'arrêt': (lambda g: 'без ' in g.lower(), 'sans arrêt did not keep phrase/preposition'),
    'courant': (lambda g: ('курс' in g.lower()) and ('бег' not in g.lower()), 'au courant is still treated as courir/running'),
    'mec': (lambda g: 'матрикс' not in g.lower(), 'mec still exposes bad WikDict first sense «матрикс»'),
    'composer': (lambda g: not any(x in g.lower() for x in ['сложить','составить композицию']), 'composer le numéro still uses non-phone dictionary sense'),
    'former': (lambda g: 'образовать' not in g.lower(), 'former le numéro still uses generic «образовать»'),
}
for word, (pred, message) in checks.items():
    g = first_gloss(word)
    if not g or not pred(g):
        audit['bugs'].append(f'{message}: {g!r}')

# No malformed dictionary fragments and no physical overlap of inline glosses.
audit['all_glosses'] = ev("(()=>[...document.querySelectorAll('.rw-fr-gloss-text')].map(e=>e.textContent||'').filter(Boolean))()")
for text in audit['all_glosses']:
    if '[' in text or ']' in text:
        audit['bugs'].append('broken bracket leaked into inline gloss: ' + text)
audit['layout'] = ev("(()=>{const gs=[...document.querySelectorAll('.rw-fr-gloss-text')].filter(e=>getComputedStyle(e).display!=='none');let overlaps=[];for(let i=0;i<gs.length;i++){const a=gs[i].getBoundingClientRect();for(let j=i+1;j<gs.length;j++){const b=gs[j].getBoundingClientRect();const x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(x>2&&y>2)overlaps.push({a:gs[i].textContent,b:gs[j].textContent,x,y});}}return {visibleGlosses:gs.length,overlaps:overlaps.slice(0,50)}})()")
if audit['layout'].get('overlaps'):
    audit['bugs'].append(f'inline gloss overlap: {audit["layout"]["overlaps"][:3]}')

OUT.joinpath('audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(audit, ensure_ascii=False, indent=2))
ws.close()
if audit['bugs']:
    raise SystemExit('toc122 live audit bugs: ' + ' | '.join(audit['bugs']))
