package smartbook.pinyin

private fun assertEquals(expected: Any?, actual: Any?, message: String) {
    if (expected != actual) error("$message\nexpected: $expected\nactual:   $actual")
}

private fun assertTrue(value: Boolean, message: String) {
    if (!value) error(message)
}

fun main() {
    val lexicon = MapChineseLexicon.from(
        linkedMapOf(
            "我" to "wǒ",
            "很" to "hěn",
            "的" to "de",
            "人" to "rén",
            "银行" to "yín háng",
            "行长" to "háng zhǎng",
            "重要" to "zhòng yào",
            "重庆" to "Chóng qìng",
            "长大" to "zhǎng dà",
            "研究" to "yán jiū",
            "生命" to "shēng mìng",
            "研究生" to "yán jiū shēng",
            "命" to "mìng",
        )
    )
    val segmenter = ChineseSegmenter(lexicon)

    val sample = "银行行长很重要。"
    val tokens = segmenter.segment(sample)
    assertEquals(listOf("银行", "行长", "很", "重要", "。"), tokens.map { it.text }, "basic segmentation")
    assertEquals(sample, tokens.joinToString("") { it.text }, "segmentation must preserve text exactly")
    tokens.forEach { token ->
        assertEquals(token.text, sample.substring(token.start, token.end), "UTF-16 offsets must remain exact")
    }

    val ambiguity = segmenter.segment("研究生命")
    assertEquals(listOf("研究", "生命"), ambiguity.map { it.text }, "avoid greedy 研究生 + 命 failure")

    val proper = segmenter.segment("重庆长大的人")
    assertEquals(listOf("重庆", "长大", "的", "人"), proper.map { it.text }, "polyphonic words stay whole")

    val planner = PinyinPlanner(lexicon, segmenter)
    val unknownOnly = planner.plan(sample, PinyinMode.UNKNOWN_ONLY, isLearnt = { it == "银行" })
    assertEquals(listOf("行长", "很", "重要"), unknownOnly.map { it.word }, "learnt word must lose pinyin")
    assertEquals(listOf("hángzhǎng", "hěn", "zhòngyào"), unknownOnly.map { it.pinyin }, "pinyin should be compact")

    val all = planner.plan(sample, PinyinMode.ALL, isLearnt = { true })
    assertTrue(all.any { it.word == "银行" && it.pinyin == "yínháng" }, "ALL mode must ignore learnt state")
    assertEquals(
        emptyList<PinyinAnnotation>(),
        planner.plan(sample, PinyinMode.OFF, isLearnt = { false }),
        "OFF mode",
    )

    val contextualLexicon = MapChineseLexicon.from(
        linkedMapOf(
            "他" to "tā", "我" to "wǒ", "们" to "men", "得" to "dé", "去" to "qù",
            "还" to "Huán", "在" to "zài", "看" to "kān", "书" to "shū",
            "这" to "zhè", "个" to "gè", "办" to "bàn", "法" to "fǎ", "行" to "háng",
            "一" to "yī", "只" to "zhī", "猫" to "māo", "都" to "Dū", "来" to "lái",
        )
    )
    val contextualPlanner = PinyinPlanner(contextualLexicon)
    fun reading(text: String, word: String): String? = contextualPlanner
        .plan(text, PinyinMode.ALL, isLearnt = { false })
        .firstOrNull { it.word == word }?.pinyin

    assertEquals("děi", reading("我得去", "得"), "得 before an action must be děi")
    assertEquals("hái", reading("他还在", "还"), "还 as still must be hái")
    assertEquals("kàn", reading("他看书", "看"), "看 as read/look must be kàn")
    assertEquals("xíng", reading("这个办法行", "行"), "standalone 行 meaning okay must be xíng")
    assertEquals("zhī", reading("一只猫", "只"), "只 after a numeral must be classifier zhī")
    assertEquals("dōu", reading("他们都来", "都"), "ordinary 都 must be dōu, not surname Dū")

    assertTrue(BookLanguage.isChinese("zh"), "zh must enable pinyin")
    assertTrue(BookLanguage.isChinese("zh_CN"), "zh_CN must enable pinyin")
    assertTrue(BookLanguage.isChinese("Chinese"), "Chinese must enable pinyin")
    assertTrue(!BookLanguage.isChinese("ja"), "Japanese books must never get Chinese pinyin")
    assertTrue(!BookLanguage.isChinese(null), "unknown language must fail closed")

    val supplementary = "𠀀人"
    val supplementaryTokens = segmenter.segment(supplementary)
    assertEquals(supplementary, supplementaryTokens.joinToString("") { it.text }, "supplementary CJK must not corrupt offsets")

    println("OK: segmentation, learnt-word filtering, language gating and contextual polyphone checks")
}
