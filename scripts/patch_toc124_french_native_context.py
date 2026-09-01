#!/usr/bin/env python3
from pathlib import Path

p = Path('android/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java')
s = p.read_text(encoding='utf-8')

field = '    private FrenchContextTranslateBridge frenchContextTranslateBridge;\n'
if field not in s:
    anchor = '    private EnglishContextTranslateBridge englishContextTranslateBridge;\n'
    if s.count(anchor) != 1:
        raise SystemExit(f'French native field anchor count={s.count(anchor)}')
    s = s.replace(anchor, anchor + field, 1)

wire = '''        frenchContextTranslateBridge = new FrenchContextTranslateBridge(this, webView);\n        webView.addJavascriptInterface(frenchContextTranslateBridge, "ReaderFrenchContextTranslate");\n'''
if wire not in s:
    anchor = '''        englishContextTranslateBridge = new EnglishContextTranslateBridge(this, webView);\n        webView.addJavascriptInterface(englishContextTranslateBridge, "ReaderEnglishContextTranslate");\n'''
    if s.count(anchor) != 1:
        raise SystemExit(f'French native wire anchor count={s.count(anchor)}')
    s = s.replace(anchor, anchor + wire, 1)

shutdown = '''        if (frenchContextTranslateBridge != null) {\n            frenchContextTranslateBridge.shutdown();\n            frenchContextTranslateBridge = null;\n        }\n'''
if shutdown not in s:
    anchor = '''        if (englishContextTranslateBridge != null) {\n            englishContextTranslateBridge.shutdown();\n            englishContextTranslateBridge = null;\n        }\n'''
    if s.count(anchor) != 1:
        raise SystemExit(f'French native shutdown anchor count={s.count(anchor)}')
    s = s.replace(anchor, anchor + shutdown, 1)

p.write_text(s, encoding='utf-8')
print('toc124 native French context bridge wired')
