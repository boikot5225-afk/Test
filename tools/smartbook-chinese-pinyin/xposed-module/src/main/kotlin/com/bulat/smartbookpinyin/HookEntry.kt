package com.bulat.smartbookpinyin

import android.text.SpannableStringBuilder
import android.text.Spanned
import android.widget.TextView
import de.robv.android.xposed.IXposedHookLoadPackage
import de.robv.android.xposed.IXposedHookZygoteInit
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import de.robv.android.xposed.XposedHelpers
import de.robv.android.xposed.callbacks.XC_LoadPackage
import smartbook.pinyin.ChineseSegmenter
import smartbook.pinyin.MapChineseLexicon
import smartbook.pinyin.PinyinMode
import smartbook.pinyin.PinyinPlanner
import smartbook.pinyin.android.SmartBookPinyinApplier
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile

class HookEntry : IXposedHookLoadPackage, IXposedHookZygoteInit {
    override fun initZygote(startupParam: IXposedHookZygoteInit.StartupParam) {
        ModuleState.modulePath = startupParam.modulePath
    }

    override fun handleLoadPackage(lpparam: XC_LoadPackage.LoadPackageParam) {
        if (lpparam.packageName != TARGET_PACKAGE) return

        ModuleState.preload()
        val readerText = XposedHelpers.findClass(READER_TEXT_CLASS, lpparam.classLoader)
        val readerSpan = XposedHelpers.findClass(READER_SPAN_CLASS, lpparam.classLoader)

        XposedHelpers.findAndHookMethod(
            readerText,
            "setText",
            CharSequence::class.java,
            TextView.BufferType::class.java,
            object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        val source = param.args[0] as? Spanned ?: return
                        if (!containsHan(source)) return

                        // Loading starts at process launch. The bounded wait only protects the
                        // first Chinese paragraph from briefly rendering without annotations.
                        val planner = ModuleState.awaitPlanner(400) ?: return
                        val state = collectSmartBookState(source, readerSpan)
                        val annotations = planner.plan(
                            text = source.toString(),
                            mode = PinyinMode.UNKNOWN_ONLY,
                            isLearnt = state.learntWords::contains,
                            preferredBoundaries = state.preferredBoundaries,
                        )
                        if (annotations.isEmpty()) return

                        val output = SpannableStringBuilder(source)
                        SmartBookPinyinApplier.apply(output, annotations)
                        param.args[0] = output
                        param.args[1] = TextView.BufferType.SPANNABLE
                    } catch (t: Throwable) {
                        XposedBridge.log("SmartBookPinyin: render hook failed: ${t.stackTraceToString()}")
                    }
                }
            },
        )
        XposedBridge.log("SmartBookPinyin: hooked $READER_TEXT_CLASS")
    }

    private fun collectSmartBookState(source: Spanned, readerSpanClass: Class<*>): WordState {
        @Suppress("UNCHECKED_CAST")
        val spans = source.getSpans(0, source.length, readerSpanClass as Class<Any>)
        val learnt = LinkedHashSet<String>()
        val boundaries = LinkedHashSet<Int>()

        for (span in spans) {
            val start = source.getSpanStart(span)
            val end = source.getSpanEnd(span)
            if (start < 0 || end <= start || end > source.length) continue
            val word = source.subSequence(start, end).toString()
            if (!containsHan(word) || word.codePointCount(0, word.length) > 12) continue

            val type = readerSpanType(span) ?: continue
            when (type.name) {
                "Learnt" -> {
                    learnt += word
                    boundaries += start
                    boundaries += end
                }
                "Saved", "Text" -> {
                    boundaries += start
                    boundaries += end
                }
            }
        }
        return WordState(learnt, boundaries)
    }

    private fun readerSpanType(span: Any): Enum<*>? {
        val field = span.javaClass.declaredFields.firstOrNull {
            it.type.name.endsWith("ReaderSpan\$Companion\$Type")
        } ?: return null
        field.isAccessible = true
        return field.get(span) as? Enum<*>
    }

    private fun containsHan(text: CharSequence): Boolean {
        var index = 0
        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            if (ChineseSegmenter.isHan(codePoint)) return true
            index += Character.charCount(codePoint)
        }
        return false
    }

    private data class WordState(
        val learntWords: Set<String>,
        val preferredBoundaries: Set<Int>,
    )

    private object ModuleState {
        @Volatile var modulePath: String? = null
        @Volatile private var planner: PinyinPlanner? = null
        private val started = AtomicBoolean(false)
        private val ready = CountDownLatch(1)

        fun preload() {
            if (!started.compareAndSet(false, true)) return
            Thread({
                try {
                    val path = requireNotNull(modulePath) { "module path unavailable" }
                    ZipFile(path).use { zip ->
                        val entry = requireNotNull(zip.getEntry(LEXICON_ASSET)) {
                            "pinyin dictionary asset not found"
                        }
                        zip.getInputStream(entry).use { input ->
                            val lexicon = MapChineseLexicon.fromGzipTsv(input)
                            planner = PinyinPlanner(lexicon)
                            XposedBridge.log(
                                "SmartBookPinyin: loaded dictionary; maxWordLength=${lexicon.maxWordLength}",
                            )
                        }
                    }
                } catch (t: Throwable) {
                    XposedBridge.log("SmartBookPinyin: dictionary load failed: ${t.stackTraceToString()}")
                } finally {
                    ready.countDown()
                }
            }, "smartbook-pinyin-loader").apply {
                isDaemon = true
                start()
            }
        }

        fun awaitPlanner(timeoutMs: Long): PinyinPlanner? {
            preload()
            planner?.let { return it }
            ready.await(timeoutMs, TimeUnit.MILLISECONDS)
            return planner
        }
    }

    companion object {
        private const val TARGET_PACKAGE = "com.kursx.smartbook"
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val READER_SPAN_CLASS = "com.kursx.smartbook.reader.span.ReaderSpan"
        private const val LEXICON_ASSET = "assets/zh_pinyin.tsv.gz"
    }
}
