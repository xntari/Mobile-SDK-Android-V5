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

    fun toJson(): JSONObject {
        val json = JSONObject()
        latestWarning?.let { warning ->
        val warningJson = JSONObject()
        warningJson.put("event", warning.event)
        warningJson.put("description", warning.description)
        warningJson.put("height_limit", warning.heightLimit)
        json.put("warning_notification", warningJson)
        }

        if (surroundingFlyZones.isNotEmpty()) {
            val zonesArray = JSONArray()
            surroundingFlyZones.forEach { zone ->
                val zoneJson = JSONObject()
                zoneJson.put("id", zone.flyZoneID)
                zoneJson.put("name", zone.name)
                zoneJson.put("category", zone.category?.name)
                zoneJson.put("type", zone.flyZoneType?.name)
                zoneJson.put("shape", zone.shape?.name)
                zoneJson.put("lower_limit", zone.lowerLimit)
                zoneJson.put("upper_limit", zone.upperLimit)
                zoneJson.put("center_latitude", zone.circleCenter?.latitude)
                zoneJson.put("center_longitude", zone.circleCenter?.longitude)
                zonesArray.put(zoneJson)
            }
            json.put("surrounding_zones", zonesArray)
        }
        return json
    }

    companion object {
        private const val TAG = "FlySafeBridgeModel"
    }
}
