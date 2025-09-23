package dji.sampleV5.aircraft.data

import android.util.Log
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class TelemetryStreamer(
    private val scheduler: ScheduledExecutorService,
    private val tag: String,
    private val hasClients: () -> Boolean,
    private val controllerSupplier: () -> String,
    private val telemetrySupplier: () -> String,
    private val batterySupplier: () -> String,
    private val broadcast: (String) -> Unit
) {

    private var controllerFuture: ScheduledFuture<*>? = null
    private var telemetryFuture: ScheduledFuture<*>? = null
    private var batteryFuture: ScheduledFuture<*>? = null

    fun start() {
        stop()

        controllerFuture = scheduler.scheduleAtFixedRate({
            try {
                if (hasClients()) {
                    val payload = controllerSupplier()
                    Log.d(tag, "Streaming controller data: ${payload.length} bytes")
                    broadcast(payload)
                } else {
                    Log.d(tag, "No clients connected - not streaming controller data")
                }
            } catch (t: Throwable) {
                Log.e(tag, "Error streaming controller data", t)
            }
        }, 100, 50, TimeUnit.MILLISECONDS)

        telemetryFuture = scheduler.scheduleAtFixedRate({
            try {
                if (hasClients()) {
                    val payload = telemetrySupplier()
                    Log.d(tag, "Streaming telemetry data: ${payload.length} bytes")
                    broadcast(payload)
                } else {
                    Log.d(tag, "No clients connected - not streaming telemetry")
                }
            } catch (t: Throwable) {
                Log.e(tag, "Error streaming telemetry data", t)
            }
        }, 200, 200, TimeUnit.MILLISECONDS)

        batteryFuture = scheduler.scheduleAtFixedRate({
            try {
                if (hasClients()) {
                    val payload = batterySupplier()
                    Log.d(tag, "Streaming battery status: ${payload.length} bytes")
                    broadcast(payload)
                } else {
                    Log.d(tag, "No clients connected - not streaming battery data")
                }
            } catch (t: Throwable) {
                Log.e(tag, "Error streaming battery data", t)
            }
        }, 500, 1000, TimeUnit.MILLISECONDS)
    }

    fun stop() {
        controllerFuture?.cancel(true)
        telemetryFuture?.cancel(true)
        batteryFuture?.cancel(true)
        controllerFuture = null
        telemetryFuture = null
        batteryFuture = null
    }
}
