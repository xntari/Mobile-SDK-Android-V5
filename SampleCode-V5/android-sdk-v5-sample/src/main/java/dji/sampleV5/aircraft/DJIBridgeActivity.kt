package dji.sampleV5.aircraft

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.TextView
import dji.sampleV5.aircraft.data.DJIBridgeServer
import dji.sampleV5.aircraft.models.VirtualStickVM
import dji.v5.utils.common.LogUtils
import dji.v5.manager.SDKManager
import dji.v5.common.callback.CommonCallbacks
import dji.v5.common.error.IDJIError
import dji.sdk.keyvalue.key.RemoteControllerKey
import dji.v5.et.create
import dji.v5.et.listen

/**
 * DJI Android Bridge Activity - Phase 1 Implementation
 * 
 * Headless Android bridge that streams DJI controller readings via WebSocket
 * Connects laptop to DJI controller for external drone control
 * 
 * Phase 1 Features:
 * - WebSocket server on port 8080
 * - Real-time joystick data streaming
 * - DJI SDK V5 Virtual Stick integration
 * - JSON protocol for controller data
 */
class DJIBridgeActivity : Activity() {
    
    companion object {
        private const val TAG = "DJIBridge"
        private const val WEBSOCKET_PORT = 8080
    }
    
    private lateinit var virtualStickVM: VirtualStickVM
    private lateinit var bridgeServer: DJIBridgeServer
    private var statusText: TextView? = null
    private var isSDKRegistered = false
    
    // Direct RC stick monitoring (same as main activity) - Thread-safe
    @Volatile private var leftH = 0   // Yaw
    @Volatile private var leftV = 0   // Throttle
    @Volatile private var rightH = 0  // Roll
    @Volatile private var rightV = 0  // Pitch
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Minimal headless UI - just status text
        statusText = TextView(this).apply {
            text = "DJI Bridge Starting..."
            textSize = 16f
            setPadding(20, 20, 20, 20)
        }
        setContentView(statusText)
        
        // Keep screen on during bridge operation
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        
        Log.i(TAG, "DJI Android Bridge Activity starting...")
        updateStatus("Initializing DJI SDK...")
        
