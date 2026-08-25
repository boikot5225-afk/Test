from pathlib import Path

p=Path('js/reader/zh-stable-slots.js')
s=p.read_text('utf-8')

# Give every Chinese token a deterministic width BEFORE page measurement.
# Width depends only on Hanzi count, never Known/Unknown or asynchronously loaded hints.
old="""  normalizePlaceholder(wrap);\n  return wrap;\n}\n"""
new="""  normalizePlaceholder(wrap);\n\n  const rawWord = String(word.dataset.word || word.textContent || '');\n  const hanziCount = Math.max(1, Array.from(rawWord).filter(ch => /[㐀-鿿]/.test(ch)).length);\n  const slotWidthEm = hanziCount <= 1 ? 1.38\n    : hanziCount === 2 ? 2.12\n    : hanziCount === 3 ? 3.02\n    : hanziCount === 4 ? 3.95\n    : Math.min(6.2, hanziCount * .98);\n  wrap.style.setProperty('--rw-zh-slot-width', `${slotWidthEm}em`);\n  return wrap;\n}\n"""
assert old in s
s=s.replace(old,new,1)

s=s.replace("""      grid-template-columns:max-content !important;\n""","""      grid-template-columns:minmax(0,var(--rw-zh-slot-width,1.38em)) !important;\n""",1)
s=s.replace("""      width:auto !important;\n      min-width:0 !important;\n      max-width:none !important;\n""","""      width:var(--rw-zh-slot-width,1.38em) !important;\n      min-width:var(--rw-zh-slot-width,1.38em) !important;\n      max-width:var(--rw-zh-slot-width,1.38em) !important;\n""",1)

old_label="""      width:max-content !important;\n      min-width:0 !important;\n      max-width:6.4em !important;\n      margin:0 !important;\n      padding:0 !important;\n      overflow:hidden !important;\n"""
new_label="""      width:calc(100% - .10em) !important;\n      min-width:0 !important;\n      max-width:calc(100% - .10em) !important;\n      margin:0 !important;\n      padding:0 .05em !important;\n      box-sizing:border-box !important;\n      overflow:hidden !important;\n"""
assert old_label in s
s=s.replace(old_label,new_label,1)

# Extra microscopic breathing room so two clipped labels never visually concatenate.
s=s.replace("margin:0 .055em !important;","margin:0 .075em !important;",1)

# Bump stylesheet identity and comment.
s=s.replace("reader-zh-stable-slots-v1","reader-zh-stable-slots-v2",1)
s=s.replace("// Fixed Chinese annotation geometry for toc44.","// Fixed Chinese annotation geometry for toc45.",1)
p.write_text(s,'utf-8')

p=Path('js/reader/interactions-runtime.js')
s=p.read_text('utf-8')
assert "import './zh-stable-slots.js?v=1';" in s
s=s.replace("import './zh-stable-slots.js?v=1';","import './zh-stable-slots.js?v=2';",1)
p.write_text(s,'utf-8')

p=Path('android/app/build.gradle')
s=p.read_text('utf-8')
assert 'versionCode 64' in s and "versionName '77.42-toc44'" in s
s=s.replace('versionCode 64','versionCode 65',1).replace("versionName '77.42-toc44'","versionName '77.42-toc45'",1)
p.write_text(s,'utf-8')
