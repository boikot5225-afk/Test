// Language separation bootstrap. AI routes, prompts, TTS and Firebase Functions are not changed.
function startLanguageShell() {
  Promise.all([
    import('./lang-core.js'),
    import('./lang-reader.js')
  ]).catch(function(error) {
    console.warn('[lang-shell] startup failed', error);
  });
}
(function waitForAn2(tries) {
  if (window.__ready && typeof window.showScreen === 'function') {
    startLanguageShell();
    return;
  }
  if ((tries || 0) < 240) {
    setTimeout(function() { waitForAn2((tries || 0) + 1); }, 100);
  }
})(0);
