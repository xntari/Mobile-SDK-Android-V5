package dji.sampleV5.aircraft.data

import android.content.Context
import android.location.Location
import android.os.Handler
import android.os.Looper
import android.util.Log
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.ProductKey
import dji.sdk.keyvalue.key.RtkMobileStationKey
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.sdk.keyvalue.value.flightcontroller.FlyToMode
import dji.sdk.keyvalue.value.product.ProductType
import dji.sdk.keyvalue.value.rtkmobilestation.RTKTakeoffAltitudeInfo
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.common.utils.GpsUtils
import dji.v5.manager.KeyManager
import dji.v5.manager.aircraft.waypoint3.WaylineExecutingInfoListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionExecuteStateListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionManager
import com.dji.wpmzsdk.manager.WPMZManager
import dji.sdk.wpmz.value.mission.Wayline
import dji.sdk.wpmz.value.mission.WaylineDroneInfo
import dji.sdk.wpmz.value.mission.WaylineDroneType
import dji.sdk.wpmz.value.mission.WaylineExecuteAltitudeMode
import dji.sdk.wpmz.value.mission.WaylineExecuteCoordinateMode
import dji.sdk.wpmz.value.mission.WaylineExecuteWaypoint
import dji.sdk.wpmz.value.mission.WaylineFinishedAction
import dji.sdk.wpmz.value.mission.WaylineFlyToWaylineMode
import dji.sdk.wpmz.value.mission.WaylineLocationCoordinate2D
import dji.sdk.wpmz.value.mission.WaylineMission
import dji.sdk.wpmz.value.mission.WaylineMissionConfig
import dji.sdk.wpmz.value.mission.WaylineWaypointGimbalHeadingMode
import dji.sdk.wpmz.value.mission.WaylineWaypointGimbalHeadingParam
import dji.sdk.wpmz.value.mission.WaylineWaypointTurnMode
import dji.sdk.wpmz.value.mission.WaylineWaypointTurnParam
import dji.sdk.wpmz.value.mission.WaylineWaypointYawMode
import dji.sdk.wpmz.value.mission.WaylineWaypointYawParam
import dji.sdk.wpmz.value.mission.WaylineWaypointYawPathMode
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import dji.v5.manager.aircraft.waypoint3.model.WaylineExecutingInfo
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.transform.OutputKeys
import javax.xml.transform.TransformerFactory
import javax.xml.transform.dom.DOMSource
import javax.xml.transform.stream.StreamResult
import org.w3c.dom.Element
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * Builds and executes minimal Waypoint V2 missions to mimic Fly-To when Intelligent Fly-To
 * is unavailable (e.g., Matrice 350 RTK).
 */
