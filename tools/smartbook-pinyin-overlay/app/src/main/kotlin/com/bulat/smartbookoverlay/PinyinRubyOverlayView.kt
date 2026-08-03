package com.bulat.smartbookoverlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import kotlin.math.max

/** Full-screen transparent overlay. Labels are already expressed in screen coordinates. */
class PinyinRubyOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    data class Label(
        val pinyin: String,
        val wordBounds: RectF,
    )

    private val rubyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = android.graphics.Typeface.DEFAULT_BOLD
    }
    private var labels: List<Label> = emptyList()
    private var preferredRubySp: Float = DEFAULT_RUBY_SP
    private var foregroundColor: Int = Color.DKGRAY

    init {
        setBackgroundColor(Color.TRANSPARENT)
        isClickable = false
        isLongClickable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    fun configure(
        labels: List<Label>,
        rubySp: Float,
        color: Int,
    ) {
        this.labels = labels
            .filter { it.pinyin.isNotBlank() && !it.wordBounds.isEmpty }
            .sortedWith(compareBy<Label> { it.wordBounds.top }.thenBy { it.wordBounds.left })
        preferredRubySp = rubySp.coerceIn(MIN_RUBY_SP, MAX_RUBY_SP)
        foregroundColor = color
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (labels.isEmpty()) return

        rubyPaint.color = foregroundColor
        val occupied = mutableListOf<RectF>()
        labels.forEach { label ->
            val bounds = label.wordBounds
            var sizeSp = preferredRubySp
            rubyPaint.textSize = sp(sizeSp)
            var width = rubyPaint.measureText(label.pinyin)
            val maximumWidth = max(bounds.width() * 1.55f, dp(28).toFloat())
            while (width > maximumWidth && sizeSp > MIN_RUBY_SP) {
                sizeSp -= 0.5f
                rubyPaint.textSize = sp(sizeSp)
                width = rubyPaint.measureText(label.pinyin)
            }

            val metrics = rubyPaint.fontMetrics
            val centerX = bounds.centerX()
            val baseline = bounds.top - dp(2)
            val labelRect = RectF(
                centerX - width / 2f - dp(2),
                baseline + metrics.ascent - dp(1),
                centerX + width / 2f + dp(2),
                baseline + metrics.descent + dp(1),
            )
            if (labelRect.top < 0f || occupied.any { RectF.intersects(it, labelRect) }) {
                return@forEach
            }

            canvas.drawText(label.pinyin, centerX, baseline, rubyPaint)
            occupied += labelRect
        }
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
    }
}
