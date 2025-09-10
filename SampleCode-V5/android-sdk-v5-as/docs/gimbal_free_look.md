# DJI Gimbal Free Look Implementation Guide

## 🚀 TL;DR

This guide documents the current DJI SDK V5 gimbal control system and provides implementation details for the **Free Look** and **Enhanced Look At** features. The system consists of an Android bridge running DJI SDK V5, a bidirectional WebSocket protocol, and an Electron-based desktop interface.

**Current Status:**
- ✅ **Basic tap-to-target working** - Click video → gimbal moves toward clicked point
- 🎯 **Next: Free Look** - Right-click drag to control gimbal like a mouse  
- 🎯 **Next: Enhanced Look At** - Shift+click to precisely center crosshair on clicked point
- ✅ **All infrastructure ready** - WebSocket protocol, gimbal APIs, client interface established

---

## 📋 Current System Overview

### Architecture
```
┌─────────────────┐    USB/ADB        ┌──────────────────┐    Electron IPC     ┌─────────────────┐
│  DJI Controller │◄─────────────────►│ Electron Main    │◄───────────────────►│ React Interface │
│   (Android)     │  WebSocket:8080   │   Process        │   Video + Data      │   (Desktop UI)  │
│                 │  JSON + H.264     │                  │                     │                 │
│ ┌─────────────┐ │                   │ ┌──────────────┐ │                     │ ┌─────────────┐ │
│ │DJI SDK V5   │ │                   │ │ WebSocket    │ │                     │ │ Live Video  │ │
│ │Bridge Server│ │                   │ │ Client       │ │                     │ │ 1920x1080   │ │
│ │:8080        │ │                   │ │              │ │                     │ │ WebCodecs   │ │
│ │             │ │                   │ └──────────────┘ │                     │ └─────────────┘ │
│ │ ┌─────────┐ │ │                   │                  │                     │                 │
│ │ │Gimbal   │ │ │                   │ ┌──────────────┐ │                     │ ┌─────────────┐ │
│ │ │Control  │ │ │                   │ │ Video Frame  │ │                     │ │ Gimbal      │ │
│ │ │APIs     │ │ │                   │ │ Handler      │ │                     │ │ Controls    │ │
│ │ └─────────┘ │ │                   │ └──────────────┘ │                     │ └─────────────┘ │
│ └─────────────┘ │                   │                  │                     │                 │
└─────────────────┘                   └──────────────────┘                     └─────────────────┘
```

### Key Components
1. **Android Bridge** - DJI SDK V5 integration with WebSocket server
2. **WebSocket Protocol** - Bidirectional JSON + binary communication  
3. **Desktop Interface** - Electron app with React UI for video and controls
4. **Gimbal Control** - Real-time gimbal movement via DJI APIs

---

## 🔧 DJI SDK V5 Gimbal Control

### Available APIs

The DJI SDK V5 provides comprehensive gimbal control through these key APIs:

#### Core Gimbal Control
```kotlin
// Speed-based rotation (for free look)
GimbalKey.KeyRotateBySpeed.create(ComponentIndexType.LEFT_OR_MAIN)
    .action(GimbalSpeedRotation(pitch, yaw, roll, CtrlInfo()))

// Absolute angle positioning (for precise look at)  
GimbalKey.KeyGimbalAngleRotation.create(ComponentIndexType.LEFT_OR_MAIN)
    .action(GimbalAngleRotation(pitch, yaw, roll, mode, duration))

// Current gimbal attitude reading
GimbalKey.KeyGimbalAttitude.create(ComponentIndexType.LEFT_OR_MAIN)
    .get { attitude -> /* pitch, yaw, roll values */ }

// Tap-to-target (current implementation)
CameraKey.KeyTapZoomAtTarget.createCamera(ComponentIndexType.LEFT_OR_MAIN, CameraLensType.CAMERA_LENS_ZOOM)
    .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN))
```

