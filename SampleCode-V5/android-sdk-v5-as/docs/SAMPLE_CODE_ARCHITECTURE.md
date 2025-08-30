# DJI Mobile SDK V5 - Sample Code Architecture & Implementation Patterns

> **Comprehensive guide to the SDK sample application structure, design patterns, and implementation best practices**

## 🏗️ Project Structure Overview

### Main Application Modules

```
android-sdk-v5-as/                        # Android Studio workspace
├── android-sdk-v5-sample/               # 📱 Main Demo Application
│   ├── src/main/java/dji/sampleV5/aircraft/
│   │   ├── DJIAircraftApplication.kt     # SDK initialization & global setup
│   │   ├── DJIAircraftMainActivity.kt    # Main UI navigation hub
│   │   ├── TestingToolsActivity.kt       # Development & debugging tools
│   │   ├── models/                       # ViewModels (35+ specialized classes)
│   │   ├── pages/                        # UI fragments (40+ feature screens)
│   │   ├── data/                         # Data models & adapters (15+ classes)
│   │   ├── keyvalue/                     # Key-value system utilities
│   │   └── util/                         # Helper utilities & WPML support
│   └── build.gradle                      # Module build configuration
├── android-sdk-v5-uxsdk/               # 🎛️ UX SDK Widget Library
│   └── src/main/java/dji/v5/ux/        # 150+ pre-built UI widgets
│       ├── core/                        # Base widget framework
│       ├── accessory/                   # RTK & positioning widgets  
│       ├── flight/                      # Flight control widgets
│       ├── visualcamera/                # Camera control widgets
│       ├── obstacle/                    # Safety & avoidance widgets
│       └── mapkit/                      # Map integration system
└── build.gradle                        # Root build configuration
```

## 📱 Main Sample Application Architecture

### Core Application Components

#### DJIAircraftApplication.kt - SDK Initialization
**Purpose**: Global application setup and SDK registration
**Key Responsibilities**:
- SDK authentication and registration
- Global error handling configuration
- Application-wide resource initialization

```kotlin
// Application-Level SDK Setup
class DJIAircraftApplication : DJIApplication() {
    override fun onCreate() {
        super.onCreate()
        initializeSDK()
        setupGlobalErrorHandling()
        initializeApplicationResources()
    }
    
    private fun initializeSDK() {
        DJISDKManager.getInstance().registerApp(this, object : DJISDKManager.SDKManagerCallback {
            override fun onRegister(djiError: DJIError?) {
                if (djiError == null) {
                    // SDK registration successful
                    logSDKStatus("SDK Registration: SUCCESS")
                    enableDroneConnection()
                } else {
                    // Handle registration error
                    logSDKStatus("SDK Registration: FAILED - ${djiError.description}")
                    handleRegistrationError(djiError)
                }
            }
            
            override fun onProductConnect(baseProduct: BaseProduct?) {
                // Aircraft connected - initialize components
                baseProduct?.let {
                    initializeAircraftComponents(it)
                }
            }
            
            override fun onProductDisconnect() {
                // Handle aircraft disconnection
                cleanupAircraftResources()
            }
        })
    }
}
```

#### DJIAircraftMainActivity.kt - Navigation Hub
**Purpose**: Main UI entry point and feature navigation
**Architecture Pattern**: Single-Activity with Fragment navigation

```kotlin
// Main Activity with Fragment Navigation
class DJIAircraftMainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityAircraftMainBinding
    private lateinit var fragmentAdapter: MainFragmentListAdapter
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = DataBindingUtil.setContentView(this, R.layout.activity_aircraft_main)
        
        setupFragmentNavigation()
        initializeUIComponents()
        startHardwareProbe() // Custom hardware detection
    }
    
    private fun setupFragmentNavigation() {
        val fragmentList = createFeatureFragmentList()
        fragmentAdapter = MainFragmentListAdapter(this, fragmentList)
        binding.fragmentList.adapter = fragmentAdapter
    }
    
    private fun createFeatureFragmentList(): List<FragmentPageItem> {
        return listOf(
            FragmentPageItem("Waypoint V3", WayPointV3Fragment::class.java),
            FragmentPageItem("MOP Interface", MopInterfaceFragment::class.java),
            FragmentPageItem("Intelligent Box", IntelligentBoxFragment::class.java),
            FragmentPageItem("RTK Center", RTKCenterFragment::class.java),
            FragmentPageItem("Virtual Stick", VirtualStickFragment::class.java),
            FragmentPageItem("Camera Stream", CameraStreamListFragment::class.java),
            FragmentPageItem("Media Manager", MediaFragment::class.java),
            // ... 35+ more feature fragments
        )
    }
}
```

