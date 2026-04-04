@echo off
REM Vehicle Telemetry Mobile App Setup Script for Windows
REM This script prepares the development environment

echo ========================================
echo Vehicle Telemetry App - Setup Wizard
echo ========================================
echo.

REM Check if Flutter is installed
flutter --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Flutter is not installed or not in PATH
    echo.
    echo Flutter should be installed at: C:\VehicleSense
    echo Please add C:\VehicleSense\flutter\bin to your PATH
    echo.
    pause
    exit /b 1
)

echo [1/5] Flutter detected successfully
flutter --version
echo.

echo [2/5] Running Flutter Doctor...
flutter doctor
echo.

echo [3/5] Checking for .env file...
if exist ".env" (
    echo .env file found!
    echo.
) else (
    echo .env file not found. Creating from template...
    echo.
    (
        echo SUPABASE_URL=https://your-project.supabase.co
        echo SUPABASE_ANON_KEY=your-anon-key-here
    ) > .env
    echo .env file created! Please edit it with your Supabase credentials.
    echo.
    echo Open .env file in a text editor and update:
    echo 1. SUPABASE_URL - Your Supabase project URL
    echo 2. SUPABASE_ANON_KEY - Your Supabase anonymous key
    echo.
    echo You can find these in your Supabase project dashboard at:
    echo https://supabase.com/dashboard/project/YOUR_PROJECT/settings/api
    echo.
    pause
)

echo [4/5] Installing Flutter dependencies...
flutter pub get
echo.

echo [5/5] Setup complete!
echo.
echo ========================================
echo Next Steps:
echo ========================================
echo 1. Edit .env file with your Supabase credentials
echo 2. Connect your Android device or start an emulator
echo 3. Run: flutter run (to test in debug mode)
echo 4. Run: build.bat (to create release builds)
echo.
echo For detailed instructions, see BUILD_INSTRUCTIONS_WINDOWS.md
echo.
pause
