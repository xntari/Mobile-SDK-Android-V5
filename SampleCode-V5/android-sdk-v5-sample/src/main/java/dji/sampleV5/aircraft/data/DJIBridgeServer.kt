package dji.sampleV5.aircraft.data

import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.SurfaceView
import android.view.SurfaceHolder
import android.graphics.SurfaceTexture
import android.app.Activity
import android.os.Handler
import dji.sampleV5.aircraft.models.LookAtVM
import dji.sampleV5.aircraft.models.CameraStreamDetailVM
import dji.sampleV5.aircraft.models.FlySafeBridgeModel
import dji.v5.utils.common.LogUtils
import dji.v5.common.utils.GpsUtils
import dji.v5.manager.diagnostic.DeviceHealthManager
import dji.v5.manager.diagnostic.DeviceStatusManager
import dji.v5.manager.diagnostic.DJIDeviceHealthInfo
import dji.v5.manager.diagnostic.DJIDeviceStatus
import dji.v5.manager.diagnostic.WarningLevel
import dji.sdk.keyvalue.key.AirLinkKey
import dji.sdk.keyvalue.key.RtkMobileStationKey
import dji.sdk.keyvalue.value.rtkmobilestation.RTKTakeoffAltitudeInfo
import dji.sdk.keyvalue.value.flightcontroller.GPSSignalLevel
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.KeyTools
import dji.v5.manager.KeyManager
import dji.v5.manager.datacenter.MediaDataCenter
import dji.v5.manager.interfaces.ICameraStreamManager
import dji.sdk.keyvalue.key.CameraKey
import dji.sdk.keyvalue.key.GimbalKey
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.sdk.keyvalue.value.flightcontroller.FlightMode
import dji.sdk.keyvalue.value.common.Velocity3D
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.sdk.keyvalue.value.common.Attitude
import dji.v5.manager.datacenter.camera.view.PinPoint
import dji.v5.manager.datacenter.camera.view.PinPointInfo
import dji.sdk.keyvalue.value.gimbal.GimbalAttitudeRange
import dji.v5.manager.aircraft.perception.PerceptionManager
import dji.v5.manager.aircraft.perception.data.ObstacleData
import dji.v5.manager.aircraft.perception.data.PerceptionInfo
import dji.v5.manager.aircraft.perception.listener.ObstacleDataListener
import dji.v5.manager.aircraft.perception.listener.PerceptionInformationListener
import dji.v5.manager.aircraft.perception.radar.RadarInformation
import dji.v5.manager.aircraft.perception.radar.RadarInformationListener
import org.json.JSONObject
import org.json.JSONArray
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.collections.ArrayList
import dji.sdk.keyvalue.value.camera.TapZoomMode
import dji.sdk.keyvalue.value.camera.ZoomTargetPointInfo
import dji.sdk.keyvalue.value.camera.CameraVideoStreamSourceType
import dji.sdk.keyvalue.value.camera.ZoomRatiosRange
import dji.sdk.keyvalue.value.common.CameraLensType
import dji.sdk.keyvalue.value.gimbal.GimbalSpeedRotation
import dji.sdk.keyvalue.value.gimbal.CtrlInfo
// GeographicLib import removed - using SDK-based conversion
import dji.sdk.keyvalue.value.flightcontroller.LookAtInfo
import dji.sdk.keyvalue.value.flightcontroller.LookAtMode
import dji.sdk.keyvalue.value.common.EmptyMsg
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.virtualstick.VirtualStickManager
import dji.v5.manager.aircraft.virtualstick.VirtualStickState
import dji.v5.manager.aircraft.virtualstick.VirtualStickStateListener
import dji.sdk.keyvalue.value.flightcontroller.FlightControlAuthority
import dji.sdk.keyvalue.value.flightcontroller.FlightControlAuthorityChangeReason
import dji.v5.et.createCamera
import dji.v5.et.create
import dji.v5.et.action
import dji.v5.et.set

/**
 * DJI Bridge WebSocket Server - Extensible Implementation
 * 
 * Comprehensive WebSocket server supporting:
 * - Real-time sensor data streaming (joystick, telemetry, GPS, etc.)
 * - Video frame transmission (H.264 binary data)
 * - Bidirectional command processing (waypoints, camera control)
 * - Protocol versioning and extensibility
 */
class DJIBridgeServer(private val port: Int, private val bridgeActivity: Any) {
    
    companion object {
        private const val TAG = "DJIBridgeServer"
        private const val WEBSOCKET_MAGIC_STRING = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val PROTOCOL_VERSION = "1.0"

        // Real SurfaceViews for SDK projection
        private var fpvSurfaceView: SurfaceView? = null
        private var secondarySurfaceView: SurfaceView? = null
        private var fpvSurface: Surface? = null
        private var secondarySurface: Surface? = null
        private var surfacesReady = false
        private val surfaceReadyCallbacks = mutableMapOf<ComponentIndexType, () -> Unit>()
        private var activity: Activity? = null

        // Use the EXACT same ViewModels as the Look At example
        private val lookAtVM = LookAtVM()
    private val cameraVM = CameraStreamDetailVM()
    }

    private val waypointMissionExecutor = WaypointMissionExecutor(
        contextProvider = {
            val act = activity ?: (bridgeActivity as? Activity)
            act?.applicationContext
        },
        runOnUiThread = ::runOnUiThread
    )

    private val flySafeBridgeModel = FlySafeBridgeModel()
    private val flyToBridgeModel = FlyToMissionBridgeModel()
    private val waypointBridgeModel = WaypointMissionBridgeModel(waypointMissionExecutor)
    private val simulatorBridgeModel = SimulatorBridgeModel()

    private val diagnosticAggregator = DiagnosticAggregator { flySafeBridgeModel.toSnapshotMap() }

    init {
        try {
            VirtualStickManager.getInstance().setVirtualStickStateListener(object : VirtualStickStateListener {
                override fun onVirtualStickStateUpdate(stickState: VirtualStickState) {
                    latestVirtualStickState = stickState
                }

                override fun onChangeReasonUpdate(reason: FlightControlAuthorityChangeReason) {
                    latestVirtualStickReason = reason
                }
            })
            Log.i(TAG, "Virtual stick state listener registered")
        } catch (e: Exception) {
            Log.w(TAG, "Unable to register virtual stick state listener: ${e.message}")
        }
        flySafeBridgeModel.start()
        flyToBridgeModel.start()
        waypointBridgeModel.start()
        simulatorBridgeModel.start()
    }

    // Retry helper for camera stream registration
    private fun registerCameraStreamWithRetry(
        componentIndex: ComponentIndexType,
        surface: android.view.Surface,
        width: Int,
        height: Int,
        surfaceName: String,
        maxRetries: Int = 3,
        delayMs: Long = 500
    ) {
        var retryCount = 0
        var registered = false

        while (retryCount < maxRetries && !registered) {
            try {
                // Register with ViewModels
                cameraVM.setCameraIndex(componentIndex)
                cameraVM.putCameraStreamSurface(
                    surface,
                    width,
                    height,
                    ICameraStreamManager.ScaleType.CENTER_INSIDE
                )

                // Also register directly with MediaDataCenter
                MediaDataCenter.getInstance().cameraStreamManager.putCameraStreamSurface(
                    componentIndex,
                    surface,
                    width,
                    height,
                    ICameraStreamManager.ScaleType.CENTER_INSIDE
                )

                // Enable the stream
                MediaDataCenter.getInstance().cameraStreamManager.enableStream(componentIndex, true)

                registered = true
                Log.i(TAG, "*** $surfaceName surface registered successfully on attempt ${retryCount + 1} ***")

            } catch (e: Exception) {
                retryCount++
                Log.w(TAG, "$surfaceName stream registration failed (attempt $retryCount/$maxRetries): ${e.message}")

                if (retryCount < maxRetries) {
                    Log.i(TAG, "Retrying $surfaceName registration in ${delayMs}ms...")
                    Thread.sleep(delayMs)
                } else {
                    Log.e(TAG, "Failed to register $surfaceName after $maxRetries attempts", e)
                }
            }
        }
    }

