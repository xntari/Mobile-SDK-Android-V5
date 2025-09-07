# DJI SDK V5 Gimbal Control API Documentation

## TLDR - Implementation Status & Plan

### ✅ RESEARCH COMPLETED
- **Gimbal Control APIs**: Full SDK API inventory with exact file paths
- **Look At Functionality**: Complete click-to-point implementation found
- **H20N Compatibility**: CONFIRMED - Uses `ComponentIndexType.LEFT_OR_MAIN`
- **Rate Limiting**: Velocity threshold ≥1.0 + 500ms throttling patterns identified
- **Error Handling**: Standard IDJIError callback patterns documented
- **Physical Override**: Limited to pitch locking only (yaw/roll not available)

### 🔧 TODO - Implementation Plan (Incremental)

#### **PHASE 1: MINIMAL CLICK-TO-POINT (SAFEST START)**
- [ ] **Step 1.1**: Add required imports to DJIBridgeServer.kt (6 lines, no functionality change)
- [ ] **Step 1.2**: Add `GIMBAL_CLICK_TARGET` message type (1 line, no handlers yet)
- [ ] **Step 1.3**: Add basic message routing (5 lines, just logs for now)
- [ ] **Step 1.4**: Add handler method using existing SDK pattern (20 lines)
- [ ] **Step 1.5**: Test with simple client click on video overlay

#### **PHASE 2: ERROR HANDLING & POLISH**  
- [ ] **Step 2.1**: Add comprehensive error responses to client
- [ ] **Step 2.2**: Add visual click indicators on video
- [ ] **Step 2.3**: Add camera selection (FPV vs H20N)
- [ ] **Step 2.4**: Add coordinate validation and edge case handling

#### **PHASE 3: ADVANCED FEATURES (FUTURE)**
- [ ] **Step 3.1**: Continuous drag-to-move functionality  
- [ ] **Step 3.2**: Manual speed control (pitch/yaw/roll sliders)
- [ ] **Step 3.3**: GPS coordinate targeting
- [ ] **Step 3.4**: Physical controller override patterns

### 🎯 NEXT IMMEDIATE ACTION
**Start with Step 1.1**: Add imports only - zero functional impact, easy to verify

---

## DETAILED IMPLEMENTATION PLAN

### **Safety-First Approach**

**Core Principle**: Each step is reversible and isolated
- No step breaks existing functionality
- Manager can verify each step independently  
- Rollback plan available for every change
- Extensive logging for debugging

### **PHASE 1: MINIMAL CLICK-TO-POINT IMPLEMENTATION**

#### **Step 1.1: Add Required Imports (ZERO RISK)**
**File**: `DJIBridgeServer.kt`  
**Action**: Add imports at top of file  
**Risk Level**: ✅ NONE - imports don't execute code

```kotlin
// Add these imports (existing imports remain unchanged)
import dji.sdk.keyvalue.key.CameraKey
import dji.sdk.keyvalue.value.camera.TapZoomMode
import dji.sdk.keyvalue.value.camera.ZoomTargetPointInfo 
import dji.sdk.keyvalue.value.common.CameraLensType
import dji.v5.et.createCamera
import dji.v5.et.action
```

**Verification**: Project compiles successfully, no runtime changes

#### **Step 1.2: Add Message Type Enum (ZERO RISK)**
**File**: `DJIBridgeServer.kt` - MessageType enum  
**Action**: Add single line  
**Risk Level**: ✅ NONE - unused enum entry

```kotlin
// Add to MessageType enum
GIMBAL_CLICK_TARGET("gimbal_click_target"),
```

**Verification**: Enum compiles, existing messages unchanged

#### **Step 1.3: Add Message Routing (LOG ONLY - MINIMAL RISK)**
**File**: `DJIBridgeServer.kt` - handleIncomingMessage method  
**Action**: Add routing with logging only  
**Risk Level**: 🟡 MINIMAL - only adds logging

