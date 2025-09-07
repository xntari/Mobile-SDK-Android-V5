# DJI Android Bridge + Controller Interface - HANDOFF DOCUMENT

## 🚀 TLDR - You Are Here

**CURRENT STATE**: **✅ COMPLETE NAVIGATION SYSTEM** - Advanced HSI compass with 360° obstacle visualization + auto-rotating minimap both working perfectly.

**IMMEDIATE NEXT STEPS:**
1. **📷 HIGH PRIORITY: Multi-Video Decoding Implementation** - Investigate CameraStreamManager in SDK demo, modify Android bridge for dual camera streams without frame mixing
2. **🎛️ HIGH PRIORITY: Secondary Camera Stream Support** - Add metadata for gimbal camera, maintain FPV compatibility when secondary stream absent
3. **🔧 MEDIUM: Complete flight controls** - Take off, RTH, flight mode switching  
4. **🗺️ LOW: Investigate DJI native map tiles** - Replace OpenStreetMap with DJI's official tiles

**CONTEXT**: Live H.264 video streaming + telemetry + **complete navigation system** works perfectly. Ready for camera controls and multi-camera support.

---

## 📍 **CURRENT STATUS - PARTIALLY WORKING SYSTEM**

### ✅ **What Works Perfectly**
- **Live H.264 video stream** from DJI camera at 1920x1080 resolution  
- **Real-time telemetry data** - GPS, altitude, speed, distance to home, battery
- **Live joystick data** - All 4 axes streaming at 20Hz from controller
- **Professional desktop interface** - Electron app with DJI-style UI
- **Responsive window behavior** - Resizable with proper aspect ratios
- **HSI Compass with 360° obstacle visualization** - Advanced version with raw perception data toggle, scale slider, logarithmic scaling
- **Auto-rotating minimap** - Map rotates based on aircraft heading, aircraft always points "up"
- **Real compass data collection** - `FlightControllerKey.KeyCompassHeading` successfully integrated
- **Obstacle avoidance data** - Raw distance arrays from radar and perception sensors

### 🎯 **Ready for Implementation**
- **Multi-camera streaming architecture** - SDK demo shows complete working implementation in `CameraStreamDetailVM.kt`
- **Dual video stream support** - FPV + secondary camera (gimbal/H20N) with metadata routing
- **Stream separation** - Individual camera stream management using `ICameraStreamManager`
- **Backwards compatibility** - System functions normally with FPV-only when secondary camera absent

### 📋 **Next Development Focus**
- **Study CameraStreamDetailVM.kt and CameraStreamDetailFragment.kt** - Complete multi-camera implementation examples
- **Implement dual-stream architecture** - Extend DJIBridgeServer.kt with ICameraStreamManager pattern
- **Add camera metadata to video frames** - Stream identification without breaking existing functionality

---

## 🎯 **IMMEDIATE IMPLEMENTATION PRIORITY**

### **Task 1**: Multi-Video Stream Implementation (HIGH PRIORITY)

**Goal**: Implement dual camera streaming architecture to support FPV + secondary camera (gimbal/H20N) without frame mixing.

**Key SDK Files to Study**:
- `CameraStreamDetailVM.kt:188-189` - `putCameraStreamSurface()` method for multi-camera management
- `CameraStreamDetailFragment.kt:285-301` - Surface management and stream priority handling
- `ICameraStreamManager` interface - Core multi-stream architecture
- Lines of Interest:
  - `CameraStreamDetailVM.kt:22` - `ICameraStreamManager` import
  - `CameraStreamDetailVM.kt:189` - Surface assignment per camera index
  - `CameraStreamDetailFragment.kt:295-300` - Stream surface configuration

**Implementation Strategy**:
1. **Study existing multi-camera demo** - CameraStreamDetailFragment shows complete working example
2. **Modify DJIBridgeServer.kt** to support dual video frame callbacks:
   - FPV stream: `ComponentIndexType.FPV`  
   - Secondary stream: `ComponentIndexType.LEFT_OR_MAIN` (H20N) or gimbal camera
3. **Add metadata routing** - Include `camera_type` field in video frame packets
4. **Client-side stream separation** - Process streams in separate buffers based on metadata
5. **Backwards compatibility** - System functions normally with FPV-only when secondary absent

### **Task 2**: Stream Metadata Enhancement (HIGH PRIORITY)

