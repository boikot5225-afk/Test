package smartbook.pinyin

enum class PinyinMode {
    OFF,
    UNKNOWN_ONLY,
    ALL,
}

data class PinyinAnnotation(
    val word: String,
    val pinyin: String,
    val start: Int,
    val end: Int,
)

class PinyinPlanner(
    private val lexicon: ChineseLexicon,
    private val segmenter: ChineseSegmenter = ChineseSegmenter(lexicon),
) {
    fun plan(
        text: String,
        mode: PinyinMode = PinyinMode.UNKNOWN_ONLY,
        isLearnt: (String) -> Boolean,
        preferredBoundaries: Set<Int> = emptySet(),
    ): List<PinyinAnnotation> {
        if (mode == PinyinMode.OFF || text.isBlank()) return emptyList()
        return segmenter.segment(text, preferredBoundaries)
            .asSequence()
            .filter { it.isHan }
            .filterNot { mode == PinyinMode.UNKNOWN_ONLY && isLearnt(it.text) }
            .mapNotNull { token ->
                val reading = lexicon.pinyin(token.text)?.let(PinyinFormatter::compact)
                    ?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                PinyinAnnotation(token.text, reading, token.start, token.end)
            }
            .toList()
    }
}

object PinyinFormatter {
    /** Ruby is narrow; remove CC-CEDICT's syllable spaces but keep punctuation. */
    fun compact(value: String): String = value
        .trim()
        .replace(Regex("\\s+"), "")
        .replace("u:", "ü", ignoreCase = true)
}
