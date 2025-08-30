# DJI Mobile SDK V5 - Development Setup & Custom Modifications

> **Complete guide to setting up the development environment and custom modifications made to the sample code**

## 🛠️ Command Line Development Setup

### Prerequisites & System Requirements

**Required Tools**:
- **JDK 17** (Temurin/OpenJDK) - `java -version` should show 17.x
- **Git** and **curl** for downloading tools
- **Android device** with USB debugging enabled

**Java Verification**:
```bash
java -version
# Should output: openjdk version "17.x.x" or similar
```

### Android SDK Command Line Installation

#### 1. SDK Setup Without Android Studio
```bash
# Set SDK location
export ANDROID_SDK_ROOT=$HOME/Android/sdk
mkdir -p "$ANDROID_SDK_ROOT"

# Download command line tools (macOS example)
cd "$ANDROID_SDK_ROOT"
mkdir -p cmdline-tools/latest
curl -L -o tools.zip https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip
unzip tools.zip -d cmdline-tools/latest
rm tools.zip
```

#### 2. Environment Configuration
Add to your shell profile (`~/.zshrc` or `~/.bashrc`):
```bash
export ANDROID_SDK_ROOT="$HOME/Android/sdk"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"
```

Apply changes:
```bash
source ~/.zshrc  # or source ~/.bashrc
```

#### 3. Install Required SDK Components
```bash
# Accept licenses
sdkmanager --licenses

# Install essential tools
sdkmanager \
  "platform-tools" \
  "build-tools;34.0.0" \
  "platforms;android-34" \
  "cmake;3.22.1" \
  "ndk;26.3.11579264"
```

### Project Configuration

#### 1. Local Properties Setup
Create `local.properties` in project root:
```properties
sdk.dir=/Users/<username>/Android/sdk  # macOS
# or
sdk.dir=/home/<username>/Android/sdk   # Linux
```

#### 2. NDK Version Pinning (if needed)
Option A - In `local.properties`:
```properties
ndk.dir=/Users/<username>/Android/sdk/ndk/26.3.11579264
```

Option B - In `app/build.gradle`:
```groovy
android {
    ndkVersion "26.3.11579264"
    // other configuration...
}
```

## 📱 Device Setup & ADB Configuration

### USB Debugging Setup

#### 1. Enable Developer Options
1. **Settings → About Phone**
2. Tap **Build Number** 7 times
3. **Settings → Developer Options**
4. Enable **USB Debugging**

#### 2. ADB Connection
```bash
# Connect device via USB
adb devices
# Authorize debugging on device when prompted
```

#### 3. Wireless ADB (Optional)
```bash
# Switch to wireless mode
adb tcpip 5555

# Connect wirelessly (replace with device IP)
adb connect 192.168.1.100:5555

# Verify connection
adb devices
```

### Linux-Specific udev Rules
For Linux systems, create `/etc/udev/rules.d/51-android.rules`:
```bash
# As root
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0666", GROUP="plugdev"' > /etc/udev/rules.d/51-android.rules

# Reload rules
udevadm control --reload-rules
sudo udevadm trigger
```

## 🏗️ Building & Deployment

### Gradle Build Commands

#### Basic Build & Install
```bash
# Navigate to project root
cd /path/to/android-sdk-v5-sample

# Build debug APK
./gradlew assembleDebug

# Install to connected device
./gradlew installDebug

# Alternative manual install
adb install -r -d app/build/outputs/apk/debug/app-debug.apk
```

#### Build Variants & Flavors
```bash
# Build specific flavor
./gradlew :app:assembleFreeDebug

# Install specific flavor
./gradlew :app:installFreeDebug
```

### Application Launch & Monitoring

#### Launch Application
```bash
# Replace with actual package name and activity
adb shell am start -n dji.sampleV5.aircraft/.DJIAircraftMainActivity
```

#### Monitor Logs
```bash
# View all logs
adb logcat

# Filter by application
adb logcat | grep -i "dji\|aircraft"

# Filter by hardware probe
adb logcat | grep -i "HardwareProbe"

# View specific tag
adb logcat -s "HardwareProbe"
```

