package com.bulat.smartbookoverlay

import kotlin.math.max

/** Pure screen-to-overlay geometry used by the ruby renderer and JVM regression tests. */
object RubyLabelGeometry {
    data class Box(
        val left: Float,
        val top: Float,
        val right: Float,
        val bottom: Float,
    ) {
        val width: Float get() = right - left
        val height: Float get() = bottom - top
        val centerX: Float get() = (left + right) / 2f
        val isValid: Boolean
            get() = left.isFinite() && top.isFinite() && right.isFinite() && bottom.isFinite() &&
                width > 0f && height > 0f

        fun offset(dx: Float, dy: Float): Box = Box(
            left = left + dx,
            top = top + dy,
            right = right + dx,
            bottom = bottom + dy,
        )
    }

    data class Placement(
        val centerX: Float,
        val baseline: Float,
        val labelBounds: Box,
        val localWordBounds: Box,
    )

    /**
     * Character locations are supplied in absolute screen coordinates, while Canvas uses the
     * overlay view's local coordinates. Samsung may place an accessibility overlay below the
     * status bar even with FLAG_LAYOUT_IN_SCREEN, so the real on-screen view origin must always
     * be subtracted.
     *
     * The label's padded bottom is guaranteed to stay [gapPx] above the word rectangle.
     */
    fun placeAboveWord(
        screenWordBounds: Box,
        overlayOriginX: Float,
        overlayOriginY: Float,
        viewportWidth: Float,
        textWidth: Float,
        fontAscent: Float,
        fontDescent: Float,
        gapPx: Float,
        paddingPx: Float,
    ): Placement? {
        if (!screenWordBounds.isValid || viewportWidth <= 0f || textWidth <= 0f) return null
        if (!fontAscent.isFinite() || !fontDescent.isFinite()) return null

        val localWord = screenWordBounds.offset(-overlayOriginX, -overlayOriginY)
        val safeGap = max(0f, gapPx)
        val safePadding = max(0f, paddingPx)
        val halfWidth = textWidth / 2f + safePadding
        if (halfWidth * 2f > viewportWidth) return null

        val centerX = localWord.centerX.coerceIn(halfWidth, viewportWidth - halfWidth)
        val baseline = localWord.top - safeGap - safePadding - fontDescent
        val labelBounds = Box(
            left = centerX - halfWidth,
            top = baseline + fontAscent - safePadding,
            right = centerX + halfWidth,
            bottom = baseline + fontDescent + safePadding,
        )

        if (!labelBounds.isValid || labelBounds.top < 0f) return null
        if (labelBounds.bottom > localWord.top - safeGap + 0.01f) return null

        return Placement(
            centerX = centerX,
            baseline = baseline,
            labelBounds = labelBounds,
            localWordBounds = localWord,
        )
    }
}
