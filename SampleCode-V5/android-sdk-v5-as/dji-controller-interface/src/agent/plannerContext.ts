import { bridgeManager } from '../bridgeManager';
import { agentTelemetryStore } from '../state/agentTelemetry';
import { missionPlannerStore } from '../state/missionPlanner';
import { cameraControlStore } from '../state/cameraControls';
import { objectMemoryTargetStore } from '../state/objectMemoryTargets';
import { objectMemoryCatalogStore } from '../state/objectMemoryCatalog';
import type { MapCoordinate } from '../config/mapGeometry';
import { getQueueSummary } from './commandQueue';

export interface PlannerContextQueueItemSummary {
  id?: string;
  tool?: string;
  label?: string | null;
  status: 'pending' | 'active' | 'completed' | 'error';
  enqueued_at_ms?: number;
  note?: string;
}

export interface PlannerContextQueueSummary {
  paused: boolean;
  active?: PlannerContextQueueItemSummary | null;
  pending: PlannerContextQueueItemSummary[];
  completed?: PlannerContextQueueItemSummary[];
  last_error?: string | null;
}

export interface PlannerContextTelemetry {
  timestamp_ms?: number;
  latitude?: number;
  longitude?: number;
  altitude_msl_m?: number;
  altitude_above_takeoff_m?: number;
  altitude_above_home_m?: number;
  distance_to_home_m?: number;
  ground_speed_mps?: number;
  horizontal_speed_mps?: number;
  vertical_speed_mps?: number;
  heading_deg?: number;
  home_bearing_deg?: number;
  flight_mode?: string;
  motors_on?: boolean;
  gps_signal_level?: string;
  satellite_count?: number;
  rc_signal_quality?: number;
  system_status?: unknown;
  diagnostics_level?: string;
  telemetry_age_ms?: number;
}

export interface PlannerContextBattery {
  percentage?: number;
  voltage?: number;
  temperature?: number;
}

export interface PlannerContextMissionWaypoint {
  id?: string;
  index?: number | null;
  kind?: string | null;
  label?: string | null;
  latitude?: number;
  longitude?: number;
  altitude?: number | null;
  altitude_reference?: string | null;
}

export interface PlannerContextMissionSummary {
  plan_count: number;
  plan_preview?: PlannerContextMissionWaypoint[];
  manual_target?: {
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null;
    source?: string;
  } | null;
  poi_target?: {
    latitude?: number;
    longitude?: number;
    altitude?: number | null;
  } | null;
  active_waypoint?: PlannerContextMissionWaypoint | null;
  orbit_mode?: string | null;
}

export interface PlannerContextMapPointFeature {
  id: string;
  type: 'point';
  name?: string;
  category?: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  radius_m?: number | null;
  metadata?: Record<string, any>;
}

export interface PlannerContextMapPolylineFeature {
  id: string;
  type: 'polyline';
  name?: string;
  category?: string;
  path: Array<{ latitude: number; longitude: number; altitude?: number | null }>;
  length_m?: number | null;
  metadata?: Record<string, any>;
}

export interface PlannerContextMapPolygonFeature {
  id: string;
  type: 'polygon';
  name?: string;
  category?: string;
  rings: Array<Array<{ latitude: number; longitude: number; altitude?: number | null }>>;
  area_m2?: number | null;
  centroid?: { latitude: number; longitude: number } | null;
  metadata?: Record<string, any>;
}

export type PlannerContextMapFeature =
  | PlannerContextMapPointFeature
  | PlannerContextMapPolylineFeature
  | PlannerContextMapPolygonFeature;

export interface PlannerContextMapSummary {
  plan_preview?: PlannerContextMissionWaypoint[];
  manual_target?: {
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null;
    source?: string;
  } | null;
  poi_target?: {
    latitude?: number;
    longitude?: number;
    altitude?: number | null;
  } | null;
  features?: PlannerContextMapFeature[];
}

export interface PlannerContextCamera {
  lens?: string;
  zoom_ratio?: number | null;
  zoom_range?: { min?: number; max?: number };
  thermal_zoom?: number | string;
  thermal_super_resolution?: boolean;
  gimbal_mode?: string;
  gimbal_attitude_mode?: string;
  look_at_mode?: string;
  look_at_busy?: boolean;
  look_at_status?: string | null;
  laser_enabled?: boolean;
  last_laser?: {
    timestamp_ms?: number;
    distance_m?: number;
    latitude?: number;
    longitude?: number;
    altitude?: number | null;
    source?: string | null;
  } | null;
}

