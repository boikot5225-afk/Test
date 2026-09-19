package space.saintjust.reader.stage1;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.webkit.JavascriptInterface;

import java.lang.ref.WeakReference;

/**
 * Позволяет странице сказать системе, что идёт работа, которую нельзя прерывать.
 *
 * Страница сама не может договориться с Android: сеть выдаёт система, и уход из
 * приложения для неё означает «можно резать». Отсюда и наблюдавшиеся зависания
 * запросов на восемнадцать минут при свёрнутом приложении.
 *
 * Мост намеренно тупой: две кнопки без параметров. Всё, что он умеет, — поднять
 * и опустить foreground-сервис, и ошибиться тут нечем.
 */
public class BackgroundWorkBridge {

    private final WeakReference<Activity> activityRef;

    public BackgroundWorkBridge(Activity activity) {
        this.activityRef = new WeakReference<>(activity);
    }

    /** Началась долгая работа: держим процесс живым. */
    @JavascriptInterface
    public boolean startTranscription() {
        return send(TranscriptionService.ACTION_START);
    }

    /** Работа кончилась — успехом, ошибкой или отменой, неважно. */
    @JavascriptInterface
    public boolean stopTranscription() {
        return send(TranscriptionService.ACTION_STOP);
    }

    private boolean send(String action) {
        final Activity activity = activityRef.get();
        if (activity == null) return false;
        try {
            final Intent intent = new Intent(activity, TranscriptionService.class);
            intent.setAction(action);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && TranscriptionService.ACTION_START.equals(action)) {
                activity.startForegroundService(intent);
            } else {
                activity.startService(intent);
            }
            return true;
        } catch (Exception e) {
            // Система может отказать (ограничения на запуск сервисов из фона).
            // Тогда распознавание работает как раньше — пока приложение открыто.
            return false;
        }
    }
}
