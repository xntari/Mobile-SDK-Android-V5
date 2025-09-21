// Ray projection utilities for camera to world coordinate transformations
// Combines aircraft pose, gimbal angles, and camera intrinsics to project rays

import { TelemetryData } from '../types';
import { rotationMatrixFromEuler, vectorRotate, combineRotationMatrices } from './poseMath';
import { getCameraIntrinsics, pixelToRay } from './cameraIntrinsics';

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
    roll: 0, // Gimbal typically doesn't have roll
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
  const aircraftPos: GeographicPoint = {
    latitude: telemetry.location.latitude,
    longitude: telemetry.location.longitude,
    altitude: telemetry.altitude_above_takeoff + (telemetry.altitude_barometric || 0),
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
