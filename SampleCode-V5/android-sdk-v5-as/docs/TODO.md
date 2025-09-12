# DJI Android Bridge + Controller Interface - HANDOFF DOCUMENT

## 🚀 TLDR - You Are Here

**CURRENT STATE**: **✅ COMPLETE DUAL CAMERA SYSTEM + GIMBAL CONTROL + LASER RF + THERMAL, ZOOM** - Advanced HSI compass + auto-rotating minimap + dual camera streaming (FPV + H20N) + tap-to-gimbal targeting all working perfectly.

**IMMEDIATE NEXT STEPS:**
1. **✅ COMPLETED: Gimbal Control Implementation** - Full tap-to-target functionality using DJI SDK "KeyTapZoomAtTarget" API
2. **✅ COMPLETED: Bidirectional Bridge Communication** - Client-to-controller command sending for gimbal control fully working
3. **📷 MEDIUM: Camera Controls** - Zoom, focus, recording controls for both cameras
4. **🔧 MEDIUM: Complete flight controls** - Take off, RTH, flight mode switching  
5. **🗺️ LOW: Investigate DJI native map tiles** - Replace OpenStreetMap with DJI's official tiles

**CONTEXT**: Live H.264 dual camera streaming + telemetry + **complete navigation system** + **gimbal tap-to-target control** all working perfectly.

---

## 📍 **CURRENT STATUS - FULLY WORKING DUAL CAMERA SYSTEM**

### ✅ **What Works Perfectly**
- **✅ DUAL H.264 video streams** - FPV camera + H20N/Secondary camera at 1920x1080 resolution
- **✅ Camera stream separation** - Independent decoders with proper `camera_source` routing prevent frame mixing
- **✅ Real-time camera toggle** - Switch between FPV and H20N camera views instantly via UI buttons
- **✅ Real-time telemetry data** - GPS, altitude, speed, distance to home, battery
- **✅ Live joystick data** - All 4 axes streaming at 20Hz from controller
- **✅ Professional desktop interface** - Electron app with DJI-style UI
- **✅ Responsive window behavior** - Resizable with proper aspect ratios
- **✅ HSI Compass with 360° obstacle visualization** - Advanced version with raw perception data toggle, scale slider, logarithmic scaling
- **✅ Auto-rotating minimap** - Map rotates based on aircraft heading, aircraft always points "up"
- **✅ Real compass data collection** - `FlightControllerKey.KeyCompassHeading` successfully integrated
- **✅ Obstacle avoidance data** - Raw distance arrays from radar and perception sensors

### 🎯 **Ready for Implementation**
- **✅ COMPLETED: Multi-camera streaming architecture** - Dual camera streaming working with proper stream separation
- **✅ COMPLETED: Dual video stream support** - FPV + secondary camera (H20N) with metadata routing implemented
- **✅ COMPLETED: Stream separation** - Independent decoders prevent frame mixing
- **✅ COMPLETED: Backwards compatibility** - System functions normally with FPV-only when secondary camera absent

### 📋 **Next Development Focus: Gimbal Control**
- **Investigate controller override capabilities** - Determine if bridge can override physical gimbal controls

---

## 🎯 **IMMEDIATE IMPLEMENTATION PRIORITY**

### **✅ COMPLETED: Task 1**: Multi-Video Stream Implementation 

**✅ COMPLETED Goal**: Implement dual camera streaming architecture to support FPV + secondary camera (gimbal/H20N) without frame mixing.

**✅ Implementation Results**:
1. **✅ Modified DJIBridgeServer.kt** with dual video frame callbacks supporting:
   - FPV stream: `ComponentIndexType.FPV`  
   - Secondary stream: `ComponentIndexType.LEFT_OR_MAIN` (H20N)
2. **✅ Added metadata routing** - `camera_source` field in video frame packets
3. **✅ Client-side stream separation** - Independent decoders process streams based on metadata
4. **✅ Backwards compatibility** - System functions normally with FPV-only when secondary absent
5. **✅ Real-time camera toggle** - UI controls to switch between FPV and H20N views

### **🎯 NEW Task 1**: Gimbal Control Research and Implementation (HIGH PRIORITY)

**✅ RESEARCH COMPLETED**: DEV has completed comprehensive gimbal API research documented in `docs/GIMBAL.md`

**MANAGER VERIFICATION STATUS**: ✅ **VERIFIED** - DEV's research is accurate with minor corrections needed

**Implementation Plan**: **TAP-TO-GIMBAL FUNCTIONALITY** using DJI's TapZoom API (safer than full Look At implementation)

---

## 🔧 **VERIFIED IMPLEMENTATION PLAN - DEV CANNOT PROCEED WITHOUT MANAGER APPROVAL**

### **CRITICAL CORRECTION TO DEV'S PLAN**
**❌ DEV ERROR**: DEV suggested using `FlightControllerKey.KeyLookAt` but this requires GPS coordinates
**✅ CORRECTED APPROACH**: Use `CameraKey.KeyTapZoomAtTarget` which works with screen coordinates (0.0-1.0)

