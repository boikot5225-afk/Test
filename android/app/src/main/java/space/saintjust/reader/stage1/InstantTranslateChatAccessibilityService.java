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
 * Drives Instant Translate Premium Chat for Reader's grammar action.
 *
 * toc74 fixes the failure seen in the toc73 recording:
 * - Send candidates must either have send semantics or be a tight clickable
 *   button at the right edge of the composer;
 * - a successful ACTION_CLICK is not trusted by itself: Reader confirms that
 *   the prompt actually left the composer before waiting for an AI response;
 * - failed sends are retried briefly and then fail fast instead of pretending
 *   a request was sent for another 30 seconds;
 * - return navigation presses Back only while an Instant Translate window is
 *   actually present, so it can no longer overshoot Reader into the launcher.
 */
public final class InstantTranslateChatAccessibilityService extends AccessibilityService {
    private static final int STAGE_FIND_CHAT = 1;
    private static final int STAGE_FIND_INPUT = 2;
    private static final int STAGE_SEND = 3;
    private static final int STAGE_CONFIRM_SEND = 4;
    private static final int STAGE_WAIT_RESPONSE = 5;

    private static final int MIN_CHAT_SCORE = 90;
    private static final int MIN_INPUT_SCORE = 120;
    private static final int MIN_STRONG_CHAT_INPUT_SCORE = 180;
    private static final int MIN_SEND_SCORE = 160;

    private static final long OVERALL_TIMEOUT_MS = 45_000L;
    private static final long FIND_CHAT_TIMEOUT_MS = 8_000L;
    private static final long FIND_INPUT_TIMEOUT_MS = 9_000L;
    private static final long SEND_TIMEOUT_MS = 8_000L;
    private static final long CONFIRM_SEND_TIMEOUT_MS = 3_000L;
    private static final long RESPONSE_TIMEOUT_MS = 32_000L;
    private static final long RESPONSE_STABLE_MS = 700L;
    private static final long SEND_CONFIRM_DELAY_MS = 650L;

    private static volatile boolean armed = false;
    private static volatile String promptText = "";
    private static volatile String sourceText = "";
    private static volatile int stage = STAGE_FIND_CHAT;
    private static volatile long stageStartedAtMs = 0L;
    private static volatile long sentAtMs = 0L;
    private static volatile long sendAttemptAtMs = 0L;
    private static volatile int sendAttemptCount = 0;
    private static volatile String stableCandidate = "";
    private static volatile int stableHits = 0;
    private static volatile long stableSinceMs = 0L;
    private static volatile String lastScreenSummary = "";

    private static volatile WeakReference<InstantTranslateChatAccessibilityService> activeService =
            new WeakReference<>(null);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private WindowManager windowManager;
    private ImageView coverView;
    private Bitmap coverBitmap;

    private static final Runnable OVERALL_TIMEOUT = () -> {
        if (!armed) return;
        InstantTranslateChatAccessibilityService service = activeService.get();
        String where = stageLabel(stage);
        String summary = lastScreenSummary;
        disarm();
        InstantTranslateChatBridge.onChatCaptureFailed(
                failureMessage("Instant AI остановился на этапе «" + where + "»", summary));
        if (service != null) service.finishExternalInternal();
        else hideReaderCover();
    };

