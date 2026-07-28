# Reader AI — Android shell

Native wrapper around the Reader AI web app. This project was reconstructed
from the shipped `ReaderAIv77.31FormattingFootnotesTranslationTest.apk`, whose
sources had never been committed; it reproduces that build's behaviour.

## How it works

There is exactly one native class, `MainActivity`. It creates a `WebView` and
serves the web app from the APK's `assets/www` over
`https://appassets.androidplatform.net/assets/` using
`androidx.webkit.WebViewAssetLoader`. Running on a real https origin (rather
than `file://`) is what gives the page a stable storage partition, so
localStorage and the reader's IndexedDB stores survive across launches.

No Cordova, no Capacitor, no `@JavascriptInterface`. The only bridge runs
native → web, and only for opening books:

1. Another app sends a `VIEW` or `SEND` intent (epub / fb2 / txt / md).
2. `captureExternalIntent` parks the content `Uri` — the file is **not** copied
   anywhere — and records its display name, MIME type and a nanotime token.
3. `shouldInterceptRequest` exposes it at the virtual endpoint
   `https://appassets.androidplatform.net/android-import/current?t=<token>`,
   streaming straight from the `ContentResolver`.
4. Once the page has loaded, `dispatchPendingImport` injects a snippet that
   calls `window.readerImportAndroidFile({name, mime, url})`, retrying every
   100 ms for up to 30 s because the page may still be booting (login, module
   loading).
5. The web side is `js/reader/android-external-import.js`, which fetches that
   URL, wraps the blob in a `File`, and feeds it to the normal import flow.

`WebChromeClient.onShowFileChooser` is wired up as well, so `<input type=file>`
inside the page opens the system document picker.

## Assets

`assets/www` is not checked in. The `syncWebAssets` task stages the repository
root — the same tree Firebase Hosting serves — into the APK at build time, so
the web app has a single source of truth. Server-side code, build tooling and
the dev preview pages are excluded; see the exclude list in `app/build.gradle`.

## Building

Needs the Android SDK (compileSdk 35) with `ANDROID_HOME` set or a
`local.properties` containing `sdk.dir`.

```bash
cd android
./gradlew assembleDebug     # app/build/outputs/apk/debug/
./gradlew assembleRelease   # unsigned unless you configure signing
```

`applicationId` is `space.saintjust.reader.semanticstage1clean.formatfix`,
with the debug build getting a `.debug` suffix so both can be installed side
by side. That matches the package name of the shipped APK.

## Differences from the shipped v77.31 APK

The reconstruction is faithful to the runtime behaviour, with three
deliberate changes:

- **`debuggable` is no longer forced on.** The shipped APK had
  `android:debuggable="true"` in the manifest, which also left
  `setWebContentsDebuggingEnabled(true)` on in every build. It is now tied to
  `BuildConfig.DEBUG`, so release builds are not remote-debuggable.
- **Release builds run R8** (`minifyEnabled` / `shrinkResources`). The shipped
  build had no minification.
- **Dev tooling no longer ships.** The shipped APK bundled `scripts/`,
  `selfhost/` (Dockerfile, nginx config, a Python TTS server), the preview
  pages and a ~430 KB unused root `app.js`.

## Known gaps

- `index.html` loads Firebase and xlsx from gstatic / jsdelivr, so first start
  needs a network. Vendoring them into `assets` would make the app start
  offline.
- Text-to-speech runs through the WebView's Web Speech API, which stops when
  the screen goes off. Reading aloud in the background needs a native
  `MediaSession` plus a foreground service.
- The library lives in IndexedDB, subject to storage-quota eviction. Books
  would be safer as files under the app's private directory.