#### Camera Component Types
- `ComponentIndexType.FPV` - FPV camera (front-facing)
- `ComponentIndexType.LEFT_OR_MAIN` - H20N gimbal camera (primary)
- `ComponentIndexType.RIGHT` - Right camera (if available)
- `ComponentIndexType.UP` - Up camera (if available)

#### Key File Locations
- **Primary gimbal implementation**: `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/data/DJIBridgeServer.kt:600-627`
- **Reference implementation**: `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/LookAtVM.kt:64-70`

---

## 🌉 Android Bridge System

### WebSocket Protocol

The bridge runs a WebSocket server on port 8080 that handles bidirectional communication:

#### Current Message Types (Inbound Commands)
```kotlin
enum class MessageType(val value: String) {
    // Existing gimbal command
    GIMBAL_TAP_TARGET("gimbal_tap_target"),
    GIMBAL_RESPONSE("gimbal_response"),
    
    // Required for Free Look implementation
    GIMBAL_FREE_LOOK("gimbal_free_look"),      // NEW - drag-based control
    GIMBAL_ENHANCED_LOOK_AT("gimbal_enhanced_look_at"), // NEW - precise centering
    
    // Other existing types...
    CONTROLLER_DATA("controller_data"),
    SENSOR_DATA("sensor_data"),
    TELEMETRY_DATA("telemetry_data"),
    VIDEO_FRAME("video_frame")
}
```

#### Current Gimbal Handler Implementation
```kotlin
// File: DJIBridgeServer.kt:600-627
private fun handleGimbalTapTarget(clientId: String, json: JSONObject) {
    try {
        val data = json.getJSONObject("data")
        val x = data.getDouble("x")
        val y = data.getDouble("y")
        
        Log.i(TAG, "Processing gimbal tap for client $clientId at ($x, $y)")
        
        val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
        
        CameraKey.KeyTapZoomAtTarget.createCamera(cameraIndex, CameraLensType.CAMERA_LENS_ZOOM)
            .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), {
                Log.i(TAG, "Gimbal tap success for client $clientId")
                sendGimbalResponse(clientId, true, "Gimbal moved successfully")
            }, { error ->
                Log.e(TAG, "Gimbal tap error for client $clientId: $error")
                sendGimbalResponse(clientId, false, error.toString())
            })
            
    } catch (e: Exception) {
        Log.e(TAG, "Exception in handleGimbalTapTarget: ${e.message}", e)
        sendGimbalResponse(clientId, false, e.message ?: "Unknown error")
    }
}
```

### Building and Deployment

#### Build Process
```bash
# Navigate to Android project
cd /Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-as

# Build debug APK
./build.sh debug

# Deploy to DJI controller (replace with your device ID)
./deploy.sh debug [YOUR_DEVICE_ID]

# Set up ADB port forwarding (CRITICAL - must do after every controller restart)
adb -s [YOUR_DEVICE_ID] forward tcp:8080 tcp:8080

# Launch bridge on controller
adb -s [YOUR_DEVICE_ID] shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE
```

#### Port Forwarding
**CRITICAL**: ADB port forwarding must be re-established after every DJI controller restart:
```bash
adb -s [YOUR_DEVICE_ID] forward tcp:8080 tcp:8080
```

### Required Imports for Gimbal Control
```kotlin
// Add to DJIBridgeServer.kt imports
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.value.gimbal.GimbalSpeedRotation
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotation  
import dji.sdk.keyvalue.value.gimbal.GimbalAngleRotationMode
import dji.sdk.keyvalue.value.gimbal.CtrlInfo
import dji.v5.et.create
import dji.v5.et.action
import dji.v5.et.get
```

---

## 🖥️ Desktop Client System

### Technology Stack
- **Electron** - Desktop app framework
- **React + TypeScript** - UI framework
- **WebCodecs API** - H.264 video decoding
- **WebSockets** - Real-time communication with Android bridge
- **Tailwind CSS** - Styling

