package smartbook.pinyin

/** A token keeps original UTF-16 offsets, so Smart Book click spans stay valid. */
data class ChineseToken(
    val text: String,
    val start: Int,
    val end: Int,
    val isHan: Boolean,
) {
    init {
        require(start >= 0)
        require(end >= start)
    }
}

/**
 * Offline dictionary segmenter.
 *
 * Reader AI used greedy longest-match as a local fallback. This port uses a
 * small dynamic-programming pass instead: it strongly penalises orphaned
 * one-character tails, fixing common failures such as 研究生 + 命 when the
 * sentence actually contains 研究 + 生命.
 */
class ChineseSegmenter(
    private val lexicon: ChineseLexicon,
    private val hardMaxWordLength: Int = 12,
) {
    fun segment(text: String, preferredBoundaries: Set<Int> = emptySet()): List<ChineseToken> {
        if (text.isEmpty()) return emptyList()
        val out = ArrayList<ChineseToken>()
        var cursor = 0
        while (cursor < text.length) {
            val cp = text.codePointAt(cursor)
            val han = isHan(cp)
            var end = cursor + Character.charCount(cp)
            while (end < text.length) {
                val next = text.codePointAt(end)
                if (isHan(next) != han) break
                end += Character.charCount(next)
            }
            if (han) {
                out += segmentHanRun(text, cursor, end, preferredBoundaries)
            } else {
                out += ChineseToken(text.substring(cursor, end), cursor, end, false)
            }
            cursor = end
        }
        return out
    }

    private fun segmentHanRun(
        fullText: String,
        runStart: Int,
        runEnd: Int,
        preferredBoundaries: Set<Int>,
    ): List<ChineseToken> {
        val boundaries = ArrayList<Int>()
        boundaries += runStart
        var p = runStart
        while (p < runEnd) {
            p += Character.charCount(fullText.codePointAt(p))
            boundaries += p
        }
        val count = boundaries.size - 1
        val best = arrayOfNulls<Path>(count + 1)
        best[count] = Path(score = 0.0, singletons = 0, tokens = 0, next = count)
        val maxLen = minOf(hardMaxWordLength, lexicon.maxWordLength.coerceAtLeast(1))

        for (i in count - 1 downTo 0) {
            var winner: Path? = null
            val limit = minOf(count, i + maxLen)
            for (j in i + 1..limit) {
                val word = fullText.substring(boundaries[i], boundaries[j])
                val length = j - i
                val known = lexicon.contains(word)
                if (!known && length > 1) continue
                val tail = best[j] ?: continue
                val absoluteEnd = boundaries[j]
                val boundaryBonus = if (absoluteEnd in preferredBoundaries) 1.25 else 0.0
                val tokenScore = when {
                    length == 1 && known -> -3.0
                    length == 1 -> -5.0
                    else -> (length * length).toDouble() - 0.5
                } + boundaryBonus
                val candidate = Path(
                    score = tokenScore + tail.score,
                    singletons = tail.singletons + if (length == 1) 1 else 0,
                    tokens = tail.tokens + 1,
                    next = j,
                )
                if (candidate.betterThan(winner)) winner = candidate
            }
            best[i] = winner ?: Path(-5.0 + (best[i + 1]?.score ?: 0.0), 1, 1, i + 1)
        }

        val out = ArrayList<ChineseToken>()
        var i = 0
        while (i < count) {
            val j = best[i]?.next?.takeIf { it > i } ?: (i + 1)
            val start = boundaries[i]
            val end = boundaries[j]
            out += ChineseToken(fullText.substring(start, end), start, end, true)
            i = j
        }
        return out
    }

    private data class Path(
        val score: Double,
        val singletons: Int,
        val tokens: Int,
        val next: Int,
    ) {
        fun betterThan(other: Path?): Boolean {
            if (other == null) return true
            if (score != other.score) return score > other.score
            if (singletons != other.singletons) return singletons < other.singletons
            if (tokens != other.tokens) return tokens < other.tokens
            return next > other.next
        }
    }

    companion object {
        fun isHan(codePoint: Int): Boolean =
            codePoint in 0x3400..0x4DBF ||
                codePoint in 0x4E00..0x9FFF ||
                codePoint in 0xF900..0xFAFF ||
                codePoint in 0x20000..0x2EBEF ||
                codePoint in 0x30000..0x323AF
    }
}
