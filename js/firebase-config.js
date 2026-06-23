// Firebase config for An II.
// ВАЖНО: это публичный web config Firebase, не service account и не приватный ключ.
window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM",
  authDomain: "french-da79a.firebaseapp.com",
  databaseURL: "https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "french-da79a",
  appId: "1:534791612002:web:e9a9a990d351ced860133b"
};

window.AN2_ADMIN_USERNAME = window.AN2_ADMIN_USERNAME || 'boikot5225';
window.AN2_FIREBASE_FUNCTIONS_REGION = window.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1';

// firebase-config.js подключается как обычный script, поэтому здесь нельзя использовать import().
// Добавляем отдельный, обычный скрипт с очередью озвучки; остальной ридер он не подменяет.
(function () {
  if (document.getElementById('an2-reader-book-audio-loader')) return;
  const load = function () {
    if (document.getElementById('an2-reader-book-audio-loader')) return;
    const script = document.createElement('script');
    script.id = 'an2-reader-book-audio-loader';
    script.src = 'js/reader-book-audio.js?v=2';
    script.async = true;
    document.head.appendChild(script);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