**Source Evidence** (`LookAtVM.kt:64-70`):
```kotlin
// DEV's research found this - CORRECT API to use
CameraKey.KeyTapZoomAtTarget.createCamera(currentComponentIndexType.value!!, CameraLensType.CAMERA_LENS_ZOOM)
    .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), { success }, { error })
```

### **PHASE 1: MINIMAL TAP-TO-GIMBAL IMPLEMENTATION (MANAGER SUPERVISED)**

**IMPORTANT**: DEV cannot proceed to next step without Manager verification of previous step

#### **✅ Step 1.1: Add Required Imports (MANAGER PRE-APPROVED)**
**Risk Level**: ✅ **ZERO** - imports don't execute code
**File**: `DJIBridgeServer.kt` (top of file)
**Change**: Add these imports after line 38:

```kotlin
// Add these imports - EXACT LINES DEV MUST USE
import dji.sdk.keyvalue.key.CameraKey
import dji.sdk.keyvalue.value.camera.TapZoomMode  
import dji.sdk.keyvalue.value.camera.ZoomTargetPointInfo
import dji.sdk.keyvalue.value.common.CameraLensType
import dji.v5.et.createCamera
import dji.v5.et.action
```

**Verification**: Project compiles successfully, no behavior changes

#### **❌ Step 1.2: Add Message Type (PENDING MANAGER APPROVAL)**
**DEV MUST WAIT**: Cannot proceed until Step 1.1 verified by Manager
**File**: `DJIBridgeServer.kt` - MessageType enum (line ~79)
**Change**: Add to enum:

```kotlin
GIMBAL_TAP_TARGET("gimbal_tap_target"),  // CORRECTED name from DEV's plan
```

**Manager Verification Required**: Enum compiles, existing messages unchanged

#### **❌ Step 1.3: Add Message Routing (PENDING MANAGER APPROVAL)**  
**DEV MUST WAIT**: Cannot proceed until Step 1.2 verified by Manager
**File**: `DJIBridgeServer.kt` - handleIncomingCommand method (line ~507)
**Change**: Add to switch statement:

```kotlin
MessageType.GIMBAL_TAP_TARGET -> handleGimbalTapTarget(clientId, json)
```

**Manager Verification Required**: Log appears when message sent, no functional changes yet

