import React from 'react';
import { TelemetryData, FlightCommandAck, SimulatorTelemetry } from '../types';

const DEFAULT_SATELLITES = 12;
const MIN_SATELLITES = 6;
const MAX_SATELLITES = 20;

type PendingMeta = {
  state: 'pending' | 'timeout' | 'error';
  message?: string;
};

interface SimulatorControlsProps {
  telemetry: TelemetryData | null;
  onSend: (action: string, params?: Record<string, any>) => Promise<void>;
  pendingActions: Set<string>;
  pendingMeta: Map<string, PendingMeta>;
  acknowledgements: Map<string, FlightCommandAck>;
}

const formatNumber = (value?: number, digits = 6): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(digits);
};

const formatRelative = (timestamp?: number): string => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return '—';
  }
  const delta = Date.now() - timestamp;
  if (delta < 0) {
    return 'now';
  }
  if (delta < 1000) {
    return '<1s';
  }
  if (delta < 60_000) {
    return `${Math.round(delta / 1000)}s`;
  }
  const minutes = delta / 60_000;
  if (minutes < 10) {
    return `${minutes.toFixed(1)}m`;
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
};

export const getSimulatorModeBadge = (simulator: SimulatorTelemetry | undefined): { label: string; className: string } => {
  if (simulator?.mode === 'simulator' || simulator?.enabled) {
    return { label: 'SIMULATOR', className: 'bg-status-good/20 text-status-good border-status-good/40' };
  }
  return { label: 'REAL', className: 'bg-gray-700/50 text-gray-200 border-gray-600/80' };
};

const boolLabel = (value: boolean | undefined, truthy: string, falsy: string): string => {
  if (value === undefined) return '—';
  return value ? truthy : falsy;
};

