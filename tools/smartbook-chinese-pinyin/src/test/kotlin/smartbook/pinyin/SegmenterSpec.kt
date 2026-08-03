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

    val supplementary = "𠀀人"
    val supplementaryTokens = segmenter.segment(supplementary)
    assertEquals(supplementary, supplementaryTokens.joinToString("") { it.text }, "supplementary CJK must not corrupt offsets")

    println("OK: ${tokens.size + ambiguity.size + proper.size} segmentation checks; ${unknownOnly.size} pinyin annotations")
}
