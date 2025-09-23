import { TelemetryData } from '../types';
import type { ObjectMemoryClusterAnchor } from '../agent/objectMemoryClient';
import { geographicToENU } from './rayProjection';

export interface TargetMetrics {
  label: string;
  bearing: number;
  horizontalDistance: number;
  slantDistance: number;
  altitudeDelta: number | null;
  enu: { east: number; north: number; up: number };
  targetPosition: { latitude: number; longitude: number; altitude_m?: number };
  dronePosition: { latitude: number; longitude: number; altitude_m?: number | null };
  distanceSource: 'anchor' | 'computed';
}

const normalizeAngle = (deg: number): number => ((deg % 360) + 360) % 360;

export function computeTargetMetrics(
  telemetry: TelemetryData | null | undefined,
  anchor: ObjectMemoryClusterAnchor | null | undefined,
  clusterLabel?: string | null
): TargetMetrics | null {
  if (!telemetry?.location || !anchor?.object_position) return null;

  const aircraftLoc = telemetry.location;
  const targetPos = anchor.object_position;

  const originAltitude = anchor.drone_position.altitude_m ?? aircraftLoc.altitude ?? telemetry.altitude_amsl ?? ((telemetry.takeoff_altitude || 0) + (telemetry.altitude || 0));
  const targetAltitude = targetPos.altitude_m
    ?? anchor.object_map?.laser_location?.altitude_m
    ?? anchor.object_map?.target_point?.altitude_m
    ?? originAltitude;
  const enu = geographicToENU({
    latitude: targetPos.latitude,
    longitude: targetPos.longitude,
    altitude: targetAltitude,
  }, {
    latitude: aircraftLoc.latitude,
    longitude: aircraftLoc.longitude,
    altitude: originAltitude,
  });

  const horizontalDistance = Math.sqrt(enu.east ** 2 + enu.north ** 2);
  const droneAlt = anchor.drone_position.altitude_m ?? aircraftLoc.altitude ?? telemetry.altitude_amsl ?? null;
  const targetAlt = targetAltitude ?? null;

  const altitudeDelta = droneAlt != null && targetAlt != null ? targetAlt - droneAlt : null;
  let slantDistance: number;
  let distanceSource: 'anchor' | 'computed' = 'computed';
  if (typeof anchor.distance_m === 'number' && Number.isFinite(anchor.distance_m)) {
    slantDistance = anchor.distance_m;
    distanceSource = 'anchor';
  } else if (altitudeDelta != null) {
    slantDistance = Math.sqrt(horizontalDistance ** 2 + altitudeDelta ** 2);
  } else {
    slantDistance = Math.sqrt(horizontalDistance ** 2 + enu.up ** 2);
  }

  const bearing = normalizeAngle((Math.atan2(enu.east, enu.north) * 180) / Math.PI);

  return {
    label: clusterLabel || anchor.source_camera || anchor.sample_id,
    bearing,
    horizontalDistance,
    slantDistance,
    altitudeDelta,
    enu,
    targetPosition: {
      latitude: targetPos.latitude,
      longitude: targetPos.longitude,
      altitude_m: targetAltitude,
    },
    dronePosition: {
      latitude: aircraftLoc.latitude,
      longitude: aircraftLoc.longitude,
      altitude_m: droneAlt,
    },
    distanceSource,
  };
}
