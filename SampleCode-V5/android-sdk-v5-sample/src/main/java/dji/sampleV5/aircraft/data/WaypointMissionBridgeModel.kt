package dji.sampleV5.aircraft.data

import android.util.Log
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.waypoint3.WaylineExecutingInfoListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionExecuteStateListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionManager
import dji.v5.manager.aircraft.waypoint3.model.WaylineExecutingInfo
import dji.v5.manager.aircraft.waypoint3.model.WaypointMissionExecuteState
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Bridges waypoint mission state into telemetry so the desktop can visualise progress and
 * provide an abort/stop control.
 */
class WaypointMissionBridgeModel(
    private val missionExecutor: WaypointMissionExecutor
) {

    private val missionManager by lazy { WaypointMissionManager.getInstance() }
    private val lastUpdate = AtomicLong(0L)
    private val latestState = AtomicReference<WaypointMissionExecuteState?>(null)
    private val latestExecutingInfo = AtomicReference<WaylineExecutingInfo?>(null)
    private val lastInterrupt = AtomicReference<IDJIError?>(null)
    private val lastStateName = AtomicReference<String?>(null)
    private val lastWaypointKey = AtomicReference<String?>(null)
    private val timelineLock = Any()
    private val timeline = ArrayDeque<Map<String, Any?>>()

    private val stateListener = WaypointMissionExecuteStateListener { state ->
        val now = System.currentTimeMillis()
        latestState.set(state)
        lastUpdate.set(now)

        val stateName = state.name.lowercase(Locale.ROOT)
        val previousState = lastStateName.getAndSet(stateName)
        if (previousState != stateName) {
            recordTimelineEntry(
                mapOf(
                    "type" to "state",
                    "state" to stateName,
                    "timestamp" to now
                )
            )
        }

        if (state == WaypointMissionExecuteState.FINISHED ||
            state == WaypointMissionExecuteState.READY ||
            state == WaypointMissionExecuteState.NOT_SUPPORTED ||
            state == WaypointMissionExecuteState.IDLE
        ) {
            missionExecutor.clearActiveMission()
        }
    }

    private val executingInfoListener = object : WaylineExecutingInfoListener {
        override fun onWaylineExecutingInfoUpdate(info: WaylineExecutingInfo) {
            val now = System.currentTimeMillis()
            latestExecutingInfo.set(info)
            lastUpdate.set(now)

            val waylineId = runCatching { info.waylineID }.getOrNull()
            val waypointIndex = runCatching { info.currentWaypointIndex }.getOrNull()
            val missionId = runCatching { info.missionFileName }.getOrNull()
            val key = "${missionId ?: "unknown"}:${waylineId ?: -1}:${waypointIndex ?: -1}"
            val previousKey = lastWaypointKey.getAndSet(key)
            if (previousKey != key) {
                recordTimelineEntry(
                    mapOf(
                        "type" to "executing",
                        "timestamp" to now,
                        "mission_id" to missionId,
                        "wayline_id" to waylineId,
                        "current_waypoint_index" to waypointIndex,
                        "raw" to info.toString()
                    )
                )
            }
        }

        override fun onWaylineExecutingInterruptReasonUpdate(error: IDJIError?) {
            if (error != null) {
                val now = System.currentTimeMillis()
                lastInterrupt.set(error)
                lastUpdate.set(now)
                recordTimelineEntry(
                    mapOf(
                        "type" to "interrupt",
                        "timestamp" to now,
                        "error" to serializeError(error)
                    )
                )
            }
        }
    }

    fun start() {
        runCatching { missionManager.addWaypointMissionExecuteStateListener(stateListener) }
            .onFailure { Log.w(TAG, "Unable to register waypoint state listener: ${it.message}") }
        runCatching { missionManager.addWaylineExecutingInfoListener(executingInfoListener) }
            .onFailure { Log.w(TAG, "Unable to register waypoint executing listener: ${it.message}") }
    }

    fun stop() {
        runCatching { missionManager.removeWaypointMissionExecuteStateListener(stateListener) }
        runCatching { missionManager.removeWaylineExecutingInfoListener(executingInfoListener) }
    }

    fun toTelemetryMap(): Map<String, Any?>? {
        val state = latestState.get()
        val info = latestExecutingInfo.get()
        val interrupt = lastInterrupt.get()

        if (state == null && info == null && interrupt == null) {
            return null
        }

        val map = mutableMapOf<String, Any?>()
        val timestamp = lastUpdate.get()
        if (timestamp != 0L) {
            map["timestamp"] = timestamp
        }
        state?.let { map["state"] = it.name.lowercase(Locale.ROOT) }
        info?.let { map["executing"] = serializeExecutingInfo(it) }
        interrupt?.let { map["last_interrupt"] = serializeError(it) }
        missionExecutor.currentMissionSnapshot()?.let { map.putAll(it) }
        if (!map.containsKey("backend")) {
            map["backend"] = missionExecutor.backendId()
        }
        synchronized(timelineLock) {
            if (timeline.isNotEmpty()) {
                map["timeline"] = timeline.toList()
            }
        }
        return map
    }

    private fun serializeExecutingInfo(info: WaylineExecutingInfo): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        runCatching { info.waylineID }.onSuccess { map["wayline_id"] = it }
        runCatching { info.currentWaypointIndex }.onSuccess { map["current_waypoint_index"] = it }
        runCatching { info.missionFileName }.onSuccess { map["mission_id"] = it }
        return map
    }

    private fun serializeError(error: IDJIError): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        map["code"] = error.errorCode()?.toString()
        map["description"] = error.description()
        return map
    }

    private fun recordTimelineEntry(entry: Map<String, Any?>) {
        synchronized(timelineLock) {
            timeline.addLast(entry)
            while (timeline.size > MAX_TIMELINE_ENTRIES) {
                timeline.removeFirst()
            }
        }
    }

    companion object {
        private const val TAG = "WaypointMissionBridge"
        private const val MAX_TIMELINE_ENTRIES = 50
    }
}
