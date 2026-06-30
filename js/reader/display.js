const ZH_PINYIN_KEY = 'an2_reader_zh_pinyin_mode_v1';

function zhPinyinOn() {
  try { return (localStorage.getItem(ZH_PINYIN_KEY) || 'unknown') !== 'off'; }
  catch { return true; }
}

export function createReaderDisplay({
  key = 'an2_reader_display_v1',
  readingViewId = 'reader-reading-view',
  panelId = 'rd-display-panel',
  backdropId = 'rd-display-back',
}) {
  const defaults = {
    font: 'Playfair Display',
    size: 20,
    lh: 182,
    theme: '',
  };

  const fonts = {
    'Playfair Display': "'Playfair Display', serif",
    'Lora': "'Lora', serif",
    'Source Serif 4': "'Source Serif 4', serif",
    'Georgia': 'Georgia, serif',
    'IBM Plex Sans': "'IBM Plex Sans', sans-serif",
  };

  function load() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
    catch { return { ...defaults }; }
  }

  function save(settings) {
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch {}
  }

  function apply(settings) {
    const root = document.getElementById(readingViewId);
    if (!root) return;
    root.style.setProperty('--rd-font', fonts[settings.font] || fonts['Playfair Display']);
    root.style.setProperty('--rd-size', Number(settings.size) + 'px');
    const lh = Number(settings.lh) / 100;
    root.style.setProperty('--rd-lh', lh.toFixed(2));
    // Chinese needs extra line-height when pinyin is visible above characters
    const zhLh = zhPinyinOn() ? Math.max(lh, 1.85).toFixed(2) : lh.toFixed(2);
    root.style.setProperty('--rd-zh-lh', zhLh);
    root.dataset.rdTheme = settings.theme || '';
  }

  function init() {
    const settings = load();
    apply(settings);
    const panel = document.getElementById(panelId);
    if (!panel) return settings;
    panel.querySelectorAll('.rd-dp-font').forEach(button => button.classList.toggle('rd-dp-active', button.dataset.font === settings.font));
    panel.querySelectorAll('.rd-dp-theme').forEach(button => button.classList.toggle('rd-dp-active', button.dataset.theme === (settings.theme || '')));
    const size = panel.querySelector('#rd-dp-size');
    const lineHeight = panel.querySelector('#rd-dp-lh');
    if (size) { size.value = settings.size; panel.querySelector('#rd-dp-size-val').textContent = settings.size; }
    if (lineHeight) { lineHeight.value = settings.lh; panel.querySelector('#rd-dp-lh-val').textContent = (settings.lh / 100).toFixed(2); }
    return settings;
  }

  function togglePanel() {
    const panel = document.getElementById(panelId);
    const backdrop = document.getElementById(backdropId);
    if (!panel) return false;
    const open = panel.classList.toggle('show');
    if (backdrop) backdrop.classList.toggle('show', open);
    if (open) init();
    return open;
  }

  function closePanel() {
    document.getElementById(panelId)?.classList.remove('show');
    document.getElementById(backdropId)?.classList.remove('show');
  }

  function setFont(name, element) {
    const settings = load();
    settings.font = name;
    save(settings);
    apply(settings);
    element?.closest('.rd-dp-row')?.querySelectorAll('.rd-dp-font').forEach(button => button.classList.remove('rd-dp-active'));
    element?.classList.add('rd-dp-active');
  }

  function setSize(input) {
    const settings = load();
    settings.size = Number(input.value);
    save(settings);
    apply(settings);
    const value = document.getElementById('rd-dp-size-val');
    if (value) value.textContent = settings.size;
  }

  function setLineHeight(input) {
    const settings = load();
    settings.lh = Number(input.value);
    save(settings);
    apply(settings);
    const value = document.getElementById('rd-dp-lh-val');
    if (value) value.textContent = (settings.lh / 100).toFixed(2);
  }

  function setTheme(theme, element) {
    const settings = load();
    settings.theme = theme;
    save(settings);
    apply(settings);
    element?.closest('.rd-dp-row')?.querySelectorAll('.rd-dp-theme').forEach(button => button.classList.remove('rd-dp-active'));
    element?.classList.add('rd-dp-active');
  }

  return { load, save, apply, init, togglePanel, closePanel, setFont, setSize, setLineHeight, setTheme };
}
