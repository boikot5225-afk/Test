package com.bulat.smartbookoverlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RubyLabelGeometryTest {
    @Test
    fun samsungStatusBarOriginIsRemovedBeforeDrawing() {
        // Regression from the user's Galaxy A54 screenshot: 概率 occupies y=435..490 in screen
        // coordinates, while the accessibility overlay's local origin begins below the status bar.
        val word = RubyLabelGeometry.Box(140f, 435f, 256f, 490f)
        val originY = 48f
        val gap = 8f

        val placement = RubyLabelGeometry.placeAboveWord(
            screenWordBounds = word,
            overlayOriginX = 0f,
            overlayOriginY = originY,
            viewportWidth = 709f,
            textWidth = 52f,
            fontAscent = -18f,
            fontDescent = 5f,
            gapPx = gap,
            paddingPx = 2f,
        )

        assertNotNull(placement)
        placement!!
        assertEquals(word.centerX, placement.centerX, 0.01f)
        assertEquals(word.centerX, placement.centerX, 0.01f)
        assertTrue(placement.labelBounds.bottom + originY <= word.top - gap + 0.01f)
        assertTrue(placement.baseline + originY < word.top)
    }

    @Test
    fun paddedRubyNeverTouchesTheChineseGlyphRectangle() {
        val word = RubyLabelGeometry.Box(180f, 460f, 270f, 520f)
        val placement = RubyLabelGeometry.placeAboveWord(
            screenWordBounds = word,
            overlayOriginX = 0f,
            overlayOriginY = 36f,
            viewportWidth = 709f,
            textWidth = 60f,
            fontAscent = -20f,
            fontDescent = 6f,
            gapPx = 10f,
            paddingPx = 3f,
        )!!

        val screenLabelBottom = placement.labelBounds.bottom + 36f
        assertEquals(word.top - 10f, screenLabelBottom, 0.01f)
        assertTrue(screenLabelBottom < word.top)
    }

    @Test
    fun placementIsSkippedWhenThereIsNoRoomAboveTheWord() {
        val placement = RubyLabelGeometry.placeAboveWord(
            screenWordBounds = RubyLabelGeometry.Box(100f, 20f, 180f, 70f),
            overlayOriginX = 0f,
            overlayOriginY = 0f,
            viewportWidth = 709f,
            textWidth = 80f,
            fontAscent = -24f,
            fontDescent = 7f,
            gapPx = 8f,
            paddingPx = 2f,
        )

        assertEquals(null, placement)
    }
}
