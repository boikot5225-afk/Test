package com.bulat.smartbookoverlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.text.SpannableStringBuilder
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import android.widget.Toast
import smartbook.pinyin.ChineseSegmenter
import smartbook.pinyin.MapChineseLexicon
import smartbook.pinyin.PinyinMode
import smartbook.pinyin.PinyinPlanner
import smartbook.pinyin.android.SmartBookPinyinApplier
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

class PinyinAccessibilityService : AccessibilityService() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val renderRunnable = Runnable { renderCurrentParagraph() }
    private val firstShown = AtomicBoolean(false)

    @Volatile
    private var planner: PinyinPlanner? = null

    private lateinit var windowManager: WindowManager
    private var overlayView: TextView? = null
    private var overlayParams: WindowManager.LayoutParams? = null
    private var lastText: String? = null
    private var lastBounds: Rect? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        loadDictionary()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val packageName = event?.packageName?.toString()
        if (packageName != MainActivity.SMART_BOOK_PACKAGE) {
            hideOverlay()
            return
        }
        mainHandler.removeCallbacks(renderRunnable)
        mainHandler.postDelayed(renderRunnable, 140L)
    }

    override fun onInterrupt() {
        hideOverlay()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        hideOverlay()
        super.onDestroy()
    }

    private fun loadDictionary() {
        Thread({
            runCatching {
                assets.open(LEXICON_ASSET).use(MapChineseLexicon::fromTsv)
            }.onSuccess { lexicon ->
                planner = PinyinPlanner(lexicon)
                mainHandler.post { renderCurrentParagraph() }
            }.onFailure { error ->
                mainHandler.post {
                    Toast.makeText(
                        this,
                        "Не удалось загрузить словарь пиньиня: ${error.javaClass.simpleName}",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }, "pinyin-overlay-dictionary").apply {
            isDaemon = true
            start()
        }
    }

    private fun renderCurrentParagraph() {
        val currentPlanner = planner ?: return
        val root = rootInActiveWindow ?: run {
            hideOverlay()
            return
        }

        val candidate = try {
            findBestChineseText(root)
        } finally {
            root.recycle()
        } ?: run {
            hideOverlay()
            return
        }

        if (candidate.text == lastText && candidate.bounds == lastBounds) return

        val annotations = currentPlanner.plan(
            text = candidate.text,
            mode = PinyinMode.ALL,
            isLearnt = { false },
        )
        if (annotations.isEmpty()) {
            hideOverlay()
            return
        }

        val rendered = SpannableStringBuilder(candidate.text)
        SmartBookPinyinApplier.apply(rendered, annotations)
        showOverlay(rendered, candidate.bounds)
        lastText = candidate.text
        lastBounds = Rect(candidate.bounds)

        if (firstShown.compareAndSet(false, true)) {
            Toast.makeText(this, "Пиньинь включён", Toast.LENGTH_SHORT).show()
        }
    }

    private fun findBestChineseText(root: AccessibilityNodeInfo): Candidate? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(AccessibilityNodeInfo.obtain(root))
        var best: Candidate? = null

        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            try {
                if (node.isVisibleToUser) {
                    evaluateNode(node)?.let { candidate ->
                        if (best == null || candidate.score > best!!.score) best = candidate
                    }
                }
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let(queue::addLast)
                }
            } finally {
                node.recycle()
            }
        }
        return best
    }

    private fun evaluateNode(node: AccessibilityNodeInfo): Candidate? {
        val packageName = node.packageName?.toString() ?: return null
        if (packageName != MainActivity.SMART_BOOK_PACKAGE) return null

        val source = node.text ?: return null
        val text = source.toString().trim()
        if (text.length !in 4..MAX_TEXT_LENGTH) return null

        val hanCount = countHan(text)
        if (hanCount < 2) return null

        val bounds = Rect().also(node::getBoundsInScreen)
        if (bounds.width() < dp(120) || bounds.height() < dp(24)) return null

        val className = node.className?.toString().orEmpty()
        var score = hanCount * 40 + text.length
        if (className == READER_TEXT_CLASS) score += 100_000
        else if (className.contains("ReaderText", ignoreCase = true)) score += 50_000
        else if (className.contains("TextView", ignoreCase = true)) score += 4_000
        if (node.isTextSelectable) score += 2_000
        score += (bounds.width() * bounds.height() / 5_000).coerceAtMost(2_000)

        return Candidate(text, bounds, score)
    }

    private fun showOverlay(text: CharSequence, sourceBounds: Rect) {
        val textSize = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
            .getInt(MainActivity.PREF_TEXT_SIZE, MainActivity.DEFAULT_TEXT_SIZE)
            .toFloat()

        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val backgroundColor = if (dark) Color.argb(244, 24, 24, 24) else Color.argb(246, 255, 255, 255)
        val foregroundColor = if (dark) Color.WHITE else Color.rgb(25, 25, 25)

        val view = overlayView ?: TextView(this).apply {
            gravity = Gravity.START
            includeFontPadding = true
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setLineSpacing(dp(2).toFloat(), 1.05f)
            ellipsize = null
            maxLines = 30
            breakStrategy = Layout.BREAK_STRATEGY_SIMPLE
            hyphenationFrequency = Layout.HYPHENATION_FREQUENCY_NONE
            elevation = dp(8).toFloat()
            this@PinyinAccessibilityService.overlayView = this
        }
        view.textSize = textSize
        view.setTextColor(foregroundColor)
        view.background = GradientDrawable().apply {
            setColor(backgroundColor)
            cornerRadius = dp(10).toFloat()
            setStroke(dp(1), if (dark) Color.DKGRAY else Color.LTGRAY)
        }
        view.setText(text, TextView.BufferType.SPANNABLE)

        val screenWidth = resources.displayMetrics.widthPixels
        val width = sourceBounds.width().coerceIn(dp(180), screenWidth)
        val x = sourceBounds.left.coerceIn(0, max(0, screenWidth - width))
        val y = max(0, sourceBounds.top - dp(4))

        val params = overlayParams ?: WindowManager.LayoutParams(
            width,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            overlayParams = this
        }
        params.width = width
        params.height = WindowManager.LayoutParams.WRAP_CONTENT
        params.x = x
        params.y = y

        if (view.parent == null) {
            windowManager.addView(view, params)
        } else {
            windowManager.updateViewLayout(view, params)
        }
    }

    private fun hideOverlay() {
        mainHandler.post {
            overlayView?.let { view ->
                if (view.parent != null) runCatching { windowManager.removeViewImmediate(view) }
            }
            lastText = null
            lastBounds = null
        }
    }

    private fun countHan(text: CharSequence): Int {
        var count = 0
        var index = 0
        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            if (ChineseSegmenter.isHan(codePoint)) count++
            index += Character.charCount(codePoint)
        }
        return count
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private data class Candidate(
        val text: String,
        val bounds: Rect,
        val score: Int,
    )

    companion object {
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val LEXICON_ASSET = "zh_pinyin.tsv"
        private const val MAX_TEXT_LENGTH = 4_000
    }
}
