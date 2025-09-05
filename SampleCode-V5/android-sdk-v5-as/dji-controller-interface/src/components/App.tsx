import React from 'react';
import { useStableBridgeData } from '../hooks/useStableBridgeData';
import { TopBar } from './TopBar';
import { FPVDisplay } from './FPVDisplay';
import { TakeOffButton } from './TakeOffButton';
import { ReturnHomeButton } from './ReturnHomeButton';
import { HSICompass } from './HSICompass';
import { MapDisplay } from './MapDisplay';
import { CameraControls } from './CameraControls';
import { ConnectionStatus } from './ConnectionStatus';

export const App: React.FC = () => {
  const { bridgeData, connectionStatus } = useStableBridgeData();

  // Show connection screen while not connected or no data at all
  const hasAnyData = bridgeData.controller || bridgeData.telemetry || bridgeData.battery;
  const shouldShowUI = connectionStatus === 'connected' && hasAnyData;
  
  if (!shouldShowUI) {
    return (
      <div className="h-screen bg-dji-dark flex items-center justify-center">
        <ConnectionStatus status={connectionStatus} />
      </div>
    );
  }

  try {
    return (
      <div className="h-screen bg-dji-dark text-white flex flex-col overflow-hidden no-select">
      {/* Top Status Bar */}
      <TopBar 
        batteryData={bridgeData.battery}
        telemetryData={bridgeData.telemetry}
        controllerData={bridgeData.controller}
        connectionStatus={connectionStatus}
      />
      
      {/* Main Content Area */}
      <div className="flex-1 flex relative">
        {/* Left Side - Flight Controls */}
        <div className="w-32 bg-black bg-opacity-60 flex flex-col gap-3 p-3 z-10">
          <TakeOffButton />
          <ReturnHomeButton />
          
          {/* Controller Status */}
          <div className="mt-auto">
            <div className="glass-panel p-2 text-xs">
              <div className="text-gray-300">RC Signal</div>
              <div className="status-good font-mono">
                {bridgeData.controller?.virtual_stick_enabled ? 'VIRTUAL' : 'MANUAL'}
              </div>
            </div>
          </div>
        </div>
        
        {/* Center - Video Display */}
        <div className="flex-1 relative">
          <FPVDisplay className="w-full h-full" />
          
          {/* Mini FPV overlay (secondary camera) */}
          <div className="absolute top-4 left-4 z-20">
            <div className="w-36 h-24 bg-gray-900 border border-gray-600 rounded flex items-center justify-center text-xs text-gray-400">
              Secondary FPV
            </div>
          </div>
          
          {/* Flight data overlay */}
          <div className="absolute top-4 left-44 z-20">
            <div className="glass-panel p-3 text-sm">
              <div className="flex items-center gap-4 mb-2">
                {bridgeData.telemetry && (
                  <>
                    <div>
                      <span className="text-gray-300">ALT: </span>
                      <span className="font-mono">{bridgeData.telemetry.altitude.toFixed(1)}m</span>
                    </div>
                    <div>
                      <span className="text-gray-300">SPD: </span>
                      <span className="font-mono">{bridgeData.telemetry.speed.toFixed(1)}m/s</span>
                    </div>
                    <div>
                      <span className="text-gray-300">DIST: </span>
                      <span className="font-mono">{bridgeData.telemetry.distance_to_home.toFixed(1)}m</span>
                    </div>
                  </>
                )}
              </div>
              {/* Controller joystick data */}
              {bridgeData.controller && (
                <div className="flex items-center gap-4 text-xs border-t border-gray-600 pt-2">
                  <div>
                    <span className="text-gray-400">L: </span>
                    <span className="font-mono text-dji-blue">
                      {bridgeData.controller.joystick.left_horizontal.toFixed(0)},{bridgeData.controller.joystick.left_vertical.toFixed(0)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">R: </span>
                    <span className="font-mono text-dji-blue">
                      {bridgeData.controller.joystick.right_horizontal.toFixed(0)},{bridgeData.controller.joystick.right_vertical.toFixed(0)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        
        {/* Right Side - Camera Controls & Map */}
        <div className="w-80 bg-black bg-opacity-60 flex flex-col z-10">
          <CameraControls cameraData={bridgeData.camera} />
          
          {/* Map at bottom right */}
          <div className="mt-auto p-4">
            <MapDisplay 
              aircraftLocation={bridgeData.telemetry?.location || null}
              homeLocation={bridgeData.telemetry?.home_location || null}
            />
          </div>
        </div>
      </div>
      
      {/* Bottom - HSI Compass */}
      <div className="h-48 bg-black bg-opacity-80 flex items-center justify-center border-t border-gray-700">
        <HSICompass 
          attitude={bridgeData.telemetry?.attitude || null}
          heading={bridgeData.telemetry?.heading || 0}
          homeDirection={bridgeData.telemetry?.home_bearing}
        />
      </div>
    </div>
    );
  } catch (error) {
    return (
      <div className="h-screen bg-dji-dark flex items-center justify-center">
        <div className="text-white text-center">
          <div className="text-xl mb-4">UI Render Error</div>
          <div className="text-sm text-gray-400">{error.message}</div>
        </div>
      </div>
    );
  }
};