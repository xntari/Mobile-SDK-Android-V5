import React from 'react';
import { TopBarProps } from '../types';
import { SettingsModal } from './SettingsModal';
import { ComponentsMenu } from './ComponentsMenu';
import { preflightPanelControls, flightCommandsPanelControls, missionControlPanelControls } from './panelControls';
import { useBridgeCommands } from '../hooks/useBridgeCommands';
import { useManualControl } from '../context/ManualControlContext';

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

const formatStatusLabel = (label?: string | null) => {
  if (!label) return 'UNKNOWN';
  return label.replace(/_/g, ' ');
};

const formatFlightMode = (mode?: string | null) => {
  if (!mode) return 'UNKNOWN';
  return mode
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

export const TopBar: React.FC<TopBarProps> = ({ 
  batteryData, 
  telemetryData, 
  connectionStatus,
  controllerData,
  preflightStatus
}) => {
  const systemStatus = telemetryData?.system_status || null;
  const diagnostics = telemetryData?.diagnostics || [];
  const diagnosticsSeverity = telemetryData?.diagnostics_severity || systemStatus?.level || 'normal';
  const systemDescription = systemStatus?.description || diagnostics[0]?.description || diagnostics[0]?.title || 'All systems nominal';

  const flightMode = formatFlightMode(
    telemetryData?.flight_mode || telemetryData?.flight_mode_label || 'UNKNOWN'
  );

  const satelliteCount = telemetryData?.satellite_count ?? 0;
  const gpsSignalLevel = telemetryData?.gps_signal_level || 'UNKNOWN';
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
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

  const gps = getGPSStatus();
  const [openSettings, setOpenSettings] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<'endpoints'|'models'>('endpoints');
  const [menuOpen, setMenuOpen] = React.useState(false);

  const { sendFlightCommand } = useBridgeCommands();
  const manualControl = useManualControl();
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [vsBusy, setVsBusy] = React.useState(false);

  const preflightPower = preflightStatus?.power;

  const aircraftBatteryPercent = React.useMemo(() => {
    if (typeof batteryData?.battery?.percentage === 'number') {
      return Math.round(batteryData.battery.percentage);
    }
    if (typeof preflightPower?.aircraft_percent === 'number') {
      return Math.round(preflightPower.aircraft_percent);
    }
    return undefined;
  }, [batteryData, preflightPower]);

  const controllerBatteryPercent = React.useMemo(() => {
    if (typeof preflightPower?.controller_percent === 'number') {
      return Math.round(preflightPower.controller_percent);
    }
    if (typeof controllerData?.battery_percent === 'number') {
      return Math.round(controllerData.battery_percent);
    }
    return undefined;
  }, [preflightPower, controllerData]);

  const batteryColorClass = (percent?: number) => {
    if (percent === undefined) return 'text-gray-400';
    if (percent > 50) return 'text-status-good';
    if (percent > 20) return 'text-status-warning';
    return 'text-status-error';
  };

  const altitudeDisplay = React.useMemo(() => {
    if (!telemetryData) return '—';
    const altitude = telemetryData.altitude ?? telemetryData.altitude_above_takeoff ?? telemetryData.altitude_above_home;
    return typeof altitude === 'number' && !Number.isNaN(altitude) ? `${altitude.toFixed(1)} m` : '—';
  }, [telemetryData]);

  const speedDisplay = React.useMemo(() => {
    if (!telemetryData) return '—';
    const speed = telemetryData.speed;
    return typeof speed === 'number' && !Number.isNaN(speed) ? `${speed.toFixed(1)} m/s` : '—';
  }, [telemetryData]);

  const missionStateRaw = telemetryData?.waypoint_status?.state || 'idle';
  const missionLabel = formatStatusLabel(missionStateRaw);
  const missionId = telemetryData?.waypoint_status?.executing?.mission_id || telemetryData?.waypoint_status?.mission_id;

  const takeoffDisabled = React.useMemo(() => {
    const altitude = telemetryData?.altitude ?? telemetryData?.altitude_above_takeoff ?? 0;
    return (altitude > 1.5) || telemetryData?.motors_on === true;
  }, [telemetryData?.altitude, telemetryData?.altitude_above_takeoff, telemetryData?.motors_on]);

  const landDisabled = React.useMemo(() => {
    if (!telemetryData) return true;
    const altitude = telemetryData.altitude ?? telemetryData.altitude_above_takeoff ?? 0;
    return !telemetryData.motors_on || altitude < 0.5;
  }, [telemetryData]);

  const rthDisabled = React.useMemo(() => {
    if (!telemetryData) return true;
    if (telemetryData.is_auto_returning_home) return true;
    return telemetryData.motors_on === false;
  }, [telemetryData]);

  const vsActive = manualControl.state.active || manualControl.state.status === 'arming';

  const handleQuickCommand = React.useCallback(async (action: string, params?: Record<string, any>) => {
    if (busyAction) return;
    try {
      setBusyAction(action);
      await sendFlightCommand(action, params);
    } catch (error) {
      console.error(`[TopBar] Quick command "${action}" failed`, error);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, sendFlightCommand]);

  const handleTakeoff = React.useCallback(() => {
    handleQuickCommand('takeoff');
  }, [handleQuickCommand]);

  const handleLand = React.useCallback(() => {
    handleQuickCommand('land_in_place');
  }, [handleQuickCommand]);

  const handleRth = React.useCallback(() => {
    handleQuickCommand('return_home_start');
  }, [handleQuickCommand]);

  const handleToggleManualControl = React.useCallback(async () => {
    if (vsBusy) return;
    setVsBusy(true);
    try {
      if (vsActive) {
        await manualControl.stop();
      } else {
        await manualControl.start();
      }
    } catch (error) {
      console.error('[TopBar] Virtual stick toggle failed', error);
    } finally {
      setVsBusy(false);
    }
  }, [manualControl, vsActive, vsBusy]);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }
      switch (event.code) {
        case 'KeyT':
          if (!takeoffDisabled) {
            event.preventDefault();
            handleTakeoff();
          }
          break;
        case 'KeyL':
          if (!landDisabled) {
            event.preventDefault();
            handleLand();
          }
          break;
        case 'KeyR':
          if (!rthDisabled) {
            event.preventDefault();
            handleRth();
          }
          break;
        case 'KeyV':
          event.preventDefault();
          handleToggleManualControl();
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleLand, handleRth, handleTakeoff, handleToggleManualControl, landDisabled, rthDisabled, takeoffDisabled]);

  const QuickButton: React.FC<{
    label: string;
    hotkey: string;
    onClick: () => void;
    tone?: 'primary' | 'danger' | 'success';
    disabled?: boolean;
    busy?: boolean;
  }> = ({ label, hotkey, onClick, tone = 'primary', disabled, busy }) => {
    const toneClass = {
      primary: 'border border-gray-700/80 bg-gray-900/70 text-gray-200 hover:bg-gray-800/80',
      success: 'border border-status-good/60 bg-status-good/15 text-status-good hover:bg-status-good/25',
      danger: 'border border-status-error/60 bg-status-error/15 text-status-error hover:bg-status-error/25',
    }[tone];

    const baseClass = `px-3 py-1.5 rounded-lg transition-colors duration-150 text-xs font-semibold flex items-center justify-between min-w-[96px] ${toneClass}`;
    const stateClass = disabled || busy ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer';

    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        className={`${baseClass} ${stateClass}`}
      >
        <span className="uppercase tracking-wide">{busy ? '…' : label}</span>
        <span className="text-[10px] uppercase tracking-wide text-gray-400 font-mono">{hotkey}</span>
      </button>
    );
  };

  return (
    <div className="h-16 bg-black/95 border-b border-gray-800 flex items-center justify-between px-6 text-sm gap-6">
      {/* Left cluster: system status + flight mode */}
      <div className="flex items-center gap-6 min-w-0">
        <button
          type="button"
          className="text-left hover:bg-gray-900/70 rounded-lg px-3 py-2 focus:outline-none focus:ring focus:ring-dji-blue/30"
          onClick={() => preflightPanelControls.setVisible(true)}
        >
          <div className={`text-[11px] uppercase tracking-wide ${statusLevelClass(diagnosticsSeverity)} font-semibold`}>System</div>
          <div className="text-sm text-gray-100 font-semibold leading-tight">{formatStatusLabel(systemStatus?.label)}</div>
          <div className="text-[11px] text-gray-400 max-w-[220px] truncate">{systemDescription}</div>
        </button>
        <div className="flex flex-col min-w-[180px]">
          <div className="text-[11px] uppercase text-gray-400 tracking-wide">Flight Mode</div>
          <div className="text-sm text-dji-blue font-semibold leading-tight">{flightMode}</div>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap overflow-x-auto pr-1">
          <QuickButton
            label="Takeoff"
            hotkey="⇧T"
            onClick={handleTakeoff}
            tone="success"
            disabled={takeoffDisabled || !!busyAction}
            busy={busyAction === 'takeoff'}
          />
          <QuickButton
            label="Land"
            hotkey="⇧L"
            onClick={handleLand}
            tone="primary"
            disabled={landDisabled || !!busyAction}
            busy={busyAction === 'land_in_place'}
          />
          <QuickButton
            label="RTH"
            hotkey="⇧R"
            onClick={handleRth}
            tone="primary"
            disabled={rthDisabled || !!busyAction}
            busy={busyAction === 'return_home_start'}
          />
          <QuickButton
            label={vsActive ? 'VS Off' : 'VS On'}
            hotkey="⇧V"
            onClick={handleToggleManualControl}
            tone={vsActive ? 'danger' : 'primary'}
            disabled={vsBusy}
            busy={vsBusy}
          />
        </div>
      </div>

      {/* Center cluster: quick status widgets */}
      <div className="flex items-center gap-8 min-w-0">
        {/* Battery & Power */}
        <div className="flex flex-col leading-tight">
          <div className="text-[11px] uppercase text-gray-400 tracking-wide">Battery</div>
          <div className="flex items-center gap-3 text-sm font-semibold">
            <span className={batteryColorClass(aircraftBatteryPercent)}>
              A {aircraftBatteryPercent !== undefined ? `${aircraftBatteryPercent}%` : '—'}
            </span>
            <span className={batteryColorClass(controllerBatteryPercent)}>
              RC {controllerBatteryPercent !== undefined ? `${controllerBatteryPercent}%` : '—'}
            </span>
          </div>
        </div>

        {/* GPS Status */}
        <div className="flex flex-col leading-tight">
          <div className="text-[11px] uppercase text-gray-400 tracking-wide">GPS</div>
          <div className={`${gps.color} font-semibold`}>{gps.label}</div>
        </div>

        {/* Mission Status */}
        <button
          type="button"
          className="text-left hover:bg-gray-900/70 rounded-lg px-3 py-2 focus:outline-none focus:ring focus:ring-dji-blue/30"
          onClick={() => missionControlPanelControls.setVisible(true)}
        >
          <div className="text-[11px] uppercase text-gray-400 tracking-wide">Mission</div>
          <div className="text-sm text-gray-100 font-semibold leading-tight">{missionLabel}</div>
          {missionId && (
            <div className="text-[11px] text-gray-500">ID {missionId}</div>
          )}
        </button>

        {/* Altitude & Speed */}
        <button
          type="button"
          className="text-left hover:bg-gray-900/70 rounded-lg px-3 py-2 focus:outline-none focus:ring focus:ring-dji-blue/30"
          onClick={() => flightCommandsPanelControls.setVisible(true)}
        >
          <div className="text-[11px] uppercase text-gray-400 tracking-wide">Altitude / Speed</div>
          <div className="flex items-baseline gap-4 text-sm font-semibold leading-tight text-gray-100">
            <span className="flex items-baseline gap-2">
              <span className="text-[11px] uppercase tracking-wide text-gray-400">Alt</span>
              <span>{altitudeDisplay}</span>
            </span>
            <span className="flex items-baseline gap-2 text-gray-200">
              <span className="text-[11px] uppercase tracking-wide text-gray-400">Spd</span>
              <span>{speedDisplay}</span>
            </span>
          </div>
        </button>
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
