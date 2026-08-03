plugins {
    id("com.android.application") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "com.bulat.smartbookpinyin"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bulat.smartbookpinyin"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets {
        getByName("main") {
            java.srcDirs(
                "src/main/kotlin",
                "../src/main/kotlin",
                "../src/android/kotlin",
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

dependencies {
    compileOnly("de.robv.android.xposed:api:82")
}
