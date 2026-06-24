// Reader audio module.
// This is a behavior-preserving extraction from app.js.
// It does not change the listen button or playback rules yet.

export function createReaderAudio({
  speak,
  stopSpeak,
  showToast,
  getParagraphText,
  getLang,
  onActiveChange,
}) {
  function setActive(value) {
    try { onActiveChange?.(!!value); } catch (_) {}
  }

  async function speakText(text, opts = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    const chunk = clean.length > 900 ? clean.slice(0, 900) : clean;
    const lang = String(opts.lang || getLang?.() || 'fr').toLowerCase().startsWith('zh') ? 'zh' : 'fr';
    const rate = opts.rate || (lang === 'zh' ? 0.92 : 0.9);

    stop(false);
    setActive(true);
    try {
      // speak() now resolves when audio actually finishes (or returns false if stopped early)
      const ok = await speak(chunk, { lang, rate });
      setActive(false);
      return !!ok;
    } catch (error) {
      setActive(false);
      console.warn('[reader tts] TTS failed:', error);
      showToast?.(`⚠️ Облачная озвучка не сработала: ${String(error?.message || error).slice(0, 160)}`, 6000);
      return false;
    }
  }

  function stop(show = true) {
    try { stopSpeak?.(); } catch (_) {}
    try { window.speechSynthesis?.cancel?.(); } catch (_) {}
    setActive(false);
    if (show) showToast?.('⏹ Озвучка остановлена');
  }

  function speakParagraph(index) {
    const text = getParagraphText?.(index);
    return text ? speakText(text) : false;
  }

  function speakCurrentParagraph() {
    return speakParagraph(null);
  }

  function speakChapter() {
    const text = String(getParagraphText?.('__chapter__') || '');
    if (!text) return false;
    if (text.length > 1800) {
      showToast?.('🎧 Глава длинная: озвучу текущий абзац, чтобы TTS не подавился.');
      return speakCurrentParagraph();
    }
    return speakText(text);
  }

  return { speakText, stop, speakParagraph, speakCurrentParagraph, speakChapter };
}
