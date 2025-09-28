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
    private val simulatorBridgeModel: SimulatorBridgeModel? = null
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
            "waypoint_pause" -> handleWaypointPause(clientId, action)
            "waypoint_resume" -> handleWaypointResume(clientId, action)
            "waypoint_stop" -> handleWaypointStop(clientId, action)
            "waypoint_load_kmz" -> handleWaypointLoadKmz(clientId, action, params)
            "simulator_enable" -> handleSimulatorEnable(clientId, action, params)
            "simulator_disable" -> handleSimulatorDisable(clientId, action)

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
                    reason = "intelligent_fly_to_unsupported"
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
                                            reason = "start_failed:${error.description() ?: "unknown"}"
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
                                            reason = "update_param_failed:${message}"
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