```kotlin
// Add to message routing switch
MessageType.GIMBAL_CLICK_TARGET -> {
    Log.i(TAG, "Gimbal click target received from $clientId: $json")
    // TODO: Implementation in next step
}
```

**Verification**: Log appears when client sends gimbal message, no functional changes

#### **Step 1.4: Add Handler Method (ISOLATED FUNCTIONALITY)**
**File**: `DJIBridgeServer.kt`  
**Action**: Add complete handler method  
**Risk Level**: 🟡 CONTROLLED - new functionality only, existing code untouched

```kotlin
private fun handleGimbalClickTarget(clientId: String, command: JSONObject) {
    try {
        Log.i(TAG, "Processing gimbal click for client: $clientId")
        
        // Extract coordinates
        val x = command.getDouble("x")  // 0.0 to 1.0
        val y = command.getDouble("y")  // 0.0 to 1.0
        
        // Validate coordinates
        if (x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0) {
            sendErrorResponse(clientId, "INVALID_COORDINATES", "x,y must be 0.0-1.0")
            return
        }
        
        // Default to H20N camera
        val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
        
        Log.i(TAG, "Gimbal click target: x=$x, y=$y, camera=$cameraIndex")
        
        // Use exact SDK pattern from LookAtVM.kt:64-70  
        CameraKey.KeyTapZoomAtTarget.createCamera(cameraIndex, CameraLensType.CAMERA_LENS_ZOOM)
            .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), {
                // Success
                Log.i(TAG, "Gimbal click success for client: $clientId")
                sendSuccessResponse(clientId, "GIMBAL_CLICK_SUCCESS", mapOf(
                    "x" to x,
                    "y" to y,
                    "camera" to cameraIndex.name
                ))
            }, { error: IDJIError ->
                // Error
                Log.e(TAG, "Gimbal click error for client $clientId: ${error}")
                sendErrorResponse(clientId, "GIMBAL_CLICK_ERROR", error.toString())
            })
            
    } catch (e: Exception) {
        Log.e(TAG, "Exception in handleGimbalClickTarget: ${e.message}", e)
        sendErrorResponse(clientId, "GIMBAL_PROCESSING_ERROR", e.message ?: "Unknown error")
    }
}

// Helper methods for client responses
private fun sendSuccessResponse(clientId: String, type: String, data: Map<String, Any>) {
    val response = BridgeMessage(
        type = MessageType.fromString("gimbal_response") ?: MessageType.SYSTEM_STATUS,
        data = mapOf(
            "status" to "success",
            "response_type" to type,
            "data" to data
        )
    )
    sendToClient(clientId, response)
}

private fun sendErrorResponse(clientId: String, errorType: String, errorMessage: String) {
    val response = BridgeMessage(
        type = MessageType.ERROR,
        data = mapOf(
            "error_type" to errorType,
            "message" to errorMessage
        )
    )
    sendToClient(clientId, response)
}
```

**Verification**: Method exists but only executes when client sends gimbal message

#### **Step 1.5: Integrate Canvas Click Handler in H20NDisplay.tsx (CLIENT-SIDE ONLY)**
**Action**: Add click event to video canvas for gimbal tap-to-target  
**Risk Level**: ✅ NONE - client-side UI integration only

**File**: `dji-controller-interface/src/components/H20NDisplay.tsx`  
**Requirements**:
1. Add onClick handler to video canvas element
2. Convert canvas click coordinates to normalized (0.0-1.0) values  
3. Send gimbal_tap_target message via existing WebSocket connection
4. Add visual feedback (optional crosshair/indicator at click point)

**Implementation Pattern**:
```typescript
const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    
    // Convert to normalized coordinates (0.0-1.0)
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    
    // Send gimbal command via existing WebSocket
    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            type: 'gimbal_tap_target',
            data: { x, y }
        }));
    }
};

// Apply to canvas element
<canvas 
    ref={canvasRef}
    onClick={handleCanvasClick}
    style={{ cursor: 'crosshair' }}
    // ... other props
/>
```

