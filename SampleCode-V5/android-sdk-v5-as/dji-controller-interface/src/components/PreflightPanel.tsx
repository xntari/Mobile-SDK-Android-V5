import React from 'react';
import { Panel } from './Panel';
import { CollapsibleSection } from './CollapsibleSection';
import { PreflightStatus, FlightCommandAck, TelemetryDiagnosticEntry, TelemetryData, BatteryData, ControllerData } from '../types';
import { useBridgeCommands } from '../hooks/useBridgeCommands';

interface PreflightPanelProps {
  preflight: PreflightStatus | null;
  history: FlightCommandAck[];
  telemetry: TelemetryData | null;
  battery: BatteryData | null;
  controller: ControllerData | null;
}

const levelClass = (level?: string | null) => {
  if (!level) return 'text-gray-300';
  const normalized = level.toLowerCase();
  if (normalized.includes('error') || normalized.includes('critical')) return 'text-status-error';
  if (normalized.includes('warn')) return 'text-yellow-300';
  if (normalized.includes('caution')) return 'text-yellow-300';
  if (normalized.includes('good') || normalized.includes('normal')) return 'text-status-good';
  return 'text-gray-300';
};

const formatDiagnosticLabel = (diag: TelemetryDiagnosticEntry) => {
  if (diag.title) return diag.title;
  if (diag.description) return diag.description;
  if (diag.code) return diag.code;
  return 'Diagnostic item';
};

const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return '';
  const delta = Date.now() - timestamp;
  if (delta < 1000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
};

