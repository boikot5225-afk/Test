package com.bulat.smartbookpinyin

import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.widget.TextView
import android.widget.Toast
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
import smartbook.pinyin.android.PinyinSpan
import smartbook.pinyin.android.SmartBookPinyinApplier
import java.io.ByteArrayInputStream
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

class HookEntry : IXposedHookLoadPackage, IXposedHookZygoteInit {
    override fun initZygote(startupParam: IXposedHookZygoteInit.StartupParam) {
        ModuleState.setModulePath(startupParam.modulePath)
    }

    override fun handleLoadPackage(lpparam: XC_LoadPackage.LoadPackageParam) {
        if (lpparam.packageName != TARGET_PACKAGE) return

        ModuleState.configureHost(
            baseApk = lpparam.appInfo?.sourceDir,
            splitApks = lpparam.appInfo?.splitSourceDirs,
        )
        ModuleState.preload()

        val hook = ReaderTextHook()
        var targetedHookCount = 0

        val readerTextClass = runCatching {
            XposedHelpers.findClass(READER_TEXT_CLASS, lpparam.classLoader)
        }.getOrNull()
        if (readerTextClass != null) {
            targetedHookCount = XposedBridge.hookAllMethods(readerTextClass, "setText", hook).size
        }

        // Fallback for builds where ReaderText does not override setText or its name changes.
        // The hook itself only touches probable reader paragraphs containing Han text.
        val frameworkHookCount = XposedBridge.hookAllMethods(TextView::class.java, "setText", hook).size

        XposedBridge.log(
            "SmartBookPinyin: hooks installed; targeted=$targetedHookCount framework=$frameworkHookCount " +
                "readerClass=${readerTextClass?.name ?: "<not found>"}",
        )
    }

    private inner class ReaderTextHook : XC_MethodHook() {
        override fun beforeHookedMethod(param: MethodHookParam) {
            try {
                val view = param.thisObject as? TextView ?: return
                val textArg = param.args.indexOfFirst { it is CharSequence }
                if (textArg < 0) return

                val source = param.args[textArg] as? CharSequence ?: return
                if (source.isEmpty() || !containsHan(source) || containsKana(source)) return
                if (!isLikelyReaderText(view, source)) return
                if (containsPinyinSpan(source)) return

                val planner = ModuleState.plannerOrNull()
                if (planner == null) {
                    ModuleState.scheduleRetry(view)
                    return
                }

                val state = collectSmartBookState(source)
                val annotations = planner.plan(
                    text = source.toString(),
                    mode = PinyinMode.UNKNOWN_ONLY,
                    isLearnt = state.learntWords::contains,
                    preferredBoundaries = state.preferredBoundaries,
                )
                if (annotations.isEmpty()) return

                val output = SpannableStringBuilder(source)
                SmartBookPinyinApplier.apply(output, annotations)
                param.args[textArg] = output

                val bufferArg = param.args.indexOfFirst { it is TextView.BufferType }
                if (bufferArg >= 0) {
                    param.args[bufferArg] = TextView.BufferType.SPANNABLE
                }
                ModuleState.notifyFirstApplied(view)
            } catch (t: Throwable) {
                XposedBridge.log("SmartBookPinyin: render hook failed: ${t.stackTraceToString()}")
            }
        }
    }

    private fun collectSmartBookState(source: CharSequence): WordState {
        if (source !is Spanned) return WordState(emptySet(), emptySet())

        val learnt = LinkedHashSet<String>()
        val boundaries = LinkedHashSet<Int>()
        val spans = source.getSpans(0, source.length, Any::class.java)

        for (span in spans) {
            if (!isReaderSpan(span)) continue
            val start = source.getSpanStart(span)
            val end = source.getSpanEnd(span)
            if (start < 0 || end <= start || end > source.length) continue

            val word = source.subSequence(start, end).toString()
            if (!containsHan(word) || word.codePointCount(0, word.length) > 24) continue

            boundaries += start
            boundaries += end
            if (readerSpanTypeName(span).equals("Learnt", ignoreCase = true)) {
                learnt += word
            }
        }
        return WordState(learnt, boundaries)
    }

