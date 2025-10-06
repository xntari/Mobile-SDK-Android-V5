import { bridgeManager } from '../bridgeManager';
import { agentTelemetryStore } from '../state/agentTelemetry';
import { missionPlannerStore } from '../state/missionPlanner';
import { cameraControlStore } from '../state/cameraControls';
import { objectMemoryTargetStore } from '../state/objectMemoryTargets';
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

  const mapContext = missionSnapshot.plan.length || missionSnapshot.manualTarget || missionSnapshot.poiTarget
    ? {
        plan_preview: planPreview,
        manual_target: missionContext.manual_target,
        poi_target: missionContext.poi_target,
      }
    : undefined;

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

  const selectedCluster = objectMemoryTargetStore.getCurrent();
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

  const obstaclesContext: PlannerContextObstacles | undefined = telemetry?.obstacle_avoidance
    ? {
        enabled: booleanOrUndefined(telemetry.obstacle_avoidance.enabled),
        sectors: Array.isArray(telemetry.obstacle_avoidance.sectors)
          ? telemetry.obstacle_avoidance.sectors.slice(0, 12).map((sector: any) => ({
              angle: numberOrUndefined(sector?.angle),
              distance: numberOrUndefined(sector?.distance),
              warning_level: stringOrUndefined(sector?.warning_level),
            }))
          : undefined,
      }
    : undefined;

  const diagnostics = telemetry?.diagnostics ? [...telemetry.diagnostics] : undefined;

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
    obstacles: obstaclesContext,
    diagnostics,
    simulator: telemetry?.simulator,
  } as PlannerContext);

  return context ?? { timestamp_ms: now };
}
