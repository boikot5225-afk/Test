package com.bulat.smartbookoverlay

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RectF
import android.text.Spanned
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.TextAppearanceSpan

/** Detects Smart Book words painted red/pink as being in study. */
object StudyWordDetector {
    data class Block(
        val text: String,
        val characterLocations: List<RectF?>,
    )

    data class DetectedWord(
        val word: String,
        val start: Int,
        val end: Int,
        val bounds: RectF,
    )

    fun fromStyledText(
        text: CharSequence,
        characterLocations: List<RectF?>,
    ): List<DetectedWord> {
        val spanned = text as? Spanned ?: return emptyList()
        if (spanned.isEmpty() || characterLocations.isEmpty()) return emptyList()

        val marked = BooleanArray(spanned.length)
        fun mark(span: Any) {
            val start = spanned.getSpanStart(span).coerceAtLeast(0)
            val end = spanned.getSpanEnd(span).coerceAtMost(spanned.length)
            for (index in start until end) marked[index] = true
        }

        spanned.getSpans(0, spanned.length, ForegroundColorSpan::class.java).forEach { span ->
            if (isStudyColor(span.foregroundColor)) mark(span)
        }
        spanned.getSpans(0, spanned.length, TextAppearanceSpan::class.java).forEach { span ->
            val color = span.textColor?.defaultColor ?: return@forEach
            if (isStudyColor(color)) mark(span)
        }
        spanned.getSpans(0, spanned.length, CharacterStyle::class.java).forEach { span ->
            if (span is ForegroundColorSpan || span is TextAppearanceSpan) return@forEach
            val color = reflectColor(span) ?: return@forEach
            if (isStudyColor(color)) mark(span)
        }

        return group(spanned.toString(), marked, characterLocations)
    }

    fun fromScreenshot(
        bitmap: Bitmap,
        blocks: List<Block>,
        coordinateWidth: Int,
        coordinateHeight: Int,
    ): List<DetectedWord> {
        if (bitmap.isRecycled || blocks.isEmpty()) return emptyList()
        val scaleX = bitmap.width.toFloat() / coordinateWidth.coerceAtLeast(1)
        val scaleY = bitmap.height.toFloat() / coordinateHeight.coerceAtLeast(1)
        val result = mutableListOf<DetectedWord>()

        blocks.forEach { block ->
            if (block.text.isEmpty() || block.characterLocations.isEmpty()) return@forEach
            val marked = BooleanArray(block.text.length)
            var index = 0
            while (index < block.text.length) {
                val codePoint = Character.codePointAt(block.text, index)
                val next = index + Character.charCount(codePoint)
                val location = block.characterLocations.getOrNull(index)
                if (location != null && !location.isEmpty && containsStudyInk(
                        bitmap,
                        RectF(
                            location.left * scaleX,
                            location.top * scaleY,
                            location.right * scaleX,
                            location.bottom * scaleY,
                        ),
                    )
                ) {
                    for (position in index until next.coerceAtMost(marked.size)) marked[position] = true
                }
                index = next
            }
            result += group(block.text, marked, block.characterLocations)
        }

        return result
            .distinctBy { Triple(it.word, it.bounds.centerX().toInt(), it.bounds.centerY().toInt()) }
            .sortedWith(compareBy<DetectedWord> { it.bounds.top }.thenBy { it.bounds.left })
    }

    internal fun isStudyColor(color: Int): Boolean {
        if (Color.alpha(color) < 72) return false
        val red = Color.red(color)
        val green = Color.green(color)
        val blue = Color.blue(color)
        return red >= 165 && red - green >= 55 && red - blue >= 28 && green <= 165
    }

    private fun containsStudyInk(bitmap: Bitmap, raw: RectF): Boolean {
        if (raw.width() < 2f || raw.height() < 2f) return false

        // Avoid neighbouring glyphs and anti-aliased colour bleeding at character-box edges.
        val insetX = (raw.width() * 0.10f).coerceAtLeast(1f)
        val insetY = (raw.height() * 0.08f).coerceAtLeast(1f)
        val left = (raw.left + insetX).toInt().coerceIn(0, bitmap.width)
        val top = (raw.top + insetY).toInt().coerceIn(0, bitmap.height)
        val right = (raw.right - insetX).toInt().coerceIn(0, bitmap.width)
        val bottom = (raw.bottom - insetY).toInt().coerceIn(0, bitmap.height)
        if (right - left < 2 || bottom - top < 2) return false

        val area = (right - left) * (bottom - top)
        val step = if (area > 8_000) 2 else 1
        var studyPixels = 0
        var inkPixels = 0
        var y = top
        while (y < bottom) {
            var x = left
            while (x < right) {
                val color = bitmap.getPixel(x, y)
                if (isStudyColor(color)) studyPixels++
                if (isInk(color)) inkPixels++
                x += step
            }
            y += step
        }

        // A red glyph has red as the dominant ink. A grey neighbour may contain a few pink
        // anti-aliased pixels, but cannot pass this ratio.
        return studyPixels >= 8 && studyPixels * 100 >= inkPixels.coerceAtLeast(1) * 35
    }

    private fun isInk(color: Int): Boolean {
        if (Color.alpha(color) < 60) return false
        val red = Color.red(color)
        val green = Color.green(color)
        val blue = Color.blue(color)
        return minOf(red, green, blue) < 225
    }

    private fun group(
        text: String,
        marked: BooleanArray,
        locations: List<RectF?>,
    ): List<DetectedWord> {
        val boxes = locations.map { rect ->
            rect?.takeUnless(RectF::isEmpty)?.let {
                StudyWordGeometry.Box(it.left, it.top, it.right, it.bottom)
            }
        }
        return StudyWordGeometry.groupMarkedHan(text, marked, boxes).map { word ->
            DetectedWord(
                word = word.value,
                start = word.start,
                end = word.end,
                bounds = RectF(word.box.left, word.box.top, word.box.right, word.box.bottom),
            )
        }
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

    private val COLOR_METHOD_NAMES = setOf(
        "getForegroundColor",
        "getTextColor",
        "getColor",
    )
}
