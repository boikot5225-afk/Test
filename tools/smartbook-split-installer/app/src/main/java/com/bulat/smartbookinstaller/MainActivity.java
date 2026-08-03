package com.bulat.smartbookinstaller;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class MainActivity extends Activity {
    private static final int REQUEST_APKS = 1001;
    private static final int REQUEST_UNKNOWN_SOURCES = 1002;
    private static final String TARGET_PACKAGE = "com.kursx.smartbook";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private TextView statusView;
    private Button installButton;
    private ProgressBar progressBar;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();

        String resultMessage = getIntent().getStringExtra("result_message");
        if (resultMessage != null && !resultMessage.isBlank()) {
            setStatus(resultMessage);
        }
    }

    private void buildUi() {
        int padding = dp(24);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(padding, padding, padding, padding);

        TextView title = new TextView(this);
        title.setText("Установщик Smart Book");
        title.setTextSize(26);
        title.setGravity(Gravity.CENTER);
        root.addView(title, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView explanation = new TextView(this);
        explanation.setText("Выбери SmartBook-3.6-Chinese-Pinyin-v0.1.4.apks. Установщик сам передаст base.apk и все split APK системному установщику Android.");
        explanation.setTextSize(17);
        explanation.setPadding(0, dp(22), 0, dp(22));
        root.addView(explanation, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        installButton = new Button(this);
        installButton.setText("Выбрать .apks и установить");
        installButton.setOnClickListener(v -> beginSelection());
        root.addView(installButton, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        progressBar = new ProgressBar(this);
        progressBar.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(48), dp(48));
        progressParams.topMargin = dp(20);
        root.addView(progressBar, progressParams);

        statusView = new TextView(this);
        statusView.setText("Готово к выбору файла.");
        statusView.setTextSize(16);
        statusView.setPadding(0, dp(20), 0, 0);
        root.addView(statusView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    private void beginSelection() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            setStatus("Сначала разреши этому установщику установку неизвестных приложений, затем вернись и нажми кнопку ещё раз.");
            try {
                Intent settingsIntent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivityForResult(settingsIntent, REQUEST_UNKNOWN_SOURCES);
            } catch (ActivityNotFoundException e) {
                startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
            }
            return;
        }

        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType("application/zip");
        picker.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/zip",
                "application/octet-stream",
                "application/vnd.android.package-archive"
        });
        startActivityForResult(picker, REQUEST_APKS);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQUEST_UNKNOWN_SOURCES) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || getPackageManager().canRequestPackageInstalls()) {
                setStatus("Разрешение получено. Теперь выбери файл .apks.");
                beginSelection();
            } else {
                setStatus("Разрешение на установку приложений не выдано.");
            }
            return;
        }

        if (requestCode != REQUEST_APKS || resultCode != RESULT_OK || data == null) {
            return;
        }

        Uri uri = data.getData();
        if (uri == null) {
            setStatus("Файл не выбран.");
            return;
        }

        int takeFlags = data.getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            getContentResolver().takePersistableUriPermission(
                    uri,
                    takeFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // The one-time read grant is enough for the current install operation.
        }

        setBusy(true);
        setStatus("Читаю комплект и проверяю APK…");
        executor.execute(() -> installApks(uri));
    }

    private void installApks(Uri uri) {
        File workDir = new File(getCacheDir(), "smartbook-install-" + System.currentTimeMillis());
        if (!workDir.mkdirs() && !workDir.isDirectory()) {
            fail("Не удалось создать временную папку установщика.");
            return;
        }

        int sessionId = -1;
        try {
            List<File> apkFiles = extractApks(uri, workDir);
            apkFiles.sort(Comparator.comparing(file -> file.getName().equals("base.apk") ? "0" : "1" + file.getName()));

            boolean hasBase = false;
            for (File apk : apkFiles) {
                if (apk.getName().equals("base.apk")) {
                    hasBase = true;
                    break;
                }
            }
            if (!hasBase) {
                throw new IllegalArgumentException("В архиве отсутствует base.apk.");
            }
            if (apkFiles.size() < 2) {
                throw new IllegalArgumentException("В архиве нет split APK.");
            }

            updateStatus("Найдено APK: " + apkFiles.size() + ". Создаю системную сессию установки…");

            PackageInstaller packageInstaller = getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(TARGET_PACKAGE);
            params.setInstallLocation(PackageInstaller.SessionParams.INSTALL_LOCATION_AUTO);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE);
            }

            sessionId = packageInstaller.createSession(params);
            try (PackageInstaller.Session session = packageInstaller.openSession(sessionId)) {
                byte[] buffer = new byte[1024 * 1024];
                int index = 0;
                for (File apk : apkFiles) {
                    index++;
                    updateStatus("Передаю APK " + index + " из " + apkFiles.size() + ": " + apk.getName());
                    try (InputStream input = new BufferedInputStream(new FileInputStream(apk));
                         OutputStream output = new BufferedOutputStream(
                                 session.openWrite(apk.getName(), 0, apk.length()))) {
                        int read;
                        while ((read = input.read(buffer)) != -1) {
                            output.write(buffer, 0, read);
                        }
                        output.flush();
                        session.fsync(output);
                    }
                }

                Intent callbackIntent = new Intent(this, InstallResultReceiver.class);
                callbackIntent.setAction("com.bulat.smartbookinstaller.INSTALL_RESULT");
                callbackIntent.putExtra("session_id", sessionId);

                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    flags |= PendingIntent.FLAG_MUTABLE;
                }
                PendingIntent pendingIntent = PendingIntent.getBroadcast(
                        this,
                        sessionId,
                        callbackIntent,
                        flags);

                updateStatus("Все части переданы. Подтверди установку в системном окне Android.");
                session.commit(pendingIntent.getIntentSender());
            }

            runOnUiThread(() -> setBusy(false));
        } catch (Exception e) {
            if (sessionId >= 0) {
                try {
                    getPackageManager().getPackageInstaller().abandonSession(sessionId);
                } catch (Exception ignored) {
                }
            }
            fail(e.getClass().getSimpleName() + ": " + safeMessage(e));
        }
    }

    private List<File> extractApks(Uri uri, File workDir) throws Exception {
        List<File> files = new ArrayList<>();
        byte[] buffer = new byte[1024 * 1024];

        InputStream rawInput = getContentResolver().openInputStream(uri);
        if (rawInput == null) {
            throw new IllegalStateException("Android не дал открыть выбранный файл.");
        }

        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(rawInput))) {
            ZipEntry entry;
            int count = 0;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory() || !entry.getName().toLowerCase().endsWith(".apk")) {
                    zip.closeEntry();
                    continue;
                }

                count++;
                if (count > 40) {
                    throw new IllegalArgumentException("Слишком много APK внутри архива.");
                }

                String fileName = new File(entry.getName()).getName();
                File target = new File(workDir, String.format("%02d-%s", count, fileName));
                if (fileName.equals("base.apk")) {
                    target = new File(workDir, "base.apk");
                } else {
                    target = new File(workDir, fileName);
                }

                try (OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
                    int read;
                    while ((read = zip.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                    }
                }
                zip.closeEntry();

                if (target.length() < 1024) {
                    throw new IllegalArgumentException("Повреждённый APK: " + fileName);
                }
                try (InputStream check = new FileInputStream(target)) {
                    if (check.read() != 'P' || check.read() != 'K') {
                        throw new IllegalArgumentException("Неверная сигнатура APK: " + fileName);
                    }
                }
                files.add(target);
            }
        }

        if (files.isEmpty()) {
            throw new IllegalArgumentException("В выбранном архиве не найдено ни одного APK.");
        }
        return files;
    }

    private void setBusy(boolean busy) {
        installButton.setEnabled(!busy);
        progressBar.setVisibility(busy ? View.VISIBLE : View.GONE);
    }

    private void setStatus(String text) {
        statusView.setText(text);
    }

    private void updateStatus(String text) {
        runOnUiThread(() -> setStatus(text));
    }

    private void fail(String message) {
        runOnUiThread(() -> {
            setBusy(false);
            setStatus("Ошибка: " + message);
        });
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? "без описания" : message;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
    }
}