export interface PlannerContextObjectMemory {
  selected_cluster?: {
    cluster_id: string;
    label?: string | null;
    latitude?: number;
    longitude?: number;
    altitude?: number | null;
    distance_m?: number | null;
  } | null;
}

export interface PlannerContextObstacles {
  enabled?: boolean;
  sectors?: Array<{
    angle?: number;
    distance?: number;
    warning_level?: string;
  }>;
}

export interface PlannerContextAgentStatus {
  mission_state?: string;
  last_command?: string | null;
  altitude_target?: number | null;
  altitude_current?: number | null;
  horizontal_remaining?: number | null;
  fallback_active?: boolean;
  notes?: string[];
  last_update_ms?: number;
}

export interface PlannerContext {
  timestamp_ms: number;
  connection?: { status: string };
  telemetry?: PlannerContextTelemetry;
  battery?: PlannerContextBattery;
  vs_state?: {
    enabled?: boolean;
    manual_override?: boolean;
    owner?: string | null;
  };
  agent_status?: PlannerContextAgentStatus;
  mission?: PlannerContextMissionSummary;
  map?: PlannerContextMapSummary;
  queue?: PlannerContextQueueSummary;
  camera?: PlannerContextCamera;
  object_memory?: PlannerContextObjectMemory;
  obstacles?: PlannerContextObstacles;
  diagnostics?: unknown[];
  simulator?: unknown;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function summarizeLaserResult(entry: any): PlannerContextCamera['last_laser'] | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const distance =
    numberOrUndefined((entry.distance_m ?? entry.distance ?? entry.range) as number | undefined) ??
    numberOrUndefined(entry?.target?.distance);
  const source = stringOrUndefined(entry.source ?? entry.kind ?? entry.type) ?? null;
  const latitude = numberOrUndefined(
    entry.latitude ?? entry.lat ?? entry?.target?.latitude ?? entry?.location?.latitude,
  );
  const longitude = numberOrUndefined(
    entry.longitude ?? entry.lon ?? entry?.target?.longitude ?? entry?.location?.longitude,
  );
  const altitude = numberOrUndefined(
    entry.altitude ?? entry.altitude_m ?? entry?.target?.altitude ?? entry?.location?.altitude,
  );
  const timestamp = numberOrUndefined(entry.timestamp ?? entry.ts ?? entry?.time_ms);
  if (
    distance === undefined &&
    latitude === undefined &&
    longitude === undefined &&
    altitude === undefined &&
    timestamp === undefined &&
    !source
  ) {
    return null;
  }
  return {
    distance_m: distance,
    latitude,
    longitude,
    altitude: altitude ?? null,
    timestamp_ms: timestamp,
    source,
  };
}

function prune<T>(value: T): T {
  if (Array.isArray(value)) {
    const prunedArray = value.map((item) => prune(item));
    return prunedArray as unknown as T;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => [key, prune(val)])
      .filter(([, val]) => val !== undefined);
    if (!entries.length) {
      return undefined as unknown as T;
    }
    return Object.fromEntries(entries) as unknown as T;
  }
  return value === undefined ? (undefined as unknown as T) : value;
}

const EARTH_RADIUS_METERS = 6378137;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineMeters(a: MapCoordinate, b: MapCoordinate): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = toRadians(b.longitude - a.longitude);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function computePolylineLength(points: MapCoordinate[]): number | null {
  if (points.length < 2) return null;
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += haversineMeters(points[i - 1], points[i]);
  }
  return length;
}

function projectToLocalXY(origin: MapCoordinate, point: MapCoordinate): { x: number; y: number } {
  const originLatRad = toRadians(origin.latitude);
  const dLat = toRadians(point.latitude - origin.latitude);
  const dLon = toRadians(point.longitude - origin.longitude);
  const x = dLon * Math.cos(originLatRad) * EARTH_RADIUS_METERS;
  const y = dLat * EARTH_RADIUS_METERS;
  return { x, y };
}