    static void arm(String prompt, String source) {
        promptText = prompt == null ? "" : prompt.trim();
        sourceText = source == null ? "" : source.trim();
        stage = STAGE_FIND_CHAT;
        stageStartedAtMs = System.currentTimeMillis();
        sentAtMs = 0L;
        sendAttemptAtMs = 0L;
        sendAttemptCount = 0;
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
        lastScreenSummary = "";
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
        stageStartedAtMs = 0L;
        sentAtMs = 0L;
        sendAttemptAtMs = 0L;
        sendAttemptCount = 0;
        stableCandidate = "";
        stableHits = 0;
        stableSinceMs = 0L;
        lastScreenSummary = "";
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

    private static String failureMessage(String base, String summary) {
        String s = summary == null ? "" : summary.trim();
        if (s.isEmpty()) return base;
        String message = base + " · экран: " + s;
        return message.length() <= 300 ? message : message.substring(0, 297) + "…";
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
        else if (stage == STAGE_CONFIRM_SEND) limit = CONFIRM_SEND_TIMEOUT_MS;
        else limit = RESPONSE_TIMEOUT_MS;
        if (age <= limit) return false;

        String where = stageLabel(stage);
        String summary = lastScreenSummary;
        disarm();
        InstantTranslateChatBridge.onChatCaptureFailed(
                failureMessage("Instant AI: не прошёл этап «" + where + "»", summary));
        finishExternalInternal();
        return true;
    }

    private static String stageLabel(int value) {
        if (value == STAGE_FIND_CHAT) return "поиск Chat";
        if (value == STAGE_FIND_INPUT) return "поле сообщения";
        if (value == STAGE_SEND) return "отправка запроса";
        if (value == STAGE_CONFIRM_SEND) return "проверка отправки";
        return "ожидание ответа";
    }

    private void failNow(String message) {
        String summary = lastScreenSummary;
        disarm();
        InstantTranslateChatBridge.onChatCaptureFailed(failureMessage(message, summary));
        finishExternalInternal();
    }

    private void stepNow() {
        if (!armed || failIfStageTimedOut()) return;
        AccessibilityNodeInfo root = findTargetRoot();
        if (root == null) {
            scheduleStep(360L);
            return;
        }

        try {
            lastScreenSummary = summarizeScreen(root);

            if (stage == STAGE_FIND_CHAT) {
                AccessibilityNodeInfo existingChatInput = findStrongChatEditable(root);
                if (existingChatInput != null) {
                    try { existingChatInput.recycle(); } catch (Exception ignored) {}
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
                        scheduleStep(650L);
                        return;
                    }
                }
                scheduleStep(360L);
                return;
            }

            if (stage == STAGE_FIND_INPUT) {
                AccessibilityNodeInfo input = findBestEditable(root);
                if (input == null) {
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
                    sendAttemptCount = 0;
                    enterStage(STAGE_SEND);
                    scheduleStep(320L);
                } else {
                    scheduleStep(340L);
                }
                return;
            }

            if (stage == STAGE_SEND) {
                AccessibilityNodeInfo input = findBestEditable(root);
                AccessibilityNodeInfo send = findBestSendNode(root, input);
                boolean attempted = false;

                if (send != null) {
                    attempted = clickNodeOrAncestor(send);
                    try { send.recycle(); } catch (Exception ignored) {}
                }

                if (!attempted && input != null && Build.VERSION.SDK_INT >= 30) {
                    try {
                        attempted = input.performAction(
                                AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
                    } catch (Exception ignored) {}
                }

                if (input != null) {
                    try { input.recycle(); } catch (Exception ignored) {}
                }

                if (attempted) {
                    sendAttemptCount++;
                    sendAttemptAtMs = System.currentTimeMillis();
                    enterStage(STAGE_CONFIRM_SEND);
                    scheduleStep(SEND_CONFIRM_DELAY_MS);
                } else {
                    scheduleStep(340L);
                }
                return;
            }

            if (stage == STAGE_CONFIRM_SEND) {
                long sinceAttempt = System.currentTimeMillis() - sendAttemptAtMs;
                if (sinceAttempt < SEND_CONFIRM_DELAY_MS) {
                    scheduleStep(SEND_CONFIRM_DELAY_MS - sinceAttempt + 60L);
                    return;
                }

                if (!promptStillInComposer(root)) {
                    enterStage(STAGE_WAIT_RESPONSE);
                    sentAtMs = System.currentTimeMillis();
                    resetStable();
                    scheduleStep(650L);
                    return;
                }

                if (sinceAttempt < 1_350L) {
                    scheduleStep(420L);
                    return;
                }

                if (sendAttemptCount >= 2) {
                    failNow("Instant AI: кнопка Send не отправила запрос");
                    return;
                }

                enterStage(STAGE_SEND);
                scheduleStep(180L);
                return;
            }

            if (stage == STAGE_WAIT_RESPONSE) {
                if (System.currentTimeMillis() - sentAtMs < 650L) {
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

    private boolean isTargetWindowPresent() {
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows != null) {
                for (AccessibilityWindowInfo window : windows) {
                    if (window == null) continue;
                    AccessibilityNodeInfo root = null;
                    try {
                        root = window.getRoot();
                        CharSequence pkg = root == null ? null : root.getPackageName();
                        if (pkg != null && InstantTranslateChatBridge.TARGET_PACKAGE.contentEquals(pkg)) {
                            if (root != null) try { root.recycle(); } catch (Exception ignored) {}
                            return true;
                        }
                    } catch (Exception ignored) {}
                    if (root != null) try { root.recycle(); } catch (Exception ignored) {}
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    private AccessibilityNodeInfo findBestChatNode(AccessibilityNodeInfo root) {
        Candidate best = new Candidate();
        scanForChat(root, best);
        return best.takeIfAtLeast(MIN_CHAT_SCORE);
    }

    private void scanForChat(AccessibilityNodeInfo node, Candidate best) {
        if (node == null) return;
        String text = nodeText(node).toLowerCase(Locale.ROOT);
        String desc = nodeDesc(node).toLowerCase(Locale.ROOT);
        String id = nodeId(node).toLowerCase(Locale.ROOT);
        String all = text + " " + desc + " " + id;

        int score = 0;
        if (id.contains("chat")) score += 170;
        if (all.contains("ai_chat") || all.contains("aichat")) score += 160;
        if (text.equals("chat") || desc.equals("chat")
                || text.equals("чат") || desc.equals("чат")) score += 150;
        if (all.contains("ai assistant") || all.contains("ai_assistant")
                || all.contains("ии помощник")) score += 125;
        if (all.contains("ask screen") || all.contains("ask_screen")) score += 115;
        if (all.contains(" chat") || all.contains("chat ")
                || all.contains(" чат") || all.contains("чат ")) score += 105;
        if (text.equals("ai") || desc.equals("ai")
                || text.equals("ии") || desc.equals("ии")) score += 55;
        if (node.isClickable()) score += 30;
        if (node.isVisibleToUser()) score += 10;
        if (score > 0 && score > best.score) best.replace(node, score);

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { scanForChat(child, best); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private AccessibilityNodeInfo findStrongChatEditable(AccessibilityNodeInfo root) {
        Candidate best = new Candidate();
        scanForEditable(root, best, true);
        return best.takeIfAtLeast(MIN_STRONG_CHAT_INPUT_SCORE);
    }

    private AccessibilityNodeInfo findBestEditable(AccessibilityNodeInfo root) {
        Candidate best = new Candidate();
        scanForEditable(root, best, false);
        return best.takeIfAtLeast(MIN_INPUT_SCORE);
    }

    private void scanForEditable(AccessibilityNodeInfo node, Candidate best, boolean requireChatHint) {
        if (node == null) return;

        String clazz = node.getClassName() == null ? "" : node.getClassName().toString();
        String clazzLower = clazz.toLowerCase(Locale.ROOT);
        String text = nodeText(node).toLowerCase(Locale.ROOT);
        String desc = nodeDesc(node).toLowerCase(Locale.ROOT);
        String id = nodeId(node).toLowerCase(Locale.ROOT);
        String all = text + " " + desc + " " + id + " " + clazzLower;

        boolean hasSetText = hasAction(node, AccessibilityNodeInfo.ACTION_SET_TEXT);
        boolean editClass = clazzLower.contains("edittext") || clazzLower.contains("textfield");
        boolean idInput = id.contains("input") || id.contains("message") || id.contains("composer");
        boolean chatHint = id.contains("chat")
                || all.contains("ask anything")
                || all.contains("type a message")
                || all.contains("enter a message")
                || all.contains("write a message")
                || all.contains("message here")
                || all.contains("chat_placeholder")
                || all.contains("задайте вопрос")
                || all.contains("спросите что угодно")
                || all.contains("введите сообщение")
                || all.contains("напишите сообщение");

        boolean plausible = node.isEditable() || hasSetText || editClass || idInput || chatHint;
        if (plausible && (!requireChatHint || chatHint)) {
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            int score = 0;
            if (hasSetText) score += 220;
            if (node.isEditable()) score += 190;
            if (editClass) score += 150;
            if (idInput) score += 120;
            if (chatHint) score += 180;
            if (node.isFocusable()) score += 30;
            if (node.isVisibleToUser()) score += 15;
            score += Math.max(0, Math.min(90, r.top / 20));
            if (score > best.score) best.replace(node, score);
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { scanForEditable(child, best, requireChatHint); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private AccessibilityNodeInfo findBestSendNode(AccessibilityNodeInfo root, AccessibilityNodeInfo input) {
        Rect inputRect = new Rect();
        if (input != null) input.getBoundsInScreen(inputRect);
        Candidate best = new Candidate();
        scanForSend(root, inputRect, best);
        return best.takeIfAtLeast(MIN_SEND_SCORE);
    }

    private void scanForSend(AccessibilityNodeInfo node, Rect inputRect, Candidate best) {
        if (node == null) return;
        String text = nodeText(node).toLowerCase(Locale.ROOT);
        String desc = nodeDesc(node).toLowerCase(Locale.ROOT);
        String id = nodeId(node).toLowerCase(Locale.ROOT);
        String all = text + " " + desc + " " + id;

        boolean explicit = id.contains("send") || id.contains("submit")
                || all.contains("send") || all.contains("отправ")
                || all.contains("submit")
                || all.contains("paperplane") || all.contains("paper_plane")
                || all.contains("arrowup") || all.contains("arrow_up")
                || text.equals("↑") || desc.equals("↑")
                || text.equals("⬆") || desc.equals("⬆");
        boolean clickable = node.isClickable() || hasAction(node, AccessibilityNodeInfo.ACTION_CLICK);

        Rect r = new Rect();
        node.getBoundsInScreen(r);
        boolean tightGeometry = false;
        if (clickable && !inputRect.isEmpty() && !r.isEmpty()) {
            int width = r.width();
            int height = r.height();
            boolean buttonSized = width >= 24 && width <= 180 && height >= 24 && height <= 180;
            boolean sameRow = r.centerY() >= inputRect.top - 90
                    && r.centerY() <= inputRect.bottom + 90;
            int edgeSlack = Math.max(150, inputRect.width() / 4);
            boolean atRightEdge = r.centerX() >= inputRect.centerX()
                    && r.right >= inputRect.right - edgeSlack;
            tightGeometry = buttonSized && sameRow && atRightEdge;
        }

        if (explicit || tightGeometry) {
            int score = 0;
            if (explicit) score += 260;
            if (tightGeometry) score += 210;
            if (clickable) score += 55;
            if (node.isVisibleToUser()) score += 10;
            if (score > best.score) best.replace(node, score);
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try { scanForSend(child, inputRect, best); }
            finally { try { child.recycle(); } catch (Exception ignored) {} }
        }
    }

    private boolean promptStillInComposer(AccessibilityNodeInfo root) {
        AccessibilityNodeInfo input = findBestEditable(root);
        if (input == null) return false;
        String value;
        try {
            value = nodeText(input);
            if (value.isEmpty()) value = nodeDesc(input);
        } finally {
            try { input.recycle(); } catch (Exception ignored) {}
        }

        String current = normalizeLoose(value);
        String prompt = normalizeLoose(promptText);
        if (current.isEmpty() || prompt.isEmpty()) return false;
        if (current.equals(prompt)) return true;
        if (current.length() >= 40 && prompt.contains(current)) return true;
        if (prompt.length() >= 40) {
            String prefix = prompt.substring(0, Math.min(80, prompt.length()));
            return current.contains(prefix);
        }
        return false;
    }

    private boolean setNodeText(AccessibilityNodeInfo node, String text) {
        if (node == null || text == null || text.isEmpty()) return false;

        AccessibilityNodeInfo current = AccessibilityNodeInfo.obtain(node);
        for (int depth = 0; current != null && depth < 5; depth++) {
            try {
                current.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
                Bundle args = new Bundle();
                args.putCharSequence(
                        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                if (current.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                    try { current.recycle(); } catch (Exception ignored) {}
                    return true;
                }
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

    private boolean clickNodeOrAncestor(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node == null ? null : AccessibilityNodeInfo.obtain(node);
        for (int depth = 0; current != null && depth < 6; depth++) {
            try {
                if ((current.isClickable() || hasAction(current, AccessibilityNodeInfo.ACTION_CLICK))
                        && current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    try { current.recycle(); } catch (Exception ignored) {}
                    return true;
                }
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

    private boolean hasAction(AccessibilityNodeInfo node, int actionId) {
        if (node == null) return false;
        try {
            for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList()) {
                if (action.getId() == actionId) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private String summarizeScreen(AccessibilityNodeInfo root) {
        List<String> texts = new ArrayList<>();
        collectTexts(root, texts, new HashSet<>());
        List<String> chosen = new ArrayList<>();
        String promptLoose = normalizeLoose(promptText);
        String sourceLoose = normalizeLoose(sourceText);

        for (String raw : texts) {
            String text = normalizeSpace(raw);
            if (text.isEmpty()) continue;
            String loose = normalizeLoose(text);
            if (!promptLoose.isEmpty() && (loose.equals(promptLoose) || promptLoose.contains(loose))) continue;
            if (!sourceLoose.isEmpty() && loose.equals(sourceLoose)) continue;
            if (text.length() > 52) text = text.substring(0, 49) + "…";
            chosen.add(text);
            if (chosen.size() >= 5) break;
        }
        return join(chosen, " | ");
    }

    private String join(List<String> values, String separator) {
        StringBuilder out = new StringBuilder();
        for (String value : values) {
            if (value == null || value.isEmpty()) continue;
            if (out.length() > 0) out.append(separator);
            out.append(value);
        }
        return out.toString();
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
                || s.equals("recent conversations") || s.equals("недавние разговоры")
                || s.equals("ask anything") || s.equals("спросите что угодно")
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
        CharSequence value = node == null ? null : node.getText();
        return value == null ? "" : normalizeSpace(value.toString());
    }

    private String nodeDesc(AccessibilityNodeInfo node) {
        CharSequence value = node == null ? null : node.getContentDescription();
        return value == null ? "" : normalizeSpace(value.toString());
    }

    private String nodeId(AccessibilityNodeInfo node) {
        try {
            String value = node == null ? null : node.getViewIdResourceName();
            return value == null ? "" : value;
        } catch (Exception ignored) {
            return "";
        }
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
        MAIN.postDelayed(() -> backUntilReader(0), 80L);
        MAIN.postDelayed(this::hideCoverInternal, 1_800L);
    }

    private void backUntilReader(int attempt) {
        if (!isTargetWindowPresent()) {
            hideCoverInternal();
            return;
        }
        if (attempt >= 3) {
            hideCoverInternal();
            return;
        }
        try { performGlobalAction(GLOBAL_ACTION_BACK); } catch (Exception ignored) {}
        MAIN.postDelayed(() -> backUntilReader(attempt + 1), 420L);
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

        AccessibilityNodeInfo takeIfAtLeast(int minimum) {
            if (node == null) return null;
            if (score >= minimum) return node;
            try { node.recycle(); } catch (Exception ignored) {}
            node = null;
            return null;
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