class WaypointMissionExecutor(
    private val contextProvider: () -> Context?,
    private val runOnUiThread: (action: () -> Unit) -> Unit
) {

    fun dispatchToUi(action: () -> Unit) {
        runOnUiThread(action)
    }

    private data class WaylineMetadata(
        val waylineIds: List<Int> = emptyList(),
        val autoFlightSpeed: Double? = null,
        val securityTakeOffHeight: Double? = null,
        val waypoints: List<Map<String, Any?>> = emptyList()
    )

    enum class PathMode {
        STRAIGHT,
        CURVED
    }

    data class Request(
        val targetLocation: LocationCoordinate3D,
        val targetAltitudeAsl: Double?,
        val mode: FlyToMode?,
        val flyToHeight: Int?,
        val maxSpeed: Double?,
        val securityTakeoffHeight: Double?,
        val reason: String,
        val plan: List<PlanPoint> = emptyList(),
        val finishAction: WaylineFinishedAction = WaylineFinishedAction.NO_ACTION,
        val pathMode: PathMode? = null,
        val missionOverrides: MissionConfigOverrides? = null
    )

    data class MissionConfigOverrides(
        val executeHeightMode: String? = null,
        val executeCoordinateMode: String? = null,
        val droneInfo: DroneInfoOverride? = null,
        val payloadInfo: List<PayloadInfoOverride> = emptyList()
    )

    data class DroneInfoOverride(
        val enumValue: Int? = null,
        val subEnumValue: Int? = null
    )

    data class PayloadInfoOverride(
        val enumValue: Int? = null,
        val subEnumValue: Int? = null,
        val positionIndex: Int? = null
    )

    data class HeadingConfig(
        val mode: String? = null,
        val angle: Double? = null,
        val angleEnable: Boolean? = null,
        val poi: PoiTarget? = null,
        val poiIndex: Int? = null,
        val yawPathMode: String? = null,
        val yawBase: String? = null
    )

    data class GimbalHeadingConfig(
        val mode: String? = null,
        val pitch: Double? = null,
        val yaw: Double? = null
    )

    data class PoiTarget(
        val latitude: Double,
        val longitude: Double,
        val altitude: Double? = null
    )

    data class ActionConfig(
        val id: Int? = null,
        val func: String,
        val params: Map<String, Any?> = emptyMap()
    )

    data class ActionGroupConfig(
        val id: Int? = null,
        val startIndex: Int? = null,
        val endIndex: Int? = null,
        val mode: String? = null,
        val triggerType: String? = null,
        val actions: List<ActionConfig> = emptyList()
    )

    data class PlanPoint(
        val latitude: Double,
        val longitude: Double,
        val altitude: Double?,
        val kind: String? = null,
        val gimbalPitch: Double? = null,
        val turnMode: String? = null,
        val turnDamping: Double? = null,
        val useStraightLine: Boolean? = null,
        val heading: HeadingConfig? = null,
        val gimbalHeading: GimbalHeadingConfig? = null,
        val actionGroups: List<ActionGroupConfig> = emptyList(),
        val poi: PoiTarget? = null,
        val gimbalStrategy: String? = null
    )

    private data class PlanPointResolved(
        val latitude: Double,
        val longitude: Double,
        val executeHeight: Double,
        val kind: String? = null,
        val altitudeAsl: Double? = null,
        val gimbalPitch: Double? = null,
        val turnMode: String? = null,
        val turnDamping: Double? = null,
        val useStraightLine: Boolean? = null,
        val heading: HeadingConfig? = null,
        val gimbalHeading: GimbalHeadingConfig? = null,
        val actionGroups: MutableList<ActionGroupConfig> = mutableListOf(),
        val poi: PoiTarget? = null,
        val gimbalStrategy: String? = null
    )

    private fun resolveDefaultTurnMode(pathMode: PathMode?, index: Int, total: Int): String? {
        if (pathMode != PathMode.CURVED) return null
        if (total <= 1) return WPML_TURN_MODE_STOP_WITH_DISCONTINUITY
        return when (index) {
            0, total - 1 -> WPML_TURN_MODE_STOP_WITH_DISCONTINUITY
            else -> WPML_TURN_MODE_PASS_WITH_CONTINUITY
        }
    }

    private fun defaultDampingForTurn(turnMode: String?): Double? = when (turnMode) {
        WPML_TURN_MODE_PASS_WITH_CONTINUITY -> CURVED_TURN_DAMPING_DISTANCE
        WPML_TURN_MODE_STOP_WITH_CONTINUITY -> CURVED_TURN_DAMPING_DISTANCE
        else -> null
    }

    private fun defaultUseStraightLine(turnMode: String?, curvedFlight: Boolean): Boolean? = when (turnMode) {
        WPML_TURN_MODE_PASS_WITH_CONTINUITY, WPML_TURN_MODE_STOP_WITH_CONTINUITY -> false
        WPML_TURN_MODE_COORDINATE, WPML_TURN_MODE_STOP_WITH_DISCONTINUITY -> if (curvedFlight) false else null
        null -> if (curvedFlight) false else null
        else -> if (curvedFlight) false else null
    }

    private fun mapTurnModeToEnum(turnMode: String?): WaylineWaypointTurnMode? {
        if (turnMode.isNullOrBlank()) return null
        val direct = TURN_MODE_ENUM_MAP[turnMode]
        if (direct != null) return direct
        val lower = turnMode.lowercase(Locale.US)
        return TURN_MODE_ENUM_MAP[lower]
            ?: runCatching {
                WaylineWaypointTurnMode.valueOf(
                    turnMode.replace(Regex("([a-z])([A-Z])"), "$1_$2")
                        .replace('-', '_')
                        .uppercase(Locale.US)
                )
            }.getOrNull()
    }

    private fun applyGimbalStrategies(plan: MutableList<PlanPointResolved>, takeoffAsl: Double?) {
        plan.forEachIndexed { index, point ->
            val strategy = point.gimbalStrategy?.lowercase(Locale.US) ?: return@forEachIndexed
            when (strategy) {
                "poi_track_aircraft" -> {
                    val poiTarget = point.poi ?: point.heading?.poi ?: return@forEachIndexed
                    val updatedHeading = (point.heading ?: HeadingConfig()).copy(
                        mode = point.heading?.mode ?: "towardPOI",
                        poi = poiTarget
                    )
                    val computedPitch = point.gimbalPitch ?: computePitchToPoi(point, poiTarget, takeoffAsl)
                    plan[index] = point.copy(
                        heading = updatedHeading,
                        gimbalPitch = computedPitch,
                        actionGroups = point.actionGroups
                    )
                }
                else -> {
                    // TODO: Support additional gimbal strategies (gimbal-track-poi, discrete updates)
                }
            }
        }
    }

    private fun computePitchToPoi(point: PlanPointResolved, poi: PoiTarget, takeoffAsl: Double?): Double? {
        val waypointAltitude = point.altitudeAsl ?: takeoffAsl?.plus(point.executeHeight)
        val poiAltitude = poi.altitude ?: takeoffAsl
        if (waypointAltitude == null || poiAltitude == null) return null
        val horizontal = horizontalDistanceMeters(point.latitude, point.longitude, poi.latitude, poi.longitude)
        val vertical = poiAltitude - waypointAltitude
        if (horizontal == 0.0) {
            return if (vertical >= 0) 90.0 else -90.0
        }
        val angleRad = atan2(vertical, horizontal)
        return Math.toDegrees(angleRad)
    }

    private fun horizontalDistanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val results = FloatArray(1)
        Location.distanceBetween(lat1, lon1, lat2, lon2, results)
        return results.firstOrNull()?.toDouble() ?: 0.0
    }

    sealed class Result {
        data class Success(val extra: Map<String, Any?> = emptyMap()) : Result()
        data class Failure(
            val message: String?,
            val error: IDJIError? = null,
            val extra: Map<String, Any?> = emptyMap()
        ) : Result()
    }

    private fun computeHorizontalDistance(start: LocationCoordinate3D?, end: LocationCoordinate3D): Double? {
        val from = start ?: return null
        val results = FloatArray(1)
        Location.distanceBetween(from.latitude, from.longitude, end.latitude, end.longitude, results)
        return results.firstOrNull()?.toDouble()
    }

    private fun estimateMissionDuration(
        horizontalDistance: Double?,
        horizontalSpeed: Double,
        verticalDistance: Double,
        verticalSpeed: Double
    ): Double? {
        val horizontalTime = horizontalDistance?.div(max(horizontalSpeed, MIN_SPEED)) ?: 0.0
        val verticalTime = if (verticalDistance > 0) verticalDistance / max(verticalSpeed, MIN_VERTICAL_SPEED) else 0.0
        val total = horizontalTime + verticalTime
        return if (total > 0) total else null
    }

    private fun setWaylineMetric(wayline: Wayline, value: Double, vararg methodCandidates: String) {
        methodCandidates.forEach { name ->
            runCatching {
                val method = wayline.javaClass.methods.firstOrNull { it.name == name && it.parameterTypes.size == 1 }
                if (method != null) {
                    method.invoke(wayline, value)
                    return
                }
            }
        }
    }

    private fun resolveDroneInfo(productType: ProductType?): DroneInfoResult? {
        if (productType == null) return null

        logAvailableDroneTypes(productType)

        val normalized = productType.name.replace("DJI_", "")
        val matchingEnum = WaylineDroneType.values().firstOrNull { type ->
            type.name.equals(normalized, true) ||
                type.name.replace("_", "").equals(normalized.replace("_", ""), true)
        }

        val enumValue = matchingEnum?.let { getDroneEnumValue(it) }
        val info = WaylineDroneInfo()

        return when {
            matchingEnum != null && enumValue != null -> {
                info.setDroneType(matchingEnum)
                info.setDroneSubType(0)
                DroneInfoResult(info, enumValue)
            }
            DRONE_TYPE_OVERRIDES.containsKey(productType.name) -> {
                val override = DRONE_TYPE_OVERRIDES[productType.name] ?: return null
                val overrideEnum = findDroneEnumByValue(override)
                if (overrideEnum != null) {
                    info.setDroneType(overrideEnum)
                    info.setDroneSubType(0)
                } else {
                    setDroneEnumValueReflect(info, override)
                    info.setDroneSubType(0)
                }
                DroneInfoResult(info, override)
            }
            else -> {
                Log.w(TAG, "No waypoint drone enum mapping for product $productType; falling back to UNKNOWN")
                null
            }
        }
    }

    private fun getDroneEnumValue(type: WaylineDroneType): Int? {
        return runCatching {
            val method = WaylineDroneType::class.java.methods.firstOrNull { it.name == "value" && it.parameterTypes.isEmpty() }
            (method?.invoke(type) as? Number)?.toInt()
        }.getOrNull()
    }

    private fun findDroneEnumByValue(value: Int): WaylineDroneType? {
        val method = WaylineDroneType::class.java.methods.firstOrNull { it.name == "value" && it.parameterTypes.isEmpty() }
        return WaylineDroneType.values().firstOrNull { enum ->
            runCatching { (method?.invoke(enum) as? Number)?.toInt() }.getOrNull() == value
        }
    }

    private fun setDroneEnumValueReflect(info: WaylineDroneInfo, value: Int) {
        runCatching {
            val method = info.javaClass.methods.firstOrNull {
                it.parameterTypes.size == 1 &&
                    it.parameterTypes.first().let { type -> type == Int::class.javaPrimitiveType || type == java.lang.Integer::class.java }
                        && (it.name == "setDroneEnumValue" || it.name == "setDroneTypeValue")
            }
            if (method != null) {
                method.invoke(info, value)
            } else {
                Log.w(TAG, "Unable to reflectively set drone enum value; using UNKNOWN")
            }
        }.onFailure {
            Log.w(TAG, "Failed setting drone enum via reflection", it)
        }
    }

    private fun logAvailableDroneTypes(productType: ProductType?) {
        if (!droneTypeLogged.compareAndSet(false, true)) return

        val valueMethod = WaylineDroneType::class.java.methods.firstOrNull { it.name == "value" && it.parameterTypes.isEmpty() }
        val summary = WaylineDroneType.values().joinToString { enum ->
            val value = runCatching { (valueMethod?.invoke(enum) as? Number)?.toInt() }.getOrNull()
            "${enum.name}:${value ?: "?"}"
        }
        Log.i(TAG, "Waypoint drone enums: $summary (product=$productType)")

        val infoMethods = WaylineDroneInfo().javaClass.methods.joinToString { it.name }
        Log.i(TAG, "WaypointDroneInfo methods: $infoMethods")
    }

    private data class DroneInfoResult(val info: WaylineDroneInfo, val enumValue: Int)

    private val TAG = "WaypointMissionExecutor"
    private val initialized = AtomicBoolean(false)
    private val missionManager by lazy { WaypointMissionManager.getInstance() }
    private val activeMissionId = AtomicReference<String?>(null)
    private val activeMissionPath = AtomicReference<String?>(null)
    private val activeMissionWaypoints = AtomicReference<List<Map<String, Any?>>>(emptyList())
    private val activeMissionSecurityHeight = AtomicReference<Double?>(null)
    private val uploadInProgress = AtomicBoolean(false)
    private val startWatcherRef = AtomicReference<MissionStartWatcher?>(null)
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    fun execute(request: Request, callback: (Result) -> Unit) {
        val context = contextProvider.invoke()
        if (context == null) {
            callback(Result.Failure("Waypoint fallback unavailable (no context)", extra = mapOf("backend" to BACKEND_ID)))
            return
        }

        ensureInitialized(context)

        val keyManager = runCatching { KeyManager.getInstance() }.getOrNull()
        if (keyManager == null) {
            callback(Result.Failure("KeyManager unavailable", extra = mapOf("backend" to BACKEND_ID)))
            return
        }

        val aircraftLocation3D = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D)) as? LocationCoordinate3D
        }.getOrNull()
        val aircraftLocation2D = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAircraftLocation)) as? LocationCoordinate2D
        }.getOrNull()
        val homeLocation = runCatching {
            keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyHomeLocation)) as? LocationCoordinate2D
        }.getOrNull()
        val productType = runCatching {
            keyManager.getValue(KeyTools.createKey(ProductKey.KeyProductType)) as? ProductType
        }.getOrNull()
        val altitudeAgl = runCatching {
            (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAltitude)) as? Number)?.toDouble()
        }.getOrNull()
        val ultrasonicHeight = runCatching {
            (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyUltrasonicHeight)) as? Number)?.toDouble()?.div(10.0)
        }.getOrNull()
        val takeoffAltitudeRaw = runCatching {
            (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyTakeoffLocationAltitude)) as? Number)?.toDouble()
        }.getOrNull()
        val rtkTakeoffInfo = runCatching {
            keyManager.getValue(KeyTools.createKey(RtkMobileStationKey.KeyRTKTakeoffAltitudeInfo)) as? RTKTakeoffAltitudeInfo
        }.getOrNull()

        val takeoffAsl = computeTakeoffAsl(
            rtkTakeoffInfo = rtkTakeoffInfo,
            takeoffAltitudeRaw = takeoffAltitudeRaw,
            homeLocation = homeLocation,
            aircraftLocation = aircraftLocation2D,
            relativeAltitude = altitudeAgl ?: ultrasonicHeight ?: 0.0
        )
        val currentLocation = aircraftLocation3D ?: aircraftLocation2D?.let { LocationCoordinate3D(it.latitude, it.longitude, altitudeAgl ?: ultrasonicHeight ?: 0.0) }
        val currentHeight = altitudeAgl ?: ultrasonicHeight ?: 0.0

        val droneInfoResult = resolveDroneInfo(productType)

        val securityFloor = request.securityTakeoffHeight
            ?.takeIf { !it.isNaN() && it > 0.0 }
            ?: DEFAULT_SECURITY_TAKEOFF_HEIGHT

        val takeoffDebug = mutableMapOf<String, Any?>(
            "computed_takeoff_asl" to takeoffAsl,
            "takeoff_altitude_raw" to takeoffAltitudeRaw,
            "rtk_takeoff_altitude" to rtkTakeoffInfo?.altitude?.toDouble(),
            "relative_altitude" to currentHeight,
            "home_latitude" to (homeLocation?.latitude ?: aircraftLocation2D?.latitude),
            "home_longitude" to (homeLocation?.longitude ?: aircraftLocation2D?.longitude),
            "product_type" to productType?.name,
            "security_takeoff_height" to securityFloor
        )
        droneInfoResult?.enumValue?.let { takeoffDebug["drone_enum_value"] = it }

        val manualHeightOverride = request.mode == FlyToMode.SET_HEIGHT ||
            request.flyToHeight != null ||
            request.targetAltitudeAsl != null

        val curvedFlight = request.pathMode == PathMode.CURVED
        val planResolved = mutableListOf<PlanPointResolved>()
        if (request.plan.isNotEmpty()) {
            val planCount = request.plan.size
            request.plan.forEachIndexed { index, point ->
                val lat = point.latitude
                val lon = point.longitude
                if (lat.isNaN() || lon.isNaN()) {
                    Log.w(TAG, "Skipping plan waypoint $index due to invalid coordinates: $lat,$lon")
                    return@forEachIndexed
                }

                val altitudeAsl = point.altitude
                val baseRelative = when {
                    altitudeAsl != null && takeoffAsl != null -> altitudeAsl - takeoffAsl
                    altitudeAsl != null -> altitudeAsl
                    else -> currentHeight
                }

                val executeHeight = if (altitudeAsl != null) {
                    max(MIN_HEIGHT, baseRelative)
                } else {
                    max(max(MIN_HEIGHT, baseRelative), securityFloor)
                }

                val resolvedTurnMode = point.turnMode ?: resolveDefaultTurnMode(request.pathMode, index, planCount)
                val resolvedTurnDamping = point.turnDamping ?: defaultDampingForTurn(resolvedTurnMode)
                val resolvedUseStraightLine = point.useStraightLine ?: defaultUseStraightLine(resolvedTurnMode, curvedFlight)

                planResolved.add(
                    PlanPointResolved(
                        latitude = lat,
                        longitude = lon,
                        executeHeight = executeHeight,
                        kind = point.kind,
                        altitudeAsl = altitudeAsl,
                        gimbalPitch = point.gimbalPitch,
                        turnMode = resolvedTurnMode,
                        turnDamping = resolvedTurnDamping,
                        useStraightLine = resolvedUseStraightLine,
                        heading = point.heading,
                        gimbalHeading = point.gimbalHeading,
                        actionGroups = point.actionGroups.toMutableList(),
                        poi = point.poi,
                        gimbalStrategy = point.gimbalStrategy
                    )
                )
            }
        }

        if (planResolved.isNotEmpty()) {
            applyGimbalStrategies(planResolved, takeoffAsl)
        }

        val targetRelativeHeight = computeTargetHeight(
            request = request,
            takeoffAsl = takeoffAsl,
            currentHeight = currentHeight,
            manualHeightOverride = manualHeightOverride
        )

        val finalTargetHeight = planResolved.lastOrNull()?.executeHeight ?: targetRelativeHeight

        takeoffDebug["manual_height_override"] = manualHeightOverride
        takeoffDebug["target_relative_height"] = finalTargetHeight
        if (planResolved.isNotEmpty()) {
            takeoffDebug["plan_waypoint_count"] = planResolved.size
            takeoffDebug["plan_waypoints"] = planResolved.mapIndexed { index, waypoint ->
                mapOf(
                    "index" to index,
                    "latitude" to waypoint.latitude,
                    "longitude" to waypoint.longitude,
                    "execute_height" to waypoint.executeHeight,
                    "kind" to waypoint.kind,
                    "altitude_asl" to waypoint.altitudeAsl
                )
            }
        }

        val horizontalDistance: Double? = if (planResolved.isNotEmpty()) {
            var total = 0.0
            val results = FloatArray(1)
            var prevLat = currentLocation?.latitude ?: planResolved.first().latitude
            var prevLon = currentLocation?.longitude ?: planResolved.first().longitude
            planResolved.forEach { waypoint ->
                Location.distanceBetween(prevLat, prevLon, waypoint.latitude, waypoint.longitude, results)
                total += results.firstOrNull()?.toDouble() ?: 0.0
                prevLat = waypoint.latitude
                prevLon = waypoint.longitude
            }
            total
        } else {
            computeHorizontalDistance(currentLocation, request.targetLocation)
        }

        val verticalDistance = abs((planResolved.lastOrNull()?.executeHeight ?: finalTargetHeight) - currentHeight)
        val estimatedDuration = estimateMissionDuration(
            horizontalDistance = horizontalDistance,
            horizontalSpeed = request.maxSpeed ?: DEFAULT_SPEED,
            verticalDistance = verticalDistance,
            verticalSpeed = request.securityTakeoffHeight ?: DEFAULT_VERTICAL_SPEED
        )
        takeoffDebug["horizontal_distance"] = horizontalDistance
        takeoffDebug["estimated_duration"] = estimatedDuration

        val missionFile = createMissionFile(context)
        val missionId = missionFile.nameWithoutExtension

        val buildResult = runCatching {
            buildMissionFiles(
                missionFile = missionFile,
                currentLocation = currentLocation,
                targetLocation = request.targetLocation,
                targetRelativeHeight = finalTargetHeight,
                currentRelativeHeight = currentHeight,
                speed = request.maxSpeed ?: DEFAULT_SPEED,
                securityTakeoffHeight = request.securityTakeoffHeight,
                horizontalDistance = horizontalDistance,
                estimatedDuration = estimatedDuration,
                droneInfoResult = droneInfoResult,
                manualHeightOverride = manualHeightOverride,
                plan = planResolved,
                finishAction = request.finishAction
            )
            patchWaylineMissionFile(
                missionFile = missionFile,
                plan = planResolved,
                hasStartWaypoint = currentLocation != null,
                missionOverrides = request.missionOverrides
            )
        }

        if (buildResult.isFailure) {
            val throwable = buildResult.exceptionOrNull()
            clearActiveMission()
            callback(
                Result.Failure(
                    message = "Failed to generate waypoint mission: ${throwable?.message}",
                    extra = mapOf(
                        "backend" to BACKEND_ID,
                        "mission_path" to missionFile.absolutePath
                    )
                )
            )
            return
        }

        activeMissionPath.set(missionFile.absolutePath)

        uploadAndStartMission(
            missionFile = missionFile,
            missionId = missionId,
            waylineIds = listOf(0),
            speed = request.maxSpeed ?: DEFAULT_SPEED,
            reason = request.reason,
            extra = takeoffDebug,
            callback = callback
        )
    }

    fun executeExternalKmz(fileName: String, kmzData: ByteArray, callback: (Result) -> Unit) {
        val context = contextProvider.invoke()
        if (context == null) {
            callback(Result.Failure("Waypoint fallback unavailable (no context)", extra = mapOf("backend" to BACKEND_ID)))
            return
        }

        ensureInitialized(context)

        runCatching {
            val outDir = File(context.cacheDir, "external_waypoints")
            if (!outDir.exists()) outDir.mkdirs()
            val sanitized = sanitizeFileName(fileName)
            val kmzFile = File(outDir, sanitized)
            kmzFile.writeBytes(kmzData)

            val metadata = parseWaylineMetadata(kmzFile)
            val waylineIds = metadata.waylineIds.ifEmpty { listOf(0) }
            val speed = metadata.autoFlightSpeed ?: DEFAULT_SPEED
            val missionId = kmzFile.nameWithoutExtension.ifBlank { "external_${System.currentTimeMillis()}" }
            val extra = mutableMapOf<String, Any?>(
                "source" to "external_kmz",
                "file_path" to kmzFile.absolutePath,
                "wayline_ids" to waylineIds,
                "auto_flight_speed" to metadata.autoFlightSpeed
            )
            metadata.securityTakeOffHeight?.let { extra["security_takeoff_height"] = it }

            if (metadata.waypoints.isNotEmpty()) {
                activeMissionWaypoints.set(metadata.waypoints)
            }
            val resolvedSecurity = metadata.securityTakeOffHeight
                ?.takeIf { !it.isNaN() && it > 0.0 }
                ?: DEFAULT_SECURITY_TAKEOFF_HEIGHT
            activeMissionSecurityHeight.set(resolvedSecurity)

            uploadAndStartMission(
                missionFile = kmzFile,
                missionId = missionId,
                waylineIds = waylineIds,
                speed = speed,
                reason = "external_kmz",
                extra = extra,
                callback = callback
            )
        }.onFailure { throwable ->
            callback(
                Result.Failure(
                    message = "Failed to execute KMZ: ${throwable.message}",
                    extra = mapOf("backend" to BACKEND_ID, "source" to "external_kmz")
                )
            )
        }
    }

    private fun ensureInitialized(context: Context) {
        if (initialized.compareAndSet(false, true)) {
            runCatching {
                WPMZManager.getInstance().init(context.applicationContext)
                Log.i(TAG, "WPMZManager initialized for waypoint fallback")
            }.onFailure {
                Log.e(TAG, "Failed to initialize WPMZManager: ${it.message}", it)
            }
        }
    }

    private fun patchWaylineMissionFile(
        missionFile: File,
        plan: List<PlanPointResolved>,
        hasStartWaypoint: Boolean,
        missionOverrides: MissionConfigOverrides?
    ) {
        runCatching {
            val tempFile = File.createTempFile("mission_patch", ".kmz")
            ZipFile(missionFile).use { zipFile ->
                ZipOutputStream(FileOutputStream(tempFile)).use { zipOut ->
                    val entries = zipFile.entries()
                    while (entries.hasMoreElements()) {
                        val entry = entries.nextElement()
                        val originalBytes = zipFile.getInputStream(entry).readBytes()
                        val bytes = if (entry.name == WAYLINES_WPML_PATH) {
                            runCatching {
                                patchWaylinesXml(originalBytes, plan, hasStartWaypoint, missionOverrides)
                            }.getOrElse { throwable ->
                                Log.w(TAG, "Failed to patch waylines.wpml: ${throwable.message}")
                                originalBytes
                            }
                        } else {
                            originalBytes
                        }
                        val patchedEntry = ZipEntry(entry.name).apply { time = entry.time }
                        zipOut.putNextEntry(patchedEntry)
                        zipOut.write(bytes)
                        zipOut.closeEntry()
                    }
                }
            }

            if (!missionFile.delete()) {
                Log.w(TAG, "Unable to remove original mission file before applying patch; overwriting")
            }
            if (!tempFile.renameTo(missionFile)) {
                tempFile.copyTo(missionFile, overwrite = true)
                tempFile.delete()
            }
        }.onFailure {
            Log.w(TAG, "Mission patch step failed: ${it.message}")
        }
    }

    private fun patchWaylinesXml(
        data: ByteArray,
        plan: List<PlanPointResolved>,
        hasStartWaypoint: Boolean,
        missionOverrides: MissionConfigOverrides?
    ): ByteArray {
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val documentBuilder = factory.newDocumentBuilder()
        val document = documentBuilder.parse(ByteArrayInputStream(data))

        applyMissionOverrides(document, missionOverrides)

        val placemarks = document.getElementsByTagName("Placemark")
        for (index in 0 until placemarks.length) {
            val placemark = placemarks.item(index) as? Element ?: continue
            val planIndex = if (hasStartWaypoint) index - 1 else index
            val resolved = plan.getOrNull(planIndex)

            if (resolved != null) {
                applyTurnConfig(placemark, resolved)
                applyHeadingConfig(placemark, resolved)
                applyGimbalConfig(placemark, resolved)
                applyActionGroups(placemark, resolved.actionGroups)
            }
        }

        val transformer = TransformerFactory.newInstance().newTransformer().apply {
            setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "no")
            setOutputProperty(OutputKeys.INDENT, "yes")
        }
        val output = ByteArrayOutputStream()
        transformer.transform(DOMSource(document), StreamResult(output))
        return output.toByteArray()
    }

    private fun applyMissionOverrides(document: org.w3c.dom.Document, overrides: MissionConfigOverrides?) {
        if (overrides == null) return
        val missionConfig = document.getElementsByTagName("wpml:missionConfig").item(0) as? Element
        missionConfig?.let { configElement ->
            overrides.droneInfo?.let { info ->
                val droneInfoElement = configElement.ensureChild(WPML_NAMESPACE, "droneInfo")
                info.enumValue?.let { droneInfoElement.ensureChild(WPML_NAMESPACE, "droneEnumValue").textContent = it.toString() }
                info.subEnumValue?.let { droneInfoElement.ensureChild(WPML_NAMESPACE, "droneSubEnumValue").textContent = it.toString() }
            }
            if (overrides.payloadInfo.isNotEmpty()) {
                // Remove existing payloadInfo children
                val existing = configElement.getElementsByTagNameNS(WPML_NAMESPACE, "payloadInfo")
                val toRemove = mutableListOf<Element>()
                for (i in 0 until existing.length) {
                    val node = existing.item(i)
                    if (node is Element) toRemove.add(node)
                }
                toRemove.forEach { configElement.removeChild(it) }

                overrides.payloadInfo.forEach { payload ->
                    val payloadElem = configElement.appendWpmlElement("payloadInfo")
                    payload.enumValue?.let { payloadElem.appendWpmlElement("payloadEnumValue", it.toString()) }
                    payload.subEnumValue?.let { payloadElem.appendWpmlElement("payloadSubEnumValue", it.toString()) }
                    payload.positionIndex?.let { payloadElem.appendWpmlElement("payloadPositionIndex", it.toString()) }
                }
            }
        }

        val folder = document.getElementsByTagName("kml:Folder").item(0) as? Element
        folder?.let { folderElement ->
            overrides.executeHeightMode?.let { folderElement.ensureChild(WPML_NAMESPACE, "executeHeightMode").textContent = it }
            overrides.executeCoordinateMode?.let { folderElement.ensureChild(WPML_NAMESPACE, "executeCoordinateMode").textContent = it }
        }
    }

    private fun applyTurnConfig(placemark: Element, point: PlanPointResolved) {
        point.useStraightLine?.let { value ->
            placemark.ensureChild(WPML_NAMESPACE, "useStraightLine").textContent = if (value) "1" else "0"
        }
        if (point.turnMode != null || point.turnDamping != null) {
            val turnParam = placemark.ensureChild(WPML_NAMESPACE, "waypointTurnParam")
            point.turnMode?.let { turnParam.ensureChild(WPML_NAMESPACE, "waypointTurnMode").textContent = it }
            point.turnDamping?.let {
                turnParam.ensureChild(WPML_NAMESPACE, "waypointTurnDampingDist").textContent =
                    String.format(Locale.US, "%.1f", it)
            }
        }
    }

    private fun applyHeadingConfig(placemark: Element, point: PlanPointResolved) {
        val heading = point.heading ?: return
        val headingParam = placemark.ensureChild(WPML_NAMESPACE, "waypointHeadingParam")
        heading.mode?.let { headingParam.ensureChild(WPML_NAMESPACE, "waypointHeadingMode").textContent = it }
        heading.angle?.let {
            headingParam.ensureChild(WPML_NAMESPACE, "waypointHeadingAngle").textContent =
                String.format(Locale.US, "%.2f", it)
        }
        heading.angleEnable?.let {
            headingParam.ensureChild(WPML_NAMESPACE, "waypointHeadingAngleEnable").textContent = if (it) "1" else "0"
        }
        val poiTarget = heading.poi ?: point.poi
        poiTarget?.let {
            val altText = it.altitude?.let { alt -> String.format(Locale.US, "%.3f", alt) } ?: "0.000000"
            headingParam.ensureChild(WPML_NAMESPACE, "waypointPoiPoint").textContent =
                String.format(Locale.US, "%.6f,%.6f,%s", it.latitude, it.longitude, altText)
        }
        heading.poiIndex?.let {
            headingParam.ensureChild(WPML_NAMESPACE, "waypointHeadingPoiIndex").textContent = it.toString()
        }
        heading.yawPathMode?.let {
            headingParam.ensureChild(WPML_NAMESPACE, "waypointHeadingPathMode").textContent = it
        }
        heading.yawBase?.let {
            headingParam.ensureChild(WPML_NAMESPACE, "waypointHeadingYawBase").textContent = it
        }
    }

    private fun applyGimbalConfig(placemark: Element, point: PlanPointResolved) {
        val gimbalParam = placemark.ensureChild(WPML_NAMESPACE, "waypointGimbalHeadingParam")
        val heading = point.gimbalHeading
        heading?.mode?.let { gimbalParam.ensureChild(WPML_NAMESPACE, "waypointGimbalHeadingMode").textContent = it }
        val pitchValue = heading?.pitch ?: point.gimbalPitch
        pitchValue?.let {
            val boundedPitch = it.coerceIn(-90.0, 30.0)
            gimbalParam.ensureChild(WPML_NAMESPACE, "waypointGimbalPitchAngle").textContent =
                String.format(Locale.US, "%.2f", boundedPitch)
        }
        val yawValue = heading?.yaw
        yawValue?.let {
            gimbalParam.ensureChild(WPML_NAMESPACE, "waypointGimbalYawAngle").textContent =
                String.format(Locale.US, "%.2f", it)
        }
    }

    private fun applyActionGroups(placemark: Element, actionGroups: List<ActionGroupConfig>) {
        if (actionGroups.isEmpty()) return

        // Remove existing actionGroup elements
        val existing = placemark.getElementsByTagNameNS(WPML_NAMESPACE, "actionGroup")
        val toRemove = mutableListOf<Element>()
        for (i in 0 until existing.length) {
            val node = existing.item(i)
            if (node is Element) toRemove.add(node)
        }
        toRemove.forEach { placemark.removeChild(it) }

        actionGroups.forEach { group ->
            val groupElem = placemark.appendWpmlElement("actionGroup")
            group.id?.let { groupElem.appendWpmlElement("actionGroupId", it.toString()) }
            group.startIndex?.let { groupElem.appendWpmlElement("actionGroupStartIndex", it.toString()) }
            group.endIndex?.let { groupElem.appendWpmlElement("actionGroupEndIndex", it.toString()) }
            group.mode?.let { groupElem.appendWpmlElement("actionGroupMode", it) }

            group.triggerType?.let { triggerType ->
                val triggerElem = groupElem.appendWpmlElement("actionTrigger")
                triggerElem.appendWpmlElement("actionTriggerType", triggerType)
            }

            group.actions.forEach { action ->
                val actionElem = groupElem.appendWpmlElement("action")
                action.id?.let { actionElem.appendWpmlElement("actionId", it.toString()) }
                actionElem.appendWpmlElement("actionActuatorFunc", action.func)
                if (action.params.isNotEmpty()) {
                    val paramsElem = actionElem.appendWpmlElement("actionActuatorFuncParam")
                    action.params.forEach { (key, value) ->
                        if (value != null) {
                            paramsElem.appendWpmlElement(key, value.toString())
                        }
                    }
                }
            }
        }
    }

    private fun Element.getFirstChildElement(namespace: String, localName: String): Element? {
        val nodes = getElementsByTagNameNS(namespace, localName)
        for (i in 0 until nodes.length) {
            val node = nodes.item(i)
            if (node is Element) {
                return node
            }
        }
        return null
    }

    private fun Element.ensureChild(namespace: String, localName: String): Element {
        val existing = getFirstChildElement(namespace, localName)
        if (existing != null) {
            return existing
        }
        val element = ownerDocument.createElementNS(namespace, "wpml:$localName")
        appendChild(element)
        return element
    }

    private fun Element.appendWpmlElement(localName: String, value: String? = null): Element {
        val element = ownerDocument.createElementNS(WPML_NAMESPACE, "wpml:$localName")
        if (value != null) {
            element.textContent = value
        }
        appendChild(element)
        return element
    }

    private fun computeTakeoffAsl(
        rtkTakeoffInfo: RTKTakeoffAltitudeInfo?,
        takeoffAltitudeRaw: Double?,
        homeLocation: LocationCoordinate2D?,
        aircraftLocation: LocationCoordinate2D?,
        relativeAltitude: Double
    ): Double? {
        val lat = homeLocation?.latitude ?: aircraftLocation?.latitude
        val lon = homeLocation?.longitude ?: aircraftLocation?.longitude

        val homePointAltitude = takeoffAltitudeRaw
        val ellipsoidTotal = homePointAltitude?.let { it + relativeAltitude }

        val rtkAltitude = rtkTakeoffInfo?.altitude?.toDouble()
        if (rtkAltitude != null && !rtkAltitude.isNaN()) {
            if (lat != null && lon != null && !lat.isNaN() && !lon.isNaN()) {
                return runCatching { GpsUtils.egm96Altitude(rtkAltitude + relativeAltitude, lat, lon) }
                    .getOrElse { rtkAltitude } - relativeAltitude
            }
            return rtkAltitude
        }

        val altitudeAsl = when {
            ellipsoidTotal != null && lat != null && lon != null && !lat.isNaN() && !lon.isNaN() ->
                runCatching { GpsUtils.egm96Altitude(ellipsoidTotal, lat, lon) }.getOrNull()
            ellipsoidTotal != null -> ellipsoidTotal
            else -> null
        }

        if (altitudeAsl != null) {
            return altitudeAsl - relativeAltitude
        }

        return homePointAltitude
    }

    private fun sanitizeFileName(input: String): String {
        val trimmed = input.substringAfterLast('/').substringAfterLast('\\')
        val candidate = if (trimmed.endsWith(".kmz", ignoreCase = true)) trimmed else "$trimmed.kmz"
        val replaced = candidate.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return if (replaced.isBlank()) {
            "external_${System.currentTimeMillis()}.kmz"
        } else {
            replaced
        }
    }

    private fun parseWaylineMetadata(kmzFile: File): WaylineMetadata {
        return kotlin.runCatching {
            ZipInputStream(kmzFile.inputStream()).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory && entry.name.endsWith("waylines.wpml", ignoreCase = true)) {
                        val content = ByteArrayOutputStream().use { buffer ->
                            val data = ByteArray(4096)
                            var read: Int
                            while (zip.read(data).also { read = it } != -1) {
                                buffer.write(data, 0, read)
                            }
                            buffer.toString(StandardCharsets.UTF_8.name())
                        }

                        val waylineIds = Regex("<wpml:waylineId>(\\d+)</wpml:waylineId>")
                            .findAll(content)
                            .mapNotNull { match -> match.groupValues.getOrNull(1)?.toIntOrNull() }
                            .distinct()
                            .toList()

                        val speed = Regex("<wpml:autoFlightSpeed>([0-9.]+)</wpml:autoFlightSpeed>")
                            .find(content)
                            ?.groupValues
                            ?.getOrNull(1)
                            ?.toDoubleOrNull()

                        val securityHeight = Regex("<wpml:takeOffSecurityHeight>([-0-9.]+)</wpml:takeOffSecurityHeight>")
                            .find(content)
                            ?.groupValues
                            ?.getOrNull(1)
                            ?.toDoubleOrNull()

                        val waypointSummaries = Regex("<Placemark>(.*?)</Placemark>", setOf(RegexOption.DOT_MATCHES_ALL))
                            .findAll(content)
                            .mapNotNull { placemarkMatch ->
                                val block = placemarkMatch.groupValues.getOrNull(1) ?: return@mapNotNull null
                                val index = Regex("<wpml:index>(\\d+)</wpml:index>")
                                    .find(block)
                                    ?.groupValues
                                    ?.getOrNull(1)
                                    ?.toIntOrNull()
                                val coordMatch = Regex("<coordinates>\\s*([-.0-9]+),([-.0-9]+)")
                                    .find(block)
                                val lon = coordMatch?.groupValues?.getOrNull(1)?.toDoubleOrNull()
                                val lat = coordMatch?.groupValues?.getOrNull(2)?.toDoubleOrNull()
                                val height = Regex("<wpml:executeHeight>([-.0-9]+)</wpml:executeHeight>")
                                    .find(block)
                                    ?.groupValues
                                    ?.getOrNull(1)
                                    ?.toDoubleOrNull()

                                if (index == null || lat == null || lon == null) {
                                    null
                                } else {
                                    mapOf(
                                        "index" to index,
                                        "latitude" to lat,
                                        "longitude" to lon,
                                        "execute_height" to height,
                                        "kind" to "waypoint"
                                    )
                                }
                            }
                            .toList()

                        zip.closeEntry()

                        return@use WaylineMetadata(
                            waylineIds = if (waylineIds.isNotEmpty()) waylineIds else listOf(0),
                            autoFlightSpeed = speed,
                            securityTakeOffHeight = securityHeight,
                            waypoints = waypointSummaries
                        )
                    }
                    entry = zip.nextEntry
                }
            }
            WaylineMetadata()
        }.getOrElse {
            Log.w(TAG, "Failed to parse KMZ metadata: ${it.message}")
            WaylineMetadata()
        }
    }

    private fun computeTargetHeight(
        request: Request,
        takeoffAsl: Double?,
        currentHeight: Double,
        manualHeightOverride: Boolean
    ): Double {
        val mode = request.mode
        val flyToHeight = request.flyToHeight?.toDouble()
        val targetAsl = request.targetAltitudeAsl
        val relativeFromAsl = if (targetAsl != null && takeoffAsl != null) targetAsl - takeoffAsl else null

        val desired = when {
            mode == FlyToMode.SET_HEIGHT && flyToHeight != null -> flyToHeight
            relativeFromAsl != null -> relativeFromAsl
            flyToHeight != null -> flyToHeight
            mode == FlyToMode.SMART_HEIGHT -> currentHeight
            else -> currentHeight
        }

        if (manualHeightOverride) {
            return max(MIN_HEIGHT, desired)
        }

        val securityFloor = request.securityTakeoffHeight
            ?.takeIf { !it.isNaN() && it > 0.0 }
            ?: DEFAULT_SECURITY_TAKEOFF_HEIGHT

        return max(max(MIN_HEIGHT, desired), securityFloor)
    }

    private fun createMissionFile(context: Context): File {
        val dir = File(context.cacheDir, "fly_to_waypoints")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        val fileName = "fly_to_${System.currentTimeMillis()}.kmz"
        return File(dir, fileName)
    }

    private fun buildMissionFiles(
        missionFile: File,
        currentLocation: LocationCoordinate3D?,
        targetLocation: LocationCoordinate3D,
        targetRelativeHeight: Double,
        currentRelativeHeight: Double,
        speed: Double,
        securityTakeoffHeight: Double?,
        horizontalDistance: Double?,
        estimatedDuration: Double?,
        droneInfoResult: DroneInfoResult?,
        manualHeightOverride: Boolean,
        plan: List<PlanPointResolved>,
        finishAction: WaylineFinishedAction
    ) {
        val securityFloor = securityTakeoffHeight
            ?.takeIf { !it.isNaN() && it > 0.0 }
            ?: DEFAULT_SECURITY_TAKEOFF_HEIGHT
        val usingPlan = plan.isNotEmpty()

        val targetHeight = if (usingPlan) {
            plan.last().executeHeight
        } else if (manualHeightOverride) {
            max(MIN_HEIGHT, targetRelativeHeight)
        } else {
            max(max(MIN_HEIGHT, targetRelativeHeight), securityFloor)
        }

        val startHeight = if (usingPlan) {
            val firstPlanHeight = plan.firstOrNull()?.executeHeight
            when {
                firstPlanHeight != null && !currentRelativeHeight.isNaN() -> max(firstPlanHeight, max(MIN_HEIGHT, currentRelativeHeight))
                firstPlanHeight != null -> max(MIN_HEIGHT, firstPlanHeight)
                currentRelativeHeight.isNaN() -> targetHeight
                else -> max(MIN_HEIGHT, max(currentRelativeHeight, securityFloor))
            }
        } else if (manualHeightOverride) {
            when {
                currentRelativeHeight.isNaN() -> targetHeight
                currentRelativeHeight > targetHeight -> currentRelativeHeight
                else -> targetHeight
            }
        } else {
            val currentSafe = if (currentRelativeHeight.isNaN()) MIN_HEIGHT else currentRelativeHeight
            max(targetHeight, max(MIN_HEIGHT, max(currentSafe, securityFloor)))
        }

        val waypoints = mutableListOf<WaylineExecuteWaypoint>()
        val waypointSummaries = mutableListOf<Map<String, Any?>>()

        if (currentLocation != null) {
            val firstPlan = plan.firstOrNull()
            waypoints.add(
                createWaypoint(
                    index = 0,
                    latitude = currentLocation.latitude,
                    longitude = currentLocation.longitude,
                    executeHeight = startHeight,
                    speed = speed,
                    gimbalPitch = null,
                    turnMode = firstPlan?.turnMode,
                    turnDamping = firstPlan?.turnDamping,
                    useStraightLine = firstPlan?.useStraightLine
                )
            )
            waypointSummaries.add(
                mapOf(
                    "index" to 0,
                    "latitude" to currentLocation.latitude,
                    "longitude" to currentLocation.longitude,
                    "execute_height" to startHeight,
                    "kind" to "start"
                )
            )
        }

        if (usingPlan) {
            plan.forEach { point ->
                val waypointIndex = waypoints.size
                val waypoint = createWaypoint(
                    index = waypointIndex,
                    latitude = point.latitude,
                    longitude = point.longitude,
                    executeHeight = point.executeHeight,
                    speed = speed,
                    gimbalPitch = point.gimbalPitch,
                    turnMode = point.turnMode,
                    turnDamping = point.turnDamping,
                    useStraightLine = point.useStraightLine
                )
                waypoints.add(waypoint)
                waypointSummaries.add(
                    mapOf(
                        "index" to waypointIndex,
                        "latitude" to point.latitude,
                        "longitude" to point.longitude,
                        "execute_height" to point.executeHeight,
                        "kind" to (point.kind ?: "waypoint")
                    )
                )
            }
        } else {
            val targetIndex = waypoints.size
            val lastPlan = plan.lastOrNull()
            val targetWaypoint = createWaypoint(
                index = targetIndex,
                latitude = targetLocation.latitude,
                longitude = targetLocation.longitude,
                executeHeight = targetHeight,
                speed = speed,
                gimbalPitch = lastPlan?.gimbalPitch,
                turnMode = lastPlan?.turnMode,
                turnDamping = lastPlan?.turnDamping,
                useStraightLine = lastPlan?.useStraightLine
            )
            waypoints.add(targetWaypoint)
            waypointSummaries.add(
                mapOf(
                    "index" to targetIndex,
                    "latitude" to targetLocation.latitude,
                    "longitude" to targetLocation.longitude,
                    "execute_height" to targetHeight,
                    "kind" to if (targetIndex == 0) "waypoint" else "target"
                )
            )
        }

        val wayline = Wayline().apply {
            setWaylineId(0)
            setTemplateId(0)
            setAutoFlightSpeed(speed)
            setMode(WaylineExecuteAltitudeMode.RELATIVE_TO_START_POINT)
            setCoordinateMode(WaylineExecuteCoordinateMode.WGS84)
            setWaypoints(waypoints)
            setWaylineStartActions(emptyList())
            setActionGroups(emptyList())
        }

        activeMissionWaypoints.set(waypointSummaries.toList())
        activeMissionSecurityHeight.set(securityFloor)

        val mission = WaylineMission().apply {
            val now = System.currentTimeMillis().toDouble()
            setCreateTime(now)
            setUpdateTime(now)
            setAuthor("bridge")
        }

        val config = WaylineMissionConfig().apply {
            setFlyToWaylineMode(WaylineFlyToWaylineMode.SAFELY)
            setFinishAction(finishAction)
            setExitOnRCLostBehavior(dji.sdk.wpmz.value.mission.WaylineExitOnRCLostBehavior.EXCUTE_RC_LOST_ACTION)
            setExitOnRCLostType(dji.sdk.wpmz.value.mission.WaylineExitOnRCLostAction.GO_BACK)
            setGlobalTransitionalSpeed(speed)
            securityTakeoffHeight?.let {
                setSecurityTakeOffHeight(it)
                setIsSecurityTakeOffHeightSet(true)
            }
            val droneInfo = droneInfoResult?.info ?: WaylineDroneInfo().apply {
                setDroneType(WaylineDroneType.UNKNOWN)
                setDroneSubType(0)
            }
            setDroneInfo(droneInfo)
            setPayloadInfo(emptyList())
        }

        horizontalDistance?.let { setWaylineMetric(wayline, it, "setWaylineDistance", "setDistance") }
        estimatedDuration?.let { setWaylineMetric(wayline, it, "setWaylineDuration", "setDuration") }

        runCatching {
            missionFile.parentFile?.let { parent ->
                if (!parent.exists()) {
                    parent.mkdirs()
                }
            }
            WPMZManager.getInstance().generateKMZFile(missionFile.absolutePath, mission, config, wayline)
        }.onFailure {
            Log.e(TAG, "generateKMZFile failed: ${it.message}", it)
            throw it
        }
    }

    private fun createWaypoint(
        index: Int,
        latitude: Double,
        longitude: Double,
        executeHeight: Double,
        speed: Double,
        gimbalPitch: Double?,
        turnMode: String?,
        turnDamping: Double?,
        useStraightLine: Boolean?
    ): WaylineExecuteWaypoint {
        val yawParam = WaylineWaypointYawParam().apply {
            setYawMode(WaylineWaypointYawMode.FOLLOW_WAYLINE)
            setEnableYawAngle(false)
            setYawAngle(0.0)
            setYawPathMode(WaylineWaypointYawPathMode.FOLLOW_BAD_ARC)
            setPoiIndex(0)
        }
        val gimbalParam = WaylineWaypointGimbalHeadingParam().apply {
            setHeadingMode(WaylineWaypointGimbalHeadingMode.FOLLOW_WAYLINE)
            setYawAngle(0.0)
            val pitch = gimbalPitch?.coerceIn(-90.0, 30.0) ?: 0.0
            setPitchAngle(pitch)
        }
        val turnParam = WaylineWaypointTurnParam().apply {
            val enumMode = mapTurnModeToEnum(turnMode)
            if (enumMode != null) {
                setTurnMode(enumMode)
            } else {
                setTurnMode(WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_DISCONTINUITY_CURVATURE)
            }
            val dampingValue = turnDamping ?: defaultDampingForTurn(turnMode)
            setTurnDampingDistance(dampingValue ?: 0.0)
        }
        return WaylineExecuteWaypoint().apply {
            setWaypointIndex(index)
            setLocation(WaylineLocationCoordinate2D(latitude, longitude))
            setExecuteHeight(max(MIN_HEIGHT, executeHeight))
            setYawParam(yawParam)
            setGimbalHeadingParam(gimbalParam)
            setTurnParam(turnParam)
            setSpeed(max(MIN_SPEED, speed))
            setUseStraightLine(useStraightLine ?: true)
            setIsRisky(false)
            setWaypointWorkType(0)
        }
    }

    private fun uploadAndStartMission(
        missionFile: File,
        missionId: String,
        waylineIds: List<Int>,
        speed: Double,
        reason: String,
        extra: Map<String, Any?>?,
        callback: (Result) -> Unit
    ) {
        if (!uploadInProgress.compareAndSet(false, true)) {
            Log.w(TAG, "Rejecting mission request while upload is in progress")
            callback(
                Result.Failure(
                    message = "Waypoint mission busy",
                    extra = mapOf(
                        "backend" to BACKEND_ID,
                        "mission_id" to missionId,
                        "mission_path" to missionFile.absolutePath,
                        "wayline_ids" to waylineIds,
                        "debug" to extra
                    )
                )
            )
            return
        }

        val missionManager = WaypointMissionManager.getInstance()

        runOnUiThread {
            missionManager.pushKMZFileToAircraft(
                missionFile.absolutePath,
                object : CommonCallbacks.CompletionCallbackWithProgress<Double> {
                    override fun onProgressUpdate(progress: Double) {
                        Log.d(TAG, "Waypoint KMZ upload progress ${(progress * 100).toInt()}%")
                    }

                    override fun onSuccess() {
                        Log.i(TAG, "Waypoint KMZ upload success: ${missionFile.name}")
                        startMission(missionManager, missionId, waylineIds, missionFile, speed, reason, extra, callback)
                    }

                    override fun onFailure(error: IDJIError) {
                        Log.e(TAG, "Waypoint KMZ upload failed: ${error.description()}")
                        clearActiveMission()
                        callback(
                            Result.Failure(
                                message = "Waypoint upload failed: ${error.description()}",
                                error = error,
                                extra = mapOf(
                                    "backend" to BACKEND_ID,
                                    "mission_id" to missionId,
                                    "mission_path" to missionFile.absolutePath,
                                    "wayline_ids" to waylineIds,
                                    "debug" to extra
                                )
                            )
                        )
                    }
                }
            )
        }
    }

    private fun startMission(
        missionManager: WaypointMissionManager,
        missionId: String,
        waylineIds: List<Int>,
        missionFile: File,
        speed: Double,
        reason: String,
        extra: Map<String, Any?>?,
        callback: (Result) -> Unit
    ) {
        missionManager.startMission(
            missionId,
            waylineIds,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Waypoint mission start acknowledged: $missionId -> $waylineIds")
                    val watcher = MissionStartWatcher(
                        missionId = missionId,
                        missionFile = missionFile,
                        waylineIds = waylineIds,
                        speed = speed,
                        reason = reason,
                        extra = extra,
                        callback = callback
                    )
                    startWatcherRef.getAndSet(watcher)?.cancel()
                    watcher.begin()
                }

                override fun onFailure(error: IDJIError) {
                    Log.e(TAG, "Waypoint mission start failed: ${error.description()}")
                    clearActiveMission()
                    callback(
                        Result.Failure(
                            message = "Waypoint mission start failed: ${error.description()}",
                            error = error,
                            extra = mapOf(
                                "backend" to BACKEND_ID,
                                "mission_id" to missionId,
                                "mission_path" to missionFile.absolutePath,
                                "wayline_ids" to waylineIds,
                                "dji_error_code" to error.errorCode()?.toString(),
                                "dji_error_description" to error.description(),
                                "debug" to extra
                            )
                        )
                    )
                }
            }
        )
    }

    fun currentMissionId(): String? = activeMissionId.get()

    fun currentMissionSnapshot(): Map<String, Any?>? = activeMissionId.get()?.let { id ->
        mutableMapOf<String, Any?>(
            "mission_id" to id,
            "mission_path" to activeMissionPath.get(),
            "backend" to BACKEND_ID
        ).also { map ->
            val waypoints = activeMissionWaypoints.get()
            if (waypoints.isNotEmpty()) {
                map["waypoints"] = waypoints
            }
            activeMissionSecurityHeight.get()?.let { map["security_takeoff_height"] = it }
        }
    }

    fun stopActiveMission(callback: CommonCallbacks.CompletionCallback): Boolean {
        val missionId = activeMissionId.get() ?: return false
        runOnUiThread {
            missionManager.stopMission(missionId, object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    clearActiveMission()
                    callback.onSuccess()
                }

                override fun onFailure(error: IDJIError) {
                    callback.onFailure(error)
                }
            })
        }
        return true
    }

    fun pauseActiveMission(callback: CommonCallbacks.CompletionCallback): Boolean {
        runOnUiThread {
            missionManager.pauseMission(object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    callback.onSuccess()
                }

                override fun onFailure(error: IDJIError) {
                    callback.onFailure(error)
                }
            })
        }
        return true
    }

    fun resumeActiveMission(callback: CommonCallbacks.CompletionCallback): Boolean {
        runOnUiThread {
            missionManager.resumeMission(object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    callback.onSuccess()
                }

                override fun onFailure(error: IDJIError) {
                    callback.onFailure(error)
                }
            })
        }
        return true
    }

    fun clearActiveMission() {
        activeMissionId.set(null)
        activeMissionPath.set(null)
        activeMissionWaypoints.set(emptyList())
        activeMissionSecurityHeight.set(null)
        uploadInProgress.set(false)
        startWatcherRef.getAndSet(null)?.cancel()
    }

    fun backendId(): String = BACKEND_ID

    companion object {
        private const val BACKEND_ID = "waypoint_v2"
        private const val DEFAULT_SPEED = 3.0
        private const val DEFAULT_VERTICAL_SPEED = 1.5
        private const val MIN_SPEED = 0.5
        private const val MIN_VERTICAL_SPEED = 0.5
        private const val MIN_HEIGHT = 0.0
        private const val DEFAULT_SECURITY_TAKEOFF_HEIGHT = 20.0
        private const val CURVED_TURN_DAMPING_DISTANCE = 10.0
        private const val WAYLINES_WPML_PATH = "wpmz/waylines.wpml"
        private const val WPML_NAMESPACE = "http://www.dji.com/wpmz/1.0.6"
        private const val WPML_TURN_MODE_PASS_WITH_CONTINUITY = "toPointAndPassWithContinuityCurvature"
        private const val WPML_TURN_MODE_STOP_WITH_DISCONTINUITY = "toPointAndStopWithDiscontinuityCurvature"
        private const val WPML_TURN_MODE_STOP_WITH_CONTINUITY = "toPointAndStopWithContinuityCurvature"
        private const val WPML_TURN_MODE_COORDINATE = "coordinateTurn"
        private val TURN_MODE_ENUM_MAP: Map<String, WaylineWaypointTurnMode> = mapOf(
            WPML_TURN_MODE_PASS_WITH_CONTINUITY to WaylineWaypointTurnMode.TO_POINT_AND_PASS_WITH_CONTINUITY_CURVATURE,
            WPML_TURN_MODE_STOP_WITH_DISCONTINUITY to WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_DISCONTINUITY_CURVATURE,
            WPML_TURN_MODE_STOP_WITH_CONTINUITY to WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_CONTINUITY_CURVATURE,
            WPML_TURN_MODE_COORDINATE to WaylineWaypointTurnMode.COORDINATE_TURN,
            WPML_TURN_MODE_PASS_WITH_CONTINUITY.lowercase(Locale.US) to WaylineWaypointTurnMode.TO_POINT_AND_PASS_WITH_CONTINUITY_CURVATURE,
            WPML_TURN_MODE_STOP_WITH_DISCONTINUITY.lowercase(Locale.US) to WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_DISCONTINUITY_CURVATURE,
            WPML_TURN_MODE_STOP_WITH_CONTINUITY.lowercase(Locale.US) to WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_CONTINUITY_CURVATURE,
            WPML_TURN_MODE_COORDINATE.lowercase(Locale.US) to WaylineWaypointTurnMode.COORDINATE_TURN
        )
        private val DRONE_TYPE_OVERRIDES = mapOf(
            "MATRICE_350_RTK" to 89,
            "M350_RTK" to 89
        )
        private val droneTypeLogged = AtomicBoolean(false)
        private val TERMINAL_STATES = setOf(
            "ready",
            "finished",
            "idle",
            "not_supported"
        )
        private val IGNORED_STATES = setOf(
            "uploading",
            "ready",
            "idle",
            "not_supported"
        )
        private val START_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(6)
        private const val START_SUCCESS_DELAY_MS = 1500L

        private fun resolveExecuteState(info: WaylineExecutingInfo): String? = callStringMethod(info, "executeState")
        private fun resolveExitReason(info: WaylineExecutingInfo): String? = callStringMethod(info, "exitReason")
        private fun resolveWaypointIndex(info: WaylineExecutingInfo): Int? = callIntMethod(info, "waypoint")

        private fun callStringMethod(info: WaylineExecutingInfo, keyword: String): String? {
            return runCatching {
                info.javaClass.methods.firstOrNull { method ->
                    method.parameterCount == 0 && method.name.contains(keyword, ignoreCase = true)
                }?.let { method ->
                    method.isAccessible = true
                    method.invoke(info)?.toString()
                }
            }.getOrNull()
        }

        private fun callIntMethod(info: WaylineExecutingInfo, keyword: String): Int? {
            return runCatching {
                info.javaClass.methods.firstOrNull { method ->
                    method.parameterCount == 0 && method.name.contains(keyword, ignoreCase = true)
                }?.let { method ->
                    method.isAccessible = true
                    val value = method.invoke(info)
                    when (value) {
                        is Number -> value.toInt()
                        is String -> value.toIntOrNull()
                        else -> null
                    }
                }
            }.getOrNull()
        }

        private fun isFailureExitReason(reason: String?): Boolean {
            if (reason.isNullOrBlank()) return false
            val normalized = reason.lowercase(Locale.ROOT)
            if (normalized.contains("normal") || normalized.contains("success") || normalized.contains("complete")) {
                return false
            }
            return true
        }
    }

    private inner class MissionStartWatcher(
        private val missionId: String,
        private val missionFile: File,
        private val waylineIds: List<Int>,
        private val speed: Double,
        private val reason: String,
        private val extra: Map<String, Any?>?,
        private val callback: (Result) -> Unit
    ) {
        private val resolved = AtomicBoolean(false)
        private var progress = false
        private var initialStateConsumed = false
        private var successPosted = false
        private var lastExecuteState: String? = null
        private var lastExitReason: String? = null
        private var lastWaypointIndex: Int? = null

        private val stateListener = WaypointMissionExecuteStateListener { state ->
            val stateName = state.name.lowercase(Locale.ROOT)
            if (resolved.get()) return@WaypointMissionExecuteStateListener
            Log.d(
                TAG,
                "MissionStartWatcher state=$stateName progress=$progress mission=$missionId exit=$lastExitReason exec=$lastExecuteState"
            )

            if (!initialStateConsumed) {
                initialStateConsumed = true
                if (stateName == "ready" || stateName == "uploading") {
                    return@WaypointMissionExecuteStateListener
                }
            }

            if (!IGNORED_STATES.contains(stateName) && !TERMINAL_STATES.contains(stateName)) {
                markProgress()
            } else if (TERMINAL_STATES.contains(stateName)) {
                handleTerminalState(stateName)
            }
        }

        private val executingInfoListener = object : WaylineExecutingInfoListener {
            override fun onWaylineExecutingInfoUpdate(info: WaylineExecutingInfo) {
                if (resolved.get()) return
                val execState = resolveExecuteState(info)
                val exitReason = resolveExitReason(info)
                val waypointIndex = resolveWaypointIndex(info)
                if (!execState.isNullOrBlank()) {
                    lastExecuteState = execState
                }
                if (!exitReason.isNullOrBlank()) {
                    lastExitReason = exitReason
                }
                if (waypointIndex != null) {
                    lastWaypointIndex = waypointIndex
                }
                Log.d(
                    TAG,
                    "MissionStartWatcher executing info mission=${info.missionFileName} exec=$execState exit=$exitReason index=$waypointIndex"
                )
                val normalizedState = execState?.lowercase(Locale.ROOT)
                if (!normalizedState.isNullOrBlank() && normalizedState != "unknown") {
                    markProgress()
                }
            }

            override fun onWaylineExecutingInterruptReasonUpdate(error: IDJIError?) {
                if (resolved.get()) return
                if (error != null) {
                    Log.w(TAG, "MissionStartWatcher interrupt mission=$missionId code=${error.errorCode()} reason=${error.description()}")
                    fail(
                        message = "Waypoint mission interrupted: ${error.description()}",
                        error = error,
                        extraInfo = mapOf(
                        "interrupt_code" to error.errorCode()?.toString(),
                        "interrupt_description" to error.description()
                    )
                )
            }
        }
        }

        private val timeoutRunnable = Runnable {
            if (resolved.get()) return@Runnable
            fail(
                message = "Mission start timeout",
                error = null,
                extraInfo = mapOf("timeout_ms" to START_TIMEOUT_MS)
            )
        }

        private val successRunnable = Runnable {
            if (!resolved.get()) {
                succeed()
            }
        }

        private fun markProgress() {
            if (!progress) {
                progress = true
            }
            scheduleSuccess()
        }

        private fun scheduleSuccess() {
            if (successPosted) return
            successPosted = true
            mainHandler.postDelayed(successRunnable, START_SUCCESS_DELAY_MS)
        }

        private fun cancelSuccess() {
            if (!successPosted) return
            successPosted = false
            mainHandler.removeCallbacks(successRunnable)
        }

        private fun handleTerminalState(stateName: String) {
            if (resolved.get()) return
            val exitReason = lastExitReason
            if (!progress) {
                fail(
                    message = "Mission aborted before execution (state=$stateName)",
                    error = null,
                    extraInfo = mapOf(
                        "mission_state" to stateName,
                        "exit_reason" to exitReason,
                        "execute_state" to lastExecuteState
                    )
                )
                return
            }

            if (isFailureExitReason(exitReason)) {
                fail(
                    message = exitReason ?: "Mission aborted (state=$stateName)",
                    error = null,
                    extraInfo = mapOf(
                        "mission_state" to stateName,
                        "exit_reason" to exitReason,
                        "execute_state" to lastExecuteState,
                        "last_waypoint_index" to lastWaypointIndex
                    )
                )
            }
        }

        fun begin() {
            runOnUiThread {
                missionManager.addWaypointMissionExecuteStateListener(stateListener)
                missionManager.addWaylineExecutingInfoListener(executingInfoListener)
            }
            mainHandler.postDelayed(timeoutRunnable, START_TIMEOUT_MS)
        }

        fun cancel() {
            mainHandler.removeCallbacks(timeoutRunnable)
            cancelSuccess()
            runOnUiThread {
                missionManager.removeWaypointMissionExecuteStateListener(stateListener)
                missionManager.removeWaylineExecutingInfoListener(executingInfoListener)
            }
        }

        private fun succeed() {
            if (!resolved.compareAndSet(false, true)) return
            cancel()
            startWatcherRef.compareAndSet(this, null)
            activeMissionId.set(missionId)
            activeMissionPath.set(missionFile.absolutePath)
            uploadInProgress.set(false)
            callback(
                Result.Success(
                    mapOf(
                        "backend" to BACKEND_ID,
                        "mission_id" to missionId,
                        "mission_path" to missionFile.absolutePath,
                        "wayline_ids" to waylineIds,
                        "auto_flight_speed" to speed,
                        "fallback_reason" to reason,
                        "debug" to extra
                    )
                )
            )
        }

        private fun fail(message: String, error: IDJIError?, extraInfo: Map<String, Any?> = emptyMap()) {
            if (!resolved.compareAndSet(false, true)) return
            cancel()
            startWatcherRef.compareAndSet(this, null)
            activeMissionId.set(null)
            activeMissionPath.set(null)
            uploadInProgress.set(false)
            val combinedExtra = mutableMapOf<String, Any?>(
                "backend" to BACKEND_ID,
                "mission_id" to missionId,
                "mission_path" to missionFile.absolutePath,
                "wayline_ids" to waylineIds,
                "fallback_reason" to reason,
                "debug" to extra
            )
            extraInfo.forEach { (key, value) -> combinedExtra[key] = value }
            callback(
                Result.Failure(
                    message = message,
                    error = error,
                    extra = combinedExtra.also {
                        it["auto_flight_speed"] = speed
                        it["mission_start_reason"] = reason
                        it["exit_reason"] = lastExitReason
                        it["execute_state"] = lastExecuteState
                        it["last_waypoint_index"] = lastWaypointIndex
                    }
                )
            )
        }
    }
}
