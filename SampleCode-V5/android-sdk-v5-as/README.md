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

---

## 🌉 DJI Android Bridge - Phase 1 ✅ COMPLETED

The **DJI Android Bridge** provides a WebSocket-based bridge between your laptop and DJI controller, enabling external applications to receive real-time joystick data and send commands back to the drone.

### Bridge Features ✅
- **Real-time joystick streaming** at 20Hz via WebSocket
- **Extensible JSON protocol** for sensors, video, and bidirectional commands  
- **USB connection** using ADB port forwarding (no WiFi dependency)
- **Thread-safe data collection** with proper JSON serialization
- **Headless operation** with minimal UI footprint

### Quick Bridge Setup

#### 1. Deploy Bridge to DJI Controller
```bash
# Build and deploy bridge to DJI controller
./build.sh debug
./deploy.sh debug 4LFCL5Q005GDF5  # Use your controller's device ID

# Launch the bridge activity
adb -s 4LFCL5Q005GDF5 shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE
```

#### 2. Set Up Port Forwarding
```bash
# Forward port 8080 from controller to laptop
adb -s 4LFCL5Q005GDF5 forward tcp:8080 tcp:8080
```

#### 3. Test Bridge Connection
```bash
# Start the test client to receive joystick data
node test_bridge.js localhost

# You should see real-time data when moving DJI controller sticks:
# [02:54:58] 🎮 Controller Data (v1.0, high):
#    Left:  H=   0 V=   0 (Yaw=0.00, Throttle=0.00)
#    Right: H= 472 V=-355 (Roll=4.72, Pitch=-3.55)
#    ✈️  Flight: BACKWARD + RIGHT
```

### Bridge Architecture

**Android Side** (`DJIBridgeActivity` + `DJIBridgeServer`):
- Direct RC stick monitoring using DJI SDK V5 RemoteControllerKey listeners
- WebSocket server on port 8080 with proper frame handling
- Extensible message protocol supporting any payload size
- Thread-safe data collection with `@Volatile` and `@Synchronized`

**Client Side** (`test_bridge.js`):
- WebSocket client with automatic reconnection
- Real-time joystick data visualization
- Flight command interpretation (ASCENDING, FORWARD, RIGHT, etc.)
- Protocol versioning and message debugging

### Protocol Support ✅

The bridge uses an extensible JSON protocol supporting:
- ✅ **Controller data** - Real-time joystick streaming at 20Hz
- ✅ **Telemetry data** - GPS, altitude, attitude, speed at 5Hz
- ✅ **Battery data** - Percentage, voltage, temperature at 1Hz
- ✅ **Video frames** - H.264 streaming via WebSocket binary frames
- 🔄 **Sensor data** - Accelerometer, gyroscope, magnetometer (TODO)
- 🔄 **Bidirectional commands** - Joystick override, waypoints (TODO)

### Files Added/Modified
- `DJIBridgeActivity.kt` - Headless bridge activity with RC monitoring
- `DJIBridgeServer.kt` - WebSocket server with extensible protocol
- `test_bridge.js` - Node.js test client for bridge validation
- `AndroidManifest.xml` - Added bridge activity registration
- Various launch scripts and documentation

---

## 🖥️ DJI Controller Interface - Phase 3B ✅ COMPLETED

The **DJI Controller Interface** is an Electron desktop app that replicates the DJI controller interface with real-time data and live H.264 video streaming from the Android bridge.

### Interface Features ✅
- **Complete DJI-style UI** with all major widgets and controls
- **Real-time data display** - Battery, GPS, telemetry, flight status
- **Flight controls** - Take off, return home with confirmation dialogs
- **Camera controls** - Photo, recording, gimbal control
- **HSI compass** - Small overlay compass in bottom-right corner with attitude display  
- **Mini map** - Aircraft position, home location, distance/bearing
- **✅ Live H.264 video streaming** - WebCodecs-based hardware decoding at 1920x1080
- **Responsive layout** - Resizable window with proper aspect ratio maintenance
- **Cross-platform** - macOS, Windows, Linux support

### Quick Interface Setup

#### 1. Install and Build Interface
```bash
cd dji-controller-interface/

# Install dependencies
npm install

# Build the application
npm run build

# Start Electron app (connects to bridge automatically)
npm start
```

#### 2. Browser Development Mode (Recommended for Development)
```bash
# Serve for browser development (faster iteration)
npm run dev:browser

# Open http://localhost:3000 in browser
# Features hot reload, better debugging, responsive testing
```

#### 3. Complete Setup Flow
```bash
# Terminal 1: Start bridge on controller
./build.sh debug && ./deploy.sh debug 4LFCL5Q005GDF5
adb -s 4LFCL5Q005GDF5 forward tcp:8080 tcp:8080
adb -s 4LFCL5Q005GDF5 shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE

# Terminal 2: Start interface (auto-connects to bridge)
cd dji-controller-interface/
npm start
```

### Interface Layout

The Electron app replicates the professional DJI controller interface:

