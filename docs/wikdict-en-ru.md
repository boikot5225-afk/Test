# Bundled English → Russian dictionary

Reader AI builds a compact English → Russian lookup database for inline Unknown-word glosses from the WikDict `en-ru.sqlite3` dataset.

- Source project: WikDict — https://www.wikdict.com/
- Source snapshot: `2_2026-06/en-ru.sqlite3`
- Upstream data: Wiktionary via DBnary
- License: Creative Commons Attribution-ShareAlike (CC BY-SA)
- Only entries relevant to Reader AI's English frequency/morphology lists are retained in the APK.

The generated SQLite file is a build artifact and is not committed to the repository. `scripts/build_en_ru_wikdict_core.py` creates it during the Android build.
