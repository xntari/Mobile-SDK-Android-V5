# DJI SDK V5 Simulator Research

## TLDR

✅ **SIMULATOR AVAILABLE**: DJI Mobile SDK V5 includes comprehensive simulator functionality  
❌ **PHYSICAL DRONE REQUIRED**: Cannot test without physical DJI hardware - simulator runs on drone's Flight Controller  
✅ **SAFE TESTING**: Motors won't spin during simulation, aircraft behavior is virtualized  
✅ **FULL API SUPPORT**: All flight control, telemetry, camera, and gimbal APIs work in simulator mode  

## Executive Summary

DJI Mobile SDK V5 provides robust simulator functionality through the `SimulatorManager` class that allows developers to test drone applications safely without physically flying the aircraft. However, **a physical DJI drone is still required** as the simulator runs on the drone's Flight Controller hardware. The simulator virtualizes flight behavior while keeping motors disabled.

## Core Simulator Architecture

### SimulatorManager API
- **Location**: `dji.v5.manager.aircraft.simulator.SimulatorManager`
- **Initialization**: `InitializationSettings.createInstance(LocationCoordinate2D, satelliteCount)`
- **State Monitoring**: `SimulatorStatusListener` provides real-time simulation data
- **Control**: Enable/disable simulator programmatically

### Key SDK Files

#### 1. SimulatorVM.kt
**Path**: `/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/models/SimulatorVM.kt`

```kotlin
class SimulatorVM : DJIViewModel() {
    val simulatorStateSb = MutableLiveData(StringBuffer())
    
    private val simulatorStateListener = SimulatorStatusListener { state ->
        // Real-time simulator state updates
        append("Motor On : " + state.areMotorsOn())
        append("In the Air : " + state.isFlying)
        append("Roll : " + state.roll)
        append("Pitch : " + state.pitch)
        append("Yaw : " + state.yaw)
        append("PositionX/Y/Z : " + state.positionX + "/" + state.positionY + "/" + state.positionZ)
        append("Latitude : " + state.location.latitude)
        append("Longitude : " + state.location.longitude)
    }

    fun enableSimulator(initializationSettings: InitializationSettings, callback: CommonCallbacks.CompletionCallback) {
        SimulatorManager.getInstance().enableSimulator(initializationSettings, callback)
    }

    fun disableSimulator(callback: CommonCallbacks.CompletionCallback) {
        SimulatorManager.getInstance().disableSimulator(callback)
    }
}
```

#### 2. SimulatorFragment.kt  
**Path**: `/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/pages/SimulatorFragment.kt`

```kotlin
private fun enableSimulator() {
    val coordinate2D = LocationCoordinate2D(
        binding?.simulatorLatEt?.text.toString().toDouble(), 
        binding?.simulatorLngEt?.text.toString().toDouble()
    )
    val data = InitializationSettings.createInstance(
        coordinate2D, 
        binding?.simulatorGpsNumEt?.text.toString().toInt()
    )
    
    simulatorVM.enableSimulator(data, object : CommonCallbacks.CompletionCallback {
        override fun onSuccess() {
            ToastUtils.showToast("start Success")
        }
        override fun onFailure(error: IDJIError) {
            ToastUtils.showToast("start Failed" + error.description())
        }
    })
}
```

#### 3. SimulatorControlWidget.kt (UXSDK)
**Path**: `/android-sdk-v5-uxsdk/src/main/java/dji/v5/ux/training/simulatorcontrol/SimulatorControlWidget.kt`

Advanced simulator control widget with:
- Preset simulation locations
- Frequency control (10-150Hz)
- Satellite count configuration
- Wind simulation parameters
- Save/load preset functionality

## Simulator Capabilities

### ✅ What Works in Simulator Mode

1. **Flight Control APIs**
   - Virtual stick control
   - Takeoff/landing commands
   - Flight modes (GPS, ATTI, etc.)
   - Waypoint missions
   - Return-to-home functionality

2. **Telemetry Data**
   - GPS coordinates (simulated)
   - Attitude data (roll, pitch, yaw)
   - Velocity and altitude
   - Battery status
   - Flight state information

3. **Camera & Gimbal Control**
   - Camera commands (photo/video)
   - Gimbal positioning
   - Live video streaming
   - Camera settings adjustment

4. **Advanced Features**
   - Obstacle avoidance simulation
   - Geofencing compliance testing
   - Multi-aircraft coordination
   - Real-time flight state monitoring

### ❌ Simulator Limitations

1. **Physical Hardware Required**
   - Drone must be connected via USB
   - Flight Controller processes simulation
   - Cannot develop without physical drone

2. **Limited Environmental Simulation**
   - No realistic physics modeling
   - Wind effects are basic parameters
   - No terrain interaction beyond altitude

3. **Visual Feedback Dependency**
   - Requires DJI Assistant 2 for 3D visualization
   - No built-in SDK visualization tools
   - Limited debugging visual aids

## Pre-configured Simulator Locations

**Path**: `/android-sdk-v5-sample/src/main/java/dji/sampleV5/aircraft/data/QuickTestConfig.kt`

