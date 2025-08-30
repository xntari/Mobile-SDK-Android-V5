# DJI Mobile SDK V5 - Build and Deploy Guide

This guide explains how to build and deploy the DJI Mobile SDK V5 sample application using separate build and deploy scripts for maximum flexibility.

## Quick Start

### Prerequisites
- **Java 17** installed and configured
- **Android SDK** with platform-tools and build-tools
- **Android device** or **DJI Controller** connected via USB
- **USB debugging** enabled on target device

### Separate Build and Deploy Workflow

The project now uses separate scripts for building and deploying, allowing you to:
- Build once, deploy multiple times without rebuilding
- Deploy to different devices without rebuilding
- Faster deployment cycles during development

```bash
# Step 1: Build the application
./build.sh debug              # Build debug APK
./build.sh release            # Build release APK

# Step 2: Deploy to device (no rebuild needed)
./deploy.sh debug             # Deploy debug APK
./deploy.sh release           # Deploy release APK
```

### Build Script Usage

```bash
# Basic building
./build.sh                    # Build debug APK (default)
./build.sh debug              # Build debug APK
./build.sh release            # Build release APK
./build.sh both               # Build both debug and release
./build.sh clean              # Clean build artifacts

# Advanced build options
./build.sh -c debug           # Clean and build debug
./build.sh -f release         # Build release and show APK location
./build.sh -v debug           # Verbose build output
./build.sh --help             # Show build help
```

### Deploy Script Usage

```bash
# Basic deployment
./deploy.sh                   # Deploy debug APK (default)
./deploy.sh debug             # Deploy debug APK
./deploy.sh release           # Deploy release APK

# Deploy to specific device
./deploy.sh debug 4LFCL5Q005GDF5

# Advanced deploy options
./deploy.sh --logs debug      # Deploy and start logging
./deploy.sh --no-launch debug # Deploy without launching app
./deploy.sh devices           # List connected devices
./deploy.sh logs              # Monitor hardware probe logs only
./deploy.sh joystick          # Monitor enhanced joystick logs
./deploy.sh vstick            # Monitor virtual stick specific logs
./deploy.sh status            # Show device and app status
./deploy.sh --help            # Show deploy help
```

### Legacy Combined Script

The original combined script is still available for compatibility:

```bash
# Combined build and deploy (legacy)
./build_and_deploy.sh deploy debug
./build_and_deploy.sh build release
```

## DJI Controller Support

The script automatically detects DJI controllers and provides optimized deployment:

- **Auto-detection**: Recognizes DJI RC Plus, DJI Smart Controller, and other DJI hardware
- **Optimized deployment**: Uses controller-specific settings
- **Special guidance**: Provides controller-specific setup instructions

### Detected Controllers
When a DJI controller is detected, you'll see:
```
4LFCL5Q005GDF5 - DJI DJI RC Plus [DJI Controller]
```

## Project Structure

```
android-sdk-v5-as/
├── build.sh                    # Build script (creates APK)
├── deploy.sh                   # Deploy script (installs APK)
├── build_and_deploy.sh         # Legacy combined script
├── build.log                   # Build logs
├── deploy.log                  # Deploy logs
├── local.properties            # Auto-generated SDK paths
├── sample/                     # Sample application module
│   └── build/outputs/apk/      # Built APK files
│       ├── debug/              # Debug APK files
│       └── release/            # Release APK files
└── uxsdk/                      # UX SDK widget library
```

## Features

### ✅ Separate Build and Deploy Scripts
- **Independent operations**: Build once, deploy multiple times
- **Faster development**: Deploy to different devices without rebuilding
- **Flexible workflow**: Mix and match build types with deployment targets
- **Reduced build time**: Only rebuild when source code changes

### ✅ Build Script Features (`build.sh`)
- Gradle wrapper detection and execution
- Multi-variant build support (debug/release/both)
- Automatic dependency resolution
- Clean build environment setup
- APK location detection and reporting
- Build artifact information display

