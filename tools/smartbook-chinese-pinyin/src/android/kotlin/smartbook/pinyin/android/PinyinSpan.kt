package smartbook.pinyin.android

import android.graphics.Canvas
import android.graphics.Paint
import android.text.TextPaint
import android.text.style.ReplacementSpan
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Draws pinyin above the same character range without inserting characters.
 * ReaderSpan remains responsible for clicks and colours.
 */
class PinyinSpan(
    val pinyin: String,
    private val rubyScale: Float = 0.43f,
    private val gapPx: Float = 1.5f,
    private val maxWidthMultiplier: Float = 1.35f,
    private val minHorizontalScale: Float = 0.58f,
) : ReplacementSpan() {

    override fun getSize(
        paint: Paint,
        text: CharSequence,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int {
        val box = measureBox(paint, text, start, end)
        if (fm != null) {
            val base = paint.fontMetricsInt
            val ruby = rubyPaint(paint).fontMetricsInt
            val extra = ceil((ruby.descent - ruby.ascent) + gapPx).toInt()
            fm.top = base.top - extra
            fm.ascent = base.ascent - extra
            fm.descent = base.descent
            fm.bottom = base.bottom
            fm.leading = base.leading
        }
        return ceil(box.width).toInt()
    }

    override fun draw(
        canvas: Canvas,
        text: CharSequence,
        start: Int,
        end: Int,
        x: Float,
        top: Int,
        y: Int,
        bottom: Int,
        paint: Paint,
    ) {
        val box = measureBox(paint, text, start, end)
        val ruby = rubyPaint(paint).apply { textScaleX = box.rubyScaleX }
        val baseX = x + (box.width - box.baseWidth) / 2f
        val rubyX = x + (box.width - box.rubyWidth) / 2f

        canvas.drawText(text, start, end, baseX, y.toFloat(), paint)

        val baseMetrics = paint.fontMetrics
        val rubyMetrics = ruby.fontMetrics
        val rubyBottom = y + baseMetrics.ascent - gapPx
        val rubyBaseline = rubyBottom - rubyMetrics.descent
        canvas.drawText(pinyin, rubyX, rubyBaseline, ruby)
    }

    private fun measureBox(paint: Paint, text: CharSequence, start: Int, end: Int): Box {
        val baseWidth = paint.measureText(text, start, end).coerceAtLeast(1f)
        val ruby = rubyPaint(paint)
        val rawRubyWidth = ruby.measureText(pinyin).coerceAtLeast(1f)
        val targetRubyWidth = min(rawRubyWidth, baseWidth * maxWidthMultiplier)
        val scaleX = max(minHorizontalScale, min(1f, targetRubyWidth / rawRubyWidth))
        val rubyWidth = rawRubyWidth * scaleX
        return Box(max(baseWidth, rubyWidth), baseWidth, rubyWidth, scaleX)
    }

    private fun rubyPaint(base: Paint): TextPaint = TextPaint(base).apply {
        textSize = base.textSize * rubyScale
        isUnderlineText = false
        isStrikeThruText = false
        letterSpacing = 0f
    }

    private data class Box(
        val width: Float,
        val baseWidth: Float,
        val rubyWidth: Float,
        val rubyScaleX: Float,
    )
}
