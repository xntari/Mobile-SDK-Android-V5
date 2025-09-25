package dji.sampleV5.aircraft.models

import android.util.Log
import dji.sdk.keyvalue.value.common.LocationCoordinate2D
import dji.v5.common.callback.CommonCallbacks
import dji.v5.manager.aircraft.flysafe.FlyZoneManager
import dji.v5.manager.aircraft.flysafe.info.FlySafeWarningInformation
import dji.v5.manager.aircraft.flysafe.info.FlyZoneInformation
import org.json.JSONArray
import org.json.JSONObject

class FlySafeBridgeModel {

    data class FlySafeWarningSnapshot(
        val event: String?,
        val description: String?,
        val heightLimit: Double?,
    )

    private var latestWarning: FlySafeWarningSnapshot? = null
    private var surroundingFlyZones: List<FlyZoneInformation> = emptyList()

    private val flySafeListener = object : dji.v5.manager.aircraft.flysafe.FlySafeNotificationListener {
        override fun onWarningNotificationUpdate(info: FlySafeWarningInformation) {
            latestWarning = FlySafeWarningSnapshot(
                event = info.event?.name,
                description = info.description,
                heightLimit = info.heightLimit?.toDouble(),
            )
        }

        override fun onSeriousWarningNotificationUpdate(info: dji.v5.manager.aircraft.flysafe.info.FlySafeSeriousWarningInformation) {
            latestWarning = FlySafeWarningSnapshot(
                event = info.event?.name,
                description = info.description,
                heightLimit = info.heightLimit?.toDouble(),
            )
        }

        override fun onReturnToHomeNotificationUpdate(info: dji.v5.manager.aircraft.flysafe.info.FlySafeReturnToHomeInformation) {
            // no-op
        }

        override fun onTipNotificationUpdate(info: dji.v5.manager.aircraft.flysafe.info.FlySafeTipInformation) {
            latestWarning = FlySafeWarningSnapshot(
                event = info.event?.name,
                description = info.description,
                heightLimit = info.heightLimit?.toDouble(),
            )
        }

        override fun onSurroundingFlyZonesUpdate(infos: MutableList<FlyZoneInformation>) {
            surroundingFlyZones = infos
        }
    }

    fun start() {
        try {
            FlyZoneManager.getInstance().addFlySafeNotificationListener(flySafeListener)
        } catch (e: Exception) {
            Log.w(TAG, "Unable to register fly-safe listener: ${e.message}")
        }
    }

    fun stop() {
        try {
            FlyZoneManager.getInstance().removeFlySafeNotificationListener(flySafeListener)
        } catch (_: Exception) {}
    }

    fun pullSurroundingZones(homeLocation: LocationCoordinate2D?) {
        if (homeLocation == null) return
        FlyZoneManager.getInstance().getFlyZonesInSurroundingArea(
            homeLocation,
            object : CommonCallbacks.CompletionCallbackWithParam<MutableList<FlyZoneInformation>> {
                override fun onSuccess(result: MutableList<FlyZoneInformation>?) {
                    surroundingFlyZones = result ?: emptyList()
                }

                override fun onFailure(error: dji.v5.common.error.IDJIError) {
                    Log.w(TAG, "getFlyZonesInSurroundingArea failed: ${error.description()}")
                }
            },
        )
    }

    fun toSnapshotMap(): Map<String, Any?>? {
        val data = mutableMapOf<String, Any?>()
        latestWarning?.let { warning ->
            data["warning_notification"] = mapOf(
                "event" to warning.event,
                "description" to warning.description,
                "height_limit" to warning.heightLimit,
            )
        }
        if (surroundingFlyZones.isNotEmpty()) {
            data["surrounding_zones"] = surroundingFlyZones.map { zone ->
                mapOf(
                    "id" to zone.flyZoneID,
                    "name" to zone.name,
                    "category" to zone.category?.name,
                    "type" to zone.flyZoneType?.name,
                    "shape" to zone.shape?.name,
                    "lower_limit" to zone.lowerLimit,
                    "upper_limit" to zone.upperLimit,
                    "center_latitude" to zone.circleCenter?.latitude,
                    "center_longitude" to zone.circleCenter?.longitude,
                )
            }
        }
        return if (data.isEmpty()) null else data
    }

    fun toJson(): JSONObject {
        val json = JSONObject()
        val snapshot = toSnapshotMap() ?: return json
        snapshot.forEach { (key, value) ->
            when (value) {
                is List<*> -> {
                    val array = JSONArray()
                    value.forEach { item ->
                        when (item) {
                            is Map<*, *> -> {
                                val obj = JSONObject()
                                item.forEach { (k, v) -> obj.put(k.toString(), v) }
                                array.put(obj)
                            }
                            null -> array.put(JSONObject.NULL)
                            else -> array.put(item)
                        }
                    }
                    json.put(key, array)
                }
                is Map<*, *> -> {
                    val obj = JSONObject()
                    value.forEach { (k, v) -> obj.put(k.toString(), v) }
                    json.put(key, obj)
                }
                null -> json.put(key, JSONObject.NULL)
                else -> json.put(key, value)
            }
        }
        return json
    }

    companion object {
        private const val TAG = "FlySafeBridgeModel"
    }
}
