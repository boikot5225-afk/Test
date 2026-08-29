from pathlib import Path

p = Path('android/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java')
s = p.read_text()

field = '    private ChineseResourceBridge chineseResourceBridge;\n'
patch = field + (
    '    private ChineseOfflineTranslateBridge chineseOfflineTranslateBridge;\n'
    '    private EnglishResidualTranslateBridge englishResidualTranslateBridge;\n'
    '    private EnglishContextTranslateBridge englishContextTranslateBridge;\n'
)
assert s.count(field) == 1
s = s.replace(field, patch, 1)

anchor = '        webView.addJavascriptInterface(chineseResourceBridge, "ReaderChineseResources");\n'
patch = anchor + (
    '\n        chineseOfflineTranslateBridge = new ChineseOfflineTranslateBridge(this, webView);\n'
    '        webView.addJavascriptInterface(chineseOfflineTranslateBridge, "ReaderChineseTranslate");\n'
    '        englishResidualTranslateBridge = new EnglishResidualTranslateBridge(this, webView);\n'
    '        webView.addJavascriptInterface(englishResidualTranslateBridge, "ReaderEnglishResidualTranslate");\n'
    '        englishContextTranslateBridge = new EnglishContextTranslateBridge(this, webView);\n'
    '        webView.addJavascriptInterface(englishContextTranslateBridge, "ReaderEnglishContextTranslate");\n'
)
assert s.count(anchor) == 1
s = s.replace(anchor, patch, 1)

destroy = (
    '        if (chineseResourceBridge != null) {\n'
    '            chineseResourceBridge.shutdown();\n'
    '            chineseResourceBridge = null;\n'
    '        }\n'
)
patch = destroy + (
    '        if (chineseOfflineTranslateBridge != null) {\n'
    '            chineseOfflineTranslateBridge.shutdown();\n'
    '            chineseOfflineTranslateBridge = null;\n'
    '        }\n'
    '        if (englishResidualTranslateBridge != null) {\n'
    '            englishResidualTranslateBridge.shutdown();\n'
    '            englishResidualTranslateBridge = null;\n'
    '        }\n'
    '        if (englishContextTranslateBridge != null) {\n'
    '            englishContextTranslateBridge.shutdown();\n'
    '            englishContextTranslateBridge = null;\n'
    '        }\n'
)
assert s.count(destroy) == 1
s = s.replace(destroy, patch, 1)
p.write_text(s)
print('toc104 native translation bridges wired')
