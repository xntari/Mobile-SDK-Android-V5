import React from 'react';
import { Panel } from './Panel';
import { TelemetryData } from '../types';
import { rotationMatrixFromEuler, vectorRotate, combineRotationMatrices } from '../utils/poseMath';

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

  return (
    <Panel
      title="Orientation"
      storageKey="orientation.panel"
      visibilityEventType="orientationPanelVisibilityChange"
      defaultPosition={{ x: 1160, y: 60 }}
      defaultSize={{ w: 320, h: 260 }}
    >
      <div className="flex flex-col gap-3 text-xs text-gray-200 h-full" style={{ fontFamily: 'monospace' }}>
        <section>
          <div className="text-gray-400 uppercase text-[10px]">Aircraft</div>
          <div>Roll: {formatAngle(telemetry?.attitude?.roll)}°</div>
          <div>Pitch: {formatAngle(telemetry?.attitude?.pitch)}°</div>
          <div>Yaw: {formatAngle(telemetry?.attitude?.yaw)}°</div>
          <div>Heading (mag): {formatAngle(telemetry?.compass_heading)}°</div>
        </section>
        <section>
          <div className="text-gray-400 uppercase text-[10px]">H20N Gimbal</div>
          <div>Status: {gimbal?.connected ? 'connected' : 'unknown'}</div>
          <div>Pitch: {formatAngle(gimbal?.attitude?.pitch)}°</div>
          <div>Yaw: {formatAngle(gimbal?.attitude?.yaw)}°</div>
          <div>Yaw relative: {formatAngle(gimbal?.yaw_relative)}°</div>
          <div>Pitch limit: {formatAngle(gimbal?.limits?.pitch?.min)}° / {formatAngle(gimbal?.limits?.pitch?.max)}°</div>
        </section>
        <section>
          <div className="text-gray-400 uppercase text-[10px]">Optics</div>
          <div>Lens: {telemetry?.camera_optics?.lens ?? '–'}</div>
          <div>Lens Type: {telemetry?.camera_optics?.lens_type ?? '–'}</div>
          <div>Zoom: {formatNumber(telemetry?.camera_optics?.zoom_ratio)}×</div>
          <div>Focal Length: {formatNumber(telemetry?.camera_optics?.focal_length, 1)} mm</div>
          <div>FOV (H×V): {telemetry?.camera_optics?.display_fov ? `${formatAngle(telemetry.camera_optics.display_fov.horizontal)}° × ${formatAngle(telemetry.camera_optics.display_fov.vertical)}°` : '–'}</div>
          <div>Laser: {telemetry?.camera_optics?.laser_measurement ?? '–'}</div>
          <button
            className="mt-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-[11px]"
            disabled={!sendCommand}
            onClick={() => {
              sendCommand?.({ type: 'gimbal_reset', data: { index: 'LEFT_OR_MAIN' } }).catch((error) => {
                console.error('gimbal_reset error', error);
              });
            }}
          >
            Zero Gimbal
          </button>
        </section>
        <section>
          <div className="text-gray-400 uppercase text-[10px]">Vectors</div>
          <div>Gimbal direction: {gimbalVector ? `${gimbalVector.x.toFixed(3)}, ${gimbalVector.y.toFixed(3)}, ${gimbalVector.z.toFixed(3)}` : '–'}</div>
          <div>Velocity vector: {telemetry?.velocity_vector ? `${formatNumber(telemetry.velocity_vector.x)} / ${formatNumber(telemetry.velocity_vector.y)} / ${formatNumber(telemetry.velocity_vector.z)} m/s` : '–'}</div>
        </section>
      </div>
    </Panel>
  );
};
