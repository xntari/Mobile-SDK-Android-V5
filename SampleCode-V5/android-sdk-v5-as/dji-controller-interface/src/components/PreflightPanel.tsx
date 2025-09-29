import React from 'react';
import { Panel } from './Panel';
import { PreflightStatus, FlightCommandAck, TelemetryDiagnosticEntry, TelemetryData, BatteryData, ControllerData } from '../types';

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

  return (
    <Panel
      title="Preflight"
      storageKey="preflight.panel"
      visibilityEventType="preflightPanelVisibilityChange"
      defaultPosition={{ x: 720, y: 20 }}
      defaultSize={{ w: 320, h: 340 }}
    >
      <div className="flex flex-col gap-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        <section className="glass-panel border border-gray-700/70 rounded-md px-3 py-2">
          <div className="flex items-center justify-between text-[11px] uppercase text-gray-400">
            <span>Device Status</span>
            <span>{preflight ? formatRelativeTime(preflight.timestamp) : '—'}</span>
          </div>
          {deviceStatus ? (
            <div className="mt-1">
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
            <div className="text-[11px] text-status-good mt-1">All systems nominal</div>
          )}
        </section>

        <section className="glass-panel border border-gray-700/70 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Preflight Warnings</div>
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
        </section>

        <section className="glass-panel border border-gray-700/70 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Flight Limits &amp; Failsafe</div>
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
        </section>

        <section className="glass-panel border border-gray-700/70 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Obstacle Avoidance</div>
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
            <InfoRow
              label="Landing Protection"
              value={formatActionLabel(obstacleSettings?.landing_protection)}
            />
          </div>
        </section>

        <section className="glass-panel border border-gray-700/70 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Power &amp; Battery</div>
          <div className="flex flex-col gap-1.5">
            <InfoRow label="Aircraft" value={formatPercent(aircraftBatteryPercent)} />
            <InfoRow label="Controller" value={formatPercent(controllerBatteryPercent)} />
            <InfoRow label="Low Warning" value={formatPercent(powerStatus?.low_warning_threshold)} />
            <InfoRow label="Critical" value={formatPercent(powerStatus?.critical_warning_threshold)} />
          </div>
        </section>

        <section className="glass-panel border border-gray-700/70 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Controller Setup</div>
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
        </section>

        {latestLandingMonitor && (
          <section className="glass-panel border border-status-error/60 rounded-md px-3 py-2">
            <div className="text-[11px] uppercase text-status-error mb-1 flex justify-between">
              <span>Landing Monitor</span>
              <span>{formatRelativeTime(latestLandingMonitor.timestamp)}</span>
            </div>
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
          </section>
        )}
      </div>
    </Panel>
  );
};
