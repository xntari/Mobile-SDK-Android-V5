package dji.sampleV5.aircraft.models

import androidx.lifecycle.MutableLiveData
import dji.sdk.keyvalue.key.RemoteControllerKey
import dji.sdk.keyvalue.value.flightcontroller.*
import dji.v5.common.callback.CommonCallbacks
import dji.v5.et.create
import dji.v5.et.listen
import dji.v5.manager.KeyManager
import dji.v5.manager.aircraft.virtualstick.VirtualStickManager
import dji.v5.manager.aircraft.virtualstick.VirtualStickState
import dji.v5.manager.aircraft.virtualstick.VirtualStickStateListener
import dji.v5.utils.common.LogUtils

/**
 * Class Description
 *
 * @author Hoker
 * @date 2021/6/18
 *
 * Copyright (c) 2021, DJI All Rights Reserved.
 */
class VirtualStickVM : DJIViewModel() {

    val currentSpeedLevel = MutableLiveData(0.0)
    var useRcStick = MutableLiveData(false)
    val currentVirtualStickStateInfo = MutableLiveData(VirtualStickStateInfo())

    val virtualStickAdvancedParam = MutableLiveData(VirtualStickFlightControlParam()).apply {
        value?.rollPitchCoordinateSystem = FlightCoordinateSystem.BODY
        value?.verticalControlMode = VerticalControlMode.VELOCITY
        value?.yawControlMode = YawControlMode.ANGULAR_VELOCITY
        value?.rollPitchControlMode = RollPitchControlMode.ANGLE
    }

    // RC Stick Value
    var stickValue = MutableLiveData(RCStickValue(0, 0, 0, 0))

    init {
        currentSpeedLevel.value = VirtualStickManager.getInstance().speedLevel
        VirtualStickManager.getInstance().setVirtualStickStateListener(object :
            VirtualStickStateListener {
            override fun onVirtualStickStateUpdate(stickState: VirtualStickState) {
                currentVirtualStickStateInfo.postValue(currentVirtualStickStateInfo.value?.apply {
                    this.state = stickState
                })
            }

            override fun onChangeReasonUpdate(reason: FlightControlAuthorityChangeReason) {
                currentVirtualStickStateInfo.postValue(currentVirtualStickStateInfo.value?.apply {
                    this.reason = reason
                })
            }
        })
    }

    fun enableVirtualStick(callback: CommonCallbacks.CompletionCallback) {
        VirtualStickManager.getInstance().enableVirtualStick(callback)
    }

    fun disableVirtualStick(callback: CommonCallbacks.CompletionCallback) {
        VirtualStickManager.getInstance().disableVirtualStick(callback)
    }

    fun setSpeedLevel(speedLevel: Double) {
        VirtualStickManager.getInstance().speedLevel = speedLevel
        currentSpeedLevel.value = speedLevel
    }

    fun setLeftPosition(horizontal: Int, vertical: Int) {
        VirtualStickManager.getInstance().leftStick.horizontalPosition = horizontal
        VirtualStickManager.getInstance().leftStick.verticalPosition = vertical
        
        // Enhanced joystick debug logging
        logJoystickInput("LeftStick", horizontal, vertical)
        
        // Log flight mapping when sticks are moved
        logCurrentFlightMapping()
    }

    fun setRightPosition(horizontal: Int, vertical: Int) {
        VirtualStickManager.getInstance().rightStick.horizontalPosition = horizontal
        VirtualStickManager.getInstance().rightStick.verticalPosition = vertical
        
        // Enhanced joystick debug logging
        logJoystickInput("RightStick", horizontal, vertical)
        
        // Log flight mapping when sticks are moved
        logCurrentFlightMapping()
    }

    fun sendVirtualStickAdvancedParam(param: VirtualStickFlightControlParam) {
        VirtualStickManager.getInstance().sendVirtualStickAdvancedParam(param)
        
        // Enhanced virtual stick parameter logging
        logVirtualStickParams(param)
    }

    fun disableVirtualStickAdvancedMode() {
        VirtualStickManager.getInstance().setVirtualStickAdvancedModeEnabled(false)
    }

    fun enableVirtualStickAdvancedMode() {
        VirtualStickManager.getInstance().setVirtualStickAdvancedModeEnabled(true)
    }

