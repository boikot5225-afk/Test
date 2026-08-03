package com.bulat.smartbookoverlay

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.text.Layout
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.TextAppearanceSpan
import smartbook.pinyin.ChineseSegmenter
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Finds words Smart Book has already painted red/pink as being in study.
 *
 * Accessibility usually preserves ForegroundColorSpan. Samsung/Compose/custom views may strip
 * those spans, so a local screenshot detector is kept as a fallback. Nothing is uploaded.
 */
object StudyWordDetector {
    data class Block(
        val text: String,
        val bounds: Rect,
    )

    fun fromStyledText(text: CharSequence): Set<String> {
        val spanned = text as? Spanned ?: return emptySet()
        if (spanned.isEmpty()) return emptySet()

        val ranges = LinkedHashSet<IntRange>()
        spanned.getSpans(0, spanned.length, ForegroundColorSpan::class.java).forEach { span ->
            if (isStudyColor(span.foregroundColor)) {
                addSpanRange(spanned, span, ranges)
            }
        }
        spanned.getSpans(0, spanned.length, TextAppearanceSpan::class.java).forEach { span ->
            val color = span.textColor?.defaultColor ?: return@forEach
            if (isStudyColor(color)) {
                addSpanRange(spanned, span, ranges)
            }
        }

        // Some custom ReaderText implementations wrap the color in their own CharacterStyle.
        spanned.getSpans(0, spanned.length, CharacterStyle::class.java).forEach { span ->
            if (span is ForegroundColorSpan || span is TextAppearanceSpan) return@forEach
            val color = reflectColor(span) ?: return@forEach
            if (isStudyColor(color)) {
                addSpanRange(spanned, span, ranges)
            }
        }

        return ranges.flatMapTo(LinkedHashSet()) { range ->
            hanRuns(spanned.subSequence(range.first, range.last + 1).toString())
        }
    }

    fun fromScreenshot(
        bitmap: Bitmap,
        blocks: List<Block>,
        scaledDensity: Float,
        density: Float,
    ): Set<String> {
        if (bitmap.isRecycled || blocks.isEmpty()) return emptySet()
        val result = LinkedHashSet<String>()
        val paint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)

