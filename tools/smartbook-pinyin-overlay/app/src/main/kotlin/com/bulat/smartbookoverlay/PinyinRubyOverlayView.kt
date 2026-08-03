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

/** Full-screen transparent overlay. Label word bounds arrive in absolute screen coordinates. */
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
    private val overlayOrigin = IntArray(2)
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
        if (labels.isEmpty() || width <= 0) return

        // Accessibility character rectangles are absolute screen coordinates. On Samsung the
        // overlay view can start below the status bar, so drawing them directly shifts ruby down
        // into the Chinese glyphs. Convert every label to this view's actual local coordinates.
        getLocationOnScreen(overlayOrigin)

        rubyPaint.color = foregroundColor
        val occupied = mutableListOf<RectF>()
        labels.forEach { label ->
            val bounds = label.wordBounds
            var sizeSp = preferredRubySp
            rubyPaint.textSize = sp(sizeSp)
            var textWidth = rubyPaint.measureText(label.pinyin)
            val maximumWidth = max(bounds.width() * 1.55f, dp(28).toFloat())
            while (textWidth > maximumWidth && sizeSp > MIN_RUBY_SP) {
                sizeSp -= 0.5f
                rubyPaint.textSize = sp(sizeSp)
                textWidth = rubyPaint.measureText(label.pinyin)
            }

            val metrics = rubyPaint.fontMetrics
            val placement = RubyLabelGeometry.placeAboveWord(
                screenWordBounds = RubyLabelGeometry.Box(
                    bounds.left,
                    bounds.top,
                    bounds.right,
                    bounds.bottom,
                ),
                overlayOriginX = overlayOrigin[0].toFloat(),
                overlayOriginY = overlayOrigin[1].toFloat(),
                viewportWidth = width.toFloat(),
                textWidth = textWidth,
                fontAscent = metrics.ascent,
                fontDescent = metrics.descent,
                gapPx = dp(LABEL_GAP_DP).toFloat(),
                paddingPx = dp(COLLISION_PADDING_DP).toFloat(),
            ) ?: return@forEach

            val labelRect = RectF(
                placement.labelBounds.left,
                placement.labelBounds.top,
                placement.labelBounds.right,
                placement.labelBounds.bottom,
            )
            if (occupied.any { RectF.intersects(it, labelRect) }) return@forEach

            canvas.drawText(
                label.pinyin,
                placement.centerX,
                placement.baseline,
                rubyPaint,
            )
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
        private const val LABEL_GAP_DP = 4
        private const val COLLISION_PADDING_DP = 1
    }
}
