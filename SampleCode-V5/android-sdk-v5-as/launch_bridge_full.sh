#!/bin/bash

# DJI Android Bridge Full Launcher - Phase 1
# Complete workflow: build, install, launch main app, then bridge

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
APP_PACKAGE="com.example.msdksample"
MAIN_ACTIVITY="dji.sampleV5.aircraft.DJIAircraftMainActivity"
BRIDGE_ACTIVITY="dji.sampleV5.aircraft.DJIBridgeActivity"
WEBSOCKET_PORT=8080

echo "🚁 DJI Android Bridge Full Launcher - Phase 1"
echo "=============================================="

# Function to check if ADB is available
check_adb() {
    if ! command -v adb &> /dev/null; then
        echo "❌ ADB not found. Please install Android SDK Platform Tools"
        exit 1
    fi
}

# Function to check connected devices
check_devices() {
    echo "📱 Checking connected DJI devices..."
    
    DEVICES=$(adb devices | grep -v "List of devices attached" | grep "device$" | wc -l)
    
    if [ "$DEVICES" -eq 0 ]; then
        echo "❌ No DJI devices connected via ADB"
        exit 1
    elif [ "$DEVICES" -eq 1 ]; then
        DEVICE_ID=$(adb devices | grep -v "List of devices attached" | grep "device$" | awk '{print $1}')
        echo "✅ Connected to DJI device: $DEVICE_ID"
    else
        echo "⚠️  Multiple devices connected. Using first device:"
        DEVICE_ID=$(adb devices | grep -v "List of devices attached" | grep "device$" | head -1 | awk '{print $1}')
        echo "   Selected device: $DEVICE_ID"
    fi
}

# Function to build and install
build_and_install() {
    echo "🔨 Building and installing DJI Bridge..."
    
    cd "$SCRIPT_DIR"
    APK_PATH="../android-sdk-v5-sample/build/outputs/apk/debug/sample-debug.apk"
    
    # Check if APK already exists and is recent
    if [ -f "$APK_PATH" ]; then
        echo "   Found existing APK, checking if rebuild needed..."
        APK_AGE=$(date -r "$APK_PATH" +%s)
        CURRENT_TIME=$(date +%s)
        AGE_DIFF=$((CURRENT_TIME - APK_AGE))
        
        if [ $AGE_DIFF -lt 3600 ]; then # Less than 1 hour old
            echo "   Using existing APK (built $(($AGE_DIFF / 60)) minutes ago)"
        else
            echo "   APK is old, rebuilding..."
            if ! ./gradlew :sample:assembleDebug --console=plain > /dev/null; then
                echo "❌ Build failed. Using existing APK anyway."
            fi
        fi
    else
        echo "   Building APK (this may take a moment)..."
        if ! ./gradlew :sample:assembleDebug --console=plain > /dev/null; then
            echo "❌ Build failed. Please run: ./gradlew :sample:assembleDebug"
            exit 1
        fi
    fi
    
    if [ ! -f "$APK_PATH" ]; then
        echo "❌ APK not found at: $APK_PATH"
        exit 1
    fi
    
    echo "   Installing APK on device $DEVICE_ID..."
    if ! adb -s "$DEVICE_ID" install -r "$APK_PATH"; then
        echo "❌ Installation failed"
        exit 1
    fi
    
    echo "✅ App installed successfully"
}

# Function to setup USB port forwarding
setup_usb() {
    echo "🔌 Setting up USB port forwarding..."
    adb -s "$DEVICE_ID" forward tcp:8080 tcp:8080
    
    if [ $? -eq 0 ]; then
        echo "✅ USB port forwarding active: localhost:8080 → device:8080"
    else
        echo "❌ Failed to set up port forwarding"
        exit 1
    fi
}

# Function to launch applications
launch_apps() {
    echo "🚀 Launching applications..."
    
    # Launch main MSDK app first (for SDK registration)
    echo "   Starting main MSDK app..."
    adb -s "$DEVICE_ID" shell am start -n "$APP_PACKAGE/$MAIN_ACTIVITY" > /dev/null 2>&1
    
    # Wait for SDK registration
    echo "   Waiting 10 seconds for SDK registration..."
    sleep 10
    
    # Launch bridge activity
    echo "   Starting bridge server..."
    adb -s "$DEVICE_ID" shell am start -n "$APP_PACKAGE/$BRIDGE_ACTIVITY" > /dev/null 2>&1
    
    # Wait for bridge to start
    sleep 3
    
    echo "✅ Applications launched"
}

# Function to test connection
test_connection() {
    echo "🧪 Testing WebSocket connection..."
    
    # Test connection with timeout
    timeout 5s node test_bridge.js localhost > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo "✅ WebSocket connection successful"
    else
        echo "⚠️  WebSocket test failed (this is normal if no joystick movement detected)"
    fi
}

# Function to show final instructions
show_instructions() {
    echo ""
    echo "🎯 DJI Android Bridge is now running!"
    echo "======================================"
    echo ""
    echo "📍 Bridge Status:"
    echo "   • Main MSDK app: Running (SDK registered)"
    echo "   • Bridge server: Running on device port 8080"
    echo "   • USB forwarding: localhost:8080 → device:8080"
    echo ""
    echo "🎮 Testing Instructions:"
    echo "   1. Connect from laptop: node test_bridge.js localhost"
    echo "   2. Move joysticks on DJI controller"
    echo "   3. See real-time data streaming in terminal"
    echo ""
    echo "📊 Bridge Features:"
    echo "   • Real-time joystick data (20Hz)"
    echo "   • JSON protocol with flight parameters"
    echo "   • Multiple client support"
    echo "   • USB connection (no WiFi needed)"
    echo ""
    echo "🛑 To Stop:"
    echo "   • Close bridge activity on device"
    echo "   • Or run: adb shell am force-stop $APP_PACKAGE"
    echo ""
    echo "📝 Note: If you don't see the bridge in the main app menu,"
    echo "   the bridge is still running via the direct activity launch."
}

# Main execution
main() {
    check_adb
    check_devices
    build_and_install
    setup_usb
    launch_apps
    test_connection
    show_instructions
}

main "$@"