### Project Structure
```
dji-controller-interface/
├── src/
│   ├── components/
│   │   ├── App.tsx                 # Main application component
│   │   ├── H20NDisplay.tsx         # Secondary camera display with gimbal control
│   │   ├── FPVDisplay.tsx          # Primary camera display
│   │   └── CameraDisplay.tsx       # Shared camera display component
│   ├── types.ts                    # TypeScript type definitions
│   ├── bridgeManager.ts            # WebSocket communication manager
│   └── main.ts                     # Electron main process
├── electron/
│   └── main.js                     # Electron setup and IPC handlers
└── package.json                    # Dependencies and scripts
```

### Running the Client
```bash
# Navigate to client directory
cd /Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-as/dji-controller-interface

# Install dependencies (if not done)
npm install

# Start development server (browser mode - recommended for development)
npm run dev:browser  # Opens http://localhost:3000

# Alternative: Start Electron app
npm run dev
```

---

## 🎯 H20N Display Component Implementation

### Current Gimbal Control Implementation

The H20NDisplay component already implements basic gimbal control:

#### Key Features (File: `H20NDisplay.tsx:41-115`)
```tsx
// Canvas click handler for tap-to-target
const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    
    // Calculate normalized coordinates (0.0-1.0)
    const x = (clickX - effectiveDisplayRect.left) / effectiveDisplayRect.width;
    const y = (clickY - effectiveDisplayRect.top) / effectiveDisplayRect.height;
    
    // Send gimbal command via electronAPI
    if ((window as any).electronAPI) {
        (window as any).electronAPI.sendBridgeCommand({
            type: 'gimbal_tap_target',
            data: { x, y }
        });
    }
};
```

#### Visual Feedback System
```tsx
// Click indicators with status tracking
interface ClickIndicator {
    id: string;
    x: number;
    y: number;
    status: 'pending' | 'success' | 'error';
    timestamp: number;
    message?: string;
}

// Rendered as crosshair overlays with color-coded status
{clickIndicators.map((indicator) => (
    <div className={`
        w-8 h-8 border-2 rounded-full
        ${indicator.status === 'pending' ? 'border-yellow-500 animate-pulse' : ''}
        ${indicator.status === 'success' ? 'border-green-500' : ''}
        ${indicator.status === 'error' ? 'border-red-500' : ''}
    `}>
        <div className="w-1 h-1 bg-current rounded-full"></div>
    </div>
))}
```

#### Response Handling
```tsx
// Bridge response listener (H20NDisplay.tsx:149-201)
useEffect(() => {
    const handleGimbalResponse = (responseData: any) => {
        if (responseData.type === 'gimbal_response') {
            const { success, message } = responseData.data;
            
            // Update click indicators to show success/error
            setClickIndicators(prev => {
                // Find last pending indicator and update status
                const updated = [...prev];
                for (let i = updated.length - 1; i >= 0; i--) {
                    if (updated[i].status === 'pending') {
                        updated[i] = {
                            ...updated[i],
                            status: success ? 'success' : 'error',
                            message: message
                        };
                        break;
                    }
                }
                return updated;
            });
        }
    };
    
    if ((window as any).electronAPI?.onBridgeMessage) {
        (window as any).electronAPI.onBridgeMessage(handleGimbalResponse);
    }
}, []);
```

---

## 🎮 Free Look Implementation Plan

### Feature Requirements

**Free Look** allows mouse drag control of the gimbal:
1. **Right-click + drag** on video canvas controls gimbal movement
2. **Mouse sensitivity** configurable for precise control
3. **Smooth movement** using speed-based gimbal control
4. **Visual feedback** showing drag operation
5. **No interference** with existing tap-to-target functionality

### Android Bridge Implementation