**Goal**: Add camera identification metadata to video frames without breaking existing single-stream functionality.

**Implementation**:
- Extend current H.264 frame packet format to include `camera_source` identifier
- Client detects secondary stream presence and enables dual-video UI mode
- FPV-only operation remains unchanged for backwards compatibility

---

## 🔧 **TECHNICAL CURRENT STATE**


### **Current System Flow**
```
┌─────────────────┐    WebSocket      ┌──────────────────┐    Electron IPC     ┌─────────────────┐
│  DJI Controller │◄─────────────────►│ Electron Main    │◄───────────────────►│ React Interface │
│   (Android)     │  JSON + H.264     │   Process        │   Video + Data      │   (Desktop UI)  │
│                 │                   │                  │                     │                 │
│ ┌─────────────┐ │                   │ ┌──────────────┐ │                     │ ┌─────────────┐ │
│ │DJI SDK V5   │ │                   │ │ WebSocket    │ │                     │ │ Live Video  │ │
│ │Bridge Server│ │                   │ │ Client       │ │                     │ │ 1920x1080   │ │
│ │:8080        │ │                   │ │              │ │                     │ │ WebCodecs   │ │
│ │             │ │                   │ └──────────────┘ │                     │ └─────────────┘ │
│ │ ┌─────────┐ │ │                   │                  │                     │                 │
│ │ │Camera   │ │ │                   │ ┌──────────────┐ │                     │ ┌─────────────┐ │
│ │ │H.264    │ │ │                   │ │ Video Frame  │ │                     │ │ Telemetry   │ │
│ │ │Streamer │ │ │                   │ │ Handler      │ │                     │ │ HSI Compass │ │
│ │ └─────────┘ │ │                   │ └──────────────┘ │                     │ │ Mini Map    │ │
│ └─────────────┘ │                   │                  │                     │ └─────────────┘ │
└─────────────────┘                   └──────────────────┘                     └─────────────────┘
```

### What's Working**
```
┌─────────────────┐    WebSocket      ┌──────────────────┐    Electron IPC     ┌─────────────────┐
│  DJI Controller │◄─────────────────►│ Electron Main    │◄───────────────────►│ React Interface │
│   (Android)     │  JSON + H.264     │   Process        │   Video + Data      │   (Desktop UI)  │
│                 │                   │                  │                     │                 │
│ ✅ DJI SDK V5   │                   │ ✅ WebSocket     │                     │ ✅ Live Video   │
│ ✅ H.264 Stream │                   │ ✅ Binary Proto  │                     │ ✅ WebCodecs    │
│ ⚠️ Compass Data  │                   │ ✅ Data Relay    │                     │ ⚠️ HSI Compass  │
│ ⚠️ Attitude      │                   │ ✅ Frame Handler │                     │ ⚠️ Minimap      │
└─────────────────┘                   └──────────────────┘                     └─────────────────┘
```

### **Data Flow - What We Have**
- **Controller Data**: 20Hz, all joystick axes working
- **Telemetry Data**: 5Hz, GPS/altitude/attitude/speed working
- **Battery Data**: 1Hz, percentage/voltage/temperature working  
- **H.264 Video**: 30fps variable, ~26KB per frame, smooth playback
- **Compass Data**: Real magnetometer heading collected via `FlightControllerKey.KeyCompassHeading`

### **Critical Files for Multi-Camera Implementation**

**Android SDK Demo Files (STUDY THESE FIRST)**:
- `CameraStreamDetailVM.kt` - Complete multi-camera stream management
- `CameraStreamDetailFragment.kt` - UI for camera stream control with surface management
- Key methods:
  - `putCameraStreamSurface(cameraIndex, surface, width, height, scaleType)` - Assigns surface to specific camera
  - `setCameraIndex(ComponentIndexType)` - Switches between camera sources
  - `enableStream(cameraIndex, enable)` - Controls individual camera streams

