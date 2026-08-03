package smartbook.pinyin

object BookLanguage {
    fun isChinese(raw: String?): Boolean {
        val code = normalize(raw) ?: return false
        return code == "zh" || code.startsWith("zh-") ||
            code == "chinese" || code == "中文" || code == "汉语" || code == "漢語"
    }

    fun normalize(raw: String?): String? {
        val value = raw
            ?.trim()
            ?.replace('_', '-')
            ?.lowercase()
            ?.takeIf { it.isNotEmpty() }
            ?: return null
        return when (value) {
            "cn", "zh-cn", "zh-hans", "chinese-simplified", "simplified-chinese" -> "zh-cn"
            "tw", "zh-tw", "zh-hk", "zh-hant", "chinese-traditional", "traditional-chinese" -> "zh-tw"
            "chi", "zho" -> "zh"
            else -> value
        }
    }
}