    private fun collectGimbalSnapshot(index: ComponentIndexType, keyManager: KeyManager): Map<String, Any?>? {
        return try {
            val attitude = keyManager.getValue(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, index)) as? Attitude
            val limits = keyManager.getValue(KeyTools.createKey(GimbalKey.KeyGimbalAttitudeRange, index)) as? GimbalAttitudeRange
            val yawRelative = keyManager.getValue(KeyTools.createKey(GimbalKey.KeyYawRelativeToAircraftHeading, index)) as? Double
            val connected = keyManager.getValue(KeyTools.createKey(GimbalKey.KeyConnection, index)) as? Boolean ?: false
            if (attitude == null && !connected) {
                return null
            }
            mapOf(
                "index" to index.name,
                "connected" to connected,
                "attitude" to attitude?.let {
                    mapOf(
                        "pitch" to it.pitch.toDouble(),
                        "roll" to it.roll.toDouble(),
                        "yaw" to it.yaw.toDouble()
                    )
                },
                "yaw_relative" to yawRelative,
                "limits" to limits?.let {
                    mapOf(
                        "pitch" to mapOf("min" to it.pitch?.min, "max" to it.pitch?.max),
                        "yaw" to mapOf("min" to it.yaw?.min, "max" to it.yaw?.max),
                        "roll" to mapOf("min" to it.roll?.min, "max" to it.roll?.max)
                    )
                }
            )
        } catch (e: Exception) {
            Log.w(TAG, "collectGimbalSnapshot error for $index: ${e.message}")
            null
        }
    }

    private fun collectCameraOpticsSnapshot(index: ComponentIndexType, keyManager: KeyManager): Map<String, Any?> {
        return try {
            val lens = keyManager.getValue(CameraKey.KeyCameraVideoStreamSource.create(index)) as? CameraVideoStreamSourceType
            val activeLens = getActiveCameraLens(index)
            val zoomLens = CameraLensType.CAMERA_LENS_ZOOM
            val zoomKey = KeyTools.createCameraKey<Double>(CameraKey.KeyCameraZoomRatios, index, zoomLens)
            val zoomRatio = keyManager.getValue(zoomKey) as? Double
            val laserInfo = try {
                val laserKey = KeyTools.createCameraKey(CameraKey.KeyLaserMeasureInformation, index, CameraLensType.CAMERA_LENS_ZOOM)
                keyManager.getValue(laserKey)
            } catch (_: Exception) {
                null
            }
            val result = mutableMapOf<String, Any?>(
                "index" to index.name,
                "lens" to lens?.name,
                "lens_type" to activeLens.name
            )
            if (zoomRatio != null) {
                result["zoom_ratio"] = zoomRatio
            }
            val zoomRangeKey = try {
                KeyTools.createCameraKey<ZoomRatiosRange>(CameraKey.KeyCameraZoomRatiosRange, index, zoomLens)
            } catch (_: Exception) {
                null
            }
            if (zoomRangeKey != null) {
                val rangeValue = try {
                    keyManager.getValue(zoomRangeKey)
                } catch (_: Exception) {
                    null
                }
                val rangeMap = when (rangeValue) {
                    is ZoomRatiosRange -> {
                        fun extract(methodNames: List<String>): Double? {
                            for (name in methodNames) {
                                try {
                                    val method = rangeValue.javaClass.getMethod(name)
                                    val value = method.invoke(rangeValue) as? Number
                                    if (value != null) {
                                        return value.toDouble()
                                    }
                                } catch (_: Exception) {
                                    // Ignore missing methods
                                }
                            }
                            return null
                        }
                        val min = extract(listOf("getMinZoomRatio", "getMin", "getMinimum"))
                        val max = extract(listOf("getMaxZoomRatio", "getMax", "getMaximum"))
                        if (min != null && max != null) mapOf("min" to min, "max" to max) else null
                    }
                    is Pair<*, *> -> {
                        val min = (rangeValue.first as? Number)?.toDouble()
                        val max = (rangeValue.second as? Number)?.toDouble()
                        if (min != null && max != null) mapOf("min" to min, "max" to max) else null
                    }
                    is List<*> -> {
                        if (rangeValue.size >= 2) {
                            val min = (rangeValue[0] as? Number)?.toDouble()
                            val max = (rangeValue[1] as? Number)?.toDouble()
                            if (min != null && max != null) {
                                mapOf("min" to min, "max" to max)
                            } else {
                                null
                            }
                        } else {
                            null
                        }
                    }
                    else -> null
                }
                if (rangeMap != null) {
                    result["zoom_range"] = rangeMap
                }
            }
            if (laserInfo != null) {
                result["laser_measurement"] = laserInfo.toString()
            }

            // Calculate focal length and FOV based on active lens type
            if (index == ComponentIndexType.LEFT_OR_MAIN) {
                when (activeLens) {
                    CameraLensType.CAMERA_LENS_WIDE -> {
                        // Wide camera has fixed focal length
                        val wideFocalLength = 24  // mm (35mm equivalent: ~24mm)
                        result["focal_length"] = wideFocalLength
                        result["zoom_ratio"] = 1.0  // Wide doesn't zoom

                        // Wide camera sensor specs
                        val sensorWidth = 11.1  // mm
                        val sensorHeight = 6.2  // mm
                        val cropFactor = 2.0

                        val actualFocalLength = wideFocalLength / cropFactor
                        val horizontalFov = Math.toDegrees(2 * Math.atan(sensorWidth / (2 * actualFocalLength)))
                        val verticalFov = Math.toDegrees(2 * Math.atan(sensorHeight / (2 * actualFocalLength)))

                        result["display_fov"] = mapOf(
                            "horizontal" to horizontalFov,
                            "vertical" to verticalFov
                        )
                    }
                    CameraLensType.CAMERA_LENS_ZOOM -> {
                        // Zoom camera: 25-400mm (35mm equivalent)
                        if (zoomRatio != null) {
                            val baseFocalLength = 25.0  // mm at 1x zoom
                            val focalLength = baseFocalLength * zoomRatio
                            result["focal_length"] = focalLength

                            // Zoom camera sensor
                            val sensorWidth = 11.1  // mm
                            val sensorHeight = 6.2  // mm
                            val cropFactor = 3.1

                            val actualFocalLength = focalLength / cropFactor
                            val horizontalFov = Math.toDegrees(2 * Math.atan(sensorWidth / (2 * actualFocalLength)))
                            val verticalFov = Math.toDegrees(2 * Math.atan(sensorHeight / (2 * actualFocalLength)))

                            result["display_fov"] = mapOf(
                                "horizontal" to horizontalFov,
                                "vertical" to verticalFov
                            )
                        }
                    }
                    CameraLensType.CAMERA_LENS_THERMAL -> {
                        // Thermal camera has different specs
                        // Get thermal zoom ratio if available
                        val thermalZoomKey = KeyTools.createCameraKey<Double>(
                            CameraKey.KeyThermalZoomRatios,
                            index,
                            CameraLensType.CAMERA_LENS_THERMAL
                        )
                        val thermalZoomRatio = try {
                            keyManager.getValue(thermalZoomKey) as? Double ?: 1.0
                        } catch (_: Exception) {
                            1.0
                        }

                        // Thermal camera: typically 13.5mm focal length
                        val thermalBaseFocalLength = 13.5
                        val thermalFocalLength = thermalBaseFocalLength * thermalZoomRatio
                        result["focal_length"] = thermalFocalLength
                        result["zoom_ratio"] = thermalZoomRatio

                        // Thermal sensor (typically smaller)
                        val sensorWidth = 8.0  // mm (approximate)
                        val sensorHeight = 6.0  // mm
                        val cropFactor = 4.3

                        val actualFocalLength = thermalFocalLength / cropFactor
                        val horizontalFov = Math.toDegrees(2 * Math.atan(sensorWidth / (2 * actualFocalLength)))
                        val verticalFov = Math.toDegrees(2 * Math.atan(sensorHeight / (2 * actualFocalLength)))

                        result["display_fov"] = mapOf(
                            "horizontal" to horizontalFov,
                            "vertical" to verticalFov
                        )
                    }
                    else -> {
                        // Fallback: use zoom lens calculations
                        if (zoomRatio != null) {
                            val baseFocalLength = 25.0
                            val focalLength = baseFocalLength * zoomRatio
                            result["focal_length"] = focalLength

                            val sensorWidth = 11.1
                            val sensorHeight = 6.2
                            val cropFactor = 3.1
                            val actualFocalLength = focalLength / cropFactor

                            val horizontalFov = Math.toDegrees(2 * Math.atan(sensorWidth / (2 * actualFocalLength)))
                            val verticalFov = Math.toDegrees(2 * Math.atan(sensorHeight / (2 * actualFocalLength)))

                            result["display_fov"] = mapOf(
                                "horizontal" to horizontalFov,
                                "vertical" to verticalFov
                            )
                        }
                    }
                }
            } else if (index == ComponentIndexType.FPV) {
                // FPV camera is fixed focal length with wide FOV
                val fpvFocalLength = 24.0
                result["focal_length"] = fpvFocalLength
                result["zoom_ratio"] = 1.0

                val fpvHorizontalFov = 82.0
                val fpvVerticalFov = 60.0
                result["display_fov"] = mapOf(
                    "horizontal" to fpvHorizontalFov,
                    "vertical" to fpvVerticalFov
                )
            }

            result
        } catch (e: Exception) {
            Log.w(TAG, "collectCameraOpticsSnapshot error for $index: ${e.message}")
            emptyMap()
        }
    }
    
    // Message Types - Extensible for all future data types
    enum class MessageType(val value: String) {
        // Outbound data streams
        CONTROLLER_DATA("controller_data"),
        SENSOR_DATA("sensor_data"), 
        TELEMETRY_DATA("telemetry_data"),
        VIDEO_FRAME("video_frame"),
        CAMERA_STATUS("camera_status"),
        BATTERY_STATUS("battery_status"),
        PREFLIGHT_STATUS("preflight_status"),
        GPS_DATA("gps_data"),
        SYSTEM_STATUS("system_status"),
        
        // Connection management
        HANDSHAKE("handshake"),
        HEARTBEAT("heartbeat"),
        ERROR("error"),
        
        // Inbound commands (bidirectional)
        JOYSTICK_OVERRIDE("joystick_override"),
        WAYPOINT_COMMAND("waypoint_command"),
        CAMERA_COMMAND("camera_command"),
        CAMERA_SELECT("camera_select"),
        CAMERA_LASER_ENABLE("camera_laser_enable"),
        CAMERA_LASER_GET("camera_laser_get"),
        CAMERA_LASER_MEASURE("camera_laser_measure"),
        CAMERA_LASER_RESULT("camera_laser_result"),
        CAMERA_LIVE_VIEW_LOCATION("camera_live_view_location"),
        CAMERA_ZOOM("camera_zoom"),
        GIMBAL_TAP_TARGET("gimbal_tap_target"),
        GIMBAL_RESPONSE("gimbal_response"),
        GIMBAL_FREE_LOOK_START("gimbal_free_look_start"),
        GIMBAL_FREE_LOOK_UPDATE("gimbal_free_look_update"),
        GIMBAL_FREE_LOOK_STOP("gimbal_free_look_stop"),
        GIMBAL_RESET("gimbal_reset"),
        GIMBAL_LOOK_AT("gimbal_look_at"),
        FLIGHT_COMMAND("flight_command"),
        SYSTEM_COMMAND("system_command");
        
        companion object {
            fun fromString(value: String): MessageType? = values().find { it.value == value }
        }
    }
    
    // Message priority levels for streaming optimization
    enum class Priority { CRITICAL, HIGH, NORMAL, LOW }
    
    data class BridgeMessage(
        val type: MessageType,
        val priority: Priority = Priority.NORMAL,
        val data: Any,
        val timestamp: Long = System.currentTimeMillis(),
        val version: String = PROTOCOL_VERSION
    )
    
    private var serverSocket: ServerSocket? = null
    private var isRunning = false
    private val clients = ConcurrentHashMap<String, Socket>()
    private val executor: ScheduledExecutorService = Executors.newScheduledThreadPool(4)
    private val socketExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "bridge-socket").apply { isDaemon = true }
    }

    // Free Look session state management
    @Volatile private var freeLookActive = false
    @Volatile private var freeLookClientId: String? = null
    @Volatile private var freeLookLastUpdate = 0L
    @Volatile private var freeLookVx = 0.0f
    @Volatile private var freeLookVy = 0.0f
    @Volatile private var freeLookPrevCmdVx = 0.0f
    @Volatile private var freeLookPrevCmdVy = 0.0f
    private var freeLookScheduler: java.util.concurrent.ScheduledFuture<*>? = null
    private var freeLookWatchdog: java.util.concurrent.ScheduledFuture<*>? = null
    private var freeLookLogTick = 0

    // Precise Look state
    @Volatile private var preciseActive = false
    private var landingMonitorFuture: java.util.concurrent.ScheduledFuture<*>? = null
    private var landingMonitorClientId: String? = null
    private var landingMonitorStartedAt: Long = 0L
    private val landingMonitorTimeoutMs = 15_000L
    private val landingMonitorAltitudeThreshold = 0.6

    private var preflightFuture: java.util.concurrent.ScheduledFuture<*>? = null

    private var preciseFuture: java.util.concurrent.ScheduledFuture<*>? = null

    // Virtual stick state tracking
    @Volatile private var latestVirtualStickState: VirtualStickState? = null
    @Volatile private var latestVirtualStickReason: FlightControlAuthorityChangeReason = FlightControlAuthorityChangeReason.UNKNOWN
    
    // Free Look constants
    private val FREELOOK_MAX_RATE = 120.0 // deg/s (tuned for responsiveness)
    private val FREELOOK_EXPONENT = 1.0   // linear mapping for snappy feel
    private val FREELOOK_DEAD_ZONE = 0.000f
    private val FREELOOK_WATCHDOG_MS = 800L
    private val FREELOOK_UPDATE_HZ = 15

    private fun runOnUiThread(action: () -> Unit) {
        val activity = bridgeActivity
        if (activity is Activity) {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                action()
            } else {
                activity.runOnUiThread(action)
            }
            return
        }

        val mainLooper = Looper.getMainLooper()
        if (mainLooper != null) {
            if (Looper.myLooper() == mainLooper) {
                action()
            } else {
                Handler(mainLooper).post(action)
            }
        } else {
            Log.w(TAG, "Main looper unavailable; executing action inline")
            action()
        }
    }

    private fun enqueueMessage(clientId: String, data: Map<String, Any?>) {
        executor.execute {
            try {
                val message = createMessage(MessageType.CAMERA_LIVE_VIEW_LOCATION, data)
                clients[clientId]?.let { socket -> sendWebSocketTextFrame(socket, message) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send camera_live_view_location message", e)
            }
        }
    }

    private fun initializeSurfaceViews() {
        activity?.let { act ->
            runOnUiThread {
                try {
                    Log.i(TAG, "*** Creating SurfaceViews programmatically for DJIBridgeActivity ***")

                    // Create SurfaceViews programmatically since DJIBridgeActivity doesn't have them in layout
                    fpvSurfaceView = SurfaceView(act)
                    secondarySurfaceView = SurfaceView(act)

                    // Add them to the activity with proper dimensions matching Look At example
                    val parent = act.window.decorView.findViewById<android.view.ViewGroup>(android.R.id.content)
                    // CRITICAL: Make surfaces take up actual screen space like Look At example
                    // The Look At example has the surface taking ~85% of screen width
                    val displayMetrics = act.resources.displayMetrics
                    val density = displayMetrics.density

                    // Create preview surfaces (~128px wide, maintain 4:3 aspect ratio)
                    val previewWidth = 128  // Fixed pixel size
                    val previewHeight = 96   // 4:3 aspect ratio

                    val params = android.widget.FrameLayout.LayoutParams(
                        previewWidth,
                        previewHeight
                    )
                    params.gravity = android.view.Gravity.BOTTOM or android.view.Gravity.END
                    params.rightMargin = (8 * density).toInt()
                    params.bottomMargin = (8 * density).toInt()

                    parent.addView(fpvSurfaceView, params)

                    val secondParams = android.widget.FrameLayout.LayoutParams(previewWidth, previewHeight).apply {
                        gravity = android.view.Gravity.BOTTOM or android.view.Gravity.END
                        rightMargin = (8 * density).toInt()
                        bottomMargin = (110 + 8 * density).toInt()  // Position above first preview
                    }
                    parent.addView(secondarySurfaceView, secondParams)

                    // Set up FPV surface callback
                    fpvSurfaceView?.holder?.addCallback(object : SurfaceHolder.Callback {
                        override fun surfaceCreated(holder: SurfaceHolder) {
                            fpvSurface = holder.surface
                            // Use screen dimensions for SDK (projections need full resolution)
                            val screenWidth = act.resources.displayMetrics.widthPixels
                            val screenHeight = act.resources.displayMetrics.heightPixels
                            holder.setFixedSize(screenWidth, screenHeight)
                            Log.i(TAG, "*** FPV Surface CREATED successfully with SDK size ${screenWidth}x${screenHeight} ***")

                            // Register with retry logic
                            registerCameraStreamWithRetry(
                                componentIndex = ComponentIndexType.FPV,
                                surface = fpvSurface!!,
                                width = screenWidth,
                                height = screenHeight,
                                surfaceName = "FPV"
                            )
                        }

                        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
                        override fun surfaceDestroyed(holder: SurfaceHolder) {
                            fpvSurface?.let { MediaDataCenter.getInstance().cameraStreamManager.removeCameraStreamSurface(it) }
                            fpvSurface = null
                        }
                    })

                    // Set up Secondary surface callback
                    secondarySurfaceView?.holder?.addCallback(object : SurfaceHolder.Callback {
                        override fun surfaceCreated(holder: SurfaceHolder) {
                            secondarySurface = holder.surface
                            // Use screen dimensions for SDK (projections need full resolution)
                            val screenWidth = act.resources.displayMetrics.widthPixels
                            val screenHeight = act.resources.displayMetrics.heightPixels
                            holder.setFixedSize(screenWidth, screenHeight)
                            Log.i(TAG, "*** Secondary Surface CREATED successfully with SDK size ${screenWidth}x${screenHeight} ***")

                            // Register with retry logic for H20N/Secondary camera
                            registerCameraStreamWithRetry(
                                componentIndex = ComponentIndexType.LEFT_OR_MAIN,
                                surface = secondarySurface!!,
                                width = screenWidth,
                                height = screenHeight,
                                surfaceName = "H20N/Secondary"
                            )

                            // Enable through ViewModel too
                            cameraVM.enableStream(true)

                            // Set the LookAtVM to match
                            lookAtVM.currentComponentIndexType.value = ComponentIndexType.LEFT_OR_MAIN

                            // Mark surfaces as ready
                            surfacesReady = true
                            Log.i(TAG, "*** H20N video stream connected to surface for GPS projections - SURFACES READY ***")

                            // Execute any pending callbacks for LEFT_OR_MAIN
                            surfaceReadyCallbacks[ComponentIndexType.LEFT_OR_MAIN]?.invoke()
                            surfaceReadyCallbacks.remove(ComponentIndexType.LEFT_OR_MAIN)
                        }

                        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
                        override fun surfaceDestroyed(holder: SurfaceHolder) {
                            secondarySurface?.let { MediaDataCenter.getInstance().cameraStreamManager.removeCameraStreamSurface(it) }
                            secondarySurface = null
                        }
                    })

                    // Make surfaces visible (they're already sized at 40dp x 30dp from addView)
                    fpvSurfaceView?.visibility = android.view.View.VISIBLE
                    secondarySurfaceView?.visibility = android.view.View.VISIBLE

                    Log.i(TAG, "*** SurfaceViews created with small display size, waiting for surface creation callbacks ***")
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to initialize SurfaceViews", e)
                }
            }
        }
    }


    private fun enqueueError(socket: Socket, error: String) {
        executor.execute {
            try {
                sendErrorResponse(socket, error)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send error response: $error", e)
            }
        }
    }


    // Video streaming
    // ================== DUAL CAMERA STREAMING SUPPORT ==================
    // FPV camera (always present)
    private val fpvCameraIndex = ComponentIndexType.FPV
    private var isFpvStreamEnabled = false
    private var fpvBytesStreamed = 0L
    private var fpvFramesStreamed = 0L
    
    // Secondary camera (H20N/Gimbal - optional)
    private val secondaryCameraIndex = ComponentIndexType.LEFT_OR_MAIN
    private var isSecondaryCameraAvailable = false

    // Store takeoff altitude when motors first turn on
    private var capturedTakeoffAltitude: Double? = null
    private var lastMotorsOnState: Boolean = false
    private var isSecondaryStreamEnabled = false
    private var secondaryBytesStreamed = 0L
    private var secondaryFramesStreamed = 0L
    
    // Legacy compatibility
    private var isVideoStreamingEnabled = false
    private var videoBytesStreamed = 0L
    private var videoFramesStreamed = 0L
    @Deprecated("Use fpvCameraIndex and secondaryCameraIndex instead")
    private val cameraIndex = ComponentIndexType.FPV // Maintained for backward compatibility
    
    // Obstacle avoidance data (cached from listeners for telemetry collection)
    @Volatile
    private var cachedRadarObstacleData: ObstacleData? = null
    @Volatile
    private var cachedPerceptionObstacleData: ObstacleData? = null
    @Volatile
    private var cachedRadarInformation: RadarInformation? = null
    @Volatile
    private var cachedPerceptionInformation: PerceptionInfo? = null

    // Projection mode for GPS to screen coordinate conversions
    enum class ProjectionMode { REAL, HORIZONTAL, FALLBACK }
    private var projectionMode = ProjectionMode.FALLBACK
    
    // Obstacle data listeners (same pattern as official HSI widget)
    private val radarObstacleDataListener = ObstacleDataListener { data -> 
        cachedRadarObstacleData = data
        Log.v(TAG, "Radar obstacle data updated: ${data.horizontalObstacleDistance?.size ?: 0} sectors")
    }
    
    private val perceptionObstacleDataListener = ObstacleDataListener { data ->
        cachedPerceptionObstacleData = data  
        Log.v(TAG, "Perception obstacle data updated: ${data.horizontalObstacleDistance?.size ?: 0} sectors")
    }
    
    private val radarInformationListener = RadarInformationListener { radarInformation ->
        cachedRadarInformation = radarInformation
        Log.v(TAG, "Radar information updated")
    }
    
    private val perceptionInformationListener = PerceptionInformationListener { perceptionInfo ->
        cachedPerceptionInformation = perceptionInfo
        Log.v(TAG, "Perception information updated")
    }
    
    // ================== DUAL CAMERA VIDEO STREAM LISTENERS ==================
    
    // FPV camera stream listener (always present)
    private val fpvVideoStreamListener = ICameraStreamManager.ReceiveStreamListener { data, offset, length, info ->
        if (!isFpvStreamEnabled || clients.isEmpty()) {
            return@ReceiveStreamListener
        }
        
        try {
            // Extract H.264 frame data
            val videoFrame = data.sliceArray(offset until offset + length)
            
            // Create video frame message with FPV camera metadata
            val videoFrameInfo = mapOf(
                "camera_source" to "fpv",           // NEW: Camera source identifier
                "camera_index" to fpvCameraIndex.name,
                "frameNumber" to fpvFramesStreamed,
                "timestamp" to System.currentTimeMillis(),
                "frameSize" to length,
                "mimeType" to (info.mimeType?.name ?: "H264"),
                "width" to (info.width ?: 1920),
                "height" to (info.height ?: 1080),
                "frameRate" to 30, // TODO: Get actual frame rate
                "is_primary" to true,               // NEW: FPV is primary camera
                "secondary_available" to isSecondaryCameraAvailable  // NEW: Secondary camera status
            )
            
            // Broadcast H.264 frame to all connected clients
            broadcastVideoFrame(videoFrame, videoFrameInfo)
            
            // Update FPV statistics
            fpvBytesStreamed += length
            fpvFramesStreamed++
            
            // Update legacy compatibility statistics
            videoBytesStreamed = fpvBytesStreamed + secondaryBytesStreamed
            videoFramesStreamed = fpvFramesStreamed
            
            // Log video streaming progress
            if (fpvFramesStreamed % 60 == 0L) { // Log every 60 frames
                Log.d(TAG, "FPV streaming: ${fpvFramesStreamed} frames, ${fpvBytesStreamed / 1024 / 1024} MB streamed")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error processing FPV video frame", e)
        }
    }
    
    // Secondary camera stream listener (H20N/Gimbal - optional)
    private val secondaryVideoStreamListener = ICameraStreamManager.ReceiveStreamListener { data, offset, length, info ->
        if (!isSecondaryStreamEnabled || clients.isEmpty()) {
            return@ReceiveStreamListener
        }
        
        try {
            // Extract H.264 frame data
            val videoFrame = data.sliceArray(offset until offset + length)
            
            // Create video frame message with secondary camera metadata
            val videoFrameInfo = mapOf(
                "camera_source" to "secondary",     // NEW: Camera source identifier
                "camera_index" to secondaryCameraIndex.name,
                "frameNumber" to secondaryFramesStreamed,
                "timestamp" to System.currentTimeMillis(),
                "frameSize" to length,
                "mimeType" to (info.mimeType?.name ?: "H264"),
                "width" to (info.width ?: 1920),
                "height" to (info.height ?: 1080),
                "frameRate" to 30, // TODO: Get actual frame rate
                "is_primary" to false,              // NEW: Secondary camera
                "secondary_available" to true       // NEW: This camera is available
            )
            
            // Broadcast H.264 frame to all connected clients
            broadcastVideoFrame(videoFrame, videoFrameInfo)
            
            // Update secondary statistics
            secondaryBytesStreamed += length
            secondaryFramesStreamed++
            
            // Update legacy compatibility statistics
            videoBytesStreamed = fpvBytesStreamed + secondaryBytesStreamed
            
            // Log video streaming progress
            if (secondaryFramesStreamed % 60 == 0L) { // Log every 60 frames
                Log.d(TAG, "Secondary streaming: ${secondaryFramesStreamed} frames, ${secondaryBytesStreamed / 1024 / 1024} MB streamed")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error processing secondary video frame", e)
        }
    }
    
    // Legacy compatibility listener (deprecated but maintained)
    @Deprecated("Use fpvVideoStreamListener and secondaryVideoStreamListener instead")
    private val videoStreamListener = fpvVideoStreamListener
    
    fun start() {
        if (isRunning) {
            Log.w(TAG, "Server is already running")
            return
        }

        // Initialize real SurfaceViews for SDK projection
        if (bridgeActivity is Activity) {
            activity = bridgeActivity
            initializeSurfaceViews()
        }

        try {
            serverSocket = ServerSocket(port)
            isRunning = true

            Log.i(TAG, "DJI Bridge WebSocket server started on port $port")

            // Start accepting client connections
            executor.submit { acceptConnections() }
            
            // Start streaming controller data
            telemetryStreamer.start()
            startPreflightStreaming()
            
            // Register obstacle data listeners (same pattern as HSI widget)
            setupObstacleDataListeners()
            
        } catch (e: IOException) {
            Log.e(TAG, "Failed to start server on port $port", e)
            throw e
        }
    }
    
    fun stop() {
        if (!isRunning) return

        isRunning = false

        telemetryStreamer.stop()
        stopPreflightStreaming()
        cancelLandingMonitor()

        // Stop video streaming
        stopVideoStreaming()
        
        // Remove obstacle data listeners
        cleanupObstacleDataListeners()
        flySafeBridgeModel.stop()
        flyToBridgeModel.stop()
        waypointBridgeModel.stop()
        simulatorBridgeModel.stop()
        
        try {
            // Close all client connections
            clients.values.forEach { client ->
                try {
                    client.close()
                } catch (e: IOException) {
                    Log.w(TAG, "Error closing client connection", e)
                }
            }
            clients.clear()
            
            serverSocket?.close()
            executor.shutdown()
            
            Log.i(TAG, "DJI Bridge server stopped")
            
        } catch (e: IOException) {
            Log.e(TAG, "Error stopping server", e)
        }
    }
    
    private fun acceptConnections() {
        while (isRunning) {
            try {
                val clientSocket = serverSocket?.accept()
                clientSocket?.let { socket ->
                    val clientId = "${socket.inetAddress.hostAddress}:${socket.port}"
                    Log.i(TAG, "New client connected: $clientId")
                    
                    executor.submit { handleClient(clientId, socket) }
                }
            } catch (e: IOException) {
                if (isRunning) {
                    Log.e(TAG, "Error accepting client connection", e)
                }
            }
        }
    }
    
    private fun handleClient(clientId: String, socket: Socket) {
        try {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            
            // Read WebSocket handshake
            val request = StringBuilder()
            val buffer = ByteArray(1024)
            val bytesRead = input.read(buffer)
            request.append(String(buffer, 0, bytesRead, StandardCharsets.UTF_8))
            
            // Parse WebSocket key for handshake response
            val lines = request.toString().split("\r\n")
            var webSocketKey = ""
            
            for (line in lines) {
                if (line.startsWith("Sec-WebSocket-Key:")) {
                    webSocketKey = line.substring(19).trim()
                    break
                }
            }
            
            if (webSocketKey.isEmpty()) {
                Log.w(TAG, "Invalid WebSocket handshake from $clientId")
                socket.close()
                return
            }
            
            // Generate WebSocket accept key
            val acceptKey = generateWebSocketAcceptKey(webSocketKey)
            
            // Send WebSocket handshake response
            val response = """
                HTTP/1.1 101 Switching Protocols
                Upgrade: websocket
                Connection: Upgrade
                Sec-WebSocket-Accept: $acceptKey
                
                
            """.trimIndent().replace("\n", "\r\n")
            
            output.write(response.toByteArray(StandardCharsets.UTF_8))
            output.flush()
            
            clients[clientId] = socket
            Log.i(TAG, "WebSocket handshake completed for client $clientId")
            
            // Send test message immediately after connection
            try {
                val testMessage = """{"type":"test","message":"Bridge connection established!","timestamp":${System.currentTimeMillis()}}"""
                sendWebSocketTextFrame(socket, testMessage)
                Log.i(TAG, "Sent test message to client $clientId")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send test message", e)
            }
            
            // Keep connection alive and handle incoming messages
            handleWebSocketConnection(clientId, socket)
            
        } catch (e: Exception) {
            Log.e(TAG, "Error handling client $clientId", e)
            clients.remove(clientId)
            try {
                socket.close()
            } catch (closeException: IOException) {
                Log.w(TAG, "Error closing client socket", closeException)
            }
        }
    }
    
    private fun handleWebSocketConnection(clientId: String, socket: Socket) {
        try {
            val input = socket.getInputStream()
            val buffer = ByteArray(4096) // Larger buffer for commands
            
            while (isRunning && !socket.isClosed) {
                try {
                    val bytesRead = input.read(buffer)
                    if (bytesRead == -1) break
                    
                    // Parse incoming WebSocket frame
                    parseIncomingWebSocketFrame(clientId, socket, buffer, bytesRead)
                    
                } catch (e: IOException) {
                    Log.d(TAG, "Client $clientId disconnected")
                    break
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error in WebSocket connection for client $clientId", e)
        } finally {
            clients.remove(clientId)
            try {
                socket.close()
            } catch (e: IOException) {
                Log.w(TAG, "Error closing socket for client $clientId", e)
            }
            
            // Clean up Free Look session if this client had one active
            if (freeLookActive && freeLookClientId == clientId) {
                Log.w("GIMBAL_FREE_LOOK", "🔌 Client disconnect - stopping Free Look session for $clientId")
                stopFreeLookSession()
            }
            
            Log.i(TAG, "Client $clientId disconnected")
        }
    }
    
    private fun parseIncomingWebSocketFrame(clientId: String, socket: Socket, buffer: ByteArray, bytesRead: Int) {
        if (bytesRead < 2) return
        
        val firstByte = buffer[0].toInt() and 0xFF
        val secondByte = buffer[1].toInt() and 0xFF
        
        val fin = (firstByte and 0x80) != 0
        val opcode = firstByte and 0x0F
        val masked = (secondByte and 0x80) != 0
        var payloadLength = secondByte and 0x7F
        
        var offset = 2
        
        // Extended payload length
        if (payloadLength == 126) {
            if (bytesRead < 4) return
            payloadLength = ((buffer[2].toInt() and 0xFF) shl 8) or (buffer[3].toInt() and 0xFF)
            offset = 4
        } else if (payloadLength == 127) {
            if (bytesRead < 10) return
            // For simplicity, only handle up to 32-bit lengths
            payloadLength = ((buffer[6].toInt() and 0xFF) shl 24) or 
                          ((buffer[7].toInt() and 0xFF) shl 16) or
                          ((buffer[8].toInt() and 0xFF) shl 8) or
                          (buffer[9].toInt() and 0xFF)
            offset = 10
        }
        
        // Masking key (client-to-server frames are always masked)
        val maskingKey = if (masked) {
            if (bytesRead < offset + 4) return
            val key = ByteArray(4)
            System.arraycopy(buffer, offset, key, 0, 4)
            offset += 4
            key
        } else null
        
        // Extract payload
        if (bytesRead < offset + payloadLength) return
        val payload = ByteArray(payloadLength)
        System.arraycopy(buffer, offset, payload, 0, payloadLength)
        
        // Unmask payload if needed
        if (masked && maskingKey != null) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor maskingKey[i % 4].toInt()).toByte()
            }
        }
        
        // Process message based on opcode
        when (opcode) {
            0x1 -> { // Text frame
                val message = String(payload, StandardCharsets.UTF_8)
                handleIncomingCommand(clientId, socket, message)
            }
            0x2 -> { // Binary frame  
                handleIncomingBinaryData(clientId, socket, payload)
            }
            0x8 -> { // Close frame
                Log.i(TAG, "Client $clientId sent close frame")
                socket.close()
            }
            0x9 -> { // Ping frame
                sendPongFrame(socket, payload)
            }
            0xA -> { // Pong frame
                Log.d(TAG, "Received pong from client $clientId")
            }
        }
    }
    
    private fun handleIncomingCommand(clientId: String, socket: Socket, message: String) {
        try {
            Log.i(TAG, "*** INCOMING COMMAND from $clientId: $message ***")
            val json = JSONObject(message)
            val typeString = json.getString("type")
            Log.i(TAG, "*** COMMAND TYPE STRING: '$typeString' ***")
            val messageType = MessageType.fromString(typeString)
            Log.i(TAG, "*** PARSED MESSAGE TYPE: $messageType ***")
            
            when (messageType) {
                MessageType.JOYSTICK_OVERRIDE -> handleJoystickOverride(clientId, json)
                MessageType.WAYPOINT_COMMAND -> handleWaypointCommand(clientId, json)
                MessageType.CAMERA_COMMAND -> handleCameraCommand(clientId, json)
                MessageType.CAMERA_SELECT -> handleCameraSelect(clientId, json)
                MessageType.CAMERA_LASER_ENABLE -> handleCameraLaserEnable(clientId, json)
                MessageType.CAMERA_LASER_GET -> handleCameraLaserGet(clientId, json)
                MessageType.CAMERA_LASER_MEASURE -> handleCameraLaserMeasure(clientId, json)
                MessageType.CAMERA_ZOOM -> handleCameraZoom(clientId, json)
                MessageType.CAMERA_LIVE_VIEW_LOCATION -> handleCameraLiveViewLocation(clientId, json)
                MessageType.GIMBAL_TAP_TARGET -> handleGimbalTapTarget(clientId, json)
                MessageType.GIMBAL_FREE_LOOK_START -> handleGimbalFreeLookStart(clientId, json)
                MessageType.GIMBAL_FREE_LOOK_UPDATE -> handleGimbalFreeLookUpdate(clientId, json)
                MessageType.GIMBAL_FREE_LOOK_STOP -> handleGimbalFreeLookStop(clientId, json)
                MessageType.GIMBAL_RESET -> handleGimbalReset(clientId, json)
                MessageType.GIMBAL_LOOK_AT -> handleGimbalLookAt(clientId, json)
                MessageType.FLIGHT_COMMAND -> handleFlightCommand(clientId, json)
                MessageType.SYSTEM_COMMAND -> handleSystemCommand(clientId, json)
                MessageType.HEARTBEAT -> handleHeartbeat(clientId, socket)
                else -> {
                    Log.w(TAG, "Unknown command type from $clientId: ${json.optString("type")}")
                    sendErrorResponse(socket, "Unknown command type")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error processing command from $clientId", e)
            sendErrorResponse(socket, "Command processing error: ${e.message}")
        }
    }
    
    private fun handleIncomingBinaryData(clientId: String, socket: Socket, data: ByteArray) {
        Log.d(TAG, "Received ${data.size} bytes of binary data from $clientId")
        // Handle binary commands (e.g., compressed waypoint data, firmware updates)
    }
    
    // Command handlers - Extensible for future commands
    private fun handleJoystickOverride(clientId: String, command: JSONObject) {
        Log.i(TAG, "Joystick override command from $clientId: $command")
        // TODO: Implement joystick override for external control
    }
    
    private fun handleWaypointCommand(clientId: String, command: JSONObject) {
        Log.i(TAG, "Waypoint command from $clientId: $command")
        // TODO: Implement waypoint mission control
    }
    
    private fun handleCameraCommand(clientId: String, command: JSONObject) {
        Log.i(TAG, "Camera command from $clientId: $command") 
        // TODO: Implement camera/gimbal control
    }

    private fun handleCameraZoom(clientId: String, command: JSONObject) {
        try {
            val data = command.optJSONObject("data") ?: run {
                clients[clientId]?.let { sendErrorResponse(it, "camera_zoom missing data") }
                return
            }
            var ratio = data.optDouble("ratio", Double.NaN)
            if (ratio.isNaN()) {
                clients[clientId]?.let { sendErrorResponse(it, "camera_zoom ratio required") }
                return
            }
            ratio = ratio.coerceIn(1.0, 200.0)
            val component = ComponentIndexType.LEFT_OR_MAIN
            val key = KeyTools.createCameraKey<Double>(CameraKey.KeyCameraZoomRatios, component, CameraLensType.CAMERA_LENS_ZOOM)
            KeyManager.getInstance().setValue(key, ratio, null)
            val msg = createMessage(
                MessageType.CAMERA_STATUS,
                mapOf(
                    "zoom_ratio" to ratio,
                    "lens" to CameraLensType.CAMERA_LENS_ZOOM.name
                )
            )
            clients[clientId]?.let { sendWebSocketTextFrame(it, msg) }
            Log.i(TAG, "Camera zoom set to $ratio on ${CameraLensType.CAMERA_LENS_ZOOM.name} for client $clientId")
        } catch (e: Exception) {
            Log.e(TAG, "camera_zoom error: ${e.message}", e)
            clients[clientId]?.let { sendErrorResponse(it, "camera_zoom failed: ${e.message}") }
        }
    }

    private fun handleCameraLiveViewLocation(clientId: String, command: JSONObject) {
        Log.i(TAG, "*** handleCameraLiveViewLocation called from client: $clientId ***")
        Log.i(TAG, "*** Command received: ${command.toString()} ***")

        val data = command.optJSONObject("data") ?: run {
            Log.e(TAG, "*** ERROR: camera_live_view_location missing data ***")
            clients[clientId]?.let { sendErrorResponse(it, "camera_live_view_location missing data") }
            return
        }

        val latitude = data.optDouble("latitude", Double.NaN)
        val longitude = data.optDouble("longitude", Double.NaN)
        val altitude = data.optDouble("altitude", Double.NaN)

        Log.i(TAG, "*** Parsed coordinates: lat=$latitude, lon=$longitude, alt=$altitude ***")

        if (latitude.isNaN() || longitude.isNaN() || altitude.isNaN()) {
            Log.e(TAG, "*** ERROR: Invalid coordinates ***")
            clients[clientId]?.let { sendErrorResponse(it, "camera_live_view_location requires latitude/longitude/altitude") }
            return
        }

        val componentName = data.optString("camera_index", "LEFT_OR_MAIN").uppercase(Locale.ROOT)
        val component = ComponentIndexType.values().find { it.name == componentName } ?: ComponentIndexType.LEFT_OR_MAIN
        val requestId = data.optString("request_id", "")
        val source = data.optString("source", "")

        val location = LocationCoordinate3D(latitude, longitude, altitude)

        runOnUiThread {
            try {
                // Check if surfaces are ready
                if (!surfacesReady) {
                    Log.w(TAG, "*** Surfaces not ready yet, deferring projection for $component ***")
                    surfaceReadyCallbacks[component] = {
                        Log.i(TAG, "*** Surface ready callback triggered for $component, executing projection ***")
                        handleCameraLiveViewLocation(clientId, command)
                    }
                    return@runOnUiThread
                }

                // Get the current video stream source and zoom before projection
                val currentStreamSource = try {
                    KeyManager.getInstance().getValue(CameraKey.KeyCameraVideoStreamSource.create(component)) as? CameraVideoStreamSourceType
                } catch (e: Exception) {
                    Log.w(TAG, "Could not get video stream source: ${e.message}")
                    null
                }

                val currentZoom = try {
                    val zoomLens = when(currentStreamSource) {
                        CameraVideoStreamSourceType.ZOOM_CAMERA -> CameraLensType.CAMERA_LENS_ZOOM
                        else -> CameraLensType.CAMERA_LENS_WIDE
                    }
                    val zoomKey = KeyTools.createCameraKey<Double>(CameraKey.KeyCameraZoomRatios, component, zoomLens)
                    KeyManager.getInstance().getValue(zoomKey) ?: 1.0
                } catch (e: Exception) {
                    1.0
                }

                Log.i(TAG, "GPS projection request: camera=$component, stream=$currentStreamSource, zoom=$currentZoom, location=(${latitude}, ${longitude}, ${altitude})")

                // Log surface status
                Log.i(TAG, "*** Surface status: fpvSurface=${fpvSurface != null}, secondarySurface=${secondarySurface != null} ***")

                // CRITICAL: Must ensure video is actually streaming to the surface for projections
                when (component) {
                    ComponentIndexType.FPV -> {
                        if (fpvSurface != null) {
                            // Register surface with SDK to receive video - use actual screen dimensions
                            val screenWidth = activity?.resources?.displayMetrics?.widthPixels ?: 1920
                            val screenHeight = activity?.resources?.displayMetrics?.heightPixels ?: 1080
                            MediaDataCenter.getInstance().cameraStreamManager.putCameraStreamSurface(
                                ComponentIndexType.FPV,
                                fpvSurface!!,
                                screenWidth,
                                screenHeight,
                                ICameraStreamManager.ScaleType.CENTER_INSIDE
                            )
                            cameraVM.setCameraIndex(ComponentIndexType.FPV)
                            Log.i(TAG, "*** FPV video stream activated for GPS projections ***")
                        } else {
                            Log.e(TAG, "*** ERROR: FPV surface is NULL! ***")
                        }
                    }
                    ComponentIndexType.LEFT_OR_MAIN -> {
                        if (secondarySurface != null) {
                            // CRITICAL: Register surface with SDK to receive H20N video - use actual screen dimensions
                            val screenWidth = activity?.resources?.displayMetrics?.widthPixels ?: 1920
                            val screenHeight = activity?.resources?.displayMetrics?.heightPixels ?: 1080
                            MediaDataCenter.getInstance().cameraStreamManager.putCameraStreamSurface(
                                ComponentIndexType.LEFT_OR_MAIN,
                                secondarySurface!!,
                                screenWidth,
                                screenHeight,
                                ICameraStreamManager.ScaleType.CENTER_INSIDE
                            )

                            // Also update ViewModels
                            cameraVM.setCameraIndex(ComponentIndexType.LEFT_OR_MAIN)
                            cameraVM.putCameraStreamSurface(
                                secondarySurface!!,
                                screenWidth,
                                screenHeight,
                                ICameraStreamManager.ScaleType.CENTER_INSIDE
                            )

                            Log.i(TAG, "*** H20N video stream activated on surface for GPS projections ***")
                        } else {
                            Log.e(TAG, "*** ERROR: Secondary surface is NULL! ***")
                        }
                    }
                    else -> {
                        Log.w(TAG, "*** No surface available for camera: $component ***")
                    }
                }

                // Set the camera index in both ViewModels
                cameraVM.setCameraIndex(component)
                lookAtVM.currentComponentIndexType.value = component

                // Important: Give the ViewModels time to update their internal state
                Handler(Looper.getMainLooper()).postDelayed({
                    Log.i(TAG, "*** Inside Handler.postDelayed ***")

                    // Get aircraft's current position - CRITICAL for SDK to calculate relative geometry
                    val aircraftLocation = try {
                        val key = FlightControllerKey.KeyAircraftLocation3D.create()
                        KeyManager.getInstance().getValue(key) as? LocationCoordinate3D
                    } catch (e: Exception) {
                        Log.e(TAG, "*** Failed to get aircraft location: ${e.message} ***")
                        null
                    }

                    // Get additional altitude information to understand reference frame
                    val takeoffAltitude = try {
                        KeyManager.getInstance().getValue(FlightControllerKey.KeyTakeoffLocationAltitude.create()) as? Double
                    } catch (e: Exception) {
                        null
                    }

                    // Get barometric altitude which is more reliable
                    val barometricAltitude = try {
                        KeyManager.getInstance().getValue(FlightControllerKey.KeyAltitude.create()) as? Double
                    } catch (e: Exception) {
                        null
                    }

                    // Check stream status before projection
                    val cameraStreamManager = MediaDataCenter.getInstance().cameraStreamManager
                    Log.i(TAG, "*** Using cameraStreamManager for component $component ***")

                    // Check if we're using the right camera/lens combination
                    val currentStreamSource = try {
                        KeyManager.getInstance().getValue(CameraKey.KeyCameraVideoStreamSource.create(component)) as? CameraVideoStreamSourceType
                    } catch (e: Exception) {
                        null
                    }
                    Log.i(TAG, "*** Current stream source for $component: $currentStreamSource ***")

                    // Set the LookAtVM's current component to match exactly like the Look At example
                    lookAtVM.currentComponentIndexType.value = component
                    Log.i(TAG, "*** Set lookAtVM.currentComponentIndexType to $component ***")

                    // Handle altitude reference frame issues
                    // Aircraft altitude from SDK is typically MSL (Mean Sea Level)
                    // If your targets are also MSL, use them directly
                    // If targets are AGL, convert to MSL by adding takeoff altitude

                    // Get aircraft altitude - SDK typically returns 0 when on ground
                    val aircraftAlt = aircraftLocation?.altitude ?: 0.0
                    val targetAlt = location.altitude
                    val altDiff = targetAlt - aircraftAlt

                    // For display purposes, try to get real altitude
                    val realAircraftAlt = when {
                        takeoffAltitude != null && barometricAltitude != null -> {
                            takeoffAltitude + barometricAltitude
                        }
                        barometricAltitude != null -> {
                            barometricAltitude
                        }
                        else -> aircraftAlt
                    }

                    Log.i(TAG, "*** Altitudes: aircraft=$aircraftAlt (display=$realAircraftAlt), target=$targetAlt, diff=$altDiff ***")

                    // Apply projection mode to determine altitude handling
                    // SDK REQUIRES matching altitudes or it returns OUT_OF_SCREEN
                    val adjustedLocation = when (projectionMode) {
                        ProjectionMode.REAL -> {
                            // For "real" mode with SDK - we need to handle altitude mismatch
                            // SDK returns OUT_OF_SCREEN if altitude difference is too large
                            when {
                                aircraftAlt == 0.0 && targetAlt > 100 -> {
                                    // Aircraft on ground, target at high altitude - use aircraft altitude
                                    LocationCoordinate3D(location.latitude, location.longitude, aircraftAlt)
                                }
                                Math.abs(altDiff) < 1000 -> {
                                    // Reasonable difference - try with actual altitude
                                    location
                                }
                                else -> {
                                    // Huge difference - use aircraft altitude
                                    LocationCoordinate3D(location.latitude, location.longitude, aircraftAlt)
                                }
                            }
                        }
                        ProjectionMode.HORIZONTAL -> {
                            // Always project at aircraft altitude for horizontal plane
                            LocationCoordinate3D(location.latitude, location.longitude, aircraftAlt)
                        }
                        ProjectionMode.FALLBACK -> {
                            // Fallback - use aircraft altitude for SDK call
                            LocationCoordinate3D(location.latitude, location.longitude, aircraftAlt)
                        }
                    }

                    Log.i(TAG, "*** Altitude: realAircraft=$realAircraftAlt, rawAircraft=$aircraftAlt, target=$targetAlt, diff=$altDiff, adjusted=${adjustedLocation.altitude}, mode=$projectionMode ***")

                    // Try adding the point to LookAtVM first, like the Look At example does
                    lookAtVM.addNewPinPoint(adjustedLocation)
                    Log.i(TAG, "*** Added point to LookAtVM ***")

                    // Try both the LookAtVM and direct SDK call
                    val pinPointInfo = try {
                        Log.i(TAG, "*** Calling lookAtVM.getLiveViewLocationWithGPS ***")
                        val resultFromVM = lookAtVM.getLiveViewLocationWithGPS(adjustedLocation)
                        Log.i(TAG, "*** VM result: result=${resultFromVM.result}, pinPoints=${resultFromVM.pinPoints?.size}, first point=${resultFromVM.pinPoints?.firstOrNull()?.let { "x=${it.x}, y=${it.y}" }} ***")

                        // Also try calling the SDK directly with the exact same component
                        Log.i(TAG, "*** Calling MediaDataCenter directly for component $component ***")
                        val resultFromSDK = MediaDataCenter.getInstance().cameraStreamManager.getLiveViewLocationWithGPS(adjustedLocation, component)
                        Log.i(TAG, "*** SDK result for $component: result=${resultFromSDK.result}, pinPoints=${resultFromSDK.pinPoints?.size}, first point=${resultFromSDK.pinPoints?.firstOrNull()?.let { "x=${it.x}, y=${it.y}" }} ***")

                        // The SDK needs actual video streaming through the surface for projections to work
                        if (resultFromSDK.pinPoints?.firstOrNull()?.y == 0.0) {
                            Log.e(TAG, "*** CRITICAL: SDK returns y=0 even with video streaming ***")
                            Log.e(TAG, "*** Source: $currentStreamSource ***")
                            Log.e(TAG, "*** Surface status: fpvSurface=${fpvSurface != null}, secondarySurface=${secondarySurface != null} ***")

                            // Try waiting longer before projection
                            Thread.sleep(500)
                            Log.i(TAG, "*** Retrying after 500ms delay ***")
                            val retryResult = MediaDataCenter.getInstance().cameraStreamManager.getLiveViewLocationWithGPS(adjustedLocation, component)
                            Log.i(TAG, "*** Retry result: result=${retryResult.result}, first point=${retryResult.pinPoints?.firstOrNull()?.let { "x=${it.x}, y=${it.y}" }} ***")
                            if (retryResult.pinPoints?.firstOrNull()?.y != 0.0) {
                                retryResult
                            } else {
                                resultFromSDK
                            }
                        } else {
                            resultFromSDK
                        }
                    } catch (t: Throwable) {
                        Log.e(TAG, "*** getLiveViewLocationWithGPS CRASHED: ${t.message} ***", t)
                        clients[clientId]?.let { socket -> enqueueError(socket, "camera_live_view_location failed: ${t.message}") }
                        return@postDelayed
                    }

                val pinPoints = pinPointInfo.pinPoints?.mapIndexed { index, pinPoint ->
                    mapOf(
                        "index" to index,
                        "x" to pinPoint.x,
                        "y" to pinPoint.y
                    )
                } ?: emptyList<Map<String, Any>>()

                Log.d(TAG, "LiveView projection [$component/$source] -> result=${pinPointInfo.result} pinPoints=${pinPoints}")

                val responseData = mapOf(
                    "component" to component.name,
                    "request_id" to requestId,
                    "source" to source,
                    "valid" to pinPointInfo.isValid,
                    "result" to pinPointInfo.result?.toString(),
                    "point_direction" to pinPointInfo.pointDirection?.toString(),
                    "pin_points" to pinPoints,
                    "request" to mapOf(
                        "latitude" to latitude,
                        "longitude" to longitude,
                        "altitude" to altitude
                    ),
                    "projection_stats" to mapOf(
                        "mode" to projectionMode.name.lowercase(),
                        "aircraft" to mapOf(
                            "lat" to (aircraftLocation?.latitude ?: 0.0),
                            "lon" to (aircraftLocation?.longitude ?: 0.0),
                            "alt" to realAircraftAlt  // Show estimated real altitude for display
                        ),
                        "target" to mapOf(
                            "lat" to location.latitude,
                            "lon" to location.longitude,
                            "alt" to targetAlt,
                            "distance" to 0.0  // UI calculates this
                        ),
                        "adjusted_alt" to adjustedLocation.altitude,  // What we actually sent to SDK
                        "sample" to requestId,
                        "capturedAt" to SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()),
                        "camera" to component.name
                    )
                )

                    enqueueMessage(clientId, responseData)
                }, 50) // Small delay to let ViewModels update
            } catch (e: Exception) {
                Log.e(TAG, "camera_live_view_location projection failed", e)
                clients[clientId]?.let { socket -> enqueueError(socket, "camera_live_view_location failed: ${e.message}") }
            }
        }
    }

    private fun handleGimbalReset(clientId: String, command: JSONObject) {
        try {
            val data = command.optJSONObject("data") ?: JSONObject()
            val indexName = data.optString("index", "LEFT_OR_MAIN").uppercase()
            val component = try { ComponentIndexType.valueOf(indexName) } catch (_: Exception) { ComponentIndexType.LEFT_OR_MAIN }

            // Target angles for reset (default to 0,0 to center gimbal relative to aircraft)
            val targetPitch = data.optDouble("pitch", 0.0)
            val targetYaw = data.optDouble("yaw", 0.0)

            // Try to use SDK's built-in reset if available (for factory reset/calibration)
            val useFactoryReset = data.optBoolean("factory_reset", false)

            if (useFactoryReset) {
                // Use KeyRestoreFactorySettings for complete reset
                try {
                    val resetKey = KeyTools.createKey(GimbalKey.KeyRestoreFactorySettings, component)
                    resetKey.action(EmptyMsg(),
                        { // Success callback
                            Log.i(TAG, "Gimbal factory reset successful")
                            sendGimbalResponse(clientId, true, "Gimbal factory reset successful", 0.0, 0.0)
                        },
                        { error -> // Error callback
                            Log.e(TAG, "Gimbal factory reset failed: $error")
                            // Fallback to manual reset
                            performManualGimbalReset(clientId, component, targetPitch, targetYaw)
                        }
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Factory reset not available, using manual reset: ${e.message}")
                    performManualGimbalReset(clientId, component, targetPitch, targetYaw)
                }
            } else {
                // Direct manual reset to specified angles
                performManualGimbalReset(clientId, component, targetPitch, targetYaw)
            }

        } catch (e: Exception) {
            Log.e(TAG, "gimbal_reset error: ${e.message}", e)
            sendGimbalResponse(clientId, false, e.message ?: "gimbal_reset error", 0.0, 0.0)
        }
    }

    private fun performManualGimbalReset(clientId: String, component: ComponentIndexType, targetPitch: Double, targetYaw: Double) {
        try {
            val keyManager = KeyManager.getInstance()
            val currentAttitude = keyManager.getValue(KeyTools.createKey(GimbalKey.KeyGimbalAttitude, component)) as? Attitude
            val currentPitch = currentAttitude?.pitch?.toDouble() ?: 0.0

            // For yaw, we need to use the relative yaw to properly zero the gimbal
            val currentYawRelative = keyManager.getValue(KeyTools.createKey(GimbalKey.KeyYawRelativeToAircraftHeading, component)) as? Double ?: 0.0

            // When zeroing, we want relative yaw to be 0 (aligned with aircraft)
            // If currentYawRelative is negative (gimbal pointing left), we need positive rotation to center
            // If currentYawRelative is positive (gimbal pointing right), we need negative rotation to center
            val pitchRotation = targetPitch - currentPitch
            val yawRotation = -currentYawRelative  // Negate to rotate back to center (target is 0)

            Log.i(TAG, "Gimbal reset: currentPitch=$currentPitch, currentYawRelative=$currentYawRelative")
            Log.i(TAG, "Gimbal reset: targetPitch=$targetPitch, targetYaw=$targetYaw")
            Log.i(TAG, "Gimbal reset: pitchRotation=$pitchRotation, yawRotation=$yawRotation")
            Log.i(TAG, "Gimbal reset: To center gimbal, rotating yaw by ${yawRotation}°")

            // Use MORE steps for better completion
            val steps = 20  // Increased from 10 to 30 for better completion
            val stepDelay = 50L // ms between steps

            executor.execute {
                for (i in 1..steps) {
                    val progress = i.toDouble() / steps

                    // Calculate velocity for this step
                    val pitchVel = if (i < steps) (pitchRotation / steps) * 20 else 0.0  // Scale to reasonable velocity
                    val yawVel = if (i < steps) (yawRotation / steps) * 20 else 0.0

                    executeGimbalVelocityCommand(yawVel.coerceIn(-FREELOOK_MAX_RATE, FREELOOK_MAX_RATE),
                                                 pitchVel.coerceIn(-FREELOOK_MAX_RATE, FREELOOK_MAX_RATE))

                    if (i < steps) {
                        Thread.sleep(stepDelay)
                    }
                }

                // Stop gimbal movement
                executeGimbalVelocityCommand(0.0, 0.0)

                // Report success
                sendGimbalResponse(clientId, true, "Gimbal reset to ($targetPitch, $targetYaw)", targetYaw, targetPitch)
            }

        } catch (e: Exception) {
            Log.e(TAG, "Manual gimbal reset error: ${e.message}", e)
            sendGimbalResponse(clientId, false, "Manual reset failed: ${e.message}", 0.0, 0.0)
        }
    }

    private fun handleGimbalLookAt(clientId: String, command: JSONObject) {
        try {
            val data = command.optJSONObject("data") ?: JSONObject()
            val latitude = data.getDouble("latitude")
            val longitude = data.getDouble("longitude")
            val altitude = data.getDouble("altitude")
            val modeName = data.optString("mode", "LOOK_AT_GIMBAL_FREE").uppercase()

            // Parse look at mode
            val lookAtMode = when(modeName) {
                "LOOK_AT_GIMBAL_FREE", "FREE" -> LookAtMode.LOOK_AT_GIMBAL_FREE
                "LOOK_AT_GIMBAL_FOLLOWING", "FOLLOWING", "FOLLOW" -> LookAtMode.LOOK_AT_GIMBAL_FOLLOWING
                "LOOK_AT_ZOOM_CIRCLE", "ZOOM_CIRCLE" -> LookAtMode.LOOK_AT_ZOOM_CIRCLE
                else -> LookAtMode.LOOK_AT_GIMBAL_FREE
            }

            val location = LocationCoordinate3D(latitude, longitude, altitude)
            val lookAtInfo = LookAtInfo().apply {
                this.location = location
                this.mode = lookAtMode
            }

            // Execute look at command
            val lookAtKey = KeyTools.createKey(FlightControllerKey.KeyLookAt)
            lookAtKey.action(lookAtInfo,
                { // Success callback
                    Log.i(TAG, "Gimbal look at successful: mode=$lookAtMode")
                    val responseData = mapOf(
                        "success" to true,
                        "mode" to lookAtMode.name,
                        "location" to mapOf(
                            "latitude" to latitude,
                            "longitude" to longitude,
                            "altitude" to altitude
                        )
                    )
                    val message = createMessage(MessageType.GIMBAL_LOOK_AT, responseData)
                    clients[clientId]?.let { sendWebSocketTextFrame(it, message) }
                },
                { error -> // Error callback
                    Log.e(TAG, "Gimbal look at failed: ${error.description()}")
                    clients[clientId]?.let {
                        sendErrorResponse(it, "Gimbal look at failed: ${error.description()}")
                    }
                }
            )
        } catch (e: Exception) {
            Log.e(TAG, "handleGimbalLookAt error: ${e.message}", e)
            clients[clientId]?.let { sendErrorResponse(it, "Look at failed: ${e.message}") }
        }
    }

    private val flightCommandHandler = FlightCommandHandler(
        runOnUiThread = ::runOnUiThread,
        sendFlightCommandResponse = { clientId, action, success, message, error, extra ->
            sendFlightCommandResponse(
                clientId = clientId,
                action = action,
                success = success,
                error = error,
                message = message,
                extra = extra ?: emptyMap()
            )
        },
        diagnosticExtrasProvider = { action -> diagnosticAggregator.collectForFlightAction(action) },
        postActionHook = { clientId, action, success -> handleFlightActionPostHook(clientId, action, success) },
        flySafeSnapshotProvider = { flySafeBridgeModel.toSnapshotMap() },
        flyToStatusProvider = { flyToBridgeModel.toTelemetryMap() },
        waypointMissionExecutor = waypointMissionExecutor,
        simulatorBridgeModel = simulatorBridgeModel
    )

    private val telemetryStreamer = TelemetryStreamer(
        scheduler = executor,
        tag = TAG,
        hasClients = { clients.isNotEmpty() },
        controllerSupplier = ::getControllerData,
        telemetrySupplier = ::createTelemetryDataMessage,
        batterySupplier = ::createBatteryStatusMessage,
        broadcast = ::broadcastToClients
    )

    private fun handleFlightCommand(clientId: String, command: JSONObject) {
        flightCommandHandler.handle(clientId, command)
    }

    private fun startPreflightStreaming() {
        stopPreflightStreaming()
        preflightFuture = executor.scheduleAtFixedRate({
            try {
                if (clients.isEmpty()) return@scheduleAtFixedRate
                val snapshot = diagnosticAggregator.buildPreflightSnapshot()
                val message = createMessage(MessageType.PREFLIGHT_STATUS, snapshot, Priority.HIGH)
                broadcastToClients(message)
            } catch (t: Throwable) {
                Log.e(TAG, "Error streaming preflight status: ${t.message}", t)
            }
        }, 0, 2, TimeUnit.SECONDS)
    }

    private fun stopPreflightStreaming() {
        preflightFuture?.cancel(true)
        preflightFuture = null
    }

    private fun handleFlightActionPostHook(clientId: String, action: String, success: Boolean) {
        when (action.lowercase(Locale.ROOT)) {
            "land", "force_land_start" -> if (success) startLandingMonitor(clientId) else cancelLandingMonitor()
            "cancel_landing", "force_land_stop", "takeoff" -> cancelLandingMonitor()
        }
    }

    private fun startLandingMonitor(clientId: String) {
        cancelLandingMonitor()
        landingMonitorClientId = clientId
        landingMonitorStartedAt = System.currentTimeMillis()
        landingMonitorFuture = executor.scheduleAtFixedRate({
            try {
                val keyManager = KeyManager.getInstance()
                val motorsOn = (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAreMotorsOn)) as? Boolean) ?: false
                val altitude = (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyAltitude)) as? Number)?.toDouble() ?: Double.NaN
                val elapsed = System.currentTimeMillis() - landingMonitorStartedAt

                val altitudeOk = altitude.isNaN() || altitude <= landingMonitorAltitudeThreshold
                if (!motorsOn && altitudeOk) {
                    cancelLandingMonitor()
                    return@scheduleAtFixedRate
                }

                if (elapsed >= landingMonitorTimeoutMs) {
                    val targetClientId = landingMonitorClientId
                    cancelLandingMonitor()

                    val monitorExtra = mutableMapOf<String, Any?>(
                        "landing_monitor" to mapOf(
                            "elapsed_ms" to elapsed,
                            "motors_on" to motorsOn,
                            "altitude" to altitude
                        )
                    )
                    diagnosticAggregator.collectForFlightAction("land_monitor")?.let { monitorExtra.putAll(it) }
                    targetClientId?.let { id ->
                        sendFlightCommandResponse(
                            clientId = id,
                            action = "land_monitor",
                            success = false,
                            message = "Landing not confirmed within ${landingMonitorTimeoutMs / 1000}s",
                            extra = monitorExtra
                        )
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Landing monitor error: ${t.message}", t)
            }
        }, 4_000, 1_000, TimeUnit.MILLISECONDS)
    }

    private fun cancelLandingMonitor() {
        landingMonitorFuture?.cancel(true)
        landingMonitorFuture = null
        landingMonitorClientId = null
        landingMonitorStartedAt = 0L
    }

    private fun sendFlightCommandResponse(
        clientId: String,
        action: String,
        success: Boolean,
        error: IDJIError? = null,
        message: String? = null,
        extra: Map<String, Any?> = emptyMap()
    ) {
        val data = mutableMapOf<String, Any?>(
            "action" to action,
            "status" to if (success) "ok" else "error",
            "timestamp" to System.currentTimeMillis()
        )
        error?.let {
            val errorMessage = runCatching { it.description() }
                .getOrNull()
                ?.takeUnless { msg -> msg.isNullOrBlank() }
                ?: it.toString()
            data["error_message"] = errorMessage
            data["error_type"] = it.javaClass.simpleName

            val errorCodeObj = runCatching { it.errorCode() }.getOrNull()
            val errorCodeText = errorCodeObj?.toString()
            val errorCodeNumeric = runCatching {
                val method = errorCodeObj?.javaClass?.methods?.firstOrNull { method ->
                    method.name.equals("code", ignoreCase = true) && method.parameterCount == 0
                }
                method?.invoke(errorCodeObj) as? Number
            }.getOrNull()
            errorCodeText?.let { code -> data["error_code"] = code }
            errorCodeNumeric?.let { numeric -> data["error_code_value"] = numeric }

            val errorDomain = runCatching {
                val method = it.javaClass.methods.firstOrNull { method ->
                    method.name.equals("errorDomain", ignoreCase = true) && method.parameterCount == 0
                }
                when (val domainValue = method?.invoke(it)) {
                    is Enum<*> -> domainValue.name
                    is String -> domainValue
                    else -> domainValue?.toString()
                }
            }.getOrNull()
            errorDomain?.let { domain -> data["error_domain"] = domain }
        }
        message?.let { data["message"] = it }
        if (extra.isNotEmpty()) {
            data.putAll(extra)
        }

        val socket = clients[clientId]
        if (socket == null || socket.isClosed) {
            Log.w(TAG, "Unable to deliver flight command response for $action - socket unavailable for client $clientId")
            return
        }

        socketExecutor.execute {
            try {
                val response = createMessage(MessageType.FLIGHT_COMMAND, data)
                sendWebSocketTextFrame(socket, response)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send flight command response for $action: ${e.message}", e)
                try {
                    val fallback = JSONObject().apply {
                        put("type", MessageType.FLIGHT_COMMAND.value)
                        put("version", PROTOCOL_VERSION)
                        put("timestamp", System.currentTimeMillis())
                        put("priority", Priority.HIGH.name.lowercase())
                        put("action", action)
                        put("status", "error")
                        put("error_message", "Bridge send failure: ${e.message}")
                    }
                    sendWebSocketTextFrame(socket, fallback.toString())
                } catch (fallbackError: Exception) {
                    Log.e(TAG, "Fallback flight command response also failed for $action: ${fallbackError.message}", fallbackError)
                }
            }
        }
    }

    private fun handleSystemCommand(clientId: String, command: JSONObject) {
        Log.i(TAG, "System command from $clientId: $command")

        try {
            val action = command.optString("action", "")
            val type = command.optString("type", "")

            // Handle both action-based and type-based commands
            when {
                type == "set_projection_mode" -> {
                    val mode = command.optString("mode", "fallback")
                    projectionMode = when (mode.lowercase()) {
                        "real" -> ProjectionMode.REAL
                        "horizontal" -> ProjectionMode.HORIZONTAL
                        else -> ProjectionMode.FALLBACK
                    }
                    Log.i(TAG, "Projection mode set to: $projectionMode")

                    val response = createMessage(MessageType.SYSTEM_STATUS, mapOf(
                        "projection_mode" to projectionMode.name.lowercase(),
                        "success" to true
                    ))
                    clients[clientId]?.let { socket -> sendWebSocketTextFrame(socket, response) }
                }
                type == "clear_projection_stats" -> {
                    // Clear any cached projection stats if needed
                    Log.i(TAG, "Clearing projection stats")
                }
                action == "start_video_streaming" -> {
                    Log.i(TAG, "Starting video streaming via system command")
                    startVideoStreaming()
                }
                action == "stop_video_streaming" -> {
                    Log.i(TAG, "Stopping video streaming via system command")
                    stopVideoStreaming()
                }
                action == "get_video_stats" -> {
                    Log.i(TAG, "Getting video streaming stats")
                    val stats = getVideoStreamingStats()
                    val response = createMessage(MessageType.SYSTEM_STATUS, stats)
                    clients[clientId]?.let { socket -> sendWebSocketTextFrame(socket, response) }
                }
                else -> {
                    Log.w(TAG, "Unknown system command action: $action, type: $type")
                    clients[clientId]?.let { socket ->
                        sendErrorResponse(socket, "Unknown system command action: $action")
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling system command", e)
            clients[clientId]?.let { socket ->
                sendErrorResponse(socket, "System command error: ${e.message}")
            }
        }
    }
    
    private fun handleHeartbeat(clientId: String, socket: Socket) {
        val response = createMessage(MessageType.HEARTBEAT, mapOf("status" to "alive"))
        sendWebSocketTextFrame(socket, response)
    }
    
    private fun handleGimbalTapTarget(clientId: String, json: JSONObject) {
        try {
            Log.i(TAG, "Processing gimbal tap for client: $clientId")
            
            val data = json.getJSONObject("data")  // REQUIRED: get data object
            val x = data.getDouble("x")  // 0.0 to 1.0
            val y = data.getDouble("y")  // 0.0 to 1.0
            
            // Validate coordinates
            if (x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0) {
                Log.e(TAG, "Invalid coordinates for client $clientId: x=$x, y=$y")
                sendGimbalResponse(clientId, false, "Invalid coordinates: x=$x, y=$y", x, y)
                return
            }
            
            val cameraIndex = ComponentIndexType.LEFT_OR_MAIN  // H20N camera
            val lens = getActiveCameraLens(cameraIndex)
            Log.i(TAG, "Sending gimbal tap command: x=$x, y=$y, camera=$cameraIndex, lens=$lens")

            CameraKey.KeyTapZoomAtTarget.createCamera(cameraIndex, lens)
                .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), {
                    Log.i(TAG, "✅ Gimbal tap SUCCESS for client $clientId at ($x, $y)")
                    sendGimbalResponse(clientId, true, "Gimbal moved to target position", x, y)
                }, { error ->
                    Log.e(TAG, "❌ Gimbal tap ERROR for client $clientId: $error")
                    sendGimbalResponse(clientId, false, "Gimbal error: ${error}", x, y)
                })
                
        } catch (e: Exception) {
            Log.e(TAG, "Exception in handleGimbalTapTarget: ${e.message}", e)
            sendGimbalResponse(clientId, false, "Processing error: ${e.message}", 0.0, 0.0)
        }
    }
    
    // Step 2 - Free Look Implementation
    private fun handleGimbalFreeLookStart(clientId: String, json: JSONObject) {
        try {
            Log.i("GIMBAL_FREE_LOOK", "🎮 Free Look START from $clientId")
            
            // Stop any existing session
            if (freeLookActive) {
                Log.w("GIMBAL_FREE_LOOK", "⚠️ Stopping existing Free Look session from ${freeLookClientId}")
                stopFreeLookSession()
            }
            
            // Initialize session state
            freeLookActive = true
            freeLookClientId = clientId
            freeLookLastUpdate = System.currentTimeMillis()
            freeLookVx = 0.0f
            freeLookVy = 0.0f
            freeLookPrevCmdVx = 0.0f
            freeLookPrevCmdVy = 0.0f
            
            // Start 15Hz control scheduler
            freeLookScheduler = executor.scheduleAtFixedRate({
                try {
                    executeFreeLookControl()
                } catch (e: Exception) {
                    Log.e("GIMBAL_ERR", "Error in Free Look control loop: ${e.message}", e)
                }
            }, 0, 1000L / FREELOOK_UPDATE_HZ, TimeUnit.MILLISECONDS)
            
            // Start watchdog timer
            scheduleFreeLookWatchdog()
            
            Log.i("GIMBAL_FREE_LOOK", "✅ Free Look session started for $clientId")
            sendGimbalResponse(clientId, true, "Free Look session started", 0.0, 0.0)
            
        } catch (e: Exception) {
            Log.e("GIMBAL_ERR", "Failed to start Free Look session: ${e.message}", e)
            sendGimbalResponse(clientId, false, "Failed to start Free Look: ${e.message}", 0.0, 0.0)
        }
    }
    
    private fun handleGimbalFreeLookUpdate(clientId: String, json: JSONObject) {
        try {
            if (!freeLookActive || freeLookClientId != clientId) {
                Log.w("GIMBAL_FREE_LOOK", "⚠️ UPDATE ignored - no active session for $clientId")
                return
            }
            
            val data = json.getJSONObject("data")
            val vx = data.getDouble("vx").toFloat().coerceIn(-1.0f, 1.0f)
            val vy = data.getDouble("vy").toFloat().coerceIn(-1.0f, 1.0f)
            
            // Update velocity and timestamp atomically
            freeLookVx = vx
            freeLookVy = vy
            freeLookLastUpdate = System.currentTimeMillis()
            
            // Reschedule watchdog
            scheduleFreeLookWatchdog()
            
            Log.d("GIMBAL_FREE_LOOK", "📊 UPDATE: vx=$vx, vy=$vy")
            // No response needed for updates
            
        } catch (e: Exception) {
            Log.e("GIMBAL_ERR", "Error processing Free Look UPDATE: ${e.message}", e)
        }
    }
    
    private fun handleGimbalFreeLookStop(clientId: String, json: JSONObject) {
        try {
            Log.i("GIMBAL_FREE_LOOK", "🛑 Free Look STOP from $clientId")
            
            if (!freeLookActive || freeLookClientId != clientId) {
                Log.w("GIMBAL_FREE_LOOK", "⚠️ STOP ignored - no active session for $clientId")
                sendGimbalResponse(clientId, true, "No active session to stop", 0.0, 0.0)
                return
            }
            
            // Stop session and send zero velocity immediately
            stopFreeLookSession()
            
            Log.i("GIMBAL_FREE_LOOK", "✅ Free Look session stopped for $clientId")
            sendGimbalResponse(clientId, true, "Free Look session stopped", 0.0, 0.0)
            
        } catch (e: Exception) {
            Log.e("GIMBAL_ERR", "Error stopping Free Look session: ${e.message}", e)
            sendGimbalResponse(clientId, false, "Error stopping Free Look: ${e.message}", 0.0, 0.0)
        }
    }
    
    // Removed precise look iterative and tap variants per instruction; use tap target only via GIMBAL_TAP_TARGET

    // Map current video stream source to camera lens type
    private fun calculateScreenX(targetBearing: Double, gimbalYawRelative: Double, streamSource: CameraVideoStreamSourceType?, zoomRatio: Double): Double {
        // Get horizontal FOV based on camera and zoom
        val baseFOV = when(streamSource) {
            CameraVideoStreamSourceType.WIDE_CAMERA -> 84.0  // Wide camera FOV
            CameraVideoStreamSourceType.ZOOM_CAMERA -> 84.0 / zoomRatio  // Zoom camera FOV changes with zoom
            CameraVideoStreamSourceType.INFRARED_CAMERA -> 40.0  // Thermal camera FOV
            else -> 84.0  // Default
        }

        // Calculate angle difference between target bearing and gimbal yaw
        var angleDiff = targetBearing - gimbalYawRelative
        while (angleDiff > 180) angleDiff -= 360
        while (angleDiff < -180) angleDiff += 360

        // Convert angle to normalized screen coordinate (0-1)
        // Center is 0.5, edges are 0 and 1
        val normalizedX = 0.5 + (angleDiff / baseFOV)

        return normalizedX.coerceIn(0.0, 1.0)
    }

    private fun calculateProjectedY(targetLat: Double, targetLon: Double, targetAlt: Double,
                                   aircraftLocation: LocationCoordinate3D, gimbalPitch: Double,
                                   streamSource: CameraVideoStreamSourceType?, zoomRatio: Double): Double {
        // Get vertical FOV based on camera and zoom
        val baseFOV = when(streamSource) {
            CameraVideoStreamSourceType.WIDE_CAMERA -> 53.0  // Wide camera vertical FOV
            CameraVideoStreamSourceType.ZOOM_CAMERA -> 53.0 / zoomRatio  // Zoom camera FOV changes with zoom
            CameraVideoStreamSourceType.INFRARED_CAMERA -> 31.0  // Thermal camera vertical FOV
            else -> 53.0  // Default
        }

        // Calculate distance to target
        val R = 6371000.0 // Earth radius in meters
        val dLat = Math.toRadians(targetLat - aircraftLocation.latitude)
        val dLon = Math.toRadians(targetLon - aircraftLocation.longitude)
        val a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(Math.toRadians(aircraftLocation.latitude)) * Math.cos(Math.toRadians(targetLat)) *
                Math.sin(dLon/2) * Math.sin(dLon/2)
        val c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
        val horizontalDistance = R * c

        // Calculate altitude difference and angle
        val altitudeDiff = targetAlt - aircraftLocation.altitude
        val angleToTarget = Math.toDegrees(Math.atan2(altitudeDiff, horizontalDistance))

        // Calculate angle difference from gimbal pitch
        val angleDiff = angleToTarget - (-gimbalPitch) // Gimbal pitch is negative when pointing down

        // Convert to screen coordinate (0=top, 1=bottom)
        val normalizedY = 0.5 - (angleDiff / baseFOV)

        Log.d(TAG, "*** Y calculation: gimbalPitch=$gimbalPitch, angleToTarget=$angleToTarget, angleDiff=$angleDiff, FOV=$baseFOV, y=$normalizedY ***")

        return normalizedY.coerceIn(0.0, 1.0)
    }

    private fun calculateScreenY(targetLat: Double, targetLon: Double, targetAlt: Double,
                                 aircraftLocation: LocationCoordinate3D, gimbalPitch: Double,
                                 streamSource: CameraVideoStreamSourceType?, zoomRatio: Double): Double {
        // Get vertical FOV based on camera and zoom
        val baseFOV = when(streamSource) {
            CameraVideoStreamSourceType.WIDE_CAMERA -> 53.0  // Wide camera vertical FOV
            CameraVideoStreamSourceType.ZOOM_CAMERA -> 53.0 / zoomRatio  // Zoom camera FOV changes with zoom
            CameraVideoStreamSourceType.INFRARED_CAMERA -> 31.0  // Thermal camera vertical FOV
            else -> 53.0  // Default
        }

        // Calculate distance to target
        val R = 6371000.0 // Earth radius in meters
        val dLat = Math.toRadians(targetLat - aircraftLocation.latitude)
        val dLon = Math.toRadians(targetLon - aircraftLocation.longitude)
        val a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(Math.toRadians(aircraftLocation.latitude)) * Math.cos(Math.toRadians(targetLat)) *
                Math.sin(dLon/2) * Math.sin(dLon/2)
        val c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
        val horizontalDistance = R * c

        // Calculate altitude difference and angle
        val altitudeDiff = targetAlt - aircraftLocation.altitude
        val angleToTarget = Math.toDegrees(Math.atan2(altitudeDiff, horizontalDistance))

        // Calculate angle difference from gimbal pitch
        val angleDiff = angleToTarget - (-gimbalPitch) // Gimbal pitch is negative when pointing down

        // Convert to screen coordinate (0=top, 1=bottom)
        val normalizedY = 0.5 - (angleDiff / baseFOV)

        return normalizedY.coerceIn(0.0, 1.0)
    }

    private fun getActiveCameraLens(cameraIndex: ComponentIndexType): CameraLensType {
        return try {
            val src = KeyManager.getInstance().getValue(CameraKey.KeyCameraVideoStreamSource.create(cameraIndex)) as? CameraVideoStreamSourceType
            when (src) {
                CameraVideoStreamSourceType.WIDE_CAMERA -> CameraLensType.CAMERA_LENS_WIDE
                CameraVideoStreamSourceType.ZOOM_CAMERA -> CameraLensType.CAMERA_LENS_ZOOM
                CameraVideoStreamSourceType.INFRARED_CAMERA -> {
                    // Fallback: if thermal lens type is not available in this SDK, prefer WIDE
                    try { CameraLensType.valueOf("CAMERA_LENS_THERMAL") } catch (_: Exception) { CameraLensType.CAMERA_LENS_WIDE }
                }
                else -> CameraLensType.CAMERA_LENS_WIDE
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read current video stream source: ${e.message}")
            CameraLensType.CAMERA_LENS_WIDE
        }
    }

    // Optional: allow client to select camera (WIDE/ZOOM/INFRARED) via bridge
    private fun handleCameraSelect(clientId: String, json: JSONObject) {
        try {
            val data = json.getJSONObject("data")
            val lensStr = data.optString("lens", "wide").lowercase()
            val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
            val src = when (lensStr) {
                "wide" -> CameraVideoStreamSourceType.WIDE_CAMERA
                "zoom" -> CameraVideoStreamSourceType.ZOOM_CAMERA
                "infrared", "ir", "thermal" -> CameraVideoStreamSourceType.INFRARED_CAMERA
                else -> CameraVideoStreamSourceType.WIDE_CAMERA
            }
            CameraKey.KeyCameraVideoStreamSource.create(cameraIndex).set(src)
            val msg = createMessage(MessageType.CAMERA_STATUS, mapOf("selected_lens" to lensStr))
            clients[clientId]?.let { sendWebSocketTextFrame(it, msg) }
            Log.i(TAG, "Camera lens switched to $lensStr ($src)")
        } catch (e: Exception) {
            Log.e(TAG, "Camera select failed: ${e.message}", e)
            clients[clientId]?.let { sendErrorResponse(it, "Camera select failed: ${e.message}") }
        }
    }

    // === Laser rangefinder integration ===
    private fun handleCameraLaserEnable(clientId: String, json: JSONObject) {
        try {
            val enabled = json.getJSONObject("data").getBoolean("enabled")
            val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
            try {
                CameraKey.KeyLaserMeasureEnabled.create(cameraIndex).set(enabled)
                Log.i("CAMERA_LASER", "Laser enabled=$enabled")
                val msg = createMessage(MessageType.CAMERA_STATUS, mapOf("laser_enabled" to enabled))
                clients[clientId]?.let { sendWebSocketTextFrame(it, msg) }
            } catch (e: Exception) {
                Log.e(TAG, "Laser enable failed: ${e.message}", e)
                clients[clientId]?.let { sendErrorResponse(it, "Laser enable failed: ${e.message}") }
            }
        } catch (e: Exception) {
            Log.e(TAG, "camera_laser_enable error: ${e.message}", e)
        }
    }

    private fun extractLaserInfo(info: Any?): Map<String, Any> {
        if (info == null) return emptyMap()
        fun call(obj: Any?, name: String): Any? {
            if (obj == null) return null
            return try { obj.javaClass.getMethod(name).invoke(obj) } catch (e: Exception) { null }
        }
        val distance = (call(info, "getDistance") as? Number)?.toDouble()
        val state = (call(info, "getLaserMeasureState") as? Number)?.toInt()
        val loc = call(info, "getLocation3D")
        val lat = (call(loc, "getLatitude") as? Number)?.toDouble()
        val lon = (call(loc, "getLongitude") as? Number)?.toDouble()
        val alt = (call(loc, "getAltitude") as? Number)?.toDouble()
        val tp = call(info, "getTargetPoint")
        val tx = (call(tp, "getX") as? Number)?.toDouble()
        val ty = (call(tp, "getY") as? Number)?.toDouble()

        // Get current aircraft location and altitude
        val aircraft3DLocation = try {
            KeyManager.getInstance().getValue(FlightControllerKey.KeyAircraftLocation3D.create()) as? LocationCoordinate3D
        } catch (e: Exception) { null }

        // Get takeoff location altitude (this is MSL at takeoff point)
        val takeoffLocationAltitude = try {
            KeyManager.getInstance().getValue(FlightControllerKey.KeyTakeoffLocationAltitude.create()) as? Double
        } catch (e: Exception) { null }

        // Get the barometric altitude (should be MSL)
        val barometricAltitude = try {
            KeyManager.getInstance().getValue(FlightControllerKey.KeyAltitude.create()) as? Double
        } catch (e: Exception) { null }

        val data = mutableMapOf<String, Any>()
        distance?.let { data["distance_m"] = it }
        if (lat != null && lon != null && alt != null) {
            // The LRF returns WGS-84 ellipsoid height (like waypoint.alt_m)
            // We need to convert to AMSL (Above Mean Sea Level)

            // Get aircraft's relative altitude from takeoff
            val aircraftRelativeAlt = aircraft3DLocation?.altitude ?: 0.0

            // Calculate the current aircraft MSL altitude
            val aircraftMSL = if (takeoffLocationAltitude != null) {
                takeoffLocationAltitude + aircraftRelativeAlt
            } else if (barometricAltitude != null) {
                // Use barometric altitude as fallback (it should be MSL)
                barometricAltitude + (takeoffLocationAltitude ?: 0.0)
            } else {
                null
            }

            // The key insight: The LRF altitude is WGS-84 ellipsoid height
            // DJI Pilot shows MSL altitude
            // The difference between them is the geoid separation (geoid height)

            // Since the SDK doesn't provide geoid conversion, we can derive it from known data:
            // At the aircraft position, we know both:
            // - MSL altitude (from barometric or takeoff + relative)
            // - What the WGS-84 height would be (if we had it)

            // For local area, geoid separation is approximately constant
            // So we can use the aircraft's geoid separation for the target

            // Calculate geoid separation using the takeoff location as reference
            // The key insight: KeyTakeoffLocationAltitude returns MSL altitude at takeoff
            // If we also had the WGS-84 ellipsoid height at takeoff, we could calculate geoid separation
            // But since LocationCoordinate3D.altitude is relative, we need a different approach

            // We can derive the geoid separation if we have GPS altitude data
            // The barometric altitude (KeyAltitude) should be closer to MSL
            // While raw GPS altitude would be WGS-84

            // Since the LRF altitude appears to be WGS-84 ellipsoid height,
            // and we need MSL, we must apply the geoid correction

            // Convert WGS-84 ellipsoid height to MSL using proper geoid model
            val correctedAlt = if (lat != null && lon != null) {
                // Use the GeoidModel to convert WGS-84 ellipsoid height to MSL
                val mslAltitude = GeoidModel.ellipsoidToMSL(alt, lat, lon)
                val geoidHeight = GeoidModel.getGeoidHeight(lat, lon)

                Log.i("CAMERA_LASER", "  - Geoid height at ($lat, $lon): $geoidHeight m")
                Log.i("CAMERA_LASER", "  - Converted MSL altitude: $mslAltitude m")

                mslAltitude
            } else {
                // No coordinates available for geoid conversion
                Log.w("CAMERA_LASER", "No coordinates for geoid conversion, returning WGS-84 altitude")
                alt
            }

            Log.i("CAMERA_LASER", "LRF Altitude Debug:")
            Log.i("CAMERA_LASER", "  - LRF reported altitude (WGS-84): $alt m")
            Log.i("CAMERA_LASER", "  - Aircraft relative altitude (AGL): $aircraftRelativeAlt m")
            Log.i("CAMERA_LASER", "  - Takeoff location altitude: $takeoffLocationAltitude m")
            Log.i("CAMERA_LASER", "  - Barometric altitude: $barometricAltitude m")
            Log.i("CAMERA_LASER", "  - Aircraft MSL: $aircraftMSL m")
            Log.i("CAMERA_LASER", "  - Distance to target: $distance m")

            data["waypoint"] = mapOf(
                "lat" to lat,
                "lon" to lon,
                "alt_m" to correctedAlt,  // This should be MSL after correction
                "alt_debug" to mapOf(
                    "lrf_wgs84" to alt,  // Raw WGS-84 ellipsoid height from SDK
                    "aircraft_agl" to aircraftRelativeAlt,
                    "takeoff_alt" to takeoffLocationAltitude,
                    "barometric_alt" to barometricAltitude,
                    "distance" to distance
                )
            )
        }
        if (tx != null && ty != null) {
            data["target_point"] = mapOf("x" to tx, "y" to ty)
        }
        state?.let { data["state"] = it }
        data["timestamp"] = System.currentTimeMillis()
        return data
    }

    private fun handleCameraLaserGet(clientId: String, json: JSONObject) {
        try {
            val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
            val info = try { KeyManager.getInstance().getValue(CameraKey.KeyLaserMeasureInformation.create(cameraIndex)) } catch (e: Exception) { null }
            Log.i("CAMERA_LASER", "Laser get -> $info")
            val data = extractLaserInfo(info)
            val msg = createMessage(MessageType.CAMERA_LASER_RESULT, mapOf("ok" to (data.isNotEmpty()), "data" to data))
            clients[clientId]?.let { sendWebSocketTextFrame(it, msg) }
        } catch (e: Exception) {
            Log.e(TAG, "camera_laser_get error: ${e.message}", e)
        }
    }

    private fun handleCameraLaserMeasure(clientId: String, json: JSONObject) {
        try {
            val data = json.getJSONObject("data")
            val x = data.getDouble("x").coerceIn(0.0, 1.0)
            val y = data.getDouble("y").coerceIn(0.0, 1.0)
            val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
            val lens = getActiveCameraLens(cameraIndex)
            // Center the target first
            Log.i("CAMERA_LASER", "Measure tap at x=${"%.3f".format(x)}, y=${"%.3f".format(y)} lens=$lens")
            CameraKey.KeyTapZoomAtTarget.createCamera(cameraIndex, lens)
                .action(ZoomTargetPointInfo(x, y, false, TapZoomMode.UNKNOWN), {
                    // After a short settle, read laser info
                    executor.schedule({
                        try {
                            val info = KeyManager.getInstance().getValue(CameraKey.KeyLaserMeasureInformation.create(cameraIndex))
                            Log.i("CAMERA_LASER", "Laser measure -> $info")
                            val res = extractLaserInfo(info)
                            val msg = createMessage(
                                MessageType.CAMERA_LASER_RESULT,
                                mapOf("ok" to (res.isNotEmpty()), "data" to res)
                            )
                            clients[clientId]?.let { sendWebSocketTextFrame(it, msg) }
                        } catch (e: Exception) {
                            Log.e(TAG, "laser measure read error: ${e.message}")
                        }
                    }, 250, java.util.concurrent.TimeUnit.MILLISECONDS)
                }, { error ->
                    Log.e(TAG, "tap before laser failed: $error")
                })
        } catch (e: Exception) {
            Log.e(TAG, "camera_laser_measure error: ${e.message}", e)
        }
    }
    
    // Free Look core functions
    private fun stopFreeLookSession() {
        if (!freeLookActive) return
        
        Log.i("GIMBAL_FREE_LOOK", "🛑 Stopping Free Look session")
        
        // Send zero velocity command immediately
        executeGimbalVelocityCommand(0.0, 0.0)
        
        // Cancel schedulers
        freeLookScheduler?.cancel(false)
        freeLookWatchdog?.cancel(false)
        
        // Clear session state
        freeLookActive = false
        freeLookClientId = null
        freeLookScheduler = null
        freeLookWatchdog = null
        freeLookVx = 0.0f
        freeLookVy = 0.0f
        freeLookPrevCmdVx = 0.0f
        freeLookPrevCmdVy = 0.0f
        
        Log.d("GIMBAL_FREE_LOOK", "🧹 Session cleanup complete")
    }
    
    private fun scheduleFreeLookWatchdog() {
        freeLookWatchdog?.cancel(false)
        freeLookWatchdog = executor.schedule({
            val now = System.currentTimeMillis()
            if (freeLookActive && (now - freeLookLastUpdate) > FREELOOK_WATCHDOG_MS) {
                Log.w("GIMBAL_FREE_LOOK", "⏰ Watchdog timeout - auto-stopping session")
                stopFreeLookSession()
            }
        }, FREELOOK_WATCHDOG_MS + 50, TimeUnit.MILLISECONDS)
    }
    
    private fun executeFreeLookControl() {
        if (!freeLookActive) return
        
        // Apply dead zone
        var vx = freeLookVx
        var vy = freeLookVy
        
        if (Math.abs(vx) < FREELOOK_DEAD_ZONE) vx = 0.0f
        if (Math.abs(vy) < FREELOOK_DEAD_ZONE) vy = 0.0f
        
        // Apply exponential curve: deg = sign(v) * (|v|^1.6) * MAX_RATE
        val yawRate = if (vx == 0.0f) 0.0 else vx.toDouble() * FREELOOK_MAX_RATE
        val pitchRate = if (vy == 0.0f) 0.0 else -vy.toDouble() * FREELOOK_MAX_RATE
        
        // Low-pass filter for smoothness
        val smoothYawRate = 0.2 * freeLookPrevCmdVx + 0.8 * yawRate
        val smoothPitchRate = 0.2 * freeLookPrevCmdVy + 0.8 * pitchRate
        
        // Store for next iteration
        freeLookPrevCmdVx = smoothYawRate.toFloat()
        freeLookPrevCmdVy = smoothPitchRate.toFloat()
        
        // Execute gimbal command
        executeGimbalVelocityCommand(smoothYawRate, smoothPitchRate)
        
        // Log applied rates (only when non-zero to reduce spam)
        freeLookLogTick = (freeLookLogTick + 1) % 6 // ~2.5Hz at 15Hz loop
        if (freeLookLogTick == 0 && (Math.abs(smoothYawRate) > 0.1 || Math.abs(smoothPitchRate) > 0.1)) {
            Log.d("GIMBAL_FREE_LOOK", "🎮 Applied: yaw=${String.format("%.1f", smoothYawRate)}°/s, pitch=${String.format("%.1f", smoothPitchRate)}°/s")
        }
    }
    
    private fun executeGimbalVelocityCommand(yawRate: Double, pitchRate: Double) {
        try {
            val cameraIndex = ComponentIndexType.LEFT_OR_MAIN
            
            // Primary control: Try DJI speed rotation
            val speedRotation = GimbalSpeedRotation(
                pitchRate.coerceIn(-FREELOOK_MAX_RATE, FREELOOK_MAX_RATE),
                yawRate.coerceIn(-FREELOOK_MAX_RATE, FREELOOK_MAX_RATE),
                0.0,
                CtrlInfo()
            )
            
            GimbalKey.KeyRotateBySpeed.create(cameraIndex).action(speedRotation, {
                // Success - no logging needed for frequent commands
            }, { error ->
                Log.e("GIMBAL_ERR", "🚨 Speed rotation failed: $error")
                // TODO: Fallback to angle steps or tap-zoom emulation
            })
            
        } catch (e: Exception) {
            Log.e("GIMBAL_ERR", "🚨 Gimbal velocity command error: ${e.message}", e)
        }
    }
    
    private fun sendGimbalResponse(clientId: String, success: Boolean, message: String, x: Double, y: Double) {
        // Use executor to avoid NetworkOnMainThreadException
        executor.submit {
            try {
                Log.d(TAG, "🔍 DEBUG: Creating gimbal response for client $clientId on background thread")
                Log.d(TAG, "🔍 DEBUG: Input parameters - success=$success, message=$message, x=$x, y=$y")
                
                val responseData = mapOf(
                    "success" to success,
                    "message" to message,
                    "coordinates" to mapOf(
                        "x" to x,
                        "y" to y
                    ),
                    "timestamp" to System.currentTimeMillis(),
                    "camera" to "H20N"
                )
                
                Log.d(TAG, "🔍 DEBUG: Response data created: $responseData")
                
                Log.d(TAG, "🔍 DEBUG: About to call createMessage with MessageType.GIMBAL_RESPONSE")
                val response = try {
                    createMessage(MessageType.GIMBAL_RESPONSE, responseData)
                } catch (e: Exception) {
                    Log.e(TAG, "❌ Exception in createMessage for GIMBAL_RESPONSE: ${e.message}", e)
                    null
                }
                
                Log.d(TAG, "🔍 DEBUG: createMessage returned: ${if (response != null) "non-null (${response.length} chars)" else "NULL"}")
                
                if (response == null) {
                    Log.e(TAG, "❌ CRITICAL: createMessage returned null for GIMBAL_RESPONSE")
                    return@submit
                }
                
                val socket = clients[clientId]
                Log.d(TAG, "🔍 DEBUG: Socket for client $clientId: ${if (socket != null) "non-null, closed=${socket.isClosed}" else "NULL"}")
                
                if (socket != null && !socket.isClosed) {
                    Log.d(TAG, "🔍 DEBUG: About to call sendWebSocketTextFrame on background thread...")
                    sendWebSocketTextFrame(socket, response)
                    Log.d(TAG, "✅ Sent gimbal response to client $clientId: success=$success, message=$message")
                } else {
                    Log.w(TAG, "Cannot send gimbal response - client $clientId socket not available or closed")
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ Failed to send gimbal response to client $clientId: ${e.message}", e)
                e.printStackTrace()
            }
        }
    }
    
    private fun sendErrorResponse(socket: Socket, error: String) {
        val response = createMessage(MessageType.ERROR, mapOf("error" to error))
        sendWebSocketTextFrame(socket, response)
    }
    
    private fun sendPongFrame(socket: Socket, payload: ByteArray) {
        sendWebSocketFrame(socket, payload, 0xA) // Pong frame
    }
    
    private fun generateWebSocketAcceptKey(webSocketKey: String): String {
        val combined = webSocketKey + WEBSOCKET_MAGIC_STRING
        val digest = MessageDigest.getInstance("SHA-1")
        val hash = digest.digest(combined.toByteArray(StandardCharsets.UTF_8))
        return Base64.getEncoder().encodeToString(hash)
    }
    
    // Message creation utilities with proper JSON serialization
    private fun createMessage(type: MessageType, data: Any, priority: Priority = Priority.NORMAL): String {
        try {
            Log.d(TAG, "🔍 DEBUG createMessage: Starting with type=${type.value}, data=$data")
            
            val message = JSONObject().apply {
                Log.d(TAG, "🔍 DEBUG createMessage: Adding basic fields")
                put("type", type.value)
                put("version", PROTOCOL_VERSION)
                put("timestamp", System.currentTimeMillis())
                put("priority", priority.name.lowercase())
                
                Log.d(TAG, "🔍 DEBUG createMessage: Processing data - type: ${data::class.simpleName}")
                when (data) {
                    is Map<*, *> -> {
                        Log.d(TAG, "🔍 DEBUG createMessage: Processing Map with ${data.size} entries")
                        data.forEach { (key, value) ->
                            Log.d(TAG, "🔍 DEBUG createMessage: Processing map entry: $key -> $value")
                            put(key.toString(), convertToJsonValue(value))
                        }
                        Log.d(TAG, "🔍 DEBUG createMessage: Finished processing Map")
                    }
                    is JSONObject -> {
                        Log.d(TAG, "🔍 DEBUG createMessage: Processing JSONObject")
                        // Copy all fields from the JSONObject
                        data.keys().forEach { key ->
                            put(key, data.get(key))
                        }
                    }
                    else -> {
                        Log.d(TAG, "🔍 DEBUG createMessage: Adding data as single field")
                        put("data", data)
                    }
                }
                Log.d(TAG, "🔍 DEBUG createMessage: JSON object construction complete")
            }
            
            Log.d(TAG, "🔍 DEBUG createMessage: Converting to string...")
            val result = message.toString()
            Log.d(TAG, "🔍 DEBUG createMessage: SUCCESS - result length: ${result.length}")
            return result
            
        } catch (e: Exception) {
            Log.e(TAG, "❌ Exception in createMessage: ${e.message}", e)
            throw e
        }
    }
    
    private fun convertToJsonValue(value: Any?): Any? {
        return try {
            when (value) {
                null -> JSONObject.NULL
                is JSONObject, is JSONArray -> value
                is Map<*, *> -> JSONObject().apply {
                    value.forEach { (k, v) ->
                        put(k.toString(), convertToJsonValue(v))
                    }
                }
                is List<*> -> JSONArray().apply {
                    value.forEach { item ->
                        put(convertToJsonValue(item))
                    }
                }
                is Array<*> -> JSONArray().apply {
                    value.forEach { item ->
                        put(convertToJsonValue(item))
                    }
                }
                is Number, is Boolean, is String -> value
                else -> value.toString()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "convertToJsonValue fallback for ${value?.let { it::class.java.simpleName }}: ${t.message}")
            value?.toString() ?: JSONObject.NULL
        }
    }
    
    private fun createControllerDataMessage(): String {
        // Get stick values directly from bridge activity
        val stickValues = if (bridgeActivity is dji.sampleV5.aircraft.DJIBridgeActivity) {
            val values = bridgeActivity.getCurrentStickValues()
            Log.d(TAG, "Got stick values: $values")
            values
        } else {
            Log.w(TAG, "bridgeActivity is not DJIBridgeActivity, using zeros")
            mapOf(
                "leftHorizontal" to 0,
                "leftVertical" to 0,
                "rightHorizontal" to 0,
                "rightVertical" to 0
            )
        }
        
        val virtualStickState = latestVirtualStickState
        val authorityOwner = virtualStickState?.currentFlightControlAuthorityOwner ?: FlightControlAuthority.UNKNOWN
        val authorityName = authorityOwner.name
        val manualOverride = when {
            authorityName.equals("UNKNOWN", ignoreCase = true) -> false
            authorityName.equals("APP", ignoreCase = true) -> false
            authorityName.isBlank() -> false
            else -> true
        }
        val controllerData = mapOf(
            "joystick" to mapOf(
                "left_horizontal" to (stickValues["leftHorizontal"] ?: 0),
                "left_vertical" to (stickValues["leftVertical"] ?: 0),
                "right_horizontal" to (stickValues["rightHorizontal"] ?: 0),
                "right_vertical" to (stickValues["rightVertical"] ?: 0)
            ),
            "flight_params" to mapOf(
                "yaw" to (stickValues["leftHorizontal"] ?: 0).toFloat() / 100.0f,
                "throttle" to (stickValues["leftVertical"] ?: 0).toFloat() / 100.0f,
                "roll" to (stickValues["rightHorizontal"] ?: 0).toFloat() / 100.0f,
                "pitch" to (stickValues["rightVertical"] ?: 0).toFloat() / 100.0f
            ),
            "virtual_stick_enabled" to (virtualStickState?.isVirtualStickEnable ?: false),
            "authority_owner" to authorityOwner.name,
            "virtual_stick" to mapOf(
                "enabled" to (virtualStickState?.isVirtualStickEnable ?: false),
                "advanced_enabled" to (virtualStickState?.isVirtualStickAdvancedModeEnabled ?: false),
                "authority_owner" to authorityOwner.name,
                "manual_override" to manualOverride,
                "change_reason" to latestVirtualStickReason.name
            )
        )
        
        val message = createMessage(MessageType.CONTROLLER_DATA, controllerData, Priority.HIGH)
        
        // Debug log for non-zero values
        val hasMovement = stickValues.values.any { it != 0 }
        if (hasMovement) {
            Log.d(TAG, "SENDING CONTROLLER DATA: ${message.length} bytes")
        }
        
        return message
    }
    
    // Extensible data creators for future use
    private fun createSensorDataMessage(): String {
        // TODO: Collect comprehensive sensor data
        val sensorData = mapOf(
            "accelerometer" to mapOf("x" to 0.0, "y" to 0.0, "z" to 0.0),
            "gyroscope" to mapOf("x" to 0.0, "y" to 0.0, "z" to 0.0),
            "magnetometer" to mapOf("x" to 0.0, "y" to 0.0, "z" to 0.0),
            "barometer" to mapOf("pressure" to 0.0, "altitude" to 0.0)
        )
        return createMessage(MessageType.SENSOR_DATA, sensorData)
    }
    
    private fun createTelemetryDataMessage(): String {
        // Collect real flight telemetry data using proper DJI SDK V5 integration
        val telemetryData = try {
            val keyManager = KeyManager.getInstance()
            
            // Check if motors are on (altitude readings may be invalid when motors are off)
            val motorsOnKey = KeyTools.createKey(FlightControllerKey.KeyAreMotorsOn)
            val areMotorsOn = keyManager.getValue(motorsOnKey) as? Boolean ?: false

            // Get 3D aircraft location first (this contains the altitude)
            val aircraft3DLocationKey = KeyTools.createKey(FlightControllerKey.KeyAircraftLocation3D)
            val aircraft3DLocation = keyManager.getValue(aircraft3DLocationKey) as? LocationCoordinate3D

            // Get barometric relative altitude (what SDK altitude widget uses)
            val baroAltitudeKey = KeyTools.createKey(FlightControllerKey.KeyAltitude)
            val baroRelativeAltitude = (keyManager.getValue(baroAltitudeKey) as? Number)?.toDouble() ?: 0.0

            // Keep GPS relative altitude for reference (LocationCoordinate3D.altitude is RELATIVE from takeoff)
            val gpsRelativeAltitude = aircraft3DLocation?.altitude ?: 0.0

            // Capture ground elevation when motors first turn on
            if (areMotorsOn && !lastMotorsOnState && aircraft3DLocation != null) {
                // Motors just turned on - capture ground elevation from SDK
                val takeoffAltitudeKey = KeyTools.createKey(FlightControllerKey.KeyTakeoffLocationAltitude)
                val sdkTakeoffAltitude = (keyManager.getValue(takeoffAltitudeKey) as? Number)?.toDouble()
                capturedTakeoffAltitude = sdkTakeoffAltitude
                Log.i(TAG, "Motors ON - captured takeoff altitude from SDK: ${capturedTakeoffAltitude}m")
            }
            lastMotorsOnState = areMotorsOn

            // Get takeoff location altitude (only valid after takeoff)
            val takeoffAltitudeKey = KeyTools.createKey(FlightControllerKey.KeyTakeoffLocationAltitude)
            val takeoffLocationAltitude = (keyManager.getValue(takeoffAltitudeKey) as? Number)?.toDouble() ?: 0.0

            // Get RTK takeoff altitude info (this is what attitude widget uses for mHomePointAltitude)
            val rtkTakeoffKey = KeyTools.createKey(RtkMobileStationKey.KeyRTKTakeoffAltitudeInfo)
            val rtkTakeoffInfo = keyManager.getValue(rtkTakeoffKey) as? RTKTakeoffAltitudeInfo
            val homePointAltitude = rtkTakeoffInfo?.altitude?.toDouble() ?: takeoffLocationAltitude

            // Get home location
            val homeLocationKey = KeyTools.createKey(FlightControllerKey.KeyHomeLocation)
            val homeLocation = keyManager.getValue(homeLocationKey) as? LocationCoordinate2D
            homeLocation?.let { flySafeBridgeModel.pullSurroundingZones(it) }

            // Get 2D aircraft location for lat/lon
            val aircraftLocationKey = KeyTools.createKey(FlightControllerKey.KeyAircraftLocation)
            val aircraftLocation = keyManager.getValue(aircraftLocationKey) as? LocationCoordinate2D

            // Prepare latitude/longitude for geoid conversion (prefer home location for stability)
            val conversionLat = when {
                homeLocation != null && !homeLocation.latitude.isNaN() -> homeLocation.latitude
                aircraftLocation != null && !aircraftLocation.latitude.isNaN() -> aircraftLocation.latitude
                aircraft3DLocation != null && !aircraft3DLocation.latitude.isNaN() -> aircraft3DLocation.latitude
                else -> Double.NaN
            }
            val conversionLon = when {
                homeLocation != null && !homeLocation.longitude.isNaN() -> homeLocation.longitude
                aircraftLocation != null && !aircraftLocation.longitude.isNaN() -> aircraftLocation.longitude
                aircraft3DLocation != null && !aircraft3DLocation.longitude.isNaN() -> aircraft3DLocation.longitude
                else -> Double.NaN
            }

            // Convert altitude to AMSL exactly like the Attitude Display widget
            val totalAltitudeEllipsoid = homePointAltitude + baroRelativeAltitude
            val altitudeAsl = if (!conversionLat.isNaN() && !conversionLon.isNaN()) {
                GpsUtils.egm96Altitude(totalAltitudeEllipsoid, conversionLat, conversionLon)
            } else {
                totalAltitudeEllipsoid
            }

            // Derive takeoff altitude (ground level) in ASL by removing the relative altitude component
            val takeoffASL = altitudeAsl - baroRelativeAltitude

            Log.i(TAG, "Altitude Debug -> AGL=${baroRelativeAltitude}m, homePointEllipsoid=${homePointAltitude}m, takeoffASL=${takeoffASL}m, ASL=${altitudeAsl}m")

            // Get ultrasonic height (more accurate for low altitudes, returned in decimeters)
            val ultrasonicHeightKey = KeyTools.createKey(FlightControllerKey.KeyUltrasonicHeight)
            val ultrasonicHeightDm = keyManager.getValue(ultrasonicHeightKey)
            val ultrasonicHeight = when (ultrasonicHeightDm) {
                is Number -> ultrasonicHeightDm.toDouble() / 10.0  // Convert dm to meters
                else -> null
            }

            // Flight limit telemetry
            val maxFlightHeight = try {
                (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyHeightLimit)) as? Number)?.toDouble()
            } catch (_: Exception) {
                null
            }
            val maxFlightDistance = try {
                (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyDistanceLimit)) as? Number)?.toDouble()
            } catch (_: Exception) {
                null
            }
            val maxFlightDistanceEnabled = try {
                keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyDistanceLimitEnabled)) as? Boolean
            } catch (_: Exception) {
                null
            }
            val goHomeHeight = try {
                (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyGoHomeHeight)) as? Number)?.toDouble()
            } catch (_: Exception) {
                null
            }

            // GPS/GNSS telemetry details
            val gpsSatelliteCount = try {
                (keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyGPSSatelliteCount)) as? Number)?.toInt()
            } catch (_: Exception) {
                null
            }
            val gpsSignalLevel = try {
                FlightControllerKey.KeyGPSSignalLevel.create().let { keyManager.getValue(it) as? GPSSignalLevel }
            } catch (_: Exception) {
                null
            }

            // RC/Airlink telemetry
            val rcSignalQuality = try {
                (keyManager.getValue(KeyTools.createKey(AirLinkKey.KeyUpLinkQualityRaw)) as? Number)?.toInt()
            } catch (_: Exception) {
                null
            }

            // Flight mode and status details
            val flightMode = try {
                keyManager.getValue(KeyTools.createKey(FlightControllerKey.KeyFlightMode)) as? FlightMode
            } catch (_: Exception) {
                null
            }
            val flightModeName = flightMode?.name ?: "UNKNOWN"
            val flightModeLabel = flightModeName.lowercase(Locale.ROOT)
            val isAutoLanding = flightModeName.contains("LAND", ignoreCase = true)
            val isAutoGoHome = flightModeName.contains("GO_HOME", ignoreCase = true) || flightModeName.contains("GOHOME", ignoreCase = true)

            // Device status & health summaries
                val deviceStatus = try {
                    DeviceStatusManager.getInstance().currentDJIDeviceStatus
                } catch (_: Exception) {
                    null
                }
                val deviceStatusMap = deviceStatus?.let {
                    mapOf(
                        "code" to it.statusCode(),
                        "label" to it.name,
                        "description" to it.description(),
                        "level" to it.warningLevel()?.name
                    )
                }
                val healthInfos = try {
                    DeviceHealthManager.getInstance().currentDJIDeviceHealthInfos?.filterIsInstance<DJIDeviceHealthInfo>() ?: emptyList()
                } catch (_: Exception) {
                    emptyList()
                }
            var healthSeverityRank = 0
            val diagnosticEntries = if (healthInfos.isNotEmpty()) {
                healthInfos.map { info ->
                    val warningLevel = info.warningLevel()
                    val entryRank = warningSeverity(warningLevel)
                    if (entryRank > healthSeverityRank) {
                        healthSeverityRank = entryRank
                    }
                    mapOf(
                        "title" to info.title(),
                        "description" to info.description(),
                        "code" to info.informationCode(),
                        "component_id" to info.componentId(),
                        "sensor_index" to info.sensorIndex(),
                        "level" to warningLevel?.name
                    )
                }
            } else {
                emptyList()
            }
            val diagnosticsSeverityRank = listOfNotNull(
                deviceStatus?.warningLevel()?.let { warningSeverity(it) },
                healthSeverityRank.takeIf { it > 0 }
            ).maxOrNull() ?: 0
            val diagnosticsSeverity = severityName(diagnosticsSeverityRank)

            // Get aircraft velocity
            val velocityKey = KeyTools.createKey(FlightControllerKey.KeyAircraftVelocity)
            val velocity = keyManager.getValue(velocityKey) as? Velocity3D
            
            // Calculate ground speed (horizontal velocity)
            val groundSpeed = velocity?.let { 
                kotlin.math.sqrt(it.x * it.x + it.y * it.y).toDouble()
            } ?: 0.0
            
            mutableMapOf(
                // System info
                "timestamp" to System.currentTimeMillis(),
                "bridge_status" to "active",
                "data_collection_status" to "sdk_integrated",
                "system_status" to deviceStatusMap,
                "system_status_level" to deviceStatus?.warningLevel()?.name,
                "diagnostics" to diagnosticEntries,
                "diagnostics_severity" to diagnosticsSeverity,
                "fly_safe" to flySafeBridgeModel.toJson(),
                "satellite_count" to gpsSatelliteCount,
                "gps_signal_level" to gpsSignalLevel?.name,
                "max_flight_height" to maxFlightHeight,
                "max_flight_distance" to maxFlightDistance,
                "max_flight_distance_enabled" to maxFlightDistanceEnabled,
                "go_home_height" to goHomeHeight,
                "rc_signal_quality" to rcSignalQuality,
                
                // Real flight data with consistent altitude naming
                "altitude" to baroRelativeAltitude,  // AGL - relative altitude from home
                "altitude_above_takeoff" to baroRelativeAltitude,  // Same as AGL
                "altitude_above_home" to baroRelativeAltitude,  // AGL - relative from home
                "altitude_barometric" to altitudeAsl,  // AMSL - barometric altitude
                "altitude_amsl" to altitudeAsl,  // ASL - for main display (PFD corrected)
                "altitude_gps_relative" to gpsRelativeAltitude,  // GPS relative for reference
                "altitude_ultrasonic" to ultrasonicHeight,  // Ultrasonic height (if available)
                "takeoff_altitude" to takeoffASL,  // Takeoff location altitude in ASL
                "motors_on" to areMotorsOn,  // Include motor status for debugging
                "ground_speed" to groundSpeed,
                "vertical_speed" to (velocity?.z?.toDouble() ?: 0.0),
                "flight_mode" to flightModeName,
                "flight_mode_label" to flightModeLabel,
                "is_auto_landing" to isAutoLanding,
                "is_auto_returning_home" to isAutoGoHome,

                // Location data - use ASL for aircraft position
                "location" to run {
                    // Use 3D location if available, otherwise fall back to 2D
                    val lat = aircraft3DLocation?.latitude ?: aircraftLocation?.latitude ?: 0.0
                    val lon = aircraft3DLocation?.longitude ?: aircraftLocation?.longitude ?: 0.0
                    mapOf(
                        "latitude" to lat,
                        "longitude" to lon,
                        "altitude" to altitudeAsl  // ASL altitude (what PFD shows)
                    )
                },

                // Home location - use ASL for home position
                "home_location" to run {
                    homeLocation?.let {
                        // Calculate ASL for home location (ground level)
                        mapOf(
                            "latitude" to it.latitude,
                            "longitude" to it.longitude,
                            "altitude" to takeoffASL  // Home altitude in ASL
                        )
                    } ?: mapOf("latitude" to 0.0, "longitude" to 0.0, "altitude" to 0.0)
                },
                
                // Calculate distance to home
                "distance_to_home" to run {
                    if (aircraftLocation != null && homeLocation != null) {
                        // Simple distance calculation (in meters)
                        val latDiff = aircraftLocation.latitude - homeLocation.latitude
                        val lonDiff = aircraftLocation.longitude - homeLocation.longitude
                        kotlin.math.sqrt(latDiff * latDiff + lonDiff * lonDiff) * 111320.0 // Rough conversion to meters
                    } else {
                        0.0
                    }
                },
                
                // Status flags (TODO: integrate with proper SDK keys)
                "are_motors_on" to areMotorsOn,
                "is_flying" to false,
                
                
                // Real attitude data from flight controller
                "attitude" to run {
                    try {
                        // Get attitude data using proper DJI SDK V5 keys
                        val attitudeKey = KeyTools.createKey(FlightControllerKey.KeyAircraftAttitude)
                        val attitude = keyManager.getValue(attitudeKey) as? Attitude
                        
                        attitude?.let {
                            mapOf(
                                "pitch" to it.pitch.toDouble(),
                                "roll" to it.roll.toDouble(), 
                                "yaw" to it.yaw.toDouble()
                            )
                        } ?: mapOf("pitch" to 0.0, "roll" to 0.0, "yaw" to 0.0)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to get attitude data: ${e.message}")
                        mapOf("pitch" to 0.0, "roll" to 0.0, "yaw" to 0.0)
                    }
                },
                
                // Real compass heading from magnetometer (distinct from attitude yaw)
                "compass_heading" to run {
                    try {
                        // Get true compass heading from magnetometer
                        val compassKey = KeyTools.createKey(FlightControllerKey.KeyCompassHeading)
                        val heading = keyManager.getValue(compassKey) as? Double
                        heading ?: 0.0
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to get compass heading: ${e.message}")
                        0.0
                    }
                },
                
                // GPS accuracy and satellite info
                "gps_info" to run {
                    try {
                        val gpsCountKey = KeyTools.createKey(FlightControllerKey.KeyGPSSignalLevel)
                        val gpsLevel = keyManager.getValue(gpsCountKey) as? Int ?: 0
                        
                        mapOf(
                            "satellite_count" to gpsLevel,
                            "signal_quality" to when {
                                gpsLevel >= 4 -> "EXCELLENT"
                                gpsLevel >= 3 -> "GOOD" 
                                gpsLevel >= 2 -> "FAIR"
                                else -> "POOR"
                            }
                        )
                    } catch (e: Exception) {
                        mapOf(
                            "satellite_count" to 0,
                            "signal_quality" to "NO_SIGNAL"
                        )
                    }
                },
                
                "velocity_vector" to velocity?.let {
                    mapOf(
                        "x" to it.x,
                        "y" to it.y,
                        "z" to it.z
                    )
                },

                // Obstacle avoidance using real data from PerceptionManager listeners (same as HSI widget)
                "obstacle_avoidance" to run {
                    try {
                        val sectors = mutableListOf<Map<String, Any>>()
                        var systemEnabled = false
                        var closestDistance = Double.MAX_VALUE
                        
                        // Extract raw distance arrays
                        val radarDistances = cachedRadarObstacleData?.horizontalObstacleDistance
                        val perceptionDistances = cachedPerceptionObstacleData?.horizontalObstacleDistance
                        
                        // Transform cached radar obstacle data to sectors format
                        cachedRadarObstacleData?.let { radarData ->
                            val radarSectors = transformObstacleDataToSectors(radarData, "radar")
                            sectors.addAll(radarSectors)
                            systemEnabled = true
                            
                            // Find closest obstacle from horizontal obstacle distance array  
                            radarData.horizontalObstacleDistance?.let { distances ->
                                val minDistance = distances.minOrNull()?.let { it / 1000.0 } // Convert mm to meters
                                if (minDistance != null && minDistance > 0 && minDistance < closestDistance) {
                                    closestDistance = minDistance
                                }
                            }
                        }
                        
                        // Transform cached perception obstacle data to sectors format
                        cachedPerceptionObstacleData?.let { perceptionData ->
                            val perceptionSectors = transformObstacleDataToSectors(perceptionData, "perception")
                            sectors.addAll(perceptionSectors)
                            systemEnabled = true
                            
                            // Find closest obstacle from horizontal obstacle distance array
                            perceptionData.horizontalObstacleDistance?.let { distances ->
                                val minDistance = distances.minOrNull()?.let { it / 1000.0 } // Convert mm to meters
                                if (minDistance != null && minDistance > 0 && minDistance < closestDistance) {
                                    closestDistance = minDistance
                                }
                            }
                        }
                        
                        // Determine system status based on closest obstacle
                        val systemStatus = when {
                            !systemEnabled -> "disabled"
                            sectors.isEmpty() -> "no_obstacles_detected"
                            closestDistance < 1.0 -> "critical" 
                            closestDistance < 3.0 -> "warning"
                            closestDistance < 5.0 -> "caution"
                            else -> "active"
                        }
                        
                        mapOf(
                            "enabled" to systemEnabled,
                            "sectors" to sectors,
                            "system_status" to systemStatus,
                            "closest_distance" to if (closestDistance < Double.MAX_VALUE) closestDistance else null,
                            "data_source" to "PerceptionManager_Listeners",
                            "radar_available" to (cachedRadarObstacleData != null),
                            "perception_available" to (cachedPerceptionObstacleData != null),
                            "radar_distances" to radarDistances?.toList(),
                            "perception_distances" to perceptionDistances?.toList()
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "Obstacle avoidance error: ${e.message}")
                        mapOf(
                            "enabled" to false,
                            "sectors" to emptyList<Map<String, Any>>(),
                            "system_status" to "error",
                            "error" to e.message
                        )
                    }
                },

                // Gimbal + optics snapshot for H20N (LEFT_OR_MAIN)
                "gimbals" to listOfNotNull(
                    collectGimbalSnapshot(ComponentIndexType.LEFT_OR_MAIN, keyManager),
                    collectGimbalSnapshot(ComponentIndexType.FPV, keyManager)
                ),
                "camera_optics" to collectCameraOpticsSnapshot(ComponentIndexType.LEFT_OR_MAIN, keyManager),
                "fpv_optics" to collectCameraOpticsSnapshot(ComponentIndexType.FPV, keyManager).takeIf { it.isNotEmpty() }
            ).also { map ->
                flyToBridgeModel.toTelemetryMap()?.let { map["fly_to_status"] = it }
                waypointBridgeModel.toTelemetryMap()?.let { map["waypoint_status"] = it }
                simulatorBridgeModel.toTelemetryMap()?.let { map["simulator"] = it }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to collect telemetry data: ${e.message}")
            mapOf(
                "error" to "Failed to collect telemetry: ${e.message}",
                "timestamp" to System.currentTimeMillis(),
                "debug_info" to "SDK integration error - check aircraft connection"
            )
        }
        return createMessage(MessageType.TELEMETRY_DATA, telemetryData, Priority.HIGH)
    }

    private fun createBatteryStatusMessage(): String {
        // Collect basic battery status - simplified for Phase 2A testing
        val batteryData = try {
            val keyManager = KeyManager.getInstance()
            
            // Try to get battery percentage (safer approach)
            val percentage = try {
                val percentageKey = KeyTools.createKey(BatteryKey.KeyChargeRemainingInPercent)
                keyManager.getValue(percentageKey) as? Int ?: 85 // Fallback to simulated value
            } catch (e: Exception) {
                85 // Simulated fallback
            }
            
            mapOf(
                // System info
                "timestamp" to System.currentTimeMillis(),
                "bridge_status" to "active",
                "data_collection_status" to "basic_sdk_integrated",
                
                // Battery data (mix of real and simulated)
                "percentage" to percentage,
                "voltage" to 14.8, // Simulated for now
                "temperature" to 25.5, // Simulated for now
                
                // Additional simulated data
                "remaining_mah" to 3200,
                "full_charge_capacity" to 3850,
                "current" to 1.2,
                "cell_voltages" to listOf(3.7, 3.7, 3.7, 3.7),
                
                // Status flags
                "is_being_charged" to false,
                "charge_remaining_time" to 0,
                "discharge_remaining_time" to 45,
                
                // Warning/connection info
                "warning_level" to "NONE",
                "connection_state" to "SDK_V5_PARTIAL",
                
                // Note for development
                "note" to "Phase 2A: Basic SDK integration - working on full battery key support"
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed to create battery data: ${e.message}")
            mapOf(
                "error" to "Failed to create battery data: ${e.message}",
                "timestamp" to System.currentTimeMillis(),
                "debug_info" to "Using simulated battery data for Phase 2A testing"
            )
        }
        return createMessage(MessageType.BATTERY_STATUS, batteryData, Priority.HIGH)
    }
    
    private fun getControllerData(): String {
        return createControllerDataMessage()
    }
    
    private fun broadcastToClients(message: String) {
        val disconnectedClients = ArrayList<String>()
        
        clients.forEach { (clientId, socket) ->
            try {
                if (!socket.isClosed) {
                    sendWebSocketTextFrame(socket, message)
                } else {
                    disconnectedClients.add(clientId)
                }
            } catch (e: IOException) {
                Log.w(TAG, "Failed to send data to client $clientId", e)
                disconnectedClients.add(clientId)
            }
        }
        
        // Remove disconnected clients
        disconnectedClients.forEach { clientId ->
            clients.remove(clientId)
            Log.d(TAG, "Removed disconnected client: $clientId")
        }
    }
    
    private fun sendWebSocketTextFrame(socket: Socket, message: String) {
        try {
            Log.d(TAG, "🔍 DEBUG sendWebSocketTextFrame: socket=${if (socket != null) "non-null" else "NULL"}, message=${if (message != null) "non-null (${message.length} chars)" else "NULL"}")
            if (socket == null) {
                Log.e(TAG, "❌ CRITICAL: socket is null in sendWebSocketTextFrame")
                return
            }
            if (message == null) {
                Log.e(TAG, "❌ CRITICAL: message is null in sendWebSocketTextFrame")
                return
            }
            Log.d(TAG, "🔍 DEBUG: About to convert message to bytes...")
            val messageBytes = message.toByteArray(StandardCharsets.UTF_8)
            Log.d(TAG, "🔍 DEBUG: Message converted to ${messageBytes.size} bytes, calling sendWebSocketFrame...")
            sendWebSocketFrame(socket, messageBytes, 0x81) // Text frame
            Log.d(TAG, "🔍 DEBUG: sendWebSocketFrame completed successfully")
        } catch (e: Exception) {
            Log.e(TAG, "❌ Exception in sendWebSocketTextFrame: ${e.message}", e)
            throw e
        }
    }
    
    private fun sendWebSocketBinaryFrame(socket: Socket, data: ByteArray) {
        sendWebSocketFrame(socket, data, 0x82) // Binary frame  
    }
    
    private fun sendWebSocketFrame(socket: Socket, payload: ByteArray, opcode: Int) {
        val output = socket.getOutputStream()
        val payloadLength = payload.size
        
        // Calculate frame header size based on payload length
        val headerSize = when {
            payloadLength < 126 -> 2
            payloadLength <= 65535 -> 4  // 2 + 2 bytes for extended length
            else -> 10 // 2 + 8 bytes for extended length
        }
        
        val frame = ByteArray(headerSize + payloadLength)
        var offset = 0
        
        // First byte: FIN=1 + opcode
        frame[offset++] = opcode.toByte()
        
        // Payload length encoding
        when {
            payloadLength < 126 -> {
                frame[offset++] = payloadLength.toByte()
            }
            payloadLength <= 65535 -> {
                frame[offset++] = 126.toByte()
                frame[offset++] = (payloadLength shr 8).toByte()  // High byte
                frame[offset++] = (payloadLength and 0xFF).toByte() // Low byte
            }
            else -> {
                frame[offset++] = 127.toByte()
                // 8-byte length (big-endian)
                for (i in 7 downTo 0) {
                    frame[offset++] = (payloadLength.toLong() shr (i * 8)).toByte()
                }
            }
        }
        
        // Copy payload
        System.arraycopy(payload, 0, frame, offset, payloadLength)
        
        try {
            output.write(frame)
            output.flush()
            Log.d(TAG, "Sent WebSocket frame: opcode=$opcode, payload=${payloadLength} bytes")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending WebSocket frame", e)
            throw e
        }
    }
    
    // ================== CAMERA AVAILABILITY DETECTION ==================
    
    /**
     * Detect if secondary camera (H20N/Gimbal) is available
     */
    private fun detectSecondaryCameraAvailability(): Boolean {
        return try {
            val cameraStreamManager = MediaDataCenter.getInstance().cameraStreamManager
            
            // Try to enable secondary camera stream briefly to test availability
            // Note: enableStream() returns Unit, so we rely on exception handling for detection
            cameraStreamManager.enableStream(secondaryCameraIndex, true)
            
            // If we get here without exception, camera is available
            // Immediately disable it - we were just testing availability
            cameraStreamManager.enableStream(secondaryCameraIndex, false)
            
            Log.i(TAG, "Secondary camera (${secondaryCameraIndex.name}) detected as available")
            true
            
        } catch (e: Exception) {
            Log.i(TAG, "Secondary camera (${secondaryCameraIndex.name}) not available: ${e.message}")
            false
        }
    }
    
    /**
     * Update camera availability status
     */
    private fun updateCameraAvailability() {
        val previousAvailability = isSecondaryCameraAvailable
        isSecondaryCameraAvailable = detectSecondaryCameraAvailability()
        
        if (previousAvailability != isSecondaryCameraAvailable) {
            Log.i(TAG, "Camera availability changed: secondary=${isSecondaryCameraAvailable}")
            
            // Broadcast camera status to clients
            val statusMessage = createMessage(
                MessageType.SYSTEM_STATUS,
                mapOf(
                    "camera_status" to mapOf(
                        "fpv_available" to true, // FPV is always available
                        "secondary_available" to isSecondaryCameraAvailable,
                        "secondary_camera_index" to secondaryCameraIndex.name
                    ),
                    "message" to "Camera availability updated"
                )
            )
            broadcastToClients(statusMessage)
        }
    }

    // ================== VIDEO STREAMING METHODS ==================
    
    /**
     * Start H.264 video streaming from DJI cameras to WebSocket clients
     * Supports dual camera streaming (FPV + Secondary) with backward compatibility
     */
    fun startVideoStreaming() {
        if (isVideoStreamingEnabled) {
            Log.w(TAG, "Video streaming is already enabled")
            return
        }
        
        try {
            // First, detect camera availability
            updateCameraAvailability()
            
            val cameraStreamManager = MediaDataCenter.getInstance().cameraStreamManager
            var successCount = 0
            
            // ================== START FPV CAMERA STREAM (Always Present) ==================
            Log.i(TAG, "Starting FPV video streaming from camera ${fpvCameraIndex.name}")

            try {
                // Add FPV stream listener
                cameraStreamManager.addReceiveStreamListener(fpvCameraIndex, fpvVideoStreamListener)

                // Enable FPV camera stream
                cameraStreamManager.enableStream(fpvCameraIndex, true)
                
                isFpvStreamEnabled = true
                fpvBytesStreamed = 0L
                fpvFramesStreamed = 0L
                successCount++
                
                Log.i(TAG, "FPV video streaming started successfully")
                
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start FPV video streaming, will retry", e)
                isFpvStreamEnabled = false

                // Retry FPV stream registration with the existing surface
                fpvSurface?.let { surface ->
                    Thread {
                        Thread.sleep(1000)  // Wait 1 second before retry
                        val screenWidth = activity?.resources?.displayMetrics?.widthPixels ?: 1920
                        val screenHeight = activity?.resources?.displayMetrics?.heightPixels ?: 1080
                        registerCameraStreamWithRetry(
                            componentIndex = ComponentIndexType.FPV,
                            surface = surface,
                            width = screenWidth,
                            height = screenHeight,
                            surfaceName = "FPV (retry from streaming)"
                        )
                    }.start()
                }
            }
            
            // ================== START SECONDARY CAMERA STREAM (Optional) ==================
            if (isSecondaryCameraAvailable) {
                Log.i(TAG, "Starting secondary video streaming from camera ${secondaryCameraIndex.name}")

                try {
                    // Add secondary stream listener
                    cameraStreamManager.addReceiveStreamListener(secondaryCameraIndex, secondaryVideoStreamListener)

                    // Enable secondary camera stream
                    cameraStreamManager.enableStream(secondaryCameraIndex, true)
                    
                    isSecondaryStreamEnabled = true
                    secondaryBytesStreamed = 0L
                    secondaryFramesStreamed = 0L
                    successCount++
                    
                    Log.i(TAG, "Secondary video streaming started successfully")
                    
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to start secondary video streaming, will retry", e)
                    isSecondaryStreamEnabled = false

                    // Retry secondary stream registration with the existing surface
                    secondarySurface?.let { surface ->
                        Thread {
                            Thread.sleep(1000)  // Wait 1 second before retry
                            val screenWidth = activity?.resources?.displayMetrics?.widthPixels ?: 1920
                            val screenHeight = activity?.resources?.displayMetrics?.heightPixels ?: 1080
                            registerCameraStreamWithRetry(
                                componentIndex = ComponentIndexType.LEFT_OR_MAIN,
                                surface = surface,
                                width = screenWidth,
                                height = screenHeight,
                                surfaceName = "H20N/Secondary (retry from streaming)"
                            )
                        }.start()
                    }

                    Log.w(TAG, "Continuing with FPV-only streaming while retrying secondary")
                }
            } else {
                Log.i(TAG, "Secondary camera not available - streaming FPV only")
            }
            
            // ================== UPDATE STREAMING STATUS ==================
            if (successCount > 0) {
                isVideoStreamingEnabled = true
                videoBytesStreamed = 0L
                videoFramesStreamed = 0L
                
                Log.i(TAG, "H.264 video streaming started: FPV=${isFpvStreamEnabled}, Secondary=${isSecondaryStreamEnabled}")
                
                // Broadcast comprehensive video stream status to clients
                val statusMessage = createMessage(
                    MessageType.SYSTEM_STATUS,
                    mapOf(
                        "video_streaming_enabled" to true,
                        "dual_camera_streaming" to mapOf(
                            "fpv_enabled" to isFpvStreamEnabled,
                            "fpv_camera_index" to fpvCameraIndex.name,
                            "secondary_enabled" to isSecondaryStreamEnabled,
                            "secondary_available" to isSecondaryCameraAvailable,
                            "secondary_camera_index" to secondaryCameraIndex.name,
                            "total_streams" to successCount
                        ),
                        // Legacy compatibility
                        "camera_index" to fpvCameraIndex.name,  // For backward compatibility
                        "message" to "H.264 dual camera streaming started (${successCount} streams active)"
                    )
                )
                broadcastToClients(statusMessage)
                
            } else {
                throw Exception("No camera streams could be started")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start video streaming", e)
            isVideoStreamingEnabled = false
            
            val errorMessage = createMessage(
                MessageType.ERROR,
                mapOf(
                    "error" to "Failed to start video streaming: ${e.message}",
                    "component" to "dual_video_stream"
                )
            )
            broadcastToClients(errorMessage)
        }
    }
    
    /**
     * Stop H.264 video streaming for both cameras
     */
    fun stopVideoStreaming() {
        if (!isVideoStreamingEnabled) {
            Log.w(TAG, "Video streaming is not enabled")
            return
        }
        
        try {
            Log.i(TAG, "Stopping H.264 dual camera video streaming")
            
            val cameraStreamManager = MediaDataCenter.getInstance().cameraStreamManager
            
            // ================== STOP FPV CAMERA STREAM ==================
            if (isFpvStreamEnabled) {
                try {
                    Log.i(TAG, "Stopping FPV video streaming")
                    
                    // Remove FPV stream listener
                    cameraStreamManager.removeReceiveStreamListener(fpvVideoStreamListener)

                    // Disable FPV camera stream
                    cameraStreamManager.enableStream(fpvCameraIndex, false)

                    Log.i(TAG, "FPV streaming stopped. Stats: ${fpvFramesStreamed} frames, ${fpvBytesStreamed / 1024 / 1024} MB")

                } catch (e: Exception) {
                    Log.e(TAG, "Error stopping FPV video streaming", e)
                }
                
                isFpvStreamEnabled = false
            }
            
            // ================== STOP SECONDARY CAMERA STREAM ==================
            if (isSecondaryStreamEnabled) {
                try {
                    Log.i(TAG, "Stopping secondary video streaming")
                    
                    // Remove secondary stream listener
                    cameraStreamManager.removeReceiveStreamListener(secondaryVideoStreamListener)

                    // Disable secondary camera stream
                    cameraStreamManager.enableStream(secondaryCameraIndex, false)

                    Log.i(TAG, "Secondary streaming stopped. Stats: ${secondaryFramesStreamed} frames, ${secondaryBytesStreamed / 1024 / 1024} MB")

                } catch (e: Exception) {
                    Log.e(TAG, "Error stopping secondary video streaming", e)
                }
                
                isSecondaryStreamEnabled = false
            }
            
            // ================== UPDATE STREAMING STATUS ==================
            isVideoStreamingEnabled = false
            
            val totalFrames = fpvFramesStreamed + secondaryFramesStreamed
            val totalBytes = fpvBytesStreamed + secondaryBytesStreamed
            
            Log.i(TAG, "H.264 dual camera streaming stopped. Total stats: ${totalFrames} frames, ${totalBytes / 1024 / 1024} MB")
            
            // Broadcast comprehensive video stream status to clients
            val statusMessage = createMessage(
                MessageType.SYSTEM_STATUS,
                mapOf(
                    "video_streaming_enabled" to false,
                    "dual_camera_streaming" to mapOf(
                        "fpv_enabled" to false,
                        "secondary_enabled" to false,
                        "fpv_stats" to mapOf(
                            "frames_streamed" to fpvFramesStreamed,
                            "bytes_streamed" to fpvBytesStreamed,
                            "mb_streamed" to (fpvBytesStreamed / 1024 / 1024)
                        ),
                        "secondary_stats" to mapOf(
                            "frames_streamed" to secondaryFramesStreamed,
                            "bytes_streamed" to secondaryBytesStreamed,
                            "mb_streamed" to (secondaryBytesStreamed / 1024 / 1024)
                        ),
                        "total_stats" to mapOf(
                            "frames_streamed" to totalFrames,
                            "bytes_streamed" to totalBytes,
                            "mb_streamed" to (totalBytes / 1024 / 1024)
                        )
                    ),
                    // Legacy compatibility
                    "frames_streamed" to totalFrames,
                    "bytes_streamed" to totalBytes,
                    "message" to "H.264 dual camera streaming stopped"
                )
            )
            broadcastToClients(statusMessage)
            
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping dual camera video streaming", e)
        }
    }
    
    /**
     * Broadcast H.264 video frame to all connected WebSocket clients
     */
    private fun broadcastVideoFrame(videoFrame: ByteArray, frameInfo: Map<String, Any>) {
        if (clients.isEmpty()) return
        
        val disconnectedClients = ArrayList<String>()
        
        clients.forEach { (clientId, socket) ->
            try {
                if (!socket.isClosed) {
                    // Send frame metadata as text message first
                    val metadataMessage = createMessage(MessageType.VIDEO_FRAME, frameInfo)
                    sendWebSocketTextFrame(socket, metadataMessage)
                    
                    // Send H.264 binary data as binary WebSocket frame
                    sendWebSocketBinaryFrame(socket, videoFrame)
                } else {
                    disconnectedClients.add(clientId)
                }
            } catch (e: IOException) {
                Log.w(TAG, "Failed to send video frame to client $clientId", e)
                disconnectedClients.add(clientId)
            }
        }
        
        // Remove disconnected clients
        disconnectedClients.forEach { clientId ->
            clients.remove(clientId)
            Log.d(TAG, "Removed disconnected video client: $clientId")
        }
    }
    
    /**
     * Get dual camera video streaming statistics
     */
    fun getVideoStreamingStats(): Map<String, Any> {
        val totalFrames = fpvFramesStreamed + secondaryFramesStreamed
        val totalBytes = fpvBytesStreamed + secondaryBytesStreamed
        
        return mapOf(
            "enabled" to isVideoStreamingEnabled,
            "dual_camera_streaming" to mapOf(
                "fpv_enabled" to isFpvStreamEnabled,
                "secondary_enabled" to isSecondaryStreamEnabled,
                "secondary_available" to isSecondaryCameraAvailable,
                "fpv_stats" to mapOf(
                    "frames_streamed" to fpvFramesStreamed,
                    "bytes_streamed" to fpvBytesStreamed,
                    "mb_streamed" to (fpvBytesStreamed / 1024 / 1024)
                ),
                "secondary_stats" to mapOf(
                    "frames_streamed" to secondaryFramesStreamed,
                    "bytes_streamed" to secondaryBytesStreamed,
                    "mb_streamed" to (secondaryBytesStreamed / 1024 / 1024)
                ),
                "total_stats" to mapOf(
                    "frames_streamed" to totalFrames,
                    "bytes_streamed" to totalBytes,
                    "mb_streamed" to (totalBytes / 1024 / 1024)
                )
            ),
            // Legacy compatibility
            "frames_streamed" to totalFrames,
            "bytes_streamed" to totalBytes,
            "mb_streamed" to (totalBytes / 1024 / 1024),
            "camera_index" to fpvCameraIndex.name,  // For backward compatibility
            "connected_clients" to clients.size
        )
    }
    
    /**
     * Transform ObstacleData to sectors format for HSI display
     */
    private fun transformObstacleDataToSectors(obstacleData: ObstacleData, source: String): List<Map<String, Any>> {
        val sectors = mutableListOf<Map<String, Any>>()
        
        try {
            obstacleData.horizontalObstacleDistance?.let { distances ->
                // Process each angle in the horizontal obstacle distance array
                distances.forEachIndexed { angleIndex, distanceInMm ->
                    val distanceInMeters = distanceInMm / 1000.0 // Convert mm to meters
                    if (distanceInMeters > 0) {
                        
                        // Determine warning level based on distance (same thresholds as HSI compass)
                        val warningLevel = when {
                            distanceInMeters < 1.0 -> "critical"
                            distanceInMeters < 3.0 -> "warning" 
                            distanceInMeters < 5.0 -> "caution"
                            else -> "none"
                        }
                        
                        // Only create sectors for obstacles that need warnings
                        if (warningLevel != "none") {
                            // Convert array index to angle (0-359 degrees)
                            val angle = angleIndex * (360.0 / distances.size)
                            
                            sectors.add(mapOf(
                                "angle" to angle,
                                "distance" to distanceInMeters,
                                "warning_level" to warningLevel,
                                "source" to source
                            ))
                            
                            Log.v(TAG, "$source obstacle: ${distanceInMeters}m at ${angle}°, level: $warningLevel")
                        }
                    }
                }
            }
            
        } catch (e: Exception) {
            Log.w(TAG, "Error transforming $source obstacle data: ${e.message}")
        }
        
        return sectors
    }
    
    /**
     * Setup obstacle data listeners (same pattern as HSI widget)
     */
    private fun setupObstacleDataListeners() {
        try {
            val perceptionManager = PerceptionManager.getInstance()
            
            // Register radar obstacle data listener
            perceptionManager.radarManager?.addObstacleDataListener(radarObstacleDataListener)
            perceptionManager.radarManager?.addRadarInformationListener(radarInformationListener)
            
            // Register perception obstacle data listener
            perceptionManager.addObstacleDataListener(perceptionObstacleDataListener)
            perceptionManager.addPerceptionInformationListener(perceptionInformationListener)
            
            Log.i(TAG, "Obstacle data listeners registered successfully")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register obstacle data listeners: ${e.message}")
        }
    }
    
    /**
     * Cleanup obstacle data listeners
     */
    private fun cleanupObstacleDataListeners() {
        try {
            val perceptionManager = PerceptionManager.getInstance()
            
            // Remove radar obstacle data listeners
            perceptionManager.radarManager?.removeObstacleDataListener(radarObstacleDataListener)
            perceptionManager.radarManager?.removeRadarInformationListener(radarInformationListener)
            
            // Remove perception obstacle data listeners
            perceptionManager.removeObstacleDataListener(perceptionObstacleDataListener)
            perceptionManager.removePerceptionInformationListener(perceptionInformationListener)
            
            Log.i(TAG, "Obstacle data listeners removed successfully")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove obstacle data listeners: ${e.message}")
        }
    }


    private fun warningSeverity(level: WarningLevel?): Int {
        return when (level) {
            WarningLevel.SERIOUS_WARNING -> 4
            WarningLevel.WARNING -> 3
            WarningLevel.CAUTION -> 2
            WarningLevel.NOTICE -> 1
            WarningLevel.NORMAL -> 0
            else -> 0
        }
    }

    private fun severityName(rank: Int): String = when {
        rank >= 4 -> "serious"
        rank >= 3 -> "warning"
        rank >= 2 -> "caution"
        rank >= 1 -> "notice"
        else -> "normal"
    }

}
