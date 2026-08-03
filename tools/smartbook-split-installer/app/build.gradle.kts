plugins {
    id("com.android.application")
}

android {
    namespace = "com.bulat.smartbookinstaller"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bulat.smartbookinstaller"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}
