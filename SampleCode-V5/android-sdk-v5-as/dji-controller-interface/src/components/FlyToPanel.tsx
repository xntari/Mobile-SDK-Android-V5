import React from 'react';
import { Panel } from './Panel';
import { useBridgeCommands } from '../hooks/useBridgeCommands';
import { useStableBridgeData } from '../hooks/useStableBridgeData';
import { addMetersToLatLon, bearingOffsetToMeters, normalizeHeadingDegrees } from '../utils/geo';
import { TelemetryData } from '../types';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';

interface MissionLogEntry {
  id: string;
  timestamp: number;
  label: string;
  payload: Record<string, any>;
}

const clampAltitude = (value: number) => Math.max(-500, Math.min(6000, value));

const formatLatLon = (value?: number) =>
  typeof value === 'number' ? value.toFixed(7) : '—';

export const FlyToPanel: React.FC = () => {
  const { sendFlightCommand } = useBridgeCommands();
  const { bridgeData } = useStableBridgeData();
  const telemetry = bridgeData.telemetry;
  const [distanceMeters, setDistanceMeters] = React.useState<number>(5);
  const [verticalMeters, setVerticalMeters] = React.useState<number>(2);
  const [maxSpeed, setMaxSpeed] = React.useState<number>(3);
  const [logEntries, setLogEntries] = React.useState<MissionLogEntry[]>([]);
  const [targetSelection, setTargetSelection] = React.useState<ObjectMemoryTargetSelection | null>(() =>
    objectMemoryTargetStore.getCurrent(),
  );
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  React.useEffect(() => objectMemoryTargetStore.subscribe(setTargetSelection), []);

  const appendLog = React.useCallback((label: string, payload: Record<string, any>) => {
    setLogEntries((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        label,
        payload,
      },
      ...prev,
    ]);
  }, []);

  const ensureTelemetry = (): TelemetryData | null => {
    if (!telemetry || !telemetry.location) {
      setStatusMessage('Telemetry unavailable — cannot compute target.');
      return null;
    }
    return telemetry;
  };

  const sendFlyTo = async (latitude: number, longitude: number, altitude: number | null, label: string) => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;

    const baseAltitude = telemetrySnapshot.location.altitude ?? telemetrySnapshot.altitude ?? 0;
    const resolvedAltitude = altitude ?? baseAltitude;

    const params: Record<string, any> = {
      target_location: {
        latitude,
        longitude,
        altitude: clampAltitude(resolvedAltitude),
      },
    };

    if (Number.isFinite(maxSpeed) && maxSpeed > 0) {
      params.max_speed = Math.round(maxSpeed);
    }

    appendLog(label, params);

    try {
      const result = await sendFlightCommand('fly_to_prepare', params);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'fly_to_prepare rejected');
      } else {
        setStatusMessage(`${label}: command sent`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'fly_to_prepare failed');
    }
  };

  const handleRelativeMove = async (direction: 'forward' | 'backward' | 'left' | 'right') => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    const { location } = telemetrySnapshot;
    const heading = normalizeHeadingDegrees(telemetrySnapshot.heading ?? telemetrySnapshot.compass_heading ?? 0);

    const dist = distanceMeters;
    const headingOffset =
      direction === 'forward'
        ? heading
        : direction === 'backward'
          ? heading + 180
          : direction === 'left'
            ? heading - 90
            : heading + 90;
    const { north, east } = bearingOffsetToMeters(dist, headingOffset);
    const next = addMetersToLatLon(location.latitude, location.longitude, north, east);
    await sendFlyTo(next.latitude, next.longitude, location.altitude ?? telemetrySnapshot.altitude ?? null, `Fly ${direction} ${dist}m`);
  };

  const handleVerticalMove = async (direction: 'up' | 'down') => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    const { location } = telemetrySnapshot;
    const delta = direction === 'up' ? Math.abs(verticalMeters) : -Math.abs(verticalMeters);
    const newAltitude = (location.altitude ?? telemetrySnapshot.altitude ?? 0) + delta;
    await sendFlyTo(location.latitude, location.longitude, newAltitude, `Fly ${direction} ${Math.abs(delta)}m`);
  };

  const handleReturnHome = async (action: 'return_home_start' | 'return_home_stop') => {
    appendLog(action === 'return_home_start' ? 'Return Home Start' : 'Return Home Stop', {});
    try {
      const result = await sendFlightCommand(action);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || `${action} rejected`);
      } else {
        setStatusMessage(`${action === 'return_home_start' ? 'Return Home started' : 'Return Home cancelled'}`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `${action} failed`);
    }
  };

  const derivedTarget = React.useMemo(() => {
    const anchor = targetSelection?.anchor;
    if (!anchor) return null;
    const objectPosition = anchor.object_position;
    const mapTarget = anchor.object_map?.target_point;
    const candidate = mapTarget && typeof mapTarget.latitude === 'number' && typeof mapTarget.longitude === 'number'
      ? mapTarget
      : objectPosition;

    if (!candidate || typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') {
      return null;
    }

    const altitudeCandidate = candidate.altitude_m ?? anchor.object_map?.laser_location?.altitude_m ?? objectPosition?.altitude_m;
    return {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      altitude: altitudeCandidate ?? null,
    };
  }, [targetSelection]);

  const handleFlyToTarget = async () => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    if (!derivedTarget) {
      setStatusMessage('Selected target missing coordinates.');
      return;
    }
    const altitude = derivedTarget.altitude ?? telemetrySnapshot.location.altitude ?? telemetrySnapshot.altitude ?? null;
    await sendFlyTo(derivedTarget.latitude, derivedTarget.longitude, altitude, 'Fly to selected target');
  };

  return (
    <Panel
      title="Fly-To & RTH"
      storageKey="flyto.panel"
      visibilityEventType="flyToPanelVisibilityChange"
      defaultPosition={{ x: 1040, y: 780 }}
      defaultSize={{ w: 340, h: 360 }}
    >
      <div className="flex flex-col gap-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        {statusMessage && (
          <div className="text-[11px] text-status-warning bg-black/40 border border-yellow-500/40 rounded px-2 py-1">
            {statusMessage}
          </div>
        )}

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Relative Move</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Distance (m)</span>
              <input
                type="number"
                value={distanceMeters}
                min={1}
                max={200}
                onChange={(event) => setDistanceMeters(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Max Speed (m/s)</span>
              <input
                type="number"
                value={maxSpeed}
                min={1}
                max={15}
                onChange={(event) => setMaxSpeed(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('forward')}>
              Forward
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('backward')}>
              Backward
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('left')}>
              Left
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('right')}>
              Right
            </button>
          </div>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Vertical Move</div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11px]">Δ Alt (m)</span>
            <input
              type="number"
              value={verticalMeters}
              min={1}
              max={200}
              onChange={(event) => setVerticalMeters(Number(event.target.value) || 0)}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right w-20"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleVerticalMove('up')}>
              Up
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleVerticalMove('down')}>
              Down
            </button>
          </div>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Target</div>
          {targetSelection ? (
            <div className="text-[11px] text-gray-300 mb-2">
              <div>Label: {targetSelection.clusterLabel ?? targetSelection.clusterId}</div>
              <div>
                Lat/Lon: {formatLatLon(derivedTarget?.latitude)} / {formatLatLon(derivedTarget?.longitude)}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-gray-500 mb-2">No target selected. Use map/LRF/object-memory panels to set one.</div>
          )}
          <button
            className="w-full px-2 py-1 rounded bg-dji-blue text-white disabled:bg-gray-700 disabled:text-gray-400"
            disabled={!targetSelection}
            onClick={handleFlyToTarget}
          >
            Fly to Selected Target
          </button>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Return to Home</div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-status-good/20 border border-status-good/50 text-status-good" onClick={() => handleReturnHome('return_home_start')}>
              Start RTH
            </button>
            <button className="px-2 py-1 rounded bg-status-error/20 border border-status-error/60 text-status-error" onClick={() => handleReturnHome('return_home_stop')}>
              Stop RTH
            </button>
          </div>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Command Log</div>
          {logEntries.length === 0 ? (
            <div className="text-[11px] text-gray-500">No mission commands sent yet.</div>
          ) : (
            <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
              {logEntries.map((entry) => (
                <div key={entry.id} className="border border-gray-700/60 rounded px-2 py-1">
                  <div className="text-[11px] text-gray-300">
                    {new Date(entry.timestamp).toLocaleTimeString()} · {entry.label}
                  </div>
                  <pre className="text-[10px] text-gray-500 whitespace-pre-wrap break-all mt-1">
{JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Panel>
  );
};
