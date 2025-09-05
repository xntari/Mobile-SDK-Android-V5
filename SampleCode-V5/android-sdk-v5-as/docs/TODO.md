# DJI Android Bridge + Controller Interface

## 🚀 TLDR - Quick Start (Project Scout Bot/Drone)

**What This Project Achieves:**
- **End Result**: External flight control system using natural language undestanding, dynamic waypoints, with real-time HUD, live videof for computer vision and active inference
- **DJI Android Bridge** streams live H.264 video + sensor data from DJI controller to laptop via WebSocket
- **DJI Controller Interface** is a complete desktop app replicating DJI controller UI with live video feed

> ** Just finished**: Phase 3B  COMPLETE - Live H.264 video streaming system fully working
> ** Immediate next steps**: Investigate DJI map data access, real compass/IMU integration, auto-rotating minimap  
> ** Current State**: Full end-to-end system with live video, telemetry, and responsive UI

---

## **PROJECT ARCHITECTURE OVERVIEW**

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

### **Data Flow Rates**
- **Controller input**: 20Hz (50ms intervals)
- **Telemetry data**: 5Hz (200ms intervals) 
- **Battery data**: 1Hz (1000ms intervals)
- **H.264 video**: ~30fps variable rate (~26KB per frame)
- **Total bandwidth**: ~800KB/s sustained

### **Key Technical Achievements**
1. **WebCodecs Integration** - Hardware-accelerated H.264 decoding in browser/Electron
2. **Binary WebSocket Protocol** - Efficient video frame transmission (metadata + raw H.264)
3. **Thread-safe Android Bridge** - Multiple data sources coordinated safely
4. **Responsive React UI** - Professional DJI-style interface with live data binding
5. **Cross-platform Support** - Works on macOS, Windows, Linux
---


**To Get the Full System Running Right Now:**
```bash
# 1. Deploy bridge to DJI controller
./build.sh debug && ./deploy.sh debug 4LFCL5Q005GDF5
adb -s 4LFCL5Q005GDF5 forward tcp:8080 tcp:8080  
adb -s 4LFCL5Q005GDF5 shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE

# 2. Start DJI Controller Interface with LIVE H.264 VIDEO
cd dji-controller-interface/
npm run dev:browser  # Opens http://localhost:3000 - shows LIVE VIDEO from drone camera
# OR
npm run build && npm run dev  # Desktop Electron app with live video
```

**Current state:**
- **Live H.264 video** from drone camera at 1920x1080, ~26KB/frame
- **Real-time telemetry** - GPS, altitude, attitude, speed
- **Live joystick data** - All 4 axes at 20Hz

---

## 📍 Current Status - September 2025

### ✅ **COMPLETED - WORKING END-TO-END SYSTEM**

**Phase 1: DJI Android Bridge** ✅ COMPLETE
- ✅ **Real-time data streaming** - 20Hz controller + 5Hz telemetry + 1Hz battery
- ✅ **Live H.264 video streaming** - MediaDataCenter integration with WebCodecs decoding
- ✅ **Multi-sensor data** - GPS, altitude, attitude, battery, controller input
- ✅ **Thread-safe WebSocket server** with JSON + binary protocol (metadata + H.264 frames)
- ✅ **USB connection** via ADB port forwarding (no WiFi needed)

**Phase 3A: DJI Controller Interface** ✅ COMPLETE  
- ✅ **Complete desktop interface** replicating full DJI controller UI
- ✅ **All major widgets** - TopBar, camera controls, HSI compass, mini map
- ✅ **Stable real-time updates** - All data streams update continuously
- ✅ **Professional UI** - DJI-style theming with Tailwind CSS

**Phase 3B: H.264 Video Streaming** ✅ COMPLETE
- ✅ **Android bridge video capture** - ICameraStreamManager with 1920x1080 resolution
- ✅ **WebSocket binary protocol** - Efficient metadata + H.264 frame transmission
- ✅ **WebCodecs hardware decoding** - Native browser/Electron H.264 decoding
- ✅ **Responsive video display** - Proper scaling and aspect ratio maintenance
- ✅ **Live video performance** - Smooth playback, <100ms latency

**Phase 3C: UI Polish** ✅ COMPLETE
- ✅ **Responsive layout** - Window resizing with all panels remaining visible
- ✅ **HSI compass relocation** - Moved to small bottom-right overlay (128x128px)
- ✅ **Window controls** - Proper movable/resizable Electron window
- ✅ **Aspect ratio maintenance** - Video scales properly with window size

