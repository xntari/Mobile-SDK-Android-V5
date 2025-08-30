package dji.sampleV5.aircraft.util

import dji.sdk.keyvalue.key.RemoteControllerKey
import dji.v5.et.create
import dji.v5.et.listen
import dji.v5.manager.KeyManager
import dji.v5.utils.common.LogUtils
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Global Joystick Monitor for DJI Remote Controller
 * 
 * Monitors RC stick inputs globally without requiring navigation to VirtualStick page.
 * Provides enhanced logging for joystick movements and flight parameter interpretation.
 *
 * @author Claude Code
 * @date 2024/08/30
 */
object GlobalJoystickMonitor {
    
    private var isMonitoring = false
    private var currentStickValues = RCStickValues()
    
    data class RCStickValues(
        var leftHorizontal: Int = 0,    // Yaw
        var leftVertical: Int = 0,      // Throttle  
        var rightHorizontal: Int = 0,   // Roll
        var rightVertical: Int = 0      // Pitch
    )
    
    /**
     * Start global RC stick monitoring
     * This runs independently of any UI components
     */
    fun startMonitoring(context: Any) {
        if (isMonitoring) {
            LogUtils.w("GlobalJoystickMonitor", "Monitoring already started")
            return
        }
        
        LogUtils.i("GlobalJoystickMonitor", "Starting global RC stick monitoring...")
        isMonitoring = true
        
        // Monitor Left Horizontal (Yaw)
        RemoteControllerKey.KeyStickLeftHorizontal.create().listen(context) { value ->
            value?.let {
                currentStickValues.leftHorizontal = it
                logStickInput("Left Horizontal (Yaw)", it)
                updateFlightMapping()
            }
        }
        
        // Monitor Left Vertical (Throttle)
        RemoteControllerKey.KeyStickLeftVertical.create().listen(context) { value ->
            value?.let {
                currentStickValues.leftVertical = it
                logStickInput("Left Vertical (Throttle)", it)
                updateFlightMapping()
            }
        }
        
        // Monitor Right Horizontal (Roll)
        RemoteControllerKey.KeyStickRightHorizontal.create().listen(context) { value ->
            value?.let {
                currentStickValues.rightHorizontal = it
                logStickInput("Right Horizontal (Roll)", it)
                updateFlightMapping()
            }
        }
        
        // Monitor Right Vertical (Pitch)
        RemoteControllerKey.KeyStickRightVertical.create().listen(context) { value ->
            value?.let {
                currentStickValues.rightVertical = it
                logStickInput("Right Vertical (Pitch)", it)
                updateFlightMapping()
            }
        }
        
        LogUtils.i("GlobalJoystickMonitor", "Global RC stick monitoring started successfully")
    }
    
    /**
     * Stop global RC stick monitoring
     */
    fun stopMonitoring(context: Any) {
        if (!isMonitoring) {
            return
        }
        
        LogUtils.i("GlobalJoystickMonitor", "Stopping global RC stick monitoring...")
        isMonitoring = false
        
        // Cancel all listeners
        KeyManager.getInstance().cancelListen(context)
        
        LogUtils.i("GlobalJoystickMonitor", "Global RC stick monitoring stopped")
    }
    
    /**
     * Log individual stick input with timestamp
     */
    private fun logStickInput(stickName: String, value: Int) {
        val timestamp = System.currentTimeMillis()
        val percentage = value.toFloat() / 100.0f
        
        LogUtils.d("RC_STICK_MONITOR", "$stickName: $value (${String.format("%.2f", percentage)}%) at $timestamp")
        
        // Log direction for significant movements
        if (abs(value) > 10) {
            val direction = when {
                value > 50 -> "HIGH_POSITIVE"
                value > 10 -> "POSITIVE"
                value < -50 -> "HIGH_NEGATIVE"
                value < -10 -> "NEGATIVE"
                else -> "NEUTRAL"
            }
            LogUtils.d("RC_STICK_DIRECTION", "$stickName Direction: $direction (${abs(value)})")
        }
    }
    
