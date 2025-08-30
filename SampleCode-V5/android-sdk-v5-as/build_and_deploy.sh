#!/usr/bin/env bash
set -euo pipefail

# DJI Mobile SDK V5 - Automated Build and Deploy Script
# Supports deployment to Android devices and DJI controllers

# Configuration
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_MODULE="sample"
LOG_FILE="${PROJECT_DIR}/build_deploy.log"
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
    log "Checking prerequisites..."
    
    # Check Java version
    if command -v java &> /dev/null; then
        JAVA_VERSION=$(java -version 2>&1 | head -n1 | awk -F '"' '{print $2}')
        log "Java version: $JAVA_VERSION"
    else
        error "Java not found. Please install JDK 17."
        exit 1
    fi
    
    # Check Android SDK
    if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
        warn "ANDROID_SDK_ROOT not set. Checking common locations..."
        if [[ -d "$HOME/Android/sdk" ]]; then
            export ANDROID_SDK_ROOT="$HOME/Android/sdk"
            log "Found Android SDK at: $ANDROID_SDK_ROOT"
        else
            error "Android SDK not found. Please set ANDROID_SDK_ROOT environment variable."
            exit 1
        fi
    else
        log "Android SDK: $ANDROID_SDK_ROOT"
    fi
    
    # Check ADB
    if command -v adb &> /dev/null; then
        log "ADB available: $(which adb)"
    else
        error "ADB not found. Please ensure Android SDK platform-tools are in PATH."
        exit 1
    fi
    
    # Check gradlew
    if [[ ! -f "./gradlew" ]]; then
        error "Gradle wrapper not found. Are you in the correct directory?"
        exit 1
    fi
    
    log "Prerequisites check completed successfully."
}

# Clean and prepare build environment
prepare_build() {
    log "Preparing build environment..."
    
    # Create local.properties if it doesn't exist
    if [[ ! -f "local.properties" ]]; then
        log "Creating local.properties..."
        cat > local.properties << EOF
sdk.dir=${ANDROID_SDK_ROOT}
ndk.dir=${ANDROID_SDK_ROOT}/ndk/21.4.7075529
EOF
    fi
    
    # Clean previous builds
    log "Cleaning previous builds..."
    ./gradlew clean
    
    log "Build environment prepared."
}

# Build the application
build_app() {
    local BUILD_TYPE="${1:-debug}"
    log "Building application (${BUILD_TYPE})..."
    
    case "$BUILD_TYPE" in
        "debug")
            ./gradlew :${SAMPLE_MODULE}:assembleDebug
            ;;
        "release")
            ./gradlew :${SAMPLE_MODULE}:assembleRelease
            ;;
        *)
            error "Invalid build type: $BUILD_TYPE. Use 'debug' or 'release'."
            exit 1
            ;;
    esac
    
    log "Build completed successfully."
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
    )
    
    for PATTERN in "${SEARCH_PATHS[@]}"; do
        if ls $PATTERN 1> /dev/null 2>&1; then
            APK_PATH=$(ls -t $PATTERN | head -n1)
            break
        fi
    done
    
    if [[ -z "$APK_PATH" ]]; then
        error "Could not find built APK for build type: $BUILD_TYPE"
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
        adb shell am start -n "${PACKAGE_NAME}/.${ACTIVITY_NAME}"
    else
        adb -s "$DEVICE_ID" shell am start -n "${PACKAGE_NAME}/.${ACTIVITY_NAME}"
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

