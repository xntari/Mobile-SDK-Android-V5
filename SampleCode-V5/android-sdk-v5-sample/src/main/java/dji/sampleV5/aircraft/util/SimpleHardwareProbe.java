package dji.sampleV5.aircraft.util;

import android.content.Context;
import android.os.Build;
import android.util.Log;

/**
 * Minimal Hardware Probe - Just basic info to test logging
 */
public class SimpleHardwareProbe {
    
    private static final String TAG = "HardwareProbe";
    
    public static void probeAndLog(Context context) {
        Log.d(TAG, "=== DJI HARDWARE PROBE START ===");
        
        Log.d(TAG, "Device: " + Build.MANUFACTURER + " " + Build.MODEL);
        Log.d(TAG, "Hardware: " + Build.HARDWARE);
        Log.d(TAG, "Board: " + Build.BOARD);
        Log.d(TAG, "Android: " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        
        int coreCount = Runtime.getRuntime().availableProcessors();
        Log.d(TAG, "CPU Cores: " + coreCount);
        
        String abis = String.join(", ", Build.SUPPORTED_ABIS);
        Log.d(TAG, "ABIs: " + abis);
        
        boolean supports64Bit = Build.SUPPORTED_64_BIT_ABIS.length > 0;
        Log.d(TAG, "64-bit Support: " + supports64Bit);
        
        Log.d(TAG, "=== DJI HARDWARE PROBE END ===");
    }
}