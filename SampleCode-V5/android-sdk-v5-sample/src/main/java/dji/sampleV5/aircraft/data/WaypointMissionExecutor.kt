package dji.sampleV5.aircraft.data

import android.content.Context
import android.util.Log
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.RtkMobileStationKey
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.sdk.keyvalue.value.flightcontroller.FlyToMode
import dji.sdk.keyvalue.value.rtkmobilestation.RTKTakeoffAltitudeInfo
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.common.utils.GpsUtils
import dji.v5.manager.KeyManager
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
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max

/**
 * Builds and executes minimal Waypoint V2 missions to mimic Fly-To when Intelligent Fly-To
 * is unavailable (e.g., Matrice 350 RTK).
 */
class WaypointMissionExecutor(
    private val contextProvider: () -> Context?,
    private val runOnUiThread: (action: () -> Unit) -> Unit
) {

    data class Request(
        val targetLocation: LocationCoordinate3D,
        val targetAltitudeAsl: Double?,
        val mode: FlyToMode?,
        val flyToHeight: Int?,
        val maxSpeed: Double?,
        val securityTakeoffHeight: Double?,
        val reason: String
    )

    sealed class Result {
        data class Success(val extra: Map<String, Any?> = emptyMap()) : Result()
        data class Failure(
            val message: String?,
            val error: IDJIError? = null,
            val extra: Map<String, Any?> = emptyMap()
        ) : Result()
    }

    private val TAG = "WaypointMissionExecutor"
    private val initialized = AtomicBoolean(false)
    private val missionManager by lazy { WaypointMissionManager.getInstance() }
    private val activeMissionId = AtomicReference<String?>(null)
    private val activeMissionPath = AtomicReference<String?>(null)

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

        val targetRelativeHeight = computeTargetHeight(
            request = request,
            takeoffAsl = takeoffAsl,
            currentHeight = currentHeight
        )

        val missionFile = createMissionFile(context)
        val missionId = missionFile.nameWithoutExtension

        val buildResult = runCatching {
            buildMissionFiles(
                missionFile = missionFile,
                currentLocation = currentLocation,
                targetLocation = request.targetLocation,
                targetRelativeHeight = targetRelativeHeight,
                currentRelativeHeight = currentHeight,
                speed = request.maxSpeed ?: DEFAULT_SPEED,
                securityTakeoffHeight = request.securityTakeoffHeight
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
            callback = callback
        )
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

    private fun computeTakeoffAsl(
        rtkTakeoffInfo: RTKTakeoffAltitudeInfo?,
        takeoffAltitudeRaw: Double?,
        homeLocation: LocationCoordinate2D?,
        aircraftLocation: LocationCoordinate2D?,
        relativeAltitude: Double
    ): Double? {
        val lat = homeLocation?.latitude ?: aircraftLocation?.latitude
        val lon = homeLocation?.longitude ?: aircraftLocation?.longitude

        val homePointAltitude = rtkTakeoffInfo?.altitude?.toDouble() ?: takeoffAltitudeRaw
        val ellipsoidTotal = homePointAltitude?.let { it + relativeAltitude }

        val altitudeAsl = when {
            ellipsoidTotal != null && lat != null && lon != null && !lat.isNaN() && !lon.isNaN() ->
                runCatching { GpsUtils.egm96Altitude(ellipsoidTotal, lat, lon) }.getOrNull()
            ellipsoidTotal != null -> ellipsoidTotal
            else -> null
        }

        if (altitudeAsl != null) {
            return altitudeAsl - relativeAltitude
        }

        return homePointAltitude ?: takeoffAltitudeRaw
    }

    private fun computeTargetHeight(
        request: Request,
        takeoffAsl: Double?,
        currentHeight: Double
    ): Double {
        val mode = request.mode
        val flyToHeight = request.flyToHeight?.toDouble()
        val targetAsl = request.targetAltitudeAsl
        val relativeFromAsl = if (targetAsl != null && takeoffAsl != null) targetAsl - takeoffAsl else null

        return when {
            mode == FlyToMode.SET_HEIGHT && flyToHeight != null -> flyToHeight
            mode == FlyToMode.SMART_HEIGHT -> currentHeight
            relativeFromAsl != null -> relativeFromAsl
            flyToHeight != null -> flyToHeight
            else -> currentHeight
        }.let { max(MIN_HEIGHT, it) }
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
        securityTakeoffHeight: Double?
    ) {
        val waypoints = mutableListOf<WaylineExecuteWaypoint>()

        if (currentLocation != null) {
            waypoints.add(
                createWaypoint(
                    index = 0,
                    latitude = currentLocation.latitude,
                    longitude = currentLocation.longitude,
                    executeHeight = currentRelativeHeight,
                    speed = speed
                )
            )
        }

        val targetIndex = waypoints.size
        val targetWaypoint = createWaypoint(
            index = targetIndex,
            latitude = targetLocation.latitude,
            longitude = targetLocation.longitude,
            executeHeight = targetRelativeHeight,
            speed = speed
        )
        waypoints.add(targetWaypoint)

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

        val mission = WaylineMission().apply {
            val now = System.currentTimeMillis().toDouble()
            setCreateTime(now)
            setUpdateTime(now)
            setAuthor("bridge")
        }

        val config = WaylineMissionConfig().apply {
            setFlyToWaylineMode(WaylineFlyToWaylineMode.SAFELY)
            setFinishAction(WaylineFinishedAction.NO_ACTION)
            setExitOnRCLostBehavior(dji.sdk.wpmz.value.mission.WaylineExitOnRCLostBehavior.EXCUTE_RC_LOST_ACTION)
            setExitOnRCLostType(dji.sdk.wpmz.value.mission.WaylineExitOnRCLostAction.GO_BACK)
            setGlobalTransitionalSpeed(speed)
            securityTakeoffHeight?.let {
                setSecurityTakeOffHeight(it)
                setIsSecurityTakeOffHeightSet(true)
            }
            setDroneInfo(WaylineDroneInfo().apply {
                setDroneType(WaylineDroneType.UNKNOWN)
                setDroneSubType(0)
            })
            setPayloadInfo(emptyList())
        }

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
        speed: Double
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
            setPitchAngle(0.0)
        }
        val turnParam = WaylineWaypointTurnParam().apply {
            setTurnMode(WaylineWaypointTurnMode.TO_POINT_AND_STOP_WITH_DISCONTINUITY_CURVATURE)
            setTurnDampingDistance(0.0)
        }
        return WaylineExecuteWaypoint().apply {
            setWaypointIndex(index)
            setLocation(WaylineLocationCoordinate2D(latitude, longitude))
            setExecuteHeight(max(MIN_HEIGHT, executeHeight))
            setYawParam(yawParam)
            setGimbalHeadingParam(gimbalParam)
            setTurnParam(turnParam)
            setSpeed(max(MIN_SPEED, speed))
            setUseStraightLine(true)
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
        callback: (Result) -> Unit
    ) {
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
                        startMission(missionManager, missionId, waylineIds, missionFile, speed, reason, callback)
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
                                    "wayline_ids" to waylineIds
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
        callback: (Result) -> Unit
    ) {
        missionManager.startMission(
            missionId,
            waylineIds,
            object : CommonCallbacks.CompletionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "Waypoint mission started: $missionId -> $waylineIds")
                    activeMissionId.set(missionId)
                    activeMissionPath.set(missionFile.absolutePath)
                    callback(
                        Result.Success(
                            mapOf(
                                "backend" to BACKEND_ID,
                                "mission_id" to missionId,
                                "mission_path" to missionFile.absolutePath,
                                "wayline_ids" to waylineIds,
                                "auto_flight_speed" to speed,
                                "fallback_reason" to reason
                            )
                        )
                    )
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
                                "wayline_ids" to waylineIds
                            )
                        )
                    )
                }
            }
        )
    }

    fun currentMissionId(): String? = activeMissionId.get()

    fun currentMissionSnapshot(): Map<String, Any?>? = activeMissionId.get()?.let { id ->
        mapOf(
            "mission_id" to id,
            "mission_path" to activeMissionPath.get(),
            "backend" to BACKEND_ID
        )
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

    fun clearActiveMission() {
        activeMissionId.set(null)
        activeMissionPath.set(null)
    }

    fun backendId(): String = BACKEND_ID

    companion object {
        private const val BACKEND_ID = "waypoint_v2"
        private const val DEFAULT_SPEED = 3.0
        private const val MIN_SPEED = 0.5
        private const val MIN_HEIGHT = 0.0
    }
}