---

## ⚡ **IMMEDIATE NEXT STEPS - Phase 4**

### **Phase 4A: Enhanced Map Integration** 🎯 **NEXT PRIORITY**

**Goal**: Investigate accessing DJI's internal map data and implement auto-rotating minimap with real compass data.

**Estimated Time**: 1-2 weeks

**Research Questions**:
1. **DJI Map Data Access**: Can we access the map tiles/data that DJI Fly app uses?
2. **Compass Integration**: How to get real magnetometer/IMU data from drone?
3. **Auto-rotating Map**: Implement heading-based map rotation

#### **Step 1: DJI Map Data Investigation** (3-4 hours)
**Files to investigate**: 
- `android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/pages/MapFragment.kt`
- Look for MapBox/MapLibre/Google Maps integration
- Check if DJI provides map data APIs

**Specific tasks**:
```bash
# Search for map-related code in DJI sample
grep -r "map\|Map\|tile" android-sdk-v5-sample/src/ --include="*.kt" --include="*.java"
grep -r "MapBox\|MapLibre\|GoogleMap" android-sdk-v5-sample/src/ --include="*.kt" --include="*.java"

# Look for location/GPS data in bridge
grep -r "location\|gps\|coordinates" android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/data/
```

#### **Step 2: Real Compass/IMU Data Collection** (2-3 hours)
**Current state**: Bridge already gets attitude data (roll, pitch, yaw), need to verify compass accuracy.

**Enhance bridge data collection**:
- Add magnetometer data if available
- Verify GPS coordinates are accurate for map positioning  
- Add home location and distance/bearing calculations

**Files to modify**:
- `DJIBridgeServer.kt` - Add magnetometer listeners
- Test compass accuracy against DJI Fly app

#### **Step 3: Auto-rotating Minimap Implementation** (4-5 hours)
**Files**: `dji-controller-interface/src/components/MapDisplay.tsx`

**Features to add**:
- Real GPS positioning using bridge coordinates
- Map rotation based on aircraft heading (attitude.yaw)
- Aircraft icon that maintains orientation
- Home location marker with distance/bearing
- Map tiles from public source (OpenStreetMap, MapBox, etc.) or DJI source

**Implementation approach**:
```typescript
// Pseudo-code for auto-rotating map
const MapDisplay = ({ aircraftLocation, heading, homeLocation }) => {
  return (
    <div style={{ 
      transform: `rotate(${-heading}deg)`, // Rotate map opposite to heading
      transformOrigin: 'center'
    }}>
      <MapContainer center={aircraftLocation}>
        <AircraftMarker position={aircraftLocation} />
        <HomeMarker position={homeLocation} />
      </MapContainer>
    </div>
  );
};
```

#### **Step 4: Map Data Source Integration** (3-4 hours)
**Options to investigate**:
1. **DJI's map source** (preferred) - Research if accessible
2. **OpenStreetMap** - Free, good coverage
3. **MapBox** - Professional, requires API key
4. **Google Maps** - Requires API key, licensing

**Integration priorities**:
1. Try to reverse-engineer DJI's map data source
2. Fallback to OpenStreetMap for offline capability
3. Add ability to switch between map sources

---

### **Phase 4B: Bidirectional Flight Control** (Secondary Priority)

**Goal**: Enable laptop → drone control (joystick override, flight commands)

**Estimated Time**: 4-5 hours

**Tasks**:
1. **Add bridge command handling** - Extend WebSocket to accept commands from laptop
2. **Implement virtual stick override** - Allow laptop to control drone movement
3. **Flight mode commands** - Takeoff, land, return home from interface
4. **Safety mechanisms** - Emergency stop, control timeout, manual override

**Files to modify**:
- `DJIBridgeServer.kt` - Add command reception and virtual stick control
- `dji-controller-interface/src/hooks/useBridgeCommands.ts` - Command sending
- UI components for manual flight control


---

## 📁 **KEY FILES AND LOCATIONS**

### **Android Bridge (Kotlin)**
```
android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/
├── DJIBridgeActivity.kt          # Main bridge activity
├── data/DJIBridgeServer.kt       # WebSocket server + H.264 streaming
└── data/                         # Data collection and management
```

