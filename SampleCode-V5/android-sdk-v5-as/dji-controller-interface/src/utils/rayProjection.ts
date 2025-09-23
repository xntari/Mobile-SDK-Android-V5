// Ray projection utilities for camera to world coordinate transformations
// Combines aircraft pose, gimbal angles, and camera intrinsics to project rays

import { TelemetryData } from '../types';
import { rotationMatrixFromEuler, vectorRotate, combineRotationMatrices } from './poseMath';
import { getCameraIntrinsics, pixelToRay } from './cameraIntrinsics';

type Matrix3 = [number, number, number, number, number, number, number, number, number];

export interface GeographicPoint {
  latitude: number;
  longitude: number;
  altitude: number; // meters above sea level
}

export interface ENUPoint {
  east: number;   // meters
  north: number;  // meters
  up: number;     // meters
}

export interface ECEFPoint {
  x: number; // meters
  y: number; // meters
  z: number; // meters
}

/**
 * Convert geographic coordinates to ECEF (Earth-Centered, Earth-Fixed)
 * @param point Geographic coordinates (lat, lon, alt)
 * @returns ECEF coordinates in meters
 */
export function geographicToECEF(point: GeographicPoint): ECEFPoint {
  const a = 6378137.0; // WGS84 semi-major axis in meters
  const f = 1 / 298.257223563; // WGS84 flattening
  const e2 = f * (2 - f); // First eccentricity squared

  const lat = (point.latitude * Math.PI) / 180;
  const lon = (point.longitude * Math.PI) / 180;
  const alt = point.altitude;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);

  return {
    x: (N + alt) * cosLat * Math.cos(lon),
    y: (N + alt) * cosLat * Math.sin(lon),
    z: (N * (1 - e2) + alt) * sinLat,
  };
}

/**
 * Convert ECEF to geographic coordinates
 * @param point ECEF coordinates in meters
 * @returns Geographic coordinates (lat, lon, alt)
 */
export function ecefToGeographic(point: ECEFPoint): GeographicPoint {
  const a = 6378137.0; // WGS84 semi-major axis
  const f = 1 / 298.257223563; // WGS84 flattening
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2); // Second eccentricity squared

  const p = Math.sqrt(point.x * point.x + point.y * point.y);
  const theta = Math.atan2(point.z * a, p * a * Math.sqrt(1 - e2));

  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  const lat = Math.atan2(
    point.z + ep2 * a * Math.sqrt(1 - e2) * sinTheta * sinTheta * sinTheta,
    p - e2 * a * cosTheta * cosTheta * cosTheta
  );

  const lon = Math.atan2(point.y, point.x);
  const sinLat = Math.sin(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - N;

  return {
    latitude: (lat * 180) / Math.PI,
    longitude: (lon * 180) / Math.PI,
    altitude: alt,
  };
}

/**
 * Convert geographic to ENU (East-North-Up) coordinates
 * @param point Point to convert
 * @param origin Origin point for ENU system
 * @returns ENU coordinates in meters
 */
export function geographicToENU(point: GeographicPoint, origin: GeographicPoint): ENUPoint {
  const pointECEF = geographicToECEF(point);
  const originECEF = geographicToECEF(origin);

  // ECEF difference
  const dx = pointECEF.x - originECEF.x;
  const dy = pointECEF.y - originECEF.y;
  const dz = pointECEF.z - originECEF.z;

  // Convert to ENU using rotation matrix
  const lat = (origin.latitude * Math.PI) / 180;
  const lon = (origin.longitude * Math.PI) / 180;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  return {
    east: -sinLon * dx + cosLon * dy,
    north: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
    up: cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
  };
}

/**
 * Project camera ray to ground intersection
 * @param telemetry Current telemetry data
 * @param pixelX X coordinate in image
 * @param pixelY Y coordinate in image
 * @param imageWidth Image width in pixels
 * @param imageHeight Image height in pixels
 * @param useTerrainModel If true, use terrain model; if false, use flat earth at sea level
 * @returns Projected point on ground or null if no intersection
 */
