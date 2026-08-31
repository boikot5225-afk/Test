#!/usr/bin/env python3
from pathlib import Path
import shutil
import zipfile

base = Path('runtime-audit')
root = base / 'epub-src-toc123'
shutil.rmtree(root, ignore_errors=True)
(root / 'META-INF').mkdir(parents=True, exist_ok=True)
(root / 'OEBPS').mkdir(parents=True, exist_ok=True)
(root / 'mimetype').write_text('application/epub+zip', encoding='utf-8')
(root / 'META-INF/container.xml').write_text('''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>''', encoding='utf-8')
(root / 'OEBPS/content.opf').write_text('''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Nada — toc123 isolated audit</dc:title><dc:creator>Jean-Patrick Manchette</dc:creator><dc:language>fr</dc:language><dc:identifier id="bookid">nada-toc123-isolated-audit</dc:identifier></metadata><manifest><item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref id="ch1"/></spine></package>''', encoding='utf-8')
passages = [
    "Elle rapportait tout à la ferme et rangeait les provisions.",
    "Le jeudi, personne ne fit rien de spécial. Treuffais restait dans sa chambre, fumant sans arrêt; la pièce sentait mauvais.",
    "Il n'arrivait pas à lire. Il essaya une fois d'appeler Buenaventura, mais raccrocha avant de finir de composer le numéro.",
    "Personne n’en avait. La cloche sonna. Du geste, Treuffais voulut futilement s’opposer au vacarme.",
    "Treuffais était allongé dans sa chambre, il fumait sans arrêt, la pièce puait le tabac froid.",
    "Il se rongeait les ongles. Il essayait de lire et n’y parvenait pas.",
    "Il se leva une fois pour appeler Buenaventura au téléphone, mais il raccrocha avant d’avoir fini de former le numéro de l’hôtel Longuevache.",
    "L’alcoolique demeura immobile, silencieux, fumant, ne faisant rien, les mains tremblantes.",
    "Il trouvait soudain la pièce dégueulasse, étriquée, puante et mal foutue.",
    "Buenaventura s’avança et fut soulagé d’apercevoir l’ivrogne au fond de la pièce.",
    "Treuffais raccrocha et ouvrit son courrier.",
    "Le Catalan raccrocha et se retourna vers Épaulard.",
    "Tout ça, je m’en branle, ajouta Treuffais.",
    "Le mec est au courant, à présent. Faut voir ce qu’il a dans le ventre.",
    "Il avait la chair de poule.",
]
body = '\n'.join(f'<p>{p}</p>' for p in passages)
(root / 'OEBPS/chapter.xhtml').write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr"><head><title>Nada audit</title></head><body><h1>Nada audit</h1>{body}</body></html>''', encoding='utf-8')
out = base / 'nada-toc123.epub'
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, 'w') as zf:
    zf.write(root / 'mimetype', 'mimetype', compress_type=zipfile.ZIP_STORED)
    for path in [root / 'META-INF/container.xml', root / 'OEBPS/content.opf', root / 'OEBPS/chapter.xhtml']:
        zf.write(path, path.relative_to(root).as_posix(), compress_type=zipfile.ZIP_DEFLATED)
print(out, out.stat().st_size)
