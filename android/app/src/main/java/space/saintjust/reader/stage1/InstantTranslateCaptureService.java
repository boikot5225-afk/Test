package space.saintjust.reader.stage1;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.ImageView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Reads only Instant Translate while a Reader request is armed.
 *
 * toc68 also keeps a frozen snapshot of Reader AI in a TYPE_ACCESSIBILITY_OVERLAY
 * while Instant Translate does its work underneath. The overlay is visual only:
 * it is not focusable/touchable and the translation is still read from the real
 * Instant Translate accessibility window.
 */
public final class InstantTranslateCaptureService extends AccessibilityService {
    private static volatile boolean armed = false;
    private static volatile String sourceText = "";
    private static volatile long armedAtMs = 0L;
    private static volatile String stableCandidate = "";
    private static volatile int stableHits = 0;
    private static volatile long stableSinceMs = 0L;
    private static volatile WeakReference<InstantTranslateCaptureService> activeService =
            new WeakReference<>(null);

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final long MIN_CAPTURE_AGE_MS = 850L;
    private static final long STABLE_WINDOW_MS = 420L;
    private static final long NATIVE_TIMEOUT_MS = 35_000L;
    private static final long COVER_HIDE_AFTER_BACK_MS = 850L;

    private WindowManager windowManager;
    private ImageView coverView;
    private Bitmap coverBitmap;

    private static final Runnable ARM_TIMEOUT = () -> {
        if (!armed) return;
        InstantTranslateCaptureService service = activeService.get();
        disarm();
        InstantTranslateBridge.onTranslationCaptureFailed(
                "Instant Translate не показал готовый перевод за 35 секунд");
        if (service != null) {
            MAIN.postDelayed(() -> service.performGlobalAction(GLOBAL_ACTION_BACK), 120L);
            MAIN.postDelayed(service::hideCoverInternal, COVER_HIDE_AFTER_BACK_MS);
        } else {
            hideReaderCover();
        }
    };

    static void arm(String source) {
        sourceText = source == null ? "" : source.trim();
        armedAtMs = System.currentTimeMillis();
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
        armed = true;
        MAIN.removeCallbacks(ARM_TIMEOUT);
        MAIN.postDelayed(ARM_TIMEOUT, NATIVE_TIMEOUT_MS);
    }

    static void disarm() {
        armed = false;
        sourceText = "";
        armedAtMs = 0L;
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
        MAIN.removeCallbacks(ARM_TIMEOUT);
    }

    static void showReaderCover(Bitmap snapshot) {
        if (snapshot == null || snapshot.isRecycled()) return;
        InstantTranslateCaptureService service = activeService.get();
        if (service == null) {
            try { snapshot.recycle(); } catch (Exception ignored) {}
            return;
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            service.showCoverInternal(snapshot);
        } else {
            MAIN.post(() -> service.showCoverInternal(snapshot));
        }
    }

    static void hideReaderCover() {
        InstantTranslateCaptureService service = activeService.get();
        if (service == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) service.hideCoverInternal();
        else MAIN.post(service::hideCoverInternal);
    }

    private void showCoverInternal(Bitmap snapshot) {
        hideCoverInternal();
        try {
            windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
            if (windowManager == null) {
                snapshot.recycle();
                return;
            }

            ImageView image = new ImageView(this);
            image.setBackgroundColor(Color.BLACK);
            image.setScaleType(ImageView.ScaleType.FIT_XY);
            image.setImageBitmap(snapshot);

            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
            params.gravity = Gravity.TOP | Gravity.START;
            windowManager.addView(image, params);
            coverView = image;
            coverBitmap = snapshot;
        } catch (Exception error) {
            try { snapshot.recycle(); } catch (Exception ignored) {}
            coverView = null;
            coverBitmap = null;
        }
    }

