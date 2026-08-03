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
import smartbook.pinyin.BookLanguage
import smartbook.pinyin.ChineseSegmenter
import smartbook.pinyin.MapChineseLexicon
import smartbook.pinyin.PinyinMode
import smartbook.pinyin.PinyinPlanner
import smartbook.pinyin.android.SmartBookPinyinApplier
import java.io.ByteArrayInputStream
import java.lang.reflect.Field
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

class HookEntry : IXposedHookLoadPackage, IXposedHookZygoteInit {
    override fun initZygote(startupParam: IXposedHookZygoteInit.StartupParam) {
        ModuleState.modulePath = startupParam.modulePath
    }

    override fun handleLoadPackage(lpparam: XC_LoadPackage.LoadPackageParam) {
        if (lpparam.packageName != TARGET_PACKAGE) return

        ModuleState.preload()
        val readerTextClass = XposedHelpers.findClass(READER_TEXT_CLASS, lpparam.classLoader)
        val readerSpanClass = XposedHelpers.findClass(READER_SPAN_CLASS, lpparam.classLoader)
        val paragraphHolderClass = XposedHelpers.findClass(PARAGRAPH_HOLDER_CLASS, lpparam.classLoader)

        XposedBridge.hookAllConstructors(
            paragraphHolderClass,
            object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    try {
                        val holder = param.thisObject ?: return
                        val uiState = param.args.firstOrNull {
                            it?.javaClass?.name == READER_UI_STATE_CLASS
                        } ?: return
                        val reader = findFieldValueByType(holder, READER_TEXT_CLASS) ?: return
                        val chapterModel = findFieldValueByType(uiState, CHAPTER_MODEL_CLASS) ?: return
                        val language = readChapterLanguage(chapterModel)
                        ModuleState.registerReader(reader, language)
                    } catch (t: Throwable) {
                        XposedBridge.log("SmartBookPinyin: language hook failed: ${t.stackTraceToString()}")
                    }
                }
            },
        )

        XposedHelpers.findAndHookMethod(
            readerTextClass,
            "setText",
            CharSequence::class.java,
            TextView.BufferType::class.java,
            object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        val reader = param.thisObject ?: return
                        if (!ModuleState.isChineseReader(reader)) return

                        val source = param.args[0] as? Spanned ?: return
                        if (!containsHan(source) || containsKana(source)) return

                        val planner = ModuleState.awaitPlanner(400) ?: return
                        val state = collectSmartBookState(source, readerSpanClass)
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
        XposedBridge.log("SmartBookPinyin: hooked Chinese-only $READER_TEXT_CLASS")
    }

    private fun readChapterLanguage(chapterModel: Any): String? {
        val getter = chapterModel.javaClass.getDeclaredMethod(CHAPTER_LANGUAGE_METHOD)
        getter.isAccessible = true
        return getter.invoke(chapterModel) as? String
    }

    private fun findFieldValueByType(instance: Any, typeName: String): Any? {
        var current: Class<*>? = instance.javaClass
        while (current != null && current != Any::class.java) {
            val field: Field? = current.declaredFields.firstOrNull { it.type.name == typeName }
            if (field != null) {
                field.isAccessible = true
                return field.get(instance)
            }
            current = current.superclass
        }
        return null
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

    private fun containsKana(text: CharSequence): Boolean {
        var index = 0
        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            if (codePoint in 0x3040..0x30FF ||
                codePoint in 0x31F0..0x31FF ||
                codePoint in 0xFF66..0xFF9D
            ) return true
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
        private val chineseReaders = Collections.synchronizedMap(WeakHashMap<Any, Boolean>())

        fun registerReader(reader: Any, language: String?) {
            val chinese = BookLanguage.isChinese(language)
            chineseReaders[reader] = chinese
            XposedBridge.log("SmartBookPinyin: reader language=${language ?: "<unknown>"}; enabled=$chinese")
        }

        fun isChineseReader(reader: Any): Boolean = chineseReaders[reader] == true

        fun preload() {
            if (!started.compareAndSet(false, true)) return
            Thread({
                try {
                    val path = requireNotNull(modulePath) { "module path unavailable" }
                    val lexicon = loadLexicon(path)
                    planner = PinyinPlanner(lexicon)
                    XposedBridge.log("SmartBookPinyin: loaded dictionary; maxWordLength=${lexicon.maxWordLength}")
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

        private fun loadLexicon(path: String): MapChineseLexicon {
            ZipFile(path).use { zip ->
                zip.getEntry(LEXICON_ASSET)?.let { entry ->
                    return zip.getInputStream(entry).use(MapChineseLexicon::fromGzipTsv)
                }

                val embeddedModule = zip.entries().asSequence().firstOrNull {
                    it.name.endsWith("/$MODULE_PACKAGE.apk") || it.name == "$MODULE_PACKAGE.apk"
                } ?: error("pinyin dictionary or embedded module not found")
                val moduleBytes = zip.getInputStream(embeddedModule).use { it.readBytes() }
                ZipInputStream(ByteArrayInputStream(moduleBytes)).use { nested ->
                    while (true) {
                        val entry = nested.nextEntry ?: break
                        if (entry.name == LEXICON_ASSET) {
                            return MapChineseLexicon.fromGzipTsv(nested)
                        }
                    }
                }
            }
            error("pinyin dictionary asset not found")
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
        private const val MODULE_PACKAGE = "com.bulat.smartbookpinyin"
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val READER_SPAN_CLASS = "com.kursx.smartbook.reader.span.ReaderSpan"
        private const val PARAGRAPH_HOLDER_CLASS = "com.kursx.smartbook.reader.holder.ParagraphHolder"
        private const val READER_UI_STATE_CLASS = "com.kursx.smartbook.reader.provider.reader_model.ReaderUIState"
        private const val CHAPTER_MODEL_CLASS = "com.kursx.smartbook.db.book.ChapterModel"
        private const val CHAPTER_LANGUAGE_METHOD = "c"
        private const val LEXICON_ASSET = "assets/zh_pinyin.tsv.gz"
    }
}
