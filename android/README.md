# Huddle Meet — Android App

Native Android wrapper for [Huddle Meet](https://huddle-meet-app.hf.space) with full WebRTC support.

## Features
- WebView with camera, microphone, and screen share permissions
- Foreground service keeps calls alive in background
- Deep linking for `huddle-meet-app.hf.space` URLs
- Edge-to-edge dark UI matching the web app
- Adaptive launcher icon (purple + video camera)
- Network security config (HTTPS prod, cleartext localhost dev)

## Build

### Prerequisites
- Android Studio Hedgehog (2023.1+) or newer
- JDK 11+
- Android SDK 34

### Steps
1. Open `android/` folder in Android Studio
2. Let Gradle sync
3. Connect device or start emulator
4. Run ▶️

### Build APK
```bash
cd android
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
```

## Local Development
The app points to `https://huddle-meet-app.hf.space` by default.  
To test against localhost, change `APP_URL` in `MainActivity.java`:
```java
private static final String APP_URL = "http://10.0.2.2:8080"; // Android emulator → host
```

## Structure
```
android/
├── app/
│   ├── build.gradle
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/huddlemeet/app/
│       │   ├── MainActivity.java
│       │   └── CallForegroundService.java
│       └── res/
│           ├── layout/activity_main.xml
│           ├── drawable/
│           ├── mipmap-anydpi-v26/
│           ├── values/
│           └── xml/
├── build.gradle
├── settings.gradle
├── gradle.properties
└── gradle/wrapper/
```