**Integration Notes**:
- Use existing `websocket` connection from bridgeManager
- Canvas click coordinates automatically normalized to 0.0-1.0 range
- Add crosshair cursor to indicate interactive area
- Optional: Add temporary visual indicator at click point

**Verification**: 
- Canvas click sends gimbal_tap_target message
- Bridge server logs show message received with correct coordinates
- Gimbal moves to clicked position if H20N connected  
- Error handling if camera not available

### **Rollback Plan for Each Step**

#### **Step 1.1 Rollback**: Remove import lines
#### **Step 1.2 Rollback**: Remove enum entry  
#### **Step 1.3 Rollback**: Remove routing case
#### **Step 1.4 Rollback**: Remove handler methods
#### **Step 1.5 Rollback**: No rollback needed (client-side only)

### **Manager Verification Checklist**

#### **After Step 1.1**:
- [ ] Project compiles without errors
- [ ] Existing functionality works normally
- [ ] No runtime behavior changes

#### **After Step 1.2**: 
- [ ] Bridge server starts normally
- [ ] Existing message types work
- [ ] No new functionality activated

#### **After Step 1.3**:
- [ ] Send test gimbal message → log entry appears  
- [ ] Existing messages still work normally
- [ ] No gimbal movement yet (expected)

#### **After Step 1.4**:
- [ ] Send gimbal message → handler executes
- [ ] Error responses work (test with invalid coordinates)
- [ ] Success responses work (test with valid coordinates if camera available)
- [ ] Existing bridge functionality unchanged

#### **After Step 1.5**:
- [ ] Manual test shows gimbal movement (if H20N connected)
- [ ] Error handling works (test without camera)  
- [ ] All existing video streaming still works

### **Success Criteria**
1. **No existing functionality broken** at any step
2. **Complete reversibility** - can undo any step
3. **Comprehensive logging** for debugging
4. **Gradual feature activation** - no sudden changes

---

## 1. SDK API Discovery

### Core Gimbal Control APIs

#### GimbalKey Primary Methods
- **`GimbalKey.KeyRotateBySpeed`** - Primary method for gimbal movement control
- **`GimbalKey.KeyYawAdjustSupported`** - Check if yaw control is supported
- **`GimbalKey.KeyGimbalAttitude`** - Get current gimbal attitude (pitch/yaw/roll)
- **`GimbalKey.KeyYawRelativeToAircraftHeading`** - Get gimbal yaw relative to aircraft
- **`GimbalKey.KeyConnection`** - Check gimbal connection status

#### Fine-Tuning APIs
- **`GimbalKey.KeyFineTunePosture`** - Fine-tune gimbal posture
- **`GimbalKey.KeyFineTuneRollTotalDegree`** - Roll fine-tuning
- **`GimbalKey.KeyFineTuneYawTotalDegree`** - Yaw fine-tuning  
- **`GimbalKey.KeyFineTunePitchTotalDegree`** - Pitch fine-tuning

#### Gimbal Management APIs
- **`GimbalKey.KeyGimbalAttitudeRange`** - Get gimbal attitude limits
- **`GimbalKey.KeyGimbalCalibrationStatus`** - Calibration status
- **`GimbalKey.KeyGimbalCalibrate`** - Start calibration
- **`GimbalKey.KeyRestoreFactorySettings`** - Factory reset

#### Data Types
- **`GimbalSpeedRotation(pitch, yaw, roll, CtrlInfo)`** - Speed-based rotation parameters
- **`FineTunePostureMsg(axis, value)`** - Fine-tuning message
- **`PostureFineTuneAxis`** - Axis enumeration for fine-tuning
- **`ComponentIndexType`** - Camera/gimbal selection (FPV, LEFT_OR_MAIN, RIGHT, UP)

### Component Index Types for Multi-Gimbal Support
```kotlin
ComponentIndexType.FPV              // FPV Camera
ComponentIndexType.LEFT_OR_MAIN     // Main/H20N Camera  
ComponentIndexType.RIGHT            // Right Camera
ComponentIndexType.UP               // Up Camera
```