#### **❌ Step 1.4: Add Handler Method (PENDING MANAGER APPROVAL)**
**DEV MUST WAIT**: Cannot proceed until Step 1.3 verified by Manager
**Critical Implementation**: Use CORRECTED API (not DEV's original suggestion)

```kotlin
// CORRECTED VERSION - DEV must use THIS implementation
private fun handleGimbalTapTarget(clientId: String, command: JSONObject) {
    try {
        Log.i(TAG, "Processing gimbal tap for client: $clientId")
        
        val data = command.getJSONObject("data")  // REQUIRED: get data object
        val x = data.getDouble("x")  // 0.0 to 1.0
        val y = data.getDouble("y")  // 0.0 to 1.0
        
        // Validate coordinates
        if (x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0) {
            Log.e(TAG, "Invalid coordinates for client $clientId: x=$x, y=$y")
            return
        }
        
        val cameraIndex = ComponentIndexType.LEFT_OR_MAIN  // H20N camera
        
        // Use CORRECTED API (not Look At)
        CameraKey.KeyTapZoomAtTarget.createCamera(cameraIndex, CameraLensType.CAMERA_LENS_ZOOM)
            .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), {
                Log.i(TAG, "Gimbal tap success for client $clientId at ($x, $y)")
            }, { error ->
                Log.e(TAG, "Gimbal tap error for client $clientId: $error")
            })
            
    } catch (e: Exception) {
        Log.e(TAG, "Exception in handleGimbalTapTarget: ${e.message}", e)
    }
}
```

**Manager Verification Required**: Method executes, gimbal moves when camera available

### **MANAGER VERIFICATION CHECKLIST**

#### **✅ After Step 1.1 (Manager must verify)**:
- [ ] Project compiles without errors  
- [ ] Bridge server starts normally
- [ ] All existing functionality works (video, telemetry, etc.)

#### **❌ After Step 1.2 (BLOCKED until Step 1.1 verified)**:
- [ ] Bridge starts with new message type
- [ ] Existing message handling works normally
- [ ] No new functionality activated yet

#### **❌ After Step 1.3 (BLOCKED until Step 1.2 verified)**:
- [ ] Send test message → routing executes (even if handler missing)
- [ ] No crashes or errors from message routing
- [ ] Existing video streaming unaffected  

#### **❌ After Step 1.4 (BLOCKED until Step 1.3 verified)**:
- [ ] Handler method executes when message received
- [ ] Invalid coordinates rejected (test with x=2.0)
- [ ] Valid coordinates processed (test with x=0.5, y=0.5)
- [ ] Gimbal movement observed if H20N connected
- [ ] No errors in existing bridge functionality

### **ROLLBACK PROCEDURES**
**Every step is reversible**:
- **Step 1.1**: Remove 6 import lines
- **Step 1.2**: Remove 1 enum entry  
- **Step 1.3**: Remove routing case
- **Step 1.4**: Remove handler method

---

## 📋 **DEV ACCOUNTABILITY REQUIREMENTS**

### **Before Each Step**:
1. **DEV MUST**: Send exact file changes to Manager for approval
2. **MANAGER MUST**: Test and verify before approval
3. **DEV CANNOT**: Proceed without explicit Manager approval
4. **BUILD REQUIREMENT**: Every step MUST compile and maintain existing functionality

### **After Each Step**:  
1. **DEV MUST**: Run bridge and verify existing functionality works
2. **DEV MUST**: Document any unexpected behavior immediately
3. **MANAGER MUST**: Test step independently before approving next step

### **Strict Rules**:
- **NO SHORTCUTS**: Each step must be individually verified
- **NO BATCHING**: Cannot combine steps even if "simple"
- **IMMEDIATE ROLLBACK**: Any step that breaks existing functionality must be reverted
- **PROOF REQUIRED**: DEV must provide evidence (logs/screenshots) of successful step

---

## 📞 **DEV-MANAGER COMMUNICATION PROTOCOLS**

### **Communication Method**: TMux Sessions
**CRITICAL**: DEV and MANAGER communicate via tmux to prevent concurrent file editing conflicts.

#### **TMux Session Structure**:
- **DEV Session**: `xandroid:DEV` - DEV's working environment
- **MANAGER Session**: `xandroid:MANAGER` - MANAGER's oversight environment

#### **Communication Commands**:

**MANAGER to DEV**:
```bash
tmux send-keys -t xandroid:DEV "MANAGER: {message}" && sleep 0.1 && tmux send-keys -t xandroid:DEV Enter
```

**DEV to MANAGER**:
```bash
tmux send-keys -t xandroid:MANAGER "DEV: {message}" && sleep 0.1 && tmux send-keys -t xandroid:MANAGER Enter
```

**Check DEV's activity**:
```bash
tmux capture-pane -t xandroid:DEV -p
```

#### **Working Rules**:
1. **NO CONCURRENT EDITING** - Only one person works on files at a time
2. **MANAGER OVERSIGHT** - All DEV steps require Manager approval
3. **CLEAR HANDOFFS** - DEV must report completion before Manager takes over
4. **DOCUMENTED COMMUNICATION** - All major decisions logged in TODO.md

### **Current Session Status**: ✅ Steps 1.1, 1.2, 1.3 COMPLETED. DEV verifying Step 1.3, awaiting approval for final Step 1.4 (handler method).

#### **COMMUNICATION REMINDER**: 
- **ALWAYS use tmux**: `tmux capture-pane -t xandroid:DEV -p` to check DEV's status
- **ALWAYS communicate via tmux**: `tmux send-keys -t xandroid:DEV "MANAGER: message" && sleep 0.1 && tmux send-keys -t xandroid:DEV Enter`
- **DEV responds via tmux**: `tmux send-keys -t xandroid:MANAGER "DEV: message" && sleep 0.1 && tmux send-keys -t xandroid:MANAGER Enter`

#### **CORRECT BUILD PROCESS** (Reference for DEV):
```bash
# 1. Navigate to project directory
cd /Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-as

# 2. Clean build cache (if errors occur)
./gradlew clean

# 3. Build using documented approach  
./build.sh debug

# 4. Deploy to device
./deploy.sh debug [YOUR_DEVICE_ID]

# 5. Set up port forwarding
adb -s [YOUR_DEVICE_ID] forward tcp:8080 tcp:8080

# 6. Launch bridge
adb -s [YOUR_DEVICE_ID] shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE

# 7. Start interface (IMPORTANT: correct directory)
cd dji-controller-interface/
npm run dev:browser  # Opens http://localhost:3000
```

---

## 🧪 **TESTING STRATEGY**

### **Step 1.4 Testing Protocol**:

**Test 1: Invalid Coordinates**
```javascript  
// Send via browser console or test client
websocket.send(JSON.stringify({
    type: 'gimbal_tap_target',
    data: { x: 2.0, y: 0.5 }  // Invalid - should be rejected
}));
```
**Expected**: Error log, no gimbal movement

**Test 2: Valid Center Point**
```javascript
websocket.send(JSON.stringify({
    type: 'gimbal_tap_target', 
    data: { x: 0.5, y: 0.5 }  // Center screen - should work
}));
```
**Expected**: Success log, gimbal points to center if camera available

**Test 3: Corner Points**
```javascript
websocket.send(JSON.stringify({
    type: 'gimbal_tap_target',
    data: { x: 0.0, y: 0.0 }  // Top-left corner
}));
```
**Expected**: Success log, gimbal points to corner if camera available

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