        initializeDJISDK()
    }
    
    private fun initializeDJISDK() {
        try {
            // Check if SDK is already registered (should be via DJIApplication)
            if (SDKManager.getInstance().isRegistered) {
                Log.i(TAG, "SDK already registered via DJIApplication")
                isSDKRegistered = true
                updateStatus("SDK already registered\nStarting bridge...")
                initializeDJIBridge()
            } else {
                Log.w(TAG, "SDK not registered, waiting for DJIApplication to complete registration...")
                updateStatus("Waiting for SDK registration...")
                // Don't re-initialize, just wait and check periodically
                waitForSDKRegistration()
            }
            
        } catch (e: Exception) {
            val errorMsg = "Failed to initialize DJI SDK: ${e.message}"
            Log.e(TAG, errorMsg, e)
            updateStatus("ERROR: $errorMsg")
        }
    }
    
    private fun waitForSDKRegistration() {
        // Check every 500ms if SDK becomes registered
        val handler = android.os.Handler(mainLooper)
        val checkRegistration = object : Runnable {
            override fun run() {
                if (SDKManager.getInstance().isRegistered) {
                    Log.i(TAG, "SDK registration detected")
                    isSDKRegistered = true
                    updateStatus("SDK registered\nStarting bridge...")
                    initializeDJIBridge()
                } else {
                    // Check again in 500ms, max 20 seconds
                    handler.postDelayed(this, 500)
                }
            }
        }
        handler.post(checkRegistration)
        
        // Timeout after 20 seconds
        handler.postDelayed({
            if (!isSDKRegistered) {
                updateStatus("SDK registration timeout\nTrying to start bridge anyway...")
                initializeDJIBridge()
            }
        }, 20000)
    }
    
    private fun initializeDJIBridge() {
        try {
            // Initialize Virtual Stick for compatibility (but don't rely on it)
            virtualStickVM = VirtualStickVM()
            
            updateStatus("Starting direct RC stick monitoring...")
            
            // Start DIRECT RC stick monitoring (same as main activity)
            startDirectRCStickMonitoring()
            Log.i(TAG, "Direct RC stick monitoring started")
            
            // Initialize and start WebSocket server
            bridgeServer = DJIBridgeServer(WEBSOCKET_PORT, this)
            bridgeServer.start()
            
            updateStatus("DJI Bridge running on port $WEBSOCKET_PORT\nDirect RC stick monitoring active - move joysticks!")
            Log.i(TAG, "DJI Android Bridge successfully started on port $WEBSOCKET_PORT")
            
        } catch (e: Exception) {
            val errorMsg = "Failed to initialize DJI Bridge: ${e.message}"
            Log.e(TAG, errorMsg, e)
            updateStatus("ERROR: $errorMsg")
        }
    }
    
    private fun startDirectRCStickMonitoring() {
        LogUtils.i(TAG, "🎮 STARTING DIRECT RC STICK MONITORING...")
        Log.i(TAG, "🎮 STARTING DIRECT RC STICK MONITORING...")
        
        val timestamp = System.currentTimeMillis()
        LogUtils.i(TAG, "⭐ JOYSTICK MONITORING INITIALIZATION at $timestamp")
        
        try {
            // Monitor Left Horizontal (Yaw) - Same as main activity
            RemoteControllerKey.KeyStickLeftHorizontal.create().listen(this) { value ->
                LogUtils.d("JOYSTICK_DEBUG", "Left Horizontal callback triggered - value: $value")
                value?.let {
                    synchronized(this) {
                        leftH = it
                    }
                    logStickInput("Left Horizontal (Yaw)", it)
                    updateControllerData()
                }
            }
            
            // Monitor Left Vertical (Throttle)
            RemoteControllerKey.KeyStickLeftVertical.create().listen(this) { value ->
                LogUtils.d("JOYSTICK_DEBUG", "Left Vertical callback triggered - value: $value")
                value?.let {
                    synchronized(this) {
                        leftV = it
                    }
                    logStickInput("Left Vertical (Throttle)", it)
                    updateControllerData()
                }
            }
            
            // Monitor Right Horizontal (Roll)
            RemoteControllerKey.KeyStickRightHorizontal.create().listen(this) { value ->
                LogUtils.d("JOYSTICK_DEBUG", "Right Horizontal callback triggered - value: $value")
                value?.let {
                    synchronized(this) {
                        rightH = it
                    }
                    logStickInput("Right Horizontal (Roll)", it)
                    updateControllerData()
                }
            }
            
            // Monitor Right Vertical (Pitch)
            RemoteControllerKey.KeyStickRightVertical.create().listen(this) { value ->
                LogUtils.d("JOYSTICK_DEBUG", "Right Vertical callback triggered - value: $value")
                value?.let {
                    synchronized(this) {
                        rightV = it
                    }
                    logStickInput("Right Vertical (Pitch)", it)
                    updateControllerData()
                }
            }
            
            LogUtils.i(TAG, "✅ Direct RC stick listeners set up successfully!")
            Log.i(TAG, "✅ Direct RC stick listeners set up successfully!")
            
        } catch (e: Exception) {
            LogUtils.e(TAG, "❌ Error setting up direct RC stick monitoring: ${e.message}")
            Log.e(TAG, "❌ Error setting up direct RC stick monitoring: ${e.message}")
        }
    }
    
    private fun logStickInput(stickName: String, value: Int) {
        val timestamp = System.currentTimeMillis()
        val percentage = value.toFloat() / 100.0f
        
        LogUtils.d("RC_STICK_MONITOR", "$stickName: $value (${String.format("%.2f", percentage)}%) at $timestamp")
        
        // Log direction for significant movements
        if (kotlin.math.abs(value) > 10) {
            val direction = when {
                value > 50 -> "HIGH_POSITIVE"
                value > 10 -> "POSITIVE"
                value < -50 -> "HIGH_NEGATIVE" 
                value < -10 -> "NEGATIVE"
                else -> "NEUTRAL"
            }
            LogUtils.d("RC_STICK_DIRECTION", "$stickName Direction: $direction (${kotlin.math.abs(value)})")
        }
    }
    
    private fun updateControllerData() {
        // Convert to normalized flight parameters
        val yaw = leftH.toFloat() / 100.0f
        val throttle = leftV.toFloat() / 100.0f  
        val roll = rightH.toFloat() / 100.0f
        val pitch = rightV.toFloat() / 100.0f
        
        // Log VirtualStick format for compatibility
        LogUtils.d("VirtualStick", "Input: P=${String.format("%.3f", pitch)}, R=${String.format("%.3f", roll)}, Y=${String.format("%.3f", yaw)}, T=${String.format("%.3f", throttle)}")
        
        // Update UI with live joystick values
        runOnUiThread {
            val statusMessage = """DJI Bridge running on port $WEBSOCKET_PORT
Direct RC stick monitoring active

Live Joystick Values:
Left H (Yaw): $leftH (${String.format("%.2f", yaw)})
Left V (Throttle): $leftV (${String.format("%.2f", throttle)})  
Right H (Roll): $rightH (${String.format("%.2f", roll)})
Right V (Pitch): $rightV (${String.format("%.2f", pitch)})

Flight Parameters:
P=${String.format("%.3f", pitch)}, R=${String.format("%.3f", roll)}, Y=${String.format("%.3f", yaw)}, T=${String.format("%.3f", throttle)}"""
            
            statusText?.text = statusMessage
        }
    }
    
    // Public method for server to get current stick values - Thread-safe with debug
    @Synchronized
    fun getCurrentStickValues(): Map<String, Int> {
        val currentValues = mapOf(
            "leftHorizontal" to leftH,
            "leftVertical" to leftV, 
            "rightHorizontal" to rightH,
            "rightVertical" to rightV
        )
        
        // Debug log every 20th call to avoid spam
        val callCount = System.currentTimeMillis() / 1000 % 20
        if (callCount == 0L) {
            LogUtils.d(TAG, "getCurrentStickValues() returning: $currentValues")
        }
        
        return currentValues
    }
    
    private fun updateStatus(message: String) {
        runOnUiThread {
            statusText?.text = message
            LogUtils.i(TAG, "Status: $message")
        }
    }
    
    override fun onDestroy() {
        super.onDestroy()
        
        try {
            bridgeServer.stop()
            Log.i(TAG, "DJI Bridge server stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping bridge server", e)
        }
        
        // Clean up RC stick monitoring resources
        try {
            dji.v5.manager.KeyManager.getInstance().cancelListen(this)
        } catch (e: Exception) {
            Log.w(TAG, "Error cleaning up RC stick monitoring resources", e)
        }
        Log.i(TAG, "DJI Android Bridge Activity destroyed")
    }
    
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            // Hide system UI for minimal headless operation
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
        }
    }
}