    private fun isReaderSpan(span: Any): Boolean {
        val name = span.javaClass.name
        return name == READER_SPAN_CLASS ||
            name.endsWith(".ReaderSpan") ||
            name.contains("reader.span.ReaderSpan")
    }

    private fun readerSpanTypeName(span: Any): String? {
        var current: Class<*>? = span.javaClass
        while (current != null && current != Any::class.java) {
            for (field in current.declaredFields) {
                val value = readField(field, span) ?: continue
                if (value is Enum<*>) return value.name
            }
            for (method in current.declaredMethods) {
                if (method.parameterTypes.isNotEmpty() || !method.returnType.isEnum) continue
                val value = invokeMethod(method, span) as? Enum<*> ?: continue
                return value.name
            }
            current = current.superclass
        }
        return null
    }

    private fun readField(field: Field, instance: Any): Any? = runCatching {
        field.isAccessible = true
        field.get(instance)
    }.getOrNull()

    private fun invokeMethod(method: Method, instance: Any): Any? = runCatching {
        method.isAccessible = true
        method.invoke(instance)
    }.getOrNull()

    private fun isLikelyReaderText(view: TextView, source: CharSequence): Boolean {
        val className = view.javaClass.name
        if (className == READER_TEXT_CLASS || className.contains("ReaderText")) return true
        if (className.startsWith("com.kursx.smartbook.reader.")) return true
        if (source is Spanned && source.getSpans(0, source.length, Any::class.java).any(::isReaderSpan)) {
            return true
        }

        val resourceName = runCatching {
            if (view.id == android.view.View.NO_ID) null else view.resources.getResourceEntryName(view.id)
        }.getOrNull()?.lowercase()
        if (resourceName != null &&
            (resourceName.contains("reader") || resourceName.contains("paragraph"))
        ) return true

        // Last-resort guard for an ordinary TextView used as a whole book paragraph.
        val hanCount = countHan(source)
        return source.length >= 24 && hanCount >= 8
    }

    private fun containsPinyinSpan(text: CharSequence): Boolean =
        text is Spanned && text.getSpans(0, text.length, PinyinSpan::class.java).isNotEmpty()

    private fun containsHan(text: CharSequence): Boolean = countHan(text) > 0