    private void hideCoverInternal() {
        ImageView view = coverView;
        Bitmap bitmap = coverBitmap;
        coverView = null;
        coverBitmap = null;
        if (view != null && windowManager != null) {
            try { view.setImageDrawable(null); } catch (Exception ignored) {}
            try { windowManager.removeViewImmediate(view); } catch (Exception ignored) {}
        }
        if (bitmap != null && !bitmap.isRecycled()) {
            try { bitmap.recycle(); } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        activeService = new WeakReference<>(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!armed || event == null) return;
        CharSequence packageName = event.getPackageName();
        if (packageName == null
                || !InstantTranslateBridge.TARGET_PACKAGE.contentEquals(packageName)) return;

        long age = System.currentTimeMillis() - armedAtMs;
        long delay = age < MIN_CAPTURE_AGE_MS
                ? Math.max(140L, MIN_CAPTURE_AGE_MS - age)
                : 220L;
        MAIN.removeCallbacks(captureRunnable);
        MAIN.postDelayed(captureRunnable, delay);
    }

    private final Runnable captureRunnable = this::captureNow;

    private void captureNow() {
        if (!armed) return;
        AccessibilityNodeInfo root = findInstantTranslateRoot();
        if (root == null) return;
        try {
            List<String> texts = new ArrayList<>();
            collectTexts(root, texts, new HashSet<>());

            if (!sourceContextMatches(texts, sourceText) || !hasRussianTargetLabel(texts)) {
                resetStableCandidate();
                return;
            }

            String visibleError = findVisibleError(texts);
            if (!visibleError.isEmpty()) {
                disarm();
                InstantTranslateBridge.onTranslationCaptureFailed(visibleError);
                finishExternalWindow();
                return;
            }

            String best = chooseRussianTranslation(texts, sourceText);
            if (best.isEmpty()) {
                resetStableCandidate();
                return;
            }

            String normalized = normalizeSpace(best);
            long now = System.currentTimeMillis();
            if (normalized.equals(stableCandidate)) {
                stableHits++;
            } else {
                stableCandidate = normalized;
                stableHits = 1;
                stableSinceMs = now;
            }

            if (stableHits < 2 || now - stableSinceMs < STABLE_WINDOW_MS) {
                MAIN.removeCallbacks(captureRunnable);
                MAIN.postDelayed(captureRunnable, STABLE_WINDOW_MS + 80L);
                return;
            }

            disarm();
            InstantTranslateBridge.onTranslationCaptured(normalized);
            finishExternalWindow();
        } finally {
            try { root.recycle(); } catch (Exception ignored) {}
        }
    }

    private AccessibilityNodeInfo findInstantTranslateRoot() {
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows != null) {
                for (AccessibilityWindowInfo window : windows) {
                    if (window == null) continue;
                    AccessibilityNodeInfo root = null;
                    try {
                        root = window.getRoot();
                        CharSequence pkg = root == null ? null : root.getPackageName();
                        if (root != null && pkg != null
                                && InstantTranslateBridge.TARGET_PACKAGE.contentEquals(pkg)) {
                            return root;
                        }
                    } catch (Exception ignored) {
                    }
                    if (root != null) {
                        try { root.recycle(); } catch (Exception ignored) {}
                    }
                }
            }
        } catch (Exception ignored) {}