const formatMeters = (value?: number | null) => (typeof value === 'number' && !Number.isNaN(value) ? `${value.toFixed(1)} m` : '—');
const formatMetersNoDecimal = (value?: number | null) => (typeof value === 'number' && !Number.isNaN(value) ? `${Math.round(value)} m` : '—');
const formatPercent = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${Math.round(value)}%`;
};
const formatActionLabel = (value?: string) => {
  if (!value) return '—';
  return value
    .toString()
    .trim()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase();
};

const InfoRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between text-[11px]">
    <span className="text-gray-400">{label}</span>
    <span className="text-gray-200 font-medium">{value}</span>
  </div>
);

const renderObject = (value: unknown): string => {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
};

export const PreflightPanel: React.FC<PreflightPanelProps> = ({ preflight, history, telemetry, battery, controller }) => {
  const latestLandingMonitor = React.useMemo(() => {
    return [...history].reverse().find((ack) => ack.action === 'land_monitor');
  }, [history]);

  const diagnostics = preflight?.diagnostics ?? [];
  const deviceStatus = preflight?.device_status;
  const flightSettings = preflight?.flight_settings;
  const flightLimits = {
    rth: flightSettings?.return_home_altitude ?? telemetry?.go_home_height,
    maxAltitude: flightSettings?.max_altitude ?? telemetry?.max_flight_height,
    maxDistance: flightSettings?.max_distance ?? telemetry?.max_flight_distance,
    maxDistanceEnabled: flightSettings?.max_distance_enabled ?? telemetry?.max_flight_distance_enabled,
    signalLost: flightSettings?.signal_lost_action,
  };
  const obstacleSettings = flightSettings?.obstacle_avoidance;
  const telemetryObstacle = telemetry?.obstacle_avoidance;

  const powerStatus = preflight?.power;
  const aircraftBatteryPercent = React.useMemo(() => {
    if (typeof powerStatus?.aircraft_percent === 'number') return powerStatus.aircraft_percent;
    const value = battery?.battery?.percentage;
    return typeof value === 'number' ? value : undefined;
  }, [powerStatus?.aircraft_percent, battery?.battery?.percentage]);

  const controllerBatteryPercent = React.useMemo(() => {
    if (typeof powerStatus?.controller_percent === 'number') return powerStatus.controller_percent;
    if (typeof controller?.battery_percent === 'number') return controller.battery_percent;
    return undefined;
  }, [powerStatus?.controller_percent, controller?.battery_percent]);
  const controllerSettings = preflight?.controller_settings;

  const { sendFlightCommand } = useBridgeCommands();

  const [rthAltitudeInput, setRthAltitudeInput] = React.useState<string>('');
  const [maxAltitudeInput, setMaxAltitudeInput] = React.useState<string>('');
  const [maxDistanceInput, setMaxDistanceInput] = React.useState<string>('');
  const [distanceLimitEnabledInput, setDistanceLimitEnabledInput] = React.useState<boolean>(false);
  const [signalLostActionInput, setSignalLostActionInput] = React.useState<string>('GO_HOME');
  const [settingsStatus, setSettingsStatus] = React.useState<string | null>(null);

  const remoteIdSnapshot = preflight?.remote_id ?? null;
  const [areaStrategyInput, setAreaStrategyInput] = React.useState<string>(remoteIdSnapshot?.areaStrategy ?? 'US_STRATEGY');
  const [operatorRegistrationInput, setOperatorRegistrationInput] = React.useState<string>(remoteIdSnapshot?.operatorRegistrationNumber ?? '');
  const [remoteIdStatusMessage, setRemoteIdStatusMessage] = React.useState<string | null>(null);
  const [flySafeStatusMessage, setFlySafeStatusMessage] = React.useState<string | null>(null);

  const signalLostOptions = React.useMemo(() => ['GO_HOME', 'HOVER', 'LAND', 'GO_BACK', 'GO_CONTINUE'], []);
  const areaStrategyOptions = React.useMemo(
    () => ['US_STRATEGY', 'EUROPEAN_STRATEGY', 'CHINA_STRATEGY', 'JAPAN_STRATEGY', 'FRANCE_STRATEGY'],
    []
  );

  const resetFlightInputs = React.useCallback(() => {
    setRthAltitudeInput(
      flightLimits.rth != null && Number.isFinite(flightLimits.rth)
        ? Math.round(flightLimits.rth).toString()
        : ''
    );
    setMaxAltitudeInput(
      flightLimits.maxAltitude != null && Number.isFinite(flightLimits.maxAltitude)
        ? Math.round(flightLimits.maxAltitude).toString()
        : ''
    );
    setMaxDistanceInput(
      flightLimits.maxDistance != null && Number.isFinite(flightLimits.maxDistance)
        ? Math.round(flightLimits.maxDistance).toString()
        : ''
    );
    setDistanceLimitEnabledInput(Boolean(flightLimits.maxDistanceEnabled));
    if (flightLimits.signalLost) {
      setSignalLostActionInput(String(flightLimits.signalLost).toUpperCase());
    } else {
      setSignalLostActionInput('GO_HOME');
    }
    setSettingsStatus(null);
  }, [
    flightLimits.rth,
    flightLimits.maxAltitude,
    flightLimits.maxDistance,
    flightLimits.maxDistanceEnabled,
    flightLimits.signalLost,
  ]);

  React.useEffect(() => {
    resetFlightInputs();
  }, [resetFlightInputs]);

  React.useEffect(() => {
    if (remoteIdSnapshot?.areaStrategy) {
      setAreaStrategyInput(remoteIdSnapshot.areaStrategy);
    }
    if (remoteIdSnapshot?.operatorRegistrationNumber !== undefined) {
      setOperatorRegistrationInput(remoteIdSnapshot.operatorRegistrationNumber ?? '');
    }
    setRemoteIdStatusMessage(null);
  }, [remoteIdSnapshot?.areaStrategy, remoteIdSnapshot?.operatorRegistrationNumber]);

  const parseNumberInput = React.useCallback((value: string, field: string): number | null => {
    if (!value.trim()) {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric value for ${field}`);
    }
    return parsed;
  }, []);

  const handleApplyFlightSettings = React.useCallback(async () => {
    const payload: Record<string, any> = {};

    try {
      const rthValue = parseNumberInput(rthAltitudeInput, 'RTH altitude');
      if (rthValue != null) payload.return_home_altitude = rthValue;

      const maxAltValue = parseNumberInput(maxAltitudeInput, 'max altitude');
      if (maxAltValue != null) payload.max_altitude = maxAltValue;

      const maxDistanceValue = parseNumberInput(maxDistanceInput, 'max distance');
      if (maxDistanceValue != null) payload.max_distance = maxDistanceValue;

      payload.max_distance_enabled = distanceLimitEnabledInput;
      payload.signal_lost_action = signalLostActionInput;
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : 'Invalid flight setting');
      return;
    }

    if (Object.keys(payload).length === 0) {
      setSettingsStatus('No flight settings to update.');
      return;
    }

    setSettingsStatus('Updating flight settings…');
    try {
      const result = await sendFlightCommand('flight_settings_update', payload);
      if (result?.success) {
        setSettingsStatus('Flight settings updated.');
      } else {
        setSettingsStatus(result?.error_message || result?.message || 'Flight settings update failed.');
      }
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : 'Flight settings command failed.');
    }
  }, [
    sendFlightCommand,
    rthAltitudeInput,
    maxAltitudeInput,
    maxDistanceInput,
    distanceLimitEnabledInput,
    signalLostActionInput,
    parseNumberInput,
  ]);

  const handleApplyRemoteId = React.useCallback(async () => {
    const payload: Record<string, any> = { area_strategy: areaStrategyInput };
    if (operatorRegistrationInput.trim()) {
      payload.operator_registration = operatorRegistrationInput.trim();
    }

    setRemoteIdStatusMessage('Updating Remote ID…');
    try {
      const result = await sendFlightCommand('remote_id_update', payload);
      if (result?.success) {
        setRemoteIdStatusMessage('Remote ID updated.');
      } else {
        setRemoteIdStatusMessage(result?.error_message || result?.message || 'Remote ID update failed.');
      }
    } catch (error) {
      setRemoteIdStatusMessage(error instanceof Error ? error.message : 'Remote ID command failed.');
    }
  }, [sendFlightCommand, areaStrategyInput, operatorRegistrationInput]);

  const handleRefreshRemoteId = React.useCallback(async () => {
    setRemoteIdStatusMessage('Refreshing Remote ID status…');
    try {
      const result = await sendFlightCommand('remote_id_update', { refresh_operator: true });
      if (result?.success) {
        setRemoteIdStatusMessage('Remote ID status refreshed.');
      } else {
        setRemoteIdStatusMessage(result?.error_message || result?.message || 'Remote ID refresh failed.');
      }
    } catch (error) {
      setRemoteIdStatusMessage(error instanceof Error ? error.message : 'Remote ID refresh failed.');
    }
  }, [sendFlightCommand]);

  const handleFlySafeRefresh = React.useCallback(async () => {
    setFlySafeStatusMessage('Requesting Fly Safe refresh…');
    try {
      const result = await sendFlightCommand('flysafe_refresh');
      if (result?.success) {
        setFlySafeStatusMessage('Fly Safe surround updated.');
      } else {
        setFlySafeStatusMessage(result?.error_message || result?.message || 'Fly Safe refresh failed.');
      }
    } catch (error) {
      setFlySafeStatusMessage(error instanceof Error ? error.message : 'Fly Safe refresh failed.');
    }
  }, [sendFlightCommand]);

  return (
    <Panel
      title="Preflight"
      storageKey="preflight.panel"
      visibilityEventType="preflightPanelVisibilityChange"
      defaultPosition={{ x: 720, y: 20 }}
      defaultSize={{ w: 320, h: 340 }}
    >
      <div className="space-y-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        <CollapsibleSection
          title="Device Status"
          storageKey="preflight.section.device"
          summary={preflight ? formatRelativeTime(preflight.timestamp) : 'No data'}
        >
          {deviceStatus ? (
            <div className="space-y-1">
              <div className={`text-base font-semibold ${levelClass(deviceStatus.level)}`}>
                {deviceStatus.label || deviceStatus.code || 'Status'}
              </div>
              {deviceStatus.description && (
                <div className="text-[11px] text-gray-300 leading-snug">
                  {deviceStatus.description}
                </div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-status-good">All systems nominal</div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Preflight Warnings"
          storageKey="preflight.section.warnings"
          summary={diagnostics.length ? `${diagnostics.length} alert${diagnostics.length === 1 ? '' : 's'}` : 'Clear'}
        >
          {diagnostics.length === 0 ? (
            <div className="text-[11px] text-gray-400">No active diagnostics.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {diagnostics.map((diag, idx) => (
                <div key={`${diag.code || diag.title || idx}`} className="bg-gray-900/40 border border-gray-700/60 rounded px-2 py-1.5">
                  <div className={`text-[12px] font-semibold ${levelClass(diag.level)}`}>
                    {formatDiagnosticLabel(diag)}
                  </div>
                  {diag.description && (
                    <div className="text-[11px] text-gray-400 leading-tight mt-0.5">
                      {diag.description}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3 text-[10px] text-gray-500 mt-1">
                    {diag.code && <span>Code {diag.code}</span>}
                    {typeof diag.component_id === 'number' && <span>Component {diag.component_id}</span>}
                    {typeof diag.sensor_index === 'number' && <span>Sensor {diag.sensor_index}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-col gap-1 text-[10px]">
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-200 hover:bg-gray-800/60"
              onClick={handleFlySafeRefresh}
            >
              Refresh Fly Safe Zones
            </button>
            {flySafeStatusMessage && <div className="text-gray-400">{flySafeStatusMessage}</div>}
          </div>
        </CollapsibleSection>

        
        <CollapsibleSection
          title="Flight Limits &amp; Failsafe"
          storageKey="preflight.section.limits"
          summary={flightLimits.rth != null ? formatMeters(flightLimits.rth) : '—'}
        >
          <div className="flex flex-col gap-1.5">
            <InfoRow label="RTH Altitude" value={formatMeters(flightLimits.rth)} />
            <InfoRow label="Max Altitude" value={formatMeters(flightLimits.maxAltitude)} />
            <InfoRow label="Max Distance" value={formatMetersNoDecimal(flightLimits.maxDistance)} />
            <InfoRow
              label="Distance Limit"
              value={
                flightLimits.maxDistanceEnabled === undefined
                  ? '—'
                  : flightLimits.maxDistanceEnabled
                  ? 'ENABLED'
                  : 'DISABLED'
              }
            />
            <InfoRow label="Signal Lost" value={formatActionLabel(flightLimits.signalLost)} />
          </div>
          <div className="mt-2 border-t border-gray-700/60 pt-2 text-[11px] flex flex-col gap-2">
            <div className="text-gray-300 font-semibold">Adjust Settings</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span>RTH Altitude (m)</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={rthAltitudeInput}
                  onChange={(event) => setRthAltitudeInput(event.target.value)}
                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Max Altitude (m)</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={maxAltitudeInput}
                  onChange={(event) => setMaxAltitudeInput(event.target.value)}
                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Max Distance (m)</span>
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={maxDistanceInput}
                  onChange={(event) => setMaxDistanceInput(event.target.value)}
                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                />
              </label>
              <label className="flex items-center gap-2 text-[10px]">
                <input
                  type="checkbox"
                  checked={distanceLimitEnabledInput}
                  onChange={(event) => setDistanceLimitEnabledInput(event.target.checked)}
                  className="accent-dji-blue"
                />
                <span>Distance Limit Enabled</span>
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span>Signal Lost Action</span>
              <select
                value={signalLostActionInput}
                onChange={(event) => setSignalLostActionInput(event.target.value)}
                className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
              >
                {signalLostOptions.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="px-2 py-1 rounded bg-dji-blue text-white hover:bg-dji-blue/80"
                onClick={handleApplyFlightSettings}
              >
                Apply
              </button>
              <button
                type="button"
                className="px-2 py-1 rounded border border-gray-700 text-gray-200 hover:bg-gray-800/60"
                onClick={resetFlightInputs}
              >
                Reset
              </button>
            </div>
            {settingsStatus && <div className="text-[10px] text-gray-400">{settingsStatus}</div>}
          </div>
        </CollapsibleSection>


        
        <CollapsibleSection
          title="Obstacle Avoidance"
          storageKey="preflight.section.obstacle"
          summary={
            obstacleSettings?.collision_avoidance ?? telemetryObstacle?.enabled
              ? 'Enabled'
              : obstacleSettings?.collision_avoidance === false || telemetryObstacle?.enabled === false
              ? 'Disabled'
              : '—'
          }
        >
          <div className="flex flex-col gap-1.5">
            <InfoRow
              label="Collision Avoidance"
              value={
                obstacleSettings?.collision_avoidance ?? telemetryObstacle?.enabled
                  ? 'ENABLED'
                  : obstacleSettings?.collision_avoidance === false
                  ? 'DISABLED'
                  : telemetryObstacle?.enabled === false
                  ? 'DISABLED'
                  : '—'
              }
            />
            <InfoRow
              label="Vision Positioning"
              value={
                obstacleSettings?.vision_positioning === undefined
                  ? '—'
                  : obstacleSettings.vision_positioning
                  ? 'ENABLED'
                  : 'DISABLED'
              }
            />
            <InfoRow label="Landing Protection" value={formatActionLabel(obstacleSettings?.landing_protection)} />
          </div>
        </CollapsibleSection>


        
        <CollapsibleSection
          title="Power &amp; Battery"
          storageKey="preflight.section.power"
          summary={formatPercent(aircraftBatteryPercent)}
        >
          <div className="flex flex-col gap-1.5">
            <InfoRow label="Aircraft" value={formatPercent(aircraftBatteryPercent)} />
            <InfoRow label="Controller" value={formatPercent(controllerBatteryPercent)} />
            <InfoRow label="Low Warning" value={formatPercent(powerStatus?.low_warning_threshold)} />
            <InfoRow label="Critical" value={formatPercent(powerStatus?.critical_warning_threshold)} />
          </div>
        </CollapsibleSection>


        
        <CollapsibleSection
          title="Controller Setup"
          storageKey="preflight.section.controller"
          summary={controllerSettings?.stick_mode ?? '—'}
        >
          <div className="flex flex-col gap-1.5">
            <InfoRow label="Stick Mode" value={controllerSettings?.stick_mode ?? '—'} />
            <InfoRow label="RC Mode" value={controllerSettings?.rc_mode ?? '—'} />
            <InfoRow
              label="Virtual Stick"
              value={
                controllerSettings?.virtual_stick?.enabled === undefined
                  ? '—'
                  : controllerSettings.virtual_stick.enabled
                  ? 'ENABLED'
                  : 'DISABLED'
              }
            />
            <InfoRow
              label="Authority Owner"
              value={controllerSettings?.virtual_stick?.authority_owner ?? '—'}
            />
            <InfoRow
              label="Manual Override"
              value={
                controllerSettings?.virtual_stick?.manual_override === undefined
                  ? '—'
                  : controllerSettings.virtual_stick.manual_override
                  ? 'YES'
                  : 'NO'
              }
            />
          </div>
        </CollapsibleSection>


        
        <CollapsibleSection
          title="Remote ID"
          storageKey="preflight.section.remoteId"
          summary={remoteIdSnapshot?.areaStrategy ?? '—'}
        >
          <div className="flex flex-col gap-1.5">
            <InfoRow label="Area Strategy" value={remoteIdSnapshot?.areaStrategy ?? '—'} />
            <InfoRow label="Operator ID" value={remoteIdSnapshot?.operatorRegistrationNumber ?? '—'} />
            <InfoRow label="Last Error" value={remoteIdSnapshot?.lastError ?? '—'} />
          </div>
          {remoteIdSnapshot?.status && (
            <div className="mt-2 text-[10px] text-gray-400 whitespace-pre-wrap bg-black/20 border border-gray-800/60 rounded px-2 py-1">
              {renderObject(remoteIdSnapshot.status)}
            </div>
          )}
          {remoteIdSnapshot?.operatorStatus && (
            <div className="mt-2 text-[10px] text-gray-400 whitespace-pre-wrap bg-black/20 border border-gray-800/60 rounded px-2 py-1">
              {renderObject(remoteIdSnapshot.operatorStatus)}
            </div>
          )}
          <div className="mt-2 border-t border-gray-700/60 pt-2 text-[11px] flex flex-col gap-2">
            <div className="text-gray-300 font-semibold">Configure</div>
            <label className="flex flex-col gap-1">
              <span>Area Strategy</span>
              <select
                value={areaStrategyInput}
                onChange={(event) => setAreaStrategyInput(event.target.value)}
                className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
              >
                {areaStrategyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span>Operator Registration</span>
              <input
                type="text"
                value={operatorRegistrationInput}
                onChange={(event) => setOperatorRegistrationInput(event.target.value)}
                className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className="px-2 py-1 rounded bg-dji-blue text-white hover:bg-dji-blue/80"
                onClick={handleApplyRemoteId}
              >
                Apply
              </button>
              <button
                type="button"
                className="px-2 py-1 rounded border border-gray-700 text-gray-200 hover:bg-gray-800/60"
                onClick={handleRefreshRemoteId}
              >
                Refresh
              </button>
            </div>
            {remoteIdStatusMessage && <div className="text-[10px] text-gray-400">{remoteIdStatusMessage}</div>}
          </div>
        </CollapsibleSection>


        {latestLandingMonitor && (
          <CollapsibleSection
            title="Landing Monitor"
            storageKey="preflight.section.landingMonitor"
            summary={formatRelativeTime(latestLandingMonitor.timestamp)}
            defaultOpen
          >
            <div className="text-[11px] text-status-error leading-tight">
              {latestLandingMonitor.message || latestLandingMonitor.error_message || 'Landing monitor reported issue.'}
            </div>
            {latestLandingMonitor.landing_monitor && (
              <div className="text-[10px] text-gray-400 mt-1 flex gap-4">
                <span>Motors: {latestLandingMonitor.landing_monitor.motors_on ? 'ON' : 'OFF'}</span>
                {typeof latestLandingMonitor.landing_monitor.altitude === 'number' && (
                  <span>Alt: {latestLandingMonitor.landing_monitor.altitude.toFixed(1)} m</span>
                )}
                {typeof latestLandingMonitor.landing_monitor.elapsed_ms === 'number' && (
                  <span>Elapsed: {(latestLandingMonitor.landing_monitor.elapsed_ms / 1000).toFixed(1)} s</span>
                )}
              </div>
            )}
          </CollapsibleSection>
        )}
      </div>
    </Panel>
  );
};
