package smartbook.pinyin.android

import android.text.Spannable
import android.text.SpannableStringBuilder
import smartbook.pinyin.PinyinAnnotation

object SmartBookPinyinApplier {
    fun apply(
        text: SpannableStringBuilder,
        annotations: List<PinyinAnnotation>,
    ) {
        text.getSpans(0, text.length, PinyinSpan::class.java)
            .forEach(text::removeSpan)

        for (annotation in annotations) {
            if (annotation.start !in 0 until text.length) continue
            if (annotation.end <= annotation.start || annotation.end > text.length) continue
            text.setSpan(
                PinyinSpan(annotation.pinyin),
                annotation.start,
                annotation.end,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
    }
}
