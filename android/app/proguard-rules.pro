# Reader AI normally calls native code only from Java. toc62 adds one narrow
# JavascriptInterface for the optional Instant Translate compatibility bridge.
# Keep only annotated bridge methods so release/R8 builds cannot rename them.
-keepclassmembers class space.saintjust.reader.stage1.InstantTranslateBridge {
    @android.webkit.JavascriptInterface <methods>;
}
