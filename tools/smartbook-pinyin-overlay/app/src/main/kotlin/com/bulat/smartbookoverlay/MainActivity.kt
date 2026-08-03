package com.bulat.smartbookoverlay

import android.app.Activity
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
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContent())
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
        }, matchWrap(top = 0, bottom = 12))

        root.addView(TextView(this).apply {
            text = "Smart Book остаётся оригинальным: вход, аккаунт и подписка не ломаются. " +
                "Это приложение показывает отдельный слой с пиньинем над видимым китайским абзацем."
            textSize = 17f
            setTextColor(Color.rgb(55, 55, 55))
        }, matchWrap(bottom = 20))

        statusView = TextView(this).apply {
            textSize = 18f
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        root.addView(statusView, matchWrap(bottom = 16))

        root.addView(button("1. Включить службу пиньиня") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }, matchWrap(bottom = 10))

        root.addView(button("2. Открыть Smart Book") {
            val launch = packageManager.getLaunchIntentForPackage(SMART_BOOK_PACKAGE)
            if (launch == null) {
                openOfficialSmartBook()
            } else {
                startActivity(launch)
            }
        }, matchWrap(bottom = 10))

        root.addView(button("Установить оригинальный Smart Book") {
            openOfficialSmartBook()
        }, matchWrap(bottom = 10))

        root.addView(button("Удалить текущий Smart Book") {
            runCatching {
                startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:$SMART_BOOK_PACKAGE")))
            }.onFailure {
                Toast.makeText(this, "Smart Book не установлен", Toast.LENGTH_SHORT).show()
            }
        }, matchWrap(bottom = 24))

        root.addView(TextView(this).apply {
            text = "Размер текста и пиньиня"
            textSize = 17f
            setTextColor(Color.rgb(35, 35, 35))
        }, matchWrap(bottom = 4))

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        root.addView(SeekBar(this).apply {
            min = 16
            max = 30
            progress = prefs.getInt(PREF_TEXT_SIZE, DEFAULT_TEXT_SIZE)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser) prefs.edit().putInt(PREF_TEXT_SIZE, progress).apply()
                }

                override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
            })
        }, matchWrap(bottom = 20))

        root.addView(TextView(this).apply {
            text = "Служба ограничена пакетом Smart Book и не использует интернет. " +
                "В первой рабочей версии пиньинь показывается над всеми китайскими словами видимого абзаца."
            textSize = 14f
            setTextColor(Color.rgb(95, 95, 95))
        }, matchWrap(bottom = 0))

        return root
    }

    private fun updateStatus() {
        val enabled = isAccessibilityServiceEnabled()
        statusView.text = if (enabled) {
            "Служба включена"
        } else {
            "Служба выключена"
        }
        statusView.setTextColor(
            if (enabled) Color.rgb(24, 120, 60) else Color.rgb(180, 45, 45),
        )
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
        const val PREF_TEXT_SIZE = "text_size_sp"
        const val DEFAULT_TEXT_SIZE = 22
    }
}
