#!/usr/bin/env bash
set -euo pipefail

# DJI Mobile SDK V5 - Build Script
# Builds the application without deployment

# Configuration
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_MODULE="sample"
LOG_FILE="${PROJECT_DIR}/build.log"
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
    log "Checking build prerequisites..."
    
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
        exit 1
    fi
    
    echo "$APK_PATH"
}

# Show usage
show_usage() {
    cat << EOF
DJI Mobile SDK V5 - Build Script

USAGE:
    $0 [OPTIONS] [BUILD_TYPE]

BUILD_TYPES:
    debug                Build debug APK (default)
    release              Build release APK
    clean                Clean build artifacts
    both                 Build both debug and release

OPTIONS:
    -h, --help          Show this help message
    -c, --clean         Clean before building
    -f, --find          Find and display APK location after build
    -v, --verbose       Enable verbose output
    --no-prep           Skip build environment preparation

EXAMPLES:
    $0                  # Build debug APK
    $0 debug            # Build debug APK
    $0 release          # Build release APK  
    $0 both             # Build both debug and release
    $0 clean            # Clean build artifacts
    $0 -c debug         # Clean and build debug
    $0 -f release       # Build release and show APK location

ENVIRONMENT VARIABLES:
    ANDROID_SDK_ROOT    Path to Android SDK (auto-detected if not set)

BUILD OUTPUT:
    APK files are generated in:
    - sample/build/outputs/apk/debug/
    - sample/build/outputs/apk/release/

EOF
}

# Parse command line arguments
BUILD_TYPE="debug"
CLEAN_FIRST="false"
FIND_APK="false"
VERBOSE="false"
SKIP_PREP="false"

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -c|--clean)
            CLEAN_FIRST="true"
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
        --no-prep)
            SKIP_PREP="true"
            shift
            ;;
        debug|release|clean|both)
            BUILD_TYPE="$1"
            shift
            ;;
        *)
            error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Main execution
main() {
    log "=== DJI Mobile SDK V5 Build Script ==="
    log "Build type: $BUILD_TYPE"
    log "Clean first: $CLEAN_FIRST"
    log "Find APK: $FIND_APK"
    log "Timestamp: $TIMESTAMP"
    log "======================================"
    
    # Check prerequisites
    check_prerequisites
    
    # Prepare build environment (unless skipped)
    if [[ "$SKIP_PREP" != "true" ]]; then
        prepare_build
    fi
    
    # Clean if requested
    if [[ "$CLEAN_FIRST" == "true" ]]; then
        log "Cleaning build artifacts..."
        ./gradlew clean
    fi
    
    # Execute build based on type
    case "$BUILD_TYPE" in
        "clean")
            log "Cleaning build artifacts..."
            ./gradlew clean
            rm -f "$LOG_FILE"
            log "Clean completed."
            ;;
        "both")
            log "Building both debug and release versions..."
            build_app "debug"
            build_app "release"
            
            if [[ "$FIND_APK" == "true" ]]; then
                DEBUG_APK=$(find_apk "debug")
                RELEASE_APK=$(find_apk "release")
                log "Debug APK: $DEBUG_APK"
                log "Release APK: $RELEASE_APK"
            fi
            ;;
        "debug"|"release")
            build_app "$BUILD_TYPE"
            
            if [[ "$FIND_APK" == "true" ]]; then
                APK_PATH=$(find_apk "$BUILD_TYPE")
                log "APK location: $APK_PATH"
                
                # Show APK info
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
            ;;
        *)
            error "Unknown build type: $BUILD_TYPE"
            show_usage
            exit 1
            ;;
    esac
    
    log "Build script completed successfully!"
}

# Run main function
main