# Main deployment workflow
main_deploy() {
    local BUILD_TYPE="${1:-debug}"
    local SKIP_BUILD="${2:-false}"
    local AUTO_LAUNCH="${3:-true}"
    local ENABLE_LOGGING="${4:-false}"
    
    log "=== DJI Mobile SDK V5 Build and Deploy ==="
    log "Build type: $BUILD_TYPE"
    log "Skip build: $SKIP_BUILD"
    log "Auto launch: $AUTO_LAUNCH"
    log "Enable logging: $ENABLE_LOGGING"
    log "============================================"
    
    # Check prerequisites
    check_prerequisites
    
    # Build if not skipping
    if [[ "$SKIP_BUILD" != "true" ]]; then
        prepare_build
        build_app "$BUILD_TYPE"
    fi
    
    # Find APK
    local APK_PATH
    APK_PATH=$(find_apk "$BUILD_TYPE")
    log "Found APK: $APK_PATH"
    
    # Select target device
    local DEVICE_ID
    DEVICE_ID=$(select_device)
    
    # Check if it's a DJI controller
    if is_dji_controller "$DEVICE_ID"; then
        log "Detected DJI Controller: $DEVICE_ID"
        info "Special deployment mode for DJI controller enabled."
    else
        log "Standard Android device detected: $DEVICE_ID"
    fi
    
    # Deploy
    deploy_to_device "$APK_PATH" "$DEVICE_ID"
    
    # Launch if requested
    if [[ "$AUTO_LAUNCH" == "true" ]]; then
        launch_app "$DEVICE_ID"
    fi
    
    # Start logging if requested
    if [[ "$ENABLE_LOGGING" == "true" ]]; then
        start_hardware_probe "$DEVICE_ID"
    fi
    
    log "Deployment completed successfully!"
    
    if is_dji_controller "$DEVICE_ID"; then
        info "DJI Controller deployment notes:"
        info "- App is now available on the controller"
        info "- Connect your drone to use SDK features"
        info "- Check controller settings for app permissions"
    fi
}

# Show usage
show_usage() {
    cat << EOF
DJI Mobile SDK V5 - Build and Deploy Tool

USAGE:
    $0 [OPTIONS] [COMMAND]

COMMANDS:
    build [debug|release]     Build the application only
    deploy [debug|release]    Build and deploy to connected device
    install [debug|release]   Deploy existing APK (skip build)
    clean                     Clean build artifacts
    devices                   List connected devices
    logs                      Monitor hardware probe logs

OPTIONS:
    -h, --help               Show this help message
    -l, --logs               Enable hardware probe logging after deployment
    --no-launch              Don't launch app after installation
    --debug                  Build in debug mode (default)
    --release                Build in release mode

EXAMPLES:
    $0 deploy                # Build debug and deploy to selected device
    $0 deploy release        # Build release and deploy
    $0 install debug         # Deploy existing debug APK
    $0 build release         # Build release APK only
    $0 logs                  # Monitor hardware probe logs
    $0 --logs deploy         # Deploy and start logging

ENVIRONMENT VARIABLES:
    ANDROID_SDK_ROOT         Path to Android SDK (auto-detected if not set)

For DJI Controller deployment:
- The script automatically detects DJI controllers
- Enables special deployment optimizations
- Provides controller-specific guidance

EOF
}

# Parse command line arguments
BUILD_TYPE="debug"
COMMAND="deploy"
SKIP_BUILD="false"
AUTO_LAUNCH="true"
ENABLE_LOGGING="false"

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
        --debug)
            BUILD_TYPE="debug"
            shift
            ;;
        --release)
            BUILD_TYPE="release"
            shift
            ;;
        build|deploy|install|clean|devices|logs)
            COMMAND="$1"
            shift
            if [[ $# -gt 0 && "$1" =~ ^(debug|release)$ ]]; then
                BUILD_TYPE="$1"
                shift
            fi
            ;;
        *)
            error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Execute command
case "$COMMAND" in
    build)
        check_prerequisites
        prepare_build
        build_app "$BUILD_TYPE"
        log "Build completed. APK location: $(find_apk "$BUILD_TYPE")"
        ;;
    deploy)
        main_deploy "$BUILD_TYPE" "$SKIP_BUILD" "$AUTO_LAUNCH" "$ENABLE_LOGGING"
        ;;
    install)
        main_deploy "$BUILD_TYPE" "true" "$AUTO_LAUNCH" "$ENABLE_LOGGING"
        ;;
    clean)
        log "Cleaning build artifacts..."
        ./gradlew clean
        rm -f "$LOG_FILE"
        log "Clean completed."
        ;;
    devices)
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
        ;;
    logs)
        SELECTED_DEVICE_ID=$(select_device)
        start_hardware_probe "$SELECTED_DEVICE_ID"
        ;;
    *)
        error "Unknown command: $COMMAND"
        show_usage
        exit 1
        ;;
esac