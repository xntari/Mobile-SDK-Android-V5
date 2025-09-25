export const EARTH_RADIUS_METERS = 6378137;

export function addMetersToLatLon(
  latitude: number,
  longitude: number,
  northMeters: number,
  eastMeters: number,
): { latitude: number; longitude: number } {
  const dLat = northMeters / EARTH_RADIUS_METERS;
  const dLon = eastMeters / (EARTH_RADIUS_METERS * Math.cos((latitude * Math.PI) / 180));

  return {
    latitude: latitude + (dLat * 180) / Math.PI,
    longitude: longitude + (dLon * 180) / Math.PI,
  };
}

export function bearingOffsetToMeters(distanceMeters: number, bearingDegrees: number) {
  const bearingRad = (bearingDegrees * Math.PI) / 180;
  const north = distanceMeters * Math.cos(bearingRad);
  const east = distanceMeters * Math.sin(bearingRad);
  return { north, east };
}

export function normalizeHeadingDegrees(value: number) {
  let heading = value % 360;
  if (heading < 0) heading += 360;
  return heading;
}
