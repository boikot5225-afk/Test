package space.saintjust.reader.stage1;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Держит распознавание аудио живым, пока пользователь вне приложения.
 *
 * Зачем это вообще нужно. Android гасит фоновым приложениям сеть: уход из
 * приложения и особенно выключение экрана переводят процесс в Doze, радио
 * паркуется, открытые сокеты рвутся, а новые получают связь короткими окнами.
 * Для WebView это выглядит как «запрос завис и умер» — ровно то, что видел
 * пользователь: одна попытка держалась 1088 секунд и отвалилась.
 *
 * Обойти это со стороны JavaScript нельзя никак: сколько ни повторяй запрос,
 * сеть выдаёт система, а не страница. Единственный санкционированный способ
 * сказать «идёт работа, которую нельзя прерывать» — foreground-сервис с
 * уведомлением. Пока он жив, процесс не считается фоновым, Doze его не трогает,
 * и заливка фрагмента доходит до конца при выключенном экране.
 *
 * Уведомление здесь не украшение, а цена сделки: система разрешает работать в
 * обмен на то, что человек эту работу видит и может остановить.
 *
 * Wake lock частичный: держит процессор, но не экран. Экран гасить можно и
 * нужно — распознавание не требует, чтобы на него смотрели.
 */
public class TranscriptionService extends Service {

    private static final String CHANNEL_ID = "reader_transcription";
    private static final int NOTIFICATION_ID = 4210;
    private static final String WAKE_TAG = "ReaderAI:transcription";

    public static final String ACTION_START = "space.saintjust.reader.TRANSCRIPTION_START";
    public static final String ACTION_STOP = "space.saintjust.reader.TRANSCRIPTION_STOP";

    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            releaseWakeLock();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundSafely();
        acquireWakeLock();
        // START_STICKY попросил бы систему воскресить сервис после убийства
        // процесса, но воскрешать нечего: задача жила в странице, которая ушла
        // вместе с процессом. Честнее не притворяться.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    private void startForegroundSafely() {
        createChannel();
        final Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14 требует назвать тип работы явно. Распознавание —
                // это выгрузка данных на сервер и получение результата.
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            // Если система отказала (нет разрешения на уведомления и т.п.),
            // сервис работать не сможет. Падать нельзя: распознавание должно
            // продолжиться так, как умеет — то есть пока приложение открыто.
            stopSelf();
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        final NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        final NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Распознавание аудио",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Показывается, пока идёт расшифровка записи в текст");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        final Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        final int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        final PendingIntent tap = PendingIntent.getActivity(this, 0, open, flags);

        final Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("Распознаю запись")
                .setContentText("Можно свернуть приложение и выключить экран")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        final PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG);
        wakeLock.setReferenceCounted(false);
        // Потолок на случай, если страница умрёт, не сказав «стоп»: держать
        // процессор бесконечно из-за потерянной задачи нельзя.
        wakeLock.acquire(2 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock == null) return;
        try {
            if (wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // Отпускание уже отпущенного не должно ронять сервис.
        }
        wakeLock = null;
    }
}