### ViewModel Architecture Pattern

The application implements the **MVVM (Model-View-ViewModel)** pattern with reactive programming:

#### Base ViewModel Implementation
```kotlin
// Base ViewModel with Common Functionality
abstract class DJIViewModel : ViewModel() {
    protected val logTag = this::class.java.simpleName
    protected var toastResult: MutableLiveData<DJIToastResult>? = null
    
    fun initToastResult(toastResult: MutableLiveData<DJIToastResult>) {
        this.toastResult = toastResult
    }
    
    protected fun sendToastMsg(djiToastResult: DJIToastResult) {
        toastResult?.postValue(djiToastResult)
    }
    
    override fun onCleared() {
        super.onCleared()
        // Cleanup resources when ViewModel is destroyed
        KeyManager.getInstance().cancelListen(this)
    }
}
```

#### Specialized ViewModel Examples

**WayPointV3VM.kt - Mission Management ViewModel:**
```kotlin
// Mission Management with Real-time Updates
class WayPointV3VM : DJIViewModel() {
    val missionUploadState = MutableLiveData<MissionUploadStateInfo>()
    val flightControlState = MutableLiveData<FlightControlState>()
    
    // Key-value system integration for real-time data
    private var compassHeadKey: DJIKey<Double> = FlightControllerKey.KeyCompassHeading.create()
    private var altitudeKey: DJIKey<Double> = FlightControllerKey.KeyAltitude.create()
    private var flightSpeed: DJIKey<Velocity3D> = FlightControllerKey.KeyAircraftVelocity.create()
    
    // Mission upload using architecture patterns - see SDK_API_DOCUMENTATION.md for full implementation
    fun pushMissionToAircraft(missionPath: String) {
        WaypointMissionManager.getInstance().pushKMZFileToAircraft(missionPath, callback)
    }
    
    // Reactive data streaming pattern
    fun listenFlightControlState(): Disposable {
        return Flowable.combineLatest(
            RxUtil.addListener(FlightControllerKey.KeyHomeLocation, this),
            RxUtil.addListener(FlightControllerKey.KeyAircraftLocation, this)
        ) { homeLocation, aircraftLocation ->
            if (homeLocation != null && aircraftLocation != null) {
                // Combine multiple sensor streams
                val distance = calculateDistance(homeLocation, aircraftLocation)
                val height = getHeight()
                val heading = getHeading()
                val speed = getSpeed()
                
                FlightControlState(
                    aircraftLocation.longitude,
                    aircraftLocation.latitude,
                    distance = distance,
                    height = height,
                    head = heading,
                    speed = speed,
                    homeLocation = homeLocation
                )
            } else null
        }
        .observeOn(AndroidSchedulers.mainThread())
        .subscribe { flightState ->
            flightState?.let {
                flightControlState.value = it
            }
        }
    }
}
```

**MopVM.kt - Pipeline Communication ViewModel:**
```kotlin
// MOP (Mobile Onboard Processor) Communication Pattern
class MopVM : DJIViewModel() {
    private var isStop = false
    val receiveMessageLiveData = MutableLiveData<String>()
    val pipelineMapLivData = MutableLiveData<Map<Int, Pipeline>>()
    
    private var pipeline: Pipeline? = null
    private val executorService: ExecutorService = DJIExecutor.getExecutorFor(DJIExecutor.Purpose.URGENT)
    
    fun connectToPipeline(
        index: ComponentIndexType,
        id: Int,
        deviceType: PipelineDeviceType,
        transmissionControlType: TransmissionControlType
    ) {
        executorService.execute {
            val error = PipelineManager.getInstance()
                .connectPipeline(index, id, deviceType, transmissionControlType)
            
            if (error == null) {
                isStop = false
                pipeline = PipelineManager.getInstance().pipelines[id]
                ToastUtils.showToast("Pipeline Connected Successfully")
                
                // Start continuous data reading
                readPipelineData()
            } else {
                ToastUtils.showToast("Pipeline Connection Failed: $error")
            }
        }
    }
    
    private fun readPipelineData() {
        if (!isStop) {
            val data = ByteArray(19004) // Large buffer for data
            val result = pipeline?.readData(data) ?: DataResult()
            
            when {
                result.length > 0 -> {
                    // Process received data
                    val receivedContent = String(data, 0, result.length)
                    val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())
                        .format(System.currentTimeMillis())
                    
                    val logMessage = "Timestamp: $timestamp, Length: ${result.length}, Data: $receivedContent"
                    receiveMessageLiveData.postValue(logMessage)
                    
                    // Continue reading
                    readPipelineData()
                }
                result.length == 0 -> {
                    // No data available, continue polling
                    readPipelineData()
                }
                else -> {
                    // Error condition
                    if (!result.error.errorCode().equals(DJIPipeLineError.TIMEOUT)) {
                        stopPipeline()
                    } else {
                        readPipelineData()
                    }
                }
            }
        }
    }
}
```