### ✅ Deploy Script Features (`deploy.sh`)
- Smart device detection with interactive selection
- DJI controller auto-detection and optimization
- APK installation with overwrite protection
- Application auto-launch capability
- Real-time hardware probe logging
- Device status and app information

### ✅ Development Tools
- Hardware probe integration for debugging
- Real-time log monitoring (`./deploy.sh logs`)
- Device management (`./deploy.sh devices`, `./deploy.sh status`)
- Build artifact verification
- Environment validation

### ✅ Error Handling & Recovery
- Comprehensive prerequisite checking
- Detailed error messages and troubleshooting
- Automatic APK location detection
- Recovery suggestions for common issues

## Troubleshooting

### Common Issues

**Build Failures:**
```bash
# Clean and rebuild
./build.sh clean
./build.sh debug
```

**APK Not Found for Deployment:**
```bash
# Build first, then deploy
./build.sh debug
./deploy.sh debug
```

**Device Not Detected:**
```bash
# Check ADB connection
adb devices

# Reset ADB if needed
adb kill-server && adb start-server

# List devices using deploy script
./deploy.sh devices
```

**SDK Path Issues:**
```bash
# Set Android SDK path manually
export ANDROID_SDK_ROOT=/path/to/android/sdk
./build.sh debug
```

**Permission Denied:**
```bash
# Make scripts executable
chmod +x build.sh deploy.sh build_and_deploy.sh
```

**Deployment to Wrong Device:**
```bash
# Deploy to specific device ID
./deploy.sh debug YOUR_DEVICE_ID

# Or use device selection
./deploy.sh debug  # Will show device selection menu
```

### Enhanced Logging Capabilities

The deployment script includes multiple logging modes for comprehensive debugging:

#### Hardware Probe Logging
```bash
# Start hardware probe logging only
./deploy.sh logs

# Deploy with automatic logging
./deploy.sh --logs debug

# Check device and app status
./deploy.sh status
```

#### Joystick and Virtual Stick Logging

**Global Joystick Monitoring**: The app now includes global joystick monitoring that works immediately upon app launch, without needing to navigate to any specific page.

```bash
# Step 1: Deploy and launch app
./deploy.sh debug

# Step 2: In separate terminal, monitor joystick activity
./deploy.sh joystick          # Enhanced joystick and virtual stick logging
./deploy.sh vstick            # Virtual stick specific logging  

# Or deploy and immediately start logging
./deploy.sh --logs debug     # Deploy with basic logging
```

**Simple Usage Flow:**
1. Deploy app to device/controller: `./deploy.sh debug`
2. In separate terminal: `./deploy.sh joystick` 
3. **Move your DJI controller sticks** - logging happens automatically!
4. No need to navigate to VirtualStick page - monitoring is global

**Key Features:**
- 🎮 **Global monitoring**: Works immediately when app starts
- 📱 **No UI navigation required**: Monitor sticks from any app screen
- 🕒 **Real-time logging**: Instant feedback on stick movements
- 🛡️ **Safety warnings**: Alerts for aggressive movements

#### Log Categories and Content

**Hardware Probe Logs:**
- Device model and manufacturer
- CPU architecture and core count
- Memory information
- Display specifications
- Android version and API level

**Enhanced Joystick Logs:**
- `VirtualStick` - Original DJI format: `Input: P=0.450, R=-0.230, Y=0.100, T=0.800`
- `RC_STICK_MONITOR` - Raw controller stick values with timestamps
- `RC_STICK_DIRECTION` - Movement direction analysis (POSITIVE, NEGATIVE, HIGH_POSITIVE)
- `FLIGHT_MAPPING` - Flight parameter mapping (pitch, roll, yaw, throttle)
- `FLIGHT_COMMAND` - Human-readable commands (ASCENDING, MOVING_FORWARD, ROTATING_LEFT)
- `FLIGHT_SAFETY` - Safety warnings for aggressive movements
- `GlobalJoystickMonitor` - Global monitoring status and initialization