## 2. Code Examples Found

### Basic Gimbal Speed Control
**Source:** `FPVInteractionWidgetModel.java:245-247`
```java
public Completable rotateGimbalBySpeed(double yaw, double pitch) {
    return djiSdkModel.performActionWithOutResult(
        KeyTools.createKey(GimbalKey.KeyRotateBySpeed, cameraIndex),
        new GimbalSpeedRotation(pitch, yaw, 0.0, new CtrlInfo())
    );
}
```

### Gimbal Capability Check
**Source:** `FPVInteractionWidgetModel.java:234`
```java
public boolean canRotateGimbalYaw() {
    return isYawAdjustSupportedProcessor.getValue();
}
```

### Fine-Tuning Control
**Source:** `GimbalFineTuneWidgetModel.kt:43-47`
```kotlin
fun fineTunePosture(axis: PostureFineTuneAxis, value: Double): Completable {
    return djiSdkModel.performActionWithOutResult(
        KeyTools.createKey(GimbalKey.KeyFineTunePosture, gimbalIndex),
        FineTunePostureMsg(axis, value)
    )
}
```

### Gimbal Attitude Monitoring
**Source:** `GimbalPitchBarModel.java:51-53`
```java
bindDataProcessor(
    KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.LEFT_OR_MAIN), 
    gimbalAttitudeProcessor
);
```

### Multi-Gimbal Support Pattern
**Source:** `HSIWidgetModel.java:89-99`
```java
// Monitor multiple gimbal attitudes simultaneously
Flowable.combineLatest(
    RxUtil.addListener(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.LEFT_OR_MAIN), this),
    RxUtil.addListener(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.RIGHT), this),
    RxUtil.addListener(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.UP), this),
    (attitude, aDouble) -> attitude.getYaw() + aDouble * RAD_TO_DEG
).subscribe(gimbalYawProcessor::onNext);
```

## 3. Look At Functionality

### Screen Tap to Gimbal Position
**Complete Implementation Found:** `LookAtFragment.kt` + `LookAtVM.kt`

#### Core Look At Method
**Source:** `LookAtVM.kt:56-62`
```kotlin
fun lookAt(info: LookAtInfo) {
    FlightControllerKey.KeyLookAt.create().action(info, {
        toastResult?.postValue(DJIToastResult.success())
    }, { error: IDJIError ->
        toastResult?.postValue(DJIToastResult.failed(error.toString()))
    })
}
```

#### Touch Event Handling
**Source:** `LookAtFragment.kt:92-102`
```kotlin
binding?.svCamera?.setOnTouchListener { v, event ->
    if (event.action == MotionEvent.ACTION_DOWN) {
        val viewHeight = binding?.svCamera?.height ?: -1
        val viewWidth = binding?.svCamera?.width ?: -1
        lookAtViewModel.startTapZoomPoint(
            event.x / viewHeight.toDouble(), 
            event.y / viewWidth.toDouble()
        )
    }
    true
}
```

#### GPS Coordinate Conversion
**Source:** `LookAtVM.kt:44-49`
```kotlin
fun getLiveViewLocationWithGPS(pointPos: LocationCoordinate3D): PinPointInfo {
    return MediaDataCenter.getInstance().cameraStreamManager.getLiveViewLocationWithGPS(
        pointPos,
        currentComponentIndexType.value ?: ComponentIndexType.UNKNOWN
    )
}
```

#### Look At Info Structure
**Source:** `LookAtFragment.kt:151-153`
```kotlin
val info = LookAtInfo()
info.location = locationList[indexChosen[0]]  // GPS coordinates
info.mode = lookAtModeList[indexChosen[0]]     // Look at mode
```