#### New Message Handler
```kotlin
// Add to DJIBridgeServer.kt
private fun handleGimbalFreeLook(clientId: String, json: JSONObject) {
    try {
        val data = json.getJSONObject("data")
        val deltaX = data.getDouble("deltaX")  // Mouse movement delta
        val deltaY = data.getDouble("deltaY")  // Mouse movement delta
        val sensitivity = data.optDouble("sensitivity", 1.0)
        
        Log.i(TAG, "Free look: deltaX=$deltaX, deltaY=$deltaY, sensitivity=$sensitivity")
        
        // Convert mouse deltas to gimbal velocities
        val yawVelocity = deltaX * sensitivity * 10.0   // Horizontal mouse -> yaw
        val pitchVelocity = -deltaY * sensitivity * 10.0 // Vertical mouse -> pitch (inverted)
        
        // Clamp velocities to safe range
        val clampedYaw = yawVelocity.coerceIn(-30.0, 30.0)
        val clampedPitch = pitchVelocity.coerceIn(-30.0, 30.0)
        
        val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
        val speedRotation = GimbalSpeedRotation().apply {
            pitchAngularVelocity = clampedPitch
            yawAngularVelocity = clampedYaw
            rollAngularVelocity = 0.0
        }
        
        GimbalKey.KeyRotateBySpeed.create(cameraIndex).action(speedRotation, {
            // Success - no response needed for smooth operation
        }, { error ->
            Log.e(TAG, "Free look error: $error")
        })
        
    } catch (e: Exception) {
        Log.e(TAG, "Exception in handleGimbalFreeLook: ${e.message}", e)
    }
}

// Add to message routing
MessageType.GIMBAL_FREE_LOOK -> handleGimbalFreeLook(clientId, json)
```

### Client Implementation

#### Mouse Event Handling
```tsx
// Add to H20NDisplay.tsx
const [isFreeLooking, setIsFreeLooking] = useState(false);
const [lastMousePos, setLastMousePos] = useState<{ x: number; y: number } | null>(null);
const [sensitivity, setSensitivity] = useState(1.0);

const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button === 2) { // Right mouse button
        event.preventDefault();
        setIsFreeLooking(true);
        setLastMousePos({ x: event.clientX, y: event.clientY });
        
        // Visual feedback - change cursor
        event.currentTarget.style.cursor = 'grabbing';
    }
};

const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isFreeLooking && lastMousePos) {
        const deltaX = event.clientX - lastMousePos.x;
        const deltaY = event.clientY - lastMousePos.y;
        
        // Send free look command
        if ((window as any).electronAPI) {
            (window as any).electronAPI.sendBridgeCommand({
                type: 'gimbal_free_look',
                data: { deltaX, deltaY, sensitivity }
            });
        }
        
        setLastMousePos({ x: event.clientX, y: event.clientY });
    }
};

const handleMouseUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button === 2 && isFreeLooking) {
        setIsFreeLooking(false);
        setLastMousePos(null);
        event.currentTarget.style.cursor = 'crosshair';
        
        // Stop gimbal movement
        if ((window as any).electronAPI) {
            (window as any).electronAPI.sendBridgeCommand({
                type: 'gimbal_free_look',
                data: { deltaX: 0, deltaY: 0, sensitivity }
            });
        }
    }
};

// Update canvas event handlers
<canvas
    ref={canvasRef}
    onClick={handleCanvasClick}
    onMouseDown={handleMouseDown}
    onMouseMove={handleMouseMove}
    onMouseUp={handleMouseUp}
    onContextMenu={(e) => e.preventDefault()} // Disable right-click menu
    className="w-full h-full object-contain"
    style={{ cursor: isFreeLooking ? 'grabbing' : 'crosshair' }}
/>
```

