// Firebase config for An II.
// ВАЖНО: это публичный web config Firebase, не service account и не приватный ключ.
window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM",
  authDomain: "french-da79a.firebaseapp.com",
  databaseURL: "https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "french-da79a",
  appId: "1:534791612002:web:e9a9a990d351ced860133b"
};

// UID админа задаётся в Realtime Database: /admins/<uid> = true.
window.AN2_ADMIN_USERNAME = window.AN2_ADMIN_USERNAME || 'boikot5225';

// Регион Cloud Functions для reader-ai. Должен совпадать с functions/index.js.
window.AN2_FIREBASE_FUNCTIONS_REGION = window.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1';
