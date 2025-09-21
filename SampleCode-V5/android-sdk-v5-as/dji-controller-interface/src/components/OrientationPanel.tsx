import React from 'react';
import { Panel } from './Panel';
import { TelemetryData } from '../types';
import { rotationMatrixFromEuler, vectorRotate, combineRotationMatrices } from '../utils/poseMath';
import { getCameraCenterRay, projectRayToGround } from '../utils/rayProjection';
import { OrientationCompass } from './OrientationCompass';

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

export const OrientationPanel: React.FC<OrientationPanelProps> = ({ telemetry, sendCommand }) => {
  const [isResetting, setIsResetting] = React.useState(false);
  const gimbal = telemetry?.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
  const aircraftMatrix = React.useMemo(() => {
    if (!telemetry?.attitude) return null;
    const { roll = 0, pitch = 0, yaw = 0 } = telemetry.attitude;
    return rotationMatrixFromEuler({ roll, pitch, yaw });
  }, [telemetry?.attitude]);

  const gimbalVector = React.useMemo(() => {
    if (!aircraftMatrix || !gimbal?.attitude) return null;
    const { pitch = 0, yaw = 0 } = gimbal.attitude;
    const gimbalMatrix = rotationMatrixFromEuler({ roll: 0, pitch, yaw });
    const combined = combineRotationMatrices([aircraftMatrix, gimbalMatrix]);
    return vectorRotate(defaultVector, combined);
  }, [aircraftMatrix, gimbal?.attitude]);

  // Calculate ground point projection for center of image
  const groundPoint = React.useMemo(() => {
    if (!telemetry) return null;
    const point = projectRayToGround(telemetry, 640, 360, 1280, 720, false);
    return point;
  }, [telemetry]);

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

  return (
    <Panel
      title="Orientation"
      storageKey="orientation.panel"
      visibilityEventType="orientationPanelVisibilityChange"
      defaultPosition={{ x: 1160, y: 60 }}
      defaultSize={{ w: 320, h: 480 }}
    >
      <div className="flex flex-col gap-2 text-xs text-gray-200 h-full overflow-y-auto" style={{ fontFamily: 'monospace' }}>
        <div className="flex justify-center">
          <OrientationCompass telemetry={telemetry} size={240} />
        </div>
        <div className="flex gap-4">
          <section className="flex-1">
            <div className="text-gray-400 uppercase text-[10px]">Aircraft</div>
            <div>Roll: {formatAngle(telemetry?.attitude?.roll)}°</div>
            <div>Pitch: {formatAngle(telemetry?.attitude?.pitch)}°</div>
            <div>Yaw: {formatAngle(telemetry?.attitude?.yaw)}°</div>
            <div>Heading: {formatAngle(telemetry?.compass_heading)}°</div>
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