## 🎛️ UX SDK Widget Library Architecture

### Widget System Overview

The UX SDK provides **150+ pre-built widgets** organized into specialized categories:

```
dji/v5/ux/
├── core/                               # Base widget framework
│   ├── base/WidgetModel.java           # Base class for all widgets
│   ├── communication/                  # Inter-widget communication
│   ├── panel/                          # Panel layout system
│   └── ui/                             # Common UI components
├── accessory/                          # RTK & positioning widgets
│   ├── RTKEnabledWidget.kt             # RTK status indicator
│   ├── RTKSatelliteStatusWidget.kt     # Satellite reception display
│   └── RTKStationConnectWidget.kt      # Base station connection UI
├── core/widget/                        # Essential flight widgets
│   ├── battery/BatteryWidget.kt        # Battery status & health monitoring
│   ├── compass/CompassWidget.kt        # Heading & orientation display
│   ├── altitude/AltitudeWidget.kt      # Height & elevation data
│   ├── fpv/FPVWidget.kt               # First-person video display
│   └── [25+ additional core widgets]   # Complete telemetry suite
├── flight/                             # Flight control widgets
│   ├── takeoff/TakeOffWidget.kt        # Takeoff control interface
│   ├── returnhome/ReturnHomeWidget.kt  # Return-to-home controls
│   └── flightparam/                    # Flight parameter controls
├── visualcamera/                       # Camera control widgets
│   ├── aperture/CameraConfigApertureWidget.java  # Aperture control
│   ├── iso/CameraConfigISOWidget.java             # ISO settings
│   ├── zoom/FocalZoomWidget.java                  # Zoom control
│   └── [15+ camera control widgets]               # Complete camera suite
└── mapkit/                             # Map integration system
    ├── core/maps/DJIMap.java           # Unified mapping interface
    ├── gmap/                           # Google Maps integration
    └── maplibre/                       # MapLibre integration
```

### Widget Implementation Patterns

#### Base Widget Architecture
```kotlin
// Base Widget with Model-View Separation
abstract class ConstraintLayoutWidget<T> @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : ConstraintLayout(context, attrs, defStyleAttr), ViewWidget<T> {
    
    protected abstract val widgetModel: T
    protected val uiUpdateStateProcessor = PublishProcessor.create<ModelState>()
    private val compositeDisposable = CompositeDisposable()
    
    override fun initView(context: Context, attrs: AttributeSet?, defStyleAttr: Int) {
        setupUI()
        bindToModel()
        setupStateProcessing()
    }
    
    protected abstract fun setupUI()
    protected abstract fun bindToModel()
    
    private fun setupStateProcessing() {
        val stateDisposable = uiUpdateStateProcessor
            .observeOn(AndroidSchedulers.mainThread())
            .subscribe { modelState ->
                updateUI(modelState)
            }
        compositeDisposable.add(stateDisposable)
    }
    
    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        compositeDisposable.clear()
        widgetModel.cleanup()
    }
}
```

