# Vehicle Telemetry Mobile App - Windows Build Instructions

## Prerequisites

### 1. Flutter Installation
Flutter is already installed in your system at `C:\VehicleSense`. Ensure it's added to your PATH environment variable.

Verify installation:
```bash
flutter --version
flutter doctor
```

### 2. Android Studio (for Android builds)
- Download from: https://developer.android.com/studio
- Install Android SDK
- Accept Android licenses: `flutter doctor --android-licenses`

### 3. Visual Studio 2022 (for Windows builds)
- Download from: https://visualstudio.microsoft.com/
- Install "Desktop development with C++" workload

## Quick Start Build

### Option 1: Using the Build Script (Recommended)

1. Copy the entire `mobile_app` folder to `C:\VehicleSense\mobile_app`

2. Create `.env` file in `C:\VehicleSense\mobile_app\.env`:
```env
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

3. Run the build script:
```bash
cd C:\VehicleSense\mobile_app
build.bat
```

4. Follow the on-screen prompts to select your build type

### Option 2: Manual Build

1. Navigate to the mobile app directory:
```bash
cd C:\VehicleSense\mobile_app
```

2. Install dependencies:
```bash
flutter pub get
```

3. Build for your target platform:

**Android Debug APK** (for testing):
```bash
flutter build apk --debug
```

**Android Release APK** (for distribution):
```bash
flutter build apk --release
```

**Android App Bundle** (for Google Play Store):
```bash
flutter build appbundle --release
```

**Windows Desktop App**:
```bash
flutter build windows --release
```

## Build Output Locations

After successful build, find your app at:

| Build Type | Location |
|------------|----------|
| Android Debug APK | `build\app\outputs\flutter-apk\app-debug.apk` |
| Android Release APK | `build\app\outputs\flutter-apk\app-release.apk` |
| Android App Bundle | `build\app\outputs\bundle\release\app-release.aab` |
| Windows Desktop | `build\windows\runner\Release\` |

## Installing the APK on Android Device

### Via USB Cable:
```bash
flutter install
```

### Manual Installation:
1. Transfer the APK file to your Android device
2. Enable "Install from Unknown Sources" in device settings
3. Open the APK file and install

## Troubleshooting

### Issue: "Flutter not recognized"
**Solution:** Add Flutter to PATH:
1. Open System Environment Variables
2. Add `C:\VehicleSense\flutter\bin` to PATH
3. Restart Command Prompt

### Issue: "Gradle build failed"
**Solution:**
```bash
cd android
gradlew clean
cd ..
flutter clean
flutter pub get
flutter build apk
```

### Issue: "Android licenses not accepted"
**Solution:**
```bash
flutter doctor --android-licenses
```
Press 'y' to accept all licenses

### Issue: "Unable to locate Android SDK"
**Solution:**
1. Open Android Studio
2. Go to Tools > SDK Manager
3. Note the SDK Location path
4. Set environment variable:
```bash
setx ANDROID_HOME "C:\Users\YourUsername\AppData\Local\Android\Sdk"
```

### Issue: ".env file not found"
**Solution:** Create `.env` file in `mobile_app` directory with your Supabase credentials

## Testing Before Building

Run the app in debug mode first to ensure everything works:

```bash
# Connect Android device or start emulator
flutter devices

# Run the app
flutter run
```

## App Signing (for Production Release)

To publish on Google Play Store, you need to sign your app:

1. Create a keystore:
```bash
keytool -genkey -v -keystore C:\VehicleSense\mobile_app\android\app\upload-keystore.jks -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

2. Create `android/key.properties`:
```properties
storePassword=your_store_password
keyPassword=your_key_password
keyAlias=upload
storeFile=upload-keystore.jks
```

3. Build signed release:
```bash
flutter build appbundle --release
```

## Performance Optimization

For smaller APK size, build split APKs per ABI:
```bash
flutter build apk --split-per-abi
```

This creates separate APKs for:
- `app-armeabi-v7a-release.apk` (32-bit ARM)
- `app-arm64-v8a-release.apk` (64-bit ARM)
- `app-x86_64-release.apk` (64-bit Intel)

## Next Steps

1. Test the debug build on a physical device
2. Verify all features work correctly
3. Build release version
4. Test release build
5. Distribute to users or publish to store

## Support

If you encounter issues:
1. Run `flutter doctor -v` and check for problems
2. Review error messages carefully
3. Check that .env file is properly configured
4. Ensure Supabase credentials are correct

## Useful Commands

```bash
# Check Flutter setup
flutter doctor

# Update Flutter
flutter upgrade

# Clean build files
flutter clean

# Get dependencies
flutter pub get

# Run on connected device
flutter run

# Run in release mode
flutter run --release

# List connected devices
flutter devices

# Analyze code
flutter analyze

# Run tests
flutter test
```