export function projectRayToGround(
  telemetry: TelemetryData,
  pixelX: number,
  pixelY: number,
  imageWidth: number,
  imageHeight: number,
  useTerrainModel: boolean = false,
  overrideDistance?: number
): GeographicPoint | null {
  if (!telemetry.location || !telemetry.attitude) {
    return null;
  }

  const gimbal = telemetry.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
  if (!gimbal?.attitude) {
    return null;
  }

  // Get camera intrinsics
  const zoomRatio = telemetry.camera_optics?.zoom_ratio || 1.0;
  const intrinsics = getCameraIntrinsics(zoomRatio);

  // Get ray in camera coordinates
  const cameraRay = pixelToRay(pixelX, pixelY, imageWidth, imageHeight, intrinsics);

  // Transform ray through gimbal and aircraft rotations
  // 1. Camera to gimbal (assuming camera aligned with gimbal)
  const gimbalMatrix = rotationMatrixFromEuler({
    roll: gimbal.attitude.roll || 0,
    pitch: gimbal.attitude.pitch || 0,
    yaw: gimbal.attitude.yaw || 0,
  });

  // 2. Gimbal to aircraft
  const aircraftMatrix = rotationMatrixFromEuler({
    roll: telemetry.attitude.roll || 0,
    pitch: telemetry.attitude.pitch || 0,
    yaw: telemetry.attitude.yaw || 0,
  });

  // 3. Combine transformations
  const worldMatrix = combineRotationMatrices([aircraftMatrix, gimbalMatrix]);

  // Transform ray to world coordinates
  const worldRay = vectorRotate(cameraRay, worldMatrix);

  // Aircraft position
  const aircraftAltitude = telemetry.location?.altitude ?? telemetry.altitude_amsl ?? ((telemetry.takeoff_altitude || 0) + (telemetry.altitude || 0));
  const aircraftPos: GeographicPoint = {
    latitude: telemetry.location.latitude,
    longitude: telemetry.location.longitude,
    altitude: aircraftAltitude,
  };

  // Check for laser range data (if available)
  let effectiveDistance: number | null = null;
  if (typeof overrideDistance === 'number' && isFinite(overrideDistance) && overrideDistance > 0) {
    effectiveDistance = overrideDistance;
  } else if (telemetry.camera_optics?.laser_measurement) {
    const laserRange = parseFloat(telemetry.camera_optics.laser_measurement);
    if (!isNaN(laserRange) && laserRange > 0) {
      effectiveDistance = laserRange;
    }
  }

  if (effectiveDistance && effectiveDistance > 0) {
    // Use provided/laser range for precise distance
    return projectRayWithDistance(aircraftPos, worldRay, effectiveDistance);
  }

  // Ray-ground intersection (simplified flat earth model)
  const groundAltitude = useTerrainModel ? 0 : 0; // TODO: Implement terrain model

  // Check if ray points downward
  if (worldRay.z >= 0) {
    return null; // Ray points upward, no ground intersection
  }

  // Calculate intersection distance
  const height = aircraftPos.altitude - groundAltitude;
  const distance = height / -worldRay.z;

  return projectRayWithDistance(aircraftPos, worldRay, distance);
}

/**
 * Project ray from origin with given distance
 * @param origin Origin point
 * @param ray Normalized ray direction in world frame
 * @param distance Distance along ray in meters
 * @returns Projected point
 */
function projectRayWithDistance(
  origin: GeographicPoint,
  ray: { x: number; y: number; z: number },
  distance: number
): GeographicPoint {
  // Convert to local ENU for projection
  const eastOffset = ray.x * distance;
  const northOffset = ray.y * distance;
  const upOffset = ray.z * distance;

  // Approximate conversion (works for small distances)
  // More accurate would be to go through ECEF
  const metersPerDegreeLat = 111319.9; // At equator
  const metersPerDegreeLon = 111319.9 * Math.cos((origin.latitude * Math.PI) / 180);

  return {
    latitude: origin.latitude + northOffset / metersPerDegreeLat,
    longitude: origin.longitude + eastOffset / metersPerDegreeLon,
    altitude: origin.altitude + upOffset,
  };
}

