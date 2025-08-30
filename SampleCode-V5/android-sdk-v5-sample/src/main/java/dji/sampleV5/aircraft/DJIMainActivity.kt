package dji.sampleV5.aircraft

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import dji.sampleV5.aircraft.databinding.ActivityMainBinding
import dji.sampleV5.aircraft.models.BaseMainActivityVm
import dji.sampleV5.aircraft.models.MSDKInfoVm
import dji.sampleV5.aircraft.models.MSDKManagerVM
import dji.sampleV5.aircraft.models.globalViewModels
import dji.sampleV5.aircraft.util.Helper
import dji.sampleV5.aircraft.util.ToastUtils
import dji.v5.utils.common.LogUtils
import dji.v5.utils.common.PermissionUtil
import dji.v5.utils.common.StringUtils
import io.reactivex.rxjava3.disposables.CompositeDisposable
import dji.sdk.keyvalue.key.RemoteControllerKey
import dji.v5.et.create
import dji.v5.et.listen

/**
 * Class Description
 *
 * @author Hoker
 * @date 2022/2/10
 *
 * Copyright (c) 2022, DJI All Rights Reserved.
 */
abstract class DJIMainActivity : AppCompatActivity() {

    val tag: String = LogUtils.getTag(this)
    private val permissionArray = arrayListOf(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.KILL_BACKGROUND_PROCESSES,
        Manifest.permission.ACCESS_COARSE_LOCATION,
        Manifest.permission.ACCESS_FINE_LOCATION,
    )