#### Specialized Widget Example: BatteryWidget
```kotlin
// Battery Widget with Real-time Updates
class BatteryWidget @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : ConstraintLayoutWidget<BatteryWidgetModel>(context, attrs, defStyleAttr) {
    
    override val widgetModel: BatteryWidgetModel by lazy {
        BatteryWidgetModel(DJISDKModel.getInstance(), ObservableInMemoryKeyedStore.getInstance())
    }
    
    private lateinit var batteryIcon: ImageView
    private lateinit var batteryPercentage: TextView
    private lateinit var batteryVoltage: TextView
    
    override fun setupUI() {
        View.inflate(context, R.layout.uxsdk_widget_battery, this)
        batteryIcon = findViewById(R.id.imageview_battery_icon)
        batteryPercentage = findViewById(R.id.textview_battery_percentage)
        batteryVoltage = findViewById(R.id.textview_battery_voltage)
    }
    
    override fun bindToModel() {
        // Reactive binding to battery data
        val modelState = widgetModel.getBatteryState()
            .observeOn(AndroidSchedulers.mainThread())
            .subscribe { batteryState ->
                updateBatteryDisplay(batteryState)
            }
        compositeDisposable.add(modelState)
    }
    
    private fun updateBatteryDisplay(batteryState: BatteryState) {
        // Update battery percentage
        batteryPercentage.text = "${batteryState.chargeRemaining}%"
        
        // Update battery icon based on charge level
        batteryIcon.setImageResource(getBatteryIcon(batteryState.chargeRemaining))
        
        // Update voltage display
        batteryVoltage.text = String.format("%.1fV", batteryState.voltage)
        
        // Set warning colors for low battery
        if (batteryState.chargeRemaining < 20) {
            batteryPercentage.setTextColor(ContextCompat.getColor(context, R.color.uxsdk_warning_red))
        } else {
            batteryPercentage.setTextColor(ContextCompat.getColor(context, R.color.uxsdk_white))
        }
    }
}
```

## 🔧 Key Implementation Patterns

### 1. Reactive Data Streaming Pattern

**Real-time Sensor Data Integration:**
```kotlin
// High-Performance Sensor Data Streaming
class SensorDataProcessor : DJIViewModel() {
    private val sensorDataProcessor = PublishProcessor.create<SensorData>()
    
    fun startSensorDataStream(): Disposable {
        return Flowable.combineLatest(
            // Multiple sensor streams combined
            RxUtil.addListener(FlightControllerKey.KeyAircraftLocation, this),
            RxUtil.addListener(FlightControllerKey.KeyAltitude, this),
            RxUtil.addListener(FlightControllerKey.KeyCompassHeading, this),
            RxUtil.addListener(FlightControllerKey.KeyAircraftVelocity, this),
            RxUtil.addListener(BatteryKey.KeyChargeRemainingInPercent, this)
        ) { location, altitude, heading, velocity, battery ->
            // Create combined sensor data object
            SensorData(
                location = location as LocationCoordinate2D,
                altitude = altitude as Double,
                heading = heading as Double,
                velocity = velocity as Velocity3D,
                batteryPercent = battery as Int,
                timestamp = System.currentTimeMillis()
            )
        }
        .observeOn(AndroidSchedulers.mainThread())
        .subscribe { sensorData ->
            // Process real-time sensor data
            processSensorUpdate(sensorData)
            
            // Update UI components
            updateTelemetryDisplay(sensorData)
            
            // Log for analysis
            logSensorData(sensorData)
        }
    }
}
```

### 2. Error Handling & Recovery Pattern

**Comprehensive Error Management:**
```kotlin
// Robust Error Handling System
class ErrorHandlingPattern {
    fun executeWithErrorHandling(operation: () -> Unit, callback: CommonCallbacks.CompletionCallback) {
        try {
            operation()
            callback.onResult(null) // Success
        } catch (exception: Exception) {
            val djiError = mapExceptionToDJIError(exception)
            
            when (djiError.errorCode) {
                DJIError.TIMEOUT -> {
                    // Retry with exponential backoff
                    retryWithBackoff(operation, callback, maxRetries = 3)
                }
                DJIError.CONNECTION_LOST -> {
                    // Handle connection loss
                    handleConnectionLoss()
                    callback.onResult(djiError)
                }
                DJIError.INVALID_PARAMETER -> {
                    // Validate parameters and retry
                    validateParametersAndRetry(operation, callback)
                }
                else -> {
                    // Log error and notify user
                    logError(djiError)
                    callback.onResult(djiError)
                }
            }
        }
    }
    
    private fun retryWithBackoff(
        operation: () -> Unit,
        callback: CommonCallbacks.CompletionCallback,
        maxRetries: Int,
        currentRetry: Int = 0
    ) {
        if (currentRetry >= maxRetries) {
            callback.onResult(DJIError.TIMEOUT)
            return
        }
        
        val delayMs = (1000L * Math.pow(2.0, currentRetry.toDouble())).toLong()
        Handler(Looper.getMainLooper()).postDelayed({
            executeWithErrorHandling(operation) { error ->
                if (error != null) {
                    retryWithBackoff(operation, callback, maxRetries, currentRetry + 1)
                } else {
                    callback.onResult(null)
                }
            }
        }, delayMs)
    }
}
```