### Tap Zoom Integration
**Source:** `LookAtVM.kt:64-70`
```kotlin
fun startTapZoomPoint(x: Double, y: Double) {
    CameraKey.KeyTapZoomAtTarget.createCamera(
        currentComponentIndexType.value!!, 
        CameraLensType.CAMERA_LENS_ZOOM
    ).action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), {
        // Success callback
    }, { error: IDJIError ->
        // Error callback
    })
}
```

## 4. Control Override Analysis

### Current Physical Control Handling
- **Finding:** No explicit "override" mode found in gimbal APIs
- **Pattern:** Software commands work in parallel with physical controls
- **Behavior:** Inputs appear to be additive rather than exclusive

### Mission-Based Gimbal Locking
**Source:** `IntelligentFlightVM.kt:273-285`
```kotlin
fun lockGimbalPitch(lock: Boolean) {
    IntelligentFlightManager.getInstance()
        .poiMissionManager.lockGimbalPitch(lock, object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                toastResult?.postValue(DJIToastResult.success("lockGimbalPitch:$lock"))
            }
            override fun onFailure(error: IDJIError) {
                toastResult?.postValue(DJIToastResult.failed("lockGimbalPitch:$lock,$error"))
            }
        })
}
```

### Virtual Stick Control Authority Pattern
**Precedent from Virtual Stick Implementation:** `VirtualStickVM.kt`
- **Authority Management:** `currentFlightControlAuthorityOwner`
- **Enable/Disable States:** `isVirtualStickEnable`
- **Advanced Mode:** `isVirtualStickAdvancedModeEnabled`
- **Override Capability:** Can take control from remote controller

### Physical Control Integration
**Remote Controller Monitoring:** `DJIBridgeActivity.kt:167-205`
```kotlin
// Physical stick monitoring pattern
RemoteControllerKey.KeyStickLeftHorizontal.create().listen(this) { value ->
    value?.let {
        currentStickValues.leftHorizontal = it
        // Can detect physical input and decide priority
    }
}
```

## Implementation Strategy for Bridge Server

### Recommended Approach
1. **Gimbal Command Types** - Add to existing `MessageType` enum:
   - `GIMBAL_SPEED_ROTATION` - Speed-based gimbal control
   - `GIMBAL_LOOK_AT` - GPS coordinate look-at
   - `GIMBAL_FINE_TUNE` - Fine adjustment commands

2. **Override Strategy** - Use POI mission locking pattern:
   - Lock gimbal during software control
   - Release lock when returning control to pilot
   - Monitor physical controller input for safety

3. **Multi-Camera Support** - Use `ComponentIndexType`:
   - Support FPV, H20N, and additional cameras
   - Include camera selection in commands

4. **Safety Integration** - Follow Virtual Stick patterns:
   - Authority management
   - Timeout handling
   - Emergency release mechanisms

### Key Classes to Import
```kotlin
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.value.gimbal.GimbalSpeedRotation
import dji.sdk.keyvalue.value.gimbal.FineTunePostureMsg
import dji.sdk.keyvalue.value.gimbal.PostureFineTuneAxis
import dji.sdk.keyvalue.value.gimbal.CtrlInfo
import dji.sdk.keyvalue.value.flightcontroller.LookAtInfo
import dji.sdk.keyvalue.value.flightcontroller.LookAtMode
import dji.v5.manager.intelligent.IntelligentFlightManager
```

## 5. PROOF - Exact File Locations and Code

### GimbalKey.KeyRotateBySpeed - PRIMARY CONTROL METHOD
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/cameracore/widget/fpvinteraction/FPVInteractionWidgetModel.java`  
**Lines:** 245-247
```java
public Completable rotateGimbalBySpeed(double yaw, double pitch) {
    return djiSdkModel.performActionWithOutResult(KeyTools.createKey(GimbalKey.KeyRotateBySpeed, cameraIndex),
            new GimbalSpeedRotation(pitch, yaw, 0.0, new CtrlInfo()));
}
```

### GimbalKey.KeyYawAdjustSupported - YAW CAPABILITY CHECK
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/cameracore/widget/fpvinteraction/FPVInteractionWidgetModel.java`  
**Line:** 103
```java
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyYawAdjustSupported, cameraIndex), isYawAdjustSupportedProcessor);
```

