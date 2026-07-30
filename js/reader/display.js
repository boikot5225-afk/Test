// One setting for both ruby languages; the storage key keeps its original
// name so existing installs do not lose the user's choice.
const RUBY_MODE_KEY = 'an2_reader_zh_pinyin_mode_v1';

const READER_THEMES = new Set([
  'paper', 'ivory', 'sepia', 'vellum', 'sage', 'mist', 'eink', 'ink', 'amoled',
]);

export function normalizeReaderTheme(theme) {
  const raw = String(theme || '').trim().toLowerCase();
  // Keep legacy values stable: the old `parchment` was the original plain
  // warm theme, while the new textured parchment deliberately uses `vellum`.
  const legacy = { '': 'paper', parchment: 'paper', night: 'ink' };
  const normalized = legacy[raw] || raw;
  return READER_THEMES.has(normalized) ? normalized : 'paper';
}

function rubyScaffoldOn() {
  try { return (localStorage.getItem(RUBY_MODE_KEY) || 'unknown') !== 'off'; }
  catch { return true; }
}

export function createReaderDisplay({
  key = 'an2_reader_display_v1',
  readingViewId = 'reader-reading-view',
  panelId = 'rd-display-panel',
  backdropId = 'rd-display-back',
}) {
  // Calm-reader defaults: Lora reads better than Playfair at body sizes
  // (Playfair is a display face), with slightly roomier leading. Users who
  // already picked a font in the Аа panel keep their choice (saved settings
  // override these).
  const defaults = {
    font: 'Lora',
    size: 20,
    lh: 185,
    theme: '',
  };

  const fonts = {
    'Playfair Display': "'Playfair Display', serif",
    'Lora': "'Lora', serif",
    'Source Serif 4': "'Source Serif 4', serif",
    'Georgia': 'Georgia, serif',
    'IBM Plex Sans': "'IBM Plex Sans', sans-serif",
  };

  // None of the Аа fonts above have Chinese glyphs — the browser always falls
  // through to whatever CJK font it finds, so picking "Lora" vs "Georgia"
  // never visibly changed Chinese text (the actual bug: this looked like the
  // font picker "doesn't work" while reading Chinese). Map each pick onto a
  // real CJK counterpart of the same character (serif ↔ Noto Serif SC, the
  // one sans option ↔ Noto Sans SC) so choosing a font does something for zh.
  const zhFonts = {
    'Playfair Display': '"Noto Serif SC","Noto Serif TC",serif',
    'Lora': '"Noto Serif SC","Noto Serif TC",serif',
    'Source Serif 4': '"Noto Serif SC","Noto Serif TC",serif',
    'Georgia': '"Noto Serif SC","Noto Serif TC",serif',
    'IBM Plex Sans': '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
  };

  // Japanese needs its own stack rather than reusing the SC one: the same code
  // points are drawn differently per region (今 直 骨 among many others), so a
  // Simplified Chinese font renders Japanese text in visibly wrong shapes.
  // Android ships neither of the JP Noto families by name, so these lists end
  // in a bare serif/sans-serif on purpose: the reading view declares lang="ja",
  // which is what makes the system fallback pick Japanese glyph shapes instead
  // of Simplified Chinese ones. Naming the fonts still helps on desktop, where
  // they are often installed.
  const jaFonts = {
    'Playfair Display': '"Noto Serif JP","Yu Mincho","Hiragino Mincho ProN","Noto Serif CJK JP",serif',
    'Lora': '"Noto Serif JP","Yu Mincho","Hiragino Mincho ProN","Noto Serif CJK JP",serif',
    'Source Serif 4': '"Noto Serif JP","Yu Mincho","Hiragino Mincho ProN","Noto Serif CJK JP",serif',
    'Georgia': '"Noto Serif JP","Yu Mincho","Hiragino Mincho ProN","Noto Serif CJK JP",serif',
    'IBM Plex Sans': '"Noto Sans JP","Hiragino Sans","Yu Gothic","Noto Sans CJK JP",sans-serif',
  };

  function load() {
    let settings;
    try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
    catch { settings = { ...defaults }; }
    settings.theme = normalizeReaderTheme(settings.theme);
    return settings;
  }

  function save(settings) {
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch {}
  }

  function apply(settings) {
    const root = document.getElementById(readingViewId);
    if (!root) return;
    root.style.setProperty('--rd-font', fonts[settings.font] || fonts['Playfair Display']);
    root.style.setProperty('--rd-font-zh', zhFonts[settings.font] || zhFonts['Lora']);
    root.style.setProperty('--rd-font-ja', jaFonts[settings.font] || jaFonts['Lora']);
    root.style.setProperty('--rd-size', Number(settings.size) + 'px');
    const lh = Number(settings.lh) / 100;
    root.style.setProperty('--rd-lh', lh.toFixed(2));
    // CJK needs extra line-height when the ruby scaffold (pinyin / furigana)
    // is visible above the characters.
    const cjkLh = rubyScaffoldOn() ? Math.max(lh, 1.85).toFixed(2) : lh.toFixed(2);
    root.style.setProperty('--rd-cjk-lh', cjkLh);
    root.dataset.rdTheme = normalizeReaderTheme(settings.theme);
  }

  // Dragging the size/line-height sliders fires 'input' far faster than once
  // per frame, and each apply() forces a reflow of the whole chapter — brutal
  // on Chinese text specifically, where every character is its own
  // inline-block span with a ruby annotation, i.e. thousands of boxes to
  // relayout. Coalesce bursts into one apply() (and one localStorage write)
  // per animation frame instead of one per input event.
  let pendingSettings = null;
  let rafScheduled = false;
  function applyThrottled(settings) {
    pendingSettings = settings;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (pendingSettings) { apply(pendingSettings); save(pendingSettings); }
    });
  }

  function init() {
    const settings = load();
    apply(settings);
    const panel = document.getElementById(panelId);
    if (!panel) return settings;
    panel.querySelectorAll('.rd-dp-font').forEach(button => button.classList.toggle('rd-dp-active', button.dataset.font === settings.font));
    panel.querySelectorAll('.rd-dp-theme').forEach(button => button.classList.toggle('rd-dp-active', button.dataset.theme === normalizeReaderTheme(settings.theme)));
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
    applyThrottled(settings);
    const value = document.getElementById('rd-dp-size-val');
    if (value) value.textContent = settings.size;
  }

  function setLineHeight(input) {
    const settings = load();
    settings.lh = Number(input.value);
    applyThrottled(settings);
    const value = document.getElementById('rd-dp-lh-val');
    if (value) value.textContent = (settings.lh / 100).toFixed(2);
  }

  function setTheme(theme, element) {
    const settings = load();
    settings.theme = normalizeReaderTheme(theme);
    save(settings);
    apply(settings);
    element?.closest('.rd-dp-row')?.querySelectorAll('.rd-dp-theme').forEach(button => button.classList.remove('rd-dp-active'));
    element?.classList.add('rd-dp-active');
  }

  return { load, save, apply, init, togglePanel, closePanel, setFont, setSize, setLineHeight, setTheme };
}
