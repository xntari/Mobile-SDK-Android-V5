package dji.sampleV5.aircraft.data

import android.util.Log
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.waypoint3.WaylineExecutingInfoListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionExecuteStateListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionManager
import dji.v5.manager.aircraft.waypoint3.model.WaylineExecutingInfo
import dji.v5.manager.aircraft.waypoint3.model.WaypointMissionExecuteState
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

    private val stateListener = WaypointMissionExecuteStateListener { state ->
        latestState.set(state)
        lastUpdate.set(System.currentTimeMillis())

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
            latestExecutingInfo.set(info)
            lastUpdate.set(System.currentTimeMillis())
        }

        override fun onWaylineExecutingInterruptReasonUpdate(error: IDJIError?) {
            if (error != null) {
                lastInterrupt.set(error)
                lastUpdate.set(System.currentTimeMillis())
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

    companion object {
        private const val TAG = "WaypointMissionBridge"
    }
}