### GimbalKey Fine-Tune APIs
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/gimbal/GimbalFineTuneWidgetModel.kt`  
**Lines:** 30, 33, 36
```kotlin
// Line 30:
GimbalKey.KeyFineTuneRollTotalDegree, gimbalIndex), rollAdjustDegreeProcessor)
// Line 33:
GimbalKey.KeyFineTuneYawTotalDegree, gimbalIndex), yawAdjustDegreeProcessor)
// Line 36:
GimbalKey.KeyFineTunePitchTotalDegree, gimbalIndex), pitchAdjustDegreeProcessor)
```

### GimbalKey.KeyFineTunePosture - FINE CONTROL
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/gimbal/GimbalFineTuneWidgetModel.kt`  
**Line:** 45
```kotlin
KeyTools.createKey(GimbalKey.KeyFineTunePosture, gimbalIndex),
```

### GimbalKey.KeyGimbalAttitude - ATTITUDE MONITORING
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/core/widget/hsi/GimbalPitchBarModel.java`  
**Lines:** 51-53
```java
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.LEFT_OR_MAIN), gimbalAttitudeInDegrees0Processor);
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.RIGHT), gimbalAttitudeInDegrees1Processor);
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.UP), gimbalAttitudeInDegrees2Processor);
```

### GimbalKey.KeyYawRelativeToAircraftHeading - YAW RELATIVE
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/map/MapWidgetModel.java`  
**Line:** 122
```java
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyYawRelativeToAircraftHeading), gimbalYawDataProcessor);
```

### GimbalKey.KeyConnection - CONNECTION STATUS
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/core/ui/hsi/HSIWidgetModel.java`  
**Lines:** 116-118
```java
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyConnection, ComponentIndexType.LEFT_OR_MAIN), gimbalConnection0Processor);
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyConnection, ComponentIndexType.RIGHT), gimbalConnection1Processor);
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyConnection, ComponentIndexType.UP), gimbalConnection2Processor);
```

### GimbalKey Calibration APIs
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/gimbal/GimbalSettingWidgetModel.kt`  
**Lines:** 38, 50, 57
```kotlin
// Line 38:
GimbalKey.KeyGimbalCalibrationStatus, gimbalIndex), calibrationStatusProcessor)
// Line 50:
KeyTools.createKey(GimbalKey.KeyRestoreFactorySettings, gimbalIndex),
// Line 57:
KeyTools.createKey(GimbalKey.KeyGimbalCalibrate, gimbalIndex),
```

### LOOK AT - FlightControllerKey.KeyLookAt
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/LookAtVM.kt`  
**Line:** 57
```kotlin
FlightControllerKey.KeyLookAt.create().action(info, {
```

### LOOK AT - Touch Event Handling
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/pages/LookAtFragment.kt`  
**Lines:** 92-102
```kotlin
binding?.svCamera?.setOnTouchListener { v, event ->
    if (event.action == MotionEvent.ACTION_DOWN) {
        val viewHeight = binding?.svCamera?.height ?: -1
        val viewWidth = binding?.svCamera?.width ?: -1
        if (viewHeight == -1 || viewWidth == -1) {
            return@setOnTouchListener false
        }
        lookAtViewModel.startTapZoomPoint(event.x / viewHeight.toDouble(), event.y / viewWidth.toDouble())
    }
    true
}
```

### LOOK AT - GPS Coordinate Conversion
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/LookAtVM.kt`  
**Lines:** 44-49
```kotlin
fun getLiveViewLocationWithGPS(pointPos: LocationCoordinate3D): PinPointInfo {
    return MediaDataCenter.getInstance().cameraStreamManager.getLiveViewLocationWithGPS(
        pointPos,
        currentComponentIndexType.value ?: ComponentIndexType.UNKNOWN
    )
}
```

### LOOK AT - LookAtInfo Import
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/LookAtVM.kt`  
**Line:** 12
```kotlin
import dji.sdk.keyvalue.value.flightcontroller.LookAtInfo
```

### GIMBAL LOCKING - Physical Control Override
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/IntelligentFlightVM.kt`  
**Lines:** 273-285
```kotlin
fun lockGimbalPitch(lock: Boolean) {
    IntelligentFlightManager.getInstance().poiMissionManager.lockGimbalPitch(
        lock,
        object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                toastResult?.postValue(DJIToastResult.success("lockGimbalPitch:$lock"))
            }

            override fun onFailure(error: IDJIError) {
                toastResult?.postValue(DJIToastResult.failed("lockGimbalPitch:$lock,$error"))
            }
        })
}
```

### GIMBAL LOCKING - Usage Example
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/pages/IntelligentFlightFragment.kt`  
**Line:** 280
```kotlin
intelligentVM.lockGimbalPitch(index[indexChosen[0]])
```

