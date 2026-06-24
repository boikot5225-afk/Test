// Firebase config for An II.
window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyC_Y-V5OIG61B7x7H54RNVwPL3vBeeyvtM",
  authDomain: "french-da79a.firebaseapp.com",
  databaseURL: "https://french-da79a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "french-da79a",
  appId: "1:534791612002:web:e9a9a990d351ced860133b"
};
window.AN2_ADMIN_USERNAME = window.AN2_ADMIN_USERNAME || 'boikot5225';
window.AN2_FIREBASE_FUNCTIONS_REGION = window.AN2_FIREBASE_FUNCTIONS_REGION || 'asia-southeast1';
window.AN2_AUTH_BOOTSTRAP = 'reader-auth-v71.4';

(function installImmediateFirebaseFallback() {
  const config = window.FIREBASE_CONFIG;
  const SESSION_KEY = 'an2_firebase_rest_session_v1';
  const apps = [];
  const listeners = new Set();
  function loadSession(){try{const v=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');return v&&v.uid&&v.idToken?v:null;}catch(_){return null;}}
  function saveSession(v){try{if(v)localStorage.setItem(SESSION_KEY,JSON.stringify(v));else localStorage.removeItem(SESSION_KEY);}catch(_){}}
  function makeError(p,f){const raw=String((p&&p.error&&p.error.message)||(p&&p.message)||f||'auth/network-request-failed');const map={EMAIL_NOT_FOUND:'auth/user-not-found',INVALID_PASSWORD:'auth/wrong-password',INVALID_LOGIN_CREDENTIALS:'auth/invalid-credential',EMAIL_EXISTS:'auth/email-already-in-use',WEAK_PASSWORD:'auth/weak-password',OPERATION_NOT_ALLOWED:'auth/operation-not-allowed',CONFIGURATION_NOT_FOUND:'auth/configuration-not-found',INVALID_EMAIL:'auth/invalid-email'};const e=new Error(raw);e.code=map[raw]||f||'auth/network-request-failed';return e;}
  let session=loadSession(), currentUser=null;
  function notify(){listeners.forEach(fn=>{try{fn(currentUser);}catch(_){}});}
  function makeUser(data){if(!data)return null;return {uid:data.uid,email:data.email||'',async getIdToken(force){if(force&&data.refreshToken){const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:data.refreshToken});const r=await fetch('https://securetoken.googleapis.com/v1/token?key='+encodeURIComponent(config.apiKey),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const j=await r.json().catch(()=>({}));if(!r.ok||j.error)throw makeError(j,'auth/network-request-failed');data.idToken=j.id_token||data.idToken;data.refreshToken=j.refresh_token||data.refreshToken;saveSession(data);}return data.idToken;}};}
  currentUser=makeUser(session);
  async function authRequest(kind,email,password){const endpoint=kind==='signup'?'accounts:signUp':'accounts:signInWithPassword';const r=await fetch('https://identitytoolkit.googleapis.com/v1/'+endpoint+'?key='+encodeURIComponent(config.apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:String(email||'').trim(),password:String(password||''),returnSecureToken:true})});const j=await r.json().catch(()=>({}));if(!r.ok||j.error)throw makeError(j,'auth/network-request-failed');session={uid:j.localId,email:j.email||email||'',idToken:j.idToken,refreshToken:j.refreshToken||''};currentUser=makeUser(session);saveSession(session);notify();return {user:currentUser};}
  const authState={Auth:{Persistence:{LOCAL:'LOCAL'}},get currentUser(){return currentUser;},setPersistence:async()=>{},onAuthStateChanged(fn){listeners.add(fn);Promise.resolve().then(()=>{try{fn(currentUser);}catch(_){}});return()=>listeners.delete(fn);},signInWithEmailAndPassword(email,password){return authRequest('signin',email,password);},createUserWithEmailAndPassword(email,password){return authRequest('signup',email,password);},signOut:async()=>{session=null;currentUser=null;saveSession(null);notify();}};
  const auth=()=>authState;auth.Auth=authState.Auth;
  function databaseRef(path){const clean=String(path||'').replace(/^\/+|\/+$/g,'');const base=String(config.databaseURL).replace(/\/+$/,'');const request=async(method,payload)=>{const token=currentUser?await currentUser.getIdToken(false):'';const url=base+(clean?'/'+clean:'')+'.json'+(token?'?auth='+encodeURIComponent(token):'');const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload)});const j=method==='DELETE'?null:await r.json().catch(()=>null);if(!r.ok||(j&&j.error))throw makeError(j,'permission-denied');return j;};return {async get(){const v=await request('GET');return {exists:()=>v!==null&&v!==undefined,val:()=>v};},set:v=>request('PUT',v),update:v=>request('PATCH',v),remove:()=>request('DELETE')};}
  const fallback={apps,initializeApp(){if(!apps.length)apps.push({name:'[DEFAULT]'});return apps[0];},app(){if(!apps.length)apps.push({name:'[DEFAULT]'});return apps[0];},auth,database:()=>({ref:databaseRef}),__an2RestFallback:true};
  window.__AN2_FALLBACK_FIREBASE=fallback;
  function completeFirebase(x){return !!x&&Array.isArray(x.apps)&&typeof x.initializeApp==='function'&&typeof x.auth==='function'&&typeof x.database==='function';}
  function repair(){if(!completeFirebase(window.firebase))window.firebase=fallback;}
  repair();
  let repairs=0;const timer=setInterval(()=>{repair();repairs++;if(repairs>=120)clearInterval(timer);},100);
  window.an2FirebaseSdkReady=Promise.resolve({fallback:true,build:window.AN2_AUTH_BOOTSTRAP});
})();
