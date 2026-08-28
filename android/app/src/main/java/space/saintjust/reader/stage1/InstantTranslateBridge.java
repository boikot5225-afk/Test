package space.saintjust.reader.stage1;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.CancellationSignal;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

import com.google.android.gms.tasks.Tasks;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.remoteconfig.FirebaseRemoteConfig;
import com.google.firebase.remoteconfig.FirebaseRemoteConfigSettings;
import com.revenuecat.purchases.CustomerInfo;
import com.revenuecat.purchases.Purchases;
import com.revenuecat.purchases.PurchasesConfiguration;
import com.revenuecat.purchases.PurchasesError;
import com.revenuecat.purchases.interfaces.ReceiveCustomerInfoCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Experimental compatibility bridge for the user's legitimately purchased
 * Instant Translate account. It does not fake premium state: every request
 * first authenticates against Instant Translate's Firebase project and then
 * asks the same RevenueCat project whether that Firebase UID has an active
 * entitlement. Any failure is reported to JavaScript, which falls back to the
 * existing Reader AI/DeepSeek request.
 */
final class InstantTranslateBridge {
    private static final String TAG = "ReaderInstantAI";
    private static final String PREFS = "reader_instant_translate_bridge_v1";

    // Public client identifiers recovered from the installed Instant Translate APK.
    private static final String FIREBASE_API_KEY = "AIzaSyBczNB2LaQbLyyQTZCTx1DeIuTdePJj-No";
    private static final String FIREBASE_APP_ID = "1:1042039249250:android:a427e7ccfa5fbb11a7f43b";
    private static final String FIREBASE_PROJECT_ID = "screentextcopy";
    private static final String FIREBASE_WEB_CLIENT_ID =
            "1042039249250-kfd9kjmvc725ermjoeinn0sgp6vigjak.apps.googleusercontent.com";
    private static final String REVENUECAT_PUBLIC_KEY = "goog_jvNGWjPqjBRdBtkiwQJsEyGuYWa";
    private static final String REMOTE_CONFIG_KEY = "ai_translate_config_v2";
    private static final String FIREBASE_APP_NAME = "reader-instant-translate";

    private static final long TOKEN_SKEW_MS = 120_000L;
    private static final int NETWORK_TIMEOUT_MS = 20_000;

    private final Activity activity;
    private final WebView webView;
    private final SharedPreferences prefs;
    private final ExecutorService worker = Executors.newCachedThreadPool();
    private final AtomicBoolean googleSignInRunning = new AtomicBoolean(false);
    private final AtomicBoolean revenueCatConfigured = new AtomicBoolean(false);
    private volatile String revenueCatUid = "";
    private volatile FirebaseRemoteConfig remoteConfig;
    private volatile boolean successToastShown = false;

    InstantTranslateBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public void translate(String requestId, String payloadJson) {
        final String safeId = requestId == null ? "" : requestId;
        final JSONObject payload;
        try {
            payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
        } catch (JSONException e) {
            deliverFailure(safeId, "bad_payload", e.getMessage());
            return;
        }
        final String text = payload.optString("text", "").trim();
        if (text.isEmpty()) {
            deliverFailure(safeId, "empty_text", "Empty paragraph");
            return;
        }

        worker.execute(() -> {
            try {
                AuthSession session = loadUsableSession();
                if (session != null) {
                    translateAuthenticated(safeId, payload, session);
                    return;
                }
            } catch (Exception refreshError) {
                Log.w(TAG, "Cached Instant Translate session failed", refreshError);
                clearSession();
            }
            requestGoogleSignIn(safeId, payload);
        });
    }

    @JavascriptInterface
    public String status() {
        AuthSession session = loadStoredSession();
        JSONObject out = new JSONObject();
        try {
            out.put("signedIn", session != null && !session.uid.isEmpty());
            out.put("uid", session == null ? "" : session.uid);
            out.put("email", session == null ? "" : session.email);
        } catch (JSONException ignored) {}
        return out.toString();
    }