```
┌─────────────────────────────────────────────────────────────────┐
│  TopBar (Battery, GPS, RC Signal, Flight Mode, Window Controls)│  
├─────────────────────────────────────────────────────────────────┤
│ ┌───────┐ ┌────────────────┐              ┌─────────────┐       │
│ │TakeOff│ │                │              │   Camera    │       │
│ │  🚁   │ │   Main Video   │              │  Controls   │       │ 
│ └───────┘ │    Display     │              │   📸 🎥    │       │
│           │ (H.264 Ready)  │              │   Gimbal    │       │
│ ┌───────┐ │                │              │  ↑ ← 🎥 → ↓  │       │
│ │Return │ │                │              │             │       │
│ │ Home  │ │                │              │  Settings   │       │
│ │  🏠   │ │                │              │             │       │
│ └───────┘ └────────────────┘              └─────────────┘       │
│                                                                 │
│           ┌────────────────┐              ┌─────────────┐       │
│           │ HSI Compass    │              │  Mini Map   │       │
│           │ Attitude+Hdg   │              │  🗺️ Aircraft │       │
│           │ ←N  🧭    E→   │              │  📍 Home    │       │
│           │   S    ↓       │              │   3.5m      │       │
│           └────────────────┘              └─────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### Development Options

**Option 1: Electron Development** (Production target)
```bash
npm start          # Standalone desktop app
npm run pack       # Create app package
npm run dist       # Create installers
```

**Option 2: Browser Development** ⭐ **Recommended for development**
```bash
npm run dev:browser    # Browser with hot reload
# - Faster iteration (no Electron restart)
# - Better debugging tools
# - Easy responsive testing
# - 1:1 conversion to Electron when ready
```

### Real-Time Data Sources

The interface displays live data from the DJI bridge:
- **Controller Data** (20Hz) - Joystick positions, virtual stick status
- **Telemetry Data** (5Hz) - GPS location, altitude, attitude, speed  
- **Battery Data** (1Hz) - Percentage, voltage, temperature, health
- **Camera Data** - Mode, recording status, gimbal attitude

### Files Structure
```
dji-controller-interface/
├── src/components/         # React UI components
│   ├── App.tsx            # Main application
│   ├── TopBar.tsx         # Status bar with flight data
│   ├── FPVDisplay.tsx     # Video display (H.264 ready)
│   ├── HSICompass.tsx     # Interactive compass
│   └── ...               # All DJI widgets
├── src/hooks/             # React hooks for data
├── mock_server.js         # Testing server
├── README.md             # Complete setup guide
└── dist/                 # Built application
```

---

## 🎯 Current Working System (September 2025)

**🚀 FULL END-TO-END SYSTEM NOW WORKING:**

```bash
# 1. Deploy bridge to DJI controller
./build.sh debug && ./deploy.sh debug 4LFCL5Q005GDF5
adb -s 4LFCL5Q005GDF5 forward tcp:8080 tcp:8080  
adb -s 4LFCL5Q005GDF5 shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE

# 2. Start DJI Controller Interface with live H.264 video
cd dji-controller-interface/
npm run dev:browser  # Browser dev mode: http://localhost:3000
# OR
npm run build && npm run dev  # Electron desktop app
```

**What You Get:**
- ✅ **Live H.264 video stream** from DJI camera at 1920x1080 
- ✅ **Real-time flight data** - GPS, altitude, attitude, battery
- ✅ **Live joystick data** - All 4 axes updating at 20Hz
- ✅ **Professional DJI UI** - Complete desktop interface
- ✅ **Responsive design** - Resizable window, proper aspect ratios
- ✅ **Small HSI compass** - Bottom-right overlay, attitude display

**Performance:**
- Video: ~26KB per frame, smooth playback with WebCodecs hardware decoding
- Data: 20Hz controller + 5Hz telemetry + 1Hz battery = ~25 updates/second
- Latency: <100ms end-to-end (controller → laptop display)

## ✅ Current Status: FULLY WORKING NAVIGATION SYSTEM

**What Works Perfectly:**
- ✅ **Live H.264 video stream** from DJI camera at 1920x1080
- ✅ **Real-time flight data** display (GPS, altitude, battery, speed, distance)
- ✅ **Real joystick data** transmission (20Hz from controller)
- ✅ **Professional DJI-style desktop interface** - Complete responsive UI
- ✅ **HSI Compass with 360° obstacle visualization** - Advanced version with raw perception data toggle, scale slider, logarithmic scaling
- ✅ **Auto-rotating minimap** - Map rotates based on aircraft heading, aircraft always points "up"
- ✅ **Real compass data collection** from DJI SDK FlightControllerKey
- ✅ **Obstacle avoidance data** - Raw distance arrays from radar and perception sensors
- ✅ **Responsive window behavior** - Resizable with proper aspect ratios

## 🧪 System Testing Script

**Quick system verification:**
```bash
# One-command system test (recommended)
./test_system.sh

# This script will:
# 1. ✅ Check device connection
# 2. 🔄 Stop existing processes  
# 3. 🔌 Re-establish port forwarding
# 4. 🚀 Launch Android bridge
# 5. 🌐 Start browser client at http://localhost:3000
# 6. ✅ Verify all connections
```

**Manual step-by-step verification:**
```bash
# 1. Check device connection
adb devices

# 2. Re-establish port forwarding (critical after controller restart)
adb forward tcp:8080 tcp:8080

# 3. Launch bridge on controller
adb shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE

# 4. Start browser client (recommended for development)
cd dji-controller-interface/
npm run dev:browser
# Open http://localhost:3000
```

## 🎯 Expected Functionality 

When the system is running correctly, you should see:
- ✅ **Live video stream** - Smooth H.264 video at 1920x1080
- ✅ **HSI compass** - Bottom-right overlay with obstacle visualization, raw perception data toggle, distance scaling
- ✅ **Auto-rotating minimap** - Top-left overlay, map rotates with aircraft heading
- ✅ **Real-time telemetry** - GPS coordinates, altitude, speed, distance to home
- ✅ **Battery status** - Percentage, voltage, temperature in top bar
- ✅ **Joystick data** - Controller inputs updating at 20Hz

## 🚨 Troubleshooting

**Connection Issues:**
```bash
# Port forwarding gets lost after controller restart - re-run:
adb forward tcp:8080 tcp:8080

# Or use the automated test script:
./test_system.sh
```

**Next Development Priority**: See `./docs/TODO.md` for multi-camera streaming implementation using `CameraStreamDetailVM.kt` patterns.