    private fun countHan(text: CharSequence): Int {
        var count = 0
        var index = 0
        while (index < text.length) {
            val codePoint = Character.codePointAt(text, index)
            if (ChineseSegmenter.isHan(codePoint)) count++
            index += Character.charCount(codePoint)
        }
        return count
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
        @Volatile private var modulePath: String? = null
        @Volatile private var baseApkPath: String? = null
        @Volatile private var splitApkPaths: List<String> = emptyList()
        @Volatile private var planner: PinyinPlanner? = null

        private val started = AtomicBoolean(false)
        private val ready = CountDownLatch(1)
        private val retryStarted = AtomicBoolean(false)
        private val firstApplied = AtomicBoolean(false)
        private val retryViews = Collections.synchronizedSet(
            Collections.newSetFromMap(WeakHashMap<TextView, Boolean>()),
        )
        private val mainHandler = Handler(Looper.getMainLooper())

        fun setModulePath(path: String?) {
            if (!path.isNullOrBlank()) modulePath = path
        }

        fun configureHost(baseApk: String?, splitApks: Array<String>?) {
            if (!baseApk.isNullOrBlank()) baseApkPath = baseApk
            splitApkPaths = splitApks?.filter { it.isNotBlank() }.orEmpty()
        }

        fun preload() {
            if (!started.compareAndSet(false, true)) return
            Thread({
                try {
                    val lexicon = loadLexicon()
                    planner = PinyinPlanner(lexicon)
                    XposedBridge.log(
                        "SmartBookPinyin: dictionary loaded; maxWordLength=${lexicon.maxWordLength}",
                    )
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

        fun plannerOrNull(): PinyinPlanner? {
            preload()
            planner?.let { return it }
            if (ready.await(15, TimeUnit.MILLISECONDS)) return planner
            return null
        }

        fun scheduleRetry(view: TextView) {
            retryViews += view
            if (!retryStarted.compareAndSet(false, true)) return

            Thread({
                ready.await(10, TimeUnit.SECONDS)
                val loaded = planner != null
                mainHandler.post {
                    val views = synchronized(retryViews) { retryViews.toList() }
                    retryViews.clear()
                    retryStarted.set(false)
                    if (!loaded) return@post
                    for (candidate in views) {
                        if (!candidate.isAttachedToWindow) continue
                        val current = candidate.text ?: continue
                        if (!containsHanForRetry(current) || containsPinyinSpanForRetry(current)) continue
                        candidate.setText(current, TextView.BufferType.SPANNABLE)
                    }
                }
            }, "smartbook-pinyin-retry").apply {
                isDaemon = true
                start()
            }
        }

        private fun containsHanForRetry(text: CharSequence): Boolean {
            var index = 0
            while (index < text.length) {
                val codePoint = Character.codePointAt(text, index)
                if (ChineseSegmenter.isHan(codePoint)) return true
                index += Character.charCount(codePoint)
            }
            return false
        }

        private fun containsPinyinSpanForRetry(text: CharSequence): Boolean =
            text is Spanned && text.getSpans(0, text.length, PinyinSpan::class.java).isNotEmpty()

        fun notifyFirstApplied(view: TextView) {
            if (!firstApplied.compareAndSet(false, true)) return
            view.post {
                runCatching {
                    Toast.makeText(view.context, "Пиньинь для незнакомых слов включён", Toast.LENGTH_SHORT)
                        .show()
                }
            }
            XposedBridge.log("SmartBookPinyin: first annotations applied")
        }

        private fun loadLexicon(): MapChineseLexicon {
            val candidates = LinkedHashSet<String>()
            modulePath?.let(candidates::add)
            baseApkPath?.let(candidates::add)
            candidates.addAll(splitApkPaths)

            val failures = ArrayList<String>()
            for (path in candidates) {
                try {
                    loadLexiconFrom(path)?.let { return it }
                    failures += "$path: lexicon not found"
                } catch (t: Throwable) {
                    failures += "$path: ${t.javaClass.simpleName}: ${t.message}"
                }
            }
            error("pinyin dictionary unavailable; candidates=${candidates.size}; ${failures.joinToString(" | ")}")
        }

        private fun loadLexiconFrom(path: String): MapChineseLexicon? {
            ZipFile(path).use { zip ->
                zip.getEntry(LEXICON_ASSET)?.let { entry ->
                    return zip.getInputStream(entry).use(MapChineseLexicon::fromGzipTsv)
                }

                val embeddedModule = zip.entries().asSequence().firstOrNull {
                    it.name == "assets/npatch/modules/$MODULE_PACKAGE.apk" ||
                        it.name.endsWith("/$MODULE_PACKAGE.apk") ||
                        it.name == "$MODULE_PACKAGE.apk"
                } ?: return null

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
            return null
        }
    }

    companion object {
        private const val TARGET_PACKAGE = "com.kursx.smartbook"
        private const val MODULE_PACKAGE = "com.bulat.smartbookpinyin"
        private const val READER_TEXT_CLASS = "com.kursx.smartbook.shared.ReaderText"
        private const val READER_SPAN_CLASS = "com.kursx.smartbook.reader.span.ReaderSpan"
        private const val LEXICON_ASSET = "assets/zh_pinyin.tsv.gz"
    }
}
