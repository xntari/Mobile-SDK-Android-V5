#!/usr/bin/env bash
set -euo pipefail

# DJI Mobile SDK V5 - Deploy Script
# Deploys pre-built APK to connected devices/controllers

# Configuration
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_MODULE="sample"
LOG_FILE="${PROJECT_DIR}/deploy.log"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

# Check prerequisites
check_prerequisites() {
    log "Checking deployment prerequisites..."
    
    # Check ADB
    if command -v adb &> /dev/null; then
        log "ADB available: $(which adb)"
    else
        error "ADB not found. Please ensure Android SDK platform-tools are in PATH."
        exit 1
    fi
    
    log "Prerequisites check completed successfully."
}

# Find built APK
find_apk() {
    local BUILD_TYPE="${1:-debug}"
    local APK_PATH=""
    
    # Try different possible locations
    local SEARCH_PATHS=(
        "${SAMPLE_MODULE}/build/outputs/apk/${BUILD_TYPE}/*.apk"
        "${SAMPLE_MODULE}/build/outputs/apk/*/${BUILD_TYPE}/*.apk"
        "build/outputs/apk/${BUILD_TYPE}/*.apk"
        "app/build/outputs/apk/${BUILD_TYPE}/*.apk"
        "../android-sdk-v5-sample/build/outputs/apk/${BUILD_TYPE}/*.apk"
        "../android-sdk-v5-sample/build/outputs/apk/*/${BUILD_TYPE}/*.apk"
    )
    
    for PATTERN in "${SEARCH_PATHS[@]}"; do
        if ls $PATTERN 1> /dev/null 2>&1; then
            APK_PATH=$(ls -t $PATTERN | head -n1)
            break
        fi
    done
    
    if [[ -z "$APK_PATH" ]]; then
        error "Could not find built APK for build type: $BUILD_TYPE"
        error "Please run './build.sh $BUILD_TYPE' first to build the APK."
        exit 1
    fi
    
    echo "$APK_PATH"
}

# Get connected devices
get_connected_devices() {
    adb devices | grep -v "List of devices" | grep -E "device|unauthorized" | awk '{print $1}' | grep -v '^$'
}

# Check if device is a DJI controller
is_dji_controller() {
    local DEVICE_ID="$1"
    local DEVICE_INFO
    
    # Get device properties
    DEVICE_INFO=$(adb -s "$DEVICE_ID" shell getprop ro.product.model 2>/dev/null || echo "")
    
    # Check for DJI controller models
    if echo "$DEVICE_INFO" | grep -iq "dji\|controller\|smart.*controller\|rc.*pro"; then
        return 0
    fi
    
    # Also check manufacturer
    local MANUFACTURER
    MANUFACTURER=$(adb -s "$DEVICE_ID" shell getprop ro.product.manufacturer 2>/dev/null || echo "")
    if echo "$MANUFACTURER" | grep -iq "dji"; then
        return 0
    fi
    
    return 1
}

