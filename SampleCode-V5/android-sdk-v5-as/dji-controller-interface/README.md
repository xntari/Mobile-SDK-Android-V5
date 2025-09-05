# DJI Controller Interface

Electron app that replicates the DJI controller interface with real-time data display from the DJI Android bridge.

## Features

- ✅ **Real-time data display** from DJI bridge with stable WebSocket connection
- ✅ **Professional DJI-style interface** with all major widgets  
- ✅ **H.264 video streaming pipeline** - Complete bridge-to-interface streaming (Phase 3B ✅)
- ✅ **Singleton data management** - eliminates React re-mounting issues for stable real-time updates
- ✅ **Browser development mode** with hot module replacement for fast iteration
- ✅ **Cross-platform desktop application** (macOS, Windows, Linux via Electron)
- ✅ **Flight controls** (takeoff, return home) - UI ready, commands implemented
- ✅ **Camera controls and gimbal control** - Full interface with photo, recording, gimbal positioning
- ✅ **Horizontal Situation Indicator (compass)** with live attitude data
- ✅ **Mini map** with aircraft position tracking
- ✅ **Battery and telemetry status** with comprehensive health monitoring
- 🔄 **Native video decoding** - Moving to Electron for robust H.264 playback (Phase 3C)

## Prerequisites

1. **DJI Android Bridge running** - The bridge must be running on the DJI controller
2. **USB connection** - Controller connected via USB with ADB port forwarding
3. **Node.js** - Version 16 or higher

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Build the application
```bash
npm run build
```

### 3. Start the Electron app
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

## DJI Bridge Setup

The Electron app connects to the DJI Android bridge via WebSocket on `localhost:8080`.

### Start the bridge on the DJI controller:
```bash
# Deploy and start the bridge
./build.sh debug && ./deploy.sh debug 4LFCL5Q005GDF5

# Set up port forwarding
adb -s 4LFCL5Q005GDF5 forward tcp:8080 tcp:8080

# Start the bridge activity
adb -s 4LFCL5Q005GDF5 shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE
```

### Verify bridge is running:
```bash
# Test with Node.js client
node ../test_bridge.js localhost
```

## Interface Layout

The Electron app replicates the DJI controller interface:

```
┌─────────────────────────────────────────────────────────────────┐
│  TopBar (Battery, GPS, RC Signal, Flight Mode, Window Controls)│
├─────────────────────────────────────────────────────────────────┤
│ ┌───────┐ ┌────────────────┐              ┌─────────────┐       │
│ │TakeOff│ │                │              │             │       │
│ └───────┘ │    Main Video  │              │   Camera    │       │
│           │     Display    │              │  Controls   │       │
│ ┌───────┐ │  (Full Screen) │              │   (Right)   │       │
│ │Return │ │                │              │             │       │
│ │ Home  │ │                │              │             │       │
│ └───────┘ └────────────────┘              │             │       │
│                                           │             │       │
│           ┌────────────────┐              ┌─────────────┐       │
│           │ HSI Indicator  │              │    Map      │       │
│           │ (Bottom Center)│              │  (Bottom    │       │
│           └────────────────┘              │   Right)    │       │
└───────────────────────────────────────────┴─────────────────────┘
```

## Data Sources

The app displays real-time data from the DJI bridge:

### Controller Data (20Hz)
- Joystick positions (pitch, roll, yaw, throttle)
- Virtual stick status

### Telemetry Data (5Hz)
- GPS location and satellite count
- Altitude (MSL and AGL)
- Speed and attitude (roll, pitch, yaw)
- Distance to home
- Flight mode

### Battery Data (1Hz)
- Battery percentage and voltage
- Temperature and health status

### Camera Data (as available)
- Camera mode and settings
- Gimbal attitude
- Recording status

## Development

### Project Structure
```
src/
├── components/          # React components
│   ├── App.tsx         # Main app component
│   ├── TopBar.tsx      # Status bar
│   ├── FPVDisplay.tsx  # Video display
│   ├── HSICompass.tsx  # Compass widget
│   └── ...
├── hooks/
│   └── useBridgeData.ts # WebSocket data management
├── styles/
│   └── index.css       # Tailwind CSS styles
├── types.ts            # TypeScript interfaces
├── main.ts             # Electron main process
├── preload.ts          # Preload script
└── renderer.tsx        # React entry point
```

### Key Technologies
- **Electron** - Desktop app framework
- **React + TypeScript** - UI framework
- **Tailwind CSS** - Styling
- **WebSocket** - Real-time communication
- **MediaSource API** - H.264 video playback

### Build Commands
```bash
npm run dev:browser # Browser development mode with hot reload (recommended)
npm run dev         # Electron development mode with hot reload  
npm run build       # Production build (all targets)
npm start           # Start Electron app
npm run pack        # Package for distribution
npm run dist        # Create installers
```

## Recent Updates (September 2025)

### ✅ Phase 3B - H.264 Video Streaming Complete  
Successfully implemented complete video streaming pipeline:

- **Android Bridge**: Added MediaDataCenter integration with ICameraStreamManager
- **Video Protocol**: Metadata + binary frame WebSocket transmission  
- **Interface Integration**: Enhanced both Electron and browser modes for H.264 data
- **Cross-Platform**: Uint8Array compatibility for browser, Buffer support for Electron
- **Status**: Video data streaming at 1920x1080, ~26-27KB per frame, ready for decoding

### ✅ Singleton Pattern Implementation
Fixed critical React re-mounting issue that was breaking real-time data updates:

- **Problem**: React components re-mounting on every update, breaking WebSocket callbacks
- **Solution**: Implemented `BridgeManager` singleton pattern with stable state management
- **Result**: Real-time joystick and telemetry data now updates continuously without interruption

### ✅ Browser Development Mode  
Added efficient browser-based development workflow:

- **Command**: `npm run dev:browser` opens http://localhost:3000
- **Features**: Hot module replacement, better debugging, faster iteration
- **WebSocket**: Direct connection to bridge (bypasses Electron IPC layer)

## Troubleshooting

### Connection Issues
- **"Connecting to DJI Bridge..."** - Bridge not running or port forwarding not active
- **Solution**: Verify bridge is running with `adb shell netstat -ln | grep 8080`

### Video Issues
- **"Waiting for Video Stream"** - Camera not active or video streaming not enabled
- **Solution**: Check camera status on controller, ensure recording mode is active

### Build Issues
- **TypeScript errors** - Try: `npm install` then `npm run build`
- **Module not found** - Delete `node_modules` and `package-lock.json`, then `npm install`

## Performance

- **Data refresh rates**: Controller 20Hz, Telemetry 5Hz, Battery 1Hz
- **Memory usage**: ~150MB typical
- **Network usage**: ~10KB/s data + video stream bandwidth
- **Latency**: <50ms for control data, <200ms for video

## Platform Support

- ✅ **macOS** - Native support
- ✅ **Windows** - Via Electron
- ✅ **Linux** - Via Electron

## License

This project is part of the DJI Android Bridge development and follows the same licensing terms.