### Automated Build Script

#### Build and Deploy Script
*Source: instructions.md:143-184*

Create `tools/build_and_install.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

if [ -f "gradlew" ]; then
  echo "[*] Building DJI SDK V5 Sample App"
  ./gradlew assembleDebug
  
  # Find debug APK
  APK=$(ls -t app/build/outputs/apk/*/app-*-debug*.apk 2>/dev/null | head -n1 || true)
  if [ -z "${APK}" ]; then
    APK=$(ls -t */build/outputs/apk/*/*-debug*.apk 2>/dev/null | head -n1 || true)
  fi
  
  if [ -z "${APK}" ]; then
    echo "Could not find debug APK"
    exit 1
  fi
  
  echo "[*] Installing $APK"
  adb install -r -d "$APK"
  
  # Auto-launch application
  PKG=$(aapt dump badging "$APK" 2>/dev/null | awk -F"'" '/package: name=/{print $2}' | head -n1)
  ACT=$(aapt dump badging "$APK" 2>/dev/null | awk -F"'" '/launchable-activity: name=/{print $2}' | head -n1)
  
  if [ -n "${PKG:-}" ] && [ -n "${ACT:-}" ]; then
    echo "[*] Launching ${PKG}/${ACT}"
    adb shell am start -n "${PKG}/${ACT}" || true
  fi
  exit 0
fi

echo "No gradlew found. Not an Android Gradle project."
exit 1
```

Make executable:
```bash
chmod +x tools/build_and_install.sh
```

## 🔧 Custom Modifications Made

### 1. Hardware Probe Integration

#### Hardware Detection Utility
*Source: SimpleHardwareProbe.java - Custom Addition*
```java
// Custom hardware probing for development debugging
public class SimpleHardwareProbe {
    private static final String TAG = "HardwareProbe";
    
    public static void probeAndLog(Context context) {
        Log.d(TAG, "=== DJI HARDWARE PROBE START ===");
        
        // Device identification
        Log.d(TAG, "Device: " + Build.MANUFACTURER + " " + Build.MODEL);
        Log.d(TAG, "Hardware: " + Build.HARDWARE);
        Log.d(TAG, "Board: " + Build.BOARD);
        Log.d(TAG, "Android: " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        
        // CPU information
        int coreCount = Runtime.getRuntime().availableProcessors();
        Log.d(TAG, "CPU Cores: " + coreCount);
        
        // Architecture support
        String abis = String.join(", ", Build.SUPPORTED_ABIS);
        Log.d(TAG, "ABIs: " + abis);
        
        boolean supports64Bit = Build.SUPPORTED_64_BIT_ABIS.length > 0;
        Log.d(TAG, "64-bit Support: " + supports64Bit);
        
        Log.d(TAG, "=== DJI HARDWARE PROBE END ===");
    }
}
```

#### Application Integration
*Source: DJIAircraftApplication.kt:24-29 - Custom Modification*
```kotlin
// Integration of hardware probe in application startup
class DJIAircraftApplication : DJIApplication() {
    override fun onCreate() {
        super.onCreate()
        
        // Custom hardware probe for debugging
        try {
            SimpleHardwareProbe.probeAndLog(this)
        } catch (e: Exception) {
            android.util.Log.e("DJIAircraftApplication", "Hardware probe failed: ${e.message}")
        }
    }
}
```

**Purpose**: Provides immediate hardware information logging when the application starts, useful for:
- Device compatibility verification
- Architecture support confirmation  
- Development environment debugging
- Hardware capability assessment

### 2. Enhanced Development Logging

#### Joystick Input Monitoring
*Enhancement for Virtual Stick debugging*

The application includes enhanced logging for joystick and virtual stick inputs to help with development debugging:

```kotlin
// Enhanced logging in Virtual Stick operations
fun logJoystickInput(pitch: Float, roll: Float, yaw: Float, throttle: Float) {
    Log.d("VirtualStick", "Input: P=${pitch}, R=${roll}, Y=${yaw}, T=${throttle}")
}
```