    /**
     * Update flight mapping and log combined stick positions
     */
    private fun updateFlightMapping() {
        val sticks = currentStickValues
        
        // Convert to normalized flight parameters (-1.0 to 1.0)
        val yaw = sticks.leftHorizontal.toFloat() / 100.0f
        val throttle = sticks.leftVertical.toFloat() / 100.0f  
        val roll = sticks.rightHorizontal.toFloat() / 100.0f
        val pitch = sticks.rightVertical.toFloat() / 100.0f
        
        // Log original VirtualStick format for compatibility
        LogUtils.d("VirtualStick", "Input: P=${String.format("%.3f", pitch)}, R=${String.format("%.3f", roll)}, Y=${String.format("%.3f", yaw)}, T=${String.format("%.3f", throttle)}")
        
        // Log detailed flight mapping
        LogUtils.d("VIRTUAL_STICK_CMD", "RC Stick Values: LH=${sticks.leftHorizontal}, LV=${sticks.leftVertical}, RH=${sticks.rightHorizontal}, RV=${sticks.rightVertical}")
        
        // Only log flight parameters if there's actual movement
        if (abs(pitch) > 0.01f || abs(roll) > 0.01f || abs(yaw) > 0.01f || abs(throttle) > 0.01f) {
            logFlightParameters(pitch, roll, yaw, throttle)
        }
    }
    
    /**
     * Log detailed flight parameters with interpretation
     */
    private fun logFlightParameters(pitch: Float, roll: Float, yaw: Float, throttle: Float) {
        val timestamp = System.currentTimeMillis()
        
        LogUtils.d("FLIGHT_MAPPING", "Flight Parameters at $timestamp:")
        LogUtils.d("FLIGHT_MAPPING", "  Pitch: ${String.format("%.3f", pitch)} (forward/backward)")
        LogUtils.d("FLIGHT_MAPPING", "  Roll: ${String.format("%.3f", roll)} (left/right)")  
        LogUtils.d("FLIGHT_MAPPING", "  Yaw: ${String.format("%.3f", yaw)} (rotation)")
        LogUtils.d("FLIGHT_MAPPING", "  Throttle: ${String.format("%.3f", throttle)} (up/down)")
        
        // Calculate movement magnitude
        val magnitude = sqrt((pitch * pitch + roll * roll + yaw * yaw + throttle * throttle).toDouble())
        LogUtils.d("FLIGHT_MAPPING", "  Movement Magnitude: ${String.format("%.3f", magnitude)}")
        
        // Safety warnings for aggressive movements
        if (abs(pitch) > 0.8f || abs(roll) > 0.8f) {
            LogUtils.w("FLIGHT_SAFETY", "HIGH SPEED MOVEMENT DETECTED! P=${String.format("%.2f", pitch)}, R=${String.format("%.2f", roll)}")
        }
        
        if (abs(yaw) > 0.8f) {
            LogUtils.w("FLIGHT_SAFETY", "RAPID ROTATION DETECTED! Y=${String.format("%.2f", yaw)}")
        }
        
        // Interpret flight command
        val command = interpretFlightCommand(pitch, roll, yaw, throttle)
        if (command.isNotEmpty()) {
            LogUtils.i("FLIGHT_COMMAND", "Interpreted Command: $command")
        }
    }
    
    /**
     * Interpret flight parameters into human-readable commands
     */
    private fun interpretFlightCommand(pitch: Float, roll: Float, yaw: Float, throttle: Float): String {
        val commands = mutableListOf<String>()
        
        // Throttle commands
        when {
            throttle > 0.3f -> commands.add("ASCENDING")
            throttle < -0.3f -> commands.add("DESCENDING")
        }
        
        // Pitch commands  
        when {
            pitch > 0.3f -> commands.add("MOVING_FORWARD")
            pitch < -0.3f -> commands.add("MOVING_BACKWARD")
        }
        
        // Roll commands
        when {
            roll > 0.3f -> commands.add("MOVING_RIGHT")
            roll < -0.3f -> commands.add("MOVING_LEFT")
        }
        
        // Yaw commands
        when {
            yaw > 0.3f -> commands.add("ROTATING_RIGHT")
            yaw < -0.3f -> commands.add("ROTATING_LEFT")
        }
        
        return if (commands.isEmpty()) "HOVERING" else commands.joinToString(" + ")
    }
    
    /**
     * Get current monitoring status
     */
    fun isMonitoring(): Boolean = isMonitoring
    
    /**
     * Get current stick values
     */
    fun getCurrentStickValues(): RCStickValues = currentStickValues.copy()
}