# Interactive device selection
select_device() {
    local DEVICES
    IFS=$'\n' read -d '' -r -a DEVICES <<< "$(get_connected_devices)" || true
    
    if [[ ${#DEVICES[@]} -eq 0 ]]; then
        error "No devices connected. Please connect a device and try again."
        exit 1
    elif [[ ${#DEVICES[@]} -eq 1 ]]; then
        echo "${DEVICES[0]}"
        return
    fi
    
    log "Multiple devices detected:"
    for i in "${!DEVICES[@]}"; do
        local DEVICE_ID="${DEVICES[$i]}"
        local MODEL=$(adb -s "$DEVICE_ID" shell getprop ro.product.model 2>/dev/null || echo "Unknown")
        local MANUFACTURER=$(adb -s "$DEVICE_ID" shell getprop ro.product.manufacturer 2>/dev/null || echo "Unknown")
        
        if is_dji_controller "$DEVICE_ID"; then
            echo "  $((i+1)). ${DEVICE_ID} - ${MANUFACTURER} ${MODEL} ${GREEN}[DJI Controller]${NC}"
        else
            echo "  $((i+1)). ${DEVICE_ID} - ${MANUFACTURER} ${MODEL}"
        fi
    done
    
    while true; do
        read -p "Select device (1-${#DEVICES[@]}): " CHOICE
        if [[ "$CHOICE" =~ ^[0-9]+$ ]] && [[ $CHOICE -ge 1 ]] && [[ $CHOICE -le ${#DEVICES[@]} ]]; then
            echo "${DEVICES[$((CHOICE-1))]}"
            break
        else
            warn "Invalid selection. Please choose a number between 1 and ${#DEVICES[@]}."
        fi
    done
}

# Deploy to device
deploy_to_device() {
    local APK_PATH="$1"
    local DEVICE_ID="${2:-}"
    
    if [[ -z "$DEVICE_ID" ]]; then
        log "Deploying to default device..."
        adb install -r -d "$APK_PATH"
    else
        log "Deploying to device: $DEVICE_ID..."
        adb -s "$DEVICE_ID" install -r -d "$APK_PATH"
    fi
    
    if [[ $? -eq 0 ]]; then
        log "APK installed successfully."
    else
        error "APK installation failed."
        return 1
    fi
}

# Launch application
launch_app() {
    local DEVICE_ID="${1:-}"
    local PACKAGE_NAME="com.example.msdksample"
    local ACTIVITY_NAME="dji.sampleV5.aircraft.DJIAircraftMainActivity"
    
    log "Launching application..."
    
    if [[ -z "$DEVICE_ID" ]]; then
        adb shell am start -n "${PACKAGE_NAME}/${ACTIVITY_NAME}"
    else
        adb -s "$DEVICE_ID" shell am start -n "${PACKAGE_NAME}/${ACTIVITY_NAME}"
    fi
    
    if [[ $? -eq 0 ]]; then
        log "Application launched successfully."
    else
        warn "Application launch may have failed. Check device manually."
    fi
}

# Hardware probe and logging
start_hardware_probe() {
    local DEVICE_ID="${1:-}"
    
    log "Starting hardware probe logging..."
    
    if [[ -z "$DEVICE_ID" ]]; then
        adb logcat -s "HardwareProbe" &
        LOGCAT_PID=$!
    else
        adb -s "$DEVICE_ID" logcat -s "HardwareProbe" &
        LOGCAT_PID=$!
    fi
    
    info "Hardware probe logging started (PID: $LOGCAT_PID)"
    info "Press Ctrl+C to stop logging and exit."
    
    # Wait for user interrupt
    trap "kill $LOGCAT_PID 2>/dev/null; exit 0" INT
    wait $LOGCAT_PID
}

# Enhanced joystick and virtual stick logging
start_joystick_logging() {
    local DEVICE_ID="${1:-}"
    
    log "Starting enhanced joystick and virtual stick logging..."
    info "Monitoring tags: SDK_REGISTRATION, JOYSTICK_INIT, RC_STICK_MONITOR, VirtualStick"
    
    local LOGCAT_CMD="adb"
    if [[ -n "$DEVICE_ID" ]]; then
        LOGCAT_CMD="adb -s $DEVICE_ID"
    fi
    
    # Create comprehensive logging filter for all joystick-related tags
    $LOGCAT_CMD logcat \
        "SDK_REGISTRATION:I" \
        "JOYSTICK_INIT:I" \
        "VirtualStick:D" \
        "JOYSTICK_INPUT:D" \
        "JOYSTICK_DIRECTION:D" \
        "VIRTUAL_STICK_CMD:D" \
        "VIRTUAL_STICK_PARAMS:D" \
        "VIRTUAL_STICK_POSITION:D" \
        "FLIGHT_MAPPING:D" \
        "FLIGHT_COMMAND:I" \
        "FLIGHT_SAFETY:W" \
        "RC_STICK_MONITOR:D" \
        "RC_STICK_DIRECTION:D" \
        "GlobalJoystickMonitor:D" \
        "GlobalJoystickMonitor:I" \
        "DJIAircraftApplication:I" \
        "HardwareProbe:D" \
        "*:S" &
    
    LOGCAT_PID=$!
    
    info "Enhanced joystick logging started (PID: $LOGCAT_PID)"
    info "Log Categories:"
    info "  • VirtualStick - Original DJI virtual stick format (P/R/Y/T)"
    info "  • RC_STICK_MONITOR - Remote controller stick input monitoring"
    info "  • FLIGHT_MAPPING - Flight parameter mapping and interpretation"
    info "  • FLIGHT_COMMAND - Human-readable flight commands"
    info "  • FLIGHT_SAFETY - Safety warnings for aggressive movements"
    info "  • GlobalJoystickMonitor - Global joystick monitoring status"
    info ""
    info "🎮 JOYSTICK MONITORING: Move your DJI controller sticks to see real-time logging!"
    info "   No need to navigate to VirtualStick page - monitoring is global."
    info "Press Ctrl+C to stop logging and exit."
    
    # Wait for user interrupt
    trap "kill $LOGCAT_PID 2>/dev/null; exit 0" INT
    wait $LOGCAT_PID
}

# Virtual stick specific logging
start_virtual_stick_logging() {
    local DEVICE_ID="${1:-}"
    
    log "Starting virtual stick specific logging..."
    info "Focus: Virtual stick commands, parameters, and flight control"
    
    local LOGCAT_CMD="adb"
    if [[ -n "$DEVICE_ID" ]]; then
        LOGCAT_CMD="adb -s $DEVICE_ID"
    fi
    
    $LOGCAT_CMD logcat \
        "VirtualStick:D" \
        "VIRTUAL_STICK_CMD:D" \
        "VIRTUAL_STICK_PARAMS:D" \
        "VIRTUAL_STICK_POSITION:D" \
        "FLIGHT_MAPPING:D" \
        "FLIGHT_COMMAND:I" \
        "FLIGHT_SAFETY:W" \
        "RC_STICK_MONITOR:D" \
        "GlobalJoystickMonitor:D" \
        "GlobalJoystickMonitor:I" \
        "*:S" &
    
    LOGCAT_PID=$!
    
    info "Virtual stick logging started (PID: $LOGCAT_PID)"
    info "Monitoring virtual stick commands and flight parameters..."
    info "Press Ctrl+C to stop logging and exit."
    
    # Wait for user interrupt
    trap "kill $LOGCAT_PID 2>/dev/null; exit 0" INT
    wait $LOGCAT_PID
}

# Show usage
show_usage() {
    cat << EOF
DJI Mobile SDK V5 - Deploy Script

USAGE:
    $0 [OPTIONS] [BUILD_TYPE] [DEVICE_ID]

ARGUMENTS:
    BUILD_TYPE          APK type to deploy (debug|release) [default: debug]
    DEVICE_ID           Specific device ID to deploy to (optional)

OPTIONS:
    -h, --help          Show this help message
    -l, --logs          Enable hardware probe logging after deployment
    --no-launch         Don't launch app after installation
    --list-devices      List connected devices and exit
    -f, --find          Find and display APK location before deploy
    -v, --verbose       Enable verbose output

COMMANDS:
    devices             List connected devices
    logs [DEVICE_ID]    Monitor hardware probe logs only
    joystick [DEVICE_ID] Monitor enhanced joystick and virtual stick logs (app must be running)
    vstick [DEVICE_ID]  Monitor virtual stick specific logs (app must be running)
    status [DEVICE_ID]  Show device status and app info

EXAMPLES:
    $0                          # Deploy debug APK to selected device
    $0 release                  # Deploy release APK to selected device
    $0 debug 4LFCL5Q005GDF5     # Deploy debug APK to specific device
    $0 --logs release           # Deploy release and start logging
    $0 --no-launch debug        # Deploy without launching app
    $0 devices                  # List connected devices
    $0 logs                     # Monitor hardware probe logs
    $0 joystick                 # Monitor joystick logs (app must be running)
    $0 vstick                   # Monitor virtual stick logs (app must be running)
    $0 status                   # Show device and app status

JOYSTICK MONITORING WORKFLOW:
    1. Deploy app: $0 debug
    2. Monitor logs: $0 joystick  
    3. Move DJI controller sticks to see real-time logging
    4. No UI navigation needed - monitoring is global!

DEVICE DETECTION:
    - Automatically detects DJI controllers
    - Provides device selection for multiple devices
    - Shows device model and manufacturer information

REQUIREMENTS:
    - APK must be built first using './build.sh [BUILD_TYPE]'
    - Android device or DJI controller connected via USB
    - USB debugging enabled on target device
    - ADB available in PATH

APK LOCATIONS:
    The script searches for APK files in:
    - sample/build/outputs/apk/debug/
    - sample/build/outputs/apk/release/

EOF
}

# Parse command line arguments
BUILD_TYPE="debug"
DEVICE_ID=""
AUTO_LAUNCH="true"
ENABLE_LOGGING="false"
LIST_DEVICES="false"
FIND_APK="false"
VERBOSE="false"

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -l|--logs)
            ENABLE_LOGGING="true"
            shift
            ;;
        --no-launch)
            AUTO_LAUNCH="false"
            shift
            ;;
        --list-devices)
            LIST_DEVICES="true"
            shift
            ;;
        -f|--find)
            FIND_APK="true"
            shift
            ;;
        -v|--verbose)
            VERBOSE="true"
            set -x
            shift
            ;;
        devices|logs|joystick|vstick|status)
            COMMAND="$1"
            shift
            if [[ $# -gt 0 && ! "$1" =~ ^- ]]; then
                DEVICE_ID="$1"
                shift
            fi
            ;;
        debug|release)
            BUILD_TYPE="$1"
            shift
            ;;
        *)
            # Assume it's a device ID if it doesn't start with -
            if [[ ! "$1" =~ ^- ]]; then
                DEVICE_ID="$1"
                shift
            else
                error "Unknown option: $1"
                show_usage
                exit 1
            fi
            ;;
    esac
done

# Handle special commands
if [[ -n "${COMMAND:-}" ]]; then
    case "$COMMAND" in
        devices)
            check_prerequisites
            log "Connected devices:"
            DEVICES_ARRAY=()
            IFS=$'\n' read -d '' -r -a DEVICES_ARRAY <<< "$(get_connected_devices)" || true
            
            if [[ ${#DEVICES_ARRAY[@]} -eq 0 ]]; then
                warn "No devices connected."
            else
                for DEVICE_ID in "${DEVICES_ARRAY[@]}"; do
                    MODEL=$(adb -s "$DEVICE_ID" shell getprop ro.product.model 2>/dev/null || echo "Unknown")
                    MANUFACTURER=$(adb -s "$DEVICE_ID" shell getprop ro.product.manufacturer 2>/dev/null || echo "Unknown")
                    
                    if is_dji_controller "$DEVICE_ID"; then
                        echo "  ${DEVICE_ID} - ${MANUFACTURER} ${MODEL} ${GREEN}[DJI Controller]${NC}"
                    else
                        echo "  ${DEVICE_ID} - ${MANUFACTURER} ${MODEL}"
                    fi
                done
            fi
            exit 0
            ;;
        logs)
            check_prerequisites
            if [[ -z "$DEVICE_ID" ]]; then
                SELECTED_DEVICE_ID=$(select_device)
            else
                SELECTED_DEVICE_ID="$DEVICE_ID"
            fi
            start_hardware_probe "$SELECTED_DEVICE_ID"
            exit 0
            ;;
        joystick)
            check_prerequisites
            if [[ -z "$DEVICE_ID" ]]; then
                SELECTED_DEVICE_ID=$(select_device)
            else
                SELECTED_DEVICE_ID="$DEVICE_ID"
            fi
            start_joystick_logging "$SELECTED_DEVICE_ID"
            exit 0
            ;;
        vstick)
            check_prerequisites
            if [[ -z "$DEVICE_ID" ]]; then
                SELECTED_DEVICE_ID=$(select_device)
            else
                SELECTED_DEVICE_ID="$DEVICE_ID"
            fi
            start_virtual_stick_logging "$SELECTED_DEVICE_ID"
            exit 0
            ;;
        status)
            check_prerequisites
            if [[ -z "$DEVICE_ID" ]]; then
                SELECTED_DEVICE_ID=$(select_device)
            else
                SELECTED_DEVICE_ID="$DEVICE_ID"
            fi
            
            log "Device Status: $SELECTED_DEVICE_ID"
            MODEL=$(adb -s "$SELECTED_DEVICE_ID" shell getprop ro.product.model 2>/dev/null || echo "Unknown")
            MANUFACTURER=$(adb -s "$SELECTED_DEVICE_ID" shell getprop ro.product.manufacturer 2>/dev/null || echo "Unknown")
            ANDROID_VERSION=$(adb -s "$SELECTED_DEVICE_ID" shell getprop ro.build.version.release 2>/dev/null || echo "Unknown")
            
            info "  Model: $MANUFACTURER $MODEL"
            info "  Android: $ANDROID_VERSION"
            info "  Controller: $(is_dji_controller "$SELECTED_DEVICE_ID" && echo "Yes" || echo "No")"
            
            # Check if app is installed
            PACKAGE_NAME="com.example.msdksample"
            if adb -s "$SELECTED_DEVICE_ID" shell pm list packages | grep -q "$PACKAGE_NAME"; then
                info "  App Status: Installed"
                VERSION=$(adb -s "$SELECTED_DEVICE_ID" shell dumpsys package "$PACKAGE_NAME" | grep "versionName" | head -n1 | awk '{print $1}' | cut -d'=' -f2 || echo "Unknown")
                info "  App Version: $VERSION"
            else
                warn "  App Status: Not installed"
            fi
            exit 0
            ;;
    esac
fi

# Main deployment workflow
main_deploy() {
    log "=== DJI Mobile SDK V5 Deploy Script ==="
    log "Build type: $BUILD_TYPE"
    log "Auto launch: $AUTO_LAUNCH"
    log "Enable logging: $ENABLE_LOGGING"
    log "Timestamp: $TIMESTAMP"
    log "======================================="
    
    # Check prerequisites
    check_prerequisites
    
    # Find APK
    local APK_PATH
    APK_PATH=$(find_apk "$BUILD_TYPE")
    log "Found APK: $APK_PATH"
    
    # Show APK info if requested
    if [[ "$FIND_APK" == "true" ]]; then
        if command -v aapt &> /dev/null && [[ -f "$APK_PATH" ]]; then
            info "APK Information:"
            PACKAGE_NAME=$(aapt dump badging "$APK_PATH" 2>/dev/null | awk -F"'" '/package: name=/{print $2}' | head -n1)
            VERSION_NAME=$(aapt dump badging "$APK_PATH" 2>/dev/null | awk -F"'" '/versionName=/{print $4}' | head -n1)
            APK_SIZE=$(ls -lh "$APK_PATH" | awk '{print $5}')
            
            info "  Package: $PACKAGE_NAME"
            info "  Version: $VERSION_NAME"
            info "  Size: $APK_SIZE"
        fi
    fi
    
    # Select target device
    local TARGET_DEVICE_ID
    if [[ -n "$DEVICE_ID" ]]; then
        TARGET_DEVICE_ID="$DEVICE_ID"
        log "Using specified device: $TARGET_DEVICE_ID"
    else
        TARGET_DEVICE_ID=$(select_device)
    fi
    
    # Check if it's a DJI controller
    if is_dji_controller "$TARGET_DEVICE_ID"; then
        log "Detected DJI Controller: $TARGET_DEVICE_ID"
        info "Special deployment mode for DJI controller enabled."
    else
        log "Standard Android device detected: $TARGET_DEVICE_ID"
    fi
    
    # Deploy
    deploy_to_device "$APK_PATH" "$TARGET_DEVICE_ID"
    
    # Launch if requested
    if [[ "$AUTO_LAUNCH" == "true" ]]; then
        launch_app "$TARGET_DEVICE_ID"
    fi
    
    # Start logging if requested
    if [[ "$ENABLE_LOGGING" == "true" ]]; then
        start_hardware_probe "$TARGET_DEVICE_ID"
    fi
    
    log "Deployment completed successfully!"
    
    if is_dji_controller "$TARGET_DEVICE_ID"; then
        info "DJI Controller deployment notes:"
        info "- App is now available on the controller"
        info "- Connect your drone to use SDK features"
        info "- Check controller settings for app permissions"
    fi
}

# Run main deployment
main_deploy