**Android Bridge** (`DJIBridgeServer.kt:742-750` + `DJIBridgeServer.kt:777-820`):
```kotlin
// ✅ Working - Real compass data collection
"compass_heading" to run {
    val compassKey = KeyTools.createKey(FlightControllerKey.KeyCompassHeading)
    val heading = keyManager.getValue(compassKey) as? Double
    heading ?: 0.0
}

// ✅ Working - Attitude data collection using same keys as HSI widget
"attitude" to run {
    val attitudeKey = KeyTools.createKey(FlightControllerKey.KeyAircraftAttitude)
    val attitude = keyManager.getValue(attitudeKey) as? Attitude
    mapOf(
        "roll" to (attitude?.roll ?: 0.0),
        "pitch" to (attitude?.pitch ?: 0.0), 
        "yaw" to (attitude?.yaw ?: 0.0)
    )
}

// ✅ Working - Obstacle avoidance using PerceptionManager with raw distance arrays
"obstacle_avoidance" to run {
    val radarDistances = cachedRadarObstacleData?.horizontalObstacleDistance
    val perceptionDistances = cachedPerceptionObstacleData?.horizontalObstacleDistance
    mapOf(
        "enabled" to true,
        "radar_distances" to radarDistances?.toList(),
        "perception_distances" to perceptionDistances?.toList()
    )
}

// 🎯 NEXT: Multi-camera stream implementation using ICameraStreamManager pattern
```

**Desktop Interface** (`App.tsx:42-49`):
```typescript
// ✅ Working - HSI compass positioning
<div className="absolute bottom-8 right-8 z-20 w-32 h-32">
  <HSICompass 
    attitude={bridgeData.telemetry?.attitude || null}
    heading={bridgeData.telemetry?.heading || 0}
    homeDirection={bridgeData.telemetry?.home_bearing}
    size="small"
  />
</div>
```

**Data Mapping** (`bridgeManager.ts:45-50`):
```typescript
// ✅ Working - Compass data mapping
const mappedTelemetry = {
    ...message,
    heading: message.compass_heading || message.heading || 0,
    compass_heading: message.compass_heading || 0,
};
```

---

## 🕒 **HOW TO REPRODUCE CURRENT STATE**

### **Quick Start Commands**
```bash
# 1. Deploy bridge to DJI controller  
./build.sh debug && ./deploy.sh debug [YOUR_DEVICE_ID]

# 2. ⚠️ CRITICAL: Re-establish port forwarding (lost after controller restart)
adb -s [YOUR_DEVICE_ID] forward tcp:8080 tcp:8080

# 3. Launch bridge on controller
adb -s [YOUR_DEVICE_ID] shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE

# 4. Start desktop interface (RECOMMENDED: browser mode for development)
cd dji-controller-interface/
npm run dev:browser  # Opens http://localhost:3000
```

### **What You Should See**
✅ **Working**: Live video from drone camera, real-time flight data, joystick values updating  
⚠️ **Partial**: HSI compass arrow pointing roughly correct direction  
❌ **Missing**: Auto-rotating minimap, full HSI attitude display

### **Key Testing Points**
- **Compass accuracy**: Arrow should track aircraft heading within ~10° (currently approximate)
- **Video quality**: 1920x1080 H.264 stream with <100ms latency
- **Data rates**: 20Hz controller + 5Hz telemetry + 1Hz battery
- **UI responsiveness**: Window resizing maintains video aspect ratio

---

## 🎯 **NEXT STEPS - PRIORITIZED ACTION PLAN**

### **Step 1: Investigate DJI Native Map Data (HIGH PRIORITY)**

**Goal**: Determine feasibility of using DJI's built-in map tiles

**Actions**:

1. **Research DJI SDK V5 MapWidget API**:
   - Look for map tile provider configuration
   - Check if DJI provides tile server endpoints
   - Investigate MapLibre/Google Maps integration points

2. **Test map data access**:
   - Try extracting tile URLs from DJI SDK
   - Test accessing DJI map servers directly
   - Compare with OpenStreetMap/MapBox alternatives

**Success Criteria**: 
- Can access same map tiles as DJI Pilot app
- No external API keys needed
- Visual consistency with official DJI interface

### **Step 2: Complete HSI Compass Functionality (MEDIUM PRIORITY)**

**Current Issue**: Arrow direction approximately correct but full HSI incomplete

**Investigation Areas**:
1. **Compass calibration**: Is our heading data properly calibrated?
2. **Attitude integration**: How to properly display roll/pitch on HSI?
3. **Visual accuracy**: Does our HSI match DJI Pilot app presentation?

**Files to Modify**:
- `HSICompass.tsx` - Fix attitude display and visual accuracy
- `DJIBridgeServer.kt` - Verify compass/attitude data accuracy
- `types.ts` - Ensure proper data structure definitions

