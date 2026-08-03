package com.bulat.smartbookoverlay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StudyWordGeometryTest {
    @Test
    fun onlyTheMarkedStudyWordIsGrouped() {
        val text = "既然你没有任何根据，那你为什么要指点孟芸？如果让她自己判断，或许会有更大的正确概率。吗"
        val boxes = characterBoxes(text)
        val marked = BooleanArray(text.length)
        val start = text.indexOf("概率")
        for (index in start until start + "概率".length) marked[index] = true

        val words = StudyWordGeometry.groupMarkedHan(text, marked, boxes)

        assertEquals(listOf("概率"), words.map { it.value })
        assertEquals(start, words.single().start)
        assertEquals(start + 2, words.single().end)
        assertFalse(words.any { it.value.contains("你") })
        assertFalse(words.any { it.value.contains("吗") })
        assertTrue(words.single().box.width > 80f)
    }

    @Test
    fun markedCharactersOnDifferentLinesNeverMerge() {
        val text = "问题"
        val boxes = listOf(
            StudyWordGeometry.Box(80f, 300f, 128f, 356f),
            StudyWordGeometry.Box(80f, 370f, 128f, 426f),
        )
        val marked = booleanArrayOf(true, true)

        val words = StudyWordGeometry.groupMarkedHan(text, marked, boxes)

        assertEquals(listOf("问", "题"), words.map { it.value })
    }

    private fun characterBoxes(text: String): List<StudyWordGeometry.Box?> {
        val result = MutableList<StudyWordGeometry.Box?>(text.length) { null }
        var x = 80f
        var y = 340f
        var index = 0
        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            val count = Character.charCount(codePoint)
            val box = StudyWordGeometry.Box(x, y, x + 48f, y + 56f)
            repeat(count) { offset -> result[index + offset] = box }
            x += 52f
            if (x > 600f || codePoint == '，'.code || codePoint == '？'.code) {
                x = 80f
                y += 92f
            }
            index += count
        }
        return result
    }
}
