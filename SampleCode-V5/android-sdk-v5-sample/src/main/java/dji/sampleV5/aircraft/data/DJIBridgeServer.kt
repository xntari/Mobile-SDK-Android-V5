package dji.sampleV5.aircraft.data

import android.util.Log
import dji.sampleV5.aircraft.models.VirtualStickVM
import dji.v5.utils.common.LogUtils
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.BatteryKey
import dji.sdk.keyvalue.key.KeyTools
import dji.v5.manager.KeyManager
import dji.v5.manager.datacenter.MediaDataCenter
import dji.v5.manager.interfaces.ICameraStreamManager
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.sdk.keyvalue.value.common.Velocity3D
import dji.sdk.keyvalue.value.common.ComponentIndexType
import dji.sdk.keyvalue.value.common.Attitude
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
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.collections.ArrayList

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
    
    // Video streaming
    private var isVideoStreamingEnabled = false
    private var videoBytesStreamed = 0L
    private var videoFramesStreamed = 0L
    private val cameraIndex = ComponentIndexType.FPV // Primary camera - using FPV as default
    
    // Obstacle avoidance data (cached from listeners for telemetry collection)
    @Volatile
    private var cachedRadarObstacleData: ObstacleData? = null
    @Volatile
    private var cachedPerceptionObstacleData: ObstacleData? = null
    @Volatile
    private var cachedRadarInformation: RadarInformation? = null
    @Volatile
    private var cachedPerceptionInformation: PerceptionInfo? = null
    
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
    
    // H.264 video stream listener - streams raw video data to WebSocket clients
    private val videoStreamListener = ICameraStreamManager.ReceiveStreamListener { data, offset, length, info ->
        if (!isVideoStreamingEnabled || clients.isEmpty()) {
            return@ReceiveStreamListener
        }
        
        try {
            // Extract H.264 frame data
            val videoFrame = data.sliceArray(offset until offset + length)
            
            // Create video frame message with metadata
            val videoFrameInfo = mapOf(
                "frameNumber" to videoFramesStreamed,
                "timestamp" to System.currentTimeMillis(),
                "frameSize" to length,
                "mimeType" to (info.mimeType?.name ?: "H264"),
                "width" to (info.width ?: 1920),
                "height" to (info.height ?: 1080),
                "frameRate" to 30 // TODO: Get actual frame rate
            )
            
            // Broadcast H.264 frame to all connected clients
            broadcastVideoFrame(videoFrame, videoFrameInfo)
            
            // Update statistics
            videoBytesStreamed += length
            videoFramesStreamed++
            
            // Log video streaming progress
            if (videoFramesStreamed % 30 == 0L) { // Log every 30 frames (1 second at 30fps)
                Log.d(TAG, "Video streaming: ${videoFramesStreamed} frames, ${videoBytesStreamed / 1024 / 1024} MB streamed")
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Error processing video frame", e)
        }
    }
    
    fun start() {
        if (isRunning) {
            Log.w(TAG, "Server is already running")
            return
        }
        
        try {
            serverSocket = ServerSocket(port)
            isRunning = true
            
            Log.i(TAG, "DJI Bridge WebSocket server started on port $port")
            
            // Start accepting client connections
            executor.submit { acceptConnections() }
            
            // Start streaming controller data
            startControllerDataStreaming()
            
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
        
        // Stop video streaming
        stopVideoStreaming()
        
        // Remove obstacle data listeners
        cleanupObstacleDataListeners()
        
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
            Log.d(TAG, "Received command from $clientId: $message")
            val json = JSONObject(message)
            val messageType = MessageType.fromString(json.getString("type"))
            
            when (messageType) {
                MessageType.JOYSTICK_OVERRIDE -> handleJoystickOverride(clientId, json)
                MessageType.WAYPOINT_COMMAND -> handleWaypointCommand(clientId, json)
                MessageType.CAMERA_COMMAND -> handleCameraCommand(clientId, json)
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
    
    private fun handleFlightCommand(clientId: String, command: JSONObject) {
        Log.i(TAG, "Flight command from $clientId: $command")
        // TODO: Implement flight mode changes, RTH, etc.
    }
    
    private fun handleSystemCommand(clientId: String, command: JSONObject) {
        Log.i(TAG, "System command from $clientId: $command")
        
        try {
            val action = command.optString("action", "")
            
            when (action) {
                "start_video_streaming" -> {
                    Log.i(TAG, "Starting video streaming via system command")
                    startVideoStreaming()
                }
                "stop_video_streaming" -> {
                    Log.i(TAG, "Stopping video streaming via system command")
                    stopVideoStreaming()
                }
                "get_video_stats" -> {
                    Log.i(TAG, "Getting video streaming stats")
                    val stats = getVideoStreamingStats()
                    val response = createMessage(MessageType.SYSTEM_STATUS, stats)
                    clients[clientId]?.let { socket -> sendWebSocketTextFrame(socket, response) }
                }
                else -> {
                    Log.w(TAG, "Unknown system command action: $action")
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
    
    private fun startControllerDataStreaming() {
        // Stream controller data every 50ms (20Hz) to connected clients
        executor.scheduleAtFixedRate({
            try {
                if (clients.isNotEmpty()) {
                    val controllerData = getControllerData()
                    Log.d(TAG, "Streaming controller data to ${clients.size} clients: ${controllerData.length} bytes")
                    broadcastToClients(controllerData)
                } else {
                    Log.d(TAG, "No clients connected - not streaming controller data")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error streaming controller data", e)
            }
        }, 100, 50, TimeUnit.MILLISECONDS)
        
        // Stream telemetry data every 200ms (5Hz) to connected clients
        executor.scheduleAtFixedRate({
            try {
                if (clients.isNotEmpty()) {
                    val telemetryData = createTelemetryDataMessage()
                    Log.d(TAG, "Streaming telemetry to ${clients.size} clients: ${telemetryData.length} bytes")
                    broadcastToClients(telemetryData)
                } else {
                    Log.d(TAG, "No clients connected - not streaming telemetry")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error streaming telemetry data", e)
            }
        }, 200, 200, TimeUnit.MILLISECONDS)
        
        // Stream battery data every 1000ms (1Hz) to connected clients
        executor.scheduleAtFixedRate({
            try {
                if (clients.isNotEmpty()) {
                    val batteryData = createBatteryStatusMessage()
                    Log.d(TAG, "Streaming battery status to ${clients.size} clients: ${batteryData.length} bytes")
                    broadcastToClients(batteryData)
                } else {
                    Log.d(TAG, "No clients connected - not streaming battery data")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error streaming battery data", e)
            }
        }, 500, 1000, TimeUnit.MILLISECONDS)
    }
    
    // Message creation utilities with proper JSON serialization
    private fun createMessage(type: MessageType, data: Any, priority: Priority = Priority.NORMAL): String {
        val message = JSONObject().apply {
            put("type", type.value)
            put("version", PROTOCOL_VERSION)
            put("timestamp", System.currentTimeMillis())
            put("priority", priority.name.lowercase())
            
            when (data) {
                is Map<*, *> -> {
                    data.forEach { (key, value) ->
                        put(key.toString(), convertToJsonValue(value))
                    }
                }
                is JSONObject -> {
                    // Copy all fields from the JSONObject
                    data.keys().forEach { key ->
                        put(key, data.get(key))
                    }
                }
                else -> put("data", data)
            }
        }
        return message.toString()
    }
    
    private fun convertToJsonValue(value: Any?): Any? {
        return when (value) {
            is Map<*, *> -> {
                JSONObject().apply {
                    value.forEach { (k, v) ->
                        put(k.toString(), convertToJsonValue(v))
                    }
                }
            }
            is List<*> -> {
                JSONArray().apply {
                    value.forEach { item ->
                        put(convertToJsonValue(item))
                    }
                }
            }
            is Array<*> -> {
                JSONArray().apply {
                    value.forEach { item ->
                        put(convertToJsonValue(item))
                    }
                }
            }
            else -> value // Primitive types, strings, etc.
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
            "virtual_stick_enabled" to false
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
            
            // Get altitude data
            val altitudeKey = KeyTools.createKey(FlightControllerKey.KeyAltitude)
            val altitude = keyManager.getValue(altitudeKey) as? Double ?: 0.0
            
            // Get aircraft location
            val aircraftLocationKey = KeyTools.createKey(FlightControllerKey.KeyAircraftLocation)
            val aircraftLocation = keyManager.getValue(aircraftLocationKey) as? LocationCoordinate2D
            
            // Get home location
            val homeLocationKey = KeyTools.createKey(FlightControllerKey.KeyHomeLocation)
            val homeLocation = keyManager.getValue(homeLocationKey) as? LocationCoordinate2D
            
            // Get aircraft velocity
            val velocityKey = KeyTools.createKey(FlightControllerKey.KeyAircraftVelocity)
            val velocity = keyManager.getValue(velocityKey) as? Velocity3D
            
            // Calculate ground speed (horizontal velocity)
            val groundSpeed = velocity?.let { 
                kotlin.math.sqrt(it.x * it.x + it.y * it.y).toDouble()
            } ?: 0.0
            
            mapOf(
                // System info
                "timestamp" to System.currentTimeMillis(),
                "bridge_status" to "active",
                "data_collection_status" to "sdk_integrated",
                
                // Real flight data
                "altitude" to altitude,
                "ground_speed" to groundSpeed,
                "vertical_speed" to (velocity?.z?.toDouble() ?: 0.0),
                "flight_mode" to "CONNECTED", // TODO: Get actual flight mode
                
                // Location data
                "location" to run {
                    aircraftLocation?.let {
                        mapOf(
                            "latitude" to it.latitude,
                            "longitude" to it.longitude,
                            "altitude" to altitude
                        )
                    } ?: mapOf("latitude" to 0.0, "longitude" to 0.0, "altitude" to altitude)
                },
                
                // Home location
                "home_location" to run {
                    homeLocation?.let {
                        mapOf(
                            "latitude" to it.latitude,
                            "longitude" to it.longitude
                        )
                    } ?: mapOf("latitude" to 0.0, "longitude" to 0.0)
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
                "are_motors_on" to false,
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
                
                // Obstacle avoidance using real data from PerceptionManager listeners (same as HSI widget)
                "obstacle_avoidance" to run {
                    try {
                        val sectors = mutableListOf<Map<String, Any>>()
                        var systemEnabled = false
                        var closestDistance = Double.MAX_VALUE
                        
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
                            "perception_available" to (cachedPerceptionObstacleData != null)
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
                
                // Note for development
                "note" to "Phase 4C: Real-time obstacle avoidance integrated using PerceptionManager listeners"
            )
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
        sendWebSocketFrame(socket, message.toByteArray(StandardCharsets.UTF_8), 0x81) // Text frame
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
    
    // ================== VIDEO STREAMING METHODS ==================
    
    /**
     * Start H.264 video streaming from DJI camera to WebSocket clients
     */
    fun startVideoStreaming() {
        if (isVideoStreamingEnabled) {
            Log.w(TAG, "Video streaming is already enabled")
            return
        }
        
        try {
            Log.i(TAG, "Starting H.264 video streaming from camera $cameraIndex")
            
            // Add stream listener to receive H.264 frames
            MediaDataCenter.getInstance().cameraStreamManager.addReceiveStreamListener(cameraIndex, videoStreamListener)
            
            // Enable camera stream
            MediaDataCenter.getInstance().cameraStreamManager.enableStream(cameraIndex, true)
            
            isVideoStreamingEnabled = true
            videoBytesStreamed = 0L
            videoFramesStreamed = 0L
            
            Log.i(TAG, "H.264 video streaming started successfully")
            
            // Broadcast video stream status to clients
            val statusMessage = createMessage(
                MessageType.SYSTEM_STATUS,
                mapOf(
                    "video_streaming_enabled" to true,
                    "camera_index" to cameraIndex.name,
                    "message" to "H.264 video streaming started"
                )
            )
            broadcastToClients(statusMessage)
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start video streaming", e)
            isVideoStreamingEnabled = false
            
            val errorMessage = createMessage(
                MessageType.ERROR,
                mapOf(
                    "error" to "Failed to start video streaming: ${e.message}",
                    "component" to "video_stream"
                )
            )
            broadcastToClients(errorMessage)
        }
    }
    
    /**
     * Stop H.264 video streaming
     */
    fun stopVideoStreaming() {
        if (!isVideoStreamingEnabled) {
            Log.w(TAG, "Video streaming is not enabled")
            return
        }
        
        try {
            Log.i(TAG, "Stopping H.264 video streaming")
            
            // Remove stream listener
            MediaDataCenter.getInstance().cameraStreamManager.removeReceiveStreamListener(videoStreamListener)
            
            // Disable camera stream
            MediaDataCenter.getInstance().cameraStreamManager.enableStream(cameraIndex, false)
            
            isVideoStreamingEnabled = false
            
            Log.i(TAG, "H.264 video streaming stopped. Stats: ${videoFramesStreamed} frames, ${videoBytesStreamed / 1024 / 1024} MB total")
            
            // Broadcast video stream status to clients
            val statusMessage = createMessage(
                MessageType.SYSTEM_STATUS,
                mapOf(
                    "video_streaming_enabled" to false,
                    "frames_streamed" to videoFramesStreamed,
                    "bytes_streamed" to videoBytesStreamed,
                    "message" to "H.264 video streaming stopped"
                )
            )
            broadcastToClients(statusMessage)
            
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping video streaming", e)
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
     * Get video streaming statistics
     */
    fun getVideoStreamingStats(): Map<String, Any> {
        return mapOf(
            "enabled" to isVideoStreamingEnabled,
            "frames_streamed" to videoFramesStreamed,
            "bytes_streamed" to videoBytesStreamed,
            "mb_streamed" to (videoBytesStreamed / 1024 / 1024),
            "camera_index" to cameraIndex.name,
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
}