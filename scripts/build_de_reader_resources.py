#!/usr/bin/env python3
"""Build compact German Reader assets from open datasets.

Frequency and forms:
  wordfreq (Apache-2.0) — corpus frequencies for German surfaces.
  simplemma (MIT) — surface -> lemma for verbs, adjectives, function words.
  german-nouns (MIT code, Wiktionary data) — declension tables for ~100k
  German nouns, used as the authority on everything nominal.
Translations:
  WikDict/DBnary (CC BY-SA) — German -> Russian.

Why not wordhoard, which the Spanish builder uses. It ships one CSV per
language and German is not among the ones this repo can rely on; more to the
point, it is a single zip on a release page, while these three are pip
packages that pin and verify themselves.

German-specific care:

Case. In German the capital letter is the only mark of a noun, and wordfreq
lowercases its whole list, so that mark is gone from the frequency data. Asked
about a lowercase noun, simplemma invents a verb out of it: on real data
lampe -> lampen, tisch -> tischen, zimmer -> zimmern, haus -> hausen. None of
those words exist, and a vocabulary list full of them is not a German
vocabulary list.

The case cannot be recovered from a lowercased list — habe is the verb in
"ich habe" and the noun in "meine Habe", and nothing in the frequency data
tells them apart. The reader, however, sees the real page, where the noun is
capitalised. So the build ships two maps instead of guessing:

  de_noun_lemma.tsv    form -> noun lemma, from the Wiktionary declension
                       tables. For a capitalised token: Stunden -> Stunde.
  de_vocab_lemma.tsv   form -> lemma from simplemma, for a lowercase token:
                       habe -> haben, ging -> gehen, gute -> gut.

Each map is asked only about the words its source actually knows, and the
ranked vocabulary admits a simplemma lemma only when the declension tables do
not know it as a form of some noun — which is what keeps lampen and tischen
out of the list.

Compounds. German builds nouns by gluing them together, and no dictionary can
list them all: Haustür is in Wiktionary, Küchentischlampe is not, and both are
ordinary words. The frequency file therefore doubles as the vocabulary the
reader splits against at runtime, and this script checks that splitting is
possible at all before shipping — a resource that cannot resolve a compound
out of its own nouns is not a German resource.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import urllib.request
from pathlib import Path

# Версии закреплены: список слов и таблицы склонений — это данные, и молчаливое
# обновление источника меняет словарь под ногами у читателя.
REQUIREMENTS = ("wordfreq==3.1.1", "simplemma==2.0.0", "german-nouns==1.2.5")

WIKDICT_URL = "https://download.wikdict.com/dictionaries/sqlite/2_2026-06/de-ru.sqlite3"
USER_AGENT = "Reader-AI-German-resource-builder/1.0"

# Сколько поверхностных форм берём у wordfreq. Дальше начинается длинный хвост
# из опечаток и имён собственных, а разбор каждой формы не бесплатен.
SURFACE_LIMIT = 200_000
# Ниже этих объёмов источник сменил форму, и ранжирование не то, чем его
# считает словарный тест.
MIN_LEMMAS = 40_000
MIN_DICT_ENTRIES = 8_000
# Немецких существительных в Викисловаре больше ста тысяч, и на нашем списке
# форм они дают десятки тысяч попаданий. Резкое падение означает, что пакет
# подменили заглушкой.
MIN_NOUNS = 80_000
MIN_NOUN_FORMS = 30_000
# Сколько лемм уезжает на телефон. Весь список — это 142 тысячи слов и пять
# мегабайт, из которых последние сто тысяч покрывают полтора процента живого
# текста: замерено по частотам wordfreq на его же списке форм. Шестьдесят тысяч
# дают 97% текста и 2.9 МБ — столько же, сколько английский слой, а остальное
# добирается разбором составных слов, части которых и так частотные.
VOCAB_LIMIT = 60_000

# Однобуквенных слов в немецком нет: одиночные буквы в частотном списке —
# это обрывки сокращений, и в словаре им делать нечего.
WORD_RE = re.compile(r"^[a-zäöüß][a-zäöüß'’-]+$")
GENUS = ("m", "f", "n")
# Пометки Викисловаря для имён: имя, фамилия, топоним, название улицы. Слово,
# у которого есть только они, — имя собственное; слово, у которого есть и
# обычное значение (Hans — это ещё и разговорное «парень»), именем не считаем.
#
# Eigenname в этот список не входит намеренно. Немецкий Викисловарь ставит его
# солнцу: Sonne — «Eigenname, Substantiv», потому что солнце одно. Со списком,
# считающим эту пометку именем, солнце выпадало из существительных вместе со
# своим склонением, и Sonnenschein раскладывался на глагол sonnen «загорать» и
# Schein. Настоящее имя отличается не пометкой, а пустой таблицей склонений:
# у Berlin, Maria, Schmidt форм нет вовсе, а у Sonne, Deutschland и Rhein
# таблица полная, и они ведут себя в тексте как обычные слова.
NAME_TAGS = ("Vorname", "Nachname", "Toponym", "Straßenname", "Eigenname")

# Соединительные элементы немецких составных слов: Arbeit+s+zimmer,
# Sonne+n+schein, Kind+er+garten.
FUGEN = ("", "s", "es", "n", "en", "er", "e")
# Короче этого «часть» составного слова — обычно не часть, а совпадение. Три, а
# не четыре: главное слово немецкого композита сплошь и рядом короткое — Tür,
# Bad, Uhr, Weg, Tag, Hof, — и на четырёх Haustür не раскладывается вовсе.
MIN_PART = 3


def norm(value: str) -> str:
    return (
        (value or "")
        .strip()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("‐", "-")
        .replace("‑", "-")
        .lower()
    )


def clean_ru(value: str) -> str:
    value = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value or "")
    return " ".join(value.split()).strip()


def download(url: str, path: Path, *, sha256: str = "", min_size: int = 1) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size >= min_size:
        if not sha256 or hashlib.sha256(path.read_bytes()).hexdigest() == sha256:
            return path
        path.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as src, path.open("wb") as dst:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            dst.write(chunk)
    if path.stat().st_size < min_size:
        raise RuntimeError(f"download unexpectedly small: {url} -> {path.stat().st_size} bytes")
    if sha256:
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != sha256:
            raise RuntimeError(f"sha256 mismatch for {url}: {actual} != {sha256}")
    return path


def install_requirements():
    """Ставит ровно те пакеты, на которых собран словарь."""
    import subprocess
    import sys

    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", *REQUIREMENTS]
    )


def read_surfaces():
    """Поверхностные формы немецкого в порядке частотности."""
    try:
        import wordfreq
    except ImportError as exc:
        raise RuntimeError(f"{exc}. Нужен пакет wordfreq: pip install wordfreq") from exc
    if "de" not in wordfreq.available_languages():
        raise RuntimeError("в этой сборке wordfreq нет немецкого")
    surfaces = []
    for surface in wordfreq.top_n_list("de", SURFACE_LIMIT):
        value = norm(surface)
        if value and WORD_RE.match(value):
            surfaces.append(value)
    if len(surfaces) < MIN_LEMMAS:
        raise RuntimeError(f"немецкий список wordfreq неожиданно мал: {len(surfaces)}")
    return surfaces


def fold(value: str) -> str:
    """ß -> ss, как это делает wordfreq.

    Частотный список приведён casefold-ом, а он превращает ß в ss: ни Straße,
    ни Fußball в нём не найти, только strasse и fussball. Правильное написание
    знают таблицы Викисловаря, а корпусный порядок — wordfreq, и склеиваются
    они через это преобразование.
    """
    return value.replace("ß", "ss")


def read_nouns(items):
    """(лемма, род, формы) для существительных и отдельно — множество имён."""
    entries = []
    names, commons = set(), set()
    for item in items:
        pos = item.get("pos") or []
        lemma = norm(item.get("lemma") or "")
        if not lemma or not WORD_RE.match(lemma):
            continue
        forms = {norm(value) for value in (item.get("flexion") or {}).values() if value}
        forms = {form for form in forms if WORD_RE.match(form)}
        if any(tag in pos for tag in NAME_TAGS) and not forms:
            names.add(lemma)
            continue
        if "Substantiv" not in pos or "adjektivische Deklination" in pos:
            # Субстантивированные прилагательные (das Gute) склоняются как
            # прилагательные, и форма gute в тексте почти всегда прилагательное.
            continue
        commons.add(lemma)
        genus = (item.get("genus") or "").strip().lower()
        forms.add(lemma)
        entries.append((lemma, genus if genus in GENUS else "", forms))
    return entries, names - commons


def load_nouns():
    """Таблицы склонений немецких существительных из Викисловаря."""
    try:
        from german_nouns.lookup import Nouns
    except ImportError as exc:
        raise RuntimeError(f"{exc}. Нужен пакет german-nouns: pip install german-nouns") from exc
    table = Nouns()
    if len(table) < MIN_NOUNS:
        raise RuntimeError(f"список существительных неожиданно мал: {len(table)}")
    return read_nouns(table.row_to_dict(row) for row in table.data)


def load_lemmatizer():
    try:
        import simplemma
    except ImportError as exc:
        raise RuntimeError(f"{exc}. Нужен пакет simplemma: pip install simplemma") from exc

    def lemmatize(value):
        return simplemma.lemmatize(value, lang="de")

    if norm(lemmatize("ging")) != "gehen":
        raise RuntimeError("simplemma не лемматизирует немецкий: ging -> gehen не сработало")
    return lemmatize


def build_noun_index(entries, names, rank_of):
    """Карта «форма -> существительное» и его место в частотном списке.

    Слово берётся, только если корпус видел хоть одну его форму: Викисловарь
    знает сто тысяч существительных, и половина из них в живом тексте не
    встречается. Ранг существительного — ранг самой частой его формы, а при
    совпадении форм побеждает более частое слово: Strasse — это швейцарское
    написание Straße, а не редкий Strass.
    """
    best, attested = {}, []
    for lemma, genus, forms in entries:
        ranks = [rank_of[fold(form)] for form in forms if fold(form) in rank_of]
        if not ranks:
            continue
        # Ранг берём по самой словарной форме, и только если корпус её не
        # видел — по остальным. Иначе редкое слово получает чужую частотность:
        # родительный падеж Hau — это Haus, и Hau оказался бы частотнее дома.
        rank = rank_of.get(fold(lemma), min(ranks))
        attested.append((lemma, rank, forms))
        if rank < best.get(lemma, (10**12, ""))[0]:
            best[lemma] = (rank, genus)
    lemma_rank = {lemma: value[0] for lemma, value in best.items()}
    genders = {lemma: value[1] for lemma, value in best.items() if value[1]}

    form_map = {}
    for lemma, _rank, forms in attested:
        rank = lemma_rank[lemma]
        for form in forms:
            for variant in (form, fold(form)):
                if variant == lemma:
                    continue
                # Reis — это рис, а не множественное число бразильского Real.
                # Слово, у которого есть своя словарная статья, чужой лемме не
                # отдаём вовсе: частотность тут не судья — Real Madrid сделал
                # реал частотнее риса, и по частоте рис проиграл бы.
                if variant in lemma_rank:
                    continue
                # Maria — это имя, а не множественное число лунного Mare:
                # частое имя чужой лемме не отдаём, иначе оно исчезнет из
                # словаря, растворившись в редком слове. Редкое имя — отдаём:
                # Strassen — деревня в Австрии, но в тексте это множественное
                # число улицы, и мерилом тут опять частотность.
                if variant in names and rank_of.get(fold(variant), 10**12) <= rank:
                    continue
                old = form_map.get(variant)
                if old is None or rank < lemma_rank[old]:
                    form_map[variant] = lemma
    return form_map, lemma_rank, genders


def general_lemmas(surfaces, lemmatize):
    """Лемма строчной формы по simplemma — для глаголов, прилагательных, служебных слов."""
    out = []
    for surface in surfaces:
        try:
            lemma = norm(lemmatize(surface) or surface)
        except Exception:
            lemma = surface
        out.append(lemma if lemma and WORD_RE.match(lemma) else surface)
    return out


def build_lexical_assets(surfaces, generals, noun_index, names, output_dir: Path):
    """Из форм и двух источников делает порядок лемм и две карты форм.

    Порядок леммы — это ранг самой частой её формы: слово, которое читатель
    встречает как ging, по частотности стоит там, где стоит ging, а не там, где
    редкое gehen в словарной форме.
    """
    form_map, lemma_rank, genders = noun_index
    best_rank = dict(lemma_rank)

    general_map = {}
    for rank, (surface, general) in enumerate(zip(surfaces, generals)):
        # Ответ simplemma принимаем, только если таблицы склонений не считают
        # его формой другого существительного: lampen — это множественное
        # число Lampe, а не словарное слово.
        if form_map.get(general, general) != general:
            continue
        # Частотность формы принадлежит слову, чьей формой её знают таблицы
        # склонений. simplemma отвечает на strasse «strass», и без этой строки
        # редкий Strass занимал бы в словаре место Straße — 323-е.
        noun_of_surface = form_map.get(surface, "")
        if not noun_of_surface or noun_of_surface == general:
            if rank < best_rank.get(general, 10**12):
                best_rank[general] = rank
        if general == surface:
            continue
        # abarbeiten — не лемма слова arbeit: форма сидит внутри чужого глагола
        # с приставкой. Известному существительному такую лемму не приписываем.
        if surface in lemma_rank and surface in general and not general.startswith(surface):
            continue
        general_map[surface] = general

    ordered = [lemma for lemma, _ in sorted(best_rank.items(), key=lambda kv: (kv[1], kv[0]))]
    ranked = ordered[:VOCAB_LIMIT]
    shipped = set(ranked)
    form_map = {form: lemma for form, lemma in form_map.items() if lemma in shipped}
    general_map = {form: lemma for form, lemma in general_map.items() if lemma in shipped}
    genders = {lemma: genus for lemma, genus in genders.items() if lemma in shipped}
    with (output_dir / "de_vocab_frequency.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        for lemma in ranked:
            # Часть речи заполняем только там, где её подтвердил Викисловарь;
            # для остальных слов её никто не знает, и выдумывать нельзя.
            # Колонка части речи: NOUN — подтверждённое Викисловарём
            # существительное, NAME — слово, у которого есть только имя
            # собственное. Немецкое имя в тексте ничем другим не отличается:
            # с заглавной буквы пишется каждое существительное.
            kind = "NOUN" if lemma in lemma_rank else ("NAME" if lemma in names else "")
            fh.write(f"{lemma}\t{kind}\n")
    with (output_dir / "de_noun_lemma.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        for form in sorted(form_map):
            fh.write(f"{form}\t{form_map[form]}\n")
    with (output_dir / "de_vocab_lemma.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        for surface in sorted(general_map):
            fh.write(f"{surface}\t{general_map[surface]}\n")
    with (output_dir / "de_noun_gender.tsv").open("w", encoding="utf-8", newline="\n") as fh:
        for lemma in sorted(genders):
            fh.write(f"{lemma}\t{genders[lemma]}\n")

    return ranked, form_map, general_map, genders


def resolve_part(part: str, ranks, forms) -> str:
    """Известное слово для части составного: сама лемма или форма от неё."""
    if part in ranks:
        return part
    lemma = forms.get(part, "")
    return lemma if lemma in ranks else ""


def compound_splits(rest: str, ranks, forms, depth: int, *, whole: bool = False):
    """Все разборы слова на известные части, от двух до depth штук."""
    out = []
    if not whole:
        known = resolve_part(rest, ranks, forms)
        if known:
            out.append([known])
    if depth > 1 and len(rest) >= MIN_PART * 2:
        for cut in range(MIN_PART, len(rest) - MIN_PART + 1):
            head, tail = rest[:cut], rest[cut:]
            last = resolve_part(tail, ranks, forms)
            if not last:
                continue
            stems = set()
            for link in FUGEN:
                if link and not head.endswith(link):
                    continue
                stem = head[: len(head) - len(link)] if link else head
                if len(stem) < MIN_PART or stem in stems:
                    continue
                stems.add(stem)
                for left in compound_splits(stem, ranks, forms, depth - 1):
                    out.append(left + [last])
    return out


def compound_cost(parts, ranks):
    """Чем меньше частей, тем лучше разбор; при равенстве — чем они частотнее.

    Читатель делит слово на самые крупные куски, которые знает: Bahnhofstraße —
    это Bahnhof и Straße, а не Bahn, Hof и Straße. А частотность нужна, чтобы
    разбор не собирался из мусора: в списке из ста тысяч слов найдутся и zim, и
    mer, и Arbeitszimmer развалится на них, если не спросить, какие части в
    языке настоящие.
    """
    return (len(parts), max(ranks[part] for part in parts), sum(ranks[part] for part in parts))


def split_compound(word: str, ranks, forms=None, *, max_parts: int = 3):
    """Разбирает составное слово на известные части, или возвращает None.

    ranks — словарь «лемма -> её место в частотном списке», тот же порядок, что
    в de_vocab_frequency.tsv; forms — карта форм существительных, чтобы
    Hausaufgaben раскладывались на Haus и Aufgabe, а не на то, что похоже.
    Само слово известным не считается: решать, нужен ли разбор, — дело
    вызывающего, а проверять разбор надо и на тех словах, которые в словаре
    есть.
    """
    word = norm(word)
    if len(word) < MIN_PART * 2:
        return None
    variants = compound_splits(word, ranks, forms or {}, max_parts, whole=True)
    if not variants:
        return None
    return min(variants, key=lambda parts: compound_cost(parts, ranks))


def build_wikdict_json(source_db: Path, output_dir: Path, ranked):
    ranked_set = set(ranked)
    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    data, senses = {}, {}
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "simple_translation" not in tables:
            raise RuntimeError(f"неизвестная схема WikDict DE-RU: {sorted(tables)}")
        for word, raw_ru in conn.execute(
            "SELECT written_rep, trans_list FROM simple_translation "
            "WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL"
        ):
            key = norm(word)
            if not key:
                continue
            parts, seen = [], set()
            for raw in (raw_ru or "").split("|"):
                item = clean_ru(raw)
                low = item.lower()
                if item and low not in seen:
                    seen.add(low)
                    parts.append(item)
            if not parts:
                continue
            data.setdefault(key, parts[0])
            if key in ranked_set and len(parts) > 1:
                senses[key] = parts[:12]
    finally:
        conn.close()

    if len(data) < MIN_DICT_ENTRIES:
        raise RuntimeError(f"выгрузка WikDict DE-RU неожиданно мала: {len(data)}")
    (output_dir / "de_ru_core.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    (output_dir / "de_ru_senses.json").write_text(
        json.dumps(senses, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8"
    )
    return len(data), len(senses)


NOTICE = """Reader AI German lexical resources