        blocks.forEach { block ->
            if (block.text.isBlank() || block.bounds.isEmpty) return@forEach
            val layout = closestLayout(
                text = block.text,
                widthPx = block.bounds.width(),
                heightPx = block.bounds.height(),
                scaledDensity = scaledDensity,
                paint = paint,
            )
            val marked = BooleanArray(block.text.length)
            var offset = 0
            while (offset < block.text.length) {
                val codePoint = Character.codePointAt(block.text, offset)
                val next = offset + Character.charCount(codePoint)
                if (ChineseSegmenter.isHan(codePoint)) {
                    val line = layout.getLineForOffset(offset)
                    val lineEnd = layout.getLineEnd(line)
                    val safeNext = min(next, lineEnd)
                    if (safeNext > offset) {
                        var left = layout.getPrimaryHorizontal(offset)
                        var right = layout.getPrimaryHorizontal(safeNext)
                        if (right < left) {
                            val swap = left
                            left = right
                            right = swap
                        }
                        if (right - left < scaledDensity * 4f) {
                            right = left + paint.textSize.coerceAtLeast(scaledDensity * 10f)
                        }

                        val sample = Rect(
                            (block.bounds.left + left - density).toInt(),
                            block.bounds.top + layout.getLineTop(line),
                            (block.bounds.left + right + density).toInt(),
                            block.bounds.top + layout.getLineBottom(line),
                        )
                        if (containsStudyInk(bitmap, sample)) {
                            for (index in offset until next.coerceAtMost(marked.size)) marked[index] = true
                        }
                    }
                }
                offset = next
            }
            result += markedHanRuns(block.text, marked)
        }
        return result
    }

    internal fun isStudyColor(color: Int): Boolean {
        if (Color.alpha(color) < 72) return false
        val red = Color.red(color)
        val green = Color.green(color)
        val blue = Color.blue(color)
        return red >= 165 &&
            red - green >= 55 &&
            red - blue >= 28 &&
            green <= 165
    }

    private fun addSpanRange(
        text: Spanned,
        span: Any,
        target: MutableSet<IntRange>,
    ) {
        val start = text.getSpanStart(span).coerceAtLeast(0)
        val end = text.getSpanEnd(span).coerceAtMost(text.length)
        if (end > start) target += start until end
    }

    private fun reflectColor(span: CharacterStyle): Int? = runCatching {
        val method = span.javaClass.methods.firstOrNull { candidate ->
            candidate.parameterCount == 0 &&
                candidate.returnType == Int::class.javaPrimitiveType &&
                candidate.name in COLOR_METHOD_NAMES
        } ?: return@runCatching null
        method.isAccessible = true
        method.invoke(span) as? Int
    }.getOrNull()

    private fun containsStudyInk(bitmap: Bitmap, rawRect: Rect): Boolean {
        val rect = Rect(
            rawRect.left.coerceIn(0, bitmap.width),
            rawRect.top.coerceIn(0, bitmap.height),
            rawRect.right.coerceIn(0, bitmap.width),
            rawRect.bottom.coerceIn(0, bitmap.height),
        )
        if (rect.width() < 2 || rect.height() < 2) return false

        val step = if (rect.width() * rect.height() > 7_500) 2 else 1
        var studyPixels = 0
        var inkPixels = 0
        var y = rect.top
        while (y < rect.bottom) {
            var x = rect.left
            while (x < rect.right) {
                val color = bitmap.getPixel(x, y)
                if (isStudyColor(color)) studyPixels++
                val red = Color.red(color)
                val green = Color.green(color)
                val blue = Color.blue(color)
                if (Color.alpha(color) > 60 && min(red, min(green, blue)) < 218) inkPixels++
                x += step
            }
            y += step
        }
        return studyPixels >= 4 && studyPixels * 100 >= max(1, inkPixels) * 5
    }

    private fun closestLayout(
        text: String,
        widthPx: Int,
        heightPx: Int,
        scaledDensity: Float,
        paint: TextPaint,
    ): StaticLayout {
        var best: StaticLayout? = null
        var bestDifference = Int.MAX_VALUE
        var sizeSp = MIN_SOURCE_SP
        while (sizeSp <= MAX_SOURCE_SP) {
            paint.textSize = sizeSp * scaledDensity
            val candidate = StaticLayout.Builder.obtain(text, 0, text.length, paint, max(1, widthPx))
                .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                .setIncludePad(true)
                .setLineSpacing(0f, 1f)
                .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
                .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
                .build()
            val difference = abs(candidate.height - heightPx)
            if (difference < bestDifference) {
                best = candidate
                bestDifference = difference
            }
            sizeSp += 0.5f
        }
        return best ?: error("Could not construct text layout")
    }

    private fun markedHanRuns(text: String, marked: BooleanArray): Set<String> {
        val result = LinkedHashSet<String>()
        var runStart = -1
        var index = 0
        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            val next = index + Character.charCount(codePoint)
            val isMarkedHan = ChineseSegmenter.isHan(codePoint) &&
                (index until next.coerceAtMost(marked.size)).any { marked[it] }
            if (isMarkedHan) {
                if (runStart < 0) runStart = index
            } else if (runStart >= 0) {
                addRun(text, runStart, index, result)
                runStart = -1
            }
            index = next
        }
        if (runStart >= 0) addRun(text, runStart, text.length, result)
        return result
    }

    private fun hanRuns(value: String): Set<String> {
        val result = LinkedHashSet<String>()
        var runStart = -1
        var index = 0
        while (index < value.length) {
            val codePoint = Character.codePointAt(value, index)
            val next = index + Character.charCount(codePoint)
            if (ChineseSegmenter.isHan(codePoint)) {
                if (runStart < 0) runStart = index
            } else if (runStart >= 0) {
                addRun(value, runStart, index, result)
                runStart = -1
            }
            index = next
        }
        if (runStart >= 0) addRun(value, runStart, value.length, result)
        return result
    }

    private fun addRun(text: String, start: Int, end: Int, target: MutableSet<String>) {
        if (end <= start) return
        val word = text.substring(start, end)
        val codePoints = word.codePointCount(0, word.length)
        if (codePoints in 1..MAX_WORD_CODEPOINTS) target += word
    }

    private val COLOR_METHOD_NAMES = setOf(
        "getForegroundColor",
        "getTextColor",
        "getColor",
    )
    private const val MAX_WORD_CODEPOINTS = 24
    private const val MIN_SOURCE_SP = 12f
    private const val MAX_SOURCE_SP = 44f
}
