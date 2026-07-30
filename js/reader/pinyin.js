// The reading scaffold above a token: pinyin over hanzi, furigana over kanji.
// Both languages share one on/off/learning setting — what changes is only how
// the button names itself, because "拼" over Japanese text means nothing.
export function createReaderPinyinControls({
  storageKey,
  getCurrentLang,
  canonicalLang,
  rerender,
  toast,
  buttonId = 'reader-pinyin-btn',
  rubyLangs = ['zh', 'ja'],
}) {
  const supported = new Set(rubyLangs);

  function isJapanese(lang) {
    return canonicalLang(lang) === 'ja';
  }

  function glyph(lang) {
    return isJapanese(lang) ? '振' : '拼';
  }

  function scriptName(lang) {
    return isJapanese(lang) ? 'Фуригана' : 'Пиньинь';
  }

  function mode() {
    try { return localStorage.getItem(storageKey) || 'unknown'; }
    catch { return 'unknown'; }
  }

  function label(value = mode(), lang = getCurrentLang()) {
    const g = glyph(lang);
    return value === 'off' ? `${g}×` : value === 'learning' ? `${g}*` : g;
  }

  function title(value = mode(), lang = getCurrentLang()) {
    const name = scriptName(lang);
    const over = isJapanese(lang) ? 'японских слов с кандзи' : 'китайских слов';
    return value === 'off'
      ? `${name} выключена`
      : value === 'learning'
        ? `${name} только для слов в изучении/проблемных`
        : `${name} для всех не изученных ${over}, где она есть`;
  }

  function update(lang = getCurrentLang()) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    const hasRuby = supported.has(canonicalLang(lang));
    const value = mode();
    const hint = title(value, lang);
    button.style.display = hasRuby ? 'flex' : 'none';
    button.textContent = label(value, lang);
    button.title = hint;
    button.setAttribute('aria-label', hint);
    button.classList.toggle('on', hasRuby && value !== 'off');
  }

  function cycle() {
    const lang = getCurrentLang();
    const current = mode();
    const next = current === 'unknown' ? 'learning' : current === 'learning' ? 'off' : 'unknown';
    try { localStorage.setItem(storageKey, next); } catch {}
    update(lang);
    rerender();
    const g = glyph(lang);
    const name = scriptName(lang);
    toast(next === 'off'
      ? `${g} ${name} выключена`
      : next === 'learning'
        ? `${g} ${name} только для слов в работе`
        : `${g} ${name} для всех новых слов`);
    return next;
  }

  return { mode, label, title, update, cycle };
}