function computePolygonMetrics(ring: MapCoordinate[]): { area?: number; centroid?: { latitude: number; longitude: number } } {
  if (ring.length < 3) {
    return {};
  }
  const origin = ring[0];
  const points = ring.map((p) => projectToLocalXY(origin, p));
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const { x: x0, y: y0 } = points[i];
    const { x: x1, y: y1 } = points[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-2) {
    return {};
  }
  const centroidX = cx / (6 * area);
  const centroidY = cy / (6 * area);
  const centroidLat = origin.latitude + (centroidY / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const centroidLon = origin.longitude + (centroidX / (EARTH_RADIUS_METERS * Math.cos(toRadians(origin.latitude)))) * (180 / Math.PI);
  return {
    area: Math.abs(area),
    centroid: {
      latitude: centroidLat,
      longitude: centroidLon,
    },
  };
}

export function collectPlannerContext(): PlannerContext {
  const now = Date.now();
  const { bridgeData, connectionStatus } = bridgeManager.getState();
  const telemetry = bridgeData.telemetry;
  const battery = bridgeData.battery;
  const controller = bridgeData.controller;
  const telemetryAge = bridgeData.lastUpdated?.telemetry
    ? now - bridgeData.lastUpdated.telemetry
    : undefined;

  const telemetryContext: PlannerContextTelemetry | undefined = telemetry
    ? {
        timestamp_ms: numberOrUndefined(telemetry.timestamp),
        latitude: numberOrUndefined(telemetry.location?.latitude),
        longitude: numberOrUndefined(telemetry.location?.longitude),
        altitude_msl_m: numberOrUndefined(telemetry.location?.altitude),
        altitude_above_takeoff_m:
          numberOrUndefined(telemetry.altitude_above_takeoff) ??
          numberOrUndefined(telemetry.altitude_above_home),
        altitude_above_home_m: numberOrUndefined(telemetry.altitude_above_home),
        distance_to_home_m: numberOrUndefined(telemetry.distance_to_home),
        ground_speed_mps: numberOrUndefined(telemetry.speed),
        horizontal_speed_mps:
          telemetry.velocity_vector
            ? (() => {
                const vx = numberOrUndefined(telemetry.velocity_vector?.x) ?? 0;
                const vy = numberOrUndefined(telemetry.velocity_vector?.y) ?? 0;
                const speed = Math.hypot(vx, vy);
                return speed > 0 ? speed : undefined;
              })()
            : undefined,
        vertical_speed_mps: telemetry.velocity_vector
          ? numberOrUndefined(telemetry.velocity_vector.z)
          : undefined,
        heading_deg: numberOrUndefined(telemetry.heading),
        home_bearing_deg: numberOrUndefined(telemetry.home_bearing),
        flight_mode: stringOrUndefined(telemetry.flight_mode_label ?? telemetry.flight_mode),
        motors_on: booleanOrUndefined(telemetry.motors_on),
        gps_signal_level: stringOrUndefined(telemetry.gps_signal_level),
        satellite_count: numberOrUndefined(telemetry.satellite_count),
        rc_signal_quality: numberOrUndefined(telemetry.rc_signal_quality),
        system_status: telemetry.system_status ?? undefined,
        diagnostics_level: stringOrUndefined(telemetry.diagnostics_severity),
        telemetry_age_ms: telemetryAge,
      }
    : undefined;

  const batteryContext: PlannerContextBattery | undefined = battery
    ? {
        percentage: numberOrUndefined(battery.battery?.percentage),
        voltage: numberOrUndefined(battery.battery?.voltage),
        temperature: numberOrUndefined(battery.battery?.temperature),
      }
    : undefined;

  const vsContext = controller?.virtual_stick
    ? {
        enabled: booleanOrUndefined(controller.virtual_stick.enabled),
        manual_override: booleanOrUndefined(controller.virtual_stick.manual_override),
        owner: stringOrUndefined(
          controller.virtual_stick.authority_owner ?? controller.authority_owner,
        ) ?? null,
      }
    : controller
      ? {
          enabled: booleanOrUndefined(controller.virtual_stick_enabled),
          manual_override: undefined,
          owner: stringOrUndefined(controller.authority_owner) ?? null,
        }
      : undefined;

  const agentSnapshot = agentTelemetryStore.getSnapshot();
  const agentContext: PlannerContextAgentStatus = {
    mission_state: agentSnapshot.missionState,
    last_command: agentSnapshot.lastCommand,
    altitude_target: agentSnapshot.altitudeTarget,
    altitude_current: agentSnapshot.altitudeCurrent,
    horizontal_remaining: agentSnapshot.horizontalRemaining,
    fallback_active: agentSnapshot.fallbackActive,
    notes: agentSnapshot.notes.length ? [...agentSnapshot.notes] : undefined,
    last_update_ms: agentSnapshot.lastUpdateMs,
  };

  const missionSnapshot = missionPlannerStore.getSnapshot();
  const planPreview: PlannerContextMissionWaypoint[] = (missionSnapshot.plan || [])
    .slice(0, 12)
    .map((entry, index) => ({
      id: entry.id,
      index,
      kind: entry.kind,
      label: (entry as any).label ?? null,
      latitude: numberOrUndefined(entry.latitude),
      longitude: numberOrUndefined(entry.longitude),
      altitude: entry.altitude ?? null,
      altitude_reference: entry.altitudeReference ?? null,
    }));

  const missionContext: PlannerContextMissionSummary = {
    plan_count: missionSnapshot.plan.length,
    plan_preview: planPreview,
    manual_target: missionSnapshot.manualTarget
      ? {
          latitude: missionSnapshot.manualTarget.latitude,
          longitude: missionSnapshot.manualTarget.longitude,
          altitude: missionSnapshot.manualTarget.altitude,
          source: missionSnapshot.manualTarget.source,
        }
      : null,
    poi_target: missionSnapshot.poiTarget
      ? {
          latitude: missionSnapshot.poiTarget.latitude,
          longitude: missionSnapshot.poiTarget.longitude,
          altitude: missionSnapshot.poiTarget.altitude ?? null,
        }
      : null,
    active_waypoint: missionSnapshot.activeWaypoint
      ? {
          id: missionSnapshot.activeWaypoint.label ?? undefined,
          index: missionSnapshot.activeWaypoint.index ?? null,
          kind: missionSnapshot.activeWaypoint.kind ?? null,
          label: missionSnapshot.activeWaypoint.label ?? null,
          latitude: numberOrUndefined(missionSnapshot.activeWaypoint.latitude),
          longitude: numberOrUndefined(missionSnapshot.activeWaypoint.longitude),
          altitude: missionSnapshot.activeWaypoint.altitude ?? null,
          altitude_reference: null,
        }
      : null,
    orbit_mode: missionSnapshot.orbitMode ?? null,
  };

  const mapFeatures: PlannerContextMapFeature[] = [];
  const featureIds = new Set<string>();

  const pushFeature = (feature: PlannerContextMapFeature | null | undefined) => {
    if (!feature) return;
    if (featureIds.has(feature.id)) return;
    featureIds.add(feature.id);
    mapFeatures.push(feature);
  };

  const memoryEntries = objectMemoryCatalogStore.getSnapshot().slice(0, 0);
  const selectedObjectMemory = objectMemoryTargetStore.getCurrent();

  // Mission planner derived features
  if (missionSnapshot.manualTarget?.latitude != null && missionSnapshot.manualTarget?.longitude != null) {
    pushFeature({
      id: 'mission_manual_target',
      type: 'point',
      name: 'Manual target',
      category: 'mission_target',
      latitude: missionSnapshot.manualTarget.latitude,
      longitude: missionSnapshot.manualTarget.longitude,
      altitude: missionSnapshot.manualTarget.altitude ?? null,
      metadata: {
        source: missionSnapshot.manualTarget.source,
      },
    });
  }

  if (missionSnapshot.poiTarget?.latitude != null && missionSnapshot.poiTarget?.longitude != null) {
    pushFeature({
      id: 'mission_poi_target',
      type: 'point',
      name: 'POI target',
      category: 'mission_poi',
      latitude: missionSnapshot.poiTarget.latitude,
      longitude: missionSnapshot.poiTarget.longitude,
      altitude: missionSnapshot.poiTarget.altitude ?? null,
    });
  }

  if (missionSnapshot.activeWaypoint?.latitude != null && missionSnapshot.activeWaypoint?.longitude != null) {
    pushFeature({
      id: `mission_active_waypoint_${missionSnapshot.activeWaypoint.index ?? 'current'}`,
      type: 'point',
      name: missionSnapshot.activeWaypoint.label ?? 'Active waypoint',
      category: 'mission_waypoint',
      latitude: missionSnapshot.activeWaypoint.latitude,
      longitude: missionSnapshot.activeWaypoint.longitude,
      altitude: missionSnapshot.activeWaypoint.altitude ?? null,
      metadata: {
        kind: missionSnapshot.activeWaypoint.kind,
        index: missionSnapshot.activeWaypoint.index,
      },
    });
  }

  if (missionSnapshot.plan.length >= 2) {
    const path = missionSnapshot.plan
      .map((entry) => ({
        latitude: entry.latitude,
        longitude: entry.longitude,
        altitude: entry.altitude ?? null,
      }))
      .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
    if (path.length >= 2) {
      pushFeature({
        id: 'mission_plan_current',
        type: 'polyline',
        name: 'Mission plan',
        category: 'mission_plan',
        path,
        length_m: computePolylineLength(path),
        metadata: {
          orbit_mode: missionSnapshot.orbitMode ?? undefined,
        },
      });
    }
  }

  const telemetryHome = telemetry?.home_location;
  if (telemetryHome && Number.isFinite(telemetryHome.latitude) && Number.isFinite(telemetryHome.longitude)) {
    pushFeature({
      id: 'home_location',
      type: 'point',
      name: 'Home position',
      category: 'home',
      latitude: telemetryHome.latitude,
      longitude: telemetryHome.longitude,
      altitude: telemetryHome.altitude ?? null,
    });
  }

  if (telemetry?.location && Number.isFinite(telemetry.location.latitude) && Number.isFinite(telemetry.location.longitude)) {
    pushFeature({
      id: 'aircraft_position',
      type: 'point',
      name: 'Aircraft',
      category: 'aircraft',
      latitude: telemetry.location.latitude,
      longitude: telemetry.location.longitude,
      altitude: telemetry.location.altitude ?? null,
      metadata: {
        heading_deg: telemetry.heading,
      },
    });
  }

  const mapContext = (() => {
    const hasPlan = planPreview.length > 0;
    const manualTarget = missionContext.manual_target ?? null;
    const poiTarget = missionContext.poi_target ?? null;
    const features = mapFeatures.length ? mapFeatures : undefined;
    if (!hasPlan && !manualTarget && !poiTarget && !features) {
      return undefined;
    }
    return {
      plan_preview: hasPlan ? planPreview : undefined,
      manual_target: manualTarget,
      poi_target: poiTarget,
      features,
    } as PlannerContextMapSummary;
  })();

  const cameraSnapshot = cameraControlStore.getSnapshot();
  const cameraContext: PlannerContextCamera = {
    lens: cameraSnapshot.selectedLens,
    zoom_ratio: cameraSnapshot.zoomRatio,
    zoom_range: cameraSnapshot.zoomRange,
    thermal_zoom: cameraSnapshot.thermalZoom,
    thermal_super_resolution: cameraSnapshot.thermalSuperResolution,
    gimbal_mode: cameraSnapshot.gimbalMode,
    gimbal_attitude_mode: cameraSnapshot.gimbalAttitudeMode,
    look_at_mode: cameraSnapshot.lookAtMode,
    look_at_busy: cameraSnapshot.lookAtBusy,
    look_at_status: cameraSnapshot.lookAtStatus,
    laser_enabled: cameraSnapshot.laserEnabled,
    last_laser: summarizeLaserResult(cameraSnapshot.lastLaserResult),
  };

  const selectedCluster = selectedObjectMemory;
  const objectMemoryContext: PlannerContextObjectMemory = {
    selected_cluster: selectedCluster
      ? {
          cluster_id: selectedCluster.clusterId,
          label: selectedCluster.clusterLabel ?? null,
          latitude: numberOrUndefined(selectedCluster.anchor?.object_position?.latitude),
          longitude: numberOrUndefined(selectedCluster.anchor?.object_position?.longitude),
          altitude: selectedCluster.anchor?.object_position?.altitude_m ?? null,
        }
      : null,
  };

  const queueSummary = getQueueSummary();

  const context = prune<PlannerContext>({
    timestamp_ms: now,
    connection: { status: connectionStatus },
    telemetry: telemetryContext,
    battery: batteryContext,
    vs_state: vsContext,
    agent_status: agentContext,
    mission: missionContext,
    map: mapContext,
    queue: queueSummary,
    camera: cameraContext,
    object_memory: objectMemoryContext,
    simulator: telemetry?.simulator,
  } as PlannerContext);

  return context ?? { timestamp_ms: now };
}
