package dji.sampleV5.aircraft.data

import android.util.Log
import dji.sampleV5.aircraft.models.VirtualStickVM
import dji.v5.utils.common.LogUtils
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
            
        } catch (e: IOException) {
            Log.e(TAG, "Failed to start server on port $port", e)
            throw e
        }
    }
    
    fun stop() {
        if (!isRunning) return
        
        isRunning = false
        
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
        // TODO: Implement system configuration, restart, etc.
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
                    Log.d(TAG, "Streaming data to ${clients.size} clients: ${controllerData.length} bytes")
                    broadcastToClients(controllerData)
                } else {
                    Log.d(TAG, "No clients connected - not streaming data")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error streaming controller data", e)
            }
        }, 100, 50, TimeUnit.MILLISECONDS)
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
        // TODO: Collect flight telemetry
        val telemetryData = mapOf(
            "altitude" to 0.0,
            "speed" to 0.0,
            "distance_to_home" to 0.0,
            "flight_mode" to "UNKNOWN",
            "gps_satellite_count" to 0,
            "gps_signal_quality" to "NONE"
        )
        return createMessage(MessageType.TELEMETRY_DATA, telemetryData)
    }
    
    private fun createBatteryStatusMessage(): String {
        // TODO: Collect battery status
        val batteryData = mapOf(
            "percentage" to 0,
            "voltage" to 0.0,
            "current" to 0.0,
            "temperature" to 0.0,
            "cell_voltages" to emptyList<Double>()
        )
        return createMessage(MessageType.BATTERY_STATUS, batteryData)
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
}