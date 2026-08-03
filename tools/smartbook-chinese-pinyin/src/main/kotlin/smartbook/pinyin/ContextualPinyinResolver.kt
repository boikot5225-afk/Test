package smartbook.pinyin

/**
 * Corrects the first-reading bias of CC-CEDICT for common one-character
 * polyphones. Multi-character dictionary words remain authoritative.
 */
class ContextualPinyinResolver(
    private val lexicon: ChineseLexicon,
) {
    fun resolve(token: ChineseToken, index: Int, tokens: List<ChineseToken>): String? {
        val dictionaryReading = lexicon.pinyin(token.text) ?: return null
        if (!token.isHan || token.text.codePointCount(0, token.text.length) != 1) {
            return dictionaryReading
        }

        val previous = tokens.previousHan(index)?.text.orEmpty()
        val next = tokens.nextHan(index)?.text.orEmpty()
        val previousLast = previous.lastOrNull()
        val nextFirst = next.firstOrNull()

        return when (token.text) {
            "还" -> if (nextFirst in HUAN_OBJECTS || previousLast in HUAN_PREFIXES) "huán" else "hái"
            "行" -> "xíng"
            "看" -> if (nextFirst in KAN_CARE_OBJECTS) "kān" else "kàn"
            "长" -> if (previousLast in ZHANG_TITLES) "zhǎng" else "cháng"
            "重" -> if (nextFirst in CHONG_ACTIONS) "chóng" else "zhòng"
            "都" -> "dōu"
            "着" -> "zhe"
            "得" -> resolveDe(previous, next)
            "地" -> if (previousLast in DI_PREPOSITIONS || nextFirst in DI_NOUNS) "dì" else "de"
            "了" -> if (previousLast == '不' || previousLast == '得') "liǎo" else "le"
            "只" -> if (previousLast in CLASSIFIER_PREVIOUS) "zhī" else "zhǐ"
            "种" -> if (nextFirst in PLANT_OBJECTS || previousLast in PLANT_MODALS) "zhòng" else "zhǒng"
            "数" -> if (nextFirst in COUNT_TARGETS || nextFirst?.isChineseNumeral() == true) "shǔ" else "shù"
            "觉" -> if (previousLast in SLEEP_PREFIXES) "jiào" else "jué"
            "便" -> if (nextFirst == '宜') "pián" else "biàn"
            "教" -> if (nextFirst in TEACH_OBJECTS) "jiāo" else "jiào"
            "处" -> if (nextFirst in CHU_ACTIONS) "chǔ" else "chù"
            "干" -> if (nextFirst in GAN_DRY_OBJECTS || previousLast in GAN_DRY_PREFIXES) "gān" else "gàn"
            "相" -> if (nextFirst in XIANG_APPEARANCE_OBJECTS) "xiàng" else "xiāng"
            "乐" -> if (nextFirst in YUE_MUSIC_OBJECTS || previousLast in YUE_MUSIC_PREFIXES) "yuè" else "lè"
            "为" -> if (nextFirst in WEI_OBJECTS || previousLast == '因') "wèi" else "wéi"
            "发" -> if (previousLast in FA_HAIR_PREFIXES || nextFirst in FA_HAIR_OBJECTS) "fà" else "fā"
            "和" -> "hé"
            "给" -> "gěi"
            "省" -> "shěng"
            "当" -> "dāng"
            else -> dictionaryReading
        }
    }

    private fun resolveDe(previous: String, next: String): String {
        val previousLast = previous.lastOrNull()
        val nextFirst = next.firstOrNull()
        if (nextFirst in DEI_ACTIONS && (previous.isEmpty() || previousLast in DEI_SUBJECTS)) {
            return "děi"
        }
        if (previous.isNotEmpty() && next.isNotEmpty()) return "de"
        return "dé"
    }

    private fun List<ChineseToken>.previousHan(index: Int): ChineseToken? {
        for (i in index - 1 downTo 0) if (this[i].isHan) return this[i]
        return null
    }

    private fun List<ChineseToken>.nextHan(index: Int): ChineseToken? {
        for (i in index + 1 until size) if (this[i].isHan) return this[i]
        return null
    }

    private fun Char.isChineseNumeral(): Boolean = this in "零〇一二两三四五六七八九十百千万亿"

    private companion object {
        val HUAN_OBJECTS = "钱书债款车钥物给回".toSet()
        val HUAN_PREFIXES = "归退偿返".toSet()
        val KAN_CARE_OBJECTS = "门家守管押病场孩子".toSet()
        val ZHANG_TITLES = "校局队班组院会处科部店厂村镇营师团舰站省市县".toSet()
        val CHONG_ACTIONS = "新复来写做读建组启播演试申审".toSet()
        val DI_PREPOSITIONS = "在到从离向往".toSet()
        val DI_NOUNS = "上下方球图点区位面板址".toSet()
        val CLASSIFIER_PREVIOUS = "一二两三四五六七八九十百千万几每这那各".toSet()
        val PLANT_OBJECTS = "花树菜田地粮稻麦果庄".toSet()
        val PLANT_MODALS = "想要来去在能会可".toSet()
        val COUNT_TARGETS = "人数钱书天次个件张页".toSet()
        val SLEEP_PREFIXES = "睡午困一".toSet()
        val TEACH_OBJECTS = "我你他她们人学生孩子徒弟".toSet()
        val CHU_ACTIONS = "在理置罚决事".toSet()
        val GAN_DRY_OBJECTS = "燥净杯粮旱枯柴".toSet()
        val GAN_DRY_PREFIXES = "晒烘吹风".toSet()
        val XIANG_APPEARANCE_OBJECTS = "片貌机框册声术".toSet()
        val YUE_MUSIC_OBJECTS = "音器曲队坛谱理章".toSet()
        val YUE_MUSIC_PREFIXES = "音声民管交".toSet()
        val WEI_OBJECTS = "了着此你我他她们国民公私".toSet()
        val FA_HAIR_PREFIXES = "头理染剪白黑长短洗".toSet()
        val FA_HAIR_OBJECTS = "型丝梢际根".toSet()
        val DEI_ACTIONS = "去来走做看说买卖学写读吃喝睡回找给问".toSet()
        val DEI_SUBJECTS = "我你他她们人谁咱大家还都也就可".toSet()
    }
}
