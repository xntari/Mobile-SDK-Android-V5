package dji.sampleV5.aircraft

import android.content.Context
import dji.sampleV5.aircraft.util.SimpleHardwareProbe

/**
 * Class Description
 *
 * @author Hoker
 * @date 2022/3/2
 *
 * Copyright (c) 2022, DJI All Rights Reserved.
 */
class DJIAircraftApplication : DJIApplication() {

    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(base)
        com.cySdkyc.clx.Helper.install(this)
    }
    
    override fun onCreate() {
        super.onCreate()
        
        // Run hardware probe on startup
        try {
            SimpleHardwareProbe.probeAndLog(this)
        } catch (e: Exception) {
            android.util.Log.e("DJIAircraftApplication", "Hardware probe failed: ${e.message}")
        }
    }
}