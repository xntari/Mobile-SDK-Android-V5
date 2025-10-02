import React from 'react';
import { Panel } from './Panel';
import { TelemetryData } from '../types';
import { rotationMatrixFromEuler, vectorRotate, combineRotationMatrices } from '../utils/poseMath';
import { getCameraCenterRay, projectRayToGround } from '../utils/rayProjection';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { missionPlannerStore } from '../state/missionPlanner';
import type { MissionWaypointTarget, PoiTarget } from '../types/missionPlanner';
import { computeTargetMetrics } from '../utils/objectMemoryTarget';
import { OrientationCompass } from './OrientationCompass';
import { telemetryShallowEqual } from '../utils/telemetryCompare';
import { orientationPanelControls } from './panelControls';
import { usePanelVisibility } from '../hooks/usePanelVisibility';

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

    const altitudeDelta = typeof altitude === 'number' && typeof telemetry.altitude === 'number'
      ? altitude - telemetry.altitude
      : null;

    return { distance, bearing, altitudeDelta };
  }, [panelVisible, telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.altitude, missionWaypoint?.latitude, missionWaypoint?.longitude, missionWaypoint?.altitude]);
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

    const altitudeDelta = typeof altitude === 'number' && typeof telemetry.altitude === 'number'
      ? altitude - telemetry.altitude
      : null;

    const slantDistance = altitudeDelta != null
      ? Math.sqrt(horizontalDistance ** 2 + altitudeDelta ** 2)
      : horizontalDistance;

    const pitch = altitudeDelta != null
      ? (Math.atan2(altitudeDelta, horizontalDistance) * 180) / Math.PI
      : null;

    return { horizontalDistance, slantDistance, bearing, altitudeDelta, pitch };
  }, [panelVisible, telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.altitude, missionPoi?.latitude, missionPoi?.longitude, missionPoi?.altitude]);

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
      <div className="flex flex-col gap-2 text-xs text-gray-200 h-full overflow-y-auto" style={{ fontFamily: 'monospace' }}>
        {targetMetrics && (
          <div className="bg-black/60 border border-sky-700/50 rounded px-3 py-2 text-[11px] text-sky-200 flex items-center justify-between">
            <div className="font-semibold text-sky-100">{objectTarget?.clusterLabel ?? objectTarget?.clusterId ?? 'Target'}</div>
            <div className="flex items-center gap-3">
              <span>{Number.isFinite(targetMetrics.slantDistance) ? `${targetMetrics.slantDistance.toFixed(1)} m` : '—'}</span>
              {targetMetrics.altitudeDelta != null && Number.isFinite(targetMetrics.altitudeDelta) && (
                <span>Δalt {targetMetrics.altitudeDelta.toFixed(1)} m</span>
              )}
              <span>BRG {targetMetrics.bearing.toFixed(0)}°</span>
              {targetPitchDeg != null && Number.isFinite(targetPitchDeg) && (
                <span>Pitch {targetPitchDeg.toFixed(1)}°</span>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-center">
          <OrientationCompass
            telemetry={telemetry}
            size={240}
            target={targetMetrics ? {
              bearing: targetMetrics.bearing,
              distance: targetMetrics.slantDistance,
              altitudeDelta: targetMetrics.altitudeDelta,
              pitch: targetPitchDeg,
            } : undefined}
            mission={missionMetrics ? {
              bearing: missionMetrics.bearing,
              distance: missionMetrics.distance,
              altitudeDelta: missionMetrics.altitudeDelta,
              pitch: missionPitchDeg,
            } : undefined}
            poi={poiMetrics ? {
              bearing: poiMetrics.bearing,
              distance: poiMetrics.slantDistance,
              altitudeDelta: poiMetrics.altitudeDelta,
              pitch: poiMetrics.pitch ?? null,
            } : undefined}
            homeBearing={telemetry?.home_bearing}
          />
        </div>
        {missionMetrics && missionWaypoint && (
          <div className="bg-black/50 border border-amber-500/40 text-amber-200 rounded px-3 py-2 text-[11px] flex items-center justify-between">
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
          <div className="bg-black/50 border border-purple-500/40 text-purple-200 rounded px-3 py-2 text-[11px] flex items-center justify-between">
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
        <div className="flex gap-4">
          <section className="flex-1">
            <div className="text-gray-400 uppercase text-[10px]">Aircraft</div>
            <div>Roll: {formatAngle(telemetry?.attitude?.roll)}°</div>
            <div>Pitch: {formatAngle(telemetry?.attitude?.pitch)}°</div>
            <div>Yaw: {formatAngle(telemetry?.attitude?.yaw)}°</div>
            <div>Heading: {formatAngle(telemetry?.compass_heading)}°</div>
            <div>Motors: {telemetry?.motors_on ? '🟢 ON' : '⚫ OFF'}</div>
            <div className="mt-1 text-gray-400 uppercase text-[10px]">Altitude</div>
            <div>AGL: {formatNumber(telemetry?.altitude, 1)} m</div>
            <div>Above TO: {formatNumber(telemetry?.altitude_above_takeoff, 1)} m</div>
            <div>TO Alt: {formatNumber(telemetry?.takeoff_altitude, 1)} m</div>
            <div>AMSL: {formatNumber(telemetry?.altitude_amsl ?? ((telemetry?.takeoff_altitude || 0) + (telemetry?.altitude || 0)), 1)} m</div>
            <div>Baro: {formatNumber(telemetry?.altitude_barometric, 1)} m</div>
            {telemetry?.altitude_ultrasonic !== undefined && telemetry?.altitude_ultrasonic !== null && (
              <div>Ultrasonic: {formatNumber(telemetry.altitude_ultrasonic, 1)} m</div>
            )}
          </section>
          <section className="flex-1">
            <div className="text-gray-400 uppercase text-[10px]">Gimbal</div>
            <div>Status: {gimbal?.connected ? 'OK' : '–'}</div>
            <div>Pitch: {formatAngle(gimbal?.attitude?.pitch)}°</div>
            <div>Yaw: {formatAngle(gimbal?.attitude?.yaw)}°</div>
            <div>Relative: {formatAngle(gimbal?.yaw_relative)}°</div>
          </section>
        </div>
        <section>
          <div className="text-gray-400 uppercase text-[10px]">Optics</div>
          <div>Lens: {telemetry?.camera_optics?.lens ?? '–'}</div>
          <div>Lens Type: {telemetry?.camera_optics?.lens_type ?? '–'}</div>
          <div>Zoom: {formatNumber(telemetry?.camera_optics?.zoom_ratio)}×</div>
          <div>Zoom Range: {telemetry?.camera_optics?.zoom_range ?
            `${formatNumber(telemetry.camera_optics.zoom_range.min)}× – ${formatNumber(telemetry.camera_optics.zoom_range.max)}×` : '–'}</div>
          <div>Focal Length: {formatNumber(telemetry?.camera_optics?.focal_length, 1)} mm</div>
          <div>FOV (H×V): {telemetry?.camera_optics?.display_fov ?
            `${formatAngle(telemetry.camera_optics.display_fov.horizontal)}° × ${formatAngle(telemetry.camera_optics.display_fov.vertical)}°` : '–'}</div>
          <div>Laser: {telemetry?.camera_optics?.laser_measurement ?? '–'}</div>
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
        </section>
        <section>
          <div className="text-gray-400 uppercase text-[10px]">Vectors</div>
          <div>Gimbal direction: {gimbalVector ? `${gimbalVector.x.toFixed(3)}, ${gimbalVector.y.toFixed(3)}, ${gimbalVector.z.toFixed(3)}` : '–'}</div>
          <div>Velocity vector: {telemetry?.velocity_vector ? `${formatNumber(telemetry.velocity_vector.x)} / ${formatNumber(telemetry.velocity_vector.y)} / ${formatNumber(telemetry.velocity_vector.z)} m/s` : '–'}</div>
        </section>
        {groundPoint && (
          <section>
            <div className="text-gray-400 uppercase text-[10px]">Ground Projection</div>
            <div>Lat: {formatNumber(groundPoint.latitude, 6)}°</div>
            <div>Lon: {formatNumber(groundPoint.longitude, 6)}°</div>
            <div>Alt: {formatNumber(groundPoint.altitude, 1)} m</div>
          </section>
        )}
      </div>
    </Panel>
  );
};

const orientationPropsEqual = (prev: OrientationPanelProps, next: OrientationPanelProps) => {
  return prev.sendCommand === next.sendCommand && telemetryShallowEqual(prev.telemetry, next.telemetry);
};

export const OrientationPanel = React.memo(OrientationPanelComponent, orientationPropsEqual);
