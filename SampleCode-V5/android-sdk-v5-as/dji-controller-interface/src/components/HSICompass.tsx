import React, { useEffect, useState } from 'react';
import { HSICompassProps, TelemetryData } from '../types';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { computeTargetMetrics } from '../utils/objectMemoryTarget';
import { missionPlannerStore } from '../state/missionPlanner';
import type { MissionWaypointTarget, PoiTarget } from '../types/missionPlanner';
import { HSICanvas } from './HSICanvas';

const STORAGE_KEYS = {
  useRaw: 'hsi.useRaw360',
  scale: 'hsi.scale',
  logScale: 'hsi.useLog',
};

const clampScale = (value: number) => Math.min(Math.max(value, 0.5), 8);

export const HSICompass: React.FC<HSICompassProps> = ({
  size = 'normal',
  standalone = true,
}) => {
  const [useRawPerceptionData, setUseRawPerceptionData] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.useRaw);
      return stored != null ? stored === 'true' : true;
    } catch {
      return true;
    }
  });
  const [scaleRange, setScaleRange] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.scale);
      if (!stored) return 8;
      const parsed = parseFloat(stored);
      return Number.isFinite(parsed) ? clampScale(parsed) : 8;
    } catch {
      return 8;
    }
  });
  const [useLogarithmicScale, setUseLogarithmicScale] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.logScale);
      return stored != null ? stored === 'true' : true;
    } catch {
      return true;
    }
  });

  const [telemetryData, setTelemetryData] = useState<TelemetryData | null>(null);
  const [objectTarget, setObjectTarget] = useState<ObjectMemoryTargetSelection | null>(() => objectMemoryTargetStore.getCurrent());
  const [missionWaypoint, setMissionWaypoint] = useState<MissionWaypointTarget | null>(() => missionPlannerStore.getSnapshot().activeWaypoint ?? null);
  const [missionPoi, setMissionPoi] = useState<PoiTarget | null>(() => missionPlannerStore.getSnapshot().poiTarget ?? null);

  useEffect(() => objectMemoryTargetStore.subscribe(setObjectTarget), []);
  useEffect(() => missionPlannerStore.subscribeActiveWaypoint(setMissionWaypoint), []);
  useEffect(() => missionPlannerStore.subscribePoiTarget(setMissionPoi), []);

  const targetMetrics = React.useMemo(
    () => computeTargetMetrics(telemetryData, objectTarget?.anchor, objectTarget?.clusterLabel ?? objectTarget?.clusterId),
    [telemetryData, objectTarget]
  );

  const missionMetrics = React.useMemo(() => {
    if (!telemetryData?.location || !missionWaypoint) {
      return null;
    }

    const { latitude: lat1, longitude: lon1 } = telemetryData.location;
    const { latitude: lat2, longitude: lon2, altitude } = missionWaypoint;
    if (typeof lat1 !== 'number' || typeof lon1 !== 'number' || typeof lat2 !== 'number' || typeof lon2 !== 'number') {
      return null;
    }

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    const distance = 6371e3 * c;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

    const aircraftAltitude =
      typeof telemetryData.location.altitude === 'number'
        ? telemetryData.location.altitude
        : typeof telemetryData.altitude === 'number'
          ? telemetryData.altitude
          : null;

    const altitudeDelta = typeof altitude === 'number' && typeof aircraftAltitude === 'number'
      ? altitude - aircraftAltitude
      : null;

    return { distance, bearing, altitudeDelta };
  }, [telemetryData, missionWaypoint]);

  const poiMetrics = React.useMemo(() => {
    if (!telemetryData?.location || !missionPoi) {
      return null;
    }

    const { latitude: lat1, longitude: lon1 } = telemetryData.location;
    const { latitude: lat2, longitude: lon2, altitude } = missionPoi;
    if (typeof lat1 !== 'number' || typeof lon1 !== 'number' || typeof lat2 !== 'number' || typeof lon2 !== 'number') {
      return null;
    }

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    const distance = 6371e3 * c;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

    const aircraftAltitude =
      typeof telemetryData.location.altitude === 'number'
        ? telemetryData.location.altitude
        : typeof telemetryData.altitude === 'number'
          ? telemetryData.altitude
          : null;

    const altitudeDelta = typeof altitude === 'number' && typeof aircraftAltitude === 'number'
      ? altitude - aircraftAltitude
      : null;

    const pitch = altitudeDelta != null ? (Math.atan2(altitudeDelta, distance) * 180) / Math.PI : null;
    const slantDistance = altitudeDelta != null ? Math.sqrt(distance ** 2 + altitudeDelta ** 2) : distance;

    return { distance, bearing, altitudeDelta, pitch, slantDistance };
  }, [telemetryData, missionPoi]);

  useEffect(() => {
    if (!window.electronAPI || !(window.electronAPI as any).onBridgeData) {
      console.warn('⚠️ electronAPI not available for HSI telemetry updates');
      return;
    }

    const handleTelemetryData = (message: any) => {
      if (message.type === 'telemetry_data' && message.location) {
        const convertYawToCompass = (yaw: number): number => {
          let compass = yaw;
          if (compass < 0) compass += 360;
          return compass % 360;
        };

        const calculateBearing = (from: any, to: any): number => {
          if (!from || !to) return 0;
          const lat1 = from.latitude * Math.PI / 180;
          const lat2 = to.latitude * Math.PI / 180;
          const deltaLng = (to.longitude - from.longitude) * Math.PI / 180;
          const y = Math.sin(deltaLng) * Math.cos(lat2);
          const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
          return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        };

        const rawYaw = message.attitude?.yaw ?? message.compass_heading ?? message.heading ?? 0;
        const trueCompassHeading = convertYawToCompass(rawYaw);
        const bearingToHome = calculateBearing(message.location, message.home_location);

        const mappedTelemetry: TelemetryData = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: trueCompassHeading,
          attitude: message.attitude || { pitch: 0, roll: 0, yaw: rawYaw },
          compass_heading: trueCompassHeading,
          home_bearing: bearingToHome,
        };

        setTelemetryData(mappedTelemetry);
      }
    };

    const listener = (message: any) => handleTelemetryData(message);
    (window.electronAPI as any).onBridgeData(listener);

    return () => {
      try {
        (window.electronAPI as any).removeBridgeDataListener?.(listener);
      } catch {}
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.useRaw, String(useRawPerceptionData));
    } catch {}
  }, [useRawPerceptionData]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.scale, String(scaleRange));
    } catch {}
  }, [scaleRange]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.logScale, String(useLogarithmicScale));
    } catch {}
  }, [useLogarithmicScale]);

  const sizeConfig = size === 'small'
    ? { width: 208, height: 200 }
    : { width: 350, height: 260 };

  const containerClass = standalone
    ? `glass-panel ${size === 'small' ? 'p-2' : 'p-4'}`
    : `${size === 'small' ? 'p-2' : 'p-3'} flex flex-col gap-2`;

  const targetForCanvas = targetMetrics
    ? {
        bearing: targetMetrics.bearing,
        distance: targetMetrics.slantDistance,
        altitudeDelta: targetMetrics.altitudeDelta,
      }
    : null;

  const missionForCanvas = missionMetrics
    ? {
        bearing: missionMetrics.bearing,
        distance: missionMetrics.distance,
        altitudeDelta: missionMetrics.altitudeDelta ?? null,
      }
    : null;

  const poiForCanvas = poiMetrics
    ? {
        bearing: poiMetrics.bearing,
        distance: poiMetrics.slantDistance,
        altitudeDelta: poiMetrics.altitudeDelta ?? null,
        pitch: poiMetrics.pitch ?? null,
      }
    : null;

  const poiLabel = ((missionPoi as unknown as { label?: string })?.label) ?? 'POI';

  return (
    <div className={containerClass}>
      {size === 'normal' && (
        <div className="text-center mb-2">
          <div className="text-sm font-semibold text-gray-300">Horizontal Situation Indicator</div>
          <div className="mt-2 flex justify-center gap-2">
            <button
              onClick={() => setUseRawPerceptionData((prev) => !prev)}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                useRawPerceptionData
                  ? 'bg-dji-blue text-white border-dji-blue'
                  : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
              }`}
            >
              {useRawPerceptionData ? '360° Raw Data' : 'Processed Sectors'}
            </button>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={useLogarithmicScale}
                onChange={(event) => setUseLogarithmicScale(event.target.checked)}
                className="rounded"
              />
              Log Scale
            </label>
          </div>
          <div className="mt-2 px-4">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Scale</span>
              <span>{scaleRange.toFixed(1)} m</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="8"
              step="0.5"
              value={scaleRange}
              onChange={(event) => setScaleRange(clampScale(parseFloat(event.target.value)))}
              className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>0.5 m</span>
              <span>8 m</span>
            </div>
          </div>
        </div>
      )}

      {size === 'small' && (
        <div className="flex items-center justify-between text-xs text-gray-400">
          <button
            onClick={() => setUseRawPerceptionData((prev) => !prev)}
            className={`px-2 py-1 rounded border transition-colors ${
              useRawPerceptionData
                ? 'bg-dji-blue text-white border-dji-blue'
                : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
            }`}
          >
            {useRawPerceptionData ? '360°' : 'Sectors'}
          </button>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={useLogarithmicScale}
              onChange={(event) => setUseLogarithmicScale(event.target.checked)}
              className="rounded"
            />
            Log
          </label>
          <div className="flex items-center gap-1">
            <span>{scaleRange.toFixed(1)}m</span>
            <input
              type="range"
              min="0.5"
              max="8"
              step="0.5"
              value={scaleRange}
              onChange={(event) => setScaleRange(clampScale(parseFloat(event.target.value)))}
              className="h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
              style={{ width: '120px' }}
            />
          </div>
        </div>
      )}

      <div
        className="relative mx-auto"
        style={{ width: `${sizeConfig.width}px`, height: `${sizeConfig.height}px` }}
      >
        <HSICanvas
          telemetry={telemetryData}
          target={targetForCanvas}
          mission={missionForCanvas}
          poi={poiForCanvas}
          scaleRange={scaleRange}
          useLogarithmicScale={useLogarithmicScale}
          useRawPerceptionData={useRawPerceptionData}
        />
      </div>

      {size === 'small' && targetMetrics && (
        <div className="mt-2 text-[10px] text-center text-sky-200">
          {(objectTarget?.clusterLabel ?? objectTarget?.clusterId) ?? 'Target'}: {targetMetrics.slantDistance.toFixed(1)} m
        </div>
      )}

      {size === 'small' && missionMetrics && missionWaypoint && (
        <div className="text-[10px] text-center text-amber-200">
          {(missionWaypoint.label ?? 'Waypoint')}: {missionMetrics.distance.toFixed(1)} m · BRG {missionMetrics.bearing.toFixed(0)}°
        </div>
      )}

      {size === 'small' && poiMetrics && (
        <div className="text-[10px] text-center text-purple-300">
          POI: {poiMetrics.slantDistance.toFixed(1)} m · BRG {poiMetrics.bearing.toFixed(0)}°
        </div>
      )}

      {size === 'normal' && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div className="glass-panel border border-gray-700/60 p-2">
            <div className="text-[11px] text-gray-400 uppercase mb-1">Target</div>
            {targetMetrics ? (
              <div className="text-sky-200 space-y-1">
                <div>{(objectTarget?.clusterLabel ?? objectTarget?.clusterId) ?? 'Target'}</div>
                <div>{targetMetrics.slantDistance.toFixed(1)} m · BRG {targetMetrics.bearing.toFixed(0)}°</div>
                {targetMetrics.altitudeDelta != null && (
                  <div>Δ Alt {targetMetrics.altitudeDelta.toFixed(1)} m</div>
                )}
              </div>
            ) : (
              <div className="text-gray-500">No target</div>
            )}
          </div>
          <div className="glass-panel border border-gray-700/60 p-2">
            <div className="text-[11px] text-gray-400 uppercase mb-1">Mission</div>
            {missionMetrics && missionWaypoint ? (
              <div className="text-amber-200 space-y-1">
                <div>{missionWaypoint.label ?? 'Waypoint'}</div>
                <div>{missionMetrics.distance.toFixed(1)} m · BRG {missionMetrics.bearing.toFixed(0)}°</div>
                {missionMetrics.altitudeDelta != null && (
                  <div>Δ Alt {missionMetrics.altitudeDelta.toFixed(1)} m</div>
                )}
              </div>
            ) : (
              <div className="text-gray-500">Idle</div>
            )}
          </div>
          <div className="glass-panel border border-gray-700/60 p-2">
            <div className="text-[11px] text-gray-400 uppercase mb-1">POI</div>
            {poiMetrics ? (
              <div className="text-purple-200 space-y-1">
                <div>{poiLabel}</div>
                <div>{poiMetrics.slantDistance.toFixed(1)} m · BRG {poiMetrics.bearing.toFixed(0)}°</div>
                {poiMetrics.pitch != null && (
                  <div>Pitch {poiMetrics.pitch.toFixed(1)}°</div>
                )}
              </div>
            ) : (
              <div className="text-gray-500">Not set</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