#### Visual Feedback for Free Look
```tsx
// Add visual indicator during free look operation
{isFreeLooking && (
    <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
            <div className="w-12 h-12 border-4 border-blue-500 rounded-full animate-pulse">
                <div className="w-2 h-2 bg-blue-500 rounded-full absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2"></div>
            </div>
        </div>
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-blue-900 text-blue-100 px-3 py-1 rounded text-sm">
            🎮 Free Look Active
        </div>
    </div>
)}
```

---

## 🎯 Enhanced Look At Implementation Plan

### Feature Requirements

**Enhanced Look At** provides precise gimbal centering:
1. **Shift + click** on video point moves gimbal to center crosshair exactly on clicked point
2. **Single operation** - no multi-click requirement like current system
3. **Crosshair-based targeting** - move point TO crosshair instead of moving gimbal TO point
4. **Mathematical precision** using camera FOV calculations

### Implementation Strategy

#### Screen-to-Angle Conversion
```kotlin
// Add to DJIBridgeServer.kt
private fun calculateGimbalAnglesForPoint(screenX: Double, screenY: Double): Pair<Double, Double> {
    // H20N camera field of view (approximate values)
    val horizontalFOV = 84.0  // degrees
    val verticalFOV = 47.0    // degrees
    
    // Calculate offset from screen center (0.5, 0.5)
    val xOffset = screenX - 0.5  // -0.5 to +0.5
    val yOffset = screenY - 0.5  // -0.5 to +0.5
    
    // Convert to angular offsets
    val yawOffset = xOffset * horizontalFOV
    val pitchOffset = yOffset * verticalFOV
    
    return Pair(pitchOffset, yawOffset)
}

private fun handleGimbalEnhancedLookAt(clientId: String, json: JSONObject) {
    try {
        val data = json.getJSONObject("data")
        val x = data.getDouble("x")
        val y = data.getDouble("y")
        
        Log.i(TAG, "Enhanced look at: ($x, $y)")
        
        // Get current gimbal attitude
        GimbalKey.KeyGimbalAttitude.create(ComponentIndexType.LEFT_OR_MAIN).get { currentAttitude ->
            if (currentAttitude != null) {
                // Calculate required angle offsets
                val (pitchOffset, yawOffset) = calculateGimbalAnglesForPoint(x, y)
                
                // Calculate target angles
                val targetPitch = currentAttitude.pitch + pitchOffset
                val targetYaw = currentAttitude.yaw + yawOffset
                
                // Execute precise gimbal movement
                val angleRotation = GimbalAngleRotation().apply {
                    pitch = targetPitch
                    yaw = targetYaw
                    roll = currentAttitude.roll
                    mode = GimbalAngleRotationMode.ABSOLUTE_ANGLE
                    duration = 1.0  // 1 second smooth movement
                }
                
                GimbalKey.KeyGimbalAngleRotation.create(ComponentIndexType.LEFT_OR_MAIN)
                    .action(angleRotation, {
                        Log.i(TAG, "Enhanced look at success")
                        sendGimbalResponse(clientId, true, "Gimbal centered on target")
                    }, { error ->
                        Log.e(TAG, "Enhanced look at error: $error")
                        sendGimbalResponse(clientId, false, error.toString())
                    })
            } else {
                sendGimbalResponse(clientId, false, "Cannot read gimbal attitude")
            }
        }
        
    } catch (e: Exception) {
        Log.e(TAG, "Exception in handleGimbalEnhancedLookAt: ${e.message}", e)
        sendGimbalResponse(clientId, false, e.message ?: "Unknown error")
    }
}
```

