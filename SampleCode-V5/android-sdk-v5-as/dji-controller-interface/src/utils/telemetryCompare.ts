import type { TelemetryData } from '../types';

type Coordinate = { latitude?: number | null; longitude?: number | null; altitude?: number | null } | null | undefined;

const numberEqual = (a?: number | null, b?: number | null, tolerance = 1e-6) => {
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  if (Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return Math.abs(a - b) <= tolerance;
};

const coordinateEqual = (a: Coordinate, b: Coordinate) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    numberEqual(a.latitude, b.latitude) &&
    numberEqual(a.longitude, b.longitude) &&
    numberEqual(a.altitude, b.altitude)
  );
};

const normalizeState = (state?: string | null) => state ? state.toLowerCase() : '';

export const telemetryShallowEqual = (a?: TelemetryData | null, b?: TelemetryData | null): boolean => {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return a === b;
  }

  if (!coordinateEqual(a.location, b.location)) {
    return false;
  }
  if (!coordinateEqual(a.home_location, b.home_location)) {
    return false;
  }
  if (!numberEqual(a.compass_heading ?? a.heading, b.compass_heading ?? b.heading, 1e-3)) {
    return false;
  }
  if ((a.motors_on ?? false) !== (b.motors_on ?? false)) {
    return false;
  }
  if (normalizeState(a.waypoint_status?.state) !== normalizeState(b.waypoint_status?.state)) {
    return false;
  }
  if ((a.simulator?.enabled ?? false) !== (b.simulator?.enabled ?? false)) {
    return false;
  }
  if (!numberEqual(a.home_bearing, b.home_bearing, 1e-3)) {
    return false;
  }
  if ((a.timestamp ?? 0) !== (b.timestamp ?? 0)) {
    return false;
  }
  return true;
};