### **Step 3: Implement Auto-Rotating Minimap (MEDIUM PRIORITY)**

**Goal**: Map rotates based on aircraft heading, aircraft always points "up"

**Implementation Approach**:
```typescript
// Counter-rotate map so aircraft points up
<div style={{ 
  transform: `rotate(${-compassHeading}deg)`,
  transformOrigin: 'center center'
}}>
  <MapContainer>
    {/* Map tiles rotate, aircraft icon stays pointing up */}
  </MapContainer>
</div>
```

**Requirements**:
- Smooth rotation interpolation (not jerky)
- Aircraft always centered and pointing up
- North indicator shows true north direction
- Compatible with chosen map tile source

---

## 🚨 **KNOWN ISSUES & WORKAROUNDS**

### **Port Forwarding Must Be Re-established After Controller Restart**
**Problem**: Connection fails after DJI controller restart  
**Root Cause**: ADB port forwarding doesn't persist across device restarts  
**Solution**: Always run `adb forward tcp:8080 tcp:8080` when troubleshooting connection issues

### **Electron vs Browser Single Client Limitation**
**Problem**: Only one client can connect to bridge at a time  
**Current Workaround**: Use browser development mode (`npm run dev:browser`) for development, Electron for production testing

### **Null Frame Handling in Browser Version**
**Problem**: Occasional crash with "Cannot read properties of null (reading 'frameNumber')"  
**Status**: Fixed in `browser.tsx` with null checks before accessing `pendingVideoFrame`

---

## 📁 **KEY FILES FOR NEXT DEVELOPER**

### **Critical Files to Understand**
```
android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/data/
├── DJIBridgeServer.kt:712-745     # Compass/attitude data collection
└── DJIBridgeActivity.kt           # Bridge startup and lifecycle

dji-controller-interface/src/
├── components/App.tsx:42-57        # HSI/minimap overlay positioning  
├── components/HSICompass.tsx       # ⚠️ Partially working compass
├── components/MapDisplay.tsx       # ❌ Needs auto-rotation
├── bridgeManager.ts:45-50          # Compass data mapping
└── types.ts:48-53                  # Compass/attitude data structures
```

### **External Resources**
```
docs/                               # This TODO.md handoff document
README.md                           # Complete setup and status documentation
test_bridge.js                      # WebSocket client for testing bridge connection
```

---

## 💡 **DEVELOPER HANDOFF NOTES**

### **If You're Coming Back to This Project**
1. **Start with**: `./README.md` for complete current status and setup instructions
2. **Focus on**: DJI native map data investigation - this is the key missing piece  
3. **Test first**: Ensure basic system still works before making changes
4. **Critical dependency**: Port forwarding must be re-established after any controller restart

### **If You're a New Developer**
1. **Read**: `./README.md` sections "Current Status" and "Getting Started"
2. **Understand**: We have a working video streaming system with partial compass integration
4. **Goal**: Auto-rotating minimap using DJI native map data, not external providers

### **Development Environment**
- **System**: macOS 14.6, Android SDK, DJI Controller, Node.js 18+
- **Languages**: Kotlin (Android bridge), TypeScript/React (desktop interface)  
- **Key Dependencies**: DJI SDK V5, Electron, WebCodecs API, Tailwind CSS
- **Test Hardware**: DJI controller with SDK V5 support

---

## 📊 **PROJECT TIMELINE & ACHIEVEMENTS**

**September 2025**: 
- ✅ Phase 1: DJI Android Bridge with real-time data streaming
- ✅ Phase 2: Desktop interface with professional DJI-style UI
- ✅ Phase 3A: Complete UI widgets and controls  
- ✅ Phase 3B: Live H.264 video streaming integration
- ✅ Phase 3C: Responsive UI with proper overlay positioning
- ⚠️ **Current**: HSI compass partially working, investigation needed for map integration

**Estimated Completion for Remaining Work**: 1-2 weeks focused development  
**Key Blocker**: Need to determine best approach for map data source (DJI native vs external)

---

**📝 Document Status**: Complete handoff documentation created  
**🕒 Last Updated**: September 6, 2025  
**📍 Current State**: Partially working HSI compass, auto-rotating minimap investigation needed  
**🎯 Next Action**: DJI SDK MapWidget API for native map data access  
**⚠️ Key Reminder**: Always re-establish port forwarding after controller restart: `adb forward tcp:8080 tcp:8080`