#### Client Implementation
```tsx
// Add to H20NDisplay.tsx click handler
const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    
    // Calculate normalized coordinates
    const x = (clickX - effectiveDisplayRect.left) / effectiveDisplayRect.width;
    const y = (clickY - effectiveDisplayRect.top) / effectiveDisplayRect.height;
    
    // Check for modifier keys
    const isShiftClick = event.shiftKey;
    
    // Determine command type
    const commandType = isShiftClick ? 'gimbal_enhanced_look_at' : 'gimbal_tap_target';
    
    console.log(`🎯 ${isShiftClick ? 'Enhanced Look At' : 'Tap Target'} at (${x.toFixed(3)}, ${y.toFixed(3)})`);
    
    // Send appropriate command
    if ((window as any).electronAPI) {
        (window as any).electronAPI.sendBridgeCommand({
            type: commandType,
            data: { x, y }
        });
    }
    
    // Add visual indicator with different styling for enhanced mode
    const newIndicator: ClickIndicator = {
        id: `click-${Date.now()}`,
        x: clickX - effectiveDisplayRect.left,
        y: clickY - effectiveDisplayRect.top,
        status: 'pending',
        timestamp: Date.now(),
        enhanced: isShiftClick  // New property to track enhanced mode
    };
    
    setClickIndicators(prev => [...prev.slice(-2), newIndicator]);
};
```

#### Enhanced Visual Feedback
```tsx
// Update click indicator rendering for enhanced mode
{clickIndicators.map((indicator) => (
    <div key={indicator.id} className="absolute pointer-events-none" /* position styles */>
        <div className={`
            w-8 h-8 border-2 rounded-full flex items-center justify-center
            ${indicator.enhanced ? 'border-blue-500 bg-blue-500 bg-opacity-20' : 'border-yellow-500 bg-yellow-500 bg-opacity-20'}
            ${indicator.status === 'pending' ? 'animate-pulse' : ''}
            ${indicator.status === 'success' ? (indicator.enhanced ? 'border-green-400' : 'border-green-500') : ''}
            ${indicator.status === 'error' ? 'border-red-500' : ''}
        `}>
            {/* Different center dot for enhanced mode */}
            <div className={`w-1 h-1 bg-current rounded-full ${indicator.enhanced ? 'w-2 h-2' : ''}`}></div>
        </div>
        
        {/* Enhanced mode label */}
        {indicator.enhanced && (
            <div className="absolute -top-6 left-1/2 transform -translate-x-1/2 text-xs font-mono text-blue-400">
                ENHANCED
            </div>
        )}
    </div>
))}
```

---

## 🔄 Integration Testing

### Testing Workflow

1. **Deploy Android Bridge**
   ```bash
   cd /Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-as
   ./build.sh debug && ./deploy.sh debug [DEVICE_ID]
   adb -s [DEVICE_ID] forward tcp:8080 tcp:8080
   adb -s [DEVICE_ID] shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE
   ```

2. **Start Desktop Client**
   ```bash
   cd dji-controller-interface
   npm run dev:browser
   ```

3. **Test Current Functionality**
   - ✅ Regular click → existing tap-to-target
   - 🧪 Right-click drag → free look (NEW)
   - 🧪 Shift+click → enhanced look at (NEW)

### Debug Tools

#### Android Bridge Logs
```bash
# Monitor gimbal commands
adb -s [DEVICE_ID] logcat | grep -E "(DJIBridge|Gimbal|GIMBAL)"

# Monitor specific message types
adb -s [DEVICE_ID] logcat | grep "gimbal_free_look\|gimbal_enhanced_look_at"
```

#### Client Debug Console
```javascript
// Test commands in browser console
window.electronAPI.sendBridgeCommand({
    type: 'gimbal_free_look',
    data: { deltaX: 5, deltaY: -3, sensitivity: 1.0 }
});

window.electronAPI.sendBridgeCommand({
    type: 'gimbal_enhanced_look_at', 
    data: { x: 0.5, y: 0.5 }
});
```

---

## 📁 Key Files Summary

### Android Bridge (DJI SDK V5)
- **Main bridge server**: `android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/data/DJIBridgeServer.kt`
- **Gimbal handler**: Lines 600-627 (current tap-to-target implementation)
- **Message routing**: Lines 150+ (switch statement for message types)
- **Reference implementation**: `android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/LookAtVM.kt`

