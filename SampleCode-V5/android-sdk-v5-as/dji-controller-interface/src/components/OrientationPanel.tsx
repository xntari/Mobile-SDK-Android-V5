import React from 'react';
import { Panel } from './Panel';
import { CollapsibleSection } from './CollapsibleSection';
import { TelemetryData } from '../types';
import { rotationMatrixFromEuler, vectorRotate, combineRotationMatrices } from '../utils/poseMath';
import { getCameraCenterRay, projectRayToGround } from '../utils/rayProjection';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { missionPlannerStore } from '../state/missionPlanner';
import type { MissionWaypointTarget, PoiTarget } from '../types/missionPlanner';
import { computeTargetMetrics } from '../utils/objectMemoryTarget';
import { HSICanvas } from './HSICanvas';
import { telemetryShallowEqual } from '../utils/telemetryCompare';
import { orientationPanelControls } from './panelControls';
import { usePanelVisibility } from '../hooks/usePanelVisibility';

const ORIENTATION_HSI_KEYS = {
  useRaw: 'orientation.hsi.useRaw360',
  scale: 'orientation.hsi.scale',
  log: 'orientation.hsi.useLog',
};

const clampScale = (value: number) => Math.min(Math.max(value, 0.5), 8);

type OrientationPanelProps = {
  telemetry: TelemetryData | null;
  sendCommand?: (payload: any) => Promise<any>;
};

function formatAngle(value?: number, digits = 1): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '–';
  }
  return value.toFixed(digits);
}

function formatNumber(value?: number, digits = 2): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '–';
  }
  return value.toFixed(digits);
}

const defaultVector = { x: 0, y: 0, z: -1 };