export function projectRayToGroundNormalized(
  telemetry: TelemetryData,
  normalizedX: number,
  normalizedY: number,
  imageWidth: number = 1280,
  imageHeight: number = 720,
  useTerrainModel: boolean = false,
  overrideDistance?: number
): GeographicPoint | null {
  if (!isFinite(imageWidth) || imageWidth <= 0 || !isFinite(imageHeight) || imageHeight <= 0) {
    return null;
  }
  const clampedX = Math.max(0, Math.min(1, normalizedX));
  const clampedY = Math.max(0, Math.min(1, normalizedY));
  const pixelX = clampedX * imageWidth;
  const pixelY = clampedY * imageHeight;
  return projectRayToGround(telemetry, pixelX, pixelY, imageWidth, imageHeight, useTerrainModel, overrideDistance);
}

/**
 * Calculate error between predicted and actual ground point
 * @param predicted Predicted ground point
 * @param actual Actual ground point
 * @returns Error in meters
 */
export function calculateProjectionError(predicted: GeographicPoint, actual: GeographicPoint): number {
  const enu = geographicToENU(predicted, actual);
  return Math.sqrt(enu.east ** 2 + enu.north ** 2 + enu.up ** 2);
}

function transposeMatrix(matrix: Matrix3): Matrix3 {
  return [
    matrix[0], matrix[3], matrix[6],
    matrix[1], matrix[4], matrix[7],
    matrix[2], matrix[5], matrix[8],
  ];
}

/**
 * Get camera center ray (for debugging/visualization)
 * @param telemetry Current telemetry data
 * @returns Ray from camera center in world coordinates
 */
export function getCameraCenterRay(telemetry: TelemetryData): { x: number; y: number; z: number } | null {
  const gimbal = telemetry.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
  if (!gimbal?.attitude || !telemetry.attitude) {
    return null;
  }

  // Camera looks along -Z axis
  const cameraRay = { x: 0, y: 0, z: -1 };

  // Transform through gimbal and aircraft
  const gimbalMatrix = rotationMatrixFromEuler({
    roll: 0,
    pitch: gimbal.attitude.pitch || 0,
    yaw: gimbal.attitude.yaw || 0,
  });

  const aircraftMatrix = rotationMatrixFromEuler({
    roll: telemetry.attitude.roll || 0,
    pitch: telemetry.attitude.pitch || 0,
    yaw: telemetry.attitude.yaw || 0,
  });

  const worldMatrix = combineRotationMatrices([aircraftMatrix, gimbalMatrix]);

  return vectorRotate(cameraRay, worldMatrix);
}

export interface ScreenProjectionResult {
  normalized: { x: number; y: number };
  screen: { x: number; y: number };
  inFrame: boolean;
  cameraVector: { x: number; y: number; z: number };
  distance: number;
}

interface ProjectToScreenOptions {
  imageWidth?: number;
  imageHeight?: number;
  cameraType?: 'main' | 'fpv';
  cameraModel?: string;
  baseFocalLength?: number;
  zoomRatioOverride?: number;
  horizontalFovOverride?: number;
  verticalFovOverride?: number;
}

