import React from 'react';
import { TopBarProps } from '../types';
import { SettingsModal } from './SettingsModal';
import { ComponentsMenu } from './ComponentsMenu';

const statusLevelClass = (level?: string | null) => {
  switch ((level || 'normal').toLowerCase()) {
    case 'serious':
    case 'serious_warning':
    case 'critical':
      return 'text-status-error';
    case 'warning':
    case 'caution':
      return 'text-status-warning';
    case 'notice':
      return 'text-status-good';
    default:
      return 'text-status-good';
  }
};

const signalBarClass = (index: number, activeBars: number) => (
  index <= activeBars ? 'bg-status-good' : 'bg-gray-600'
);

const formatStatusLabel = (label?: string | null) => {
  if (!label) return 'UNKNOWN';
  return label.replace(/_/g, ' ');
};

export const TopBar: React.FC<TopBarProps> = ({ 
  batteryData, 
  telemetryData, 
  connectionStatus 
}) => {
  const systemStatus = telemetryData?.system_status || null;
  const diagnostics = telemetryData?.diagnostics || [];
  const diagnosticsSeverity = telemetryData?.diagnostics_severity || systemStatus?.level || 'normal';
  const systemDescription = systemStatus?.description || diagnostics[0]?.description || diagnostics[0]?.title || 'All systems nominal';

  const flightMode = telemetryData?.flight_mode || 'UNKNOWN';

  const satelliteCount = telemetryData?.satellite_count ?? 0;
  const gpsSignalLevel = telemetryData?.gps_signal_level || 'UNKNOWN';
  const rcSignalQuality = telemetryData?.rc_signal_quality ?? null;
  const rcBars = rcSignalQuality != null ? Math.round(Math.min(Math.max(rcSignalQuality, 0), 100) / 20) : 0;

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
    if (!telemetryData) return { label: 'NO FIX', color: 'text-gray-400' };

    const level = (gpsSignalLevel || '').toUpperCase();
    switch (level) {
      case 'LEVEL_3':
        return { label: `Strong (${satelliteCount})`, color: 'text-status-good' };
      case 'LEVEL_2':
        return { label: `Fair (${satelliteCount})`, color: 'text-status-warning' };
      case 'LEVEL_1':
        return { label: `Weak (${satelliteCount})`, color: 'text-status-error' };
      default:
        return { label: satelliteCount > 0 ? `${satelliteCount} sats` : 'No signal', color: 'text-gray-400' };
    }
  };

  const battery = getBatteryStatus();
  const gps = getGPSStatus();
  const [openSettings, setOpenSettings] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<'endpoints'|'models'>('endpoints');
  const [menuOpen, setMenuOpen] = React.useState(false);

  return (
    <div className="h-16 bg-black bg-opacity-90 border-b border-gray-700 flex items-center justify-between px-6 text-sm">
      {/* Left cluster: system status + flight mode */}
      <div className="flex items-center gap-6">
        <div>
          <div className={`text-xs uppercase ${statusLevelClass(diagnosticsSeverity)} font-semibold`}>System</div>
          <div className="text-sm text-gray-200 font-medium">{formatStatusLabel(systemStatus?.label)}</div>
          <div className="text-[11px] text-gray-400 max-w-xs truncate">{systemDescription}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-gray-400">Flight Mode</div>
          <div className="text-sm text-dji-blue font-semibold">{flightMode}</div>
        </div>
      </div>

      {/* Center cluster: quick status widgets */}
      <div className="flex items-center gap-8">
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
        </div>

        {/* GPS Status */}
        <div className="flex flex-col leading-tight">
          <div className="text-xs uppercase text-gray-400">GPS</div>
          <div className={gps.color}>{gps.label}</div>
        </div>

        {/* RC Signal */}
        <div className="flex flex-col leading-tight">
          <div className="text-xs uppercase text-gray-400">RC</div>
          <div className="flex items-center gap-1">
            <div className="flex gap-1">
              {[1,2,3,4,5].map((bar) => (
                <div key={bar} className={`w-1 h-3 rounded-sm ${signalBarClass(bar, rcBars)}`}></div>
              ))}
            </div>
            <span className="text-gray-300 text-[11px]">{rcSignalQuality != null ? `${rcSignalQuality}%` : '—'}</span>
          </div>
        </div>
      </div>

      {/* Right cluster: connection + settings */}
      <div className="flex items-center gap-6">
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

        {/* Timestamp */}
        {telemetryData && (
          <div className="text-xs text-gray-500">
            {formatTime(telemetryData.timestamp)}
          </div>
        )}

        {/* Window Controls */}
        <div className="flex items-center gap-1 ml-2">
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

        {/* Components menu */}
        <ComponentsMenu />

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
      </div>

      <SettingsModal open={openSettings} onClose={() => setOpenSettings(false)} initialTab={settingsTab} />
    </div>
  );
};