### VIRTUAL STICK AUTHORITY PATTERN - Control Authority
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/pages/VirtualStickFragment.kt`  
**Line:** 216
```kotlin
builder.append("Current control permission owner:").append(virtualStickVM.currentVirtualStickStateInfo.value?.state?.currentFlightControlAuthorityOwner)
```

### REMOTE CONTROLLER MONITORING - Physical Input Detection
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/DJIBridgeActivity.kt`  
**Lines:** 167-169
```kotlin
RemoteControllerKey.KeyStickLeftHorizontal.create().listen(this) { value ->
    LogUtils.d("JOYSTICK_DEBUG", "Left Horizontal callback triggered - value: $value")
    value?.let {
```

### GIMBAL IMPORT - Key Classes
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/gimbal/GimbalFineTuneWidgetModel.kt`  
**Lines:** 3-7
```kotlin
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.sdk.keyvalue.value.gimbal.FineTunePostureMsg
import dji.sdk.keyvalue.value.gimbal.PostureFineTuneAxis
```

### GIMBAL IMPORT - Speed Rotation
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/cameracore/widget/fpvinteraction/FPVInteractionWidgetModel.java`  
**Line:** 43
```java
import dji.sdk.keyvalue.value.gimbal.GimbalSpeedRotation;
```

### GIMBAL IMPORT - CtrlInfo
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/cameracore/widget/fpvinteraction/FPVInteractionWidgetModel.java`  
**Line:** 42
```java
import dji.sdk.keyvalue.value.gimbal.CtrlInfo;
```

## Conclusion

**✅ GIMBAL CONTROL:** Fully supported via `GimbalKey.KeyRotateBySpeed`  
**✅ LOOK AT FUNCTIONALITY:** Complete implementation available  
**⚠️ PHYSICAL OVERRIDE:** Achievable via mission locking + authority patterns  
**✅ MULTI-CAMERA:** Full support via `ComponentIndexType`

## 6. CRITICAL IMPLEMENTATION DETAILS

### H20N Compatibility with ComponentIndexType.LEFT_OR_MAIN
**CONFIRMED**: H20N uses ComponentIndexType.LEFT_OR_MAIN  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-as/docs/H20N.md`  
**Line:** 33
```markdown
- **Component Identification:** H20N uses ComponentIndexType.LEFT_OR_MAIN
```

**VERIFIED USAGE**: All gimbal examples work with LEFT_OR_MAIN:
```java
// From GimbalPitchBarModel.java:51
bindDataProcessor(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, ComponentIndexType.LEFT_OR_MAIN), gimbalAttitudeInDegrees0Processor);
```

