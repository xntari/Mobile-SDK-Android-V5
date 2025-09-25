package dji.sampleV5.aircraft.data

import android.util.Log
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.virtualstick.VirtualStickManager
import dji.v5.et.create
import dji.v5.et.action
import dji.v5.manager.intelligent.IntelligentFlightManager
import dji.v5.manager.intelligent.flyto.FlyToTarget
import org.json.JSONObject
import java.util.Locale

private const val TAG = "FlightCommandHandler"

class FlightCommandHandler(
    private val runOnUiThread: ((() -> Unit) -> Unit),
    private val sendFlightCommandResponse: (
        clientId: String,
        action: String,
        success: Boolean,
        message: String?,
        error: IDJIError?,
        extra: Map<String, Any?>?
    ) -> Unit,
    private val diagnosticExtrasProvider: (String) -> Map<String, Any?>?,
    private val postActionHook: (clientId: String, action: String, success: Boolean) -> Unit
) {

    private fun respond(
        clientId: String,
        action: String,
        success: Boolean,
        message: String? = null,
        error: IDJIError? = null,
        extra: Map<String, Any?>? = null
    ) {
        val diagnosticExtra = if (!success) diagnosticExtrasProvider(action) else null
        val mergedExtra = mergeExtras(extra, diagnosticExtra)
        sendFlightCommandResponse(clientId, action, success, message, error, mergedExtra)
        postActionHook(clientId, action, success)
    }

    private fun mergeExtras(
        primary: Map<String, Any?>?,
        diagnostic: Map<String, Any?>?
    ): Map<String, Any?>? {
        if (primary == null && diagnostic == null) return null
        if (diagnostic == null) return primary
        if (primary == null) return diagnostic
        val merged = primary.toMutableMap()
        diagnostic.forEach { (key, value) ->
            merged[key] = value
        }
        return merged
    }

    fun handle(clientId: String, command: JSONObject) {
        Log.i(TAG, "Flight command from $clientId: $command")

        val data = command.optJSONObject("data")
        if (data == null) {
            respond(clientId, "unknown", false, message = "flight_command missing data payload")
            return
        }

        val actionRaw = data.optString("action", "")
        val action = actionRaw.lowercase(Locale.ROOT)
        if (action.isBlank()) {
            respond(clientId, actionRaw.ifBlank { "unknown" }, false, message = "flight_command requires an action")
            return
        }

        val params = data.optJSONObject("params")

        when (action) {
            "arm_motors" -> {
                Log.w(TAG, "Deprecated arm_motors command from $clientId")
                respond(clientId, action, false, message = "Manual motor control deprecated; use takeoff/land")
            }

            "arm_motors_virtual" -> {
                Log.w(TAG, "Deprecated arm_motors_virtual command from $clientId")
                respond(clientId, action, false, message = "Manual motor control deprecated; use takeoff/land")
            }

            "disarm_motors" -> {
                Log.w(TAG, "Deprecated disarm_motors command from $clientId")
                respond(clientId, action, false, message = "Manual motor control deprecated; use land")
            }

            "compass_calibrate_start" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStartCompassCalibration.create().action({ success(it) }, failure)
            }

            "compass_calibrate_stop" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStopCompassCalibration.create().action({ success(it) }, failure)
            }

            "takeoff" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStartTakeoff.create().action({ success(it) }, failure)
            }

            "land" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStartAutoLanding.create().action({ success(it) }, failure)
            }

            "cancel_landing" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStopAutoLanding.create().action({ success(it) }, failure)
            }

            "confirm_landing" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyConfirmLanding.create().action({ success(it) }, failure)
            }

            "return_home_start" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStartGoHome.create().action({ success(it) }, failure)
            }

            "return_home_stop" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStopGoHome.create().action({ success(it) }, failure)
            }

            "force_land_start" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyConfirmLanding.create().action({ success(it) }, failure)
            }

            "force_land_stop" -> performFlightControllerAction(clientId, action) { success, failure ->
                FlightControllerKey.KeyStopAutoLanding.create().action({ success(it) }, failure)
            }

            "virtual_stick_enable" -> toggleVirtualStick(clientId, action, true)
            "virtual_stick_disable" -> toggleVirtualStick(clientId, action, false)
            "virtual_stick_override" -> handleVirtualStickOverride(clientId, action, params)
            "fly_to_prepare" -> handleFlyToPrepare(clientId, action, params)

            else -> {
                Log.w(TAG, "Unsupported flight command action '$actionRaw' from $clientId")
                respond(clientId, actionRaw, false, message = "unsupported action")
            }
        }
    }

    private fun performFlightControllerAction(
        clientId: String,
        action: String,
        executor: (success: (EmptyMsg?) -> Unit, failure: (IDJIError) -> Unit) -> Unit
    ) {
        runOnUiThread {
            try {
                executor(
                    { respond(clientId, action, true) },
                    { error -> respond(clientId, action, false, error = error) }
                )
            } catch (e: Exception) {
                Log.e(TAG, "Flight action '$action' failed: ${e.message}", e)
                respond(clientId, action, false, message = e.message ?: "exception")
            }
        }
    }

    private fun toggleVirtualStick(clientId: String, action: String, enable: Boolean) {
        runOnUiThread {
            try {
                val manager = VirtualStickManager.getInstance()
                val callback = object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        respond(clientId, action, true, extra = mapOf("enabled" to enable))
                    }

                    override fun onFailure(error: IDJIError) {
                        respond(clientId, action, false, error = error)
                    }
                }
                if (enable) {
                    manager.enableVirtualStick(callback)
                } else {
                    manager.disableVirtualStick(callback)
                }
            } catch (e: Exception) {
                Log.e(TAG, "toggleVirtualStick($enable) failed: ${e.message}", e)
                respond(clientId, action, false, message = e.message ?: "exception")
            }
        }
    }

    private fun handleVirtualStickOverride(clientId: String, action: String, params: JSONObject?) {
        if (params == null) {
            respond(clientId, action, false, message = "virtual_stick_override requires params")
            return
        }

        val yaw = params.optDouble("yaw", Double.NaN)
        val throttle = params.optDouble("throttle", Double.NaN)
        val roll = params.optDouble("roll", Double.NaN)
        val pitch = params.optDouble("pitch", Double.NaN)

        runOnUiThread {
            try {
                val manager = VirtualStickManager.getInstance()
                val leftHorizontal = mapNormalizedStickValue(yaw)
                val leftVertical = mapNormalizedStickValue(throttle)
                val rightHorizontal = mapNormalizedStickValue(roll)
                val rightVertical = mapNormalizedStickValue(pitch)

                manager.leftStick.horizontalPosition = leftHorizontal
                manager.leftStick.verticalPosition = leftVertical
                manager.rightStick.horizontalPosition = rightHorizontal
                manager.rightStick.verticalPosition = rightVertical

                val extra = mapOf(
                    "joystick" to mapOf(
                        "left_horizontal" to leftHorizontal,
                        "left_vertical" to leftVertical,
                        "right_horizontal" to rightHorizontal,
                        "right_vertical" to rightVertical
                    )
                )
                respond(clientId, action, true, extra = extra)
            } catch (e: Exception) {
                Log.e(TAG, "virtual_stick_override failed: ${e.message}", e)
                respond(clientId, action, false, message = e.message ?: "exception")
            }
        }
    }

    private fun mapNormalizedStickValue(value: Double): Int {
        if (value.isNaN()) return 0
        val normalized = value.coerceIn(-1.0, 1.0)
        return (normalized * 660).toInt().coerceIn(-660, 660)
    }

    private fun handleFlyToPrepare(clientId: String, action: String, params: JSONObject?) {
        if (params == null) {
            respond(clientId, action, false, message = "fly_to_prepare requires params")
            return
        }

        val targetJson = params.optJSONObject("target_location")
        if (targetJson == null) {
            respond(clientId, action, false, message = "fly_to_prepare requires target_location")
            return
        }

        val latitude = targetJson.optDouble("latitude", Double.NaN)
        val longitude = targetJson.optDouble("longitude", Double.NaN)
        if (latitude.isNaN() || longitude.isNaN()) {
            respond(clientId, action, false, message = "target_location must include latitude and longitude")
            return
        }

        val altitude = if (targetJson.has("altitude")) targetJson.optDouble("altitude", Double.NaN) else Double.NaN
        val maxSpeed = if (params.has("max_speed")) params.optDouble("max_speed", Double.NaN) else Double.NaN
        val securityTakeoffHeight = if (params.has("security_takeoff_height")) params.optDouble("security_takeoff_height", Double.NaN) else Double.NaN
        val mode = params.optString("mode", "")

        val targetLocation = LocationCoordinate3D(latitude, longitude, if (altitude.isNaN()) 0.0 else altitude)
        val flyToTarget = FlyToTarget().apply {
            this.targetLocation = targetLocation
            if (!altitude.isNaN()) {
                this.targetLocation.altitude = altitude
            }
            if (!maxSpeed.isNaN()) {
                this.maxSpeed = maxSpeed.toInt()
            }
            if (!securityTakeoffHeight.isNaN()) {
                this.securityTakeoffHeight = securityTakeoffHeight.toInt()
            }
        }

        fun buildTargetExtra(): Map<String, Any?> {
            val locationExtra = mutableMapOf(
                "latitude" to latitude,
                "longitude" to longitude,
                "altitude" to if (altitude.isNaN()) null else altitude
            )
            val extra = mutableMapOf<String, Any?>(
                "target_location" to locationExtra
            )
            if (!maxSpeed.isNaN()) {
                extra["max_speed"] = maxSpeed
            }
            if (!securityTakeoffHeight.isNaN()) {
                extra["security_takeoff_height"] = securityTakeoffHeight
            }
            if (mode.isNotBlank()) {
                extra["mode"] = mode
            }
            return extra
        }

        runOnUiThread {
            try {
                IntelligentFlightManager.getInstance().flyToMissionManager.startMission(
                    flyToTarget,
                    null,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() {
                            respond(clientId, action, true, extra = buildTargetExtra())
                        }

                        override fun onFailure(error: IDJIError) {
                            respond(clientId, action, false, error = error, extra = buildTargetExtra())
                        }
                    }
                )
            } catch (e: Exception) {
                Log.e(TAG, "fly_to_prepare failed: ${e.message}", e)
                respond(
                    clientId,
                    action,
                    false,
                    message = e.message ?: "exception",
                    extra = buildTargetExtra()
                )
            }
        }
    }
}