    private void requestGoogleSignIn(String requestId, JSONObject payload) {
        if (!googleSignInRunning.compareAndSet(false, true)) {
            deliverFailure(requestId, "auth_busy", "Instant Translate sign-in is already open");
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                GetGoogleIdOption googleOption = new GetGoogleIdOption.Builder()
                        .setFilterByAuthorizedAccounts(false)
                        .setAutoSelectEnabled(false)
                        .setServerClientId(FIREBASE_WEB_CLIENT_ID)
                        .build();
                GetCredentialRequest request = new GetCredentialRequest.Builder()
                        .addCredentialOption(googleOption)
                        .build();
                CredentialManager manager = CredentialManager.create(activity);
                manager.getCredentialAsync(
                        activity,
                        request,
                        new CancellationSignal(),
                        command -> activity.runOnUiThread(command),
                        new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                            @Override
                            public void onResult(GetCredentialResponse response) {
                                googleSignInRunning.set(false);
                                try {
                                    Credential credential = response.getCredential();
                                    if (!(credential instanceof CustomCredential)
                                            || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                                            .equals(credential.getType())) {
                                        deliverFailure(requestId, "auth_type",
                                                "Google returned an unexpected credential type");
                                        return;
                                    }
                                    GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(
                                            ((CustomCredential) credential).getData());
                                    String googleIdToken = google.getIdToken();
                                    worker.execute(() -> {
                                        try {
                                            AuthSession session = exchangeGoogleToken(googleIdToken);
                                            saveSession(session);
                                            translateAuthenticated(requestId, payload, session);
                                        } catch (Exception e) {
                                            Log.w(TAG, "Instant Translate Firebase sign-in failed", e);
                                            deliverFailure(requestId, "firebase_auth", readable(e));
                                        }
                                    });
                                } catch (Exception e) {
                                    deliverFailure(requestId, "google_credential", readable(e));
                                }
                            }

                            @Override
                            public void onError(GetCredentialException e) {
                                googleSignInRunning.set(false);
                                deliverFailure(requestId, "google_sign_in", readable(e));
                            }
                        });
            } catch (Exception e) {
                googleSignInRunning.set(false);
                deliverFailure(requestId, "google_sign_in_start", readable(e));
            }
        });
    }

    private void translateAuthenticated(String requestId, JSONObject payload, AuthSession session) {
        try {
            if (!hasPremiumEntitlement(session.uid)) {
                throw new IllegalStateException(
                        "Instant Translate Premium is not active for this Google account");
            }
            String endpoint = fetchAiEndpoint(true);
            String text = payload.optString("text", "");
            String targetLang = payload.optString("targetLang", "ru");
            String translation = requestAiTranslation(endpoint, session.idToken, text, targetLang);
            if (translation.trim().isEmpty()) {
                throw new IllegalStateException("Instant Translate returned an empty translation");
            }
            deliverSuccess(requestId, translation.trim());
            if (!successToastShown) {
                successToastShown = true;
                activity.runOnUiThread(() -> Toast.makeText(activity,
                        "Instant Translate AI подключён", Toast.LENGTH_SHORT).show());
            }
        } catch (Exception e) {
            Log.w(TAG, "Instant Translate AI failed; Reader AI will fall back", e);
            deliverFailure(requestId, "instant_ai", readable(e));
        }
    }

    private AuthSession loadUsableSession() throws Exception {
        AuthSession session = loadStoredSession();
        if (session == null) return null;
        if (session.expiresAtMs > System.currentTimeMillis() + TOKEN_SKEW_MS
                && !session.idToken.isEmpty()) {
            return session;
        }
        if (session.refreshToken.isEmpty()) return null;
        AuthSession refreshed = refreshFirebaseToken(session);
        saveSession(refreshed);
        return refreshed;
    }

    private AuthSession loadStoredSession() {
        String uid = prefs.getString("uid", "");
        String idToken = prefs.getString("idToken", "");
        String refreshToken = prefs.getString("refreshToken", "");
        String email = prefs.getString("email", "");
        long expiresAt = prefs.getLong("expiresAt", 0L);
        if (uid == null || uid.isEmpty() || idToken == null || idToken.isEmpty()) return null;
        return new AuthSession(uid, email == null ? "" : email, idToken,
                refreshToken == null ? "" : refreshToken, expiresAt);
    }

    private void saveSession(AuthSession session) {
        prefs.edit()
                .putString("uid", session.uid)
                .putString("email", session.email)
                .putString("idToken", session.idToken)
                .putString("refreshToken", session.refreshToken)
                .putLong("expiresAt", session.expiresAtMs)
                .apply();
    }

    private void clearSession() {
        prefs.edit().clear().apply();
    }

    private AuthSession exchangeGoogleToken(String googleIdToken) throws Exception {
        JSONObject body = new JSONObject();
        body.put("requestUri", "http://localhost");
        body.put("postBody", "id_token="
                + URLEncoder.encode(googleIdToken, StandardCharsets.UTF_8.name())
                + "&providerId=google.com");
        body.put("returnIdpCredential", true);
        body.put("returnSecureToken", true);

        JSONObject result = postJson(
                "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key="
                        + FIREBASE_API_KEY,
                body,
                null,
                null);
        String uid = result.optString("localId", "");
        String idToken = result.optString("idToken", "");
        String refreshToken = result.optString("refreshToken", "");
        String email = result.optString("email", "");
        long expiresIn = parseLong(result.optString("expiresIn", "3600"), 3600L);
        if (uid.isEmpty() || idToken.isEmpty()) {
            throw new IllegalStateException("Firebase did not return the Instant Translate user");
        }
        return new AuthSession(uid, email, idToken, refreshToken,
                System.currentTimeMillis() + Math.max(60L, expiresIn) * 1000L);
    }

    private AuthSession refreshFirebaseToken(AuthSession previous) throws Exception {
        String body = "grant_type=refresh_token&refresh_token="
                + URLEncoder.encode(previous.refreshToken, StandardCharsets.UTF_8.name());
        JSONObject result = postForm(
                "https://securetoken.googleapis.com/v1/token?key=" + FIREBASE_API_KEY,
                body);
        String idToken = result.optString("id_token", "");
        String refresh = result.optString("refresh_token", previous.refreshToken);
        String uid = result.optString("user_id", previous.uid);
        long expiresIn = parseLong(result.optString("expires_in", "3600"), 3600L);
        if (idToken.isEmpty()) throw new IllegalStateException("Firebase token refresh failed");
        return new AuthSession(uid, previous.email, idToken, refresh,
                System.currentTimeMillis() + Math.max(60L, expiresIn) * 1000L);
    }

    private boolean hasPremiumEntitlement(String uid) throws Exception {
        configureRevenueCat(uid);
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<CustomerInfo> infoRef = new AtomicReference<>();
        AtomicReference<PurchasesError> errorRef = new AtomicReference<>();
        Purchases.getSharedInstance().getCustomerInfo(new ReceiveCustomerInfoCallback() {
            @Override
            public void onReceived(CustomerInfo customerInfo) {
                infoRef.set(customerInfo);
                latch.countDown();
            }

            @Override
            public void onError(PurchasesError purchasesError) {
                errorRef.set(purchasesError);
                latch.countDown();
            }
        });
        if (!latch.await(15, TimeUnit.SECONDS)) {
            throw new IllegalStateException("RevenueCat entitlement check timed out");
        }
        if (errorRef.get() != null) {
            throw new IllegalStateException("RevenueCat: " + errorRef.get().getMessage());
        }
        CustomerInfo info = infoRef.get();
        return info != null && info.getEntitlements() != null
                && info.getEntitlements().getActive() != null
                && !info.getEntitlements().getActive().isEmpty();
    }

    private synchronized void configureRevenueCat(String uid) {
        if (revenueCatConfigured.get()) {
            if (!uid.equals(revenueCatUid)) {
                throw new IllegalStateException("Instant Translate account changed; restart Reader AI");
            }
            return;
        }
        Purchases.configure(new PurchasesConfiguration.Builder(activity.getApplicationContext(),
                REVENUECAT_PUBLIC_KEY).appUserID(uid).build());
        revenueCatUid = uid;
        revenueCatConfigured.set(true);
    }

    private String fetchAiEndpoint(boolean premium) throws Exception {
        FirebaseRemoteConfig config = getRemoteConfig();
        Tasks.await(config.fetchAndActivate(), 15, TimeUnit.SECONDS);
        String raw = config.getString(REMOTE_CONFIG_KEY);
        if (raw == null || raw.trim().isEmpty()) {
            throw new IllegalStateException("Instant Translate Remote Config is empty");
        }
        JSONObject parsed = new JSONObject(raw);
        String endpoint = firstServer(parsed.opt(premium ? "premiumServers" : "servers"));
        if (endpoint.isEmpty() && premium) endpoint = firstServer(parsed.opt("servers"));
        if (endpoint.isEmpty()) throw new IllegalStateException("No Instant Translate AI server in config");
        return endpoint;
    }

    private synchronized FirebaseRemoteConfig getRemoteConfig() {
        if (remoteConfig != null) return remoteConfig;
        FirebaseApp app;
        try {
            app = FirebaseApp.getInstance(FIREBASE_APP_NAME);
        } catch (IllegalStateException missing) {
            FirebaseOptions options = new FirebaseOptions.Builder()
                    .setApiKey(FIREBASE_API_KEY)
                    .setApplicationId(FIREBASE_APP_ID)
                    .setProjectId(FIREBASE_PROJECT_ID)
                    .build();
            app = FirebaseApp.initializeApp(activity.getApplicationContext(), options,
                    FIREBASE_APP_NAME);
        }
        if (app == null) throw new IllegalStateException("Cannot initialize Instant Translate Firebase");
        FirebaseRemoteConfig config = FirebaseRemoteConfig.getInstance(app);
        config.setConfigSettingsAsync(new FirebaseRemoteConfigSettings.Builder()
                .setFetchTimeoutInSeconds(10)
                .setMinimumFetchIntervalInSeconds(0)
                .build());
        remoteConfig = config;
        return config;
    }

    private String requestAiTranslation(String endpoint, String firebaseIdToken,
                                        String text, String targetLang) throws Exception {
        JSONObject indexedText = new JSONObject();
        indexedText.put("0", text);

        JSONObject body = new JSONObject();
        body.put("text", indexedText.toString());
        body.put("isFixTypoEnable", false);
        body.put("isFixWordOrderEnable", false);
        body.put("makeFluent", true);
        body.put("mangaMode", false);
        body.put("contentType", "");
        body.put("language", languageName(targetLang));

        HttpURLConnection connection = openConnection(endpoint, "POST");
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("Authorization", "Bearer " + firebaseIdToken);
        connection.setRequestProperty("User-Agent", "Instant Translate/7.5.00201 Android");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(bytes);
        }
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300
                ? connection.getInputStream() : connection.getErrorStream();
        String raw = readAll(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("Instant AI HTTP " + code + ": " + shorten(raw, 400));
        }
        String translated = parseAiResponse(raw);
        if (translated.isEmpty()) {
            throw new IllegalStateException("Unrecognized Instant AI response: " + shorten(raw, 500));
        }
        return translated;
    }

    private String parseAiResponse(String raw) {
        if (raw == null) return "";
        StringBuilder deltas = new StringBuilder();
        String latestDirect = "";
        String[] lines = raw.replace("\r\n", "\n").split("\n");
        for (String sourceLine : lines) {
            String line = sourceLine == null ? "" : sourceLine.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("data:")) line = line.substring(5).trim();
            if (line.isEmpty() || "[DONE]".equalsIgnoreCase(line)) continue;
            try {
                Object json = line.startsWith("[") ? new JSONArray(line)
                        : line.startsWith("{") ? new JSONObject(line) : null;
                if (json != null) {
                    String direct = findDirectTranslation(json);
                    if (!direct.isEmpty()) latestDirect = direct;
                    String delta = findDeltaContent(json);
                    if (!delta.isEmpty()) deltas.append(delta);
                    continue;
                }
            } catch (Exception ignored) {
                // Some servers split a JSON fragment across SSE chunks; raw fallback below.
            }
            if (!line.startsWith("event:") && !line.startsWith("id:")) {
                deltas.append(line);
            }
        }
        if (!latestDirect.isEmpty()) return latestDirect;
        String deltaText = deltas.toString().trim();
        if (!deltaText.isEmpty()) return deltaText;
        try {
            Object json = raw.trim().startsWith("[") ? new JSONArray(raw.trim())
                    : raw.trim().startsWith("{") ? new JSONObject(raw.trim()) : null;
            return json == null ? "" : findDirectTranslation(json);
        } catch (Exception ignored) {
            return "";
        }
    }

    private String findDirectTranslation(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Object zero = object.opt("0");
            if (zero instanceof String && !((String) zero).trim().isEmpty()) return (String) zero;
            String[] preferred = {"translation", "translatedText", "text", "content", "result", "message"};
            for (String key : preferred) {
                Object child = object.opt(key);
                if (child instanceof String && !((String) child).trim().isEmpty()) return (String) child;
                String nested = findDirectTranslation(child);
                if (!nested.isEmpty()) return nested;
            }
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String nested = findDirectTranslation(object.opt(keys.next()));
                if (!nested.isEmpty()) return nested;
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) {
                String nested = findDirectTranslation(array.opt(i));
                if (!nested.isEmpty()) return nested;
            }
        }
        return "";
    }

    private String findDeltaContent(Object value) {
        try {
            if (value instanceof JSONObject) {
                JSONObject object = (JSONObject) value;
                JSONArray choices = object.optJSONArray("choices");
                if (choices != null && choices.length() > 0) {
                    JSONObject choice = choices.optJSONObject(0);
                    if (choice != null) {
                        JSONObject delta = choice.optJSONObject("delta");
                        if (delta != null && !delta.optString("content", "").isEmpty()) {
                            return delta.optString("content", "");
                        }
                        JSONObject message = choice.optJSONObject("message");
                        if (message != null && !message.optString("content", "").isEmpty()) {
                            return message.optString("content", "");
                        }
                    }
                }
                JSONObject delta = object.optJSONObject("delta");
                if (delta != null) return delta.optString("content", "");
            }
        } catch (Exception ignored) {}
        return "";
    }

    private String firstServer(Object value) {
        if (value == null || value == JSONObject.NULL) return "";
        if (value instanceof String) {
            String s = ((String) value).trim();
            return (s.startsWith("https://") || s.startsWith("http://")) ? s : "";
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) {
                String found = firstServer(array.opt(i));
                if (!found.isEmpty()) return found;
            }
            return "";
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            String[] preferred = {"url", "server", "endpoint", "host"};
            for (String key : preferred) {
                String found = firstServer(object.opt(key));
                if (!found.isEmpty()) return found;
            }
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String found = firstServer(object.opt(keys.next()));
                if (!found.isEmpty()) return found;
            }
        }
        return "";
    }

    private JSONObject postJson(String url, JSONObject body, String bearer, String accept)
            throws Exception {
        HttpURLConnection connection = openConnection(url, "POST");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (bearer != null && !bearer.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + bearer);
        }
        if (accept != null && !accept.isEmpty()) connection.setRequestProperty("Accept", accept);
        connection.setDoOutput(true);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        return readJsonResponse(connection);
    }

    private JSONObject postForm(String url, String body) throws Exception {
        HttpURLConnection connection = openConnection(url, "POST");
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        connection.setDoOutput(true);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        return readJsonResponse(connection);
    }

    private JSONObject readJsonResponse(HttpURLConnection connection) throws Exception {
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300
                ? connection.getInputStream() : connection.getErrorStream();
        String raw = readAll(stream);
        connection.disconnect();
        JSONObject result;
        try {
            result = new JSONObject(raw == null || raw.trim().isEmpty() ? "{}" : raw);
        } catch (JSONException e) {
            throw new IllegalStateException("HTTP " + code + ": " + shorten(raw, 400));
        }
        if (code < 200 || code >= 300 || result.has("error")) {
            throw new IllegalStateException("HTTP " + code + ": " + shorten(result.toString(), 500));
        }
        return result;
    }

    private HttpURLConnection openConnection(String url, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(NETWORK_TIMEOUT_MS);
        connection.setReadTimeout(NETWORK_TIMEOUT_MS * 2);
        connection.setUseCaches(false);
        return connection;
    }

    private String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream,
                StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                out.append(line).append('\n');
            }
        }
        return out.toString();
    }

    private void deliverSuccess(String requestId, String translation) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("ru", translation);
            payload.put("provider", "instant_translate_ai");
        } catch (JSONException ignored) {}
        deliverJs(requestId, true, payload.toString());
    }

    private void deliverFailure(String requestId, String code, String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("code", code == null ? "instant_ai" : code);
            payload.put("message", message == null ? "Instant Translate AI failed" : message);
        } catch (JSONException ignored) {}
        deliverJs(requestId, false, payload.toString());
    }

    private void deliverJs(String requestId, boolean ok, String payloadJson) {
        if (webView == null) return;
        final String script = "window.__readerInstantTranslateResolve&&window.__readerInstantTranslateResolve("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(payloadJson == null ? "{}" : payloadJson) + ");";
        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (Exception ignored) {}
        });
    }

    private String languageName(String code) {
        String value = code == null ? "ru" : code.trim().toLowerCase(Locale.ROOT);
        if (value.startsWith("ru")) return "Russian";
        if (value.startsWith("en")) return "English";
        if (value.startsWith("zh") || value.startsWith("cn")) return "Chinese";
        if (value.startsWith("ja") || value.startsWith("jp")) return "Japanese";
        if (value.startsWith("es")) return "Spanish";
        if (value.startsWith("fr")) return "French";
        if (value.startsWith("de")) return "German";
        return code;
    }

    private long parseLong(String value, long fallback) {
        try { return Long.parseLong(value); } catch (Exception ignored) { return fallback; }
    }

    private String readable(Throwable error) {
        if (error == null) return "unknown error";
        String message = error.getMessage();
        return (message == null || message.trim().isEmpty())
                ? error.getClass().getSimpleName() : message;
    }

    private String shorten(String value, int max) {
        String s = value == null ? "" : value.replace('\n', ' ').trim();
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    void shutdown() {
        worker.shutdownNow();
    }

    private static final class AuthSession {
        final String uid;
        final String email;
        final String idToken;
        final String refreshToken;
        final long expiresAtMs;

        AuthSession(String uid, String email, String idToken, String refreshToken,
                    long expiresAtMs) {
            this.uid = uid == null ? "" : uid;
            this.email = email == null ? "" : email;
            this.idToken = idToken == null ? "" : idToken;
            this.refreshToken = refreshToken == null ? "" : refreshToken;
            this.expiresAtMs = expiresAtMs;
        }
    }
}