export function projectGeographicPointToScreen(
  telemetry: TelemetryData,
  target: GeographicPoint,
  options: ProjectToScreenOptions = {}
): ScreenProjectionResult | null {
  if (!telemetry.location || !telemetry.attitude) {
    return null;
  }

  const imageWidth = options.imageWidth ?? 1280;
  const imageHeight = options.imageHeight ?? 720;
  if (imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const cameraType = options.cameraType ?? 'main';
  const gimbal = telemetry.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN' || g.index === 'MAIN' || g.index === 'PRIMARY');

  const gimbalAttitude = gimbal?.attitude;
  const gimbalPitch = gimbalAttitude?.pitch ?? 0;
  const gimbalRoll = gimbalAttitude?.roll ?? 0;
  const aircraftYaw = telemetry.attitude.yaw || 0;
  const gimbalYawRel = typeof gimbal?.yaw_relative === 'number'
    ? gimbal.yaw_relative
    : (gimbalAttitude?.yaw ?? aircraftYaw) - aircraftYaw;

  const aircraftMatrix = rotationMatrixFromEuler({
    roll: telemetry.attitude.roll || 0,
    pitch: telemetry.attitude.pitch || 0,
    yaw: aircraftYaw,
  });

  const worldToBody = transposeMatrix(aircraftMatrix);

  const gimbalMatrix = rotationMatrixFromEuler({
    roll: gimbalRoll,
    pitch: gimbalPitch,
    yaw: gimbalYawRel,
  });
  const bodyToCamera = transposeMatrix(gimbalMatrix);

  const originAltitude = telemetry.location.altitude ?? telemetry.altitude ?? 0;
  const enu = geographicToENU({
    latitude: target.latitude,
    longitude: target.longitude,
    altitude: target.altitude,
  }, {
    latitude: telemetry.location.latitude,
    longitude: telemetry.location.longitude,
    altitude: originAltitude,
  });

  const worldVector = { x: enu.east, y: enu.north, z: enu.up };
  const bodyVector = vectorRotate(worldVector, worldToBody);
  const cameraVector = vectorRotate(bodyVector, bodyToCamera);

  const distance = Math.sqrt(cameraVector.x ** 2 + cameraVector.y ** 2 + cameraVector.z ** 2);
  if (!Number.isFinite(distance) || distance <= 1e-3) {
    return null;
  }
  const forward = -cameraVector.z;
  if (!Number.isFinite(forward) || forward <= 1e-6) {
    return {
      normalized: { x: Number.NaN, y: Number.NaN },
      screen: { x: Number.NaN, y: Number.NaN },
      inFrame: false,
      cameraVector,
      distance,
    };
  }

  const defaultZoom = telemetry.camera_optics?.zoom_ratio ?? 1;
  const zoomRatio = options.zoomRatioOverride ?? defaultZoom;
  const cameraModel = options.cameraModel ?? (cameraType === 'fpv' ? 'MAVIC3' : 'H20N');
  const baseFocalLength = options.baseFocalLength ?? (cameraType === 'fpv' ? 24 : 25);

  const overrideHFov = options.horizontalFovOverride ?? telemetry.camera_optics?.display_fov?.horizontal;
  const overrideVFov = options.verticalFovOverride ?? telemetry.camera_optics?.display_fov?.vertical;

  let halfHFov: number;
  let halfVFov: number;
  let fx: number;
  let fy: number;

  if (typeof overrideHFov === 'number' && overrideHFov > 0 && typeof overrideVFov === 'number' && overrideVFov > 0) {
    halfHFov = (overrideHFov * Math.PI) / 180 / 2;
    halfVFov = (overrideVFov * Math.PI) / 180 / 2;
    fx = (imageWidth / 2) / Math.tan(halfHFov);
    fy = (imageHeight / 2) / Math.tan(halfVFov);
  } else {
    const intrinsics = getCameraIntrinsics(zoomRatio, cameraModel, baseFocalLength);
    halfHFov = (intrinsics.horizontalFov * Math.PI) / 180 / 2;
    halfVFov = (intrinsics.verticalFov * Math.PI) / 180 / 2;
    fx = (imageWidth / 2) / Math.tan(halfHFov);
    fy = (imageHeight / 2) / Math.tan(halfVFov);
  }

  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx <= 0 || fy <= 0) {
    return null;
  }

  const u = fx * (cameraVector.x / forward) + imageWidth / 2;
  const v = fy * (cameraVector.y / forward) + imageHeight / 2;

  const normalizedX = u / imageWidth;
  const normalizedY = v / imageHeight;

  const screenX = normalizedX;
  const screenY = normalizedY;

  const inFrame = normalizedX >= 0 && normalizedX <= 1 && normalizedY >= 0 && normalizedY <= 1;

  return {
    normalized: { x: normalizedX, y: normalizedY },
    screen: { x: screenX, y: screenY },
    inFrame,
    cameraVector,
    distance,
  };
}
