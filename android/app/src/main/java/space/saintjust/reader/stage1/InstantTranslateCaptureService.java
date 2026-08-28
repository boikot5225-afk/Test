package space.saintjust.reader.stage1;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Reads only the visible UI tree of Instant Translate while a Reader request is armed. */
public final class InstantTranslateCaptureService extends AccessibilityService {
    private static volatile boolean armed = false;
    private static volatile String sourceText = "";
    private static volatile long armedAtMs = 0L;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    static void arm(String source) {
        sourceText = source == null ? "" : source.trim();
        armedAtMs = System.currentTimeMillis();
        armed = true;
    }

    static void disarm() {
        armed = false;
        sourceText = "";
        armedAtMs = 0L;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!armed || event == null) return;
        CharSequence packageName = event.getPackageName();
        if (packageName == null
                || !InstantTranslateBridge.TARGET_PACKAGE.contentEquals(packageName)) return;

        // Give the popup a moment to replace its loading state with the translation.
        if (System.currentTimeMillis() - armedAtMs < 350L) {
            MAIN.removeCallbacks(captureRunnable);
            MAIN.postDelayed(captureRunnable, 400L);
            return;
        }
        MAIN.removeCallbacks(captureRunnable);
        MAIN.postDelayed(captureRunnable, 180L);
    }

    private final Runnable captureRunnable = this::captureNow;

    private void captureNow() {
        if (!armed) return;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            List<String> texts = new ArrayList<>();
            collectTexts(root, texts, new HashSet<>());
            String best = chooseRussianTranslation(texts, sourceText);
            if (best.isEmpty()) return;

            disarm();
            InstantTranslateBridge.onTranslationCaptured(best);
            MAIN.postDelayed(() -> performGlobalAction(GLOBAL_ACTION_BACK), 180L);
        } finally {
            try { root.recycle(); } catch (Exception ignored) {}
        }
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
        String text = value.toString().replace('\u00a0', ' ').trim();
        if (text.isEmpty() || !seen.add(text)) return;
        out.add(text);
    }

    private String chooseRussianTranslation(List<String> texts, String source) {
        String best = "";
        int bestScore = Integer.MIN_VALUE;
        for (String text : texts) {
            if (text == null) continue;
            String candidate = text.trim();
            if (candidate.isEmpty() || candidate.equals(source)) continue;

            int cyrillic = countCyrillic(candidate);
            if (cyrillic < 4) continue;

            String lower = candidate.toLowerCase();
            if (lower.equals("русский") || lower.equals("перевод")
                    || lower.startsWith("скопировать") || lower.startsWith("поделиться")) {
                continue;
            }

            int score = cyrillic * 6 + Math.min(candidate.length(), 500);
            if (candidate.length() >= 20) score += 60;
            if (candidate.indexOf('。') >= 0 || candidate.matches(".*[\\u4E00-\\u9FFF].*")) score -= 120;

            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        return best;
    }

    private int countCyrillic(String text) {
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c >= '\u0400' && c <= '\u04ff') || (c >= '\u0500' && c <= '\u052f')) count++;
        }
        return count;
    }

    @Override
    public void onInterrupt() {
        // Nothing persistent is recorded; a pending request simply times out in Reader AI.
    }
}