const OrientationPanelComponent: React.FC<OrientationPanelProps> = ({ telemetry, sendCommand }) => {
  const panelVisible = usePanelVisibility(
    orientationPanelControls.isVisible,
    'orientationPanelVisibilityChange',
  );
  const [isResetting, setIsResetting] = React.useState(false);
  const [hsiUseRaw, setHsiUseRaw] = React.useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(ORIENTATION_HSI_KEYS.useRaw);
      return stored != null ? stored === 'true' : true;
    } catch {
      return true;
    }
  });
  const [hsiScale, setHsiScale] = React.useState<number>(() => {
    try {
      const stored = localStorage.getItem(ORIENTATION_HSI_KEYS.scale);
      if (!stored) return 6;
      const parsed = parseFloat(stored);
      return Number.isFinite(parsed) ? clampScale(parsed) : 6;
    } catch {
      return 6;
    }
  });
  const [hsiUseLog, setHsiUseLog] = React.useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(ORIENTATION_HSI_KEYS.log);
      return stored != null ? stored === 'true' : true;
    } catch {
      return true;
    }
  });
  const [objectTarget, setObjectTarget] = React.useState<ObjectMemoryTargetSelection | null>(() => objectMemoryTargetStore.getCurrent());
  const [missionWaypoint, setMissionWaypoint] = React.useState<MissionWaypointTarget | null>(
    () => missionPlannerStore.getSnapshot().activeWaypoint ?? null,
  );
  const [missionPoi, setMissionPoi] = React.useState<PoiTarget | null>(
    () => missionPlannerStore.getSnapshot().poiTarget ?? null,
  );
  const targetMetrics = React.useMemo(
    () => (
      panelVisible
        ? computeTargetMetrics(telemetry, objectTarget?.anchor, objectTarget?.clusterLabel ?? objectTarget?.clusterId)
        : null
    ),
    [panelVisible, telemetry, objectTarget]
  );
  const targetPitchDeg = React.useMemo(() => {
    if (!targetMetrics || targetMetrics.altitudeDelta == null) return null;
    return (Math.atan2(targetMetrics.altitudeDelta, targetMetrics.horizontalDistance) * 180) / Math.PI;
  }, [targetMetrics]);
  React.useEffect(() => {
    if (!panelVisible) {
      return undefined;
    }
    return objectMemoryTargetStore.subscribe(setObjectTarget);
  }, [panelVisible]);
  React.useEffect(() => {
    if (!panelVisible) {
      return undefined;
    }
    return missionPlannerStore.subscribeActiveWaypoint(setMissionWaypoint);
  }, [panelVisible]);
  React.useEffect(() => {
    if (!panelVisible) {
      return undefined;
    }
    return missionPlannerStore.subscribePoiTarget(setMissionPoi);
  }, [panelVisible]);
  React.useEffect(() => {
    try {
      localStorage.setItem(ORIENTATION_HSI_KEYS.useRaw, String(hsiUseRaw));
    } catch {}
  }, [hsiUseRaw]);
  React.useEffect(() => {
    try {
      localStorage.setItem(ORIENTATION_HSI_KEYS.scale, String(hsiScale));
    } catch {}
  }, [hsiScale]);
  React.useEffect(() => {
    try {
      localStorage.setItem(ORIENTATION_HSI_KEYS.log, String(hsiUseLog));
    } catch {}
  }, [hsiUseLog]);
  const gimbal = telemetry?.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
  const aircraftMatrix = React.useMemo(() => {
    if (!panelVisible || !telemetry?.attitude) return null;
    const { roll = 0, pitch = 0, yaw = 0 } = telemetry.attitude;
    return rotationMatrixFromEuler({ roll, pitch, yaw });
  }, [panelVisible, telemetry?.attitude]);

  const gimbalVector = React.useMemo(() => {
    if (!panelVisible || !aircraftMatrix || !gimbal?.attitude) return null;
    const { pitch = 0, yaw = 0 } = gimbal.attitude;
    const gimbalMatrix = rotationMatrixFromEuler({ roll: 0, pitch, yaw });
    const combined = combineRotationMatrices([aircraftMatrix, gimbalMatrix]);
    return vectorRotate(defaultVector, combined);
  }, [panelVisible, aircraftMatrix, gimbal?.attitude]);

  const missionMetrics = React.useMemo(() => {
    if (!panelVisible || !telemetry?.location || !missionWaypoint) {
      return null;
    }

    const { latitude: lat1, longitude: lon1 } = telemetry.location;
    const { latitude: lat2, longitude: lon2, altitude } = missionWaypoint;
    if (
      typeof lat1 !== 'number' ||
      typeof lon1 !== 'number' ||
      typeof lat2 !== 'number' ||
      typeof lon2 !== 'number'
    ) {
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
      typeof telemetry?.location?.altitude === 'number'
        ? telemetry.location.altitude
        : typeof telemetry?.altitude === 'number'
          ? telemetry.altitude
          : null;

    const altitudeDelta = typeof altitude === 'number' && typeof aircraftAltitude === 'number'
      ? altitude - aircraftAltitude
      : null;

    return { distance, bearing, altitudeDelta };
  }, [
    panelVisible,
    telemetry?.location?.latitude,
    telemetry?.location?.longitude,
    telemetry?.location?.altitude,
    telemetry?.altitude,
    missionWaypoint?.latitude,
    missionWaypoint?.longitude,
    missionWaypoint?.altitude,
  ]);
  const missionPitchDeg = React.useMemo(() => {
    if (!missionMetrics || missionMetrics.altitudeDelta == null) return null;
    return (Math.atan2(missionMetrics.altitudeDelta, missionMetrics.distance) * 180) / Math.PI;
  }, [missionMetrics]);

  const poiMetrics = React.useMemo(() => {
    if (!panelVisible || !telemetry?.location || !missionPoi) {
      return null;
    }

    const { latitude: lat1, longitude: lon1 } = telemetry.location;
    const { latitude: lat2, longitude: lon2, altitude } = missionPoi;
    if (
      typeof lat1 !== 'number' || typeof lon1 !== 'number' ||
      typeof lat2 !== 'number' || typeof lon2 !== 'number'
    ) {
      return null;
    }

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    const horizontalDistance = 6371e3 * c;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

    const aircraftAltitude =
      typeof telemetry?.location?.altitude === 'number'
        ? telemetry.location.altitude
        : typeof telemetry?.altitude === 'number'
          ? telemetry.altitude
          : null;

    const altitudeDelta = typeof altitude === 'number' && typeof aircraftAltitude === 'number'
      ? altitude - aircraftAltitude
      : null;

    const slantDistance = altitudeDelta != null
      ? Math.sqrt(horizontalDistance ** 2 + altitudeDelta ** 2)
      : horizontalDistance;

    const pitch = altitudeDelta != null
      ? (Math.atan2(altitudeDelta, horizontalDistance) * 180) / Math.PI
      : null;

    return { horizontalDistance, slantDistance, bearing, altitudeDelta, pitch };
  }, [
    panelVisible,
    telemetry?.location?.latitude,
    telemetry?.location?.longitude,
    telemetry?.location?.altitude,
    telemetry?.altitude,
    missionPoi?.latitude,
    missionPoi?.longitude,
    missionPoi?.altitude,
  ]);

  // Calculate ground point projection for center of image
  const groundPoint = React.useMemo(() => {
    if (!panelVisible || !telemetry) return null;
    const point = projectRayToGround(telemetry, 640, 360, 1280, 720, false);
    return point;
  }, [panelVisible, telemetry]);

  const handleZeroGimbal = async () => {
    if (!sendCommand || isResetting) return;

    setIsResetting(true);
    try {
      await sendCommand({
        type: 'gimbal_reset',
        data: {
          index: 'LEFT_OR_MAIN',
          pitch: 0,
          yaw: 0
        }
      });
    } catch (error) {
      console.error('Zero gimbal error:', error);
    } finally {
      setTimeout(() => setIsResetting(false), 2000); // Increased to 2 seconds for longer operation
    }
  };

  if (!panelVisible) {
    return null;
  }

  return (
    <Panel
      title="Orientation"
      storageKey="orientation.panel"
      visibilityEventType="orientationPanelVisibilityChange"
      defaultPosition={{ x: 1160, y: 60 }}
      defaultSize={{ w: 320, h: 480 }}
    >
      
      <div className="space-y-3 text-xs text-gray-200 h-full overflow-y-auto pr-1" style={{ fontFamily: 'monospace' }}>
        <CollapsibleSection
          title="Compass & Targets"
          storageKey="orientation.section.compass"
        >
          <div className="relative w-full min-h-[220px] max-h-[360px] aspect-square">
            <HSICanvas
              telemetry={telemetry}
              target={targetMetrics ? {
                bearing: targetMetrics.bearing,
                distance: targetMetrics.slantDistance,
                altitudeDelta: targetMetrics.altitudeDelta,
                pitch: targetPitchDeg ?? null,
              } : null}
              mission={missionMetrics ? {
                bearing: missionMetrics.bearing,
                distance: missionMetrics.distance,
                altitudeDelta: missionMetrics.altitudeDelta ?? null,
                pitch: missionPitchDeg ?? null,
              } : null}
              poi={poiMetrics ? {
                bearing: poiMetrics.bearing,
                distance: poiMetrics.slantDistance,
                altitudeDelta: poiMetrics.altitudeDelta ?? null,
                pitch: poiMetrics.pitch ?? null,
              } : null}
              scaleRange={hsiScale}
              useLogarithmicScale={hsiUseLog}
              useRawPerceptionData={hsiUseRaw}
            />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[11px]">
            {missionMetrics && missionWaypoint && (
              <div className="bg-black/60 border border-amber-500/40 rounded px-3 py-2 text-amber-200 flex items-center justify-between">
                <div className="font-semibold text-amber-100">Next waypoint</div>
                <div className="flex items-center gap-3">
                  <span>{missionMetrics.distance.toFixed(1)} m</span>
                  <span>BRG {missionMetrics.bearing.toFixed(0)}°</span>
                  {missionMetrics.altitudeDelta != null && (
                    <span>Δalt {missionMetrics.altitudeDelta.toFixed(1)} m</span>
                  )}
                  {missionPitchDeg != null && Number.isFinite(missionPitchDeg) && (
                    <span>Pitch {missionPitchDeg.toFixed(1)}°</span>
                  )}
                </div>
              </div>
            )}
            {poiMetrics && (
              <div className="bg-black/50 border border-purple-500/40 rounded px-3 py-2 text-purple-200 flex items-center justify-between">
                <div className="font-semibold text-purple-100">Mission POI</div>
                <div className="flex items-center gap-3">
                  <span>{poiMetrics.slantDistance.toFixed(1)} m</span>
                  <span>BRG {poiMetrics.bearing.toFixed(0)}°</span>
                  {poiMetrics.altitudeDelta != null && (
                    <span>Δalt {poiMetrics.altitudeDelta.toFixed(1)} m</span>
                  )}
                  {poiMetrics.pitch != null && Number.isFinite(poiMetrics.pitch) && (
                    <span>Pitch {poiMetrics.pitch.toFixed(1)}°</span>
                  )}
                </div>
              </div>
            )}
            {targetMetrics && (
              <div className="bg-black/60 border border-sky-700/50 rounded px-3 py-2 text-sky-200 flex items-center justify-between">
                <div className="font-semibold text-sky-100">{objectTarget?.clusterLabel ?? objectTarget?.clusterId ?? 'Target'}</div>
                <div className="flex items-center gap-3">
                  <span>{Number.isFinite(targetMetrics.slantDistance) ? `${targetMetrics.slantDistance.toFixed(1)} m` : '—'}</span>
                  {targetMetrics.altitudeDelta != null && Number.isFinite(targetMetrics.altitudeDelta) && (
                    <span>Δalt {targetMetrics.altitudeDelta.toFixed(1)} m</span>
                  )}
                  <span>BRG {targetMetrics.bearing.toFixed(0)}°</span>
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-[10px] text-gray-400">
            <button
              type="button"
              onClick={() => setHsiUseRaw((prev) => !prev)}
              className={`px-2.5 py-1 rounded border transition ${
                hsiUseRaw
                  ? 'border-sky-500 text-sky-100 bg-sky-500/20'
                  : 'border-gray-600 text-gray-400 bg-gray-800 hover:border-sky-500'
              }`}
            >
              {hsiUseRaw ? '360° Raw' : 'Sector View'}
            </button>
            <label className="flex items-center gap-2">
              <span>Log scale</span>
              <input
                type="checkbox"
                checked={hsiUseLog}
                onChange={(event) => setHsiUseLog(event.target.checked)}
                className="accent-sky-400"
              />
            </label>
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <span>Scale {hsiScale.toFixed(1)} m</span>
              <input
                type="range"
                min="0.5"
                max="8"
                step="0.5"
                value={hsiScale}
                onChange={(event) => setHsiScale(clampScale(parseFloat(event.target.value)))}
                className="flex-1 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Aircraft Attitude"
          storageKey="orientation.section.aircraft"
          summary={telemetry?.compass_heading != null ? `${formatAngle(telemetry.compass_heading)}°` : '—'}
        >
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div>Roll: {formatAngle(telemetry?.attitude?.roll)}°</div>
              <div>Pitch: {formatAngle(telemetry?.attitude?.pitch)}°</div>
              <div>Yaw: {formatAngle(telemetry?.attitude?.yaw)}°</div>
              <div>Heading: {formatAngle(telemetry?.compass_heading)}°</div>
              <div>Motors: {telemetry?.motors_on ? '🟢 ON' : '⚫ OFF'}</div>
            </div>
            <div>
              <div className="mt-1 text-gray-400 uppercase text-[10px]">Altitude</div>
              <div>AGL: {formatNumber(telemetry?.altitude, 1)} m</div>
              <div>Above TO: {formatNumber(telemetry?.altitude_above_takeoff, 1)} m</div>
              <div>TO Alt: {formatNumber(telemetry?.takeoff_altitude, 1)} m</div>
              <div>
                AMSL: {formatNumber(
                  telemetry?.altitude_amsl ?? ((telemetry?.takeoff_altitude || 0) + (telemetry?.altitude || 0)),
                  1,
                )} m
              </div>
              <div>Baro: {formatNumber(telemetry?.altitude_barometric, 1)} m</div>
              {telemetry?.altitude_ultrasonic !== undefined && telemetry?.altitude_ultrasonic !== null && (
                <div>Ultrasonic: {formatNumber(telemetry.altitude_ultrasonic, 1)} m</div>
              )}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Gimbal"
          storageKey="orientation.section.gimbal"
          summary={gimbal?.attitude?.pitch != null ? `${formatAngle(gimbal.attitude.pitch)}°` : '—'}
        >
          <div className="flex flex-col gap-1">
            <div>Status: {gimbal?.connected ? 'OK' : '—'}</div>
            <div>Pitch: {formatAngle(gimbal?.attitude?.pitch)}°</div>
            <div>Yaw: {formatAngle(gimbal?.attitude?.yaw)}°</div>
            <div>Relative: {formatAngle(gimbal?.yaw_relative)}°</div>
            <button
              className={`mt-2 px-2 py-1 rounded text-[11px] transition-all ${
                isResetting
                  ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                  : 'bg-gray-700 hover:bg-gray-600 active:bg-gray-800'
              }`}
              disabled={!sendCommand || isResetting}
              onClick={handleZeroGimbal}
            >
              {isResetting ? 'Resetting...' : 'Zero Gimbal'}
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Optics"
          storageKey="orientation.section.optics"
          summary={telemetry?.camera_optics?.lens ?? '—'}
        >
          <div className="flex flex-col gap-1">
            <div>Lens: {telemetry?.camera_optics?.lens ?? '–'}</div>
            <div>Lens Type: {telemetry?.camera_optics?.lens_type ?? '–'}</div>
            <div>Zoom: {formatNumber(telemetry?.camera_optics?.zoom_ratio)}×</div>
            <div>
              Zoom Range: {telemetry?.camera_optics?.zoom_range ?
                `${formatNumber(telemetry.camera_optics.zoom_range.min)}× – ${formatNumber(telemetry.camera_optics.zoom_range.max)}×` : '–'}
            </div>
            <div>Focal Length: {formatNumber(telemetry?.camera_optics?.focal_length, 1)} mm</div>
            <div>
              FOV (H×V): {telemetry?.camera_optics?.display_fov ?
                `${formatAngle(telemetry.camera_optics.display_fov.horizontal)}° × ${formatAngle(telemetry.camera_optics.display_fov.vertical)}°` : '–'}
            </div>
            <div>Laser: {telemetry?.camera_optics?.laser_measurement ?? '–'}</div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Vectors"
          storageKey="orientation.section.vectors"
          defaultOpen={false}
        >
          <div className="flex flex-col gap-1">
            <div>
              Gimbal direction: {gimbalVector ? `${gimbalVector.x.toFixed(3)}, ${gimbalVector.y.toFixed(3)}, ${gimbalVector.z.toFixed(3)}` : '–'}
            </div>
            <div>
              Velocity vector: {telemetry?.velocity_vector ?
                `${formatNumber(telemetry.velocity_vector.x)} / ${formatNumber(telemetry.velocity_vector.y)} / ${formatNumber(telemetry.velocity_vector.z)} m/s` : '–'}
            </div>
          </div>
        </CollapsibleSection>

        {groundPoint && (
          <CollapsibleSection
            title="Ground Projection"
            storageKey="orientation.section.ground"
            defaultOpen={false}
            summary={`${formatNumber(groundPoint.latitude, 4)}°, ${formatNumber(groundPoint.longitude, 4)}°`}
          >
            <div>Lat: {formatNumber(groundPoint.latitude, 6)}°</div>
            <div>Lon: {formatNumber(groundPoint.longitude, 6)}°</div>
            <div>Alt: {formatNumber(groundPoint.altitude, 1)} m</div>
          </CollapsibleSection>
        )}
      </div>
    </Panel>
  );
};

const orientationPropsEqual = (prev: OrientationPanelProps, next: OrientationPanelProps) => {
  return prev.sendCommand === next.sendCommand && telemetryShallowEqual(prev.telemetry, next.telemetry);
};

export const OrientationPanel = React.memo(OrientationPanelComponent, orientationPropsEqual);
