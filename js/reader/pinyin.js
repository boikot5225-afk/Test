export function createReaderPinyinControls({
  storageKey,
  getCurrentLang,
  canonicalLang,
  rerender,
  toast,
  buttonId = 'reader-pinyin-btn',
}) {
  function mode() {
    try { return localStorage.getItem(storageKey) || 'unknown'; }
    catch { return 'unknown'; }
  }

  function label(value = mode()) {
    return value === 'off' ? '拼×' : value === 'learning' ? '拼*' : '拼';
  }

  function title(value = mode()) {
    return value === 'off'
      ? 'Пиньинь выключен'
      : value === 'learning'
        ? 'Пиньинь только для слов в изучении/проблемных'
        : 'Пиньинь для всех не изученных китайских слов, где он есть';
  }

  function update(lang = getCurrentLang()) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    const isChinese = canonicalLang(lang) === 'zh';
    const value = mode();
    const hint = title(value);
    button.style.display = isChinese ? 'flex' : 'none';
    button.textContent = label(value);
    button.title = hint;
    button.setAttribute('aria-label', hint);
    button.classList.toggle('on', isChinese && value !== 'off');
  }

  function cycle() {
    const current = mode();
    const next = current === 'unknown' ? 'learning' : current === 'learning' ? 'off' : 'unknown';
    try { localStorage.setItem(storageKey, next); } catch {}
    update(getCurrentLang());
    rerender();
    toast(next === 'off'
      ? '拼 Пиньинь выключен'
      : next === 'learning'
        ? '拼 Пиньинь только для слов в работе'
        : '拼 Пиньинь для всех новых слов');
    return next;
  }

  return { mode, label, title, update, cycle };
}