    fun listenRCStick() {
        LogUtils.i("RC_STICK_MONITOR", "Starting RC stick monitoring...")
        
        RemoteControllerKey.KeyStickLeftHorizontal.create().listen(this) {
            it?.let {
                stickValue.value?.leftHorizontal = it
                LogUtils.d("RC_STICK_MONITOR", "Left Horizontal: $it")
            }
            tryUpdateVirtualStickByRc()
        }
        RemoteControllerKey.KeyStickLeftVertical.create().listen(this) {
            it?.let {
                stickValue.value?.leftVertical = it
                LogUtils.d("RC_STICK_MONITOR", "Left Vertical: $it")
            }
            tryUpdateVirtualStickByRc()
        }
        RemoteControllerKey.KeyStickRightHorizontal.create().listen(this) {
            it?.let {
                stickValue.value?.rightHorizontal = it
                LogUtils.d("RC_STICK_MONITOR", "Right Horizontal: $it")
            }
            tryUpdateVirtualStickByRc()
        }
        RemoteControllerKey.KeyStickRightVertical.create().listen(this) {
            it?.let {
                stickValue.value?.rightVertical = it
                LogUtils.d("RC_STICK_MONITOR", "Right Vertical: $it")
            }
            tryUpdateVirtualStickByRc()
        }
    }

    private fun tryUpdateVirtualStickByRc() {
        stickValue.postValue(stickValue.value)
        
        // Enhanced RC stick monitoring with flight parameters
        stickValue.value?.let { rcStick ->
            LogUtils.d("RC_STICK_MONITOR", "RC Stick Values: " +
                "LH=${rcStick.leftHorizontal}, LV=${rcStick.leftVertical}, " +
                "RH=${rcStick.rightHorizontal}, RV=${rcStick.rightVertical}")
            
            // Log virtual stick command interpretation
            val yaw = rcStick.leftHorizontal.toFloat() / 100.0f  // Normalize to -1.0 to 1.0
            val throttle = rcStick.leftVertical.toFloat() / 100.0f
            val pitch = rcStick.rightVertical.toFloat() / 100.0f
            val roll = rcStick.rightHorizontal.toFloat() / 100.0f
            
            LogUtils.d("VIRTUAL_STICK_CMD", "Virtual Stick Commands: " +
                "P=${String.format("%.2f", pitch)}, R=${String.format("%.2f", roll)}, " +
                "Y=${String.format("%.2f", yaw)}, T=${String.format("%.2f", throttle)}")
        }
        
        if (useRcStick.value == true) {
            stickValue.value?.apply {
                setLeftPosition(leftHorizontal, leftVertical)
                setRightPosition(rightHorizontal, rightVertical)
            }
        }
    }

    override fun onCleared() {
        KeyManager.getInstance().cancelListen(this)
        VirtualStickManager.getInstance().clearAllVirtualStickStateListener()
    }

    /**
     * Enhanced joystick input logging for development debugging
     * Logs joystick inputs with detailed movement analysis
     */
    private fun logJoystickInput(stickType: String, horizontal: Int, vertical: Int) {
        val timestamp = System.currentTimeMillis()
        val horizontalPercent = horizontal.toFloat() / 100.0f
        val verticalPercent = vertical.toFloat() / 100.0f
        
        // Detailed joystick logging
        LogUtils.d("JOYSTICK_INPUT", "$stickType Input: " +
            "H=${horizontal} (${String.format("%.2f", horizontalPercent)}%), " +
            "V=${vertical} (${String.format("%.2f", verticalPercent)}%) " +
            "at ${timestamp}")
        
        // Movement direction analysis
        val direction = when {
            horizontal == 0 && vertical == 0 -> "CENTER"
            horizontal > 10 && vertical > 10 -> "UP-RIGHT"
            horizontal > 10 && vertical < -10 -> "DOWN-RIGHT"
            horizontal < -10 && vertical > 10 -> "UP-LEFT"
            horizontal < -10 && vertical < -10 -> "DOWN-LEFT"
            horizontal > 10 -> "RIGHT"
            horizontal < -10 -> "LEFT"
            vertical > 10 -> "UP"
            vertical < -10 -> "DOWN"
            else -> "MICRO-MOVEMENT"
        }
        
        if (direction != "CENTER" && direction != "MICRO-MOVEMENT") {
            LogUtils.d("JOYSTICK_DIRECTION", "$stickType Direction: $direction " +
                "Magnitude: ${String.format("%.2f", kotlin.math.sqrt((horizontalPercent * horizontalPercent + verticalPercent * verticalPercent).toDouble()))}")
        }
    }

