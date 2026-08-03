package com.bulat.smartbookoverlay

import smartbook.pinyin.ChineseSegmenter
import kotlin.math.max
import kotlin.math.min

/** Pure geometry used by the detector and by JVM regression tests. */
object StudyWordGeometry {
    data class Box(
        val left: Float,
        val top: Float,
        val right: Float,
        val bottom: Float,
    ) {
        val width: Float get() = right - left
        val height: Float get() = bottom - top
        val isValid: Boolean
            get() = left.isFinite() && top.isFinite() && right.isFinite() && bottom.isFinite() &&
                width > 0f && height > 0f

        fun union(other: Box): Box = Box(
            left = min(left, other.left),
            top = min(top, other.top),
            right = max(right, other.right),
            bottom = max(bottom, other.bottom),
        )
    }

    data class Word(
        val value: String,
        val start: Int,
        val end: Int,
        val box: Box,
    )

    fun groupMarkedHan(
        text: String,
        marked: BooleanArray,
        characterBoxes: List<Box?>,
    ): List<Word> {
        if (text.isEmpty() || marked.isEmpty() || characterBoxes.isEmpty()) return emptyList()

        val result = mutableListOf<Word>()
        var runStart = -1
        var runEnd = -1
        var runBox: Box? = null
        var previousBox: Box? = null
        var index = 0

        fun flush() {
            val box = runBox
            if (runStart >= 0 && runEnd > runStart && box != null && box.isValid) {
                val value = text.substring(runStart, runEnd)
                val codePoints = value.codePointCount(0, value.length)
                if (codePoints in 1..MAX_WORD_CODEPOINTS) {
                    result += Word(value, runStart, runEnd, box)
                }
            }
            runStart = -1
            runEnd = -1
            runBox = null
            previousBox = null
        }

        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            val next = index + Character.charCount(codePoint)
            val box = characterBoxes.getOrNull(index)?.takeIf(Box::isValid)
            val isMarked = ChineseSegmenter.isHan(codePoint) &&
                box != null &&
                (index until next.coerceAtMost(marked.size)).any { marked[it] }

            if (!isMarked) {
                flush()
                index = next
                continue
            }

            val previous = previousBox
            val sameLine = previous == null || verticalOverlap(previous, box!!) >= MIN_LINE_OVERLAP
            val closeEnough = previous == null ||
                box!!.left - previous.right <= max(previous.height, box.height) * MAX_GAP_IN_GLYPHS

            if (runStart >= 0 && (!sameLine || !closeEnough)) flush()

            if (runStart < 0) {
                runStart = index
                runBox = box
            } else {
                runBox = runBox!!.union(box!!)
            }
            runEnd = next
            previousBox = box
            index = next
        }
        flush()
        return result
    }

    private fun verticalOverlap(first: Box, second: Box): Float {
        val intersection = min(first.bottom, second.bottom) - max(first.top, second.top)
        if (intersection <= 0f) return 0f
        val smaller = min(first.height, second.height)
        return if (smaller <= 0f) 0f else intersection / smaller
    }

    private const val MAX_WORD_CODEPOINTS = 24
    private const val MIN_LINE_OVERLAP = 0.55f
    private const val MAX_GAP_IN_GLYPHS = 0.45f
}