### 3. Resource Management Pattern

**Lifecycle-Aware Resource Management:**
```kotlin
// Proper Resource Cleanup
class ResourceManagedComponent : DJIViewModel(), LifecycleObserver {
    private val disposables = CompositeDisposable()
    private val keyListeners = mutableListOf<DJIKey<*>>()
    
    @OnLifecycleEvent(Lifecycle.Event.ON_CREATE)
    fun onCreate() {
        initializeResources()
    }
    
    @OnLifecycleEvent(Lifecycle.Event.ON_RESUME)
    fun onResume() {
        startDataStreams()
    }
    
    @OnLifecycleEvent(Lifecycle.Event.ON_PAUSE)
    fun onPause() {
        pauseDataStreams()
    }
    
    @OnLifecycleEvent(Lifecycle.Event.ON_DESTROY)
    fun onDestroy() {
        cleanup()
    }
    
    private fun startDataStreams() {
        val dataStream = createSensorDataStream()
            .subscribe { data ->
                processSensorData(data)
            }
        disposables.add(dataStream)
    }
    
    private fun cleanup() {
        // Dispose of all RxJava subscriptions
        disposables.clear()
        
        // Cancel all key listeners
        keyListeners.forEach { key ->
            KeyManager.getInstance().cancelListen(key, this)
        }
        keyListeners.clear()
        
        // Close any open connections
        closeConnections()
    }
}
```

### 4. Custom Widget Development Pattern

**Creating Custom Widgets:**
```kotlin
// Custom Widget Implementation
class CustomTelemetryWidget @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : ConstraintLayoutWidget<CustomTelemetryWidgetModel>(context, attrs, defStyleAttr) {
    
    override val widgetModel: CustomTelemetryWidgetModel by lazy {
        CustomTelemetryWidgetModel(DJISDKModel.getInstance())
    }
    
    private lateinit var telemetryDisplay: RecyclerView
    private lateinit var telemetryAdapter: TelemetryAdapter
    
    override fun setupUI() {
        View.inflate(context, R.layout.custom_telemetry_widget, this)
        telemetryDisplay = findViewById(R.id.telemetry_recycler_view)
        
        telemetryAdapter = TelemetryAdapter()
        telemetryDisplay.adapter = telemetryAdapter
        telemetryDisplay.layoutManager = LinearLayoutManager(context)
    }
    
    override fun bindToModel() {
        val telemetryStream = widgetModel.getTelemetryData()
            .observeOn(AndroidSchedulers.mainThread())
            .subscribe { telemetryData ->
                telemetryAdapter.updateData(telemetryData)
            }
        compositeDisposable.add(telemetryStream)
    }
    
    // Custom widget configuration
    fun configureTelemetryDisplay(
        showGPS: Boolean = true,
        showBattery: Boolean = true,
        showAttitude: Boolean = true,
        updateFrequency: Long = 100 // milliseconds
    ) {
        widgetModel.configureTelemetry(showGPS, showBattery, showAttitude, updateFrequency)
    }
}
```

## 🔨 Build System & Development Tools

### Gradle Configuration Pattern

**Multi-Module Build Configuration:**
```kotlin
// Root build.gradle
allprojects {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://jitpack.io' }
        // DJI SDK repository
        maven { url 'https://developer.dji.com/sdk/download' }
    }
}

// Module build.gradle pattern
android {
    compileSdkVersion 34
    
    defaultConfig {
        minSdkVersion 24  // DJI SDK requirement
        targetSdkVersion 34
        multiDexEnabled true
    }
    
    buildFeatures {
        dataBinding true
        viewBinding true
    }
    
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    // DJI SDK dependencies
    implementation 'com.dji:dji-sdk-v5-aircraft:5.15.0'
    implementation 'com.dji:dji-sdk-v5-networkImp:5.15.0'
    
    // Android Architecture Components
    implementation 'androidx.lifecycle:lifecycle-viewmodel-ktx:2.6.2'
    implementation 'androidx.lifecycle:lifecycle-livedata-ktx:2.6.2'
    
    // Reactive Programming
    implementation 'io.reactivex.rxjava3:rxjava:3.1.5'
    implementation 'io.reactivex.rxjava3:rxandroid:3.0.0'
    
    // UI Components
    implementation 'androidx.recyclerview:recyclerview:1.3.1'
    implementation 'com.google.android.material:material:1.9.0'
}
```