    /**
     * Enhanced virtual stick command logging
     * Logs virtual stick parameters with flight control interpretation
     */
    private fun logVirtualStickParams(param: VirtualStickFlightControlParam) {
        val timestamp = System.currentTimeMillis()
        
        LogUtils.d("VIRTUAL_STICK_PARAMS", "Virtual Stick Advanced Parameters at $timestamp:")
        LogUtils.d("VIRTUAL_STICK_PARAMS", "  Coordinate System: ${param.rollPitchCoordinateSystem}")
        LogUtils.d("VIRTUAL_STICK_PARAMS", "  Vertical Control: ${param.verticalControlMode}")
        LogUtils.d("VIRTUAL_STICK_PARAMS", "  Yaw Control: ${param.yawControlMode}")
        LogUtils.d("VIRTUAL_STICK_PARAMS", "  Roll/Pitch Control: ${param.rollPitchControlMode}")
        
        // Log current stick positions for correlation
        val leftStick = VirtualStickManager.getInstance().leftStick
        val rightStick = VirtualStickManager.getInstance().rightStick
        
        LogUtils.d("VIRTUAL_STICK_POSITION", "Current Stick Positions: " +
            "Left(${leftStick.horizontalPosition}, ${leftStick.verticalPosition}), " +
            "Right(${rightStick.horizontalPosition}, ${rightStick.verticalPosition})")
    }

    /**
     * Real-time joystick input verification with flight parameter mapping
     * Maps raw joystick inputs to flight control parameters
     */
    fun logJoystickFlightMapping(pitch: Float, roll: Float, yaw: Float, throttle: Float) {
        val timestamp = System.currentTimeMillis()
        
        // Original VirtualStick tag for compatibility with DEVELOPMENT_SETUP.md
        LogUtils.d("VirtualStick", "Input: P=${String.format("%.3f", pitch)}, R=${String.format("%.3f", roll)}, Y=${String.format("%.3f", yaw)}, T=${String.format("%.3f", throttle)}")
        
        LogUtils.d("FLIGHT_MAPPING", "Flight Parameters at $timestamp:")
        LogUtils.d("FLIGHT_MAPPING", "  Pitch: ${String.format("%.3f", pitch)} (forward/backward)")
        LogUtils.d("FLIGHT_MAPPING", "  Roll: ${String.format("%.3f", roll)} (left/right)")
        LogUtils.d("FLIGHT_MAPPING", "  Yaw: ${String.format("%.3f", yaw)} (rotation)")
        LogUtils.d("FLIGHT_MAPPING", "  Throttle: ${String.format("%.3f", throttle)} (up/down)")
        
        // Flight safety warnings
        if (kotlin.math.abs(pitch) > 0.8f || kotlin.math.abs(roll) > 0.8f) {
            LogUtils.w("FLIGHT_SAFETY", "HIGH SPEED MOVEMENT DETECTED! P=${String.format("%.2f", pitch)}, R=${String.format("%.2f", roll)}")
        }
        
        if (kotlin.math.abs(yaw) > 0.8f) {
            LogUtils.w("FLIGHT_SAFETY", "RAPID ROTATION DETECTED! Y=${String.format("%.2f", yaw)}")
        }
        
        // Command interpretation
        val command = interpretFlightCommand(pitch, roll, yaw, throttle)
        if (command.isNotEmpty()) {
            LogUtils.i("FLIGHT_COMMAND", "Interpreted Command: $command")
        }
    }

    /**
     * Interprets flight parameters into human-readable commands
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
     * Logs current flight mapping based on current stick positions
     */
    private fun logCurrentFlightMapping() {
        val leftStick = VirtualStickManager.getInstance().leftStick
        val rightStick = VirtualStickManager.getInstance().rightStick
        
        // Convert stick positions to normalized flight parameters (-1.0 to 1.0)
        val yaw = leftStick.horizontalPosition.toFloat() / 100.0f        // Left horizontal = Yaw
        val throttle = leftStick.verticalPosition.toFloat() / 100.0f     // Left vertical = Throttle
        val pitch = rightStick.verticalPosition.toFloat() / 100.0f       // Right vertical = Pitch
        val roll = rightStick.horizontalPosition.toFloat() / 100.0f      // Right horizontal = Roll
        
        // Only log if there's actual movement (avoid spam from zero positions)
        if (kotlin.math.abs(pitch) > 0.01f || kotlin.math.abs(roll) > 0.01f || 
            kotlin.math.abs(yaw) > 0.01f || kotlin.math.abs(throttle) > 0.01f) {
            logJoystickFlightMapping(pitch, roll, yaw, throttle)
        }
    }

    data class VirtualStickStateInfo(
        var state: VirtualStickState = VirtualStickState(false, FlightControlAuthority.UNKNOWN, false),
        var reason: FlightControlAuthorityChangeReason = FlightControlAuthorityChangeReason.UNKNOWN
    )

    data class RCStickValue(
        var leftHorizontal: Int, var leftVertical:
        Int, var rightHorizontal: Int, var rightVertical: Int
    ) {
        override fun toString(): String {
            return "leftHorizontal=$leftHorizontal,leftVertical=$leftVertical,\n" +
                    "rightHorizontal=$rightHorizontal,rightVertical=$rightVertical"
        }
    }
}