### Desktop Client (Electron + React)
- **Main app**: `dji-controller-interface/src/components/App.tsx`
- **H20N display**: `dji-controller-interface/src/components/H20NDisplay.tsx`
- **Bridge manager**: `dji-controller-interface/src/bridgeManager.ts`
- **Type definitions**: `dji-controller-interface/src/types.ts`
- **Electron main process**: `dji-controller-interface/electron/main.js`

### Build and Deploy
- **Android build script**: `build.sh debug`
- **Android deploy script**: `deploy.sh debug [DEVICE_ID]` 
- **Client package.json**: `dji-controller-interface/package.json`

### Documentation
- **Current status**: `docs/TODO.md`
- **Gimbal research**: `docs/GIMBAL.md`
- **Bridge implementation**: `docs/BRIDGE_PHASE1.md`
- **Development setup**: `docs/DEVELOPMENT_SETUP.md`

---

## 🚀 Implementation Checklist

### Phase 1: Free Look Feature
- [ ] Add `GIMBAL_FREE_LOOK` message type to Android bridge
- [ ] Implement `handleGimbalFreeLook()` method in DJIBridgeServer.kt
- [ ] Add mouse event handlers to H20NDisplay.tsx
- [ ] Implement visual feedback for drag operation
- [ ] Test sensitivity controls and velocity clamping
- [ ] Add configuration UI for mouse sensitivity

### Phase 2: Enhanced Look At Feature  
- [ ] Add `GIMBAL_ENHANCED_LOOK_AT` message type to Android bridge
- [ ] Implement `handleGimbalEnhancedLookAt()` method with FOV calculations
- [ ] Add shift-click detection to client click handler
- [ ] Implement precise angle calculation and gimbal positioning
- [ ] Add enhanced visual indicators for shift-click mode
- [ ] Test accuracy and fine-tune FOV values

### Phase 3: Integration and Polish
- [ ] Test all three modes together (tap-target, free look, enhanced look at)
- [ ] Add keyboard shortcuts and configuration options
- [ ] Implement sensitivity sliders and control panels
- [ ] Add help overlay explaining control modes
- [ ] Performance testing and optimization
- [ ] Documentation and user guide

---

## 💡 Development Notes

### Key Insights for New Team Member

1. **Current System Works Well** - The basic tap-to-target functionality is fully operational and provides a good foundation for the new features.

2. **WebSocket Protocol is Extensible** - Adding new message types is straightforward; just extend the MessageType enum and add handlers.

3. **DJI SDK V5 is Powerful** - The SDK provides both speed-based and position-based gimbal control, giving us flexibility for different control modes.

4. **Port Forwarding is Critical** - Always remember to re-establish ADB port forwarding after controller restarts.

5. **Visual Feedback is Important** - The click indicators and status displays help users understand what's happening with gimbal commands.

### Common Issues and Solutions

1. **Bridge Connection Lost** - Check ADB port forwarding: `adb forward tcp:8080 tcp:8080`
2. **Gimbal Not Responding** - Verify H20N camera is connected and powered
3. **Build Failures** - Ensure Android SDK and Java 17 are properly configured
4. **Video Not Displaying** - Check browser WebCodecs support (Chrome/Edge 94+)

### Performance Considerations

- **Free Look Frequency** - Limit mouse movement commands to ~20Hz to avoid overwhelming the gimbal
- **Gimbal Velocity Limits** - Clamp rotation speeds to safe ranges (±30°/sec max)
- **Network Bandwidth** - Consider throttling non-critical messages during intensive gimbal operations

---

**📝 Document Status**: Ready for implementation  
**🕒 Last Updated**: September 10, 2025  
**📍 Current Phase**: Free Look and Enhanced Look At feature implementation  
**🎯 Next Milestone**: Complete Free Look feature with mouse drag control  
**⚠️ Key Requirement**: Test on actual DJI hardware with H20N camera for accurate results
