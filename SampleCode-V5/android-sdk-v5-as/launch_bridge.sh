#!/bin/bash

# DJI Android Bridge Launcher Script - Phase 1
# Deploys and launches the DJI Bridge Activity for WebSocket streaming

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
SAMPLE_DIR="$SCRIPT_DIR/../android-sdk-v5-sample"
APP_PACKAGE="dji.sampleV5.aircraft"
BRIDGE_ACTIVITY="dji.sampleV5.aircraft.DJIBridgeActivity"
WEBSOCKET_PORT=8080

echo "🚁 DJI Android Bridge Launcher - Phase 1"
echo "========================================="

# Function to check if ADB is available
check_adb() {
    if ! command -v adb &> /dev/null; then
        echo "❌ ADB not found. Please install Android SDK Platform Tools"
        echo "   For macOS: brew install android-platform-tools"
        exit 1
    fi
}

# Function to check connected devices
check_devices() {
    echo "📱 Checking connected DJI devices..."
    
    DEVICES=$(adb devices | grep -v "List of devices attached" | grep "device$" | wc -l)
    
    if [ "$DEVICES" -eq 0 ]; then
        echo "❌ No DJI devices connected via ADB"
        echo "   Please connect your DJI controller and enable USB Debugging"
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

# Function to build and install the app
build_and_install() {
    echo "🔨 Building and installing DJI Android Bridge..."
    
    cd "$SAMPLE_DIR"
    
    # Build the project
    echo "   Building APK..."
    cd "$SCRIPT_DIR"
    ./gradlew :sample:assembleDebug > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        echo "❌ Build failed. Please check the build logs."
        exit 1
    fi
    
    # Install APK
    APK_PATH="../android-sdk-v5-sample/build/outputs/apk/debug/sample-debug.apk"
    
    if [ ! -f "$APK_PATH" ]; then
        echo "❌ APK not found at: $APK_PATH"
        exit 1
    fi
    
    echo "   Installing APK on device..."
    adb install -r "$APK_PATH" > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        echo "❌ Installation failed"
        exit 1
    fi
    
    echo "✅ App installed successfully"
}

# Function to launch the bridge activity
launch_bridge() {
    echo "🌉 Launching DJI Android Bridge..."
    
    # Launch the bridge activity
    adb shell am start -n "$APP_PACKAGE/$BRIDGE_ACTIVITY"
    
    if [ $? -ne 0 ]; then
        echo "❌ Failed to launch bridge activity"
        exit 1
    fi
    
    echo "✅ Bridge activity launched successfully"
    
    # Wait a moment for the activity to start
    sleep 2
    
    # Get device IP address
    DEVICE_IP=$(adb shell ip route get 8.8.8.8 2>/dev/null | head -1 | awk '{print $7}' 2>/dev/null || echo "unknown")
    
    echo ""
    echo "🎯 Bridge Information:"
    echo "   WebSocket Server: ws://$DEVICE_IP:$WEBSOCKET_PORT"
    echo "   Protocol: WebSocket with JSON messages"
    echo "   Data: Real-time joystick readings from DJI controller"
    echo ""
    echo "📡 Test connection from your laptop:"
    echo "   wscat -c ws://$DEVICE_IP:$WEBSOCKET_PORT"
    echo "   or use any WebSocket client to connect"
}

# Function to monitor bridge logs
monitor_logs() {
    echo "📊 Monitoring bridge logs (Ctrl+C to stop):"
    echo "----------------------------------------"
    
    # Filter logs for bridge-related messages
    adb logcat | grep -E "(DJIBridge|DJIBridgeServer|JOYSTICK_INPUT|RC_STICK_MONITOR|VIRTUAL_STICK|WebSocket)"
}

# Function to stop the bridge
stop_bridge() {
    echo "🛑 Stopping DJI Android Bridge..."
    
    # Kill the bridge activity
    adb shell am force-stop "$APP_PACKAGE"
    
    echo "✅ Bridge stopped"
}

# Main execution
main() {
    case "${1:-start}" in
        "start")
            check_adb
            check_devices
            build_and_install
            launch_bridge
            echo ""
            echo "🚀 DJI Android Bridge Phase 1 is now running!"
            echo "   Move the joysticks on your DJI controller to test"
            echo "   Connect from laptop: wscat -c ws://$DEVICE_IP:$WEBSOCKET_PORT"
            echo ""
            echo "📝 To monitor logs: $0 logs"
            echo "📝 To stop bridge: $0 stop"
            ;;
        "logs")
            check_adb
            check_devices
            monitor_logs
            ;;
        "stop")
            check_adb
            check_devices
            stop_bridge
            ;;
        "help"|"-h"|"--help")
            echo "Usage: $0 [start|logs|stop|help]"
            echo ""
            echo "Commands:"
            echo "  start  - Build, install and launch DJI Bridge (default)"
            echo "  logs   - Monitor bridge activity logs"
            echo "  stop   - Stop the bridge server"
            echo "  help   - Show this help message"
            echo ""
            echo "Phase 1 Features:"
            echo "  • WebSocket server on port 8080"
            echo "  • Real-time joystick data streaming" 
            echo "  • JSON protocol for controller data"
            echo "  • Compatible with any WebSocket client"
            ;;
        *)
            echo "❌ Unknown command: $1"
            echo "   Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

main "$@"