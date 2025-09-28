package dji.sampleV5.aircraft.data

import android.util.Log
import dji.v5.manager.aircraft.simulator.SimulatorManager
import dji.v5.manager.aircraft.simulator.SimulatorState
import dji.v5.manager.aircraft.simulator.SimulatorStatusListener
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Lightweight bridge wrapper around the DJI simulator APIs. Keeps a cached copy of the
 * simulator state so telemetry + command acknowledgements can report whether we are in
 * simulator mode, what configuration was requested, and the latest attitude/location.
 */
class SimulatorBridgeModel {

    data class SimulatorCommandConfig(
        val latitude: Double?,
        val longitude: Double?,
        val altitude: Double?,
        val satellites: Int?,
        val frequencyHz: Int?,
        val source: String?,
        val timestamp: Long
    )

    private val simulatorManager by lazy { SimulatorManager.getInstance() }
    @Volatile private var lastState: SimulatorState? = null
    private val lastUpdate = AtomicLong(0L)
    private val listenerRegistered = AtomicBoolean(false)
    private val lastError = AtomicReference<Map<String, Any?>?>(null)
    private val lastConfig = AtomicReference<SimulatorCommandConfig?>(null)

    private val statusListener = SimulatorStatusListener { state ->
        lastState = state
        lastUpdate.set(System.currentTimeMillis())
    }

    fun start() {
        if (!listenerRegistered.compareAndSet(false, true)) {
            return
        }
        runCatching {
            simulatorManager.addSimulatorStateListener(statusListener)
            Log.i(TAG, "Simulator state listener registered")
        }.onFailure { error ->
            listenerRegistered.set(false)
            Log.w(TAG, "Unable to register simulator listener: ${error.message}")
        }
    }

    fun stop() {
        if (!listenerRegistered.compareAndSet(true, false)) {
            return
        }
        runCatching {
            simulatorManager.removeSimulatorStateListener(statusListener)
            Log.i(TAG, "Simulator state listener removed")
        }.onFailure { error ->
            Log.w(TAG, "Unable to remove simulator listener: ${error.message}")
        }
    }

    fun isEnabled(): Boolean = runCatching { simulatorManager.isSimulatorEnabled }.getOrDefault(false)

    fun recordCommandConfig(
        latitude: Double?,
        longitude: Double?,
        altitude: Double?,
        satellites: Int?,
        frequencyHz: Int?,
        source: String?
    ) {
        val config = SimulatorCommandConfig(
            latitude = sanitizeDouble(latitude),
            longitude = sanitizeDouble(longitude),
            altitude = sanitizeDouble(altitude),
            satellites = satellites?.takeIf { it > 0 },
            frequencyHz = frequencyHz?.takeIf { it > 0 },
            source = source?.takeUnless { it.isBlank() },
            timestamp = System.currentTimeMillis()
        )
        lastConfig.set(config)
    }

    fun recordError(error: Map<String, Any?>?) {
        lastError.set(error)
    }

    fun clearError() {
        lastError.set(null)
    }

    fun toTelemetryMap(): Map<String, Any?>? {
        val enabled = isEnabled()
        val state = lastState
        val timestamp = lastUpdate.get().takeIf { it != 0L }
        val config = lastConfig.get()
        val error = lastError.get()

        if (!enabled && state == null && config == null && error == null && timestamp == null) {
            return null
        }

        val map = mutableMapOf<String, Any?>()
        map["mode"] = if (enabled) "simulator" else "real"
        map["enabled"] = enabled
        timestamp?.let { map["timestamp"] = it }
        if (listenerRegistered.get()) {
            map["listener_registered"] = true
        }
        state?.let { map.putAll(serializeState(it)) }
        config?.let { map["configuration"] = serializeConfig(it) }
        error?.let { map["last_error"] = it }
        return map
    }

    fun statusSnapshot(): Map<String, Any?> {
        return toTelemetryMap() ?: mapOf(
            "mode" to if (isEnabled()) "simulator" else "real",
            "enabled" to isEnabled(),
            "listener_registered" to listenerRegistered.get()
        )
    }

    private fun serializeConfig(config: SimulatorCommandConfig): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        config.latitude?.let { map["latitude"] = it }
        config.longitude?.let { map["longitude"] = it }
        config.altitude?.let { map["altitude"] = it }
        config.satellites?.let { map["satellites"] = it }
        config.frequencyHz?.let { map["frequency_hz"] = it }
        config.source?.let { map["source"] = it }
        map["timestamp"] = config.timestamp
        return map
    }

    private fun serializeState(state: SimulatorState): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        runCatching { state.areMotorsOn() }.getOrNull()?.let { map["motors_on"] = it }
        runCatching { state.isFlying }.getOrNull()?.let { map["flying"] = it }

        val attitude = mutableMapOf<String, Any?>()
        runCatching { state.roll }.getOrNull()?.let { value ->
            sanitizeNumber(value)?.let { attitude["roll"] = it }
        }
        runCatching { state.pitch }.getOrNull()?.let { value ->
            sanitizeNumber(value)?.let { attitude["pitch"] = it }
        }
        runCatching { state.yaw }.getOrNull()?.let { value ->
            sanitizeNumber(value)?.let { attitude["yaw"] = it }
        }
        if (attitude.isNotEmpty()) {
            map["attitude"] = attitude
        }

        val position = mutableMapOf<String, Any?>()
        runCatching { state.positionX }.getOrNull()?.let { value ->
            sanitizeNumber(value)?.let { position["x"] = it }
        }
        runCatching { state.positionY }.getOrNull()?.let { value ->
            sanitizeNumber(value)?.let { position["y"] = it }
        }
        runCatching { state.positionZ }.getOrNull()?.let { value ->
            sanitizeNumber(value)?.let { position["z"] = it }
        }
        if (position.isNotEmpty()) {
            map["position"] = position
        }

        runCatching { state.location }.getOrNull()?.let { location ->
            val locMap = mutableMapOf<String, Any?>()
            sanitizeDouble(location.latitude)?.let { locMap["latitude"] = it }
            sanitizeDouble(location.longitude)?.let { locMap["longitude"] = it }
            sanitizeNumber(runCatching { state.positionZ }.getOrNull())?.let { locMap["altitude"] = it }
            if (locMap.isNotEmpty()) {
                map["location"] = locMap
            }
        }

        return map
    }

    private fun sanitizeDouble(value: Double?): Double? {
        if (value == null) return null
        return if (value.isNaN() || value.isInfinite()) null else value
    }

    private fun sanitizeNumber(value: Number?): Double? {
        if (value == null) return null
        val doubleValue = value.toDouble()
        return if (doubleValue.isNaN() || doubleValue.isInfinite()) null else doubleValue
    }

    companion object {
        private const val TAG = "SimulatorBridge"
    }
}
