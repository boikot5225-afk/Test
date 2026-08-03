package com.bulat.smartbookoverlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import smartbook.pinyin.ChineseSegmenter
import smartbook.pinyin.MapChineseLexicon
import smartbook.pinyin.PinyinAnnotation
import smartbook.pinyin.PinyinFormatter
import smartbook.pinyin.PinyinMode
import smartbook.pinyin.PinyinPlanner
import java.util.ArrayDeque
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

class PinyinAccessibilityService : AccessibilityService() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val renderRunnable = Runnable { renderVisibleText() }

    @Volatile
    private var planner: PinyinPlanner? = null

    @Volatile
    private var lexicon: MapChineseLexicon? = null

    private lateinit var windowManager: WindowManager
    private lateinit var trackedWords: TrackedWordStore
    private val overlays = mutableListOf<OverlayHolder>()
    private var lastSignature: String? = null
    private var pendingWord: PendingWord? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        trackedWords = TrackedWordStore(this)
        loadDictionary()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        val eventPackage = event.packageName?.toString()
        when {
            eventPackage == packageName -> return
            eventPackage == MainActivity.SMART_BOOK_PACKAGE -> {
                when (event.eventType) {
                    AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> captureSelection(event)
                    AccessibilityEvent.TYPE_VIEW_CLICKED -> handleSmartBookClick(event)
                    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
                    AccessibilityEvent.TYPE_VIEW_SELECTED -> refreshPendingWordFromPanel()
                }
                scheduleRender()
            }
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> hideOverlays()
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

    private fun scheduleRender() {
        mainHandler.removeCallbacks(renderRunnable)
        mainHandler.postDelayed(renderRunnable, 90L)
    }

    private fun loadDictionary() {
        Thread({
            runCatching {
                assets.open(LEXICON_ASSET).use(MapChineseLexicon::fromTsv)
            }.onSuccess { loaded ->
                lexicon = loaded
                planner = PinyinPlanner(loaded)
                mainHandler.post { renderVisibleText(force = true) }
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

    private fun captureSelection(event: AccessibilityEvent) {
        val source = event.source
        try {
            val fullText = source?.text?.toString()
            val from = event.fromIndex
            val to = event.toIndex
            val selected = when {
                fullText != null && from >= 0 && to > from && to <= fullText.length ->
                    fullText.substring(from, to)
                else -> event.text
                    .asSequence()
                    .map { it.toString() }
                    .mapNotNull(TrackedWordStore::normalize)
                    .firstOrNull()
            }
            rememberPendingWord(selected)
        } finally {
            source?.recycle()
        }
    }

    private fun handleSmartBookClick(event: AccessibilityEvent) {
        val source = event.source
        try {
            val metadata = buildString {
                append(source?.text?.toString() ?: "")
                append(' ')
                append(source?.contentDescription?.toString() ?: "")
                append(' ')
                append(source?.viewIdResourceName ?: "")
                append(' ')
                append(source?.className?.toString() ?: "")
                append(' ')
                event.text.forEach {
                    append(it)
                    append(' ')
                }
            }.lowercase()

            val bounds = Rect().also { source?.getBoundsInScreen(it) }
            val pending = pendingWord?.takeIf {
                SystemClock.elapsedRealtime() - it.savedAt <= PENDING_WORD_TTL_MS
            }

            val addAction = containsAny(metadata, ADD_ACTION_MARKERS) ||
                (pending != null && looksLikeBottomLeftAction(bounds))
            val removeAction = containsAny(metadata, REMOVE_ACTION_MARKERS)

            when {
                addAction && pending != null -> {
                    val saved = trackedWords.add(pending.word) ?: return
                    pendingWord = PendingWord(saved, SystemClock.elapsedRealtime())
                    lastSignature = null
                    Toast.makeText(this, "Пиньинь добавлен: $saved", Toast.LENGTH_SHORT).show()
                    renderVisibleText(force = true)
                }
                removeAction && pending != null -> {
                    val removed = trackedWords.remove(pending.word) ?: return
                    lastSignature = null
                    Toast.makeText(this, "Пиньинь убран: $removed", Toast.LENGTH_SHORT).show()
                    renderVisibleText(force = true)
                }
            }
        } finally {
            source?.recycle()
        }
    }

    private fun rememberPendingWord(raw: String?) {
        val word = raw?.let(TrackedWordStore::normalize) ?: return
        pendingWord = PendingWord(word, SystemClock.elapsedRealtime())
    }

    private fun refreshPendingWordFromPanel() {
        val root = rootInActiveWindow ?: return
        try {
            findPanelHeadword(root)?.let(::rememberPendingWord)
        } finally {
            root.recycle()
        }
    }

    private fun findPanelHeadword(root: AccessibilityNodeInfo): String? {
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(AccessibilityNodeInfo.obtain(root))
        var best: PanelCandidate? = null
        var visited = 0

        while (queue.isNotEmpty() && visited < MAX_SCANNED_NODES) {
            val node = queue.removeFirst()
            visited++
            try {
                if (node.isVisibleToUser) {
                    val raw = node.text?.toString()
                    val word = raw?.let(TrackedWordStore::normalize)
                    if (word != null) {
                        val codePoints = word.codePointCount(0, word.length)
                        val bounds = Rect().also(node::getBoundsInScreen)
                        val inLowerPanel = bounds.centerY() > (screenHeight * 0.55f).toInt()
                        val compact = bounds.width() < (screenWidth * 0.72f).toInt() &&
                            bounds.height() < (screenHeight * 0.20f).toInt()
                        if (inLowerPanel && compact && codePoints in 1..12) {
                            val score = bounds.top + (12 - codePoints) * dp(24) +
                                if (node.isClickable) dp(40) else 0
                            if (best == null || score > best!!.score) {
                                best = PanelCandidate(word, score)
                            }
                        }
                    }
                }
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let(queue::addLast)
                }
            } finally {
                node.recycle()
            }
        }
        return best?.word
    }

    private fun renderVisibleText(force: Boolean = false) {
        val currentPlanner = planner ?: return
        val currentLexicon = lexicon ?: return
        val learnt = trackedWords.snapshot()
        if (learnt.isEmpty()) {
            hideOverlays()
            return
        }

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

        val learntSignature = learnt.sorted().joinToString(",").hashCode()
        val rubySize = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
            .getInt(MainActivity.PREF_RUBY_SIZE, MainActivity.DEFAULT_RUBY_SIZE)
        val signature = buildString {
            append(learntSignature)
            append(':')
            append(rubySize)
            candidates.forEach {
                append('|')
                append(it.bounds.left)
                append(',')
                append(it.bounds.top)
                append(',')
                append(it.bounds.right)
                append(',')
                append(it.bounds.bottom)
                append(':')
                append(it.text.hashCode())
            }
        }
        if (!force && signature == lastSignature) return

        val renderedBlocks = candidates.mapNotNull { candidate ->
            val boundaries = preferredBoundaries(candidate.text, learnt)
            val planned = currentPlanner.plan(
                text = candidate.text,
                mode = PinyinMode.ALL,
                isLearnt = { false },
                preferredBoundaries = boundaries,
            ).filter { it.word in learnt }

            val annotations = addDirectFallbacks(
                text = candidate.text,
                learnt = learnt,
                planned = planned,
                currentLexicon = currentLexicon,
            )
            if (annotations.isEmpty()) return@mapNotNull null
            RenderedBlock(candidate.text, annotations, candidate.bounds)
        }

        if (renderedBlocks.isEmpty()) {
            hideOverlays()
            return
        }

        showOverlays(renderedBlocks, rubySize.toFloat())
        lastSignature = signature
    }

    private fun preferredBoundaries(text: String, learnt: Set<String>): Set<Int> {
        val boundaries = mutableSetOf<Int>()
        learnt.sortedByDescending(String::length).forEach { word ->
            var from = 0
            while (from < text.length) {
                val index = text.indexOf(word, from)
                if (index < 0) break
                boundaries += index
                boundaries += index + word.length
                from = index + max(1, word.length)
            }
        }
        return boundaries
    }

    private fun addDirectFallbacks(
        text: String,
        learnt: Set<String>,
        planned: List<PinyinAnnotation>,
        currentLexicon: MapChineseLexicon,
    ): List<PinyinAnnotation> {
        val result = planned.toMutableList()
        val occupied = BooleanArray(text.length.coerceAtLeast(1))
        planned.forEach { annotation ->
            for (index in annotation.start.coerceAtLeast(0) until annotation.end.coerceAtMost(text.length)) {
                occupied[index] = true
            }
        }

        learnt.sortedByDescending(String::length).forEach { word ->
            val reading = currentLexicon.pinyin(word)
                ?.let(PinyinFormatter::compact)
                ?.takeIf(String::isNotBlank)
                ?: return@forEach
            var from = 0
            while (from < text.length) {
                val index = text.indexOf(word, from)
                if (index < 0) break
                val end = index + word.length
                val overlaps = (index until end.coerceAtMost(text.length)).any { occupied[it] }
                if (!overlaps) {
                    result += PinyinAnnotation(word, reading, index, end)
                    for (position in index until end.coerceAtMost(text.length)) occupied[position] = true
                }
                from = index + max(1, word.length)
            }
        }
        return result.sortedBy { it.start }
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

        val text = node.text?.toString() ?: return null
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

    private fun showOverlays(blocks: List<RenderedBlock>, rubySizeSp: Float) {
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val foregroundColor = if (dark) Color.rgb(220, 220, 220) else Color.rgb(65, 72, 78)
        val requestedTopPadding = ceil(sp(rubySizeSp) + dp(4)).toInt()

        blocks.forEachIndexed { index, block ->
            val holder = getOrCreateOverlay(index)
            val width = max(1, block.bounds.width())
            val desiredTop = block.bounds.top - requestedTopPadding
            val y = max(0, desiredTop)
            val actualTopPadding = block.bounds.top - y
            val height = max(dp(20), block.bounds.height() + actualTopPadding)

            holder.view.configure(
                text = block.text,
                annotations = block.annotations,
                widthPx = width,
                heightPx = block.bounds.height(),
                topOffsetPx = actualTopPadding,
                rubySp = rubySizeSp,
                color = foregroundColor,
            )

            holder.params.width = width
            holder.params.height = height
            holder.params.x = block.bounds.left
            holder.params.y = y

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

        val view = PinyinRubyOverlayView(this)
        val params = WindowManager.LayoutParams(
            1,
            1,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }
        return OverlayHolder(view, params).also(overlays::add)
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

    private fun looksLikeBottomLeftAction(bounds: Rect): Boolean {
        if (bounds.isEmpty) return false
        val width = resources.displayMetrics.widthPixels
        val height = resources.displayMetrics.heightPixels
        return bounds.centerX() < (width * 0.24f).toInt() &&
            bounds.centerY() > (height * 0.66f).toInt() &&
            bounds.width() < (width * 0.28f).toInt() &&
            bounds.height() < (height * 0.20f).toInt()
    }

    private fun containsAny(value: String, markers: List<String>): Boolean =
        markers.any(value::contains)

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

    private fun sp(value: Float): Float = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_SP,
        value,
        resources.displayMetrics,
    )

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private data class Candidate(
        val text: String,
        val bounds: Rect,
    )

    private data class RenderedBlock(
        val text: String,
        val annotations: List<PinyinAnnotation>,
        val bounds: Rect,
    )

    private data class OverlayHolder(
        val view: PinyinRubyOverlayView,
        val params: WindowManager.LayoutParams,
    )

    private data class PendingWord(
        val word: String,
        val savedAt: Long,
    )

    private data class PanelCandidate(
        val word: String,
        val score: Int,
    )

    companion object {
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val LEXICON_ASSET = "zh_pinyin.tsv"
        private const val MIN_TEXT_LENGTH = 2
        private const val MAX_TEXT_LENGTH = 4_000
        private const val MIN_HAN_COUNT = 1
        private const val MIN_HAN_RATIO = 0.18f
        private const val MIN_WIDTH_RATIO = 0.42f
        private const val MAX_VISIBLE_BLOCKS = 8
        private const val MAX_SCANNED_NODES = 800
        private const val PENDING_WORD_TTL_MS = 30_000L

        private val ADD_ACTION_MARKERS = listOf(
            "add", "plus", "learn", "study", "vocabulary", "save word",
            "добав", "изуч", "учить", "словар",
        )
        private val REMOVE_ACTION_MARKERS = listOf(
            "remove", "delete", "minus", "forget",
            "убрат", "удал", "забы",
        )
    }
}