**Sample Joystick Log Output:**
```
GlobalJoystickMonitor: Starting global RC stick monitoring...
RC_STICK_MONITOR: Right Vertical (Pitch): 45 (0.45%) at 1693456789123
VirtualStick: Input: P=0.450, R=0.000, Y=0.000, T=0.000
FLIGHT_MAPPING: Flight Parameters at 1693456789123:
FLIGHT_MAPPING:   Pitch: 0.450 (forward/backward)
FLIGHT_COMMAND: Interpreted Command: MOVING_FORWARD
```

## Environment Variables

| Variable | Description | Auto-detected |
|----------|-------------|---------------|
| `ANDROID_SDK_ROOT` | Path to Android SDK | ✅ Common paths |
| `JAVA_HOME` | Path to Java installation | ✅ System Java |

## Build Variants

### Debug Build
```bash
./build_and_deploy.sh build debug
```
- Debugging enabled
- No code obfuscation
- Faster build times
- Development keystore signing

### Release Build
```bash
./build_and_deploy.sh build release
```
- Code optimization enabled
- ProGuard/R8 shrinking
- Production keystore signing
- Smaller APK size

## DJI SDK Integration

The application includes:
- **DJI Mobile SDK V5.15.0** - Latest aircraft SDK
- **UX SDK Widgets** - 150+ pre-built UI components
- **Sample Applications** - Comprehensive feature examples
- **Custom Hardware Probe** - Development debugging utility

### Key Dependencies
- `dji-sdk-v5-aircraft:5.15.0`
- `dji-sdk-v5-networkImp:5.15.0`
- Android Architecture Components
- RxJava 3 for reactive programming
- Google Maps and MapLibre integration

## Script Architecture

### Core Components
1. **Prerequisite Checker** - Validates environment setup
2. **Build System** - Manages Gradle build process
3. **Device Manager** - Handles device detection and selection
4. **Deployment Engine** - Manages APK installation and launch
5. **Logger** - Provides comprehensive logging and monitoring

### Safety Features
- Atomic operations with rollback capability
- Build artifact verification
- Device compatibility checking
- Error recovery mechanisms
- Progress tracking and status reporting

## Getting Help

```bash
# Show help and usage information
./build_and_deploy.sh --help

# View recent logs
tail -f build_deploy.log

# Check script version and features
./build_and_deploy.sh --help | head -20
```

---

## Quick Reference

### Build Commands
| Command | Description |
|---------|-------------|
| `./build.sh` | Build debug APK (default) |
| `./build.sh debug` | Build debug APK |
| `./build.sh release` | Build release APK |
| `./build.sh both` | Build both debug and release |
| `./build.sh clean` | Clean build artifacts |
| `./build.sh -f debug` | Build and show APK location |
| `./build.sh --help` | Show build help |

### Deploy Commands
| Command | Description |
|---------|-------------|
| `./deploy.sh` | Deploy debug APK (default) |
| `./deploy.sh debug` | Deploy debug APK |
| `./deploy.sh release` | Deploy release APK |
| `./deploy.sh devices` | List connected devices |
| `./deploy.sh logs` | Monitor hardware probe logs |
| `./deploy.sh joystick` | Monitor enhanced joystick logs |
| `./deploy.sh vstick` | Monitor virtual stick specific logs |
| `./deploy.sh status` | Show device and app status |
| `./deploy.sh --logs debug` | Deploy with logging |
| `./deploy.sh --help` | Show deploy help |

### Legacy Combined Commands
| Command | Description |
|---------|-------------|
| `./build_and_deploy.sh deploy` | Build and deploy debug APK |
| `./build_and_deploy.sh build release` | Build release APK only |

**For DJI controller deployment**, the script provides:
- Automatic controller detection
- Optimized deployment settings
- Controller-specific guidance
- Hardware probe integration

This automated solution streamlines the development workflow for DJI Mobile SDK V5 applications.