### Development & Testing Tools

**Hardware Probing Utility:**
```kotlin
// Development Hardware Detection
class SimpleHardwareProbe {
    companion object {
        fun probeAndLog(context: Context) {
            Log.d("HardwareProbe", "=== DJI HARDWARE PROBE START ===")
            
            // System Information
            Log.d("HardwareProbe", "Device Model: ${Build.MODEL}")
            Log.d("HardwareProbe", "Manufacturer: ${Build.MANUFACTURER}")
            Log.d("HardwareProbe", "Hardware: ${Build.HARDWARE}")
            Log.d("HardwareProbe", "Board: ${Build.BOARD}")
            Log.d("HardwareProbe", "CPU ABI: ${Build.CPU_ABI}")
            
            // Memory Information
            val runtime = Runtime.getRuntime()
            Log.d("HardwareProbe", "Max Memory: ${runtime.maxMemory() / 1024 / 1024} MB")
            Log.d("HardwareProbe", "Total Memory: ${runtime.totalMemory() / 1024 / 1024} MB")
            
            // Display Information
            val displayMetrics = context.resources.displayMetrics
            Log.d("HardwareProbe", "Screen: ${displayMetrics.widthPixels}x${displayMetrics.heightPixels}")
            Log.d("HardwareProbe", "Density: ${displayMetrics.densityDpi} DPI")
            
            Log.d("HardwareProbe", "=== DJI HARDWARE PROBE END ===")
        }
    }
}
```

## 🎯 Architecture Best Practices

### 1. Performance Optimization
```kotlin
// Optimized Data Processing
class PerformanceOptimizedProcessor {
    private val backgroundExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    
    fun processHighFrequencyData(data: SensorData) {
        backgroundExecutor.execute {
            // Heavy processing on background thread
            val processedData = performHeavyCalculations(data)
            
            // UI updates on main thread
            mainHandler.post {
                updateUserInterface(processedData)
            }
        }
    }
    
    fun cleanup() {
        backgroundExecutor.shutdown()
    }
}
```

### 2. Memory Management
```kotlin
// Memory-Efficient Data Handling
class MemoryEfficientDataHandler {
    private val dataCache = LruCache<String, CachedData>(100) // LRU cache
    
    fun processDataWithCaching(key: String, data: ByteArray) {
        val cachedData = dataCache.get(key)
        
        if (cachedData != null && cachedData.isValid()) {
            // Use cached data
            processCachedData(cachedData)
        } else {
            // Process new data
            val processedData = processRawData(data)
            dataCache.put(key, CachedData(processedData))
        }
    }
}
```

### 3. Testing Integration
```kotlin
// Unit Testing Support
class TestingUtilities {
    companion object {
        fun createMockDroneConnection(): MockDroneConnection {
            return MockDroneConnection().apply {
                setConnected(true)
                setAircraftModel(ProductType.M350_RTK)
                setBatteryLevel(85)
                setGPSSignal(GPSSignal.GOOD)
            }
        }
        
        fun simulateFlightData(): FlightControlState {
            return FlightControlState(
                longitude = -122.4194,  // San Francisco
                latitude = 37.7749,
                distance = 150.0,       // meters from home
                height = 50.0,          // meters AGL
                head = 45.0f,           // degrees
                speed = 5.0,            // m/s
                homeLocation = LocationCoordinate2D(37.7749, -122.4194)
            )
        }
    }
}
```

---

## 📋 Architecture Summary

The DJI Mobile SDK V5 sample architecture demonstrates:

✅ **MVVM Pattern Implementation** with reactive data binding  
✅ **Modular Component Design** for maintainability and scalability  
✅ **Widget-Based UI System** with 150+ pre-built components  
✅ **Reactive Programming** using RxJava for real-time data streams  
✅ **Comprehensive Error Handling** with retry mechanisms  
✅ **Resource Management** with proper lifecycle integration  
✅ **Performance Optimization** through background processing  
✅ **Testing Support** with mock objects and simulation utilities  

This architecture provides a solid foundation for developing professional drone applications with the DJI Mobile SDK V5, ensuring maintainable, performant, and reliable software solutions.

---

*Sample code architecture based on analysis of the DJI Mobile SDK V5 demonstration application. Implementation patterns may be adapted based on specific application requirements and use cases.*