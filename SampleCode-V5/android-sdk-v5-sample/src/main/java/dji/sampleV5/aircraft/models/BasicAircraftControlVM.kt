package dji.sampleV5.aircraft.models

import dji.sdk.keyvalue.key.FlightControllerKey
import android.util.Log
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.sdk.keyvalue.value.flightcontroller.ArmPresentStateMsg
import dji.sdk.keyvalue.value.flightcontroller.FCMotorStartFailureError
import dji.sdk.keyvalue.value.flightcontroller.FcMotorLockMsg
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.et.action
import dji.v5.et.create
import dji.v5.manager.KeyManager
import dji.sdk.keyvalue.key.KeyTools

class BasicAircraftControlVM : DJIViewModel() {

    fun startMotors(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        val unlockMsg = FcMotorLockMsg().apply {
            setMotorDisableCmd(false)
            setDisableCmdType(true)
        }

        FlightControllerKey.KeyLockMotorSetting.create().action(unlockMsg, {
            FlightControllerKey.KeyTurnOnTheMotor.create().action({ emptyMsg ->
                confirmArmState(normal = true)
                val diagnostics = collectMotorDiagnostics()
                if (diagnostics.motorsOn == true) {
                    callback.onSuccess(emptyMsg)
                } else {
                    callback.onFailure(createMotorStateError("Motors failed to remain armed", diagnostics))
                }
            }, { e: IDJIError ->
                callback.onFailure(e)
            })
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun stopMotors(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        val lockMsg = FcMotorLockMsg().apply {
            setMotorDisableCmd(true)
            setDisableCmdType(true)
        }

        FlightControllerKey.KeyLockMotorSetting.create().action(lockMsg, { emptyMsg ->
            confirmArmState(normal = false)
            val diagnostics = collectMotorDiagnostics()
            if (diagnostics.motorsOn == false) {
                callback.onSuccess(emptyMsg)
            } else {
                callback.onFailure(createMotorStateError("Motors failed to disarm", diagnostics))
            }
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun startTakeOff(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        FlightControllerKey.KeyStartTakeoff.create().action({
            callback.onSuccess(it)
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun startLanding(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        FlightControllerKey.KeyStartAutoLanding.create().action({
            callback.onSuccess(it)
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun cancelLanding(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        FlightControllerKey.KeyStopAutoLanding.create().action({
            callback.onSuccess(it)
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun confirmLanding(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        FlightControllerKey.KeyConfirmLanding.create().action({
            callback.onSuccess(it)
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun startReturnToHome(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        FlightControllerKey.KeyStartGoHome.create().action({
            callback.onSuccess(it)
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    fun stopReturnToHome(callback: CommonCallbacks.CompletionCallbackWithParam<EmptyMsg>) {
        FlightControllerKey.KeyStopGoHome.create().action({
            callback.onSuccess(it)
        }, { e: IDJIError ->
            callback.onFailure(e)
        })
    }

    private fun confirmArmState(normal: Boolean) {
        try {
            val keyInfo = if (normal) {
                FlightControllerKey.KeyMGUserConfirmArmStateNormal
            } else {
                FlightControllerKey.KeyMGUserConfirmArmStateAbnormal
            }

            keyInfo.create().action({
                // Intentionally left blank; confirmation is fire-and-forget.
            }, { error: IDJIError ->
                Log.w(TAG, "Arm state confirmation failed: ${error.description()}")
            })
        } catch (ignored: Exception) {
            // Some aircraft do not expose these keys; ignore.
        }
    }

    private data class MotorDiagnostics(
        val motorsOn: Boolean? = null,
        val startFailure: FCMotorStartFailureError? = null,
        val stopReason: FCMotorStartFailureError? = null,
        val lockMotors: Boolean? = null,
        val notAllowStart: Boolean? = null,
        val abnormalLock: Boolean? = null,
        val emergencyStop: Boolean? = null,
        val armPresentState: ArmPresentStateMsg? = null,
        val armRequireTakeoff: Boolean? = null
    )

    private fun collectMotorDiagnostics(): MotorDiagnostics {
        val keyManager = KeyManager.getInstance()

        fun readBoolean(keyInfo: dji.sdk.keyvalue.key.DJIKeyInfo<Boolean>): Boolean? = try {
            keyManager.getValue(KeyTools.createKey(keyInfo)) as? Boolean
        } catch (_: Exception) {
            null
        }

        fun readFailure(keyInfo: dji.sdk.keyvalue.key.DJIKeyInfo<FCMotorStartFailureError>): FCMotorStartFailureError? = try {
            keyManager.getValue(KeyTools.createKey(keyInfo)) as? FCMotorStartFailureError
        } catch (_: Exception) {
            null
        }

        fun readArmState(): ArmPresentStateMsg? = try {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyMGArmPresentState)) as? ArmPresentStateMsg
        } catch (_: Exception) {
            null
        }

        val motorsOn = readBoolean(FlightControllerKey.KeyAreMotorsOn)
        val startFailure = readFailure(FlightControllerKey.KeyMotorStartFailureError)
        val stopReason = readFailure(FlightControllerKey.KeyMotorStopReason)
        val lockMotors = readBoolean(FlightControllerKey.KeyLockMotors)
        val notAllowStart = readBoolean(FlightControllerKey.KeyNotAllowMotorStart)
        val abnormalLock = readBoolean(FlightControllerKey.KeyMotorPowerAbnormalLock)
        val emergencyStop = readBoolean(FlightControllerKey.KeyEmergencyStopMotorEnable)
        val armState = readArmState()
        val armRequire = readBoolean(FlightControllerKey.KeyArmPresentReqTakeOff)

        return MotorDiagnostics(
            motorsOn = motorsOn,
            startFailure = startFailure,
            stopReason = stopReason,
            lockMotors = lockMotors,
            notAllowStart = notAllowStart,
            abnormalLock = abnormalLock,
            emergencyStop = emergencyStop,
            armPresentState = armState,
            armRequireTakeoff = armRequire
        )
    }

    private fun createMotorStateError(message: String, diagnostics: MotorDiagnostics): IDJIError {
        return object : IDJIError {
            override fun errorType(): dji.v5.common.error.ErrorType = dji.v5.common.error.ErrorType.UNKNOWN
            override fun errorCode(): String = "MOTOR_STATE"
            override fun innerCode(): String = "MOTOR_STATE"
            override fun hint(): String = buildDiagnosticMessage()
            override fun description(): String = buildDiagnosticMessage()
            override fun toString(): String = description()
            override fun isError(code: String): Boolean = code == errorCode()

            private fun buildDiagnosticMessage(): String {
                val parts = mutableListOf<String>()
                diagnostics.motorsOn?.let { parts.add("motors_on=$it") }
                diagnostics.startFailure?.let { parts.add("start_failure=${it.name}") }
                diagnostics.stopReason?.let { parts.add("stop_reason=${it.name}") }
                diagnostics.lockMotors?.let { parts.add("lock_motors=$it") }
                diagnostics.notAllowStart?.let { parts.add("blocked=$it") }
                diagnostics.abnormalLock?.let { parts.add("abnormal_lock=$it") }
                diagnostics.emergencyStop?.let { parts.add("emergency_stop=$it") }
                diagnostics.armRequireTakeoff?.takeIf { it }?.let { parts.add("arm_requires_takeoff_confirmation=true") }
                diagnostics.armPresentState?.let { state ->
                    val engaged = state.toReadableMap().filterValues { it == true }.keys
                    if (engaged.isNotEmpty()) {
                        parts.add("arm_presence=${engaged.joinToString(",")}")
                    }
                }
                return if (parts.isEmpty()) message else "$message (${parts.joinToString(", ")})"
            }
        }
    }

    companion object {
        private const val TAG = "BasicAircraftControl"
    }

    private fun ArmPresentStateMsg.toReadableMap(): Map<String, Boolean?> {
        return mapOf(
            "arm1" to getArm1PresentState(),
            "arm2" to getArm2PresentState(),
            "arm3" to getArm3PresentState(),
            "arm4" to getArm4PresentState(),
            "arm5" to getArm5PresentState(),
            "arm6" to getArm6PresentState()
        )
    }
}