export const SimulatorControls: React.FC<SimulatorControlsProps> = ({
  telemetry,
  onSend,
  pendingActions,
  pendingMeta,
  acknowledgements,
}) => {
  const simulator = telemetry?.simulator;
  const [lat, setLat] = React.useState('');
  const [lng, setLng] = React.useState('');
  const [satellites, setSatellites] = React.useState(String(DEFAULT_SATELLITES));
  const [altitude, setAltitude] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const satellitesPresetRef = React.useRef(false);
  const altitudePresetRef = React.useRef(false);

  React.useEffect(() => {
    if (lat.trim().length > 0) return;
    const sourceLat = simulator?.configuration?.latitude ?? telemetry?.home_location?.latitude ?? telemetry?.location?.latitude;
    if (typeof sourceLat === 'number' && Number.isFinite(sourceLat)) {
      setLat(sourceLat.toFixed(6));
    }
  }, [lat, simulator?.configuration?.latitude, telemetry?.home_location?.latitude, telemetry?.location?.latitude]);

  React.useEffect(() => {
    if (lng.trim().length > 0) return;
    const sourceLng = simulator?.configuration?.longitude ?? telemetry?.home_location?.longitude ?? telemetry?.location?.longitude;
    if (typeof sourceLng === 'number' && Number.isFinite(sourceLng)) {
      setLng(sourceLng.toFixed(6));
    }
  }, [lng, simulator?.configuration?.longitude, telemetry?.home_location?.longitude, telemetry?.location?.longitude]);

  React.useEffect(() => {
    if (satellitesPresetRef.current) return;
    const configSat = simulator?.configuration?.satellites;
    if (typeof configSat === 'number' && Number.isFinite(configSat)) {
      const clamped = Math.min(Math.max(configSat, MIN_SATELLITES), MAX_SATELLITES);
      setSatellites(String(clamped));
      satellitesPresetRef.current = true;
    }
  }, [simulator?.configuration?.satellites]);

  React.useEffect(() => {
    if (altitudePresetRef.current) return;
    const configAlt = simulator?.configuration?.altitude;
    if (typeof configAlt === 'number' && Number.isFinite(configAlt)) {
      setAltitude(configAlt.toFixed(1));
      altitudePresetRef.current = true;
    }
  }, [simulator?.configuration?.altitude]);

  const pendingEnable = pendingActions.has('simulator_enable');
  const pendingDisable = pendingActions.has('simulator_disable');
  const enableMeta = pendingMeta.get('simulator_enable');
  const disableMeta = pendingMeta.get('simulator_disable');
  const lastEnableAck = acknowledgements.get('simulator_enable');
  const lastDisableAck = acknowledgements.get('simulator_disable');

  const applyHome = () => {
    const home = telemetry?.home_location;
    if (typeof home?.latitude === 'number' && Number.isFinite(home.latitude)) {
      setLat(home.latitude.toFixed(6));
    }
    if (typeof home?.longitude === 'number' && Number.isFinite(home.longitude)) {
      setLng(home.longitude.toFixed(6));
    }
  };

  const applyAircraft = () => {
    const aircraft = telemetry?.location;
    if (typeof aircraft?.latitude === 'number' && Number.isFinite(aircraft.latitude)) {
      setLat(aircraft.latitude.toFixed(6));
    }
    if (typeof aircraft?.longitude === 'number' && Number.isFinite(aircraft.longitude)) {
      setLng(aircraft.longitude.toFixed(6));
    }
  };

  const applyConfig = () => {
    const config = simulator?.configuration;
    if (!config) return;
    if (typeof config.latitude === 'number' && Number.isFinite(config.latitude)) {
      setLat(config.latitude.toFixed(6));
    }
    if (typeof config.longitude === 'number' && Number.isFinite(config.longitude)) {
      setLng(config.longitude.toFixed(6));
    }
    if (typeof config.satellites === 'number' && Number.isFinite(config.satellites)) {
      const clamped = Math.min(Math.max(config.satellites, MIN_SATELLITES), MAX_SATELLITES);
      setSatellites(String(clamped));
    }
    if (typeof config.altitude === 'number' && Number.isFinite(config.altitude)) {
      setAltitude(config.altitude.toFixed(1));
    }
  };

  const handleEnable = async () => {
    setValidationError(null);
    const latitude = parseFloat(lat);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
      setValidationError('Latitude must be between -90° and 90°.');
      return;
    }
    const longitude = parseFloat(lng);
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      setValidationError('Longitude must be between -180° and 180°.');
      return;
    }
    const parsedSat = parseInt(satellites, 10);
    if (!Number.isFinite(parsedSat)) {
      setValidationError(`Satellite count must be a number between ${MIN_SATELLITES} and ${MAX_SATELLITES}.`);
      return;
    }
    if (parsedSat < MIN_SATELLITES || parsedSat > MAX_SATELLITES) {
      setValidationError(`Satellite count must stay between ${MIN_SATELLITES} and ${MAX_SATELLITES}.`);
      return;
    }
    const satelliteCount = parsedSat;
    const params: Record<string, any> = {
      latitude,
      longitude,
      satellites: satelliteCount,
      source: 'flight_commands_panel'
    };
    const altitudeValue = parseFloat(altitude);
    if (Number.isFinite(altitudeValue)) {
      params.altitude = altitudeValue;
    }
    await onSend('simulator_enable', params);
  };

  const handleDisable = async () => {
    setValidationError(null);
    await onSend('simulator_disable');
  };

  const badge = getSimulatorModeBadge(simulator);
  const lastAck = lastEnableAck || lastDisableAck;

  return (
    <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase text-gray-400">Simulator</div>
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            <span className={`px-2 py-0.5 border rounded ${badge.className}`}>
              {badge.label}
            </span>
            <span className="text-gray-300">
              {boolLabel(simulator?.enabled, 'Enabled', 'Disabled')}
            </span>
            <span className="text-gray-500">
              Updated {formatRelative(simulator?.timestamp)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-400 leading-tight">
            <div>
              Motors {boolLabel(simulator?.motors_on, 'ON', 'OFF')}
            </div>
            <div>
              Flight {boolLabel(simulator?.flying, 'In Air', 'Ground')}
            </div>
            <div>
              Listener {boolLabel(simulator?.listener_registered, 'OK', '—')}
            </div>
          </div>
          {simulator?.configuration && (
            <div className="mt-2 text-[10px] text-gray-400 leading-tight">
              <div>
                Last config: lat {formatNumber(simulator.configuration.latitude)} · lon {formatNumber(simulator.configuration.longitude)} · sats {simulator.configuration.satellites ?? '—'}
              </div>
              <div>
                Source {simulator.configuration.source ?? '—'} · {formatRelative(simulator.configuration.timestamp)} ago
              </div>
            </div>
          )}
          {simulator?.last_error && (
            <div className="mt-2 text-[10px] text-status-error leading-tight">
              Last error: {simulator.last_error.description ?? 'Unknown'}
              {simulator.last_error.code && (
                <span className="text-gray-400"> ({simulator.last_error.code})</span>
              )}
              {simulator.last_error.domain && (
                <span className="text-gray-500"> · {simulator.last_error.domain}</span>
              )}
            </div>
          )}
        </div>
        <div className="text-[10px] text-gray-400 leading-tight space-y-1 text-right">
          {lastAck && (
            <div>
              Last action {lastAck.action} · {lastAck.status.toUpperCase()} · {formatRelative(lastAck.timestamp)}
            </div>
          )}
          {enableMeta && enableMeta.state !== 'pending' && (
            <div className={enableMeta.state === 'error' ? 'text-status-error' : 'text-status-error'}>
              Enable: {enableMeta.message ?? (enableMeta.state === 'timeout' ? 'Bridge timeout' : 'Command failed')}
            </div>
          )}
          {disableMeta && disableMeta.state !== 'pending' && (
            <div className={disableMeta.state === 'error' ? 'text-status-error' : 'text-status-error'}>
              Disable: {disableMeta.message ?? (disableMeta.state === 'timeout' ? 'Bridge timeout' : 'Command failed')}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 text-[11px] text-gray-200">
        <div>
          <div className="flex flex-wrap gap-2 text-[10px] text-gray-400 mb-1">
            <button
              className="border border-gray-700/80 bg-gray-900/60 px-2 py-0.5 rounded hover:border-gray-500/80"
              type="button"
              onClick={applyHome}
            >
              Use Home
            </button>
            <button
              className="border border-gray-700/80 bg-gray-900/60 px-2 py-0.5 rounded hover:border-gray-500/80"
              type="button"
              onClick={applyAircraft}
            >
              Use Aircraft
            </button>
            {simulator?.configuration && (
              <button
                className="border border-gray-700/80 bg-gray-900/60 px-2 py-0.5 rounded hover:border-gray-500/80"
                type="button"
                onClick={applyConfig}
              >
                Use Config
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-gray-400">Latitude</span>
              <input
                className="rounded bg-black/40 border border-gray-700/70 px-2 py-1 text-[11px] focus:outline-none focus:border-status-good"
                value={lat}
                onChange={(event) => setLat(event.target.value)}
                placeholder="34.000000"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-gray-400">Longitude</span>
              <input
                className="rounded bg-black/40 border border-gray-700/70 px-2 py-1 text-[11px] focus:outline-none focus:border-status-good"
                value={lng}
                onChange={(event) => setLng(event.target.value)}
                placeholder="-118.000000"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-gray-400">Satellites ({MIN_SATELLITES}-{MAX_SATELLITES})</span>
              <input
                className="rounded bg-black/40 border border-gray-700/70 px-2 py-1 text-[11px] focus:outline-none focus:border-status-good"
                value={satellites}
                onChange={(event) => setSatellites(event.target.value)}
                placeholder={`${DEFAULT_SATELLITES}`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-gray-400">Altitude (m, optional)</span>
              <input
                className="rounded bg-black/40 border border-gray-700/70 px-2 py-1 text-[11px] focus:outline-none focus:border-status-good"
                value={altitude}
                onChange={(event) => setAltitude(event.target.value)}
                placeholder="0"
              />
            </label>
          </div>
          {validationError && (
            <div className="mt-1 text-[10px] text-status-error leading-tight">
              {validationError}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleEnable}
            disabled={pendingEnable}
            className={`flex-1 rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wide border ${pendingEnable ? 'bg-status-good/20 border-status-good/40 text-status-good cursor-wait' : 'bg-status-good/10 border-status-good/60 text-status-good hover:bg-status-good/20'}`}
          >
            {pendingEnable ? 'Enabling…' : 'Enable Simulator'}
          </button>
          <button
            type="button"
            onClick={handleDisable}
            disabled={pendingDisable}
            className={`flex-1 rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wide border ${pendingDisable ? 'bg-status-error/10 border-status-error/40 text-status-error cursor-wait' : 'bg-status-error/10 border-status-error/60 text-status-error hover:bg-status-error/20'}`}
          >
            {pendingDisable ? 'Disabling…' : 'Disable Simulator'}
          </button>
        </div>
      </div>
    </section>
  );
};