```kotlin
val simulatorAreaList = listOf(
    SimulatorArea("中国", LocationCoordinate2D(22.5797650, 113.9411710), AreaCode.CHINA),
    SimulatorArea("美国", LocationCoordinate2D(34.063191, -118.121621), AreaCode.UNITED_STATES_OF_AMERICA),
    SimulatorArea("日本", LocationCoordinate2D(35.658890, 139.746074), AreaCode.JAPAN),
    SimulatorArea("法国", LocationCoordinate2D(48.860284, 2.336282), AreaCode.FRANCE),
    SimulatorArea("德国", LocationCoordinate2D(52.516294, 13.376631), AreaCode.GERMANY),
    SimulatorArea("禁飞区", LocationCoordinate2D(22.645945, 113.816311), AreaCode.CHINA),
    SimulatorArea("授权区", LocationCoordinate2D(22.395237, 114.203203), AreaCode.CHINA),
    SimulatorArea("加强警告区", LocationCoordinate2D(22.208262, 114.03056), AreaCode.CHINA),
)
```

## Integration with Our System

### Current Bridge Architecture Compatibility

Our `DJIBridgeServer.kt` can seamlessly integrate with simulator mode:

```kotlin
// No code changes required - all APIs work identically
// Simulator state automatically reflected in telemetry data
// Video streaming continues normally (static/test patterns)
// Gimbal control commands processed as normal
```

### Recommended Implementation Approach

1. **Add Simulator Control to Bridge**
   ```kotlin
   private fun handleSimulatorCommand(clientId: String, json: JSONObject) {
       val data = json.getJSONObject("data")
       when (data.getString("action")) {
           "enable" -> {
               val lat = data.getDouble("latitude")
               val lng = data.getDouble("longitude")
               val satellites = data.getInt("satellites")
               
               val coord = LocationCoordinate2D(lat, lng)
               val settings = InitializationSettings.createInstance(coord, satellites)
               
               SimulatorManager.getInstance().enableSimulator(settings) { error ->
                   sendResponse(clientId, if (error == null) "success" else "error")
               }
           }
           "disable" -> SimulatorManager.getInstance().disableSimulator { /* ... */ }
       }
   }
   ```

2. **Add Client-Side Controls**
   - Simulator enable/disable buttons
   - Location picker interface
   - Real-time simulator state display
   - Quick preset location selection

3. **Enhanced Testing Workflow**
   - Automated CI/CD testing with simulator
   - Scripted flight pattern testing
   - Multi-scenario validation

## External Tools Integration

### DJI Assistant 2 Integration
- **Windows/Mac Application**: Provides 3D visualization of simulated flight
- **USB Connection**: Direct connection to aircraft for simulation control
- **Real-time Monitoring**: Visual feedback of aircraft behavior in virtual environment

### Automated Testing Support
```kotlin
// CI/CD Integration Example
class SimulatorTestRunner {
    fun runAutomatedFlightTest() {
        // Enable simulator
        enableSimulator(testLocation, testSatellites)
        
        // Execute flight commands
        takeoff()
        moveToWaypoint(waypoint1)
        moveToWaypoint(waypoint2)
        land()
        
        // Verify results
        assertFlightPath(expectedPath)
    }
}
```

## API Reference Summary

### Key Classes
- `SimulatorManager`: Main simulator control interface
- `InitializationSettings`: Simulator configuration parameters  
- `SimulatorStatusListener`: Real-time state monitoring
- `SimulatorState`: Current simulation state data
- `SimulatorControlWidget`: UXSDK widget for simulator control

### Key Methods
```kotlin
// Enable simulator with location and satellite count
SimulatorManager.getInstance().enableSimulator(settings, callback)

// Disable simulator
SimulatorManager.getInstance().disableSimulator(callback)

// Check if simulator is active
SimulatorManager.getInstance().isSimulatorEnabled

// Add state listener
SimulatorManager.getInstance().addSimulatorStateListener(listener)
```

## Conclusion

DJI Mobile SDK V5 provides comprehensive simulator functionality that enables safe development and testing of drone applications. While a physical drone is required, the simulator prevents actual flight while maintaining full API compatibility. This makes it ideal for:

- **Development**: Test flight control logic without risk
- **Debugging**: Isolate software issues from hardware variables  
- **CI/CD**: Automated testing in controlled environments
- **Training**: Learn drone development safely
- **Validation**: Verify mission logic before real flights

The simulator seamlessly integrates with our existing bridge architecture and can enhance our development workflow significantly.

## Related Files

### Core Implementation
- `SimulatorVM.kt:15-78` - Main simulator view model
- `SimulatorFragment.kt:82-97` - UI implementation example
- `QuickTestConfig.kt:16-25` - Preset locations configuration

### UXSDK Widgets
- `SimulatorControlWidget.kt` - Advanced simulator control interface
- `SimulatorIndicatorWidget.kt` - Simulator status indicator
- `SimulatorPresetUtils.kt` - Preset management utilities

### UI Resources  
- `frag_simulator_page.xml` - Sample simulator UI layout
- `uxsdk_widget_simulator_control.xml` - UXSDK widget layout

### Generated Documentation
This research was generated by analyzing the complete DJI Mobile SDK V5 codebase and official documentation on 2025-09-08.