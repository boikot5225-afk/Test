package com.bulat.smartbookoverlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.StaticLayout
import android.util.TypedValue
import android.view.Gravity
import android.view.View
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
import kotlin.math.min

class PinyinAccessibilityService : AccessibilityService() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val renderRunnable = Runnable { renderVisibleText() }
    private val firstShown = AtomicBoolean(false)

    @Volatile
    private var planner: PinyinPlanner? = null

    private lateinit var windowManager: WindowManager
    private val overlays = mutableListOf<OverlayHolder>()
    private var lastSignature: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        loadDictionary()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val eventPackage = event?.packageName?.toString()
        when {
            eventPackage == packageName -> return
            eventPackage == MainActivity.SMART_BOOK_PACKAGE -> {
                mainHandler.removeCallbacks(renderRunnable)
                mainHandler.postDelayed(renderRunnable, 90L)
            }
            event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> hideOverlays()
        }
    }

    override fun onInterrupt() {
        hideOverlays()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        hideOverlays()
        super.onDestroy()
    }

    private fun loadDictionary() {
        Thread({
            runCatching {
                assets.open(LEXICON_ASSET).use(MapChineseLexicon::fromTsv)
            }.onSuccess { lexicon ->
                planner = PinyinPlanner(lexicon)
                mainHandler.post { renderVisibleText() }
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

    private fun renderVisibleText() {
        val currentPlanner = planner ?: return
        val root = rootInActiveWindow ?: run {
            hideOverlays()
            return
        }

        if (root.packageName?.toString() != MainActivity.SMART_BOOK_PACKAGE) {
            root.recycle()
            hideOverlays()
            return
        }

        val candidates = try {
            findVisibleChineseBlocks(root)
        } finally {
            root.recycle()
        }

        if (candidates.isEmpty()) {
            hideOverlays()
            return
        }

        val signature = candidates.joinToString("|") {
            "${it.bounds.left},${it.bounds.top},${it.bounds.right},${it.bounds.bottom}:${it.text.hashCode()}"
        }
        if (signature == lastSignature) return

        val renderedBlocks = candidates.mapNotNull { candidate ->
            val annotations = currentPlanner.plan(
                text = candidate.text,
                mode = PinyinMode.ALL,
                isLearnt = { false },
            )
            if (annotations.isEmpty()) return@mapNotNull null

            val rendered = SpannableStringBuilder(candidate.text)
            SmartBookPinyinApplier.apply(rendered, annotations)
            RenderedBlock(rendered, candidate.bounds)
        }

        if (renderedBlocks.isEmpty()) {
            hideOverlays()
            return
        }

        showOverlays(renderedBlocks)
        lastSignature = signature

        if (firstShown.compareAndSet(false, true)) {
            Toast.makeText(this, "Пиньинь включён", Toast.LENGTH_SHORT).show()
        }
    }

    private fun findVisibleChineseBlocks(root: AccessibilityNodeInfo): List<Candidate> {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(AccessibilityNodeInfo.obtain(root))
        val raw = mutableListOf<Candidate>()

        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            try {
                if (node.isVisibleToUser) {
                    evaluateNode(node)?.let(raw::add)
                }
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let(queue::addLast)
                }
            } finally {
                node.recycle()
            }
        }

        if (raw.isEmpty()) return emptyList()

        val kept = mutableListOf<Candidate>()
        raw.sortedBy { it.bounds.width().toLong() * it.bounds.height() }.forEach { candidate ->
            val duplicate = kept.any { existing ->
                overlapRatio(candidate.bounds, existing.bounds) >= 0.82f &&
                    (candidate.text.contains(existing.text) || existing.text.contains(candidate.text))
            }
            if (!duplicate) kept += candidate
        }

        return kept
            .sortedWith(compareBy<Candidate> { it.bounds.top }.thenBy { it.bounds.left })
            .take(MAX_VISIBLE_BLOCKS)
    }

    private fun evaluateNode(node: AccessibilityNodeInfo): Candidate? {
        if (node.packageName?.toString() != MainActivity.SMART_BOOK_PACKAGE) return null

        val className = node.className?.toString().orEmpty()
        val looksLikeReaderText = className == READER_TEXT_CLASS ||
            className.contains("ReaderText", ignoreCase = true) ||
            className.contains("TextView", ignoreCase = true) ||
            node.isTextSelectable
        if (!looksLikeReaderText) return null

        val source = node.text ?: return null
        val text = source.toString()
        val trimmed = text.trim()
        if (trimmed.length !in MIN_TEXT_LENGTH..MAX_TEXT_LENGTH) return null

        val hanCount = countHan(trimmed)
        if (hanCount < MIN_HAN_COUNT) return null
        if (hanCount.toFloat() / trimmed.length < MIN_HAN_RATIO) return null

        val bounds = Rect().also(node::getBoundsInScreen)
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val visibleScreen = Rect(0, 0, screenWidth, screenHeight)
        if (!Rect.intersects(bounds, visibleScreen)) return null
        if (bounds.width() < (screenWidth * MIN_WIDTH_RATIO).toInt()) return null
        if (bounds.height() < dp(28)) return null

        val clipped = Rect(bounds)
        if (!clipped.intersect(visibleScreen)) return null
        if (clipped.height() < dp(20)) return null

        return Candidate(trimmed, clipped)
    }

    private fun showOverlays(blocks: List<RenderedBlock>) {
        val prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
        val preferredTextSize = prefs
            .getInt(MainActivity.PREF_TEXT_SIZE, MainActivity.DEFAULT_TEXT_SIZE)
            .toFloat()

        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val backgroundColor = if (dark) Color.rgb(24, 24, 24) else Color.WHITE
        val foregroundColor = if (dark) Color.rgb(235, 235, 235) else Color.rgb(70, 79, 86)

        blocks.forEachIndexed { index, block ->
            val holder = getOrCreateOverlay(index)
            val width = max(1, block.bounds.width())
            val height = max(dp(24), block.bounds.height())

            holder.view.apply {
                setTextColor(foregroundColor)
                background = ColorDrawable(backgroundColor)
                minHeight = height
                maxHeight = height
                setText(block.text, TextView.BufferType.SPANNABLE)
            }

            fitTextIntoBounds(
                view = holder.view,
                text = block.text,
                widthPx = width,
                heightPx = height,
                preferredSp = preferredTextSize,
            )

            holder.params.width = width
            holder.params.height = height
            holder.params.x = block.bounds.left
            holder.params.y = block.bounds.top

            if (holder.view.parent == null) {
                windowManager.addView(holder.view, holder.params)
            } else {
                windowManager.updateViewLayout(holder.view, holder.params)
            }
        }

        for (index in blocks.size until overlays.size) {
            val holder = overlays[index]
            if (holder.view.parent != null) {
                runCatching { windowManager.removeViewImmediate(holder.view) }
            }
        }
    }

    private fun getOrCreateOverlay(index: Int): OverlayHolder {
        if (index < overlays.size) return overlays[index]

        val view = TextView(this).apply {
            gravity = Gravity.START or Gravity.TOP
            includeFontPadding = true
            setPadding(0, 0, 0, 0)
            setLineSpacing(0f, 1f)
            ellipsize = null
            maxLines = 100
            breakStrategy = Layout.BREAK_STRATEGY_SIMPLE
            hyphenationFrequency = Layout.HYPHENATION_FREQUENCY_NONE
            elevation = 0f
            isClickable = false
            isLongClickable = false
            setTextIsSelectable(false)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }

        val params = WindowManager.LayoutParams(
            1,
            1,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.OPAQUE,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }

        return OverlayHolder(view, params).also(overlays::add)
    }

    private fun fitTextIntoBounds(
        view: TextView,
        text: CharSequence,
        widthPx: Int,
        heightPx: Int,
        preferredSp: Float,
    ) {
        var sizeSp = preferredSp.coerceIn(MIN_TEXT_SIZE_SP, MAX_TEXT_SIZE_SP)
        val safeWidth = max(1, widthPx)
        val safeHeight = max(1, heightPx)

        while (sizeSp > MIN_TEXT_SIZE_SP) {
            view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            val layout = StaticLayout.Builder.obtain(text, 0, text.length, view.paint, safeWidth)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                .setIncludePad(true)
                .setLineSpacing(0f, 1f)
                .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
                .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
                .build()
            if (layout.height <= safeHeight) return
            sizeSp -= 0.5f
        }

        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, MIN_TEXT_SIZE_SP)
    }

    private fun hideOverlays() {
        mainHandler.post {
            overlays.forEach { holder ->
                if (holder.view.parent != null) {
                    runCatching { windowManager.removeViewImmediate(holder.view) }
                }
            }
            lastSignature = null
        }
    }

    private fun overlapRatio(first: Rect, second: Rect): Float {
        val intersection = Rect(first)
        if (!intersection.intersect(second)) return 0f
        val intersectionArea = intersection.width().toLong() * intersection.height()
        val firstArea = first.width().toLong() * first.height()
        val secondArea = second.width().toLong() * second.height()
        val smallerArea = min(firstArea, secondArea)
        if (smallerArea <= 0L) return 0f
        return intersectionArea.toFloat() / smallerArea
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
    )

    private data class RenderedBlock(
        val text: CharSequence,
        val bounds: Rect,
    )

    private data class OverlayHolder(
        val view: TextView,
        val params: WindowManager.LayoutParams,
    )

    companion object {
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val LEXICON_ASSET = "zh_pinyin.tsv"
        private const val MIN_TEXT_LENGTH = 4
        private const val MAX_TEXT_LENGTH = 4_000
        private const val MIN_HAN_COUNT = 2
        private const val MIN_HAN_RATIO = 0.18f
        private const val MIN_WIDTH_RATIO = 0.48f
        private const val MAX_VISIBLE_BLOCKS = 8
        private const val MIN_TEXT_SIZE_SP = 14f
        private const val MAX_TEXT_SIZE_SP = 30f
    }
}