**Benefits**:
- Real-time joystick input verification
- Virtual stick command debugging  
- Flight control parameter validation
- Development troubleshooting support

## ⚙️ Development Best Practices

### 1. Build Optimization

#### Parallel Builds
Configure parallel execution in `gradle.properties`:
```properties
org.gradle.parallel=true
org.gradle.daemon=true
org.gradle.caching=true
```

#### Memory Settings
```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxPermSize=512m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
```

### 2. Debugging Configuration

#### ADB Log Filtering
```bash
# Hardware probe logs
adb logcat -s "HardwareProbe"

# DJI SDK logs
adb logcat | grep -E "(DJI|Aircraft|Mission|Virtual)"

# Application logs only
adb logcat | grep "dji.sampleV5"
```

#### Debug Build Configuration
In `app/build.gradle`:
```groovy
android {
    buildTypes {
        debug {
            debuggable true
            minifyEnabled false
            applicationIdSuffix ".debug"
            versionNameSuffix "-debug"
        }
    }
}
```

### 3. Testing & Validation

#### Device Compatibility Check
```bash
# Check device specifications
adb shell getprop ro.build.version.release  # Android version
adb shell getprop ro.product.cpu.abi         # Architecture
adb shell getprop ro.build.characteristics   # Device type
```

#### Application State Monitoring
```bash
# Monitor application lifecycle
adb logcat | grep -E "(onCreate|onResume|onPause|onDestroy)"

# Monitor hardware probe execution
adb logcat | grep "HARDWARE PROBE"
```

## 🚀 Quick Start Workflow

### Daily Development Commands

#### Standard Build & Deploy
```bash
# One-liner build and install
./gradlew installDebug && adb shell am start -n dji.sampleV5.aircraft/.DJIAircraftMainActivity

# With log monitoring
./gradlew installDebug && adb shell am start -n dji.sampleV5.aircraft/.DJIAircraftMainActivity && adb logcat -s "HardwareProbe"
```

#### Using Build Script
```bash
# Automated build, install, and launch
./tools/build_and_install.sh

# Monitor logs after launch
adb logcat | grep -i "dji\|hardware"
```

## 🔍 Troubleshooting

### Common Issues & Solutions

#### Build Issues
```bash
# Clean and rebuild
./gradlew clean
./gradlew assembleDebug

# Check Java version
java -version  # Must be JDK 17

# Verify SDK path
echo $ANDROID_SDK_ROOT
```

#### Device Connection Issues
```bash
# Reset ADB
adb kill-server
adb start-server
adb devices

# Check USB debugging
adb shell settings get global adb_enabled  # Should return 1
```

#### Application Launch Issues
```bash
# Check if app is installed
adb shell pm list packages | grep dji

# Clear app data if needed
adb shell pm clear dji.sampleV5.aircraft

# Check logcat for errors
adb logcat | grep -E "(Error|Exception|Fatal)"
```

### Hardware Probe Debugging

If hardware probe fails to execute:
```bash
# Check logs for probe execution
adb logcat | grep "HardwareProbe"

# Look for initialization errors
adb logcat | grep "DJIAircraftApplication"

# Verify probe class loading
adb logcat | grep "SimpleHardwareProbe"
```

---

## 📋 Development Environment Summary

This setup provides a complete command-line development environment for the DJI Mobile SDK V5 sample application, including:

✅ **Command-line Android development** without Android Studio  
✅ **Automated build and deployment** scripts  
✅ **Custom hardware probing** for development debugging  
✅ **Enhanced logging** for joystick and virtual stick operations  
✅ **Comprehensive troubleshooting** guidance  
✅ **Optimized development workflow** for daily use  

The custom modifications enhance the development experience by providing immediate hardware information and improved debugging capabilities while maintaining compatibility with the original DJI SDK V5 sample code.

---

*Development setup guide based on command-line Android development best practices and custom modifications to the DJI Mobile SDK V5 sample application.*