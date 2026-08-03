plugins {
    id("com.android.application") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "com.bulat.smartbookoverlay"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bulat.smartbookoverlay"
        minSdk = 28
        targetSdk = 35
        versionCode = 4
        versionName = "0.4.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            java.srcDirs(
                "src/main/kotlin",
                "../../smartbook-chinese-pinyin/src/main/kotlin",
                "../../smartbook-chinese-pinyin/src/android/kotlin",
            )
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}
