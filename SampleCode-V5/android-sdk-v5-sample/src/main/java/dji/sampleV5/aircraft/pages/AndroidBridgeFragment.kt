package dji.sampleV5.aircraft.pages

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import dji.sampleV5.aircraft.DJIBridgeActivity
import dji.sampleV5.aircraft.R
import dji.sampleV5.aircraft.databinding.FragAndroidBridgePageBinding
import dji.sampleV5.aircraft.util.ToastUtils
import dji.v5.manager.SDKManager

/**
 * Android Bridge Fragment - Phase 1 UI
 * 
 * Simple interface to start/stop the DJI Android Bridge server
 * for streaming controller data to external clients
 */
class AndroidBridgeFragment : DJIFragment() {
    
    private var binding: FragAndroidBridgePageBinding? = null
    private val mainBinding: FragAndroidBridgePageBinding get() = binding!!
    
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        binding = FragAndroidBridgePageBinding.inflate(inflater, container, false)
        return mainBinding.root
    }
    
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        
        initView()
        updateStatus()
    }
    
    private fun initView() {
        mainBinding.btnStartBridge.setOnClickListener {
            startBridge()
        }
        
        mainBinding.btnStopBridge.setOnClickListener {
            stopBridge()
        }
    }
    
    private fun startBridge() {
        if (!SDKManager.getInstance().isRegistered) {
            ToastUtils.showToast("DJI SDK not registered. Please wait for registration to complete.")
            return
        }
        
        try {
            val intent = Intent(requireContext(), DJIBridgeActivity::class.java)
            startActivity(intent)
            
            ToastUtils.showToast("DJI Android Bridge launched")
            updateStatus()
            
        } catch (e: Exception) {
            ToastUtils.showToast("Failed to start bridge: ${e.message}")
        }
    }
    
    private fun stopBridge() {
        // Note: The bridge activity will handle its own cleanup when the activity is destroyed
        ToastUtils.showToast("To stop bridge, close the Bridge Activity")
    }
    
    private fun updateStatus() {
        val isRegistered = SDKManager.getInstance().isRegistered
        
        mainBinding.tvBridgeStatus.text = if (isRegistered) {
            "✅ DJI SDK Registered - Bridge Ready"
        } else {
            "⏳ Waiting for DJI SDK Registration..."
        }
        
        mainBinding.btnStartBridge.isEnabled = isRegistered
    }
    
    override fun onResume() {
        super.onResume()
        updateStatus()
    }
    
    override fun onDestroyView() {
        super.onDestroyView()
        binding = null
    }
}