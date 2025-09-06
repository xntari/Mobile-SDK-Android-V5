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
      <div className="flex-1 relative bg-black">
        <FPVDisplay className="w-full h-full">
          {/* Navigation panel - Top Left Corner */}
          <div className="absolute top-4 left-4 z-20">
            <div className="flex flex-col space-y-2">
              {/* Minimap */}
              <MapDisplay 
                aircraftLocation={bridgeData.telemetry?.location || null}
                homeLocation={bridgeData.telemetry?.home_location || null}
                compassHeading={bridgeData.telemetry?.compass_heading || 0}
              />
              
              {/* HSI Compass - Smaller size to fit under map */}
              <div className="w-48 flex justify-center">
                <HSICompass 
                  attitude={bridgeData.telemetry?.attitude || null}
                  heading={bridgeData.telemetry?.heading || 0}
                  homeDirection={bridgeData.telemetry?.home_bearing}
                  size="small"
                />
              </div>
            </div>
          </div>
          
          {/* Flight data overlay - Top Center */}
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20">
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
        </FPVDisplay>
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