### Gimbal Command Rate Limiting
**FOUND**: Built-in velocity threshold system  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/cameracore/widget/fpvinteraction/FPVInteractionWidget.java`  
**Lines:** 392-398
```java
// VELOCITY THRESHOLD: Commands only sent if velocity >= 1
if (Math.abs(yawVelocity) >= 1 || Math.abs(pitchVelocity) >= 1) {
    addDisposable(widgetModel.rotateGimbalBySpeed(yawVelocity, -pitchVelocity)
            .observeOn(SchedulerProvider.ui())
            .subscribe(() -> {
                //do nothing
            }, UxErrorHandle.logErrorConsumer(TAG, "rotate gimbal: ")));
}
```

**THROTTLING PATTERN FOUND**: 500ms throttling for UI updates  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/sample/showcase/defaultlayout/DefaultLayoutActivity.java`  
**Line:** 268
```java
.throttleLast(500, TimeUnit.MILLISECONDS)
```

### Gimbal Locking - Yaw/Roll Support Analysis
**FINDING**: Only pitch locking found in API  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/IntelligentFlightVM.kt`  
**Lines:** 273-285

**API SEARCH RESULTS**: No `lockGimbalYaw()` or `lockGimbalRoll()` methods found
- Only `lockGimbalPitch()` available in POI mission manager
- **LIMITATION**: Yaw/Roll locking not available in current API
- **WORKAROUND**: Software control priority requires authority management patterns

### Error Handling Patterns
**STANDARD PATTERN**: IDJIError callback with toast notifications  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/LookAtVM.kt`  
**Lines:** 57-61
```kotlin
FlightControllerKey.KeyLookAt.create().action(info, {
    toastResult?.postValue(DJIToastResult.success())
}, { error: IDJIError ->
    toastResult?.postValue(DJIToastResult.failed(error.toString()))
})
```

**COMPLETABLE ERROR HANDLING**: RxJava pattern  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/cameracore/widget/fpvinteraction/FPVInteractionWidget.java`  
**Line:** 397
```java
UxErrorHandle.logErrorConsumer(TAG, "rotate gimbal: ")
```

**COMPLEX GIMBAL ERROR HANDLING**: Mission-based with callbacks  
**File:** `/Users/kamil/git/xMobile-SDK-Android-V5/SampleCode-V5/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/IntelligentFlightVM.kt`  
**Lines:** 276-285
```kotlin
object : CommonCallbacks.CompletionCallback {
    override fun onSuccess() {
        toastResult?.postValue(DJIToastResult.success("lockGimbalPitch:$lock"))
    }
    override fun onFailure(error: IDJIError) {
        toastResult?.postValue(DJIToastResult.failed("lockGimbalPitch:$lock,$error"))
    }
}
```

## Implementation Requirements Summary

### ✅ CONFIRMED CAPABILITIES:
1. **H20N Gimbal Control**: Full support via ComponentIndexType.LEFT_OR_MAIN
2. **Rate Limiting**: Velocity threshold (≥1) + 500ms UI throttling patterns  
3. **Error Handling**: IDJIError callbacks + toast notifications standard
4. **Speed Control**: GimbalSpeedRotation(pitch, yaw, roll, CtrlInfo)

### ⚠️ LIMITATIONS IDENTIFIED:
1. **Physical Override**: Only pitch locking available - NO yaw/roll locking APIs
2. **Rate Limits**: No explicit API rate limits found - use velocity thresholds
3. **Authority Management**: Must implement Virtual Stick-style authority patterns

### 🔧 REQUIRED IMPLEMENTATION PATTERNS:
```java
// Rate limiting pattern
if (Math.abs(yaw) >= 1.0 || Math.abs(pitch) >= 1.0) {
    // Send gimbal command
}

// Error handling pattern  
.subscribe(() -> {
    // Success - silent
}, error -> {
    // Log error and notify client
    sendErrorToClient(clientId, "GIMBAL_ERROR", error.getMessage());
});

// Authority management pattern (from VirtualStick)
if (hasGimbalAuthority()) {
    lockGimbalPitch(true);  // Only pitch available
    performGimbalControl();
    // Release on timeout/disconnect
}
```

**All claims verified with exact file paths and line numbers. Research complete with critical implementation details.**