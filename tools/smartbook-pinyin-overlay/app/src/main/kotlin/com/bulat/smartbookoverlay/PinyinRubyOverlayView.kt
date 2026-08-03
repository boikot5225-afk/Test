package com.bulat.smartbookoverlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import smartbook.pinyin.PinyinAnnotation
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class PinyinRubyOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val sourcePaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val rubyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = android.graphics.Typeface.DEFAULT_BOLD
    }

    private var sourceText: String = ""
    private var annotations: List<PinyinAnnotation> = emptyList()
    private var sourceWidthPx: Int = 1
    private var sourceHeightPx: Int = 1
    private var sourceTopOffsetPx: Int = 0
    private var preferredRubySp: Float = DEFAULT_RUBY_SP
    private var foregroundColor: Int = Color.DKGRAY
    private var layout: StaticLayout? = null

    init {
        setBackgroundColor(Color.TRANSPARENT)
        isClickable = false
        isLongClickable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    fun configure(
        text: String,
        annotations: List<PinyinAnnotation>,
        widthPx: Int,
        heightPx: Int,
        topOffsetPx: Int,
        rubySp: Float,
        color: Int,
    ) {
        sourceText = text
        this.annotations = annotations.sortedBy { it.start }
        sourceWidthPx = max(1, widthPx)
        sourceHeightPx = max(1, heightPx)
        sourceTopOffsetPx = max(0, topOffsetPx)
        preferredRubySp = rubySp.coerceIn(MIN_RUBY_SP, MAX_RUBY_SP)
        foregroundColor = color
        layout = buildClosestLayout()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val currentLayout = layout ?: return
        if (sourceText.isEmpty() || annotations.isEmpty()) return

        rubyPaint.color = foregroundColor
        val occupiedByLine = HashMap<Int, MutableList<FloatRange>>()

        for (annotation in annotations) {
            val start = annotation.start.coerceIn(0, sourceText.length)
            val end = annotation.end.coerceIn(start, sourceText.length)
            if (start >= end) continue

            val line = currentLayout.getLineForOffset(start)
            val lineEnd = min(end, currentLayout.getLineEnd(line))
            if (lineEnd <= start) continue

            var startX = currentLayout.getPrimaryHorizontal(start)
            var endX = currentLayout.getPrimaryHorizontal(lineEnd)
            if (endX < startX) {
                val swap = startX
                startX = endX
                endX = swap
            }
            val wordWidth = max(dp(12).toFloat(), endX - startX)
            val centerX = ((startX + endX) / 2f).coerceIn(0f, sourceWidthPx.toFloat())

            var rubySizeSp = preferredRubySp
            rubyPaint.textSize = sp(rubySizeSp)
            var rubyWidth = rubyPaint.measureText(annotation.pinyin)
            while (rubyWidth > wordWidth * 1.45f && rubySizeSp > MIN_RUBY_SP) {
                rubySizeSp -= 0.5f
                rubyPaint.textSize = sp(rubySizeSp)
                rubyWidth = rubyPaint.measureText(annotation.pinyin)
            }

            val left = centerX - rubyWidth / 2f
            val right = centerX + rubyWidth / 2f
            val ranges = occupiedByLine.getOrPut(line) { mutableListOf() }
            val clashes = ranges.any { existing ->
                left < existing.endInclusive + dp(2) && right > existing.start - dp(2)
            }
            if (clashes) continue
            ranges += left..right

            val lineTop = currentLayout.getLineTop(line)
            val baseline = sourceTopOffsetPx + lineTop - dp(1)
            if (baseline - rubyPaint.fontMetrics.ascent < 0f) continue
            canvas.drawText(annotation.pinyin, centerX, baseline.toFloat(), rubyPaint)
        }
    }

    private fun buildClosestLayout(): StaticLayout {
        var best: StaticLayout? = null
        var bestDifference = Int.MAX_VALUE
        var sizeSp = MIN_SOURCE_SP

        while (sizeSp <= MAX_SOURCE_SP) {
            sourcePaint.textSize = sp(sizeSp)
            val candidate = StaticLayout.Builder.obtain(
                sourceText,
                0,
                sourceText.length,
                sourcePaint,
                sourceWidthPx,
            )
                .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                .setIncludePad(true)
                .setLineSpacing(0f, 1f)
                .setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE)
                .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
                .build()

            val difference = abs(candidate.height - sourceHeightPx)
            if (difference < bestDifference) {
                best = candidate
                bestDifference = difference
            }
            sizeSp += 0.5f
        }

        return best ?: StaticLayout.Builder.obtain(
            sourceText,
            0,
            sourceText.length,
            sourcePaint,
            sourceWidthPx,
        ).build()
    }

    private fun sp(value: Float): Float = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_SP,
        value,
        resources.displayMetrics,
    )

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val DEFAULT_RUBY_SP = 10f
        private const val MIN_RUBY_SP = 7f
        private const val MAX_RUBY_SP = 16f
        private const val MIN_SOURCE_SP = 14f
        private const val MAX_SOURCE_SP = 36f
    }
}
