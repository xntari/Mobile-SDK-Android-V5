// Camera intrinsics and calibration parameters for DJI cameras
// Provides focal length, sensor dimensions, and FOV calculations

export interface CameraSensor {
  width: number;  // Sensor width in mm
  height: number; // Sensor height in mm
  cropFactor: number; // Crop factor relative to 35mm full frame
  name: string;
}

export interface CameraIntrinsics {
  focalLength: number; // Current focal length in mm (35mm equivalent)
  sensorWidth: number; // Sensor width in mm
  sensorHeight: number; // Sensor height in mm
  horizontalFov: number; // Horizontal field of view in degrees
  verticalFov: number; // Vertical field of view in degrees
  diagonalFov: number; // Diagonal field of view in degrees
}

// Known camera sensors
export const CAMERA_SENSORS: Record<string, CameraSensor> = {
  // H20N has a 1/1.26" CMOS sensor
  H20N: {
    width: 11.1,  // Approximate for 1/1.26" sensor
    height: 6.2,  // Based on 16:9 aspect ratio
    cropFactor: 3.1, // Relative to 35mm full frame
    name: 'DJI H20N',
  },
  // H20T has similar specs
  H20T: {
    width: 11.1,
    height: 6.2,
    cropFactor: 3.1,
    name: 'DJI H20T',
  },
  // Mavic 3 has a 4/3" CMOS sensor
  MAVIC3: {
    width: 17.3,
    height: 13.0,
    cropFactor: 2.0,
    name: 'Mavic 3',
  },
  // Mini 3 Pro has a 1/1.3" CMOS sensor
  MINI3PRO: {
    width: 10.7,
    height: 6.0,
    cropFactor: 3.2,
    name: 'Mini 3 Pro',
  },
};

/**
 * Calculate field of view from focal length and sensor dimensions
 * @param focalLength Actual focal length in mm (not 35mm equivalent)
 * @param sensorSize Sensor dimension in mm (width or height)
 * @returns Field of view in degrees
 */
export function calculateFov(focalLength: number, sensorSize: number): number {
  return Math.atan(sensorSize / (2 * focalLength)) * 2 * (180 / Math.PI);
}

/**
 * Convert 35mm equivalent focal length to actual focal length
 * @param equivalentFocalLength Focal length in 35mm equivalent
 * @param cropFactor Sensor crop factor
 * @returns Actual focal length in mm
 */
export function toActualFocalLength(equivalentFocalLength: number, cropFactor: number): number {
  return equivalentFocalLength / cropFactor;
}

/**
 * Get camera intrinsics from zoom ratio and camera type
 * @param zoomRatio Current zoom ratio (1.0 = no zoom)
 * @param cameraType Camera model identifier
 * @param baseFocalLength Base focal length at 1x zoom (35mm equivalent)
 * @returns Complete camera intrinsics including FOV
 */
export function getCameraIntrinsics(
  zoomRatio: number,
  cameraType: string = 'H20N',
  baseFocalLength: number = 25 // H20N base focal length at 1x
): CameraIntrinsics {
  const sensor = CAMERA_SENSORS[cameraType] || CAMERA_SENSORS.H20N;

  // Calculate current focal length (35mm equivalent)
  const focalLength35mm = baseFocalLength * zoomRatio;

  // Convert to actual focal length
  const actualFocalLength = toActualFocalLength(focalLength35mm, sensor.cropFactor);

  // Calculate FOV for each dimension
  const horizontalFov = calculateFov(actualFocalLength, sensor.width);
  const verticalFov = calculateFov(actualFocalLength, sensor.height);

  // Calculate diagonal FOV
  const diagonalSize = Math.sqrt(sensor.width ** 2 + sensor.height ** 2);
  const diagonalFov = calculateFov(actualFocalLength, diagonalSize);

  return {
    focalLength: focalLength35mm,
    sensorWidth: sensor.width,
    sensorHeight: sensor.height,
    horizontalFov,
    verticalFov,
    diagonalFov,
  };
}

/**
 * Calculate pixel to ray direction in camera coordinates
 * @param pixelX X coordinate in image (0 to imageWidth)
 * @param pixelY Y coordinate in image (0 to imageHeight)
 * @param imageWidth Image width in pixels
 * @param imageHeight Image height in pixels
 * @param intrinsics Camera intrinsics
 * @returns Normalized ray direction in camera frame [x, y, z]
 */
export function pixelToRay(
  pixelX: number,
  pixelY: number,
  imageWidth: number,
  imageHeight: number,
  intrinsics: CameraIntrinsics
): { x: number; y: number; z: number } {
  // Convert pixel to normalized image coordinates (-1 to 1)
  const normalizedX = (pixelX / imageWidth) * 2 - 1;
  const normalizedY = (pixelY / imageHeight) * 2 - 1;

  // Calculate ray angles based on FOV
  const angleX = (normalizedX * intrinsics.horizontalFov * Math.PI) / 360; // Half FOV
  const angleY = (normalizedY * intrinsics.verticalFov * Math.PI) / 360;

  // Convert angles to ray direction
  // Camera looks along -Z axis in camera frame
  const x = Math.tan(angleX);
  const y = Math.tan(angleY);
  const z = -1; // Looking forward

  // Normalize the ray
  const length = Math.sqrt(x * x + y * y + z * z);

  return {
    x: x / length,
    y: y / length,
    z: z / length,
  };
}

/**
 * Get principal point offset for lens distortion correction
 * Default assumes centered principal point
 */
export function getPrincipalPoint(imageWidth: number, imageHeight: number): { cx: number; cy: number } {
  return {
    cx: imageWidth / 2,
    cy: imageHeight / 2,
  };
}