package dji.sampleV5.aircraft.data

import android.util.Log
import dji.sdk.keyvalue.value.common.DoubleMinMax
import dji.sdk.keyvalue.value.common.LocationCoordinate3D
import dji.sdk.keyvalue.value.flightcontroller.FlyToMode
import dji.v5.manager.intelligent.IMissionCapabilityListener
import dji.v5.manager.intelligent.IMissionInfoListener
import dji.v5.manager.intelligent.IntelligentFlightManager
import dji.v5.manager.intelligent.flyto.FlyToCapability
import dji.v5.manager.intelligent.flyto.FlyToInfo
import dji.v5.manager.intelligent.flyto.FlyToTarget
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Captures Fly-To mission state and capability information for telemetry streaming.
 */
class FlyToMissionBridgeModel {

    private val flyToManager by lazy { IntelligentFlightManager.getInstance().flyToMissionManager }

    @Volatile private var latestInfo: FlyToInfo? = null
    @Volatile private var latestTarget: FlyToTarget? = null
    @Volatile private var latestCapability: FlyToCapability? = null
    private val lastUpdate = AtomicLong(0L)

    private val infoListener = object : IMissionInfoListener<FlyToInfo, FlyToTarget> {
        override fun onMissionInfoUpdate(info: FlyToInfo) {
            latestInfo = info
            lastUpdate.set(System.currentTimeMillis())
        }

        override fun onMissionTargetUpdate(target: FlyToTarget) {
            latestTarget = target
            lastUpdate.set(System.currentTimeMillis())
        }
    }

    private val capabilityListener = IMissionCapabilityListener<FlyToCapability> { capability ->
        latestCapability = capability
        lastUpdate.set(System.currentTimeMillis())
    }

    fun start() {
        try {
            flyToManager.addMissionInfoListener(infoListener)
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to register Fly-To mission info listener: ${t.message}")
        }
        try {
            flyToManager.addMissionCapabilityListener(capabilityListener)
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to register Fly-To mission capability listener: ${t.message}")
        }
    }

    fun stop() {
        try {
            flyToManager.removeMissionInfoListener(infoListener)
        } catch (_: Throwable) {
        }
        try {
            flyToManager.removeMissionCapabilityListener(capabilityListener)
        } catch (_: Throwable) {
        }
    }

    fun toTelemetryMap(): Map<String, Any?>? {
        val info = latestInfo
        val target = latestTarget
        val capability = latestCapability
        if (info == null && target == null && capability == null) {
            return null
        }

        val map = mutableMapOf<String, Any?>()
        val timestamp = lastUpdate.get()
        if (timestamp != 0L) {
            map["timestamp"] = timestamp
        }

        info?.let { map["info"] = serializeInfo(it) }
        target?.let { map["target"] = serializeTarget(it) }
        capability?.let { map["capability"] = serializeCapability(it) }

        return map
    }

    private fun serializeInfo(info: FlyToInfo): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        (call(info, "getFlyToMode") as? FlyToMode)?.let {
            map["mode"] = it.name.lowercase(Locale.ROOT)
        }
        (call(info, "getFlyToHeight") as? Number)?.let {
            map["height"] = it.toInt()
        }
        val running = call(info, "isMissionRunning") as? Boolean
        running?.let { map["is_running"] = it }
        (call(info, "getTargetLocation") as? LocationCoordinate3D)?.let {
            map["target_location"] = serializeLocation(it)
        }
        map["raw"] = info.toString()
        return map
    }

    private fun serializeTarget(target: FlyToTarget): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        (call(target, "getTargetLocation") as? LocationCoordinate3D)?.let {
            map["target_location"] = serializeLocation(it)
        }
        (call(target, "getMaxSpeed") as? Number)?.let {
            map["max_speed"] = it.toInt()
        }
        (call(target, "getSecurityTakeoffHeight") as? Number)?.let {
            map["security_takeoff_height"] = it.toInt()
        }
        map["raw"] = target.toString()
        return map
    }

    private fun serializeCapability(capability: FlyToCapability): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        (call(capability, "getSupportedFlyModes") as? List<*>)?.let { modes ->
            map["supported_modes"] = modes.mapNotNull { mode ->
                (mode as? FlyToMode)?.name?.lowercase(Locale.ROOT)
            }
        }
        (call(capability, "getHeightRange") as? DoubleMinMax)?.let { range ->
            val min = (call(range, "getMin") as? Number)?.toDouble()
            val max = (call(range, "getMax") as? Number)?.toDouble()
            map["height_range"] = mapOf(
                "min" to min,
                "max" to max
            )
        }
        map["raw"] = capability.toString()
        return map
    }

    private fun serializeLocation(location: LocationCoordinate3D): Map<String, Any?> = mapOf(
        "latitude" to location.latitude,
        "longitude" to location.longitude,
        "altitude" to location.altitude
    )

    private fun call(instance: Any, methodName: String): Any? {
        return runCatching {
            instance.javaClass.getMethod(methodName).invoke(instance)
        }.getOrNull()
    }

    companion object {
        private const val TAG = "FlyToMissionBridge"
    }
}
