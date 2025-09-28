package dji.sampleV5.aircraft.data

import android.util.Log
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.waypoint3.WaylineExecutingInfoListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionExecuteStateListener
import dji.v5.manager.aircraft.waypoint3.WaypointMissionManager
import dji.v5.manager.aircraft.waypoint3.model.BreakPointInfo
import dji.v5.manager.aircraft.waypoint3.model.WaylineExecutingInfo
import dji.v5.manager.aircraft.waypoint3.model.WaypointMissionExecuteState
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt

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
    private val lastBreakPointMission = AtomicReference<String?>(null)
    private val lastBreakPointTimestamp = AtomicLong(0L)
    private val breakPointQueryActive = AtomicBoolean(false)
    private val lastPauseReason = AtomicReference<String?>(null)
    private val lastResumeReason = AtomicReference<String?>(null)

    private val stateListener = WaypointMissionExecuteStateListener { state ->
        val now = System.currentTimeMillis()
        Log.d(TAG, "Waypoint state update: ${state.name}")
        latestState.set(state)
        lastUpdate.set(now)

        val stateName = state.name.lowercase(Locale.ROOT)
        val previousState = lastStateName.getAndSet(stateName)
        if (previousState != stateName) {
            recordTimelineEntry(
                mapOf(
                    "type" to "state",
                    "state" to stateName,
                    "timestamp" to now,
                    "label" to stateLabel(stateName)
                )
            )
        }

        if (state == WaypointMissionExecuteState.INTERRUPTED || state == WaypointMissionExecuteState.RECOVERING) {
            maybeQueryBreakPointInfo("state:${state.name}")
        }

        if (state == WaypointMissionExecuteState.FINISHED ||
            state == WaypointMissionExecuteState.READY ||
            state == WaypointMissionExecuteState.NOT_SUPPORTED ||
            state == WaypointMissionExecuteState.IDLE
        ) {
            missionExecutor.clearActiveMission()
            lastBreakPointMission.set(null)
            breakPointQueryActive.set(false)
            lastPauseReason.set(null)
            lastResumeReason.set(null)
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
        val executeStateName = resolveExecuteState(info)
        val pauseReason = resolvePauseReason(info)
        val resumeReason = resolveResumeReason(info)
        val exitReasonHint = resolveExitReason(info)

        Log.d(
            TAG,
            "Waypoint executing update: mission=${missionId ?: "?"} wayline=${waylineId ?: "?"} index=${waypointIndex ?: "?"} state=${executeStateName ?: "unknown"} pause=${pauseReason ?: "none"} resume=${resumeReason ?: "none"} exit=${exitReasonHint ?: "none"}"
        )

        val key = "${missionId ?: "unknown"}:${waylineId ?: -1}:${waypointIndex ?: -1}:${executeStateName ?: "unknown"}"
        val previousKey = lastWaypointKey.get()
        if (previousKey != key) {
            val entry = mutableMapOf<String, Any?>(
                "type" to "executing",
                "timestamp" to now,
                "mission_id" to missionId,
                "wayline_id" to waylineId,
                "current_waypoint_index" to waypointIndex,
                "raw" to info.toString(),
                "label" to executingLabel(waylineId, waypointIndex, executeStateName)
            )
            executeStateName?.let { entry["execute_state"] = it }
            pauseReason?.let { entry["pause_reason"] = it }
            resumeReason?.let { entry["resume_reason"] = it }
            exitReasonHint?.let { entry["exit_reason"] = it }
            recordTimelineEntry(entry)
            lastWaypointKey.set(key)
        }

        if (!pauseReason.isNullOrBlank() && pauseReason != lastPauseReason.get()) {
            lastPauseReason.set(pauseReason)
            lastResumeReason.set(null)
            recordTimelineEntry(
                mapOf(
                    "type" to "event",
                    "timestamp" to now,
                    "event" to "pause",
                    "mission_id" to missionId,
                    "wayline_id" to waylineId,
                    "current_waypoint_index" to waypointIndex,
                    "reason" to pauseReason,
                    "label" to "Mission paused: ${pauseReason.replace('_', ' ').replaceFirstChar { ch -> if (ch.isLowerCase()) ch.titlecase(Locale.ROOT) else ch.toString() }}"
                )
            )
            maybeQueryBreakPointInfo("pause:$pauseReason")
        }

        if (!resumeReason.isNullOrBlank() && resumeReason != lastResumeReason.get()) {
            lastResumeReason.set(resumeReason)
            lastPauseReason.set(null)
            recordTimelineEntry(
                mapOf(
                    "type" to "event",
                    "timestamp" to now,
                    "event" to "resume",
                    "mission_id" to missionId,
                    "wayline_id" to waylineId,
                    "current_waypoint_index" to waypointIndex,
                    "reason" to resumeReason,
                    "label" to "Mission resumed: ${resumeReason.replace('_', ' ').replaceFirstChar { ch -> if (ch.isLowerCase()) ch.titlecase(Locale.ROOT) else ch.toString() }}"
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
                        "error" to serializeError(error),
                        "label" to interruptLabel(error)
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
        resolveExecuteState(info)?.let { map["execute_state"] = it }
        resolvePauseReason(info)?.let { map["pause_reason"] = it }
        resolveResumeReason(info)?.let { map["resume_reason"] = it }
        resolveExitReason(info)?.let { map["exit_reason"] = it }
        return map
    }

    private fun serializeError(error: IDJIError): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        map["code"] = error.errorCode()?.toString()
        map["description"] = error.description()
        return map
    }

    private fun maybeQueryBreakPointInfo(trigger: String) {
        val missionName = missionExecutor.currentMissionId()
            ?: runCatching { latestExecutingInfo.get()?.missionFileName }.getOrNull()
            ?: return

        val now = System.currentTimeMillis()
        val previousMission = lastBreakPointMission.get()
        val lastTs = lastBreakPointTimestamp.get()
        if (previousMission == missionName && now - lastTs < 1000L) {
            return
        }
        if (!breakPointQueryActive.compareAndSet(false, true)) {
            return
        }

        lastBreakPointMission.set(missionName)
        lastBreakPointTimestamp.set(now)

        missionExecutor.dispatchToUi {
            missionManager.queryBreakPointInfoFromAircraft(missionName, object : CommonCallbacks.CompletionCallbackWithParam<BreakPointInfo> {
                override fun onSuccess(breakPointInfo: BreakPointInfo?) {
                    breakPointQueryActive.set(false)
                    if (breakPointInfo == null) {
                        return
                    }
                    val timestamp = System.currentTimeMillis()
                    val entry = mutableMapOf<String, Any?>(
                        "type" to "breakpoint",
                        "timestamp" to timestamp,
                        "mission_id" to missionName,
                        "label" to breakPointLabel(breakPointInfo)
                    )
                    breakPointInfo.waylineID?.let { entry["wayline_id"] = it }
                    breakPointInfo.waypointID?.let { entry["waypoint_id"] = it }
                    breakPointInfo.segmentProgress?.let { entry["segment_progress"] = it }
                    breakPointInfo.recoverActionType?.let { entry["recover_action"] = it.name.lowercase(Locale.ROOT) }
                    breakPointInfo.location?.let { location ->
                        entry["location"] = mapOf(
                            "latitude" to location.latitude,
                            "longitude" to location.longitude,
                            "altitude" to location.altitude
                        )
                    }
                    entry["source"] = trigger
                    recordTimelineEntry(entry)
                }

                override fun onFailure(error: IDJIError) {
                    breakPointQueryActive.set(false)
                    val timestamp = System.currentTimeMillis()
                    recordTimelineEntry(
                        mapOf(
                            "type" to "breakpoint_error",
                            "timestamp" to timestamp,
                            "mission_id" to missionName,
                            "error" to serializeError(error),
                            "source" to trigger,
                            "label" to "Break point query failed: ${error.errorCode()?.toString() ?: "unknown"}"
                        )
                    )
                }
            })
        }
    }

    private fun recordTimelineEntry(entry: Map<String, Any?>) {
        synchronized(timelineLock) {
            timeline.addLast(entry)
            while (timeline.size > MAX_TIMELINE_ENTRIES) {
                timeline.removeFirst()
            }
        }
    }

    private fun stateLabel(stateName: String): String = when (stateName.lowercase(Locale.ROOT)) {
        "uploading" -> "Uploading mission"
        "ready" -> "Ready"
        "prepare" -> "Preparing"
        "preparing" -> "Preparing"
        "executing" -> "Executing"
        "enter_wayline" -> "Entering wayline"
        "exit_wayline" -> "Exiting wayline"
        "finish" -> "Finished"
        "finished" -> "Finished"
        "paused" -> "Paused"
        "resume" -> "Resumed"
        else -> stateName.replace('_', ' ').replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.ROOT) else it.toString() }
    }

    private fun executingLabel(waylineId: Int?, waypointIndex: Int?, executeState: String?): String = buildString {
        append("Waypoint ")
        append(if (waypointIndex != null && waypointIndex >= 0) "#${waypointIndex}" else "progress")
        if (waylineId != null && waylineId >= 0) {
            append(" (Wayline $waylineId)")
        }
        executeState?.let {
            append(" · ")
            append(it.replace('_', ' ').replaceFirstChar { ch -> if (ch.isLowerCase()) ch.titlecase(Locale.ROOT) else ch.toString() })
        }
    }

    private fun resolveExecuteState(info: WaylineExecutingInfo): String? {
        val reflected = runCatching {
            val method = info.javaClass.methods.firstOrNull { method ->
                method.name == "getExecuteState" && method.parameterCount == 0
            }
            val raw = method?.invoke(info) ?: return null
            raw.toString().lowercase(Locale.ROOT)
        }.getOrElse {
            if (!methodsLogged) {
                methodsLogged = true
                val methodNames = info.javaClass.methods.joinToString { it.name }
                Log.w(TAG, "Waypoint executeState unavailable; methods: $methodNames")
            }
            null
        }
        if (reflected != null) {
            return reflected
        }
        return extractInfoField(info, "executeState", "execute_state", "state")?.lowercase(Locale.ROOT)
    }

    private fun resolvePauseReason(info: WaylineExecutingInfo): String? =
        extractInfoField(info, "pauseReason", "pause_reason", "pause")?.lowercase(Locale.ROOT)

    private fun resolveResumeReason(info: WaylineExecutingInfo): String? =
        extractInfoField(info, "resumeReason", "resume_reason", "resume")?.lowercase(Locale.ROOT)

    private fun resolveExitReason(info: WaylineExecutingInfo): String? =
        extractInfoField(info, "exitReason", "exit_reason")?.lowercase(Locale.ROOT)

    private fun breakPointLabel(info: BreakPointInfo): String {
        val waypointId = info.waypointID
        val progress = info.segmentProgress
        val percent = progress?.let {
            val clamped = when {
                it < 0.0 -> 0.0
                it > 1.0 -> 1.0
                else -> it
            }
            (clamped * 100.0).roundToInt()
        }
        val builder = StringBuilder("Break point")
        waypointId?.let {
            builder.append(" · Waypoint #").append(it)
        }
        percent?.let {
            builder.append(" · Progress ").append(it).append('%')
        }
        info.recoverActionType?.let {
            builder.append(" · Action ")
                .append(it.name.lowercase(Locale.ROOT).replace('_', ' '))
        }
        return builder.toString()
    }

    private fun extractInfoField(info: WaylineExecutingInfo, vararg keys: String): String? {
        val raw = runCatching { info.toString() }.getOrNull() ?: return null
        for (key in keys) {
            val regex = Regex("(?i)${Regex.escape(key)}\\s*=\\s*([^,}]+)")
            val match = regex.find(raw)
            if (match != null) {
                return match.groupValues[1]
                    .trim()
                    .trim('"', '\'')
            }
        }
        return null
    }

    private fun interruptLabel(error: IDJIError): String {
        val description = error.description()
        val code = error.errorCode()?.toString()
        return when {
            !description.isNullOrBlank() && !code.isNullOrBlank() -> "$description ($code)"
            !description.isNullOrBlank() -> description
            !code.isNullOrBlank() -> "Interrupt $code"
            else -> "Interrupt"
        }
    }

    companion object {
        private const val TAG = "WaypointMissionBridge"
        private const val MAX_TIMELINE_ENTRIES = 50
        private var methodsLogged = false
    }
}
