package dji.sampleV5.aircraft.data

import android.util.Log
import dji.v5.manager.diagnostic.DJIDeviceHealthInfo
import dji.v5.manager.diagnostic.DJIDeviceStatus
import dji.v5.manager.diagnostic.DeviceHealthManager
import dji.v5.manager.diagnostic.DeviceStatusManager
import dji.v5.manager.diagnostic.WarningLevel

private const val DIAGNOSTIC_TAG = "DiagnosticAggregator"

class DiagnosticAggregator(
    private val flySafeSnapshotProvider: (() -> Map<String, Any?>?)? = null,
) {

    fun collectForFlightAction(action: String): Map<String, Any?>? {
        val health = collectHealthInfos()
        val status = collectDeviceStatus()
        val flySafe = flySafeSnapshotProvider?.invoke()
        if (health.isEmpty() && status == null && flySafe == null) {
            return null
        }
        return buildMap {
            put("source", "flight_command")
            put("action", action)
            if (health.isNotEmpty()) {
                put("diagnostics", health)
            }
            status?.let { put("device_status", it) }
            flySafe?.let { put("fly_safe", it) }
        }
    }

    fun buildPreflightSnapshot(): Map<String, Any?> {
        val health = collectHealthInfos()
        val status = collectDeviceStatus()
        val flySafe = flySafeSnapshotProvider?.invoke()
        return buildMap {
            put("timestamp", System.currentTimeMillis())
            status?.let { put("device_status", it) }
            put("diagnostics", health)
            flySafe?.let { put("fly_safe", it) }
        }
    }

    private fun collectHealthInfos(): List<Map<String, Any?>> {
        return try {
            val infos = DeviceHealthManager.getInstance().currentDJIDeviceHealthInfos ?: emptyList()
            infos.mapNotNull { info ->
                info?.let { mapHealthInfo(it) }
            }
        } catch (t: Throwable) {
            Log.w(DIAGNOSTIC_TAG, "Failed to read device health info: ${t.message}", t)
            emptyList()
        }
    }

    private fun collectDeviceStatus(): Map<String, Any?>? {
        return try {
            DeviceStatusManager.getInstance().currentDJIDeviceStatus?.let { mapDeviceStatus(it) }
        } catch (t: Throwable) {
            Log.w(DIAGNOSTIC_TAG, "Failed to read device status: ${t.message}", t)
            null
        }
    }

    private fun mapHealthInfo(info: DJIDeviceHealthInfo): Map<String, Any?> {
        return mapOf(
            "code" to info.informationCode(),
            "warning_level" to info.warningLevel()?.asLabel(),
            "title" to info.title(),
            "description" to info.description(),
            "component_id" to info.componentId(),
            "sensor_index" to info.sensorIndex()
        )
    }

    private fun mapDeviceStatus(status: DJIDeviceStatus): Map<String, Any?> {
        return mapOf(
            "code" to status.statusCode(),
            "label" to status.toString(),
            "description" to status.description(),
            "level" to status.warningLevel()?.asLabel()
        )
    }

    private fun WarningLevel?.asLabel(): String? = this?.name?.lowercase()
}
