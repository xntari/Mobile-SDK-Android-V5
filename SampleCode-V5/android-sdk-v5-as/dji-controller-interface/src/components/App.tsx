import React, { useState } from 'react';
import { useStableBridgeData } from '../hooks/useStableBridgeData';
import { TopBar } from './TopBar';
import { FPVDisplay } from './FPVDisplay';
import { H20NDisplay } from './H20NDisplay';
import { TakeOffButton } from './TakeOffButton';
import { ReturnHomeButton } from './ReturnHomeButton';
import { HSICompass } from './HSICompass';
import { MapDisplay } from './MapDisplay';
import { FlightDisplay } from './FlightDisplay';
import { CameraControls } from './CameraControls';
import { ConnectionStatus } from './ConnectionStatus';

export const App: React.FC = () => {
  const { bridgeData, connectionStatus } = useStableBridgeData();
  const [displayMode, setDisplayMode] = useState<'fpv' | 'h20n'>('fpv');

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
          {/* Camera Display Toggle */}
          <div className="absolute top-4 right-4 z-30">
            <div className="glass-panel p-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400">Camera:</span>
                <button
                  onClick={() => setDisplayMode('fpv')}
                  className={`px-3 py-1 rounded ${
                    displayMode === 'fpv' 
                      ? 'bg-dji-blue text-white' 
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  FPV
                </button>
                <button
                  onClick={() => setDisplayMode('h20n')}
                  className={`px-3 py-1 rounded ${
                    displayMode === 'h20n' 
                      ? 'bg-dji-blue text-white' 
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  H20N
                </button>
              </div>
            </div>
          </div>

          {/* Conditional Camera Display */}
          {displayMode === 'fpv' ? (
            <FPVDisplay className="w-full h-full" />
          ) : (
            <H20NDisplay className="w-full h-full" />
          )}

          {/* Shared overlays that appear on both displays */}
          {/* Navigation panel - Top Left Corner */}
          <div className="absolute top-4 left-4 z-20">
            <div className="flex flex-col space-y-2">
              {/* Minimap */}
              <MapDisplay 
                aircraftLocation={bridgeData.telemetry?.location || null}
                homeLocation={bridgeData.telemetry?.home_location || null}
                compassHeading={bridgeData.telemetry?.compass_heading || bridgeData.telemetry?.heading || 0}
              />
              
              {/* HSI Compass - Match Live Map width */}
              <div className="w-52">
                <HSICompass 
                  attitude={bridgeData.telemetry?.attitude || null}
                  heading={bridgeData.telemetry?.compass_heading || bridgeData.telemetry?.heading || 0}
                  homeDirection={bridgeData.telemetry?.home_bearing}
                  size="small"
                  telemetryData={bridgeData.telemetry}
                />
              </div>
            </div>
          </div>
          
          {/* HUD Overlay - Center of screen */}
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-30">
            <FlightDisplay 
              telemetryData={bridgeData.telemetry}
              size="compact"
            />
          </div>

          {/* Controller data overlay - Top Center */}
          {bridgeData.controller && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20">
              <div className="glass-panel p-2 text-xs">
                <div className="flex items-center gap-4">
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
              </div>
            </div>
          )}
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