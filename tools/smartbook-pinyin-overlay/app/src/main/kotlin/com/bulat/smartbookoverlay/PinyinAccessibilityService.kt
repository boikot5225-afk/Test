package com.bulat.smartbookoverlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import smartbook.pinyin.ChineseSegmenter
import smartbook.pinyin.MapChineseLexicon
import smartbook.pinyin.PinyinFormatter
import java.util.ArrayDeque
import kotlin.math.min

class PinyinAccessibilityService : AccessibilityService() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val scanRunnable = Runnable { scanVisiblePage() }

    @Volatile
    private var lexicon: MapChineseLexicon? = null

    private lateinit var windowManager: WindowManager
    private var overlayView: PinyinRubyOverlayView? = null
    private var overlayParams: WindowManager.LayoutParams? = null
    private var screenshotInFlight = false
    private var rescanRequested = false
    private var scanGeneration = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        // Old versions stored guessed words. They must never leak into exact red-word rendering.
        TrackedWordStore(this).clear()
        loadDictionary()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        val eventPackage = event.packageName?.toString()
        when {
            eventPackage == packageName -> Unit
            eventPackage == MainActivity.SMART_BOOK_PACKAGE -> scheduleScan()
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                scanGeneration++
                hideOverlay()
            }
        }
    }

    override fun onInterrupt() {
        scanGeneration++
        hideOverlay()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        scanGeneration++
        hideOverlay()
        super.onDestroy()
    }

    private fun scheduleScan() {
        mainHandler.removeCallbacks(scanRunnable)
        mainHandler.postDelayed(scanRunnable, SCAN_DEBOUNCE_MS)
    }

    private fun loadDictionary() {
        Thread({
            runCatching {
                assets.open(LEXICON_ASSET).use(MapChineseLexicon::fromTsv)
            }.onSuccess { loaded ->
                lexicon = loaded
                mainHandler.post(::scheduleScan)
            }
        }, "pinyin-overlay-dictionary").apply {
            isDaemon = true
            start()
        }
    }

    private fun scanVisiblePage() {
        if (lexicon == null) return
        if (screenshotInFlight) {
            rescanRequested = true
            return
        }

        val root = rootInActiveWindow ?: run {
            hideOverlay()
            return
        }
        if (root.packageName?.toString() != MainActivity.SMART_BOOK_PACKAGE) {
            root.recycle()
            hideOverlay()
            return
        }

        val candidates = try {
            findVisibleChineseBlocks(root)
        } finally {
            root.recycle()
        }
        if (candidates.isEmpty()) {
            hideOverlay()
            return
        }

        val generation = ++scanGeneration
        hideOverlay()

        val styledWords = candidates.flatMap { candidate ->
            StudyWordDetector.fromStyledText(candidate.styledText, candidate.characterLocations)
        }
        if (styledWords.isNotEmpty()) {
            showDetectedWords(styledWords)
        }

        requestScreenshotScan(candidates, generation, styledWords)
    }

    private fun requestScreenshotScan(
        candidates: List<Candidate>,
        generation: Long,
        styledFallback: List<StudyWordDetector.DetectedWord>,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            if (styledFallback.isEmpty()) hideOverlay()
            return
        }

        screenshotInFlight = true
        val callback = object : TakeScreenshotCallback {
            override fun onSuccess(screenshot: ScreenshotResult) {
                val buffer = screenshot.hardwareBuffer
                val wrapped = runCatching {
                    Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                }.getOrNull()
                val bitmap = runCatching {
                    wrapped?.copy(Bitmap.Config.ARGB_8888, false)
                }.getOrNull()
                wrapped?.recycle()
                buffer.close()

                if (bitmap == null) {
                    finishScreenshotScan(generation, styledFallback)
                    return
                }

                val blocks = candidates.map { candidate ->
                    StudyWordDetector.Block(candidate.text, candidate.characterLocations)
                }
                Thread({
                    val detected = runCatching {
                        StudyWordDetector.fromScreenshot(
                            bitmap = bitmap,
                            blocks = blocks,
                            coordinateWidth = resources.displayMetrics.widthPixels,
                            coordinateHeight = resources.displayMetrics.heightPixels,
                        )
                    }.getOrDefault(emptyList())
                    bitmap.recycle()
                    mainHandler.post {
                        finishScreenshotScan(
                            generation = generation,
                            words = if (detected.isNotEmpty()) detected else styledFallback,
                        )
                    }
                }, "smartbook-exact-red-word-scan").apply {
                    isDaemon = true
                    start()
                }
            }

            override fun onFailure(errorCode: Int) {
                finishScreenshotScan(generation, styledFallback)
            }
        }

        runCatching {
            // The old character-location key returns screen coordinates, so capture the full
            // display rather than a cropped window. The overlay is removed before this call.
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, callback)
        }.onFailure {
            finishScreenshotScan(generation, styledFallback)
        }
    }

    private fun finishScreenshotScan(
        generation: Long,
        words: List<StudyWordDetector.DetectedWord>,
    ) {
        screenshotInFlight = false
        if (generation == scanGeneration) {
            if (words.isEmpty()) hideOverlay() else showDetectedWords(words)
        }
        if (rescanRequested) {
            rescanRequested = false
            scheduleScan()
        }
    }

    private fun showDetectedWords(words: List<StudyWordDetector.DetectedWord>) {
        val currentLexicon = lexicon ?: return
        val labels = words.mapNotNull { detected ->
            val reading = readingFor(detected.word, currentLexicon) ?: return@mapNotNull null
            PinyinRubyOverlayView.Label(reading, RectF(detected.bounds))
        }.distinctBy { label ->
            Triple(label.pinyin, label.wordBounds.centerX().toInt(), label.wordBounds.centerY().toInt())
        }
        if (labels.isEmpty()) {
            hideOverlay()
            return
        }

        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val color = if (dark) Color.rgb(225, 225, 225) else Color.rgb(65, 72, 78)
        val rubySize = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
            .getInt(MainActivity.PREF_RUBY_SIZE, MainActivity.DEFAULT_RUBY_SIZE)
            .toFloat()

        val view = overlayView ?: PinyinRubyOverlayView(this).also { overlayView = it }
        val params = overlayParams ?: WindowManager.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }.also { overlayParams = it }

        view.configure(labels, rubySize, color)
        if (view.parent == null) {
            windowManager.addView(view, params)
        } else {
            windowManager.updateViewLayout(view, params)
        }
    }

    private fun readingFor(word: String, currentLexicon: MapChineseLexicon): String? {
        currentLexicon.pinyin(word)
            ?.let(PinyinFormatter::compact)
            ?.takeIf(String::isNotBlank)
            ?.let { return it }

        val parts = mutableListOf<String>()
        var index = 0
        while (index < word.length) {
            val codePoint = Character.codePointAt(word, index)
            val character = String(Character.toChars(codePoint))
            val reading = currentLexicon.pinyin(character)
                ?.let(PinyinFormatter::compact)
                ?.takeIf(String::isNotBlank)
                ?: return null
            parts += reading
            index += Character.charCount(codePoint)
        }
        return parts.joinToString(" ")
    }

    private fun findVisibleChineseBlocks(root: AccessibilityNodeInfo): List<Candidate> {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(AccessibilityNodeInfo.obtain(root))
        val raw = mutableListOf<Candidate>()
        var visited = 0

        while (queue.isNotEmpty() && visited < MAX_SCANNED_NODES) {
            val node = queue.removeFirst()
            visited++
            try {
                if (node.isVisibleToUser) evaluateNode(node)?.let(raw::add)
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let(queue::addLast)
                }
            } finally {
                node.recycle()
            }
        }

        val kept = mutableListOf<Candidate>()
        raw.sortedWith(
            compareByDescending<Candidate> { it.validCharacterCount }
                .thenBy { it.bounds.width().toLong() * it.bounds.height() },
        ).forEach { candidate ->
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

        val styledText = node.text ?: return null
        val text = styledText.toString()
        if (text.length !in MIN_TEXT_LENGTH..MAX_TEXT_LENGTH) return null
        val visibleCharacters = text.count { !it.isWhitespace() }.coerceAtLeast(1)
        val hanCount = countHan(text)
        if (hanCount < MIN_HAN_COUNT || hanCount.toFloat() / visibleCharacters < MIN_HAN_RATIO) return null

        val bounds = Rect().also(node::getBoundsInScreen)
        val screen = Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        if (!Rect.intersects(bounds, screen) || bounds.width() < screen.width() * MIN_WIDTH_RATIO) return null

        val locations = requestCharacterLocations(node, text.length)
        val validCount = locations.count { it != null && !it.isEmpty }
        if (validCount < hanCount.coerceAtMost(MIN_REQUIRED_CHARACTER_LOCATIONS)) return null

        return Candidate(
            styledText = styledText,
            text = text,
            bounds = bounds,
            characterLocations = locations,
            validCharacterCount = validCount,
        )
    }

    private fun requestCharacterLocations(
        node: AccessibilityNodeInfo,
        textLength: Int,
    ): List<RectF?> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || textLength <= 0) return emptyList()
        val length = min(textLength, MAX_CHARACTER_LOCATION_LENGTH)
        val arguments = Bundle().apply {
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, 0)
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, length)
        }
        val key = AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY
        val refreshed = runCatching { node.refreshWithExtraData(key, arguments) }.getOrDefault(false)
        if (!refreshed) return emptyList()

        @Suppress("DEPRECATION")
        val raw = node.extras.getParcelableArray(key) ?: return emptyList()
        return MutableList<RectF?>(textLength) { index ->
            (raw.getOrNull(index) as? RectF)?.let(::RectF)
        }
    }

    private fun hideOverlay() {
        val view = overlayView ?: return
        if (view.parent != null) runCatching { windowManager.removeViewImmediate(view) }
    }

    private fun overlapRatio(first: Rect, second: Rect): Float {
        val intersection = Rect(first)
        if (!intersection.intersect(second)) return 0f
        val intersectionArea = intersection.width().toLong() * intersection.height()
        val smallerArea = min(
            first.width().toLong() * first.height(),
            second.width().toLong() * second.height(),
        )
        return if (smallerArea <= 0L) 0f else intersectionArea.toFloat() / smallerArea
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

    private data class Candidate(
        val styledText: CharSequence,
        val text: String,
        val bounds: Rect,
        val characterLocations: List<RectF?>,
        val validCharacterCount: Int,
    )

    companion object {
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val LEXICON_ASSET = "zh_pinyin.tsv"
        private const val MIN_TEXT_LENGTH = 2
        private const val MAX_TEXT_LENGTH = 4_000
        private const val MIN_HAN_COUNT = 1
        private const val MIN_HAN_RATIO = 0.18f
        private const val MIN_WIDTH_RATIO = 0.38f
        private const val MAX_VISIBLE_BLOCKS = 8
        private const val MAX_SCANNED_NODES = 800
        private const val MIN_REQUIRED_CHARACTER_LOCATIONS = 1
        private const val MAX_CHARACTER_LOCATION_LENGTH = 20_000
        private const val SCAN_DEBOUNCE_MS = 180L
    }
}
