package com.bulat.smartbookoverlay

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var statusView: TextView
    private lateinit var wordsCountView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(ScrollView(this).apply { addView(buildContent()) })
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(32), dp(24), dp(24))
        }

        root.addView(TextView(this).apply {
            text = "Пиньинь для Smart Book"
            textSize = 28f
            setTextColor(Color.rgb(20, 20, 20))
            gravity = Gravity.CENTER
        }, matchWrap(bottom = 12))

        root.addView(TextView(this).apply {
            text = "Оригинальный Smart Book остаётся без изменений. Служба находит слова, " +
                "которые Smart Book уже выделил красным как добавленные в изучение, и рисует " +
                "только маленький прозрачный пиньинь над ними."
            textSize = 17f
            setTextColor(Color.rgb(55, 55, 55))
        }, matchWrap(bottom = 20))

        statusView = TextView(this).apply {
            textSize = 18f
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(12), dp(12), dp(6))
        }
        root.addView(statusView, matchWrap())

        wordsCountView = TextView(this).apply {
            textSize = 16f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(70, 70, 70))
            setPadding(dp(12), dp(2), dp(12), dp(12))
        }
        root.addView(wordsCountView, matchWrap(bottom = 12))

        root.addView(button("1. Включить службу пиньиня") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }, matchWrap(bottom = 10))

        root.addView(button("2. Открыть Smart Book") {
            val launch = packageManager.getLaunchIntentForPackage(SMART_BOOK_PACKAGE)
            if (launch == null) openOfficialSmartBook() else startActivity(launch)
        }, matchWrap(bottom = 20))

        root.addView(TextView(this).apply {
            text = "Как это работает"
            textSize = 19f
            setTextColor(Color.rgb(30, 30, 30))
        }, matchWrap(bottom = 6))

        root.addView(TextView(this).apply {
            text = "Добавь слово в изучение штатной синей кнопкой Smart Book. Когда слово станет " +
                "красным, служба распознает его автоматически. Уже красные слова тоже подхватятся " +
                "при открытии абзаца — повторно нажимать плюс не нужно."
            textSize = 16f
            setTextColor(Color.rgb(65, 65, 65))
        }, matchWrap(bottom = 20))

        root.addView(TextView(this).apply {
            text = "Размер пиньиня"
            textSize = 17f
            setTextColor(Color.rgb(35, 35, 35))
        }, matchWrap(bottom = 4))

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        root.addView(SeekBar(this).apply {
            min = 7
            max = 16
            progress = prefs.getInt(PREF_RUBY_SIZE, DEFAULT_RUBY_SIZE)
                .coerceIn(min, max)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser) prefs.edit().putInt(PREF_RUBY_SIZE, progress).apply()
                }

                override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
            })
        }, matchWrap(bottom = 16))

        root.addView(button("Очистить локальный список пиньиня") {
            AlertDialog.Builder(this)
                .setTitle("Очистить список?")
                .setMessage("Список снова заполнится по красным словам при открытии Smart Book.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Очистить") { _, _ ->
                    TrackedWordStore(this).clear()
                    updateStatus()
                    Toast.makeText(this, "Локальный список очищен", Toast.LENGTH_SHORT).show()
                }
                .show()
        }, matchWrap(bottom = 20))

        root.addView(TextView(this).apply {
            text = "Интернет не используется. Если Smart Book не передаёт цвет текста службе " +
                "специальных возможностей, приложение локально проверяет цвет страницы через " +
                "системный снимок окна. Снимок никуда не отправляется и не сохраняется."
            textSize = 14f
            setTextColor(Color.rgb(95, 95, 95))
        }, matchWrap(bottom = 10))

        root.addView(button("Установить оригинальный Smart Book") {
            openOfficialSmartBook()
        }, matchWrap(bottom = 0))

        return root
    }

    private fun updateStatus() {
        val enabled = isAccessibilityServiceEnabled()
        statusView.text = if (enabled) "Служба включена" else "Служба выключена"
        statusView.setTextColor(
            if (enabled) Color.rgb(24, 120, 60) else Color.rgb(180, 45, 45),
        )

        val count = TrackedWordStore(this).snapshot().size
        wordsCountView.text = "Распознано изучаемых слов: $count"
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val expected = ComponentName(this, PinyinAccessibilityService::class.java)
        val raw = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return raw.split(':').mapNotNull(ComponentName::unflattenFromString).any { it == expected }
    }

    private fun openOfficialSmartBook() {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$SMART_BOOK_PACKAGE"))
        val web = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("https://play.google.com/store/apps/details?id=$SMART_BOOK_PACKAGE"),
        )
        runCatching { startActivity(market) }.recoverCatching { startActivity(web) }
    }

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        textSize = 16f
        isAllCaps = false
        setOnClickListener { action() }
    }

    private fun matchWrap(top: Int = 0, bottom: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val SMART_BOOK_PACKAGE = "com.kursx.smartbook"
        const val PREFS = "overlay_settings"
        const val PREF_TRACKED_WORDS = "tracked_words"
        const val PREF_RUBY_SIZE = "ruby_size_sp"
        const val DEFAULT_RUBY_SIZE = 10
    }
}
