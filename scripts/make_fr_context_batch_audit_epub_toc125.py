#!/usr/bin/env python3
from pathlib import Path
import shutil
import zipfile

base = Path('runtime-audit')
root = base / 'epub-src-toc125'
shutil.rmtree(root, ignore_errors=True)
(root / 'META-INF').mkdir(parents=True, exist_ok=True)
(root / 'OEBPS').mkdir(parents=True, exist_ok=True)
(root / 'mimetype').write_text('application/epub+zip', encoding='utf-8')
(root / 'META-INF/container.xml').write_text(
    '<?xml version="1.0"?>\n'
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
    '</rootfiles></container>',
    encoding='utf-8',
)
(root / 'OEBPS/content.opf').write_text('''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Audit contexte français toc125</dc:title><dc:creator>Reader AI fixture</dc:creator>
<dc:language>fr</dc:language><dc:identifier id="bookid">toc125-fr-context-batch-audit</dc:identifier>
</metadata><manifest><item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref id="ch1"/></spine></package>''', encoding='utf-8')

# First two paragraphs reproduce the real failure shown on the user's device.
# Additional paragraphs keep the older context/morphology regressions alive.
passages = [
    "Moi là tout de suite, je me hâte de te dire que personnellement je n'en ai pas tué le moindre. Je le précise car je sais que cela t'ennuiera, t'ennuie ! tu en serais bien ennuyée, ma petite Maman.",
    "Tout de même je répète que c'est une chose à envisager sans faiblesse, si un jour nous sommes contraints à user la force pour la défense de notre cause.",
    "Tendre la joue, c'est bien joli, mais que veux-tu faire ?",
    "Il tend la corde et vérifie le nœud.",
    "Treuffais restait dans sa chambre, fumant sans arrêt; la pièce sentait mauvais.",
    "Le mec est au courant, à présent. Il faut voir ce qu'il a dans le ventre.",
]
body = '\n'.join(f'<p>{p}</p>' for p in passages)
(root / 'OEBPS/chapter.xhtml').write_text(
    f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr"><head><title>Audit contexte français toc125</title></head><body>{body}</body></html>''',
    encoding='utf-8',
)
out = base / 'fr-context-toc125.epub'
with zipfile.ZipFile(out, 'w') as zf:
    zf.write(root / 'mimetype', 'mimetype', compress_type=zipfile.ZIP_STORED)
    for path in [root / 'META-INF/container.xml', root / 'OEBPS/content.opf', root / 'OEBPS/chapter.xhtml']:
        zf.write(path, path.relative_to(root).as_posix(), compress_type=zipfile.ZIP_DEFLATED)
print(out, out.stat().st_size)
