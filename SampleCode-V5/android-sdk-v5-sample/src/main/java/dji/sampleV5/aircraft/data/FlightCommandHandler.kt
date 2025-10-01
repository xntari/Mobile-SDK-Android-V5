package dji.sampleV5.aircraft.data

import android.util.Log
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.virtualstick.VirtualStickManager
import dji.v5.common.utils.GpsUtils
import dji.v5.et.create
import dji.v5.et.action
import dji.v5.manager.intelligent.IntelligentFlightManager
import dji.sdk.keyvalue.value.flightcontroller.FlyToMode
import dji.v5.manager.intelligent.flyto.FlyToParam
import dji.v5.manager.intelligent.flyto.FlyToTarget
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.v5.manager.KeyManager
import dji.v5.manager.diagnostic.DeviceStatusManager
import android.util.Base64
import dji.v5.manager.aircraft.simulator.InitializationSettings
import dji.v5.manager.aircraft.simulator.SimulatorManager
import dji.sdk.wpmz.value.mission.WaylineFinishedAction
import dji.sdk.keyvalue.value.flightcontroller.FailsafeAction
import dji.sampleV5.aircraft.models.FlySafeBridgeModel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import kotlin.math.roundToInt

private const val TAG = "FlightCommandHandler"
private const val DEFAULT_SIMULATOR_SATELLITES = 12
private const val SIMULATOR_MIN_SATELLITES = 6
private const val SIMULATOR_MAX_SATELLITES = 20
private const val SIMULATOR_SOURCE_DEFAULT = "flight_commands"

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
    private val postActionHook: (clientId: String, action: String, success: Boolean) -> Unit,
    private val flySafeSnapshotProvider: (() -> Map<String, Any?>?)? = null,
    private val flyToStatusProvider: (() -> Map<String, Any?>?)? = null,
    private val waypointMissionExecutor: WaypointMissionExecutor? = null,
    private val simulatorBridgeModel: SimulatorBridgeModel? = null,
    private val flySafeBridgeModel: FlySafeBridgeModel? = null,
    private val remoteIdBridgeModel: RemoteIDBridgeModel? = null
) {

    private fun respond(
        clientId: String,
        action: String,
        success: Boolean,
        message: String? = null,
        error: IDJIError? = null,
        extra: Map<String, Any?>? = null
    ) {
        val enrichedExtra = attachSimulatorExtra(extra)
        val diagnosticExtra = if (!success) diagnosticExtrasProvider(action) else null
        val mergedExtra = mergeExtras(enrichedExtra, diagnosticExtra)
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

    private fun attachSimulatorExtra(extra: Map<String, Any?>?): Map<String, Any?>? {
        val snapshot = simulatorBridgeModel?.statusSnapshot() ?: return extra
        val map = extra?.toMutableMap() ?: mutableMapOf()
        map["simulator"] = snapshot
        return map
    }

    private fun locationToMap(location: LocationCoordinate2D?): Map<String, Any?>? {
        if (location == null) return null
        if (!GpsUtils.isValid(location.latitude, location.longitude)) return null
        return mapOf(
            "latitude" to location.latitude,
            "longitude" to location.longitude
        )
    }

    private fun locationToMap(location: LocationCoordinate3D?): Map<String, Any?>? {
        if (location == null) return null
        if (!GpsUtils.isValid(location.latitude, location.longitude)) return null
        return mapOf(
            "latitude" to location.latitude,
            "longitude" to location.longitude,
            "altitude" to location.altitude
        )
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

            "set_home_current" -> handleSetHomeCurrent(clientId, action)

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
            "waypoint_pause" -> handleWaypointPause(clientId, action)
            "waypoint_resume" -> handleWaypointResume(clientId, action)
            "waypoint_stop" -> handleWaypointStop(clientId, action)
            "waypoint_load_kmz" -> handleWaypointLoadKmz(clientId, action, params)
            "waypoint_execute_plan" -> handleWaypointExecutePlan(clientId, action, params)
            "simulator_enable" -> handleSimulatorEnable(clientId, action, params)
            "simulator_disable" -> handleSimulatorDisable(clientId, action)
            "flight_settings_update" -> handleFlightSettingsUpdate(clientId, action, params)
            "remote_id_update" -> handleRemoteIdUpdate(clientId, action, params)
            "flysafe_refresh" -> handleFlySafeRefresh(clientId, action)

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

    private fun handleSetHomeCurrent(clientId: String, action: String) {
        runOnUiThread {
            val keyManager = runCatching { KeyManager.getInstance() }.getOrNull()
            if (keyManager == null) {
                respond(clientId, action, false, message = "KeyManager unavailable")
                return@runOnUiThread
            }

            val previousHome = runCatching {
                keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) as? LocationCoordinate2D
            }.getOrNull()

            val aircraftLocation = runCatching {
                keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D)) as? LocationCoordinate3D
            }.getOrNull()

            val extra = mutableMapOf<String, Any?>()
            locationToMap(previousHome)?.let { extra["previous_home"] = it }
            locationToMap(aircraftLocation)?.let { extra["aircraft_location"] = it }

            try {
                val actionKey = KeyTools.createKey(FlightControllerKey.KeyHomeLocationUsingCurrentAircraftLocation)
                actionKey.action(
                    onSuccess = { _: EmptyMsg? ->
                        val newHome = runCatching {
                            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) as? LocationCoordinate2D
                        }.getOrNull()
                        locationToMap(newHome)?.let { extra["new_home"] = it }
                        respond(clientId, action, true, extra = extra)
                    },
                    onFailure = { error: IDJIError ->
                        respond(clientId, action, false, error = error, extra = extra)
                    }
                )
            } catch (e: Exception) {
                Log.e(TAG, "set_home_current failed: ${e.message}", e)
                extra["error_type"] = e.javaClass.simpleName
                respond(clientId, action, false, message = e.message ?: "exception", extra = extra)
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
        val modeRaw = if (params.has("mode")) params.optString("mode") else null
        val flyToMode = parseFlyToMode(modeRaw)
        val flyToHeightMeters = if (params.has("fly_to_height")) {
            params.optDouble("fly_to_height", Double.NaN).takeUnless { it.isNaN() || !it.isFinite() }
        } else null

        if (flyToMode == FlyToMode.SET_HEIGHT && flyToHeightMeters == null) {
            respond(clientId, action, false, message = "fly_to_height required when mode=set_height")
            return
        }

        val targetAltitude = if (altitude.isNaN()) null else altitude
        val targetLocation = LocationCoordinate3D(latitude, longitude, targetAltitude ?: 0.0)
        val flyToTarget = FlyToTarget().apply {
            this.targetLocation = targetLocation
            if (targetAltitude != null) {
                this.targetLocation.altitude = targetAltitude
            }
            maxSpeed.takeUnless { it.isNaN() }?.let { speed ->
                this.maxSpeed = speed.roundToInt()
            }
            securityTakeoffHeight.takeUnless { it.isNaN() }?.let { height ->
                this.securityTakeoffHeight = height.roundToInt()
            }
        }

        val maxSpeedMeters = maxSpeed.takeUnless { it.isNaN() }
        val securityTakeoffHeightMeters = securityTakeoffHeight.takeUnless { it.isNaN() }
        val altitudeSpecified = targetAltitude != null
        val flyToHeightInt = flyToHeightMeters?.roundToInt()

        val capabilitySnapshot = flyToStatusProvider?.invoke()
        val supportedModes = (capabilitySnapshot?.get("capability") as? Map<*, *>)
            ?.get("supported_modes") as? List<*>

        val baseExtra = buildFlyToExtra(
            targetLocation = targetLocation,
            targetAltitude = targetAltitude,
            altitudeSpecified = altitudeSpecified,
            maxSpeed = maxSpeedMeters,
            securityTakeoffHeight = securityTakeoffHeightMeters,
            mode = flyToMode,
            flyToHeight = flyToHeightInt
        )

        val shouldUseWaypointBackend = supportedModes.isNullOrEmpty()
        if (shouldUseWaypointBackend) {
            attemptWaypointFallback(
                clientId = clientId,
                action = action,
                request = WaypointMissionExecutor.Request(
                    targetLocation = targetLocation,
                    targetAltitudeAsl = targetAltitude,
                    mode = flyToMode,
                    flyToHeight = flyToHeightInt,
                    maxSpeed = maxSpeedMeters,
                    securityTakeoffHeight = securityTakeoffHeightMeters,
                    reason = "intelligent_fly_to_unsupported",
                    plan = emptyList()
                ),
                baseExtra = baseExtra,
                message = "Fallback to waypoint mission: intelligent_fly_to_unsupported"
            )
            return
        }

        var fallbackAttempted = false

        runOnUiThread {
            try {
                val flyToManager = IntelligentFlightManager.getInstance().flyToMissionManager
                val paramSteps = mutableListOf<Map<String, Any?>>()

                fun respondWithStatus(
                    success: Boolean,
                    paramStatus: String,
                    error: IDJIError? = null,
                    message: String? = null
                ) {
                    val extra = baseExtra.toMutableMap().apply {
                        put("fly_to_param_update", paramStatus)
                        message?.let { put("fly_to_param_message", it) }
                        error?.let { err ->
                            put("fly_to_param_error", err.description())
                        }
                        if (paramSteps.isNotEmpty()) {
                            put("fly_to_param_steps", paramSteps.toList())
                        }
                        flyToStatusProvider?.invoke()?.let { put("fly_to_status_snapshot", it) }
                    }
                    if (success) {
                        respond(clientId, action, true, extra = extra)
                    } else {
                        respond(clientId, action, false, message = message, error = error, extra = extra)
                    }
                }

                fun startMission(paramStatus: String, message: String? = null) {
                    flyToManager.startMission(
                        flyToTarget,
                        null,
                        object : CommonCallbacks.CompletionCallback {
                            override fun onSuccess() {
                                Log.i(TAG, "fly_to_prepare succeeded with context: $baseExtra status=$paramStatus")
                                respondWithStatus(success = true, paramStatus = paramStatus, message = message)
                            }

                            override fun onFailure(error: IDJIError) {
                                logFlyToError("start_mission", error)
                                if (!fallbackAttempted && shouldFallbackDueToFlyToError(error)) {
                                    fallbackAttempted = true
                                    attemptWaypointFallback(
                                        clientId = clientId,
                                        action = action,
                                        request = WaypointMissionExecutor.Request(
                                            targetLocation = targetLocation,
                                            targetAltitudeAsl = targetAltitude,
                                            mode = flyToMode,
                                            flyToHeight = flyToHeightInt,
                                            maxSpeed = maxSpeedMeters,
                                            securityTakeoffHeight = securityTakeoffHeightMeters,
                                            reason = "start_failed:${error.description() ?: "unknown"}",
                                            plan = emptyList()
                                        ),
                                        baseExtra = baseExtra,
                                        message = error.description() ?: message ?: "start_failed"
                                    )
                                    return
                                } else {
                                    respondWithStatus(success = false, paramStatus = paramStatus, error = error, message = message)
                                }
                            }
                        }
                    )
                }

                val updateQueue = ArrayDeque<Pair<String, FlyToParam>>()
                flyToMode?.let { mode ->
                    updateQueue.add("mode" to FlyToParam().apply { this.flyToMode = mode })
                }
                flyToHeightInt?.let { height ->
                    updateQueue.add("height" to FlyToParam().apply { this.height = height })
                }

                fun runUpdates() {
                    val next = updateQueue.removeFirstOrNull()
                    if (next == null) {
                        val finalStatus = when {
                            paramSteps.any { it["status"] == "failed" } -> "update_failed"
                            paramSteps.isEmpty() -> "skipped"
                            else -> "applied"
                        }
                        val failureMessage = paramSteps.firstOrNull { it["status"] == "failed" }?.get("message") as? String
                        startMission(paramStatus = finalStatus, message = failureMessage)
                        return
                    }

                    val (label, param) = next
                    flyToManager.updateMissionParam(
                        param,
                        object : CommonCallbacks.CompletionCallback {
                            override fun onSuccess() {
                                paramSteps.add(
                                    mapOf(
                                        "type" to label,
                                        "status" to "ok"
                                    )
                                )
                                runUpdates()
                            }

                            override fun onFailure(error: IDJIError) {
                                val message = error.description() ?: "$label update failed"
                                logFlyToError("update_$label", error)
                                if (!fallbackAttempted && shouldFallbackDueToFlyToError(error)) {
                                    fallbackAttempted = true
                                    attemptWaypointFallback(
                                        clientId = clientId,
                                        action = action,
                                       request = WaypointMissionExecutor.Request(
                                           targetLocation = targetLocation,
                                           targetAltitudeAsl = targetAltitude,
                                           mode = flyToMode,
                                           flyToHeight = flyToHeightInt,
                                           maxSpeed = maxSpeedMeters,
                                           securityTakeoffHeight = securityTakeoffHeightMeters,
                                            reason = "update_param_failed:${message}",
                                            plan = emptyList()
                                       ),
                                        baseExtra = baseExtra,
                                        message = message
                                    )
                                    return
                                } else {
                                    paramSteps.add(
                                        mapOf(
                                            "type" to label,
                                            "status" to "failed",
                                            "message" to message
                                        )
                                    )
                                    startMission(paramStatus = "update_failed", message = message)
                                }
                            }
                        }
                    )
                }

                if (updateQueue.isEmpty()) {
                    startMission(paramStatus = "skipped")
                } else {
                    runUpdates()
                }
            } catch (e: Exception) {
                Log.e(TAG, "fly_to_prepare failed: ${e.message}", e)
                val extra = buildFlyToExtra(
                    targetLocation = targetLocation,
                    targetAltitude = targetAltitude,
                    altitudeSpecified = altitudeSpecified,
                    maxSpeed = maxSpeedMeters,
                    securityTakeoffHeight = securityTakeoffHeightMeters,
                    mode = flyToMode,
                    flyToHeight = flyToHeightInt
                ).toMutableMap().apply {
                    put("fly_to_param_update", "exception")
                    put("fly_to_param_message", e.message ?: "exception")
                }
                respond(clientId, action, false, message = e.message ?: "exception", extra = extra)
            }
        }
    }

    private fun attemptWaypointFallback(
        clientId: String,
        action: String,
        request: WaypointMissionExecutor.Request,
        baseExtra: Map<String, Any?>,
        message: String
    ) {
        val executor = waypointMissionExecutor
        val extra = baseExtra.toMutableMap().apply {
            this["backend"] = "waypoint_v2"
            this["fly_to_param_update"] = "waypoint_fallback"
            this["fly_to_param_message"] = message

            val steps = (this["fly_to_param_steps"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> }?.toMutableList()
                ?: mutableListOf()
            steps.add(
                mapOf(
                    "type" to "backend",
                    "status" to "waypoint_v2",
                    "message" to message
                )
            )
            this["fly_to_param_steps"] = steps
        }

        if (executor == null) {
            respond(
                clientId,
                action,
                false,
                message = "Waypoint mission fallback unavailable",
                extra = extra
            )
            return
        }

        executor.execute(request) { result ->
            when (result) {
                is WaypointMissionExecutor.Result.Success -> {
                    val mergedExtra = extra.toMutableMap().apply {
                        result.extra.forEach { (key, value) -> this[key] = value }
                    }
                    respond(clientId, action, true, extra = mergedExtra)
                }
                is WaypointMissionExecutor.Result.Failure -> {
                    val mergedExtra = extra.toMutableMap().apply {
                        result.extra.forEach { (key, value) -> this[key] = value }
                    }
                    respond(clientId, action, false, message = result.message, error = result.error, extra = mergedExtra)
                }
            }
        }
    }

    private fun shouldFallbackDueToFlyToError(error: IDJIError): Boolean {
        val description = error.description()?.uppercase(Locale.ROOT) ?: return false
        return description.contains("REQUEST_HANDLER_NOT_FOUND") || description.contains("NOT_SUPPORTED")
    }

    private fun parseFlyToMode(raw: String?): FlyToMode? {
        if (raw.isNullOrBlank()) return null
        val normalized = raw.trim().uppercase(Locale.ROOT)
        return when (normalized) {
            "SET_HEIGHT", "SET", "HEIGHT" -> FlyToMode.SET_HEIGHT
            "SMART_HEIGHT", "SMART", "AUTO" -> FlyToMode.SMART_HEIGHT
            else -> runCatching { FlyToMode.valueOf(normalized) }.getOrNull()
        }
    }

    private fun buildFlyToExtra(
        targetLocation: LocationCoordinate3D,
        targetAltitude: Double?,
        altitudeSpecified: Boolean,
        maxSpeed: Double?,
        securityTakeoffHeight: Double?,
        mode: FlyToMode?,
        flyToHeight: Int?
    ): Map<String, Any?> {
        val locationExtra = mutableMapOf(
            "latitude" to targetLocation.latitude,
            "longitude" to targetLocation.longitude,
            "altitude" to targetAltitude
        )

        val extra = mutableMapOf<String, Any?>(
            "target_location" to locationExtra
        )

        maxSpeed?.let { extra["max_speed"] = it }
        securityTakeoffHeight?.let { extra["security_takeoff_height"] = it }
        mode?.let { extra["mode"] = it.name.lowercase(Locale.ROOT) }
        flyToHeight?.let { extra["fly_to_height"] = it }

        val context = collectFlyToContext(
            targetAltitude = targetAltitude,
            altitudeSpecified = altitudeSpecified,
            mode = mode,
            maxSpeed = maxSpeed,
            securityTakeoffHeight = securityTakeoffHeight,
            flyToHeight = flyToHeight
        )
        if (context.isNotEmpty()) {
            extra["fly_to_context"] = context
        }

        return extra
    }

    private fun collectFlyToContext(
        targetAltitude: Double?,
        altitudeSpecified: Boolean,
        mode: FlyToMode?,
        maxSpeed: Double?,
        securityTakeoffHeight: Double?,
        flyToHeight: Int?
    ): Map<String, Any?> {
        val context = mutableMapOf<String, Any?>()
        context["timestamp"] = System.currentTimeMillis()
        context["altitude_specified"] = altitudeSpecified
        mode?.let { context["mode"] = it.name.lowercase(Locale.ROOT) }
        maxSpeed?.let { context["max_speed"] = it }
        securityTakeoffHeight?.let { context["security_takeoff_height"] = it }
        flyToHeight?.let { context["requested_height"] = it }

        val keyManager = runCatching { KeyManager.getInstance() }.getOrNull()
        if (keyManager == null) {
            return context
        }

        val altitudeAgl = runCatching {
            (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAltitude)) as? Number)?.toDouble()
        }.getOrNull()
        altitudeAgl?.let { context["current_altitude_agl"] = it }

        val ultrasonicHeight = runCatching {
            when (val raw = keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyUltrasonicHeight))) {
                is Number -> raw.toDouble() / 10.0
                else -> null
            }
        }.getOrNull()
        ultrasonicHeight?.let { context["current_altitude_ultrasonic"] = it }

        val areMotorsOn = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAreMotorsOn)) as? Boolean
        }.getOrNull()
        areMotorsOn?.let { context["motors_on"] = it }

        val homeLocation = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) as? LocationCoordinate2D
        }.getOrNull()
        homeLocation?.let { location ->
            context["home_location"] = mapOf(
                "latitude" to location.latitude,
                "longitude" to location.longitude
            )
        }

        val takeoffAltitudeRaw = runCatching {
            (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyTakeoffLocationAltitude)) as? Number)?.toDouble()
        }.getOrNull()

        val aircraftLocation2D = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation)) as? LocationCoordinate2D
        }.getOrNull()

        val referenceLat = homeLocation?.latitude ?: aircraftLocation2D?.latitude
        val referenceLon = homeLocation?.longitude ?: aircraftLocation2D?.longitude

        var takeoffAltitudeAsl = runCatching {
            if (takeoffAltitudeRaw != null && referenceLat != null && referenceLon != null && !referenceLat.isNaN() && !referenceLon.isNaN()) {
                GpsUtils.egm96Altitude(takeoffAltitudeRaw, referenceLat, referenceLon)
            } else {
                takeoffAltitudeRaw
            }
        }.getOrNull()

        if (takeoffAltitudeAsl == null && altitudeAgl != null) {
            val lat = aircraftLocation2D?.latitude
            val lon = aircraftLocation2D?.longitude
            val currentEllipsoid = (takeoffAltitudeRaw ?: 0.0) + altitudeAgl
            val currentAsl = runCatching {
                if (lat != null && lon != null && !lat.isNaN() && !lon.isNaN()) {
                    GpsUtils.egm96Altitude(currentEllipsoid, lat, lon)
                } else null
            }.getOrNull()
            takeoffAltitudeAsl = currentAsl?.minus(altitudeAgl)
        }

        if (takeoffAltitudeAsl == null && takeoffAltitudeRaw != null) {
            takeoffAltitudeAsl = takeoffAltitudeRaw
        }

        takeoffAltitudeAsl?.let { context["takeoff_altitude_asl"] = it }

        val heightLimitSetting = runCatching {
            (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyHeightLimit)) as? Number)?.toDouble()
        }.getOrNull()
        heightLimitSetting?.let { context["height_limit_setting"] = it }

        val currentLocation = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D)) as? LocationCoordinate3D
        }.getOrNull()
        currentLocation?.let { location ->
            context["current_location"] = mapOf(
                "latitude" to location.latitude,
                "longitude" to location.longitude,
                "altitude" to location.altitude
            )
        }

        targetAltitude?.let { context["target_altitude_asl"] = it }

        val targetRelativeToTakeoff = when {
            targetAltitude != null && takeoffAltitudeAsl != null -> targetAltitude - takeoffAltitudeAsl
            altitudeSpecified && altitudeAgl != null -> altitudeAgl
            else -> null
        }
        targetRelativeToTakeoff?.let { context["target_altitude_relative_takeoff"] = it }

        if (targetAltitude != null && takeoffAltitudeAsl != null && altitudeAgl != null) {
            val currentAsl = takeoffAltitudeAsl + altitudeAgl
            context["target_altitude_margin_from_current"] = targetAltitude - currentAsl
        }

        if (heightLimitSetting != null && targetRelativeToTakeoff != null) {
            val margin = heightLimitSetting - targetRelativeToTakeoff
            context["height_limit_margin"] = margin
            context["likely_height_limit_violation"] = margin < 0
        }

        val flySafeSnapshot = flySafeSnapshotProvider?.invoke()
        val warning = flySafeSnapshot?.get("warning_notification") as? Map<*, *>
        val flySafeHeightLimit = (warning?.get("height_limit") as? Number)?.toDouble()
        flySafeHeightLimit?.let { context["fly_safe_height_limit"] = it }

        if (flySafeHeightLimit != null && targetRelativeToTakeoff != null) {
            val margin = flySafeHeightLimit - targetRelativeToTakeoff
            context["fly_safe_margin"] = margin
            context["likely_fly_safe_violation"] = margin < 0
        }

        warning?.get("event")?.let { context["fly_safe_warning_event"] = it }
        warning?.get("description")?.let { context["fly_safe_warning_description"] = it }

        val deviceStatus = runCatching { DeviceStatusManager.getInstance().currentDJIDeviceStatus }.getOrNull()
        if (deviceStatus != null) {
            context["device_status_raw"] = mapOf<String, Any?>(
                "code" to deviceStatus.statusCode(),
                "label" to deviceStatus.name,
                "description" to deviceStatus.description(),
                "level" to deviceStatus.warningLevel()?.name
            )
        }

        return context
    }

    private fun logFlyToError(stage: String, error: IDJIError) {
        val domain = runCatching {
            error.javaClass.methods.firstOrNull { it.name.equals("errorDomain", true) && it.parameterCount == 0 }?.invoke(error)
        }.getOrNull()
        val code = runCatching {
            val codeObj = error.errorCode()
            codeObj?.let { obj ->
                obj.javaClass.methods.firstOrNull { it.name.equals("code", true) && it.parameterCount == 0 }?.invoke(obj)
            }
        }.getOrNull()
        val snapshot = flyToStatusProvider?.invoke()
        val domainStr = domain ?: "unknown"
        val codeStr = code ?: "unknown"
        Log.w(
            TAG,
            "fly_to_prepare stage=$stage failed: domain=$domainStr code=$codeStr description=${error.description()} capability=${snapshot?.get("capability")}"
        )
    }

    private fun handleWaypointLoadKmz(clientId: String, action: String, params: JSONObject?) {
        val executor = waypointMissionExecutor
        if (executor == null) {
            respond(clientId, action, false, message = "Waypoint executor unavailable")
            return
        }

        if (params == null) {
            respond(clientId, action, false, message = "waypoint_load_kmz requires params")
            return
        }

        val rawName = params.optString("file_name", "").trim()
        val base64Data = params.optString("file_data", "").trim()
        if (rawName.isEmpty() || base64Data.isEmpty()) {
            respond(clientId, action, false, message = "waypoint_load_kmz requires file_name and file_data")
            return
        }

        val sanitizedName = sanitizeKmzFileName(rawName)
        val kmzBytes = try {
            Base64.decode(base64Data, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            respond(clientId, action, false, message = "Invalid KMZ payload: ${e.message}")
            return
        }

        executor.executeExternalKmz(sanitizedName, kmzBytes) { result ->
            when (result) {
                is WaypointMissionExecutor.Result.Success -> respond(clientId, action, true, extra = result.extra)
                is WaypointMissionExecutor.Result.Failure -> respond(clientId, action, false, message = result.message, error = result.error, extra = result.extra)
            }
        }
    }

    private fun handleWaypointExecutePlan(clientId: String, action: String, params: JSONObject?) {
        val executor = waypointMissionExecutor
        if (executor == null) {
            respond(clientId, action, false, message = "Waypoint executor unavailable")
            return
        }

        if (params == null) {
            respond(clientId, action, false, message = "waypoint_execute_plan requires params")
            return
        }

        val planArray = params.optJSONArray("plan")
        if (planArray == null || planArray.length() == 0) {
            respond(clientId, action, false, message = "waypoint_execute_plan requires plan array")
            return
        }

        val planPoints = mutableListOf<WaypointMissionExecutor.PlanPoint>()
        for (i in 0 until planArray.length()) {
            val entry = planArray.optJSONObject(i) ?: continue
            val planPoint = parsePlanPoint(entry)
            if (planPoint == null) {
                val lat = entry.optDouble("latitude", Double.NaN)
                val lon = entry.optDouble("longitude", Double.NaN)
                Log.w(TAG, "Skipping plan waypoint $i due to invalid coordinates: $lat,$lon")
                continue
            }
            planPoints.add(planPoint)
        }

        if (planPoints.isEmpty()) {
            respond(clientId, action, false, message = "No valid waypoints in plan")
            return
        }

        val targetJson = params.optJSONObject("target_location")
        val targetLatitude = targetJson?.optDouble("latitude", Double.NaN) ?: planPoints.last().latitude
        val targetLongitude = targetJson?.optDouble("longitude", Double.NaN) ?: planPoints.last().longitude
        if (targetLatitude.isNaN() || targetLongitude.isNaN()) {
            respond(clientId, action, false, message = "Invalid target coordinates")
            return
        }

        val targetAltitude = targetJson?.optDouble("altitude", Double.NaN)?.takeIf { !it.isNaN() }
        val targetAltitudeAsl = params.optDouble("target_altitude_asl", Double.NaN).takeIf { !it.isNaN() } ?: targetAltitude

        val targetLocation = LocationCoordinate3D(
            targetLatitude,
            targetLongitude,
            targetAltitude ?: 0.0
        )

        val modeRaw = params.optString("mode", "")
        val flyToMode = parseFlyToMode(modeRaw.ifBlank { null })
        val flyToHeight = if (params.has("fly_to_height")) params.optInt("fly_to_height") else null
        val maxSpeed = params.optDouble("max_speed", Double.NaN).takeIf { !it.isNaN() }
        val securityTakeoffHeight = params.optDouble("security_takeoff_height", Double.NaN).takeIf { !it.isNaN() }
        val reason = params.optString("reason", "mission_plan")
        val finishActionRaw = params.optString("finish_action", "").lowercase()
        val finishAction = when (finishActionRaw) {
            "go_home", "return_home" -> WaylineFinishedAction.GO_HOME
            "land", "auto_land" -> WaylineFinishedAction.AUTO_LAND
            else -> WaylineFinishedAction.NO_ACTION
        }

        val pathModeRaw = params.optString("path_mode", "").lowercase(Locale.ROOT)
        val pathMode = when (pathModeRaw) {
            "curved" -> WaypointMissionExecutor.PathMode.CURVED
            "straight" -> WaypointMissionExecutor.PathMode.STRAIGHT
            else -> null
        }

        val baseExtra = buildFlyToExtra(
            targetLocation = targetLocation,
            targetAltitude = targetAltitudeAsl,
            altitudeSpecified = targetAltitudeAsl != null,
            maxSpeed = maxSpeed,
            securityTakeoffHeight = securityTakeoffHeight,
            mode = flyToMode,
            flyToHeight = flyToHeight
        ).toMutableMap().apply {
            put("plan_waypoint_count", planPoints.size)
            put(
                "plan_waypoints",
                planPoints.mapIndexed { index, point ->
                    mutableMapOf<String, Any?>(
                        "index" to index,
                        "latitude" to point.latitude,
                        "longitude" to point.longitude,
                        "altitude" to point.altitude,
                        "kind" to point.kind
                    ).apply {
                        point.gimbalPitch?.let { put("gimbal_pitch", it) }
                    }
                }
            )
            if (pathMode != null) {
                put("path_mode", pathMode.name.lowercase(Locale.ROOT))
            }
        }

        val missionOverrides = params.optJSONObject("mission_config")?.let { parseMissionOverrides(it) }

        val request = WaypointMissionExecutor.Request(
            targetLocation = targetLocation,
            targetAltitudeAsl = targetAltitudeAsl,
            mode = flyToMode,
            flyToHeight = flyToHeight,
            maxSpeed = maxSpeed,
            securityTakeoffHeight = securityTakeoffHeight,
            reason = reason,
            plan = planPoints,
            finishAction = finishAction,
            pathMode = pathMode,
            missionOverrides = missionOverrides
        )

        attemptWaypointFallback(
            clientId = clientId,
            action = action,
            request = request,
            baseExtra = baseExtra,
            message = "Executing mission plan (${planPoints.size} waypoints)"
        )
    }

    private fun parsePlanPoint(entry: JSONObject): WaypointMissionExecutor.PlanPoint? {
        val latitude = entry.optDouble("latitude", Double.NaN)
        val longitude = entry.optDouble("longitude", Double.NaN)
        if (latitude.isNaN() || longitude.isNaN()) {
            return null
        }

        val altitude = entry.optDoubleOrNull("altitude")
        val kind = entry.optStringOrNull("kind")

        var gimbalPitch = entry.optDoubleOrNull("gimbal_pitch")
        val actionsArray = entry.optJSONArray("actions")
        if (actionsArray != null) {
            for (j in 0 until actionsArray.length()) {
                val action = actionsArray.optJSONObject(j) ?: continue
                val type = action.optString("type", "")
                if (type.equals("gimbal_pitch", ignoreCase = true)) {
                    val pitchValue = action.optDouble("pitch", Double.NaN)
                    if (!pitchValue.isNaN()) {
                        gimbalPitch = pitchValue
                        break
                    }
                }
            }
        }

        val turnObj = entry.optJSONObject("turn")
        val turnMode = turnObj?.optStringOrNull("mode")
        val turnDamping = turnObj?.optDoubleOrNull("damping")
        val useStraightLine: Boolean? = when {
            turnObj?.has("use_straight_line") == true -> turnObj.optBoolean("use_straight_line")
            entry.has("use_straight_line") -> entry.optBoolean("use_straight_line")
            else -> null
        }

        val heading = entry.optJSONObject("heading")?.let { parseHeadingConfig(it) }
        val gimbalHeading = entry.optJSONObject("gimbal_heading")?.let { parseGimbalHeadingConfig(it) }
        val poi = entry.optJSONObject("poi")?.let { parsePoiTarget(it) }
        val gimbalStrategy = entry.optString("gimbal_strategy", "").takeUnless { it.isBlank() }
        val actionGroups = entry.optJSONArray("action_groups")?.let { parseActionGroups(it) } ?: emptyList()

        return WaypointMissionExecutor.PlanPoint(
            latitude = latitude,
            longitude = longitude,
            altitude = altitude,
            kind = kind,
            gimbalPitch = gimbalPitch,
            turnMode = turnMode,
            turnDamping = turnDamping,
            useStraightLine = useStraightLine,
            heading = heading,
            gimbalHeading = gimbalHeading,
            actionGroups = actionGroups,
            poi = poi,
            gimbalStrategy = gimbalStrategy
        )
    }

    private fun parseMissionOverrides(obj: JSONObject): WaypointMissionExecutor.MissionConfigOverrides {
        val executeHeightMode = obj.optString("execute_height_mode", "").takeUnless { it.isBlank() }
        val executeCoordinateMode = obj.optString("execute_coordinate_mode", "").takeUnless { it.isBlank() }

        val droneInfo = obj.optJSONObject("drone_info")?.let { droneObj ->
            WaypointMissionExecutor.DroneInfoOverride(
                enumValue = droneObj.optIntOrNull("enum_value"),
                subEnumValue = droneObj.optIntOrNull("sub_enum_value")
            )
        }

        val payloadInfoList = mutableListOf<WaypointMissionExecutor.PayloadInfoOverride>()
        val payloadInfoArray = obj.optJSONArray("payload_info")
        if (payloadInfoArray != null) {
            for (i in 0 until payloadInfoArray.length()) {
                val payloadObj = payloadInfoArray.optJSONObject(i) ?: continue
                payloadInfoList.add(
                    WaypointMissionExecutor.PayloadInfoOverride(
                        enumValue = payloadObj.optIntOrNull("enum_value"),
                        subEnumValue = payloadObj.optIntOrNull("sub_enum_value"),
                        positionIndex = payloadObj.optIntOrNull("position_index")
                    )
                )
            }
        } else {
            obj.optJSONObject("payload_info")?.let { payloadObj ->
                payloadInfoList.add(
                    WaypointMissionExecutor.PayloadInfoOverride(
                        enumValue = payloadObj.optIntOrNull("enum_value"),
                        subEnumValue = payloadObj.optIntOrNull("sub_enum_value"),
                        positionIndex = payloadObj.optIntOrNull("position_index")
                    )
                )
            }
        }

        return WaypointMissionExecutor.MissionConfigOverrides(
            executeHeightMode = executeHeightMode,
            executeCoordinateMode = executeCoordinateMode,
            droneInfo = droneInfo,
            payloadInfo = payloadInfoList
        )
    }

    private fun parseHeadingConfig(obj: JSONObject): WaypointMissionExecutor.HeadingConfig {
        val mode = obj.optString("mode", "").takeUnless { it.isBlank() }
        val angle = obj.optDoubleOrNull("angle")
        val angleEnable = if (obj.has("angle_enable")) obj.optBoolean("angle_enable") else null
        val poi = obj.optJSONObject("poi")?.let { parsePoiTarget(it) }
        val poiIndex = obj.optIntOrNull("poi_index")
        val yawPathMode = obj.optString("yaw_path_mode", "").takeUnless { it.isBlank() }
        val yawBase = obj.optString("yaw_base", "").takeUnless { it.isBlank() }
        return WaypointMissionExecutor.HeadingConfig(
            mode = mode,
            angle = angle,
            angleEnable = angleEnable,
            poi = poi,
            poiIndex = poiIndex,
            yawPathMode = yawPathMode,
            yawBase = yawBase
        )
    }

    private fun parseGimbalHeadingConfig(obj: JSONObject): WaypointMissionExecutor.GimbalHeadingConfig {
        val mode = obj.optString("mode", "").takeUnless { it.isBlank() }
        val pitch = obj.optDoubleOrNull("pitch")
        val yaw = obj.optDoubleOrNull("yaw")
        return WaypointMissionExecutor.GimbalHeadingConfig(
            mode = mode,
            pitch = pitch,
            yaw = yaw
        )
    }

    private fun parsePoiTarget(obj: JSONObject): WaypointMissionExecutor.PoiTarget? {
        val latitude = obj.optDouble("latitude", Double.NaN)
        val longitude = obj.optDouble("longitude", Double.NaN)
        if (latitude.isNaN() || longitude.isNaN()) {
            return null
        }
        val altitude = obj.optDoubleOrNull("altitude")
        return WaypointMissionExecutor.PoiTarget(latitude, longitude, altitude)
    }

    private fun parseActionGroups(array: JSONArray): List<WaypointMissionExecutor.ActionGroupConfig> {
        if (array.length() == 0) return emptyList()
        val result = mutableListOf<WaypointMissionExecutor.ActionGroupConfig>()
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val actionsArray = obj.optJSONArray("actions")
            val actions = actionsArray?.let { parseActions(it) } ?: emptyList()
            val triggerObj = obj.optJSONObject("trigger")
            val triggerType = when {
                triggerObj != null -> triggerObj.optString("type", "").takeUnless { it.isBlank() }
                obj.has("trigger") -> obj.optString("trigger", "").takeUnless { it.isBlank() }
                obj.has("actionTriggerType") -> obj.optString("actionTriggerType", "").takeUnless { it.isBlank() }
                else -> null
            }

            result.add(
                WaypointMissionExecutor.ActionGroupConfig(
                    id = obj.optIntOrNull("id") ?: obj.optIntOrNull("actionGroupId"),
                    startIndex = obj.optIntOrNull("start_index") ?: obj.optIntOrNull("actionGroupStartIndex"),
                    endIndex = obj.optIntOrNull("end_index") ?: obj.optIntOrNull("actionGroupEndIndex"),
                    mode = obj.optString("mode", obj.optString("actionGroupMode", "")).takeUnless { it.isBlank() },
                    triggerType = triggerType,
                    actions = actions
                )
            )
        }
        return result
    }

    private fun parseActions(array: JSONArray): List<WaypointMissionExecutor.ActionConfig> {
        if (array.length() == 0) return emptyList()
        val actions = mutableListOf<WaypointMissionExecutor.ActionConfig>()
        for (i in 0 until array.length()) {
            val action = array.optJSONObject(i) ?: continue
            val func = action.optString("func", action.optString("actionActuatorFunc", ""))
            if (func.isBlank()) continue
            val paramsObj = action.optJSONObject("params") ?: action.optJSONObject("actionActuatorFuncParam")
            val params = mutableMapOf<String, Any?>()
            if (paramsObj != null) {
                val keys = paramsObj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    params[key] = paramsObj.get(key)
                }
            }
            actions.add(
                WaypointMissionExecutor.ActionConfig(
                    id = action.optIntOrNull("id") ?: action.optIntOrNull("actionId"),
                    func = func,
                    params = params
                )
            )
        }
        return actions
    }

    private fun JSONObject.optDoubleOrNull(key: String): Double? {
        if (!has(key)) return null
        val value = optDouble(key, Double.NaN)
        return if (value.isNaN()) null else value
    }

    private fun JSONObject.optIntOrNull(key: String): Int? {
        return if (has(key)) optInt(key) else null
    }

    private fun JSONObject.optStringOrNull(key: String): String? {
        if (!has(key)) return null
        val value = optString(key, "")
        return value.takeUnless { it.isBlank() }
    }

    private fun handleSimulatorEnable(clientId: String, action: String, params: JSONObject?) {
        val latitudeRaw = params?.optDouble("latitude", Double.NaN) ?: Double.NaN
        val longitudeRaw = params?.optDouble("longitude", Double.NaN) ?: Double.NaN
        val altitudeRaw = params?.optDouble("altitude", Double.NaN) ?: Double.NaN
        val satellitesRaw = params?.optInt("satellites", DEFAULT_SIMULATOR_SATELLITES) ?: DEFAULT_SIMULATOR_SATELLITES
        val frequencyRaw = params?.optInt("frequency_hz", 0) ?: 0
        val sourceParam = params?.optString("source")?.takeUnless { it.isBlank() }

        if (latitudeRaw.isNaN() || longitudeRaw.isNaN()) {
            respond(clientId, action, false, message = "simulator_enable requires latitude and longitude")
            return
        }

        val satellites = when {
            satellitesRaw in SIMULATOR_MIN_SATELLITES..SIMULATOR_MAX_SATELLITES -> satellitesRaw
            satellitesRaw <= 0 -> DEFAULT_SIMULATOR_SATELLITES
            satellitesRaw < SIMULATOR_MIN_SATELLITES -> SIMULATOR_MIN_SATELLITES
            else -> SIMULATOR_MAX_SATELLITES
        }
        val coordinate = LocationCoordinate2D(latitudeRaw, longitudeRaw)
        val settings = try {
            InitializationSettings.createInstance(coordinate, satellites)
        } catch (e: Exception) {
            respond(clientId, action, false, message = "Failed to create simulator settings: ${e.message}")
            return
        }

        val altitude = altitudeRaw.takeUnless { it.isNaN() }
        val frequencyHz = frequencyRaw.takeIf { it > 0 }
        val resolvedSource = sourceParam ?: SIMULATOR_SOURCE_DEFAULT

        val requestSnapshot = mutableMapOf<String, Any?>(
            "latitude" to latitudeRaw,
            "longitude" to longitudeRaw,
            "satellites" to satellites,
            "source" to resolvedSource
        )
        altitude?.let { requestSnapshot["altitude"] = it }
        frequencyHz?.let { requestSnapshot["frequency_hz"] = it }

        runOnUiThread {
            try {
                simulatorBridgeModel?.clearError()
                SimulatorManager.getInstance().enableSimulator(settings, object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        simulatorBridgeModel?.recordCommandConfig(
                            latitude = latitudeRaw,
                            longitude = longitudeRaw,
                            altitude = altitude,
                            satellites = satellites,
                            frequencyHz = frequencyHz,
                            source = resolvedSource
                        )
                        respond(clientId, action, true, extra = mapOf("requested" to requestSnapshot))
                    }

                    override fun onFailure(error: IDJIError) {
                        simulatorBridgeModel?.recordError(simpleErrorMap(error))
                        respond(
                            clientId,
                            action,
                            false,
                            error = error,
                            extra = mapOf("requested" to requestSnapshot)
                        )
                    }
                })
            } catch (e: Exception) {
                simulatorBridgeModel?.recordError(mapOf(
                    "description" to (e.message ?: "simulator enable failed"),
                    "exception" to e.javaClass.simpleName
                ))
                respond(
                    clientId,
                    action,
                    false,
                    message = e.message ?: "Simulator enable failed",
                    extra = mapOf("requested" to requestSnapshot)
                )
            }
        }
    }

    private fun handleSimulatorDisable(clientId: String, action: String) {
        runOnUiThread {
            try {
                val manager = SimulatorManager.getInstance()
                val enabled = runCatching { manager.isSimulatorEnabled }.getOrDefault(false)
                if (!enabled) {
                    respond(clientId, action, true, message = "Simulator already disabled")
                    return@runOnUiThread
                }

                simulatorBridgeModel?.clearError()
                manager.disableSimulator(object : CommonCallbacks.CompletionCallback {
                    override fun onSuccess() {
                        respond(clientId, action, true)
                    }

                    override fun onFailure(error: IDJIError) {
                        simulatorBridgeModel?.recordError(simpleErrorMap(error))
                        respond(clientId, action, false, error = error)
                    }
                })
            } catch (e: Exception) {
                simulatorBridgeModel?.recordError(mapOf(
                    "description" to (e.message ?: "simulator disable failed"),
                    "exception" to e.javaClass.simpleName
                ))
                respond(clientId, action, false, message = e.message ?: "Simulator disable failed")
            }
        }
    }

    private fun handleFlightSettingsUpdate(clientId: String, action: String, params: JSONObject?) {
        if (params == null) {
            respond(clientId, action, false, message = "flight_settings_update requires params")
            return
        }

        val keyManager = runCatching { KeyManager.getInstance() }.getOrElse {
            respond(clientId, action, false, message = "KeyManager unavailable")
            return
        }

        data class PendingSetting(
            val label: String,
            val executor: (success: () -> Unit, failure: (IDJIError) -> Unit) -> Unit
        )

        val requested = mutableMapOf<String, Any?>()
        val operations = mutableListOf<PendingSetting>()

        val goHomeAltitude = params.optDouble("return_home_altitude", Double.NaN)
        if (!goHomeAltitude.isNaN()) {
            val value = goHomeAltitude.roundToInt()
            requested["return_home_altitude"] = value
            operations += PendingSetting("return_home_altitude") { success, failure ->
                keyManager.setValue(
                    KeyTools.createKey(FlightControllerKey.KeyGoHomeHeight),
                    value,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() = success()
                        override fun onFailure(error: IDJIError) = failure(error)
                    }
                )
            }
        }

        val heightLimit = params.optDouble("max_altitude", Double.NaN)
        if (!heightLimit.isNaN()) {
            val value = heightLimit.roundToInt()
            requested["max_altitude"] = value
            operations += PendingSetting("max_altitude") { success, failure ->
                keyManager.setValue(
                    KeyTools.createKey(FlightControllerKey.KeyHeightLimit),
                    value,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() = success()
                        override fun onFailure(error: IDJIError) = failure(error)
                    }
                )
            }
        }

        val distanceLimit = params.optDouble("max_distance", Double.NaN)
        if (!distanceLimit.isNaN()) {
            val value = distanceLimit.roundToInt()
            requested["max_distance"] = value
            operations += PendingSetting("max_distance") { success, failure ->
                keyManager.setValue(
                    KeyTools.createKey(FlightControllerKey.KeyDistanceLimit),
                    value,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() = success()
                        override fun onFailure(error: IDJIError) = failure(error)
                    }
                )
            }
        }

        if (params.has("max_distance_enabled")) {
            val enabled = params.optBoolean("max_distance_enabled", false)
            requested["max_distance_enabled"] = enabled
            operations += PendingSetting("max_distance_enabled") { success, failure ->
                keyManager.setValue(
                    KeyTools.createKey(FlightControllerKey.KeyDistanceLimitEnabled),
                    enabled,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() = success()
                        override fun onFailure(error: IDJIError) = failure(error)
                    }
                )
            }
        }

        if (params.has("signal_lost_action")) {
            val rawAction = params.optString("signal_lost_action", "")
            val failsafe = FailsafeAction.values().firstOrNull {
                it.name.equals(rawAction, ignoreCase = true)
            }
            if (failsafe == null) {
                respond(clientId, action, false, message = "Unknown failsafe action '$rawAction'")
                return
            }
            requested["signal_lost_action"] = failsafe.name
            operations += PendingSetting("signal_lost_action") { success, failure ->
                keyManager.setValue(
                    KeyTools.createKey(FlightControllerKey.KeyFailsafeAction),
                    failsafe,
                    object : CommonCallbacks.CompletionCallback {
                        override fun onSuccess() = success()
                        override fun onFailure(error: IDJIError) = failure(error)
                    }
                )
            }
        }

        if (operations.isEmpty()) {
            respond(clientId, action, false, message = "No flight settings to update", extra = mapOf("requested" to requested))
            return
        }

        runOnUiThread {
            val applied = mutableListOf<String>()
            val failures = mutableListOf<Map<String, Any?>>()

            fun execute(index: Int) {
                if (index >= operations.size) {
                    val extra = mutableMapOf<String, Any?>("requested" to requested)
                    if (applied.isNotEmpty()) extra["applied"] = applied
                    if (failures.isNotEmpty()) extra["errors"] = failures
                    val success = failures.isEmpty()
                    respond(
                        clientId,
                        action,
                        success,
                        message = if (success) "Flight settings updated" else "One or more settings failed",
                        extra = extra
                    )
                    return
                }

                val pending = operations[index]
                pending.executor.invoke(
                    {
                        applied.add(pending.label)
                        execute(index + 1)
                    },
                    { error ->
                        failures.add(
                            mapOf(
                                "operation" to pending.label,
                                "error" to error.description()
                            )
                        )
                        execute(index + 1)
                    }
                )
            }

            execute(0)
        }
    }

    private fun handleRemoteIdUpdate(clientId: String, action: String, params: JSONObject?) {
        val remoteModel = remoteIdBridgeModel
        if (remoteModel == null) {
            respond(clientId, action, false, message = "Remote ID bridge unavailable")
            return
        }

        if (params == null) {
            respond(clientId, action, false, message = "remote_id_update requires params")
            return
        }

        data class RemoteOperation(
            val label: String,
            val executor: (success: () -> Unit, failure: (String) -> Unit) -> Unit
        )

        val requested = mutableMapOf<String, Any?>()
        val operations = mutableListOf<RemoteOperation>()

        if (params.has("area_strategy")) {
            val strategyName = params.optString("area_strategy", "")
            requested["area_strategy"] = strategyName
            operations += RemoteOperation("area_strategy") { success, failure ->
                remoteModel.setAreaStrategy(strategyName) { error ->
                    if (error == null) success() else failure(error.description())
                }
            }
        }

        val registration = params.optString("operator_registration", "")
        if (params.has("operator_registration")) {
            requested["operator_registration"] = registration
            operations += RemoteOperation("operator_registration") { success, failure ->
                remoteModel.setOperatorRegistrationNumber(registration) { error ->
                    if (error == null) success() else failure(error.description())
                }
            }
        }

        if (params.optBoolean("refresh_operator", false)) {
            requested["refresh_operator"] = true
            operations += RemoteOperation("refresh_operator") { success, failure ->
                remoteModel.refreshOperatorRegistrationNumber { error ->
                    if (error == null) success() else failure(error.description())
                }
            }
        }

        if (operations.isEmpty()) {
            respond(clientId, action, false, message = "No Remote ID updates requested", extra = mapOf("requested" to requested))
            return
        }

        runOnUiThread {
            val applied = mutableListOf<String>()
            val failures = mutableListOf<Map<String, Any?>>()

            fun execute(index: Int) {
                if (index >= operations.size) {
                    val extra = mutableMapOf<String, Any?>("requested" to requested)
                    remoteModel.toSnapshotMap()?.let { extra["remote_id"] = it }
                    if (applied.isNotEmpty()) extra["applied"] = applied
                    if (failures.isNotEmpty()) extra["errors"] = failures
                    val success = failures.isEmpty()
                    respond(
                        clientId,
                        action,
                        success,
                        message = if (success) "Remote ID updated" else "Remote ID update failed",
                        extra = extra
                    )
                    return
                }

                val op = operations[index]
                op.executor.invoke(
                    {
                        applied.add(op.label)
                        execute(index + 1)
                    },
                    { errorMessage ->
                        failures.add(mapOf("operation" to op.label, "error" to errorMessage))
                        execute(index + 1)
                    }
                )
            }

            execute(0)
        }
    }

    private fun handleFlySafeRefresh(clientId: String, action: String) {
        val flySafeModel = flySafeBridgeModel
        if (flySafeModel == null) {
            respond(clientId, action, false, message = "FlySafe bridge unavailable")
            return
        }

        runOnUiThread {
            val keyManager = runCatching { KeyManager.getInstance() }.getOrNull()
            val homeLocation = runCatching {
                keyManager?.getValue(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) as? LocationCoordinate2D
            }.getOrNull()

            if (homeLocation == null) {
                respond(clientId, action, false, message = "Home location unavailable")
                return@runOnUiThread
            }

            flySafeModel.pullSurroundingZones(homeLocation)
            val extra = mutableMapOf<String, Any?>()
            extra["requested"] = mapOf(
                "latitude" to homeLocation.latitude,
                "longitude" to homeLocation.longitude
            )
            flySafeSnapshotProvider?.invoke()?.let { extra["fly_safe"] = it }
            respond(clientId, action, true, message = "Fly Safe zones refresh requested", extra = extra)
        }
    }

    private fun handleWaypointPause(clientId: String, action: String) {
        val executor = waypointMissionExecutor
        if (executor == null) {
            respond(clientId, action, false, message = "Waypoint executor unavailable")
            return
        }

        val snapshot = executor.currentMissionSnapshot()
        val extra = snapshot?.toMutableMap() ?: mutableMapOf<String, Any?>()

        executor.pauseActiveMission(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                respond(clientId, action, true, extra = extra)
            }

            override fun onFailure(error: IDJIError) {
                respond(clientId, action, false, error = error, extra = extra)
            }
        })
    }

    private fun handleWaypointResume(clientId: String, action: String) {
        val executor = waypointMissionExecutor
        if (executor == null) {
            respond(clientId, action, false, message = "Waypoint executor unavailable")
            return
        }

        val snapshot = executor.currentMissionSnapshot()
        val extra = snapshot?.toMutableMap() ?: mutableMapOf<String, Any?>()

        executor.resumeActiveMission(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                respond(clientId, action, true, extra = extra)
            }

            override fun onFailure(error: IDJIError) {
                respond(clientId, action, false, error = error, extra = extra)
            }
        })
    }

    private fun simpleErrorMap(error: IDJIError): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        runCatching { error.errorCode() }.getOrNull()?.let { codeObj ->
            map["code"] = codeObj.toString()
            val numeric = runCatching {
                codeObj.javaClass.methods.firstOrNull { it.name.equals("code", true) && it.parameterCount == 0 }?.invoke(codeObj) as? Number
            }.getOrNull()
            numeric?.let { map["code_value"] = it.toInt() }
        }
        map["description"] = error.description()?.takeUnless { it.isNullOrBlank() } ?: error.toString()
        val domain = runCatching {
            error.javaClass.methods.firstOrNull { it.name.equals("errorDomain", true) && it.parameterCount == 0 }?.invoke(error)
        }.getOrNull()
        when (domain) {
            is Enum<*> -> map["domain"] = domain.name
            is String -> map["domain"] = domain
            else -> domain?.let { map["domain"] = it.toString() }
        }
        return map
    }

    private fun sanitizeKmzFileName(input: String): String {
        val trimmed = input.substringAfterLast('/').substringAfterLast('\\')
        val replaced = trimmed.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return if (replaced.isBlank()) "external_${System.currentTimeMillis()}.kmz" else replaced
    }

    private fun handleWaypointStop(clientId: String, action: String) {
        val executor = waypointMissionExecutor
        if (executor == null) {
            respond(clientId, action, false, message = "Waypoint executor unavailable")
            return
        }

        val snapshot = executor.currentMissionSnapshot()
        if (snapshot == null) {
            respond(
                clientId,
                action,
                false,
                message = "No active waypoint mission",
                extra = mapOf("backend" to "waypoint_v2")
            )
            return
        }

        val stopped = executor.stopActiveMission(object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                val extra = snapshot.toMutableMap().apply { this["backend"] = "waypoint_v2" }
                respond(clientId, action, true, extra = extra)
            }

            override fun onFailure(error: IDJIError) {
                val extra = snapshot.toMutableMap().apply { this["backend"] = "waypoint_v2" }
                respond(clientId, action, false, error = error, extra = extra)
            }
        })

        if (!stopped) {
            val extra = snapshot.toMutableMap().apply { this["backend"] = "waypoint_v2" }
            respond(clientId, action, false, message = "Failed to issue waypoint stop", extra = extra)
        }
    }
}