        AccessibilityNodeInfo active = getRootInActiveWindow();
        if (active == null) return null;
        CharSequence pkg = active.getPackageName();
        if (pkg != null && InstantTranslateBridge.TARGET_PACKAGE.contentEquals(pkg)) return active;
        try { active.recycle(); } catch (Exception ignored) {}
        return null;
    }

    private void finishExternalWindow() {
        MAIN.postDelayed(() -> performGlobalAction(GLOBAL_ACTION_BACK), 120L);
        MAIN.postDelayed(this::hideCoverInternal, COVER_HIDE_AFTER_BACK_MS);
    }

    private void resetStableCandidate() {
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
    }

    private void collectTexts(AccessibilityNodeInfo node, List<String> out, Set<String> seen) {
        if (node == null) return;
        addText(node.getText(), out, seen);
        addText(node.getContentDescription(), out, seen);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                collectTexts(child, out, seen);
            } finally {
                try { child.recycle(); } catch (Exception ignored) {}
            }
        }
    }

    private void addText(CharSequence value, List<String> out, Set<String> seen) {
        if (value == null) return;
        String text = normalizeSpace(value.toString().replace('\u00a0', ' '));
        if (text.isEmpty() || !seen.add(text)) return;
        out.add(text);
    }

    private boolean sourceContextMatches(List<String> texts, String source) {
        String sourceCjk = cjkOnly(source);
        StringBuilder all = new StringBuilder();
        for (String text : texts) all.append(cjkOnly(text));
        String allCjk = all.toString();

        if (sourceCjk.length() >= 6) {
            int probe = Math.min(9, Math.max(5, sourceCjk.length() / 5));
            String first = sourceCjk.substring(0, Math.min(probe, sourceCjk.length()));
            int midStart = Math.max(0, (sourceCjk.length() - probe) / 2);
            String middle = sourceCjk.substring(midStart,
                    Math.min(sourceCjk.length(), midStart + probe));
            String last = sourceCjk.substring(Math.max(0, sourceCjk.length() - probe));

            if (first.length() >= 7 && allCjk.contains(first)) return true;

            int matches = 0;
            if (!first.isEmpty() && allCjk.contains(first)) matches++;
            if (!middle.isEmpty() && allCjk.contains(middle)) matches++;
            if (!last.isEmpty() && allCjk.contains(last)) matches++;
            return sourceCjk.length() < 18 ? matches >= 1 : matches >= 2;
        }

        String normalizedSource = normalizeLoose(source);
        if (normalizedSource.length() < 5) return true;
        StringBuilder joined = new StringBuilder();
        for (String text : texts) joined.append(' ').append(normalizeLoose(text));
        return joined.toString().contains(normalizedSource);
    }

    private boolean hasRussianTargetLabel(List<String> texts) {
        for (String text : texts) {
            String lower = text.toLowerCase(Locale.ROOT);
            if (lower.equals("русский") || lower.startsWith("русский ")
                    || lower.contains(" русский")
                    || lower.equals("russian") || lower.startsWith("russian ")
                    || lower.contains(" russian")) return true;
        }
        return false;
    }

    private String findVisibleError(List<String> texts) {
        for (String text : texts) {
            String lower = text.toLowerCase(Locale.ROOT);
            if (lower.contains("не удалось") || lower.contains("ошибка перевода")
                    || lower.contains("попробуйте еще раз") || lower.contains("попробуйте ещё раз")
                    || lower.contains("нет подключения") || lower.contains("нет соединения")
                    || lower.contains("translation failed") || lower.contains("try again")
                    || lower.contains("no connection")) {
                return text.length() <= 220 ? text : "Instant Translate показал ошибку перевода";
            }
        }
        return "";
    }

    private String chooseRussianTranslation(List<String> texts, String source) {
        String best = "";
        int bestScore = Integer.MIN_VALUE;
        int sourceMeaningful = Math.max(countCjk(source), countLetters(source));
        int minLength = sourceMeaningful <= 16
                ? 8
                : Math.min(46, Math.max(14, sourceMeaningful / 3));

        for (String text : texts) {
            if (text == null) continue;
            String candidate = normalizeSpace(text);
            if (candidate.isEmpty() || candidate.equals(source)) continue;
            if (!isTranslationCandidate(candidate, minLength, sourceMeaningful)) continue;

            int cyrillic = countCyrillic(candidate);
            int words = countWords(candidate);
            int score = cyrillic * 8 + Math.min(candidate.length(), 700) + Math.min(words * 5, 80);
            if (candidate.length() >= Math.max(28, minLength * 2)) score += 70;

            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        return best;
    }

    private boolean isTranslationCandidate(String candidate, int minLength, int sourceMeaningful) {
        String lower = candidate.toLowerCase(Locale.ROOT);
        if (isKnownUiText(lower)) return false;
        if (candidate.length() < minLength) return false;
        if (countCjk(candidate) > 0) return false;

        int cyrillic = countCyrillic(candidate);
        int letters = countLetters(candidate);
        if (cyrillic < Math.max(6, minLength / 2)) return false;
        if (letters > 0 && cyrillic * 100 < letters * 52) return false;
        if (sourceMeaningful > 20 && countWords(candidate) < 4) return false;

        return !lower.contains("не удалось")
                && !lower.contains("ошибка перевода")
                && !lower.contains("попробуйте ещё раз")
                && !lower.contains("попробуйте еще раз")
                && !lower.contains("translation failed");
    }

    private boolean isKnownUiText(String lower) {
        String s = normalizeSpace(lower);
        return s.equals("русский")
                || s.equals("russian")
                || s.equals("перевод")
                || s.equals("перевод экрана")
                || s.equals("исходный текст")
                || s.equals("переведенный текст")
                || s.equals("переведённый текст")
                || s.startsWith("китайский")
                || s.startsWith("русский")
                || s.startsWith("chinese")
                || s.startsWith("russian")
                || s.startsWith("скопировать")
                || s.startsWith("поделиться")
                || s.startsWith("озвучить")
                || s.startsWith("настройки")
                || s.startsWith("история")
                || s.startsWith("закрыть");
    }

    private String normalizeSpace(String text) {
        return text == null ? "" : text.replaceAll("\\s+", " ").trim();
    }

    private String normalizeLoose(String text) {
        return normalizeSpace(text).toLowerCase(Locale.ROOT)
                .replaceAll("[\\p{Punct}«»„“”‘’—–…]+", "")
                .replace(" ", "");
    }

    private String cjkOnly(String text) {
        if (text == null) return "";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c >= '\u3400' && c <= '\u9fff') out.append(c);
        }
        return out.toString();
    }

    private int countCjk(String text) {
        return cjkOnly(text).length();
    }

    private int countCyrillic(String text) {
        int count = 0;
        if (text == null) return count;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c >= '\u0400' && c <= '\u04ff') || (c >= '\u0500' && c <= '\u052f')) count++;
        }
        return count;
    }

    private int countLetters(String text) {
        int count = 0;
        if (text == null) return count;
        for (int i = 0; i < text.length(); i++) {
            if (Character.isLetter(text.charAt(i))) count++;
        }
        return count;
    }

    private int countWords(String text) {
        String normalized = normalizeSpace(text);
        if (normalized.isEmpty()) return 0;
        return normalized.split(" ").length;
    }

    @Override
    public void onInterrupt() {
        // No persistent state is stored; a pending request will fail visibly.
    }

    @Override
    public void onDestroy() {
        if (activeService.get() == this) activeService = new WeakReference<>(null);
        disarm();
        MAIN.removeCallbacks(captureRunnable);
        hideCoverInternal();
        super.onDestroy();
    }
}
