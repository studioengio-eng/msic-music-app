# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Keep Tauri and Rust JNI Bridges
-keep class app.tauri.** { *; }
-keep class com.tauri.** { *; }
-keep class org.tauri.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Tauri annotations
-keep @interface tauri.** { *; }
-keep @interface app.tauri.** { *; }

# Keep NewPipe Extractor classes (reflection-heavy extractor)
-keep class org.schabi.newpipe.extractor.** { *; }
-keep interface org.schabi.newpipe.extractor.** { *; }
-keepattributes Signature, *Annotation*, InnerClasses, EnclosingMethod

# Keep RxJava
-keep class io.reactivex.rxjava3.** { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# Keep OkHttp
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**

# Keep Media3 / ExoPlayer
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**

# Keep Google Cast SDK
-keep class com.google.android.gms.cast.** { *; }
-dontwarn com.google.android.gms.cast.**

# Keep Kotlin Coroutines
-keep class kotlinx.coroutines.** { *; }

# Preserve line number information for debugging stack traces
-keepattributes SourceFile,LineNumberTable

# Ignore missing classes that are not present in Android SDK (referenced from third-party dependencies like jsoup and rhino)
-dontwarn com.google.re2j.**
-dontwarn java.beans.**
-dontwarn javax.script.**

# Keep MSIC player package classes, plugins, activities, services, and reflection command arguments
-keep class com.msic.player.** { *; }
-keepclassmembers class com.msic.player.** { *; }

# Keep MSIC API package (Last.fm repository and API)
-keep class com.msic.api.** { *; }
-keepclassmembers class com.msic.api.** { *; }