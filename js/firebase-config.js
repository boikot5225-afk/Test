window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM",
  authDomain: "french-da79a.firebaseapp.com",
  databaseURL: "https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "french-da79a",
  appId: "1:534791612002:web:e9a9a990d351ced860133b"
};
window.AN2_ADMIN_USERNAME = window.AN2_ADMIN_USERNAME || 'boikot5225';
window.AN2_FIREBASE_FUNCTIONS_REGION = window.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1';
(function() {
  const base = document.currentScript && document.currentScript.src ? document.currentScript.src : location.href;
  const load = function(name, id) {
    if (document.getElementById(id)) return;
    const script = document.createElement('script');
    script.id = id;
    script.type = 'module';
    script.src = new URL(name, base).href;
    document.head.appendChild(script);
  };
  const start = function() {
    load('lang-separation.js?v=71.0', 'an2-language-shell-loader');
    load('lang-personal-verbs.js?v=71.0', 'an2-personal-verbs-loader');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