wordfreq (Robyn Speer)
  https://github.com/rspeer/wordfreq
  License: Apache License 2.0
  Frequency order for German surfaces; the package documents the corpora it
  combines.

simplemma (Adrien Barbaresi)
  https://github.com/adbar/simplemma
  License: MIT
  Surface-to-lemma mapping for lowercase German words.

german-nouns (gambolutty)
  https://github.com/gambolutty/german-nouns
  License: MIT (code), Creative Commons Attribution-ShareAlike (data)
  Declension tables and grammatical gender for German nouns, extracted from
  the German Wiktionary.

WikDict / DBnary German-Russian dictionary, 2026-06 export
  https://www.wikdict.com/
  https://download.wikdict.com/
  License: Creative Commons Attribution-ShareAlike
  Wiktionary data processed via DBnary.
"""


def self_test():
    import tempfile

    # Статьи в том виде, в каком их отдаёт german_nouns на настоящих данных.
    articles = [
        {"lemma": "Lampe", "pos": ["Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Lampe", "nominativ plural": "Lampen"}},
        {"lemma": "Lampe", "pos": ["Nachname", "Substantiv"], "flexion": {}},
        {"lemma": "Haus", "pos": ["Substantiv"], "genus": "n",
         "flexion": {"nominativ singular": "Haus", "nominativ plural": "Häuser"}},
        {"lemma": "Habe", "pos": ["Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Habe"}},
        {"lemma": "Haben", "pos": ["Substantiv"], "genus": "n",
         "flexion": {"nominativ singular": "Haben"}},
        {"lemma": "Arbeit", "pos": ["Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Arbeit", "nominativ plural": "Arbeiten"}},
        {"lemma": "Tür", "pos": ["Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Tür", "nominativ plural": "Türen"}},
        {"lemma": "Aufgabe", "pos": ["Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Aufgabe", "nominativ plural": "Aufgaben"}},
        # Straße и Strass совпадают в написании через ss, и корпус знает только
        # его: выбирать между ними приходится по частотности.
        {"lemma": "Strass", "pos": ["Substantiv"], "genus": "m",
         "flexion": {"nominativ singular": "Strass", "genitiv singular": "Strasses"}},
        {"lemma": "Straße", "pos": ["Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Straße", "nominativ plural": "Straßen"}},
        # Reis (рис) — частотное слово, и оно же форма множественного числа
        # бразильского Real. Настоящая пара из данных Викисловаря.
        {"lemma": "Real", "pos": ["Substantiv"], "genus": "m",
         "flexion": {"nominativ singular": "Real", "nominativ plural": "Reis"}},
        {"lemma": "Reis", "pos": ["Substantiv"], "genus": "m",
         "flexion": {"nominativ singular": "Reis"}},
        # Субстантивированное прилагательное: форма gute должна остаться за gut.
        {"lemma": "Guter", "pos": ["Substantiv", "adjektivische Deklination"], "genus": "m",
         "flexion": {"nominativ singular schwach": "Gute"}},
        # Maria — имя, и она же множественное число лунного Mare. Настоящая
        # пара из данных Викисловаря.
        {"lemma": "Mare", "pos": ["Substantiv"], "genus": "n",
         "flexion": {"nominativ singular": "Mare", "nominativ plural": "Maria"}},
        {"lemma": "Maria", "pos": ["Substantiv", "Vorname"], "flexion": {}},
        # Strassen — деревня в Австрии и в то же время множественное число
        # Straße. Редкое имя формы у частотного слова не отнимает.
        {"lemma": "Strassen", "pos": ["Toponym"], "genus": "n",
         "flexion": {"nominativ singular": "Strassen"}},
        # Топоним без таблицы склонений — настоящее имя.
        {"lemma": "Berlin", "pos": ["Substantiv", "Toponym"], "flexion": {}},
        # А солнце Викисловарь тоже помечает именем собственным — и даёт ему
        # полное склонение. Это обычное слово, и Sonnenschein без него
        # раскладывается на глагол sonnen «загорать».
        {"lemma": "Sonne", "pos": ["Eigenname", "Substantiv"], "genus": "f",
         "flexion": {"nominativ singular": "Sonne", "nominativ plural": "Sonnen"}},
        # Существительное, которого корпус не видел ни в одной форме.
        {"lemma": "Zwirnsfaden", "pos": ["Substantiv"], "genus": "m",
         "flexion": {"nominativ singular": "Zwirnsfaden"}},
    ]
    # Ответы настоящей simplemma на эти формы, снятые с неё же.
    answers = {
        "lampe": "lampen", "lampen": "lampen", "haus": "hausen", "häuser": "Haus",
        "gute": "gut", "ging": "gehen", "gehen": "gehen", "habe": "haben",
        "haben": "haben", "tür": "Tür", "türen": "Tür", "arbeit": "abarbeiten",
        "strasse": "strass", "aufgaben": "aufgeben", "strasses": "strass",
        "reis": "reis", "real": "real", "aufgeben": "aufgeben", "berlin": "berlin",
        "maria": "maria", "mare": "mare", "strassen": "strass",
        "sonne": "sonnen", "sonnen": "sonnen",
    }
    lemmatize = lambda value: answers.get(norm(value), value)

    entries, names = read_nouns(articles)
    assert ("gute" not in {form for _l, _g, forms in entries for form in forms}), \
        "субстантивированное прилагательное в существительные не берём"
    assert "berlin" in names and "lampe" not in names, sorted(names)

    surfaces = ["habe", "haben", "ging", "gehen", "gute", "haus", "häuser", "lampe",
                "lampen", "tür", "türen", "arbeit", "strasse", "aufgaben",
                # Настоящий глагол в списке есть и сам по себе — ранг он берёт
                # оттуда, а не у формы существительного Aufgaben.
                "aufgeben", "berlin", "maria", "sonne", "sonnen", "strassen",
                # Real Madrid сделал реал частотнее риса — на настоящих данных
                # реал стоит 1479-м, а рис 3795-м. Порядок здесь тот же.
                "real", "reis", "strasses", "mare"]
    rank_of = {surface: rank for rank, surface in enumerate(surfaces)}
    form_map, lemma_rank, genders = build_noun_index(entries, names, rank_of)
    assert form_map["strasse"] == "straße", form_map.get("strasse")
    assert form_map["straßen"] == "straße"
    assert form_map.get("reis") is None, \
        "рис не может быть формой бразильского реала, даже если реал частотнее"
    assert form_map.get("maria") is None, "частое имя не может быть формой чужого существительного"
    assert form_map.get("strassen") == "straße", "редкое имя не отнимает форму у частотного слова"
    assert "zwirnsfaden" not in lemma_rank, "слово, которого корпус не видел, в словарь не берём"
    assert genders["haus"] == "n" and genders["lampe"] == "f" and genders["straße"] == "f"

    generals = general_lemmas(surfaces, lemmatize)
    with tempfile.TemporaryDirectory() as td:
        ranked, form_map, general_map, genders = build_lexical_assets(
            surfaces, generals, (form_map, lemma_rank, genders), names, Path(td)
        )
        assert "lampen" not in ranked, "форма множественного числа не может быть леммой"
        assert "lampe" in ranked and "straße" in ranked
        assert "haben" in ranked and "gehen" in ranked
        assert form_map["häuser"] == "haus"
        assert form_map["lampen"] == "lampe"
        assert "haus" not in form_map, "лемма сама себе формой не записывается"
        assert general_map["habe"] == "haben", "строчное habe — это глагол"
        assert general_map["ging"] == "gehen"
        assert general_map["gute"] == "gut"
        assert "lampe" not in general_map, "выдуманный инфинитив lampen в карту не попадает"
        assert "arbeit" not in general_map, "abarbeiten — не лемма слова arbeit"
        assert ranked.index("straße") < ranked.index("strass"), \
            "частотность формы strasse принадлежит Straße, а не редкому Strass"
        # aufgeben — настоящий глагол, и в словаре ему место; форма aufgaben
        # при этом остаётся и формой существительного Aufgabe. Что показать,
        # решает регистр в тексте: карта существительных отвечает на Aufgaben,
        # общая карта — на строчное aufgaben.
        assert "aufgeben" in ranked and form_map["aufgaben"] == "aufgabe"
        assert general_map["aufgaben"] == "aufgeben"
        # habe читается и как существительное (meine Habe), и как глагол
        # (ich habe); словарь держит оба чтения, а выбирает регистр в тексте.
        head = (Path(td) / "de_vocab_frequency.tsv").read_text(encoding="utf-8").splitlines()
        assert head[:2] == ["habe\tNOUN", "haben\tNOUN"], head[:3]
        assert "gehen\t" in head and "gut\t" in head
        assert "berlin\tNAME" in head, "топоним помечен как имя собственное"
        assert "maria\tNAME" in head, "имя осталось в словаре и помечено"
        assert "sonne\tNOUN" in head, "солнце — обычное слово, а не имя собственное"
        assert form_map["sonnen"] == "sonne", "множественное число солнца потеряно"
        assert genders["sonne"] == "f"
        assert "lampe\tNOUN" in head
        nouns_file = (Path(td) / "de_noun_lemma.tsv").read_text(encoding="utf-8")
        assert "strasse\tstraße\n" in nouns_file

    # Порядок списка — это частотность: haus частотнее редкого hau, и разбор
    # haustür обязан выбрать haus, хотя hau тоже «известное слово».
    known = {word: rank for rank, word in enumerate(
        ["haus", "tür", "arbeit", "zimmer", "kind", "garten", "sonne", "schein",
         "küche", "tisch", "aufgabe", "arbeits", "hau", "zim", "mer", "ten", "gar"]
    )}
    forms = {"aufgaben": "aufgabe", "häuser": "haus", "türen": "tür"}
    cases = {
        "haustür": ["haus", "tür"],
        "arbeitszimmer": ["arbeit", "zimmer"],
        "kindergarten": ["kind", "garten"],
        "sonnenschein": ["sonne", "schein"],
        "hausaufgaben": ["haus", "aufgabe"],   # часть стоит во множественном числе
        "küchentisch": ["küche", "tisch"],
        "haus": None,               # простое слово не разбирается
        "xyzzyfoo": None,           # незнакомое остаётся незнакомым
    }
    for word, expect in cases.items():
        got = split_compound(word, known, forms)
        assert got == expect, f"{word}: {got} вместо {expect}"

    print("German Reader resource self-test PASS")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output-dir")
    ap.add_argument("--cache-dir")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--install-deps", action="store_true")
    args = ap.parse_args()

    if args.install_deps:
        install_requirements()
        return
    if args.self_test:
        self_test()
        return

    if not args.output_dir or not args.cache_dir:
        ap.error("нужны --output-dir и --cache-dir")
    output_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    surfaces = read_surfaces()
    rank_of = {surface: rank for rank, surface in enumerate(surfaces)}
    entries, names = load_nouns()
    noun_index = build_noun_index(entries, names, rank_of)
    if len(noun_index[0]) < MIN_NOUN_FORMS:
        raise RuntimeError(
            f"форм существительных нашлось {len(noun_index[0])}, ожидалось не меньше {MIN_NOUN_FORMS}"
        )

    generals = general_lemmas(surfaces, load_lemmatizer())
    ranked, form_map, general_map, genders = build_lexical_assets(
        surfaces, generals, noun_index, names, output_dir
    )
    if len(ranked) < MIN_LEMMAS:
        raise RuntimeError(f"лемм получилось {len(ranked)}, ожидалось не меньше {MIN_LEMMAS}")
    if len(ranked) > VOCAB_LIMIT:
        raise RuntimeError(f"в словарь уехало {len(ranked)} лемм при пределе {VOCAB_LIMIT}")

    # Составные слова — половина немецких существительных в тексте. Ресурс, на
    # котором Haustür не раскладывается, немецким читателю не будет.
    ranks = {lemma: rank for rank, lemma in enumerate(ranked)}
    probes = {
        "haustür": ["haus", "tür"],
        "arbeitszimmer": ["arbeit", "zimmer"],
        "kindergarten": ["kind", "garten"],
        "sonnenschein": ["sonne", "schein"],
        "hausaufgaben": ["haus", "aufgabe"],
        "krankenhauskosten": ["krankenhaus", "kosten"],
        "bahnhofstraße": ["bahnhof", "straße"],
    }
    for word, want in probes.items():
        parts = split_compound(word, ranks, form_map)
        if parts != want:
            raise RuntimeError(f"составное слово {word} разобрано как {parts}, ожидалось {want}")

    wikdict_db = download(WIKDICT_URL, cache_dir / "de-ru-2_2026-06.sqlite3", min_size=1_000_000)
    dict_count, sense_count = build_wikdict_json(wikdict_db, output_dir, ranked)

    manifest = {
        "language": "de",
        "sources": ["wordfreq", "simplemma", "german-nouns", "wikdict-de-ru-2_2026-06"],
        "ranked_lemmas": len(ranked),
        "noun_forms": len(form_map),
        "nouns_with_gender": len(genders),
        "proper_names": sum(1 for lemma in ranked if lemma in names),
        "mapped_surface_forms": len(general_map),
        "dictionary_entries": dict_count,
        "ambiguous_heads": sense_count,
        "top20": ranked[:20],
    }
    (output_dir / "de_vocab_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "NOTICE.txt").write_text(NOTICE, encoding="utf-8")
    print(
        "German Reader resources:", f"{len(ranked)} ranked lemmas,",
        f"{len(form_map)} noun forms,", f"{len(genders)} nouns with gender,",
        f"{len(general_map)} surface mappings,", f"{dict_count} DE-RU entries,",
        f"{sense_count} ambiguous dictionary heads",
    )


if __name__ == "__main__":
    main()
