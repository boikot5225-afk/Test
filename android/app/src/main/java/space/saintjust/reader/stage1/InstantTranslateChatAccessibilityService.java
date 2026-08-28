package space.saintjust.reader.stage1;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
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
 * Drives only the installed Instant Translate Chat UI while a Reader grammar
 * request is armed. It never reads or exports credentials.
 *
 * toc72 fixes the toc71 overlay deadlock: a full-screen accessibility overlay
 * intentionally hides Instant Translate from the user, which also makes many
 * underlying nodes report isVisibleToUser() == false. Those nodes are still in
 * the target accessibility window and can be acted on, so discovery must not
 * discard them merely because our own protective overlay is above them.
 */
public final class InstantTranslateChatAccessibilityService extends AccessibilityService {
    private static final int STAGE_FIND_CHAT = 1;
    private static final int STAGE_FIND_INPUT = 2;
    private static final int STAGE_SEND = 3;
    private static final int STAGE_WAIT_RESPONSE = 4;

    private static volatile boolean armed = false;
    private static volatile String promptText = "";
    private static volatile String sourceText = "";
    private static volatile int stage = STAGE_FIND_CHAT;
    private static volatile long armedAtMs = 0L;
    private static volatile long stageStartedAtMs = 0L;
    private static volatile long sentAtMs = 0L;
    private static volatile String stableCandidate = "";
    private static volatile int stableHits = 0;
    private static volatile long stableSinceMs = 0L;
    private static volatile WeakReference<InstantTranslateChatAccessibilityService> activeService =
            new WeakReference<>(null);

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final long OVERALL_TIMEOUT_MS = 45_000L;
    private static final long FIND_CHAT_TIMEOUT_MS = 8_000L;
    private static final long FIND_INPUT_TIMEOUT_MS = 8_000L;
    private static final long SEND_TIMEOUT_MS = 7_000L;
    private static final long RESPONSE_TIMEOUT_MS = 32_000L;
    private static final long RESPONSE_STABLE_MS = 700L;
    private static final long COVER_HIDE_MS = 900L;

    private WindowManager windowManager;
    private ImageView coverView;
    private Bitmap coverBitmap;

    private static final Runnable OVERALL_TIMEOUT = () -> {
        if (!armed) return;
        InstantTranslateChatAccessibilityService service = activeService.get();
        String where = stageLabel(stage);
        disarm();
        InstantTranslateChatBridge.onChatCaptureFailed(
                "Instant AI остановился на этапе «" + where + "»");
        if (service != null) service.finishExternalInternal();
        else hideReaderCover();
    };

    static void arm(String prompt, String source) {
        promptText = prompt == null ? "" : prompt.trim();
        sourceText = source == null ? "" : source.trim();
        stage = STAGE_FIND_CHAT;
        armedAtMs = System.currentTimeMillis();
        stageStartedAtMs = armedAtMs;
        sentAtMs = 0L;
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
        armed = true;
        MAIN.removeCallbacks(OVERALL_TIMEOUT);
        MAIN.postDelayed(OVERALL_TIMEOUT, OVERALL_TIMEOUT_MS);
        InstantTranslateChatAccessibilityService service = activeService.get();
        if (service != null) MAIN.postDelayed(service.stepRunnable, 380L);
    }

    static void disarm() {
        armed = false;
        promptText = "";
        sourceText = "";
        stage = STAGE_FIND_CHAT;
        armedAtMs = 0L;
        stageStartedAtMs = 0L;
        sentAtMs = 0L;
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
        MAIN.removeCallbacks(OVERALL_TIMEOUT);
        InstantTranslateChatAccessibilityService service = activeService.get();
        if (service != null) MAIN.removeCallbacks(service.stepRunnable);
    }

    static void showReaderCover(Bitmap snapshot) {
        if (snapshot == null || snapshot.isRecycled()) return;
        InstantTranslateChatAccessibilityService service = activeService.get();
        if (service == null) {
            try { snapshot.recycle(); } catch (Exception ignored) {}
            return;
        }
        if (Looper.myLooper() == Looper.getMainLooper()) service.showCoverInternal(snapshot);
        else MAIN.post(() -> service.showCoverInternal(snapshot));
    }

