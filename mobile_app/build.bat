@echo off
REM Vehicle Telemetry Mobile App Build Script for Windows
REM This script automates the build process for the Flutter mobile app

echo ========================================
echo Vehicle Telemetry Mobile App Builder
echo ========================================
echo.

REM Check if Flutter is installed
flutter --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Flutter is not installed or not in PATH
    echo Please install Flutter from https://flutter.dev/docs/get-started/install/windows
    pause
    exit /b 1
)

echo [1/6] Checking Flutter installation...
flutter --version
echo.

REM Check if .env file exists
if not exist ".env" (
    echo ERROR: .env file not found!
    echo Please create a .env file with your Supabase credentials.
    echo.
    echo Required format:
    echo SUPABASE_URL=https://your-project.supabase.co
    echo SUPABASE_ANON_KEY=your-anon-key-here
    echo.
    pause
    exit /b 1
)

echo [2/6] Environment configuration found
echo.

echo [3/6] Cleaning previous builds...
flutter clean
echo.

echo [4/6] Installing dependencies...
flutter pub get
echo.

echo [5/6] Running build...
echo.
echo Select build type:
echo 1. Android APK (Debug)
echo 2. Android APK (Release)
echo 3. Android App Bundle (Release)
echo 4. Windows Desktop App
echo 5. All Android Builds
echo.
set /p choice="Enter your choice (1-5): "

if "%choice%"=="1" (
    echo Building Android APK (Debug)...
    flutter build apk --debug
    echo.
    echo Build complete! APK location:
    echo build\app\outputs\flutter-apk\app-debug.apk
)

if "%choice%"=="2" (
    echo Building Android APK (Release)...
    flutter build apk --release
    echo.
    echo Build complete! APK location:
    echo build\app\outputs\flutter-apk\app-release.apk
)

if "%choice%"=="3" (
    echo Building Android App Bundle (Release)...
    flutter build appbundle --release
    echo.
    echo Build complete! Bundle location:
    echo build\app\outputs\bundle\release\app-release.aab
)

if "%choice%"=="4" (
    echo Building Windows Desktop App...
    flutter build windows --release
    echo.
    echo Build complete! App location:
    echo build\windows\runner\Release\
)

if "%choice%"=="5" (
    echo Building all Android variants...
    echo.
    echo Building Debug APK...
    flutter build apk --debug
    echo.
    echo Building Release APK...
    flutter build apk --release
    echo.
    echo Building Release App Bundle...
    flutter build appbundle --release
    echo.
    echo All builds complete!
    echo.
    echo Debug APK: build\app\outputs\flutter-apk\app-debug.apk
    echo Release APK: build\app\outputs\flutter-apk\app-release.apk
    echo Release Bundle: build\app\outputs\bundle\release\app-release.aab
)

echo.
echo ========================================
echo [6/6] Build process completed!
echo ========================================
echo.
pause