### **Desktop Interface (Electron + React)**
```
dji-controller-interface/
├── src/components/
│   ├── App.tsx                   # Main application layout
│   ├── FPVDisplay.tsx           # H.264 video display with WebCodecs
│   ├── TopBar.tsx               # Flight status and controls
│   ├── HSICompass.tsx           # Small compass overlay (bottom-right)
│   ├── MapDisplay.tsx           # Mini map (NEXT: auto-rotating)
│   └── ...                      # Other DJI widgets
├── src/hooks/
│   ├── useStableBridgeData.ts   # Singleton data management
│   └── useBridgeCommands.ts     # Command sending (for future use)
├── src/main.ts                  # Electron main process
├── src/preload.ts               # IPC bridge
├── src/browser.tsx              # Browser development mode
└── package.json                 # Dependencies and scripts
```

### **Development Tools**
```
├── build.sh / deploy.sh         # Android build and deployment
├── test_bridge.js               # WebSocket client for testing
├── docs/TODO.md                 # This handoff document
└── README.md                    # Complete setup documentation
```

---

## 🚨 **TROUBLESHOOTING COMMON ISSUES**

### **H.264 Video Not Displaying**
**Symptoms**: Interface shows "Receiving H.264 Stream" but no video

**Solutions**:
1. **Check camera activation**: Ensure camera is recording/active on DJI controller
2. **Browser compatibility**: Use Chrome 94+, Edge 94+, or Firefox 90+ for WebCodecs
3. **Check bridge logs**: 
   ```bash
   adb -s 4LFCL5Q005GDF5 logcat | grep "VIDEO_STREAM\|DJIBridge"
   ```
4. **Verify H.264 frames**: Should see "📹 Video frame: XXXX bytes" in interface

### **Bridge Connection Issues**
**Problem**: Interface shows "Connecting..." or "Connection Error"

**Solutions**:
```bash
# 1. Verify bridge is running and port is open
adb -s 4LFCL5Q005GDF5 shell netstat -ln | grep 8080  # Should show LISTEN

# 2. Check port forwarding
adb forward tcp:8080 tcp:8080
adb forward --list  # Should show tcp:8080 forwarding

# 3. Test direct connection
node test_bridge.js localhost  # Should show live data

# 4. Restart bridge if needed
adb -s 4LFCL5Q005GDF5 shell am force-stop dji.sampleV5.aircraft
adb -s 4LFCL5Q005GDF5 shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE
```

### **Performance Issues**
**Problem**: Video stuttering or high CPU usage

**Solutions**:
1. **Use Electron mode**: `npm run dev` instead of browser mode for better performance
2. **Check video decoder**: Should use hardware acceleration (check DevTools Performance tab)
3. **Monitor bandwidth**: ~800KB/s is normal; higher suggests issues
4. **Close other apps**: H.264 decoding is CPU/GPU intensive

### **Window Resizing Issues**
**Problem**: UI elements cut off when window is small

**Fixed in Phase 3C**: Window now properly resizes with responsive breakpoints:
- Left panel: 96px (small) → 128px (large screens)
- Right panel: 256px (medium) → 320px (large screens) 
- Minimum window size: 800x600

---

## 🎯 **SUCCESS CRITERIA FOR PHASE 4A**

### **Map Integration Goals**
1. **Real GPS positioning** - Aircraft icon moves based on actual GPS coordinates
2. **Auto-rotating map** - Map rotates based on aircraft heading for intuitive navigation
3. **Accurate compass** - HSI compass matches real magnetometer data
4. **Map data source** - Either DJI's tiles or reliable alternative (OpenStreetMap/MapBox)
5. **Home location tracking** - Distance and bearing from takeoff point

### **Technical Specifications**
- Map update rate: 5Hz (matching telemetry data)
- Map rotation: Smooth interpolation, not jerky
- GPS accuracy: Within 3-5 meters of DJI Fly app
- Compass accuracy: Within 2-3 degrees of DJI Fly app
- Performance: <5% CPU overhead for map rendering

### **User Experience**
- Aircraft always centered on mini map
- Map oriented so "up" is forward direction of aircraft
- Clear visual distinction between aircraft icon and home marker
- Zoom level adjusts automatically based on distance from home

---

**📝 Project Status**: Phase 3B ✅ Complete - Full H.264 video streaming system working  
**🕒 Last Updated**: September 5, 2025  
**🔧 Development Environment**: Live video + telemetry + responsive UI all functional  
**📊 Test Status**: End-to-end system validated - laptop displays live drone camera feed  
**🚀 Latest Achievement**: Complete working system with H.264 video streaming at 1920x1080

**🔥 IMMEDIATE ACTION**: Start Phase 4A map investigation - this is the next big enhancement that will make the system truly professional.