    static void hideReaderCover() {
        InstantTranslateChatAccessibilityService service = activeService.get();
        if (service == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) service.hideCoverInternal();
        else MAIN.post(service::hideCoverInternal);
    }

    static void finishExternalWindowAndHide() {
        InstantTranslateChatAccessibilityService service = activeService.get();
        if (service != null) MAIN.post(service::finishExternalInternal);
        else hideReaderCover();
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
            // Consume touches so the user can never accidentally operate the
            // hidden Instant Translate window while automation is running.
            image.setOnTouchListener((view, event) -> true);

            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
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
        CharSequence pkg = event.getPackageName();
        if (pkg == null || !InstantTranslateChatBridge.TARGET_PACKAGE.contentEquals(pkg)) return;
        MAIN.removeCallbacks(stepRunnable);
        MAIN.postDelayed(stepRunnable, 220L);
    }

    private final Runnable stepRunnable = this::stepNow;

    private void scheduleStep(long delayMs) {
        if (!armed) return;
        MAIN.removeCallbacks(stepRunnable);
        MAIN.postDelayed(stepRunnable, delayMs);
    }

    private void enterStage(int nextStage) {
        stage = nextStage;
        stageStartedAtMs = System.currentTimeMillis();
    }

    private long stageAgeMs() {
        return stageStartedAtMs <= 0L ? 0L : System.currentTimeMillis() - stageStartedAtMs;
    }

    private boolean failIfStageTimedOut() {
        long age = stageAgeMs();
        long limit;
        if (stage == STAGE_FIND_CHAT) limit = FIND_CHAT_TIMEOUT_MS;
        else if (stage == STAGE_FIND_INPUT) limit = FIND_INPUT_TIMEOUT_MS;
        else if (stage == STAGE_SEND) limit = SEND_TIMEOUT_MS;
        else limit = RESPONSE_TIMEOUT_MS;
        if (age <= limit) return false;

        String where = stageLabel(stage);
        disarm();
        InstantTranslateChatBridge.onChatCaptureFailed(
                "Instant AI: не прошёл этап «" + where + "»");
        finishExternalInternal();
        return true;
    }

    private static String stageLabel(int value) {
        if (value == STAGE_FIND_CHAT) return "поиск Chat";
        if (value == STAGE_FIND_INPUT) return "поле сообщения";
        if (value == STAGE_SEND) return "отправка запроса";
        return "ожидание ответа";
    }