    init {
        permissionArray.apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
//                add(Manifest.permission.READ_MEDIA_IMAGES)
//                add(Manifest.permission.READ_MEDIA_VIDEO)
//                add(Manifest.permission.READ_MEDIA_AUDIO)
            } else {
                add(Manifest.permission.READ_EXTERNAL_STORAGE)
                add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }
    }

    private val baseMainActivityVm: BaseMainActivityVm by viewModels()
    private val msdkInfoVm: MSDKInfoVm by viewModels()
    private val msdkManagerVM: MSDKManagerVM by globalViewModels()
    private lateinit var binding: ActivityMainBinding
    private val handler: Handler = Handler(Looper.getMainLooper())
    private val disposable = CompositeDisposable()

    abstract fun prepareUxActivity()

    abstract fun prepareTestingToolsActivity()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 有一些手机从系统桌面进入的时候可能会重启main类型的activity
        // 需要校验这种情况，业界标准做法，基本所有app都需要这个
        if (!isTaskRoot && intent.hasCategory(Intent.CATEGORY_LAUNCHER) && Intent.ACTION_MAIN == intent.action) {

                finish()
                return

        }

        window.decorView.apply {
            systemUiVisibility =
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        }

        initMSDKInfoView()
        observeSDKManager()
        checkPermissionAndRequest()
        
        // Test logging first
        LogUtils.i("DEBUG_TEST", "MainActivity onCreate called!")
        android.util.Log.i("DEBUG_TEST", "MainActivity onCreate with Android Log!")
        android.util.Log.i("DEBUG_TEST", "RC stick monitoring will start after SDK registration")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (checkPermission()) {
            handleAfterPermissionPermitted()
        }
    }

    override fun onResume() {
        super.onResume()
        if (checkPermission()) {
            handleAfterPermissionPermitted()
        }
    }

    private fun handleAfterPermissionPermitted() {
        prepareTestingToolsActivity()
    }

    @SuppressLint("SetTextI18n")
    private fun initMSDKInfoView() {
        msdkInfoVm.msdkInfo.observe(this) {
            binding.textViewVersion.text = StringUtils.getResStr(R.string.sdk_version, it.SDKVersion + " " + it.buildVer)
            binding.textViewProductName.text = StringUtils.getResStr(R.string.product_name, it.productType.name)
            binding.textViewPackageProductCategory.text = StringUtils.getResStr(R.string.package_product_category, it.packageProductCategory)
            binding.textViewIsDebug.text = StringUtils.getResStr(R.string.is_sdk_debug, it.isDebug)
            binding.textCoreInfo.text = it.coreInfo.toString()
        }

        binding.iconSdkForum.setOnClickListener {
            Helper.startBrowser(this, StringUtils.getResStr(R.string.sdk_forum_url))
        }

        binding.iconReleaseNode.setOnClickListener {
            Helper.startBrowser(this, StringUtils.getResStr(R.string.release_node_url))
        }
        binding.iconTechSupport.setOnClickListener {
            Helper.startBrowser(this, StringUtils.getResStr(R.string.tech_support_url))
        }
        binding.viewBaseInfo.setOnClickListener {
            baseMainActivityVm.doPairing {
                showToast(it)
            }
        }
    }

    private fun observeSDKManager() {
        msdkManagerVM.lvRegisterState.observe(this) { resultPair ->
            val statusText: String?
            
            // Enhanced debug logging for SDK registration
            LogUtils.i("SDK_REGISTRATION", "SDK Registration state changed - Success: ${resultPair.first}")
            android.util.Log.i("SDK_REGISTRATION", "SDK Registration state changed - Success: ${resultPair.first}")
            
            if (resultPair.first) {
                ToastUtils.showToast("Register Success")
                statusText = StringUtils.getResStr(this, R.string.registered)
                
                // Enhanced success logging
                LogUtils.i("SDK_REGISTRATION", "🎉 SDK REGISTRATION SUCCESSFUL! Starting initialization...")
                android.util.Log.i("SDK_REGISTRATION", "🎉 SDK REGISTRATION SUCCESSFUL! Starting initialization...")
                
                msdkInfoVm.initListener()
                
                // Start RC stick monitoring after SDK is registered with countdown
                LogUtils.i("SDK_REGISTRATION", "⏰ Starting 6-second countdown before joystick monitoring...")
                android.util.Log.i("SDK_REGISTRATION", "⏰ Starting 6-second countdown before joystick monitoring...")
                
                handler.postDelayed({
                    LogUtils.i("SDK_REGISTRATION", "⏰ 6-second delay complete! Initializing joystick monitoring...")
                    android.util.Log.i("SDK_REGISTRATION", "⏰ 6-second delay complete! Initializing joystick monitoring...")
                    startRCStickMonitoring()
                    prepareUxActivity()
                }, 6000) // Increased delay to ensure SDK is fully ready
            } else {
                // Enhanced failure logging
                LogUtils.e("SDK_REGISTRATION", "❌ SDK REGISTRATION FAILED: ${resultPair.second}")
                android.util.Log.e("SDK_REGISTRATION", "❌ SDK REGISTRATION FAILED: ${resultPair.second}")
                showToast("Register Failure: ${resultPair.second}")
                statusText = StringUtils.getResStr(this, R.string.unregistered)
            }
            binding.textViewRegistered.text = StringUtils.getResStr(R.string.registration_status, statusText)
        }

        msdkManagerVM.lvProductConnectionState.observe(this) { resultPair ->
            showToast("Product: ${resultPair.second} ,ConnectionState:  ${resultPair.first}")
        }

        msdkManagerVM.lvProductChanges.observe(this) { productId ->
            showToast("Product: $productId Changed")
        }

        msdkManagerVM.lvInitProcess.observe(this) { processPair ->
            showToast("Init Process event: ${processPair.first.name}")
        }

        msdkManagerVM.lvDBDownloadProgress.observe(this) { resultPair ->
            showToast("Database Download Progress current: ${resultPair.first}, total: ${resultPair.second}")
        }
    }

    private fun showToast(content: String) {
        ToastUtils.showToast(content)

    }


    fun <T> enableDefaultLayout(cl: Class<T>) {
        enableShowCaseButton(binding.defaultLayoutButton, cl)
    }

    fun <T> enableWidgetList(cl: Class<T>) {
        enableShowCaseButton(binding.widgetListButton, cl)
    }

    fun <T> enableTestingTools(cl: Class<T>) {
        enableShowCaseButton(binding.testingToolButton, cl)
    }

    private fun <T> enableShowCaseButton(view: View, cl: Class<T>) {
        view.isEnabled = true
        view.setOnClickListener {
            Intent(this, cl).also {
                startActivity(it)
            }
        }
    }

    private fun checkPermissionAndRequest() {
        if (!checkPermission()) {
            requestPermission()
        }
    }

    private fun checkPermission(): Boolean {
        for (i in permissionArray.indices) {
            if (!PermissionUtil.isPermissionGranted(this, permissionArray[i])) {
                return false
            }
        }
        return true
    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        result?.entries?.forEach {
            if (!it.value) {
                requestPermission()
                return@forEach
            }
        }
    }

    private fun requestPermission() {
        requestPermissionLauncher.launch(permissionArray.toArray(arrayOf()))
    }

    private fun startRCStickMonitoring() {
        LogUtils.i("GlobalJoystickMonitor", "🎮 STARTING GLOBAL RC STICK MONITORING...")
        android.util.Log.i("GlobalJoystickMonitor", "🎮 STARTING GLOBAL RC STICK MONITORING with Android Log...")
        
        val timestamp = System.currentTimeMillis()
        LogUtils.i("JOYSTICK_INIT", "⭐ JOYSTICK MONITORING INITIALIZATION at $timestamp")
        android.util.Log.i("JOYSTICK_INIT", "⭐ JOYSTICK MONITORING INITIALIZATION at $timestamp")
        
        // Store current stick values
        var leftH = 0   // Yaw
        var leftV = 0   // Throttle
        var rightH = 0  // Roll
        var rightV = 0  // Pitch
        
        try {
            // Monitor Left Horizontal (Yaw)
            RemoteControllerKey.KeyStickLeftHorizontal.create().listen(this) { value ->
                value?.let {
                    leftH = it
                    logStickInput("Left Horizontal (Yaw)", it)
                    updateFlightMapping(leftH, leftV, rightH, rightV)
                }
            }
            
            // Monitor Left Vertical (Throttle)
            RemoteControllerKey.KeyStickLeftVertical.create().listen(this) { value ->
                value?.let {
                    leftV = it
                    logStickInput("Left Vertical (Throttle)", it)
                    updateFlightMapping(leftH, leftV, rightH, rightV)
                }
            }
            
            // Monitor Right Horizontal (Roll)
            RemoteControllerKey.KeyStickRightHorizontal.create().listen(this) { value ->
                value?.let {
                    rightH = it
                    logStickInput("Right Horizontal (Roll)", it)
                    updateFlightMapping(leftH, leftV, rightH, rightV)
                }
            }
            
            // Monitor Right Vertical (Pitch)  
            RemoteControllerKey.KeyStickRightVertical.create().listen(this) { value ->
                value?.let {
                    rightV = it
                    logStickInput("Right Vertical (Pitch)", it)
                    updateFlightMapping(leftH, leftV, rightH, rightV)
                }
            }
            
            LogUtils.i("GlobalJoystickMonitor", "✅ RC stick listeners set up successfully!")
            android.util.Log.i("GlobalJoystickMonitor", "✅ RC stick listeners set up successfully!")
            
            LogUtils.i("JOYSTICK_INIT", "🎯 ALL JOYSTICK LISTENERS READY - Move controller sticks to see logs!")
            android.util.Log.i("JOYSTICK_INIT", "🎯 ALL JOYSTICK LISTENERS READY - Move controller sticks to see logs!")
            
        } catch (e: Exception) {
            LogUtils.e("GlobalJoystickMonitor", "❌ Error setting up RC stick monitoring: ${e.message}")
            android.util.Log.e("GlobalJoystickMonitor", "❌ Error setting up RC stick monitoring: ${e.message}")
        }
    }
    
    /**
     * Log individual stick input with timestamp and direction analysis
     */
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
    
    /**
     * Update flight mapping and log combined stick positions
     */
    private fun updateFlightMapping(leftH: Int, leftV: Int, rightH: Int, rightV: Int) {
        // Convert to normalized flight parameters (-1.0 to 1.0)
        val yaw = leftH.toFloat() / 100.0f        // Left horizontal = Yaw
        val throttle = leftV.toFloat() / 100.0f   // Left vertical = Throttle
        val roll = rightH.toFloat() / 100.0f      // Right horizontal = Roll
        val pitch = rightV.toFloat() / 100.0f     // Right vertical = Pitch
        
        // Log original VirtualStick format for compatibility
        LogUtils.d("VirtualStick", "Input: P=${String.format("%.3f", pitch)}, R=${String.format("%.3f", roll)}, Y=${String.format("%.3f", yaw)}, T=${String.format("%.3f", throttle)}")
        
        // Log detailed flight mapping
        LogUtils.d("VIRTUAL_STICK_CMD", "RC Stick Values: LH=$leftH, LV=$leftV, RH=$rightH, RV=$rightV")
        
        // Only log flight parameters if there's actual movement
        if (kotlin.math.abs(pitch) > 0.01f || kotlin.math.abs(roll) > 0.01f || 
            kotlin.math.abs(yaw) > 0.01f || kotlin.math.abs(throttle) > 0.01f) {
            logFlightParameters(pitch, roll, yaw, throttle)
        }
    }
    
    /**
     * Log detailed flight parameters with interpretation
     */
    private fun logFlightParameters(pitch: Float, roll: Float, yaw: Float, throttle: Float) {
        val timestamp = System.currentTimeMillis()
        
        LogUtils.d("FLIGHT_MAPPING", "Flight Parameters at $timestamp:")
        LogUtils.d("FLIGHT_MAPPING", "  Pitch: ${String.format("%.3f", pitch)} (forward/backward)")
        LogUtils.d("FLIGHT_MAPPING", "  Roll: ${String.format("%.3f", roll)} (left/right)")
        LogUtils.d("FLIGHT_MAPPING", "  Yaw: ${String.format("%.3f", yaw)} (rotation)")
        LogUtils.d("FLIGHT_MAPPING", "  Throttle: ${String.format("%.3f", throttle)} (up/down)")
        
        // Calculate movement magnitude
        val magnitude = kotlin.math.sqrt((pitch * pitch + roll * roll + yaw * yaw + throttle * throttle).toDouble())
        LogUtils.d("FLIGHT_MAPPING", "  Movement Magnitude: ${String.format("%.3f", magnitude)}")
        
        // Safety warnings for aggressive movements
        if (kotlin.math.abs(pitch) > 0.8f || kotlin.math.abs(roll) > 0.8f) {
            LogUtils.w("FLIGHT_SAFETY", "HIGH SPEED MOVEMENT DETECTED! P=${String.format("%.2f", pitch)}, R=${String.format("%.2f", roll)}")
        }
        
        if (kotlin.math.abs(yaw) > 0.8f) {
            LogUtils.w("FLIGHT_SAFETY", "RAPID ROTATION DETECTED! Y=${String.format("%.2f", yaw)}")
        }
        
        // Interpret flight command
        val command = interpretFlightCommand(pitch, roll, yaw, throttle)
        if (command.isNotEmpty()) {
            LogUtils.i("FLIGHT_COMMAND", "Interpreted Command: $command")
        }
    }
    
    /**
     * Interpret flight parameters into human-readable commands
     */
    private fun interpretFlightCommand(pitch: Float, roll: Float, yaw: Float, throttle: Float): String {
        val commands = mutableListOf<String>()
        
        // Throttle commands
        when {
            throttle > 0.3f -> commands.add("ASCENDING")
            throttle < -0.3f -> commands.add("DESCENDING")
        }
        
        // Pitch commands  
        when {
            pitch > 0.3f -> commands.add("MOVING_FORWARD")
            pitch < -0.3f -> commands.add("MOVING_BACKWARD")
        }
        
        // Roll commands
        when {
            roll > 0.3f -> commands.add("MOVING_RIGHT")
            roll < -0.3f -> commands.add("MOVING_LEFT")
        }
        
        // Yaw commands
        when {
            yaw > 0.3f -> commands.add("ROTATING_RIGHT")
            yaw < -0.3f -> commands.add("ROTATING_LEFT")
        }
        
        return if (commands.isEmpty()) "HOVERING" else commands.joinToString(" + ")
    }


    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
        disposable.dispose()
    }
}