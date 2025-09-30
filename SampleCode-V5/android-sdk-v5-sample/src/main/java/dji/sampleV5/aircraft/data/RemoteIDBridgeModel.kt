package dji.sampleV5.aircraft.data

import android.util.Log
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.v5.manager.aircraft.uas.AreaStrategy
import dji.v5.manager.aircraft.uas.OperatorRegistrationNumberStatus
import dji.v5.manager.aircraft.uas.OperatorRegistrationNumberStatusListener
import dji.v5.manager.aircraft.uas.UASRemoteIDManager
import dji.v5.manager.aircraft.uas.UASRemoteIDStatus
import dji.v5.manager.aircraft.uas.UASRemoteIDStatusListener
import dji.v5.utils.common.JsonUtil
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

class RemoteIDBridgeModel {

    private val manager: UASRemoteIDManager = UASRemoteIDManager.getInstance()

    private val currentStrategy = AtomicReference(AreaStrategy.US_STRATEGY)
    private val latestStatus = AtomicReference<UASRemoteIDStatus?>(null)
    private val latestOperatorStatus = AtomicReference<OperatorRegistrationNumberStatus?>(null)
    private val latestOperatorNumber = AtomicReference<String?>(null)
    private val lastErrorMessage = AtomicReference<String?>(null)

    private val statusListener = UASRemoteIDStatusListener { status ->
        latestStatus.set(status)
    }

    private val operatorStatusListener = OperatorRegistrationNumberStatusListener { status ->
        latestOperatorStatus.set(status)
    }

    fun start() {
        runCatching {
            manager.setUASRemoteIDAreaStrategy(currentStrategy.get())
        }.onFailure { throwable ->
            Log.w(TAG, "Failed to set initial Remote ID strategy: ${throwable.message}")
            lastErrorMessage.set(throwable.message)
        }

        runCatching { manager.addUASRemoteIDStatusListener(statusListener) }
            .onFailure { Log.w(TAG, "Unable to register Remote ID status listener: ${it.message}") }

        runCatching { manager.addOperatorRegistrationNumberStatusListener(operatorStatusListener) }
            .onFailure { Log.w(TAG, "Unable to register operator registration listener: ${it.message}") }

        refreshOperatorRegistrationNumber(null)
    }

    fun stop() {
        runCatching { manager.clearUASRemoteIDStatusListener() }
        runCatching { manager.clearAllOperatorRegistrationNumberStatusListener() }
    }

    fun setAreaStrategy(
        strategyName: String,
        callback: (IDJIError?) -> Unit
    ) {
        val strategy = resolveAreaStrategy(strategyName)
        val error = manager.setUASRemoteIDAreaStrategy(strategy)
        if (error == null) {
            currentStrategy.set(strategy)
            lastErrorMessage.set(null)
        } else {
            lastErrorMessage.set(error.description())
        }
        callback(error)
    }

    fun setOperatorRegistrationNumber(
        registration: String,
        callback: (IDJIError?) -> Unit
    ) {
        manager.setOperatorRegistrationNumber(registration, object : CommonCallbacks.CompletionCallback {
            override fun onSuccess() {
                latestOperatorNumber.set(registration)
                lastErrorMessage.set(null)
                callback(null)
            }

            override fun onFailure(error: IDJIError) {
                lastErrorMessage.set(error.description())
                callback(error)
            }
        })
    }

    fun refreshOperatorRegistrationNumber(callback: ((IDJIError?) -> Unit)?) {
        manager.getOperatorRegistrationNumber(object : CommonCallbacks.CompletionCallbackWithParam<String> {
            override fun onSuccess(result: String) {
                latestOperatorNumber.set(result)
                lastErrorMessage.set(null)
                callback?.invoke(null)
            }

            override fun onFailure(error: IDJIError) {
                lastErrorMessage.set(error.description())
                callback?.invoke(error)
            }
        })
    }

    fun toSnapshotMap(): Map<String, Any?>? {
        val map = mutableMapOf<String, Any?>()
        map["area_strategy"] = currentStrategy.get().name

        latestOperatorNumber.get()?.let { number ->
            if (number.isNotBlank()) {
                map["operator_registration_number"] = number
            }
        }

        latestOperatorStatus.get()?.let { status ->
            jsonToMap(JsonUtil.toJson(status))?.let { map["operator_status"] = it }
        }

        latestStatus.get()?.let { status ->
            jsonToMap(JsonUtil.toJson(status))?.let { map["status"] = it }
        }

        lastErrorMessage.get()?.let { error ->
            map["last_error"] = error
        }

        return if (map.isEmpty()) null else map
    }

    private fun resolveAreaStrategy(name: String): AreaStrategy {
        val normalized = name.trim().uppercase(Locale.ROOT)
        return AreaStrategy.values().firstOrNull { it.name.equals(normalized, ignoreCase = true) }
            ?: currentStrategy.get()
    }

    private fun jsonToMap(json: String?): Map<String, Any?>? {
        if (json.isNullOrBlank()) return null
        return runCatching {
            val obj = JSONObject(json)
            obj.toMap()
        }.getOrNull()
    }

    private fun JSONObject.toMap(): Map<String, Any?> {
        val result = mutableMapOf<String, Any?>()
        val iterator = keys()
        while (iterator.hasNext()) {
            val key = iterator.next()
            val value = when (val raw = opt(key)) {
                is JSONObject -> raw.toMap()
                is JSONArray -> raw.toList()
                JSONObject.NULL -> null
                else -> raw
            }
            result[key] = value
        }
        return result
    }

    private fun JSONArray.toList(): List<Any?> {
        val list = mutableListOf<Any?>()
        for (index in 0 until length()) {
            val item = opt(index)
            val value = when (item) {
                is JSONObject -> item.toMap()
                is JSONArray -> item.toList()
                JSONObject.NULL -> null
                else -> item
            }
            list.add(value)
        }
        return list
    }

    companion object {
        private const val TAG = "RemoteIDBridgeModel"
    }
}
