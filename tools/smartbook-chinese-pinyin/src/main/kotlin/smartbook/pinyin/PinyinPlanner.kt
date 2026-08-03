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
    private val contextualResolver: ContextualPinyinResolver = ContextualPinyinResolver(lexicon),
) {
    fun plan(
        text: String,
        mode: PinyinMode = PinyinMode.UNKNOWN_ONLY,
        isLearnt: (String) -> Boolean,
        preferredBoundaries: Set<Int> = emptySet(),
    ): List<PinyinAnnotation> {
        if (mode == PinyinMode.OFF || text.isBlank()) return emptyList()
        val tokens = segmenter.segment(text, preferredBoundaries)
        return tokens.asSequence()
            .withIndex()
            .filter { it.value.isHan }
            .filterNot { mode == PinyinMode.UNKNOWN_ONLY && isLearnt(it.value.text) }
            .mapNotNull { indexed ->
                val token = indexed.value
                val reading = contextualResolver.resolve(token, indexed.index, tokens)
                    ?.let(PinyinFormatter::compact)
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
