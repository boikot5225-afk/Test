package com.bulat.smartbookoverlay

import android.content.Context
import smartbook.pinyin.ChineseSegmenter

class TrackedWordStore(context: Context) {
    private val prefs = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)

    fun snapshot(): Set<String> =
        prefs.getStringSet(MainActivity.PREF_TRACKED_WORDS, emptySet())
            ?.toSet()
            .orEmpty()

    fun add(rawWord: String): String? = addAll(listOf(rawWord)).firstOrNull()
        ?: normalize(rawWord)?.takeIf { it in snapshot() }

    /** Returns only words that were not present before this call. */
    fun addAll(rawWords: Iterable<String>): Set<String> {
        val normalized = rawWords.mapNotNull(::normalize).toSet()
        if (normalized.isEmpty()) return emptySet()

        val words = snapshot().toMutableSet()
        val added = normalized.filterTo(LinkedHashSet()) { words.add(it) }
        if (added.isNotEmpty()) {
            prefs.edit().putStringSet(MainActivity.PREF_TRACKED_WORDS, words).apply()
        }
        return added
    }

    fun remove(rawWord: String): String? {
        val word = normalize(rawWord) ?: return null
        val words = snapshot().toMutableSet()
        if (!words.remove(word)) return null
        prefs.edit().putStringSet(MainActivity.PREF_TRACKED_WORDS, words).apply()
        return word
    }

    fun clear() {
        prefs.edit().remove(MainActivity.PREF_TRACKED_WORDS).apply()
    }

    companion object {
        fun normalize(raw: String): String? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null

            var bestStart = -1
            var bestEnd = -1
            var runStart = -1
            var index = 0
            while (index < trimmed.length) {
                val codePoint = Character.codePointAt(trimmed, index)
                val charCount = Character.charCount(codePoint)
                if (ChineseSegmenter.isHan(codePoint)) {
                    if (runStart < 0) runStart = index
                } else if (runStart >= 0) {
                    if (bestStart < 0 || index - runStart > bestEnd - bestStart) {
                        bestStart = runStart
                        bestEnd = index
                    }
                    runStart = -1
                }
                index += charCount
            }
            if (runStart >= 0 && (bestStart < 0 || trimmed.length - runStart > bestEnd - bestStart)) {
                bestStart = runStart
                bestEnd = trimmed.length
            }
            if (bestStart < 0 || bestEnd <= bestStart) return null

            val word = trimmed.substring(bestStart, bestEnd)
            val codePoints = word.codePointCount(0, word.length)
            return word.takeIf { codePoints in 1..MAX_WORD_CODEPOINTS }
        }

        private const val MAX_WORD_CODEPOINTS = 24
    }
}
