import React from 'react';
import { TopBarProps } from '../types';
import { SettingsModal } from './SettingsModal';

export const TopBar: React.FC<TopBarProps> = ({ 
  batteryData, 
  telemetryData, 
  controllerData, 
  connectionStatus 
}) => {
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  const getBatteryStatus = () => {
    if (!batteryData?.battery) return { level: 0, status: 'unknown', color: 'text-gray-400' };
    
    const level = batteryData.battery.percentage;
    if (level > 50) return { level, status: 'good', color: 'text-status-good' };
    if (level > 20) return { level, status: 'warning', color: 'text-status-warning' };
    return { level, status: 'critical', color: 'text-status-error' };
  };

  const getGPSStatus = () => {
    if (!telemetryData) return { satellites: 0, quality: 'No Signal', color: 'text-gray-400' };
    
    const satellites = telemetryData.satellite_count || 0;
    const quality = telemetryData.gps_signal_quality || 0;
    
    if (satellites >= 10 && quality > 3) {
      return { satellites, quality: 'Strong', color: 'text-status-good' };
    } else if (satellites >= 6 && quality > 2) {
      return { satellites, quality: 'Good', color: 'text-status-warning' };
    } else {
      return { satellites, quality: 'Weak', color: 'text-status-error' };
    }
  };

  const getFlightMode = () => {
    return telemetryData?.flight_mode || 'UNKNOWN';
  };

  const battery = getBatteryStatus();
  const gps = getGPSStatus();
  const [openSettings, setOpenSettings] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<'endpoints'|'models'>('endpoints');
  const [menuOpen, setMenuOpen] = React.useState(false);

  return (
    <div className="h-16 bg-black bg-opacity-90 border-b border-gray-700 flex items-center justify-between px-6 text-sm">
      {/* Left Side - System Status */}
      <div className="flex items-center gap-6">
        {/* Battery Status */}
        <div className="flex items-center gap-2">
          <div className={`w-6 h-3 border border-gray-400 rounded-sm relative ${battery.color}`}>
            <div 
              className={`h-full rounded-sm transition-all duration-300 ${
                battery.status === 'good' ? 'bg-status-good' :
                battery.status === 'warning' ? 'bg-status-warning' : 'bg-status-error'
              }`}
              style={{ width: `${battery.level}%` }}
            />
            <div className="absolute -right-1 top-0.5 w-1 h-1 bg-gray-400 rounded-sm"></div>
          </div>
          <span className={battery.color}>
            {battery.level}%
          </span>
          {batteryData?.battery && (
            <span className="text-gray-400 text-xs">
              {batteryData.battery.voltage.toFixed(1)}V
            </span>
          )}
        </div>

        {/* GPS Status */}
        <div className="flex items-center gap-2">
          <div className="text-lg">📡</div>
          <div>
            <span className={gps.color}>{gps.quality}</span>
            <span className="text-gray-400 ml-1 text-xs">
              ({gps.satellites} sats)
            </span>
          </div>
        </div>

        {/* Connection Status */}
        <div className="flex items-center gap-2">
          <div className={`status-indicator ${
            connectionStatus === 'connected' ? 'bg-status-good' :
            (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') ? 'bg-status-warning animate-pulse' :
            'bg-status-error'
          }`}></div>
          <span className="text-xs text-gray-300">
            {connectionStatus.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Center - Flight Mode */}
      <div className="text-center">
        <div className="text-lg font-bold text-dji-blue">
          {getFlightMode()}
        </div>
        {telemetryData && (
          <div className="text-xs text-gray-400">
            {formatTime(telemetryData.timestamp)}
          </div>
        )}
      </div>

      {/* Right Side - Telemetry + Menu */}
      <div className="flex items-center gap-6">
        {/* RC Signal */}
        <div className="flex items-center gap-2">
          <div className="text-lg">📶</div>
          <div>
            <span className="text-status-good">Strong</span>
            <div className="text-xs text-gray-400">
              {controllerData?.virtual_stick_enabled ? 'VIRTUAL' : 'MANUAL'}
            </div>
          </div>
        </div>

        {/* Altitude */}
        {telemetryData && (
          <div className="text-center">
            <div className="text-xs text-gray-400">ALT</div>
            <div className="font-mono text-white">
              {telemetryData.altitude.toFixed(1)}m
            </div>
          </div>
        )}

        {/* Distance to Home */}
        {telemetryData && (
          <div className="text-center">
            <div className="text-xs text-gray-400">DIST</div>
            <div className="font-mono text-white">
              {telemetryData.distance_to_home.toFixed(0)}m
            </div>
          </div>
        )}

        {/* Settings menu */}
        <div className="relative">
          <button className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-200 hover:bg-gray-600" onClick={()=>setMenuOpen(v=>!v)}>Settings ▾</button>
          {menuOpen && (
            <div className="absolute right-0 mt-1 w-40 bg-gray-900 border border-gray-700 rounded shadow-lg text-xs z-50" onMouseLeave={()=>setMenuOpen(false)}>
              <button className="block w-full text-left px-3 py-2 hover:bg-gray-800" onClick={()=>{ setMenuOpen(false); setSettingsTab('models'); setOpenSettings(true); }}>Models</button>
              <button className="block w-full text-left px-3 py-2 hover:bg-gray-800" onClick={()=>{ setMenuOpen(false); setSettingsTab('endpoints'); setOpenSettings(true); }}>Endpoints</button>
            </div>
          )}
        </div>

        {/* Window Controls */}
        <div className="flex items-center gap-1 ml-4">
          <button 
            className="w-3 h-3 bg-yellow-500 rounded-full hover:bg-yellow-400"
            onClick={() => window.electronAPI.minimizeWindow()}
            title="Minimize"
          />
          <button 
            className="w-3 h-3 bg-green-500 rounded-full hover:bg-green-400"
            onClick={() => window.electronAPI.maximizeWindow()}
            title="Maximize"
          />
          <button 
            className="w-3 h-3 bg-red-500 rounded-full hover:bg-red-400"
            onClick={() => window.electronAPI.closeWindow()}
            title="Close"
          />
        </div>
      </div>
      <SettingsModal open={openSettings} onClose={()=>setOpenSettings(false)} initialTab={settingsTab} />
    </div>
  );
};