    private void stepNow() {
        if (!armed || failIfStageTimedOut()) return;
        AccessibilityNodeInfo root = findTargetRoot();
        if (root == null) {
            scheduleStep(360L);
            return;
        }
        try {
            if (stage == STAGE_FIND_CHAT) {
                AccessibilityNodeInfo input = findBestEditable(root);
                if (input != null) {
                    try { input.recycle(); } catch (Exception ignored) {}
                    enterStage(STAGE_FIND_INPUT);
                    scheduleStep(120L);
                    return;
                }

                AccessibilityNodeInfo chat = findBestChatNode(root);
                if (chat != null) {
                    boolean clicked = clickNodeOrAncestor(chat);
                    try { chat.recycle(); } catch (Exception ignored) {}
                    if (clicked) {
                        enterStage(STAGE_FIND_INPUT);
                        scheduleStep(520L);
                        return;
                    }
                }
                scheduleStep(360L);
                return;
            }

            if (stage == STAGE_FIND_INPUT) {
                AccessibilityNodeInfo input = findBestEditable(root);
                if (input == null) {
                    // A slow Home -> Chat transition can leave us on Home for a
                    // moment. Re-try the Chat entry without resetting watchdog.
                    AccessibilityNodeInfo chat = findBestChatNode(root);
                    if (chat != null) {
                        clickNodeOrAncestor(chat);
                        try { chat.recycle(); } catch (Exception ignored) {}
                    }
                    scheduleStep(360L);
                    return;
                }
                boolean set = setNodeText(input, promptText);
                try { input.recycle(); } catch (Exception ignored) {}
                if (set) {
                    enterStage(STAGE_SEND);
                    scheduleStep(260L);
                } else {
                    scheduleStep(340L);
                }
                return;
            }

            if (stage == STAGE_SEND) {
                AccessibilityNodeInfo input = findBestEditable(root);
                AccessibilityNodeInfo send = findBestSendNode(root, input);
                boolean sent = false;
                if (send != null) {
                    sent = clickNodeOrAncestor(send);
                    try { send.recycle(); } catch (Exception ignored) {}
                }
                if (!sent && input != null && Build.VERSION.SDK_INT >= 30) {
                    try {
                        sent = input.performAction(
                                AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
                    } catch (Exception ignored) {}
                }
                if (input != null) {
                    try { input.recycle(); } catch (Exception ignored) {}
                }
                if (sent) {
                    enterStage(STAGE_WAIT_RESPONSE);
                    sentAtMs = System.currentTimeMillis();
                    resetStable();
                    scheduleStep(760L);
                } else {
                    scheduleStep(340L);
                }
                return;
            }

            if (stage == STAGE_WAIT_RESPONSE) {
                if (System.currentTimeMillis() - sentAtMs < 700L) {
                    scheduleStep(320L);
                    return;
                }
                List<String> texts = new ArrayList<>();
                collectTexts(root, texts, new HashSet<>());
                String visibleError = findVisibleError(texts);
                if (!visibleError.isEmpty()) {
                    disarm();
                    InstantTranslateChatBridge.onChatCaptureFailed(visibleError);
                    finishExternalInternal();
                    return;
                }

                String response = chooseChatResponse(texts);
                if (response.isEmpty()) {
                    resetStable();
                    scheduleStep(420L);
                    return;
                }

                long now = System.currentTimeMillis();
                if (response.equals(stableCandidate)) {
                    stableHits++;
                } else {
                    stableCandidate = response;
                    stableHits = 1;
                    stableSinceMs = now;
                }
                if (stableHits < 2 || now - stableSinceMs < RESPONSE_STABLE_MS) {
                    scheduleStep(RESPONSE_STABLE_MS + 90L);
                    return;
                }

                disarm();
                InstantTranslateChatBridge.onChatCaptured(response);
                finishExternalInternal();
            }
        } finally {
            try { root.recycle(); } catch (Exception ignored) {}
        }
    }

    private AccessibilityNodeInfo findTargetRoot() {
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
                                && InstantTranslateChatBridge.TARGET_PACKAGE.contentEquals(pkg)) {
                            return root;
                        }
                    } catch (Exception ignored) {}
                    if (root != null) {
                        try { root.recycle(); } catch (Exception ignored) {}
                    }
                }
            }
        } catch (Exception ignored) {}

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        CharSequence pkg = root.getPackageName();
        if (pkg != null && InstantTranslateChatBridge.TARGET_PACKAGE.contentEquals(pkg)) return root;
        try { root.recycle(); } catch (Exception ignored) {}
        return null;
    }

    private AccessibilityNodeInfo findBestChatNode(AccessibilityNodeInfo root) {
        Candidate best = new Candidate();
        scanForChat(root, best);
        return best.node;
    }

    private void scanForChat(AccessibilityNodeInfo node, Candidate best) {
        if (node == null) return;
        int score = 0;
        String text = nodeText(node).toLowerCase(Locale.ROOT);
        String desc = nodeDesc(node).toLowerCase(Locale.ROOT);
        String id = nodeId(node).toLowerCase(Locale.ROOT);
        String all = text + " " + desc + " " + id;
        if (id.contains("chat")) score += 160;
        if (all.contains("ai_chat") || all.contains("aichat")) score += 150;
        if (text.equals("chat") || desc.equals("chat") || text.equals("чат") || desc.equals("чат")) score += 140;
        if (all.contains(" chat") || all.contains("chat ") || all.contains(" чат") || all.contains("чат ")) score += 100;
        if (text.equals("ai") || desc.equals("ai") || text.equals("ии") || desc.equals("ии")) score += 55;
        if (node.isClickable()) score += 30;
        if (node.isVisibleToUser()) score += 10; // boost only; never a requirement under our overlay
        if (score > best.score) best.replace(node, score);

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { scanForChat(child, best); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private AccessibilityNodeInfo findBestEditable(AccessibilityNodeInfo root) {
        Candidate best = new Candidate();
        scanForEditable(root, best);
        return best.node;
    }

    private void scanForEditable(AccessibilityNodeInfo node, Candidate best) {
        if (node == null) return;
        String clazz = node.getClassName() == null ? "" : node.getClassName().toString();
        String id = nodeId(node).toLowerCase(Locale.ROOT);
        boolean editable = node.isEditable() || clazz.contains("EditText")
                || id.contains("input") || id.contains("message");
        if (editable) {
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            int score = 100 + Math.max(0, r.top / 10);
            if (node.isEditable()) score += 80;
            if (id.contains("chat") || id.contains("message") || id.contains("input")) score += 70;
            if (node.isVisibleToUser()) score += 20; // overlay can legitimately make this false
            if (score > best.score) best.replace(node, score);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { scanForEditable(child, best); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private AccessibilityNodeInfo findBestSendNode(AccessibilityNodeInfo root, AccessibilityNodeInfo input) {
        Rect inputRect = new Rect();
        if (input != null) input.getBoundsInScreen(inputRect);
        Candidate best = new Candidate();
        scanForSend(root, inputRect, best);
        return best.node;
    }

    private void scanForSend(AccessibilityNodeInfo node, Rect inputRect, Candidate best) {
        if (node == null) return;
        String text = nodeText(node).toLowerCase(Locale.ROOT);
        String desc = nodeDesc(node).toLowerCase(Locale.ROOT);
        String id = nodeId(node).toLowerCase(Locale.ROOT);
        String all = text + " " + desc + " " + id;
        int score = 0;
        if (id.contains("send")) score += 180;
        if (all.contains("send") || all.contains("отправ")) score += 150;
        if (all.contains("paperplane") || all.contains("arrowup") || all.contains("arrow_up")) score += 110;
        if (node.isClickable()) score += 35;
        if (node.isVisibleToUser()) score += 15; // boost only; our overlay may obscure it

        Rect r = new Rect();
        node.getBoundsInScreen(r);
        if (!inputRect.isEmpty()) {
            int cy = (r.top + r.bottom) / 2;
            int inputCy = (inputRect.top + inputRect.bottom) / 2;
            if (Math.abs(cy - inputCy) < 180 && r.left >= inputRect.centerX()) score += 80;
        }
        if (score > best.score) best.replace(node, score);

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { scanForSend(child, inputRect, best); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private boolean setNodeText(AccessibilityNodeInfo node, String text) {
        if (node == null || text == null || text.isEmpty()) return false;
        try {
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean clickNodeOrAncestor(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node == null ? null : AccessibilityNodeInfo.obtain(node);
        for (int depth = 0; current != null && depth < 6; depth++) {
            try {
                if ((current.isClickable() || hasClickAction(current))
                        && current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
                AccessibilityNodeInfo parent = current.getParent();
                try { current.recycle(); } catch (Exception ignored) {}
                current = parent;
            } catch (Exception ignored) {
                try { current.recycle(); } catch (Exception ignored2) {}
                current = null;
            }
        }
        if (current != null) try { current.recycle(); } catch (Exception ignored) {}
        return false;
    }

    private boolean hasClickAction(AccessibilityNodeInfo node) {
        try {
            for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList()) {
                if (action.getId() == AccessibilityNodeInfo.ACTION_CLICK) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private void collectTexts(AccessibilityNodeInfo node, List<String> out, Set<String> seen) {
        if (node == null) return;
        addText(node.getText(), out, seen);
        addText(node.getContentDescription(), out, seen);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { collectTexts(child, out, seen); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private void addText(CharSequence value, List<String> out, Set<String> seen) {
        if (value == null) return;
        String text = normalizeSpace(value.toString().replace('\u00a0', ' '));
        if (text.isEmpty() || !seen.add(text)) return;
        out.add(text);
    }

    private String chooseChatResponse(List<String> texts) {
        String best = "";
        int bestScore = Integer.MIN_VALUE;
        String promptLoose = normalizeLoose(promptText);
        String sourceLoose = normalizeLoose(sourceText);

        for (String raw : texts) {
            String text = normalizeSpace(raw);
            if (text.isEmpty() || isKnownUiText(text)) continue;
            String loose = normalizeLoose(text);
            if (!promptLoose.isEmpty() && (loose.equals(promptLoose)
                    || (loose.length() > 120 && promptLoose.contains(loose)))) continue;
            if (!sourceLoose.isEmpty() && loose.equals(sourceLoose)) continue;
            if (text.contains("Ответь СТРОГО") || text.contains("Исходный текст:")) continue;

            int cyr = countCyrillic(text);
            int score = Math.min(text.length(), 4000) + cyr * 4;
            String lower = text.toLowerCase(Locale.ROOT);
            if (lower.contains("\"parts\"") && lower.contains("\"summary\"")) score += 1800;
            if (text.startsWith("{") && text.endsWith("}")) score += 700;
            if (cyr < 18 && !lower.contains("\"parts\"")) continue;
            if (text.length() < 45) continue;

            if (score > bestScore) {
                bestScore = score;
                best = text;
            }
        }
        return best;
    }

    private String findVisibleError(List<String> texts) {
        for (String text : texts) {
            String lower = text.toLowerCase(Locale.ROOT);
            if (lower.contains("try again") || lower.contains("something went wrong")
                    || lower.contains("no connection") || lower.contains("network error")
                    || lower.contains("попробуйте ещё раз") || lower.contains("попробуйте еще раз")
                    || lower.contains("нет соединения") || lower.contains("ошибка сети")
                    || lower.contains("лимит") || lower.contains("quota")) {
                return text.length() < 240 ? text : "Instant AI Chat показал ошибку";
            }
        }
        return "";
    }

    private boolean isKnownUiText(String text) {
        String s = normalizeSpace(text).toLowerCase(Locale.ROOT);
        return s.equals("chat") || s.equals("чат") || s.equals("ai") || s.equals("ии")
                || s.equals("send") || s.equals("отправить")
                || s.equals("new chat") || s.equals("новый чат")
                || s.equals("history") || s.equals("история")
                || s.equals("settings") || s.equals("настройки")
                || s.equals("translate") || s.equals("перевести")
                || s.equals("copy") || s.equals("копировать")
                || s.equals("regenerate") || s.equals("повторить");
    }

    private void resetStable() {
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
    }

    private String nodeText(AccessibilityNodeInfo node) {
        CharSequence v = node == null ? null : node.getText();
        return v == null ? "" : normalizeSpace(v.toString());
    }

    private String nodeDesc(AccessibilityNodeInfo node) {
        CharSequence v = node == null ? null : node.getContentDescription();
        return v == null ? "" : normalizeSpace(v.toString());
    }

    private String nodeId(AccessibilityNodeInfo node) {
        try {
            String v = node == null ? null : node.getViewIdResourceName();
            return v == null ? "" : v;
        } catch (Exception ignored) { return ""; }
    }

    private String normalizeSpace(String text) {
        return text == null ? "" : text.replaceAll("\\s+", " ").trim();
    }

    private String normalizeLoose(String text) {
        return normalizeSpace(text).toLowerCase(Locale.ROOT)
                .replaceAll("[\\p{Punct}«»„“”‘’—–…]+", "")
                .replace(" ", "");
    }

    private int countCyrillic(String text) {
        int count = 0;
        if (text == null) return 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c >= '\u0400' && c <= '\u04ff') || (c >= '\u0500' && c <= '\u052f')) count++;
        }
        return count;
    }

    private void finishExternalInternal() {
        MAIN.removeCallbacks(stepRunnable);
        // Normal path is Reader -> Instant home -> Chat, therefore two backs.
        MAIN.postDelayed(() -> performGlobalAction(GLOBAL_ACTION_BACK), 90L);
        MAIN.postDelayed(() -> performGlobalAction(GLOBAL_ACTION_BACK), 390L);
        MAIN.postDelayed(this::hideCoverInternal, COVER_HIDE_MS);
    }

    private static final class Candidate {
        AccessibilityNodeInfo node;
        int score = Integer.MIN_VALUE;

        void replace(AccessibilityNodeInfo source, int nextScore) {
            if (source == null || nextScore <= score) return;
            if (node != null) {
                try { node.recycle(); } catch (Exception ignored) {}
            }
            node = AccessibilityNodeInfo.obtain(source);
            score = nextScore;
        }
    }

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        if (activeService.get() == this) activeService = new WeakReference<>(null);
        disarm();
        hideCoverInternal();
        super.onDestroy();
    }
}
