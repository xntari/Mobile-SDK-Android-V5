import React from 'react';
import JSZip from 'jszip';
import { Panel } from './Panel';
import { CollapsibleSection } from './CollapsibleSection';
import { getSimulatorModeBadge } from './SimulatorControls';
import { useBridgeCommands } from '../hooks/useBridgeCommands';
import { useStableBridgeData } from '../hooks/useStableBridgeData';
import { addMetersToLatLon, bearingOffsetToMeters, normalizeHeadingDegrees } from '../utils/geo';
import { TelemetryData, FlyToStatus, WaypointStatusTelemetry, FlightCommandAck, WaypointTimelineEntry } from '../types';
import type {
  PlannedMissionEntry,
  ManualTargetState,
  MissionEntryKind,
  MissionWaypointTarget,
  WaypointAction,
  WaypointTurnConfig,
  WaypointHeadingConfig,
  WaypointGimbalHeadingConfig,
  WaypointActionGroup,
  WaypointActionConfig,
  PoiTarget,
  AltitudeReferenceMode,
  OrbitMode,
} from '../types/missionPlanner';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { listClusters } from '../agent/objectMemoryClient';
import { objectMemoryCatalogStore } from '../state/objectMemoryCatalog';
import type { ObjectMemoryCluster, ObjectMemoryClusterAnchor } from '../agent/objectMemoryClient';
import { missionPlannerStore } from '../state/missionPlanner';
import { missionSettingsStore, altitudeReferenceForExecuteMode, type ExecuteHeightMode } from '../state/missionSettings';
import { terrainCache } from '../map/terrainCache';

type MissionLogKind = 'command' | 'telemetry' | 'simulation' | 'laser' | 'manual' | 'kmz';

interface MissionLogEntry {
  id: string;
  timestamp: number;
  label: string;
  payload: Record<string, any>;
  kind: MissionLogKind;
}

interface MissionPlanCommandEntry {
  latitude: number;
  longitude: number;
  altitude?: number | null;
  kind?: string;
  radius?: number;
  turns?: number;
  actions?: WaypointAction[];
  turn?: WaypointTurnConfig | null;
  heading?: WaypointHeadingConfig | null;
  gimbal_heading?: WaypointGimbalHeadingConfig | null;
  action_groups?: WaypointActionGroup[];
  poi?: PoiTarget | null;
  gimbal_strategy?: string | null;
  altitude_reference?: AltitudeReferenceMode | null;
}

const MAX_LOG_ENTRIES = 40;
const clampAltitude = (value: number) => Math.max(-500, Math.min(6000, value));

const STORAGE_KEYS = {
  flyToMode: 'mission.flyTo.mode',
  flyToHeight: 'mission.flyTo.height',
  securityHeight: 'mission.flyTo.securityHeight',
  maxSpeed: 'mission.flyTo.maxSpeed',
  flightPathMode: 'mission.flightPathMode',
  orbitMode: 'mission.orbit.mode',
};

const formatLatLon = (value?: number) =>
  typeof value === 'number' ? value.toFixed(7) : '—';

const formatMissionStateLabel = (state?: string) =>
  state ? state.replace(/_/g, ' ').toUpperCase() : 'UNKNOWN';

const missionStateClassName = (state?: string) => {
  if (!state) return 'text-gray-400';
  const normalized = state.toLowerCase();
  if (normalized.includes('error') || normalized.includes('interrupt')) {
    return 'text-status-error';
  }
  if (['executing', 'enter_wayline', 'flying'].includes(normalized)) {
    return 'text-status-good';
  }
  if (['uploading', 'preparing', 'ready', 'paused'].includes(normalized)) {
    return 'text-yellow-300';
  }
  if (normalized === 'finished') {
    return 'text-gray-200';
  }
  return 'text-gray-300';
};

const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return '–';
  const delta = Date.now() - timestamp;
  if (delta < 0) return 'now';
  if (delta < 1000) return '<1s';
  if (delta < 60000) return `${Math.floor(delta / 1000)}s`;
  const minutes = delta / 60000;
  return minutes < 10 ? `${minutes.toFixed(1)}m` : `${Math.floor(minutes)}m`;
};

const clampLat = (value: number) => Math.max(-90, Math.min(90, value));
const clampLon = (value: number) => Math.max(-180, Math.min(180, value));

const EARTH_RADIUS_M = 6371000;
const DEFAULT_VERTICAL_SPEED_MS = 1.5;
const MIN_HORIZONTAL_DISTANCE_M = 1.0;
const MIN_VERTICAL_DISTANCE_M = 0.5;
const GIMBAL_PITCH_MIN = -90;
const GIMBAL_PITCH_MAX = 30;
const CURVED_TURN_DAMPING_DISTANCE = 10;

const haversineMeters = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(1 - h, 0)));
  return EARTH_RADIUS_M * c;
};

const formatMetersValue = (value: number, precision = 1) => `${value.toFixed(precision)} m`;

const formatSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '–';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = seconds / 60;
  return mins < 60 ? `${mins.toFixed(1)}m` : `${(mins / 60).toFixed(1)}h`;
};

const formatBytes = (bytes?: number) => {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
};

const WAYPOINT_ACTION_CATALOG: Array<{ id: string; label: string; description: string }> = [
  {
    id: 'gimbal_pitch',
    label: 'Gimbal Pitch',
    description: 'Adjust camera pitch before entering the waypoint.',
  },
  {
    id: 'poi',
    label: 'Point of Interest',
    description: 'Orient the gimbal toward a latitude/longitude reference.',
  },
];

const TURN_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto (derive from mission)' },
  { value: 'toPointAndPassWithContinuityCurvature', label: 'Curved fly-through' },
  { value: 'toPointAndStopWithContinuityCurvature', label: 'Curved stop (smooth)' },
  { value: 'toPointAndStopWithDiscontinuityCurvature', label: 'Stop with break' },
  { value: 'coordinateTurn', label: 'Coordinated turn' },
];

const HEADING_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inherit', label: 'Auto (inherit)' },
  { value: 'followWayline', label: 'Follow wayline' },
  { value: 'towardPOI', label: 'Toward POI' },
  { value: 'fixed', label: 'Fixed angle' },
];

const GIMBAL_HEADING_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'Auto (inherit)' },
  { value: 'lock', label: 'Lock heading' },
  { value: 'follow', label: 'Follow flight path' },
  { value: 'poi', label: 'Track POI' },
];

const GIMBAL_STRATEGY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'None (manual)' },
  { value: 'poi_track_aircraft', label: 'Lock aircraft heading on POI' },
];

const ALTITUDE_REFERENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inherit', label: 'Mission default' },
  { value: 'relative_to_takeoff', label: 'Relative to takeoff' },
  { value: 'absolute_wgs84', label: 'Absolute (WGS84 ellipsoid)' },
  { value: 'egm96', label: 'Absolute (EGM96 geoid)' },
];

const MSL_ALTITUDE_SOURCES: Array<ManualTargetState['source']> = ['manual', 'laser', 'object-memory'];

const inferAltitudeReference = (
  altitude: number | null | undefined,
  source?: ManualTargetState['source'],
): AltitudeReferenceMode | undefined => {
  if (typeof altitude !== 'number' || !Number.isFinite(altitude)) {
    return undefined;
  }
  if (source && MSL_ALTITUDE_SOURCES.includes(source)) {
    return 'egm96';
  }
  return 'absolute_wgs84';
};

const ACTION_TRIGGER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'reach_point', label: 'When waypoint reached' },
  { value: 'time', label: 'After delay' },
  { value: 'distance', label: 'After distance' },
  { value: 'interval', label: 'Interval' },
];

const sanitizeWpmlKey = (key: string): string => key.replace(/[^A-Za-z0-9_]/g, '');

const actionDraftKey = (entryId: string, groupKey: string | number, actionIndex: number): string =>
  `${entryId}:${groupKey}:${actionIndex}`;

const serializePoiConfig = (poi?: PoiTarget | null) => {
  if (!poi) return undefined;
  if (!Number.isFinite(poi.latitude) || !Number.isFinite(poi.longitude)) {
    return undefined;
  }
  const result: Record<string, unknown> = {
    latitude: poi.latitude,
    longitude: poi.longitude,
  };
  if (typeof poi.altitude === 'number' && Number.isFinite(poi.altitude)) {
    result.altitude = poi.altitude;
  }
  return result;
};

const serializeTurnConfig = (turn?: WaypointTurnConfig | null) => {
  if (!turn) return undefined;
  const result: Record<string, unknown> = {};
  if (turn.mode && turn.mode !== 'auto') {
    result.mode = turn.mode;
  }
  if (typeof turn.damping === 'number' && Number.isFinite(turn.damping)) {
    result.damping = turn.damping;
  }
  if (typeof turn.useStraightLine === 'boolean') {
    result.use_straight_line = turn.useStraightLine;
  }
  return Object.keys(result).length ? result : undefined;
};

const serializeHeadingConfig = (heading?: WaypointHeadingConfig | null) => {
  if (!heading) return undefined;
  const result: Record<string, unknown> = {};
  if (heading.mode) result.mode = heading.mode;
  if (typeof heading.angle === 'number' && Number.isFinite(heading.angle)) {
    result.angle = heading.angle;
  }
  if (typeof heading.angleEnable === 'boolean') {
    result.angle_enable = heading.angleEnable;
  }
  const poi = serializePoiConfig(heading.poi);
  if (poi) result.poi = poi;
  if (typeof heading.poiIndex === 'number' && Number.isFinite(heading.poiIndex)) {
    result.poi_index = heading.poiIndex;
  }
  if (heading.yawPathMode) result.yaw_path_mode = heading.yawPathMode;
  if (heading.yawBase) result.yaw_base = heading.yawBase;
  return Object.keys(result).length ? result : undefined;
};

const serializeGimbalHeadingConfig = (gimbal?: WaypointGimbalHeadingConfig | null) => {
  if (!gimbal) return undefined;
  const result: Record<string, unknown> = {};
  if (gimbal.mode) result.mode = gimbal.mode;
  if (typeof gimbal.pitch === 'number' && Number.isFinite(gimbal.pitch)) {
    result.pitch = gimbal.pitch;
  }
  if (typeof gimbal.yaw === 'number' && Number.isFinite(gimbal.yaw)) {
    result.yaw = gimbal.yaw;
  }
  return Object.keys(result).length ? result : undefined;
};

const serializeActionGroup = (group: WaypointActionGroup) => {
  const result: Record<string, unknown> = {};
  if (group.id != null) result.id = group.id;
  if (group.startIndex != null) result.start_index = group.startIndex;
  if (group.endIndex != null) result.end_index = group.endIndex;
  if (group.mode) result.mode = group.mode;
  if (group.triggerType) {
    result.triggerType = group.triggerType;
    result.trigger = { type: group.triggerType };
  }
  if (group.actions.length) {
    result.actions = group.actions.map((action) => {
      const actionResult: Record<string, unknown> = { func: action.func };
      if (action.id != null) actionResult.id = action.id;
      if (action.params && Object.keys(action.params).length > 0) {
        actionResult.params = action.params;
      }
      return actionResult;
    });
  } else {
    result.actions = [];
  }
  return result;
};

const serializePlanPoint = (point: MissionPlanCommandEntry) => {
  const result: Record<string, unknown> = {
    latitude: point.latitude,
    longitude: point.longitude,
    altitude: typeof point.altitude === 'number' ? point.altitude : null,
  };
  if (point.kind) result.kind = point.kind;
  if (typeof point.radius === 'number') result.radius = point.radius;
  if (typeof point.turns === 'number') result.turns = point.turns;
  if (point.actions && point.actions.length) result.actions = point.actions;
  if (typeof (point as any).gimbal_pitch === 'number') {
    result.gimbal_pitch = (point as any).gimbal_pitch;
  }
  const turn = serializeTurnConfig(point.turn);
  if (turn) {
    result.turn = turn;
    if (typeof turn.use_straight_line === 'boolean') {
      result.use_straight_line = turn.use_straight_line;
    }
  }
  const heading = serializeHeadingConfig(point.heading);
  if (heading) result.heading = heading;
  const gimbalHeading = serializeGimbalHeadingConfig(point.gimbal_heading);
  if (gimbalHeading) result.gimbal_heading = gimbalHeading;
  const poi = serializePoiConfig(point.poi);
  if (poi) result.poi = poi;
  if (point.gimbal_strategy) result.gimbal_strategy = point.gimbal_strategy;
  if (point.action_groups && point.action_groups.length) {
    const groups = point.action_groups
      .map(serializeActionGroup)
      .filter((group) => Boolean(group));
    if (groups.length) {
      result.action_groups = groups;
    }
  }
  if (point.altitude_reference) {
    result.altitude_reference = point.altitude_reference;
  }
  return result;
};

interface SimulationSegment {
  label: string;
  distance: number;
  speed: number;
  duration: number;
  startAltitude: number;
  endAltitude: number;
}

interface SimulationPreview {
  segments: SimulationSegment[];
  totalDistance: number;
  totalDuration: number;
}

export const FlyToPanel: React.FC = () => {
  const { sendFlightCommand } = useBridgeCommands();
  const { bridgeData } = useStableBridgeData();
  const telemetry = bridgeData.telemetry;
  const [missionSettings, setMissionSettings] = React.useState(() => missionSettingsStore.getSnapshot());
  React.useEffect(() => missionSettingsStore.subscribe(setMissionSettings), []);
  const executeHeightMode = missionSettings.executeHeightMode;
  const takeoffAltitudeAsl = React.useMemo(() => {
    const latestContextAltitude = (() => {
      const log = bridgeData.flightCommandLog;
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const entry = log[index];
        const derived = entry?.fly_to_context?.takeoff_altitude_asl;
        if (typeof derived === 'number' && Number.isFinite(derived)) {
          return derived;
        }
      }
      return null;
    })();

    if (typeof latestContextAltitude === 'number') {
      return latestContextAltitude;
    }

    const telemetryTakeoff = telemetry?.takeoff_altitude;
    if (typeof telemetryTakeoff === 'number' && Number.isFinite(telemetryTakeoff)) {
      return telemetryTakeoff;
    }

    const homeAltitude = telemetry?.home_location?.altitude;
    if (typeof homeAltitude === 'number' && Number.isFinite(homeAltitude)) {
      return homeAltitude;
    }

    if (
      typeof telemetry?.location?.altitude === 'number' &&
      Number.isFinite(telemetry.location.altitude) &&
      typeof telemetry?.altitude_above_takeoff === 'number' &&
      Number.isFinite(telemetry.altitude_above_takeoff)
    ) {
      const derived = telemetry.location.altitude - telemetry.altitude_above_takeoff;
      if (Number.isFinite(derived)) {
        return derived;
      }
    }

    const locationAltitude = telemetry?.location?.altitude;
    if (typeof locationAltitude === 'number' && Number.isFinite(locationAltitude)) {
      return locationAltitude;
    }

    return null;
  }, [bridgeData.flightCommandLog, telemetry]);

  const resolveTakeoffAltitude = React.useCallback(
    (snapshot?: TelemetryData | null): number | null => {
      const source = snapshot ?? telemetry;
      if (source) {
        const explicit = source.takeoff_altitude;
        if (typeof explicit === 'number' && Number.isFinite(explicit)) {
          return explicit;
        }

        const homeAltitude = source.home_location?.altitude;
        if (typeof homeAltitude === 'number' && Number.isFinite(homeAltitude)) {
          return homeAltitude;
        }

        if (
          typeof source.location?.altitude === 'number' &&
          Number.isFinite(source.location.altitude) &&
          typeof source.altitude_above_takeoff === 'number' &&
          Number.isFinite(source.altitude_above_takeoff)
        ) {
          const derived = source.location.altitude - source.altitude_above_takeoff;
          if (Number.isFinite(derived)) {
            return derived;
          }
        }

        const locationAltitude = source.location?.altitude;
        if (typeof locationAltitude === 'number' && Number.isFinite(locationAltitude)) {
          return locationAltitude;
        }
      }

      if (typeof takeoffAltitudeAsl === 'number' && Number.isFinite(takeoffAltitudeAsl)) {
        return takeoffAltitudeAsl;
      }

      return null;
    },
    [takeoffAltitudeAsl, telemetry],
  );

  const [distanceMeters, setDistanceMeters] = React.useState<number>(5);
  const [verticalMeters, setVerticalMeters] = React.useState<number>(2);
  const [maxSpeed, setMaxSpeed] = React.useState<number>(() => {
    if (typeof window === 'undefined') return 10;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.maxSpeed);
      const parsed = stored != null ? Number(stored) : NaN;
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    } catch {
      // ignore storage error
    }
    return 10;
  });
  const [securityTakeoffHeight, setSecurityTakeoffHeight] = React.useState<number>(() => {
    if (typeof window === 'undefined') return 20;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.securityHeight);
      const parsed = stored != null ? Number(stored) : NaN;
      if (!Number.isNaN(parsed) && parsed >= 0) {
        return parsed;
      }
    } catch {
      // ignore storage error
    }
    return 20;
  });
  const [flyToMode, setFlyToMode] = React.useState<'smart_height' | 'set_height'>(() => {
    if (typeof window === 'undefined') return 'set_height';
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.flyToMode);
      if (stored === 'smart_height' || stored === 'set_height') {
        return stored;
      }
    } catch {
      // ignore
    }
    return 'set_height';
  });
  const [flyToHeight, setFlyToHeight] = React.useState<number>(() => {
    if (typeof window === 'undefined') return 20;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.flyToHeight);
      const parsed = stored != null ? Number(stored) : NaN;
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    } catch {
      // ignore
    }
    return 20;
  });
  const [flightPathMode, setFlightPathMode] = React.useState<'straight' | 'curved'>(() => {
    if (typeof window === 'undefined') return 'straight';
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.flightPathMode);
      if (stored === 'straight' || stored === 'curved') {
        return stored;
      }
    } catch {
      // ignore
    }
    return 'straight';
  });
  const [orbitMode, setOrbitModeState] = React.useState<OrbitMode>(() => {
    const snapshotMode = missionPlannerStore.getSnapshot().orbitMode ?? 'none';
    if (typeof window === 'undefined') {
      return snapshotMode;
    }
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.orbitMode);
      if (stored === 'none' || stored === 'drift' || stored === 'gimbal' || stored === 'gimbal_free') {
        missionPlannerStore.setOrbitMode(stored);
        return stored;
      }
    } catch {
      // ignore
    }
    return snapshotMode;
  });
  const [logEntries, setLogEntries] = React.useState<MissionLogEntry[]>([]);
  const [manualTarget, setManualTarget] = React.useState<ManualTargetState>({ latitude: null, longitude: null, altitude: null });
  const [placingTarget, setPlacingTarget] = React.useState<boolean>(false);
  const [simPreview, setSimPreview] = React.useState<SimulationPreview | null>(null);
  const [missionPlan, setMissionPlan] = React.useState<PlannedMissionEntry[]>(
    () => missionPlannerStore.getSnapshot().plan,
  );
  const missionPlanUpdateOriginRef = React.useRef<'remote' | 'local'>('remote');
  const [expandedEntries, setExpandedEntries] = React.useState<Record<string, boolean>>({});
  const [actionParamDrafts, setActionParamDrafts] = React.useState<Record<string, string>>({});
  const [actionParamErrors, setActionParamErrors] = React.useState<Record<string, string>>({});
  const [lastLaserFix, setLastLaserFix] = React.useState<{ latitude: number; longitude: number; altitude?: number } | null>(null);
  const [targetSelection, setTargetSelection] = React.useState<ObjectMemoryTargetSelection | null>(() =>
    objectMemoryTargetStore.getCurrent(),
  );
  const [objectMemoryClusters, setObjectMemoryClusters] = React.useState<ObjectMemoryCluster[]>([]);
  const [objectMemoryLoading, setObjectMemoryLoading] = React.useState(false);
  const [objectMemoryError, setObjectMemoryError] = React.useState<string | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const lastAckRef = React.useRef<number | null>(null);
  const lastWaypointStateRef = React.useRef<string | null>(null);
  const lastWaypointIndexRef = React.useRef<string | null>(null);
  const waypointTimelineSeenRef = React.useRef<Set<string>>(new Set());
  const [poiTarget, setPoiTarget] = React.useState<PoiTarget | null>(() => missionPlannerStore.getSnapshot().poiTarget ?? null);
  const [lastLoadedKmz, setLastLoadedKmz] = React.useState<{
    name: string;
    path?: string;
    sizeBytes?: number;
    timestamp: number;
  } | null>(null);

  const orbitModeRef = React.useRef<OrbitMode>(orbitMode);
  const poiTargetRef = React.useRef<PoiTarget | null>(poiTarget);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEYS.maxSpeed, String(maxSpeed)); } catch {}
  }, [maxSpeed]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEYS.securityHeight, String(securityTakeoffHeight)); } catch {}
  }, [securityTakeoffHeight]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEYS.flyToMode, flyToMode); } catch {}
  }, [flyToMode]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEYS.flyToHeight, String(flyToHeight)); } catch {}
  }, [flyToHeight]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEYS.flightPathMode, flightPathMode); } catch {}
  }, [flightPathMode]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEYS.orbitMode, orbitMode); } catch {}
  }, [orbitMode]);

  React.useEffect(() => {
    orbitModeRef.current = orbitMode;
  }, [orbitMode]);

  React.useEffect(() => {
    poiTargetRef.current = poiTarget;
  }, [poiTarget]);

  React.useEffect(() => {
    missionPlannerStore.updatePlan((prev) => {
      const desiredReference = altitudeReferenceForExecuteMode(executeHeightMode);
      let mutated = false;
      const next = prev.map((entry) => {
        if (entry.altitudeReference && entry.altitudeReference !== 'inherit') {
          return entry;
        }
        mutated = true;
        return {
          ...entry,
          altitudeReference: desiredReference,
        };
      });
      return mutated ? next : prev;
    });
  }, [executeHeightMode]);

  React.useEffect(() => objectMemoryTargetStore.subscribe(setTargetSelection), []);
  React.useEffect(() => missionPlannerStore.subscribePlan((plan) => {
    missionPlanUpdateOriginRef.current = 'remote';
    setMissionPlan(plan);
  }), []);
  React.useEffect(() => missionPlannerStore.subscribePoiTarget(setPoiTarget), []);
  React.useEffect(() => missionPlannerStore.subscribeOrbitMode(setOrbitModeState), []);

  const refreshObjectMemoryClusters = React.useCallback(async () => {
    setObjectMemoryLoading(true);
    try {
      const response = await listClusters({ limit: 200 });
      const clusters = (response?.clusters ?? []).filter((cluster) => cluster.object_map_anchor);
      setObjectMemoryClusters(clusters);
      objectMemoryCatalogStore.setClusters(clusters);
      setObjectMemoryError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load object memory clusters';
      setObjectMemoryError(message);
      objectMemoryCatalogStore.setClusters([]);
    } finally {
      setObjectMemoryLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshObjectMemoryClusters();
  }, [refreshObjectMemoryClusters]);

  const flyToStatus = telemetry?.fly_to_status as FlyToStatus | undefined;
  const waypointStatus = telemetry?.waypoint_status as WaypointStatusTelemetry | undefined;
  const missionTimeline = (waypointStatus?.timeline ?? []) as WaypointTimelineEntry[];
  const latestStateEntry = [...missionTimeline].reverse().find((entry) => entry.type === 'state');
  const missionStateRaw = latestStateEntry?.state ?? waypointStatus?.state;
  const missionStateLabel = latestStateEntry?.label ?? formatMissionStateLabel(missionStateRaw);
  const missionActive = Boolean(
    missionStateRaw &&
      !['ready', 'finished', 'idle', 'not_supported', 'unknown'].includes(
        missionStateRaw.toLowerCase(),
      ),
  );
  const missionStateNormalized = missionStateRaw?.toLowerCase() ?? '';
  const missionTimestampLabel = formatRelativeTime(waypointStatus?.timestamp);
  const missionBackend = waypointStatus?.backend;
  const missionId = waypointStatus?.mission_id;
  const missionInterrupt = waypointStatus?.last_interrupt;
  const missionTimelineDisplay = [...missionTimeline].slice(-6).reverse();
  const latestPauseEvent = [...missionTimeline].reverse().find((entry) => entry.type === 'event' && entry.event === 'pause');
  const latestResumeEvent = [...missionTimeline].reverse().find((entry) => entry.type === 'event' && entry.event === 'resume');
  const pauseTimestamp = latestPauseEvent?.timestamp ?? 0;
  const resumeTimestamp = latestResumeEvent?.timestamp ?? 0;
  const pausedByEvent = Boolean(latestPauseEvent && pauseTimestamp >= resumeTimestamp);
  const missionPaused = pausedByEvent || missionStateNormalized === 'interrupted';
  const canResumeMission = missionPaused;
  const canPauseMission = missionActive && !missionPaused;
  const missionTimelineTooltip = React.useCallback((entry: WaypointTimelineEntry, fallback: string) => {
    if ('reason' in entry && typeof entry.reason === 'string' && entry.reason) {
      return entry.reason.replace(/_/g, ' ');
    }
    if ('pause_reason' in entry && typeof entry.pause_reason === 'string' && entry.pause_reason) {
      return entry.pause_reason.replace(/_/g, ' ');
    }
    if ('resume_reason' in entry && typeof entry.resume_reason === 'string' && entry.resume_reason) {
      return entry.resume_reason.replace(/_/g, ' ');
    }
    if ('exit_reason' in entry && typeof entry.exit_reason === 'string' && entry.exit_reason) {
      return entry.exit_reason.replace(/_/g, ' ');
    }
    if ('error' in entry && entry.error?.description) {
      return entry.error.description;
    }
    return fallback;
  }, []);

  const handleOrbitModeChange = React.useCallback((mode: OrbitMode) => {
    missionPlannerStore.setOrbitMode(mode);
  }, []);

  const handleExecuteHeightModeChange = React.useCallback((mode: ExecuteHeightMode) => {
    missionSettingsStore.setExecuteHeightMode(mode);
  }, []);

  const ensureTelemetry = (): TelemetryData | null => {
    if (!telemetry || !telemetry.location) {
      setStatusMessage('Telemetry unavailable — cannot compute target.');
      return null;
    }
    return telemetry;
  };

  const [terrainElevationPreview, setTerrainElevationPreview] = React.useState<number | null>(null);

  const getDefaultAglHeight = React.useCallback((): number | null => {
    if (flyToMode === 'set_height' && Number.isFinite(flyToHeight)) {
      return flyToHeight;
    }
    if (Number.isFinite(securityTakeoffHeight)) {
      return securityTakeoffHeight;
    }
    return null;
  }, [flyToHeight, flyToMode, securityTakeoffHeight]);

  React.useEffect(() => {
    if (executeHeightMode !== 'absolute_wgs84') {
      setTerrainElevationPreview(null);
      return;
    }
    const candidateLat = manualTarget.latitude ?? telemetry?.location?.latitude ?? telemetry?.home_location?.latitude ?? null;
    const candidateLon = manualTarget.longitude ?? telemetry?.location?.longitude ?? telemetry?.home_location?.longitude ?? null;
    if (typeof candidateLat !== 'number' || typeof candidateLon !== 'number' || !Number.isFinite(candidateLat) || !Number.isFinite(candidateLon)) {
      setTerrainElevationPreview(null);
      return;
    }
    let cancelled = false;
    terrainCache.getElevation(candidateLat, candidateLon).then((value) => {
      if (!cancelled) {
        setTerrainElevationPreview(typeof value === 'number' && Number.isFinite(value) ? value : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [executeHeightMode, manualTarget.latitude, manualTarget.longitude, telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.location?.latitude, telemetry?.location?.longitude]);

  const computeDefaultTargetAltitude = React.useCallback((options?: {
    latitude?: number | null;
    longitude?: number | null;
    terrainElevation?: number | null;
  }): number | null => {
    const takeoffAsl = resolveTakeoffAltitude();
    const defaultAglHeight = getDefaultAglHeight();

    if (executeHeightMode === 'absolute_wgs84') {
      const terrainElevation = (() => {
        if (typeof options?.terrainElevation === 'number' && Number.isFinite(options.terrainElevation)) {
          return options.terrainElevation;
        }
        if (typeof terrainElevationPreview === 'number' && Number.isFinite(terrainElevationPreview)) {
          return terrainElevationPreview;
        }
        return null;
      })();

      if (terrainElevation != null && defaultAglHeight != null) {
        return clampAltitude(terrainElevation + defaultAglHeight);
      }
      if (takeoffAsl != null && defaultAglHeight != null) {
        return clampAltitude(takeoffAsl + defaultAglHeight);
      }
    }

    if (flyToMode === 'set_height' && Number.isFinite(flyToHeight)) {
      if (takeoffAsl != null) {
        return takeoffAsl + flyToHeight;
      }
      const baseAlt = telemetry?.location?.altitude;
      return typeof baseAlt === 'number' && Number.isFinite(baseAlt)
        ? baseAlt + flyToHeight
        : null;
    }

    if (Number.isFinite(securityTakeoffHeight)) {
      if (takeoffAsl != null) {
        return takeoffAsl + securityTakeoffHeight;
      }
      const baseAlt = telemetry?.location?.altitude;
      if (typeof baseAlt === 'number' && Number.isFinite(baseAlt)) {
        return baseAlt + securityTakeoffHeight;
      }
    }

    if (takeoffAsl != null) {
      return takeoffAsl;
    }

    const fallbackAlt = telemetry?.location?.altitude ?? telemetry?.altitude ?? null;
    return typeof fallbackAlt === 'number' && Number.isFinite(fallbackAlt) ? fallbackAlt : null;
  }, [executeHeightMode, getDefaultAglHeight, resolveTakeoffAltitude, terrainElevationPreview, telemetry?.altitude, telemetry?.location?.altitude, flyToMode, flyToHeight, securityTakeoffHeight]);

  const resolveDefaultAltitudeForLocation = React.useCallback(async (
    latitude: number,
    longitude: number,
    fallback?: number | null,
  ): Promise<number | null> => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return computeDefaultTargetAltitude();
    }

    if (executeHeightMode === 'absolute_wgs84') {
      const agl = getDefaultAglHeight();
      if (agl != null) {
        const terrainElevation = await terrainCache.getElevation(latitude, longitude);
        if (typeof terrainElevation === 'number' && Number.isFinite(terrainElevation)) {
          return clampAltitude(terrainElevation + agl);
        }
      }
      if (typeof fallback === 'number' && Number.isFinite(fallback)) {
        return clampAltitude(fallback);
      }
    }

    return computeDefaultTargetAltitude();
  }, [computeDefaultTargetAltitude, executeHeightMode, getDefaultAglHeight]);

  const handleCopyMissionPath = React.useCallback(async (path: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(path);
        setStatusMessage('KMZ path copied to clipboard');
      } else {
        setStatusMessage('Clipboard API unavailable');
      }
    } catch (error) {
      console.error('Failed to copy KMZ path', error);
      setStatusMessage('Failed to copy KMZ path');
    }
  }, []);
  const derivedTarget = React.useMemo(() => {
    const anchor = targetSelection?.anchor;
    if (!anchor) return null;
    const objectPosition = anchor.object_position;
    const mapTarget = anchor.object_map?.target_point;
    const candidate = mapTarget && typeof mapTarget.latitude === 'number' && typeof mapTarget.longitude === 'number'
      ? mapTarget
      : objectPosition;

    if (!candidate || typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') {
      return null;
    }

    const altitudeCandidate = candidate.altitude_m ?? anchor.object_map?.laser_location?.altitude_m ?? objectPosition?.altitude_m;
    return {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      altitude: altitudeCandidate ?? null,
    };
  }, [targetSelection]);
  const activeTarget = React.useMemo(() => {
    if (manualTarget.latitude != null && manualTarget.longitude != null) {
      return manualTarget;
    }
    if (derivedTarget) {
      return {
        latitude: derivedTarget.latitude,
        longitude: derivedTarget.longitude,
        altitude: derivedTarget.altitude ?? null,
        source: 'object-memory' as ManualTargetState['source'],
      };
    }
    return null;
  }, [manualTarget.latitude, manualTarget.longitude, manualTarget.altitude, manualTarget.source, derivedTarget?.latitude, derivedTarget?.longitude, derivedTarget?.altitude]);

  const selectedObjectMemoryClusterId = targetSelection?.clusterId ?? '';
  const objectMemorySelectionAvailable = selectedObjectMemoryClusterId
    ? objectMemoryClusters.some((cluster) => cluster.cluster_id === selectedObjectMemoryClusterId)
    : false;
  const objectMemorySelectValue = objectMemorySelectionAvailable ? selectedObjectMemoryClusterId : '';
  const objectMemorySelectionMissing = Boolean(selectedObjectMemoryClusterId && !objectMemorySelectionAvailable);

  const canAssignPoi = Boolean(
    activeTarget &&
    activeTarget.latitude != null &&
    activeTarget.longitude != null,
  );

  const defaultTargetAltitudePreview = computeDefaultTargetAltitude();

  const appendLog = React.useCallback((label: string, payload: Record<string, any>, kind: MissionLogKind = 'command') => {
    setLogEntries((prev) => {
      const entry: MissionLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        label,
        payload,
        kind,
      };
      const next = [entry, ...prev];
      return next.slice(0, MAX_LOG_ENTRIES);
    });
  }, []);

  const applyPoiFromAnchor = React.useCallback(
    (anchor: ObjectMemoryClusterAnchor | null | undefined, context?: { clusterId?: string; clusterLabel?: string | null }) => {
      if (!anchor) {
        setStatusMessage('Selected object memory entry has no anchor telemetry.');
        return false;
      }

      const candidate = anchor.object_map?.target_point ?? anchor.object_position;
      if (
        !candidate ||
        typeof candidate.latitude !== 'number' ||
        typeof candidate.longitude !== 'number'
      ) {
        setStatusMessage('Selected object memory anchor is missing coordinates.');
        return false;
      }

      const altitudeCandidate =
        typeof candidate.altitude_m === 'number'
          ? candidate.altitude_m
          : typeof anchor.object_map?.laser_location?.altitude_m === 'number'
            ? anchor.object_map?.laser_location?.altitude_m
            : typeof anchor.object_position?.altitude_m === 'number'
              ? anchor.object_position.altitude_m
              : null;

      const altitude =
        typeof altitudeCandidate === 'number'
          ? altitudeCandidate
          : defaultTargetAltitudePreview ?? telemetry?.location?.altitude ?? null;

      const poiPayload = {
        latitude: clampLat(candidate.latitude),
        longitude: clampLon(candidate.longitude),
        altitude,
      };

      missionPlannerStore.setPoiTarget(poiPayload);
      appendLog(
        'POI target updated (object-memory)',
        {
          ...poiPayload,
          source: 'object-memory',
          cluster: context?.clusterLabel ?? context?.clusterId,
        },
        'manual',
      );

      const clusterLabel = context?.clusterLabel ?? context?.clusterId ?? 'object memory';
      setStatusMessage(`POI set from ${clusterLabel}`);
      return true;
    },
    [appendLog, defaultTargetAltitudePreview, setStatusMessage, telemetry?.location?.altitude],
  );

  const handleSetPoiFromTarget = React.useCallback(() => {
    const target = activeTarget;
    if (!target || target.latitude == null || target.longitude == null) {
      setStatusMessage('No staged target available to assign as POI.');
      return;
    }
    const altitudeCandidate = typeof target.altitude === 'number' && Number.isFinite(target.altitude)
      ? target.altitude
      : typeof telemetry?.location?.altitude === 'number'
        ? telemetry.location.altitude
        : typeof telemetry?.altitude === 'number'
          ? telemetry.altitude
          : null;
    missionPlannerStore.setPoiTarget({
      latitude: clampLat(target.latitude),
      longitude: clampLon(target.longitude),
      altitude: altitudeCandidate,
    });
    setStatusMessage(`POI set to ${formatLatLon(target.latitude)}, ${formatLatLon(target.longitude)}`);
  }, [activeTarget, telemetry?.location?.altitude, telemetry?.altitude]);

  const handleClearPoiTarget = React.useCallback(() => {
    missionPlannerStore.setPoiTarget(null);
    setStatusMessage('POI target cleared.');
  }, []);

  const handleSelectObjectMemoryCluster = React.useCallback((clusterId: string) => {
    if (!clusterId) {
      objectMemoryTargetStore.set(null);
      setStatusMessage('Object Memory selection cleared.');
      return;
    }

    const cluster = objectMemoryClusters.find((entry) => entry.cluster_id === clusterId);
    if (!cluster) {
      setStatusMessage('Selected Object Memory cluster is unavailable.');
      return;
    }

    const anchor = cluster.object_map_anchor;
    if (!anchor) {
      setStatusMessage('Selected cluster has no anchor coordinates.');
      return;
    }

    objectMemoryTargetStore.set({
      clusterId: cluster.cluster_id,
      clusterLabel: cluster.label,
      anchor,
    });

    applyPoiFromAnchor(anchor, {
      clusterId: cluster.cluster_id,
      clusterLabel: cluster.label,
    });
  }, [applyPoiFromAnchor, objectMemoryClusters, setStatusMessage]);

  const handleSetPoiFromObjectMemory = React.useCallback(() => {
    if (!targetSelection) {
      setStatusMessage('Select an Object Memory target to assign a POI.');
      return;
    }
    applyPoiFromAnchor(targetSelection.anchor, {
      clusterId: targetSelection.clusterId,
      clusterLabel: targetSelection.clusterLabel,
    });
  }, [applyPoiFromAnchor, setStatusMessage, targetSelection]);

  const manualTargetSourceLabel = React.useMemo(() => {
    switch (manualTarget.source) {
      case 'map':
        return 'Map click';
      case 'laser':
        return 'Laser range';
      case 'object-memory':
        return 'Object memory';
      case 'manual':
        return 'Manual entry';
      default:
        return null;
    }
  }, [manualTarget.source]);

  React.useEffect(() => {
    if (missionPlanUpdateOriginRef.current !== 'local') {
      return;
    }
    missionPlannerStore.setPlan(missionPlan);
    missionPlanUpdateOriginRef.current = 'remote';
  }, [missionPlan]);

  React.useEffect(() => {
    if (
      manualTarget.latitude != null &&
      manualTarget.longitude != null &&
      (manualTarget.altitude == null || Number.isNaN(manualTarget.altitude))
    ) {
      const defaultAltitude = computeDefaultTargetAltitude();
      if (defaultAltitude != null) {
        setManualTarget((prev) => {
          if (
            prev.latitude !== manualTarget.latitude ||
            prev.longitude !== manualTarget.longitude ||
            prev.altitude === defaultAltitude
          ) {
            return prev;
          }
          return {
            ...prev,
            altitude: defaultAltitude,
          };
        });
      }
    }
  }, [manualTarget.latitude, manualTarget.longitude, manualTarget.altitude, computeDefaultTargetAltitude]);

  React.useEffect(() => {
    if (!derivedTarget || !targetSelection) {
      return;
    }
    setManualTarget((prev) => {
      if (prev.source && prev.source !== 'object-memory') {
        return prev;
      }
      if (
        prev.latitude === derivedTarget.latitude &&
        prev.longitude === derivedTarget.longitude &&
        ((prev.altitude ?? null) === (derivedTarget.altitude ?? null))
      ) {
        return prev;
      }
      return {
        latitude: derivedTarget.latitude,
        longitude: derivedTarget.longitude,
        altitude: derivedTarget.altitude ?? prev.altitude ?? null,
        source: 'object-memory',
      };
    });
  }, [derivedTarget?.latitude, derivedTarget?.longitude, derivedTarget?.altitude, targetSelection?.clusterId]);

  React.useEffect(() => {
    if (manualTarget.latitude == null || manualTarget.longitude == null) {
      missionPlannerStore.setManualTarget(null);
      return;
    }
    missionPlannerStore.setManualTarget(manualTarget);
  }, [manualTarget.latitude, manualTarget.longitude, manualTarget.altitude, manualTarget.source]);

  React.useEffect(() => {
    const executingIndex = waypointStatus?.executing?.current_waypoint_index;
    const telemetryWaypoints = waypointStatus?.waypoints;

    const fromTelemetry = (): MissionWaypointTarget | null => {
      if (!telemetryWaypoints || telemetryWaypoints.length === 0) {
        return null;
      }
      const candidate = (() => {
        if (typeof executingIndex === 'number') {
          const exact = telemetryWaypoints.find((wp) => wp && wp.index === executingIndex);
          if (exact) return exact;
          const fallback = telemetryWaypoints.find((wp) => {
            if (!wp) return false;
            if (typeof wp.index === 'number') {
              return wp.index >= executingIndex;
            }
            return false;
          });
          return fallback ?? telemetryWaypoints[telemetryWaypoints.length - 1];
        }
        return telemetryWaypoints.find(
          (wp) => wp && typeof wp.latitude === 'number' && typeof wp.longitude === 'number',
        ) ?? null;
      })();

      if (!candidate || typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') {
        return null;
      }

      const labelIndex = typeof candidate.index === 'number' ? candidate.index + 1 : undefined;
      const label = labelIndex != null
        ? (candidate.kind === 'orbit' ? `O${labelIndex}` : `${labelIndex}`)
        : (candidate.kind === 'orbit' ? 'O' : 'NEXT');

      return {
        index: candidate.index,
        label,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        altitude: typeof candidate.execute_height === 'number' ? candidate.execute_height : null,
        kind: candidate.kind,
      };
    };

    const fromPlan = (): MissionWaypointTarget | null => {
      if (!missionPlan.length) {
        return null;
      }
      let planIndex = typeof executingIndex === 'number' && executingIndex >= 0 && executingIndex < missionPlan.length
        ? executingIndex
        : 0;
      const entry = missionPlan[planIndex];
      if (!entry) {
        return null;
      }
      const label = entry.kind === 'orbit'
        ? `O${planIndex + 1}`
        : entry.kind === 'return_home'
          ? 'R'
          : entry.kind === 'land'
            ? 'L'
            : `${planIndex + 1}`;
      return {
        index: planIndex,
        label,
        latitude: entry.latitude,
        longitude: entry.longitude,
        altitude: entry.altitude ?? null,
        kind: entry.kind,
      };
    };

    const target = fromTelemetry() ?? fromPlan();
    missionPlannerStore.setActiveWaypoint(target);
  }, [missionPlan, waypointStatus?.executing?.current_waypoint_index, waypointStatus?.waypoints]);

  React.useEffect(() => {
    if (manualTarget.latitude == null || manualTarget.longitude == null) {
      return;
    }
    setPlacingTarget(false);
  }, [manualTarget.latitude, manualTarget.longitude]);

  React.useEffect(() => {
    setSimPreview(null);
  }, [manualTarget.latitude, manualTarget.longitude, manualTarget.altitude, flyToMode, flyToHeight, maxSpeed, securityTakeoffHeight]);
  const capabilitySupportedModes = React.useMemo(() => {
    const raw = flyToStatus?.capability?.supported_modes;
    if (!raw || !Array.isArray(raw) || raw.length === 0) return undefined;
    const mapping: Record<string, 'smart_height' | 'set_height'> = {
      smart_height: 'smart_height',
      smartheight: 'smart_height',
      smart: 'smart_height',
      set_height: 'set_height',
      setheight: 'set_height',
      set: 'set_height',
    };
    const normalized = raw
      .map((mode) => (typeof mode === 'string' ? mapping[mode.toLowerCase()] : undefined))
      .filter((value): value is 'smart_height' | 'set_height' => Boolean(value));
    if (!normalized.length) return undefined;
    return Array.from(new Set(normalized));
  }, [flyToStatus?.capability?.supported_modes]);

  const availableModes = capabilitySupportedModes ?? ['smart_height', 'set_height'];

  React.useEffect(() => {
    if (!availableModes.includes(flyToMode)) {
      setFlyToMode(availableModes[0]);
    }
  }, [availableModes, flyToMode]);

  const heightRange = flyToStatus?.capability?.height_range;
  const heightRangeMin = typeof heightRange?.min === 'number' ? heightRange.min : 1;
  const heightRangeMax = typeof heightRange?.max === 'number' ? heightRange.max : 500;

  const homeLocation = telemetry?.home_location;
  const hasHomeLocation = Boolean(homeLocation
    && Number.isFinite(homeLocation.latitude)
    && Number.isFinite(homeLocation.longitude));
  const hasLandingCoordinate = hasHomeLocation
    || Boolean(telemetry?.location
      && Number.isFinite(telemetry.location.latitude)
      && Number.isFinite(telemetry.location.longitude));


  const handleClearMissionLog = React.useCallback(() => {
    setLogEntries([]);
    setStatusMessage('Mission timeline cleared');
  }, []);

  const addWaypointToPlan = React.useCallback(() => {
    if (!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Stage a target before adding a waypoint to the plan.');
      return;
    }
    const manualAltitude = typeof manualTarget.altitude === 'number' ? manualTarget.altitude : null;
    const activeAltitude = typeof activeTarget.altitude === 'number' ? activeTarget.altitude : null;
    const altitudeCandidate = manualAltitude
      ?? activeAltitude
      ?? defaultTargetAltitudePreview
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? null;
    const altitudeReference = inferAltitudeReference(
      altitudeCandidate,
      activeTarget?.source ?? manualTarget.source,
    );
    const entry: PlannedMissionEntry = {
      id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'waypoint',
      latitude: activeTarget.latitude,
      longitude: activeTarget.longitude,
      altitude: altitudeCandidate,
    };
    if (altitudeReference) {
      entry.altitudeReference = altitudeReference;
    }
    updateMissionPlan((prev) => [...prev, entry]);
    setExpandedEntries((prev) => ({ ...prev, [entry.id]: true }));
    appendLog('Plan waypoint added', entry, 'manual');
    setStatusMessage('Waypoint added to mission plan.');
  }, [activeTarget, telemetry?.location?.altitude, telemetry?.altitude, appendLog, defaultTargetAltitudePreview]);

  const addOrbitToPlan = React.useCallback(() => {
    if (!canAssignPoi || !activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Stage a target before assigning the POI/orbit center.');
      return;
    }
    const altitudeCandidate = defaultTargetAltitudePreview
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? activeTarget.altitude
      ?? null;
    missionPlannerStore.setPoiTarget({
      latitude: clampLat(activeTarget.latitude),
      longitude: clampLon(activeTarget.longitude),
      altitude: altitudeCandidate,
    });
    appendLog('POI target updated (mission control)', {
      latitude: activeTarget.latitude,
      longitude: activeTarget.longitude,
      altitude: altitudeCandidate,
      source: 'mission_control',
    }, 'manual');
    setStatusMessage('POI target updated from staged target.');
  }, [activeTarget, canAssignPoi, defaultTargetAltitudePreview, telemetry?.location?.altitude, telemetry?.altitude, appendLog]);

  const addReturnHomeToPlan = React.useCallback(() => {
    const home = telemetry?.home_location;
    if (!home || !Number.isFinite(home.latitude) || !Number.isFinite(home.longitude)) {
      setStatusMessage('Home location unavailable; cannot add Return Home waypoint.');
      return;
    }

    const altitudeReference = inferAltitudeReference(
      defaultTargetAltitudePreview
        ?? takeoffAltitudeAsl
        ?? telemetry?.location?.altitude
        ?? null,
      'map',
    );

    const entry: PlannedMissionEntry = {
      id: `return-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'return_home',
      latitude: clampLat(home.latitude),
      longitude: clampLon(home.longitude),
      altitude: defaultTargetAltitudePreview
        ?? takeoffAltitudeAsl
        ?? telemetry?.location?.altitude
        ?? null,
    };
    if (altitudeReference) {
      entry.altitudeReference = altitudeReference;
    }
    updateMissionPlan((prev) => [...prev, entry]);
    setExpandedEntries((prev) => ({ ...prev, [entry.id]: true }));
    appendLog('Plan return-to-home added', entry, 'manual');
    setStatusMessage('Return-to-home added to mission plan.');
  }, [telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.location?.altitude, appendLog, defaultTargetAltitudePreview, takeoffAltitudeAsl]);

  const addHomeWaypointToPlan = React.useCallback(() => {
    const home = telemetry?.home_location;
    if (!home || !Number.isFinite(home.latitude) || !Number.isFinite(home.longitude)) {
      setStatusMessage('Home location unavailable; cannot add Home waypoint.');
      return;
    }

    const altitudeCandidate = defaultTargetAltitudePreview
      ?? takeoffAltitudeAsl
      ?? telemetry?.location?.altitude
      ?? null;
    const altitudeReference = inferAltitudeReference(altitudeCandidate, 'map');

    const entry: PlannedMissionEntry = {
      id: `home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'waypoint',
      latitude: clampLat(home.latitude),
      longitude: clampLon(home.longitude),
      altitude: altitudeCandidate,
    };
    if (altitudeReference) {
      entry.altitudeReference = altitudeReference;
    }
    updateMissionPlan((prev) => [...prev, entry]);
    setExpandedEntries((prev) => ({ ...prev, [entry.id]: true }));
    appendLog('Plan home waypoint added', entry, 'manual');
    setStatusMessage('Home waypoint added to mission plan.');
  }, [telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.location?.altitude, appendLog, defaultTargetAltitudePreview, takeoffAltitudeAsl]);

  const addOriginWaypointToPlan = React.useCallback(() => {
    const origin = missionPlan.find((entry) => Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude));
    if (!origin) {
      setStatusMessage('Add at least one waypoint before adding Origin.');
      return;
    }

    const altitudeCandidate = origin.altitude
      ?? defaultTargetAltitudePreview
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? null;
    const altitudeReference = origin.altitudeReference
      ?? inferAltitudeReference(altitudeCandidate, manualTarget.source);

    const entry: PlannedMissionEntry = {
      id: `origin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'waypoint',
      latitude: clampLat(origin.latitude),
      longitude: clampLon(origin.longitude),
      altitude: altitudeCandidate,
    };
    if (altitudeReference) {
      entry.altitudeReference = altitudeReference;
    }
    updateMissionPlan((prev) => [...prev, entry]);
    setExpandedEntries((prev) => ({ ...prev, [entry.id]: true }));
    appendLog('Plan origin waypoint added', entry, 'manual');
    setStatusMessage('Origin waypoint appended to mission plan.');
  }, [missionPlan, telemetry?.location?.altitude, telemetry?.altitude, appendLog, defaultTargetAltitudePreview]);

  const addLandToPlan = React.useCallback(() => {
    const candidate = [...missionPlan].reverse().find((entry) =>
      Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude)
    );

    const landingLatitude = candidate?.latitude
      ?? telemetry?.location?.latitude
      ?? telemetry?.home_location?.latitude;
    const landingLongitude = candidate?.longitude
      ?? telemetry?.location?.longitude
      ?? telemetry?.home_location?.longitude;

    if (!Number.isFinite(landingLatitude) || !Number.isFinite(landingLongitude)) {
      setStatusMessage('Landing coordinate unavailable; cannot add Land waypoint.');
      return;
    }

    const landingAltitude = resolveTakeoffAltitude()
      ?? candidate?.altitude
      ?? telemetry?.location?.altitude
      ?? defaultTargetAltitudePreview
      ?? 0;

    const altitudeReference = inferAltitudeReference(landingAltitude, 'map');

    const entry: PlannedMissionEntry = {
      id: `land-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'land',
      latitude: clampLat(landingLatitude),
      longitude: clampLon(landingLongitude),
      altitude: landingAltitude,
    };
    if (altitudeReference) {
      entry.altitudeReference = altitudeReference;
    }
    updateMissionPlan((prev) => [...prev, entry]);
    setExpandedEntries((prev) => ({ ...prev, [entry.id]: true }));
    appendLog('Plan land added', entry, 'manual');
    setStatusMessage('Landing step added to mission plan.');
  }, [missionPlan, telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, appendLog, defaultTargetAltitudePreview, resolveTakeoffAltitude]);

  const removePlanEntry = React.useCallback((id: string) => {
    updateMissionPlan((prev) => prev.filter((entry) => entry.id !== id));
    setExpandedEntries((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActionParamDrafts((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (key.startsWith(`${id}:`)) {
          changed = true;
          return;
        }
        next[key] = value;
      });
      return changed ? next : prev;
    });
    setActionParamErrors((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (key.startsWith(`${id}:`)) {
          changed = true;
          return;
        }
        next[key] = value;
      });
      return changed ? next : prev;
    });
  }, []);

  const clearMissionPlan = React.useCallback(() => {
    replaceMissionPlan([]);
    setExpandedEntries({});
    setActionParamDrafts({});
    setActionParamErrors({});
    setStatusMessage('Mission plan cleared.');
  }, []);

  const togglePlanEntryExpanded = React.useCallback((id: string) => {
    setExpandedEntries((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }, []);

  const cloneActionGroups = React.useCallback((groups: WaypointActionGroup[] | undefined) => {
    if (!groups) return undefined;
    return groups.map((group) => ({
      ...group,
      actions: group.actions.map((action) => ({
        ...action,
        params: action.params ? { ...action.params } : undefined,
      })),
    }));
  }, []);

  const sanitizePoiTarget = React.useCallback((target: PoiTarget | null): PoiTarget | null => {
    if (!target) {
      return null;
    }
    const latitude = clampLat(target.latitude);
    const longitude = clampLon(target.longitude);
    const altitude = typeof target.altitude === 'number' && Number.isFinite(target.altitude)
      ? target.altitude
      : null;
    return {
      latitude,
      longitude,
      altitude,
    };
  }, []);

  const poiTargetsEqual = React.useCallback((a?: PoiTarget | null, b?: PoiTarget | null) => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const altA = typeof a.altitude === 'number' && Number.isFinite(a.altitude) ? a.altitude : null;
    const altB = typeof b.altitude === 'number' && Number.isFinite(b.altitude) ? b.altitude : null;
    return (
      Math.abs(a.latitude - b.latitude) < 1e-7 &&
      Math.abs(a.longitude - b.longitude) < 1e-7 &&
      ((altA === null && altB === null) || (altA !== null && altB !== null && Math.abs(altA - altB) < 1e-3))
    );
  }, []);

  const applyOrbitDefaultsToPlan = React.useCallback(
    (plan: PlannedMissionEntry[], mode: OrbitMode, poi: PoiTarget | null): PlannedMissionEntry[] => {
      const sanitizedPoi = sanitizePoiTarget(poi);
      const normalizedMode: OrbitMode = mode ?? 'none';
      let changed = false;

      const nextPlan = plan.map((entry) => {
        if (entry.kind !== 'waypoint') {
          if (entry.orbitAutoHeading) {
            changed = true;
            return {
              ...entry,
              orbitAutoHeading: undefined,
            };
          }
          return entry;
        }

        if (normalizedMode === 'drift' && sanitizedPoi) {
          if (entry.orbitAutoHeading === false) {
            return entry;
          }

          const needsHeadingUpdate = entry.heading?.mode !== 'towardPOI'
            || !poiTargetsEqual(entry.heading?.poi, sanitizedPoi);
          const needsPoiUpdate = !poiTargetsEqual(entry.poi, sanitizedPoi);

          if (!needsHeadingUpdate && !needsPoiUpdate && entry.orbitAutoHeading === true) {
            return entry;
          }

          changed = true;
          return {
            ...entry,
            heading: {
              ...(entry.heading ?? {}),
              mode: 'towardPOI',
              poi: { ...sanitizedPoi },
            },
            poi: { ...sanitizedPoi },
            orbitAutoHeading: true,
          };
        }

        if (entry.orbitAutoHeading) {
          const shouldClearHeading = entry.heading?.mode === 'towardPOI';
          const shouldClearPoi = !!entry.poi && (!poiTargetsEqual(entry.poi, sanitizedPoi) || sanitizedPoi == null);

          if (!shouldClearHeading && !shouldClearPoi && normalizedMode === 'drift' && sanitizedPoi) {
            return entry;
          }

          changed = true;
          return {
            ...entry,
            heading: shouldClearHeading ? null : entry.heading,
            poi: shouldClearPoi ? null : entry.poi,
            orbitAutoHeading: normalizedMode === 'drift' && sanitizedPoi ? true : undefined,
          };
        }

        if (
          normalizedMode === 'drift' &&
          sanitizedPoi &&
          entry.orbitAutoHeading == null &&
          entry.heading?.mode === 'towardPOI'
        ) {
          changed = true;
          return {
            ...entry,
            heading: {
              ...entry.heading,
              mode: 'towardPOI',
              poi: { ...sanitizedPoi },
            },
            poi: { ...sanitizedPoi },
            orbitAutoHeading: true,
          };
        }

        if (
          normalizedMode !== 'drift' &&
          entry.orbitAutoHeading == null &&
          entry.heading?.mode === 'towardPOI' &&
          (entry.poi || sanitizedPoi == null)
        ) {
          changed = true;
          return {
            ...entry,
            heading: null,
            poi: null,
            orbitAutoHeading: undefined,
          };
        }

        return entry;
      });

      return changed ? nextPlan : plan;
    },
    [poiTargetsEqual, sanitizePoiTarget],
  );

  const updateMissionPlan = React.useCallback((updater: (prev: PlannedMissionEntry[]) => PlannedMissionEntry[]) => {
    missionPlanUpdateOriginRef.current = 'local';
    setMissionPlan((prev) => applyOrbitDefaultsToPlan(updater(prev), orbitModeRef.current, poiTargetRef.current));
  }, [applyOrbitDefaultsToPlan]);

  const replaceMissionPlan = React.useCallback((nextPlan: PlannedMissionEntry[]) => {
    missionPlanUpdateOriginRef.current = 'local';
    setMissionPlan(applyOrbitDefaultsToPlan(nextPlan, orbitModeRef.current, poiTargetRef.current));
  }, [applyOrbitDefaultsToPlan]);

  React.useEffect(() => {
    missionPlanUpdateOriginRef.current = 'local';
    setMissionPlan((prev) => applyOrbitDefaultsToPlan(prev, orbitMode, poiTarget));
  }, [applyOrbitDefaultsToPlan, orbitMode, poiTarget]);

  const updatePlanEntryById = React.useCallback((
    id: string,
    updater: (entry: PlannedMissionEntry) => PlannedMissionEntry,
  ) => {
    updateMissionPlan((prev) => prev.map((entry) => {
      if (entry.id !== id) {
        return entry;
      }
      const base: PlannedMissionEntry = {
        ...entry,
        actions: entry.actions ? entry.actions.map((action) => ({ ...action })) : undefined,
        turn: entry.turn ? { ...entry.turn } : undefined,
        heading: entry.heading
          ? { ...entry.heading, poi: entry.heading.poi ? { ...entry.heading.poi } : undefined }
          : undefined,
        gimbalHeading: entry.gimbalHeading ? { ...entry.gimbalHeading } : undefined,
        poi: entry.poi ? { ...entry.poi } : undefined,
        actionGroups: cloneActionGroups(entry.actionGroups),
      };
      return updater(base);
    }));
  }, [cloneActionGroups, updateMissionPlan]);

  const updatePlanEntryAltitude = React.useCallback((id: string, altitude: number | null) => {
    updatePlanEntryById(id, (entry) => ({ ...entry, altitude }));
  }, [updatePlanEntryById]);

  const updatePlanEntryGimbalPitch = React.useCallback((id: string, pitch: number | null) => {
    updatePlanEntryById(id, (entry) => {
      const withoutGimbal = (entry.actions ?? []).filter((action) => action.type !== 'gimbal_pitch');
      if (pitch == null || Number.isNaN(pitch)) {
        return withoutGimbal.length ? { ...entry, actions: withoutGimbal } : { ...entry, actions: undefined };
      }
      const clampedPitch = Math.max(GIMBAL_PITCH_MIN, Math.min(GIMBAL_PITCH_MAX, pitch));
      const nextActions: WaypointAction[] = [...withoutGimbal, { type: 'gimbal_pitch', pitch: clampedPitch, timing: 'before' }];
      return { ...entry, actions: nextActions };
    });
  }, [updatePlanEntryById]);

  const updatePlanEntryTurn = React.useCallback((id: string, turn: WaypointTurnConfig | null) => {
    updatePlanEntryById(id, (entry) => {
      if (!turn) {
        return { ...entry, turn: undefined };
      }
      const normalized: WaypointTurnConfig = { ...turn };
      if (normalized.mode === 'auto') {
        delete normalized.mode;
      }
      if (
        !normalized.mode &&
        normalized.damping == null &&
        normalized.useStraightLine == null
      ) {
        return { ...entry, turn: undefined };
      }
      return { ...entry, turn: normalized };
    });
  }, [updatePlanEntryById]);

  const updatePlanEntryHeading = React.useCallback((id: string, heading: WaypointHeadingConfig | null) => {
    updatePlanEntryById(id, (entry) => {
      if (!heading) {
        return {
          ...entry,
          heading: undefined,
          orbitAutoHeading: entry.orbitAutoHeading ? undefined : entry.orbitAutoHeading,
        };
      }
      const normalized: WaypointHeadingConfig = {
        ...heading,
        poi: heading.poi ? { ...heading.poi } : undefined,
      };
      const hasValue = Boolean(
        normalized.mode ||
        normalized.angle != null ||
        normalized.angleEnable != null ||
        normalized.poi ||
        normalized.poiIndex != null ||
        normalized.yawPathMode ||
        normalized.yawBase,
      );
      if (!hasValue) {
        return {
          ...entry,
          heading: undefined,
          orbitAutoHeading: entry.orbitAutoHeading ? undefined : entry.orbitAutoHeading,
        };
      }
      return {
        ...entry,
        heading: normalized,
        orbitAutoHeading: false,
      };
    });
  }, [updatePlanEntryById]);

  const updatePlanEntryGimbalHeading = React.useCallback((id: string, gimbal: WaypointGimbalHeadingConfig | null) => {
    updatePlanEntryById(id, (entry) => {
      if (!gimbal) {
        return { ...entry, gimbalHeading: undefined };
      }
      const normalized: WaypointGimbalHeadingConfig = { ...gimbal };
      const hasValue = Boolean(
        normalized.mode ||
        normalized.pitch != null ||
        normalized.yaw != null,
      );
      if (!hasValue) {
        return { ...entry, gimbalHeading: undefined };
      }
      return { ...entry, gimbalHeading: normalized };
    });
  }, [updatePlanEntryById]);

  const updatePlanEntryPoi = React.useCallback((id: string, poi: PoiTarget | null) => {
    updatePlanEntryById(id, (entry) => {
      if (!poi) {
        return {
          ...entry,
          poi: undefined,
          orbitAutoHeading: entry.orbitAutoHeading ? undefined : entry.orbitAutoHeading,
        };
      }
      if (
        !Number.isFinite(poi.latitude) ||
        !Number.isFinite(poi.longitude)
      ) {
        return {
          ...entry,
          poi: undefined,
          orbitAutoHeading: entry.orbitAutoHeading ? undefined : entry.orbitAutoHeading,
        };
      }
      return {
        ...entry,
        poi: { ...poi },
        orbitAutoHeading: false,
      };
    });
  }, [updatePlanEntryById]);

  const updatePlanEntryGimbalStrategy = React.useCallback((id: string, strategy: string | null) => {
    updatePlanEntryById(id, (entry) => ({
      ...entry,
      gimbalStrategy: strategy && strategy.trim() !== '' ? strategy : undefined,
    }));
  }, [updatePlanEntryById]);

  const updatePlanEntryAltitudeReference = React.useCallback((id: string, reference: AltitudeReferenceMode | null) => {
    updatePlanEntryById(id, (entry) => ({
      ...entry,
      altitudeReference: reference && reference !== 'unknown' ? reference : undefined,
    }));
  }, [updatePlanEntryById]);

  const updatePlanEntryActionGroups = React.useCallback((
    id: string,
    updater: (groups: WaypointActionGroup[]) => WaypointActionGroup[],
  ) => {
    updatePlanEntryById(id, (entry) => {
      const current = cloneActionGroups(entry.actionGroups) ?? [];
      const nextGroups = updater(current);
      return {
        ...entry,
        actionGroups: nextGroups.length ? nextGroups : undefined,
      };
    });
  }, [cloneActionGroups, updatePlanEntryById]);

  const addActionGroupToEntry = React.useCallback((id: string) => {
    updatePlanEntryActionGroups(id, (groups) => {
      const nextGroup: WaypointActionGroup = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        triggerType: 'reach_point',
        mode: 'sequential',
        actions: [],
      };
      return [...groups, nextGroup];
    });
  }, [updatePlanEntryActionGroups]);

  const removeActionGroupFromEntry = React.useCallback((id: string, index: number, groupKey?: string | number) => {
    const prefix = `${id}:${groupKey ?? index}:`;
    setActionParamDrafts((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (key.startsWith(prefix)) {
          changed = true;
          return;
        }
        next[key] = value;
      });
      return changed ? next : prev;
    });
    setActionParamErrors((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (key.startsWith(prefix)) {
          changed = true;
          return;
        }
        next[key] = value;
      });
      return changed ? next : prev;
    });
    updatePlanEntryActionGroups(id, (groups) => groups.filter((_, idx) => idx !== index));
  }, [setActionParamDrafts, setActionParamErrors, updatePlanEntryActionGroups]);

  const updateActionGroupMeta = React.useCallback((
    id: string,
    index: number,
    updates: Partial<Omit<WaypointActionGroup, 'actions'>>,
  ) => {
    updatePlanEntryActionGroups(id, (groups) => groups.map((group, idx) => (
      idx === index
        ? {
            ...group,
            ...updates,
          }
        : group
    )));
  }, [updatePlanEntryActionGroups]);

  const addActionToGroup = React.useCallback((id: string, groupIndex: number) => {
    updatePlanEntryActionGroups(id, (groups) => groups.map((group, idx) => {
      if (idx !== groupIndex) return group;
      const nextActions = [...group.actions, { func: 'gimbalRotate', params: { pitch: 0 } }];
      return {
        ...group,
        actions: nextActions,
      };
    }));
  }, [updatePlanEntryActionGroups]);

  const removeActionFromGroup = React.useCallback((id: string, groupIndex: number, actionIndex: number, groupKey?: string | number) => {
    const key = `${id}:${groupKey ?? groupIndex}:${actionIndex}`;
    setActionParamDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setActionParamErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    updatePlanEntryActionGroups(id, (groups) => groups.map((group, idx) => {
      if (idx !== groupIndex) return group;
      const nextActions = group.actions.filter((_, actionIdx) => actionIdx !== actionIndex);
      return {
        ...group,
        actions: nextActions,
      };
    }));
  }, [setActionParamDrafts, setActionParamErrors, updatePlanEntryActionGroups]);

  const updateActionInGroup = React.useCallback((
    id: string,
    groupIndex: number,
    actionIndex: number,
    updates: Partial<WaypointActionConfig>,
    paramsUpdater?: (prevParams: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    updatePlanEntryActionGroups(id, (groups) => groups.map((group, idx) => {
      if (idx !== groupIndex) return group;
      const nextActions = group.actions.map((action, idxAction) => {
        if (idxAction !== actionIndex) return action;
        const baseParams = updates.params ?? (action.params ? { ...action.params } : undefined);
        const updatedParams = paramsUpdater
          ? paramsUpdater(baseParams ?? {})
          : baseParams;
        const cleanedUpdates = { ...updates };
        delete (cleanedUpdates as any).params;
        const normalizedParams = updatedParams && Object.keys(updatedParams).length > 0 ? updatedParams : undefined;
        return {
          ...action,
          ...cleanedUpdates,
          ...(normalizedParams ? { params: normalizedParams } : {}),
        };
      });
      return {
        ...group,
        actions: nextActions,
      };
    }));
  }, [updatePlanEntryActionGroups]);

  const stageManualTarget = React.useCallback((next: ManualTargetState, context: Record<string, any>, message: string) => {
    (async () => {
      let resolvedAltitude = typeof next.altitude === 'number' ? next.altitude : null;
      if (resolvedAltitude == null && typeof next.latitude === 'number' && typeof next.longitude === 'number') {
        resolvedAltitude = await resolveDefaultAltitudeForLocation(next.latitude, next.longitude);
      }
      if (resolvedAltitude == null) {
        resolvedAltitude = computeDefaultTargetAltitude();
      }

      setManualTarget({
        latitude: next.latitude,
        longitude: next.longitude,
        altitude: resolvedAltitude,
        source: next.source,
      });
      setPlacingTarget(false);
      setSimPreview(null);
      appendLog('Target staged', context, 'manual');
      setStatusMessage(message);
    })();
  }, [appendLog, computeDefaultTargetAltitude, resolveDefaultAltitudeForLocation]);

  React.useEffect(() => {
    const unsubscribeAdd = missionPlannerStore.onAddWaypointRequest((request) => {
      (async () => {
      const { latitude, longitude } = request;
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return;
      }
      const clampedLat = clampLat(latitude);
      const clampedLon = clampLon(longitude);
      const defaultAltitudeForWaypoint = computeDefaultTargetAltitude({ latitude: clampedLat, longitude: clampedLon });
      const altitudeFallback = typeof manualTarget.altitude === 'number'
        ? manualTarget.altitude
        : telemetry?.location?.altitude ?? null;
      let altitudeCandidate = typeof request.altitude === 'number'
        ? request.altitude
        : (defaultAltitudeForWaypoint ?? altitudeFallback ?? 0);

      if (typeof request.altitude !== 'number' && executeHeightMode === 'absolute_wgs84') {
        const resolved = await resolveDefaultAltitudeForLocation(clampedLat, clampedLon, altitudeCandidate);
        if (typeof resolved === 'number' && Number.isFinite(resolved)) {
          altitudeCandidate = resolved;
        }
      }

      const takeoffAslLocal = resolveTakeoffAltitude(telemetry);
      const altitudeReference = request.altitudeReference
        ? request.altitudeReference
        : altitudeReferenceForExecuteMode(executeHeightMode);

      const relativeAltitude = altitudeReference === 'relative_to_takeoff'
        ? (typeof altitudeCandidate === 'number' && takeoffAslLocal != null
          ? altitudeCandidate - takeoffAslLocal
          : altitudeCandidate)
        : altitudeCandidate;

      if (request.kind === 'orbit') {
        missionPlannerStore.setPoiTarget({
          latitude: clampedLat,
          longitude: clampedLon,
          altitude: altitudeReference === 'relative_to_takeoff'
            ? (typeof altitudeCandidate === 'number' && takeoffAslLocal != null
              ? altitudeCandidate
              : altitudeCandidate)
            : altitudeCandidate,
        });
        appendLog('POI target updated (map)', {
          latitude: clampedLat,
          longitude: clampedLon,
          altitude: altitudeCandidate,
          source: request.source ?? 'map',
        }, 'manual');
        setStatusMessage(`POI set from map ${clampedLat.toFixed(6)}, ${clampedLon.toFixed(6)}`);
        if (manualTarget.latitude == null || manualTarget.longitude == null) {
          stageManualTarget(
            {
              latitude: clampedLat,
              longitude: clampedLon,
              altitude: altitudeCandidate,
              source: 'map',
            },
            { source: 'map', latitude: clampedLat, longitude: clampedLon },
            `Map target set at ${clampedLat.toFixed(6)}, ${clampedLon.toFixed(6)}`,
          );
        }
        return;
      }

      const entry: PlannedMissionEntry = {
        id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'waypoint',
        latitude: clampedLat,
        longitude: clampedLon,
        altitude: altitudeReference === 'relative_to_takeoff'
          ? relativeAltitude
          : altitudeCandidate,
      };
      if (request.turn) {
        entry.turn = { ...request.turn };
      }
      if (request.heading) {
        entry.heading = { ...request.heading };
      }
      if (request.gimbalHeading) {
        entry.gimbalHeading = { ...request.gimbalHeading };
      }
      if (request.poi) {
        entry.poi = { ...request.poi };
      }
      if (request.gimbalStrategy) {
        entry.gimbalStrategy = request.gimbalStrategy;
      }
      if (request.actionGroups) {
        entry.actionGroups = request.actionGroups.map((group) => ({
          ...group,
          actions: group.actions.map((action) => ({
            ...action,
            params: action.params ? { ...action.params } : undefined,
          })),
        }));
      }
      entry.altitudeReference = altitudeReference;
      updateMissionPlan((prev) => [...prev, entry]);
      appendLog('Plan waypoint added (map)', entry, 'manual');
      setStatusMessage('Waypoint added from map.');
      })();
    });

    const unsubscribeStage = missionPlannerStore.onStageTargetRequest((request) => {
      const { latitude, longitude } = request;
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return;
      }
      const clampedLat = clampLat(latitude);
      const clampedLon = clampLon(longitude);
      const next: ManualTargetState = {
        latitude: clampedLat,
        longitude: clampedLon,
        altitude: typeof request.altitude === 'number'
          ? request.altitude
          : manualTarget.altitude ?? null,
        source: request.source ?? 'map',
      };
      stageManualTarget(
        next,
        { source: 'map', latitude: clampedLat, longitude: clampedLon },
        `Map target set at ${clampedLat.toFixed(6)}, ${clampedLon.toFixed(6)}`,
      );
    });

    return () => {
      unsubscribeAdd();
      unsubscribeStage();
    };
  }, [
    appendLog,
    manualTarget.altitude,
    stageManualTarget,
    computeDefaultTargetAltitude,
    executeHeightMode,
    resolveDefaultAltitudeForLocation,
    telemetry?.altitude,
    telemetry?.location?.altitude,
    setStatusMessage,
  ]);

  const handleLoadKmzMission = React.useCallback(async () => {
    try {
      if (!window?.electronAPI?.pickKmzFile) {
        setStatusMessage('KMZ picker unavailable in this build');
        return;
      }

      const selection = await window.electronAPI.pickKmzFile();
      if (!selection) {
        setStatusMessage('KMZ selection cancelled');
        return;
      }

      if (selection.error) {
        setStatusMessage(`KMZ selection failed: ${selection.error}`);
        return;
      }

      if (!selection.base64 || !selection.name) {
        setStatusMessage('Selected KMZ is missing content');
        return;
      }

      const convertMetadataEntry = (raw: any): PlannedMissionEntry => {
        const actions = Array.isArray(raw.actions)
          ? raw.actions.map((action: any) => ({ ...action }))
          : [];
        const actionGroups = Array.isArray(raw.actionGroups)
          ? raw.actionGroups.map((group: any) => ({
              ...group,
              actions: Array.isArray(group.actions)
                ? group.actions.map((action: any) => ({
                    ...action,
                    params: action.params ? { ...action.params } : undefined,
                  }))
                : [],
            }))
          : [];
        const entry: PlannedMissionEntry = {
          id: typeof raw.id === 'string' ? raw.id : '',
          kind: raw.kind ?? 'waypoint',
          latitude: Number(raw.latitude) || 0,
          longitude: Number(raw.longitude) || 0,
          altitude: typeof raw.altitude === 'number' ? raw.altitude : null,
          radius: typeof raw.radius === 'number' ? raw.radius : undefined,
          turns: typeof raw.turns === 'number' ? raw.turns : undefined,
          actions: actions.length ? actions : undefined,
          turn: raw.turn ? { ...raw.turn } : undefined,
          heading: raw.heading
            ? {
                ...raw.heading,
                poi: raw.heading.poi ? { ...raw.heading.poi } : undefined,
              }
            : undefined,
          gimbalHeading: raw.gimbalHeading ? { ...raw.gimbalHeading } : undefined,
          poi: raw.poi ? { ...raw.poi } : undefined,
          gimbalStrategy: typeof raw.gimbalStrategy === 'string' ? raw.gimbalStrategy : undefined,
          actionGroups: actionGroups.length ? actionGroups : undefined,
          altitudeReference: raw.altitudeReference ?? undefined,
        };
        entry.latitude = clampLat(entry.latitude);
        entry.longitude = clampLon(entry.longitude);
        return entry;
      };

      const mapExecuteHeightMode = (value?: string | null): AltitudeReferenceMode | undefined => {
        if (!value) return undefined;
        const normalized = value.toLowerCase();
        if (normalized.includes('relative')) {
          return 'relative_to_takeoff';
        }
        if (normalized.includes('egm96')) {
          return 'egm96';
        }
        if (normalized.includes('absolute')) {
          return 'absolute_wgs84';
        }
        return undefined;
      };

      type ParsedWaypoint = {
        latitude: number;
        longitude: number;
        relativeHeight?: number;
        turn?: WaypointTurnConfig | null;
        heading?: WaypointHeadingConfig | null;
        gimbalHeading?: WaypointGimbalHeadingConfig | null;
        actionGroups?: WaypointActionGroup[];
        actions?: WaypointAction[];
        poi?: PoiTarget | null;
        gimbalStrategy?: string | null;
      };

      const parseKmzWaypoints = async (base64: string) => {
        const binary = atob(base64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          data[i] = binary.charCodeAt(i);
        }
        const zip = await JSZip.loadAsync(data);

        const metadataEntryName = Object.keys(zip.files).find((name) => /mission-metadata\.json$/i.test(name));
        if (metadataEntryName) {
          try {
            const metadataText = await zip.file(metadataEntryName)!.async('string');
            const metadata = JSON.parse(metadataText);
            if (metadata && Array.isArray(metadata.plan)) {
              const metadataPlan = metadata.plan.map((item: any) => convertMetadataEntry(item));
              return {
                metadataPlan,
                waypoints: [] as ParsedWaypoint[],
                finishAction: typeof metadata.finish_action === 'string' ? metadata.finish_action : '',
                pathMode: typeof metadata.path_mode === 'string' ? metadata.path_mode : undefined,
                maxSpeed: typeof metadata.max_speed === 'number' ? metadata.max_speed : undefined,
                securityHeight: typeof metadata.security_takeoff_height === 'number' ? metadata.security_takeoff_height : undefined,
                altitudeReference: mapExecuteHeightMode(metadata.execute_height_mode ?? metadata.altitude_reference),
              };
            }
          } catch (error) {
            console.warn('KMZ metadata parse failed', error);
          }
        }

        const waylineEntry = Object.keys(zip.files).find((name) => /waylines\.wpml$/i.test(name));
        if (!waylineEntry) {
          throw new Error('No waylines.wpml found in KMZ');
        }
        const xmlString = await zip.file(waylineEntry)!.async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, 'text/xml');
        const ns = 'http://www.dji.com/wpmz/1.0.6';

        const findChild = (parent: Element | null, localName: string): Element | null => {
          if (!parent) return null;
          return Array.from(parent.children).find((child) => child.localName === localName) ?? null;
        };

        const missionConfig = doc.getElementsByTagNameNS(ns, 'missionConfig')?.[0] ?? null;
        const finishAction = findChild(missionConfig, 'finishAction')?.textContent?.trim().toLowerCase() ?? '';
        const globalSpeedText = findChild(missionConfig, 'globalTransitionalSpeed')?.textContent
          ?? findChild(missionConfig, 'globalSpeed')?.textContent
          ?? '';
        const securityHeightText = findChild(missionConfig, 'takeOffSecurityHeight')?.textContent ?? '';

        const folder = doc.getElementsByTagName('Folder')?.[0] ?? null;
        const executeHeightMode = findChild(folder, 'executeHeightMode')?.textContent ?? undefined;

        const placemarks = folder
          ? Array.from(folder.getElementsByTagName('Placemark'))
          : Array.from(doc.getElementsByTagName('Placemark'));

        const parseNumeric = (value?: string | null) => {
          if (!value) return NaN;
          const numeric = parseFloat(value);
          return Number.isFinite(numeric) ? numeric : NaN;
        };

        const parsePoi = (value?: string | null): PoiTarget | null => {
          if (!value) return null;
          const parts = value.split(',');
          if (parts.length < 2) return null;
          const lat = parseNumeric(parts[0]);
          const lon = parseNumeric(parts[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          const alt = parseNumeric(parts[2] ?? '');
          return {
            latitude: clampLat(lat),
            longitude: clampLon(lon),
            altitude: Number.isFinite(alt) ? alt : undefined,
          };
        };

        const parseActionGroups = (root: Element): WaypointActionGroup[] => {
          const groupNodes = Array.from(root.getElementsByTagNameNS(ns, 'actionGroup'));
          return groupNodes.map((groupNode, groupIndex) => {
            const actionNodes = Array.from(groupNode.getElementsByTagNameNS(ns, 'action'));
            const actions: WaypointActionConfig[] = actionNodes.map((actionNode, actionIndex) => {
              const func = findChild(actionNode, 'actionActuatorFunc')?.textContent ?? '';
              const idText = findChild(actionNode, 'actionId')?.textContent ?? '';
              const paramsNode = findChild(actionNode, 'actionActuatorFuncParam');
              const params: Record<string, unknown> = {};
              if (paramsNode) {
                Array.from(paramsNode.children).forEach((child) => {
                  const key = sanitizeWpmlKey(child.localName ?? child.nodeName);
                  const valueText = child.textContent ?? '';
                  const numeric = parseNumeric(valueText);
                  params[key] = Number.isFinite(numeric) ? numeric : valueText;
                });
              }
              return {
                id: Number.isFinite(parseInt(idText, 10)) ? parseInt(idText, 10) : actionIndex,
                func,
                params,
              };
            });
            const triggerType = findChild(groupNode, 'actionTriggerType')?.textContent
              ?? findChild(findChild(groupNode, 'actionTrigger'), 'actionTriggerType')?.textContent
              ?? undefined;
            const startIndexText = findChild(groupNode, 'actionGroupStartIndex')?.textContent ?? '';
            const endIndexText = findChild(groupNode, 'actionGroupEndIndex')?.textContent ?? '';
            const modeText = findChild(groupNode, 'actionGroupMode')?.textContent ?? '';
            return {
              id: Number.isFinite(parseInt(findChild(groupNode, 'actionGroupId')?.textContent ?? '', 10))
                ? parseInt(findChild(groupNode, 'actionGroupId')?.textContent ?? '', 10)
                : groupIndex,
              startIndex: Number.isFinite(parseInt(startIndexText, 10)) ? parseInt(startIndexText, 10) : undefined,
              endIndex: Number.isFinite(parseInt(endIndexText, 10)) ? parseInt(endIndexText, 10) : undefined,
              mode: modeText || undefined,
              triggerType: triggerType || undefined,
              actions,
            };
          });
        };

        const waypoints: ParsedWaypoint[] = [];
        let pathMode: 'straight' | 'curved' = 'straight';

        placemarks.forEach((placemark) => {
          const pointNode = findChild(placemark, 'Point');
          const coordinateText = pointNode ? findChild(pointNode, 'coordinates')?.textContent ?? '' : '';
          const coords = coordinateText.trim().split(',');
          const longitude = parseNumeric(coords[0]);
          const latitude = parseNumeric(coords[1]);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return;
          }

          const executeHeightText = findChild(placemark, 'executeHeight')?.textContent
            ?? placemark.getElementsByTagNameNS(ns, 'executeHeight')?.[0]?.textContent
            ?? '';
          const relativeHeight = parseNumeric(executeHeightText);

          const turnNode = findChild(placemark, 'waypointTurnParam');
          const turnModeText = turnNode ? findChild(turnNode, 'waypointTurnMode')?.textContent ?? '' : '';
          const turnDampingText = turnNode ? findChild(turnNode, 'waypointTurnDampingDist')?.textContent ?? '' : '';
          const useStraightText = findChild(placemark, 'useStraightLine')?.textContent ?? '';
          const useStraightLine = useStraightText === '1' ? true : useStraightText === '0' ? false : undefined;
          if (useStraightLine === false || (turnModeText && turnModeText.toLowerCase().includes('pass'))) {
            pathMode = 'curved';
          }

          const turn: WaypointTurnConfig | null = (turnModeText || turnDampingText || useStraightLine != null)
            ? {
                mode: turnModeText || undefined,
                damping: Number.isFinite(parseNumeric(turnDampingText)) ? parseNumeric(turnDampingText) : undefined,
                useStraightLine,
              }
            : null;

          const headingNode = findChild(placemark, 'waypointHeadingParam');
          const headingModeText = headingNode ? findChild(headingNode, 'waypointHeadingMode')?.textContent ?? '' : '';
          const headingAngleText = headingNode ? findChild(headingNode, 'waypointHeadingAngle')?.textContent ?? '' : '';
          const headingAngleEnableText = headingNode ? findChild(headingNode, 'waypointHeadingAngleEnable')?.textContent ?? '' : '';
          const headingPoiText = headingNode ? findChild(headingNode, 'waypointPoiPoint')?.textContent ?? '' : '';
          const headingPoiIndexText = headingNode ? findChild(headingNode, 'waypointHeadingPoiIndex')?.textContent ?? '' : '';
          const headingPathModeText = headingNode ? findChild(headingNode, 'waypointHeadingPathMode')?.textContent ?? '' : '';
          const headingBaseText = headingNode ? findChild(headingNode, 'waypointHeadingBase')?.textContent ?? '' : '';

          const heading: WaypointHeadingConfig | null = (headingModeText || headingAngleText || headingPoiText || headingPathModeText || headingBaseText)
            ? {
                mode: headingModeText || undefined,
                angle: Number.isFinite(parseNumeric(headingAngleText)) ? parseNumeric(headingAngleText) : undefined,
                angleEnable: headingAngleEnableText === '1' ? true : headingAngleEnableText === '0' ? false : undefined,
                poi: parsePoi(headingPoiText) ?? undefined,
                poiIndex: Number.isFinite(parseNumeric(headingPoiIndexText)) ? parseNumeric(headingPoiIndexText) : undefined,
                yawPathMode: headingPathModeText || undefined,
                yawBase: headingBaseText || undefined,
              }
            : null;

          const gimbalNode = findChild(placemark, 'waypointGimbalHeadingParam');
          const gimbalModeText = gimbalNode ? findChild(gimbalNode, 'waypointGimbalHeadingMode')?.textContent ?? '' : '';
          const gimbalPitchText = gimbalNode ? findChild(gimbalNode, 'waypointGimbalPitchAngle')?.textContent ?? '' : '';
          const gimbalYawText = gimbalNode ? findChild(gimbalNode, 'waypointGimbalYawAngle')?.textContent ?? '' : '';
          const gimbalHeading: WaypointGimbalHeadingConfig | null = (gimbalModeText || gimbalPitchText || gimbalYawText)
            ? {
                mode: gimbalModeText || undefined,
                pitch: Number.isFinite(parseNumeric(gimbalPitchText)) ? parseNumeric(gimbalPitchText) : undefined,
                yaw: Number.isFinite(parseNumeric(gimbalYawText)) ? parseNumeric(gimbalYawText) : undefined,
              }
            : null;

          const actionGroups = parseActionGroups(placemark);

          waypoints.push({
            latitude,
            longitude,
            relativeHeight: Number.isFinite(relativeHeight) ? relativeHeight : undefined,
            turn,
            heading,
            gimbalHeading,
            actionGroups: actionGroups.length ? actionGroups : undefined,
            actions: [],
            poi: heading?.poi ?? null,
          });
        });

        return {
          metadataPlan: undefined,
          waypoints,
          finishAction,
          pathMode,
          maxSpeed: Number.isFinite(parseNumeric(globalSpeedText)) ? parseNumeric(globalSpeedText) : undefined,
          securityHeight: Number.isFinite(parseNumeric(securityHeightText)) ? parseNumeric(securityHeightText) : undefined,
          altitudeReference: mapExecuteHeightMode(executeHeightMode),
        };
      };
      const { metadataPlan, waypoints, finishAction, pathMode, maxSpeed: parsedMaxSpeed, securityHeight: parsedSecurityHeight, altitudeReference } = await parseKmzWaypoints(selection.base64);

      const sizeBytes = Math.floor((selection.base64.length * 3) / 4);
      const timestamp = Date.now();

      const normalizedPathMode = typeof pathMode === 'string' ? pathMode.toLowerCase() : undefined;

      if (metadataPlan && metadataPlan.length) {
        const planWithIds = metadataPlan.map((entry, index) => ({
          ...entry,
          id: entry.id && entry.id.length ? entry.id : `kmz-metadata-${timestamp}-${index}`,
          actions: entry.actions && entry.actions.length
            ? entry.actions.map((action) => ({ ...action }))
            : undefined,
          turn: entry.turn ? { ...entry.turn } : undefined,
          heading: entry.heading
            ? {
                ...entry.heading,
                poi: entry.heading.poi ? { ...entry.heading.poi } : undefined,
              }
            : undefined,
          gimbalHeading: entry.gimbalHeading ? { ...entry.gimbalHeading } : undefined,
          poi: entry.poi ? { ...entry.poi } : undefined,
          gimbalStrategy: entry.gimbalStrategy ?? undefined,
          actionGroups: entry.actionGroups && entry.actionGroups.length
            ? entry.actionGroups.map((group) => ({
                ...group,
                actions: group.actions.map((action) => ({
                  ...action,
                  params: action.params ? { ...action.params } : undefined,
                })),
              }))
            : undefined,
        }));
        const expandedMap: Record<string, boolean> = {};
        planWithIds.forEach((entry) => {
          expandedMap[entry.id] = true;
        });
        if (normalizedPathMode === 'curved') {
          setFlightPathMode('curved');
        } else if (normalizedPathMode === 'straight') {
          setFlightPathMode('straight');
        }
        if (typeof parsedMaxSpeed === 'number' && Number.isFinite(parsedMaxSpeed)) {
          setMaxSpeed(parsedMaxSpeed);
        }
        if (typeof parsedSecurityHeight === 'number' && Number.isFinite(parsedSecurityHeight)) {
          setSecurityTakeoffHeight(parsedSecurityHeight);
        }
        const metadata = {
          name: selection.name,
          path: selection.path,
          size_bytes: sizeBytes,
          selected_at: timestamp,
          waypoint_count: planWithIds.length,
          finish_action: finishAction,
          path_mode: normalizedPathMode,
          max_speed: parsedMaxSpeed ?? null,
          security_takeoff_height: parsedSecurityHeight ?? null,
        };
        appendLog('KMZ plan imported', metadata, 'kmz');
        setLastLoadedKmz({
          name: selection.name,
          path: selection.path,
          sizeBytes,
          timestamp,
        });
        setSimPreview(null);
        setExpandedEntries(expandedMap);
        replaceMissionPlan(planWithIds);
        setStatusMessage(`Loaded KMZ into mission plan (${planWithIds.length} entries). Review and simulate before execution.`);
        return;
      }

      if (!waypoints.length) {
        setStatusMessage('Loaded KMZ does not contain any waypoints.');
        return;
      }

      const baseAltitude = resolveTakeoffAltitude()
        ?? telemetry?.location?.altitude
        ?? telemetry?.altitude
        ?? 0;

      const resolvedPlan: PlannedMissionEntry[] = waypoints.map((wp, index) => {
        const altitudeAbs = wp.relativeHeight != null
          ? baseAltitude + wp.relativeHeight
          : defaultTargetAltitudePreview ?? baseAltitude;

        const actions: WaypointAction[] = [];
        if (wp.actions && wp.actions.length) {
          wp.actions.forEach((action) => actions.push({ ...action }));
        }
        const gimbalPitchValue = wp.gimbalHeading?.pitch;
        if (typeof gimbalPitchValue === 'number' && Number.isFinite(gimbalPitchValue)) {
          actions.push({
            type: 'gimbal_pitch',
            pitch: Math.max(GIMBAL_PITCH_MIN, Math.min(GIMBAL_PITCH_MAX, gimbalPitchValue)),
            timing: 'before',
          });
        }

        const actionGroups = wp.actionGroups
          ? wp.actionGroups.map((group) => ({
              ...group,
              actions: group.actions.map((action) => ({
                ...action,
                params: action.params ? { ...action.params } : undefined,
              })),
            }))
          : undefined;

        return {
          id: `kmz-${timestamp}-${index}`,
          kind: 'waypoint',
          latitude: clampLat(wp.latitude),
          longitude: clampLon(wp.longitude),
          altitude: altitudeAbs,
          actions: actions.length ? actions : undefined,
          turn: wp.turn ? { ...wp.turn } : undefined,
          heading: wp.heading
            ? {
                ...wp.heading,
                poi: wp.heading.poi ? { ...wp.heading.poi } : undefined,
              }
            : undefined,
          gimbalHeading: wp.gimbalHeading ? { ...wp.gimbalHeading } : undefined,
          poi: wp.poi ? { ...wp.poi } : undefined,
          gimbalStrategy: wp.gimbalStrategy ?? undefined,
          actionGroups,
          altitudeReference: altitudeReference ?? undefined,
        };
      });

      if (normalizedPathMode === 'curved') {
        setFlightPathMode('curved');
      } else if (normalizedPathMode === 'straight') {
        setFlightPathMode('straight');
      }
      if (typeof parsedMaxSpeed === 'number' && Number.isFinite(parsedMaxSpeed)) {
        setMaxSpeed(parsedMaxSpeed);
      }
      if (typeof parsedSecurityHeight === 'number' && Number.isFinite(parsedSecurityHeight)) {
        setSecurityTakeoffHeight(parsedSecurityHeight);
      }

      const augmentedPlan = [...resolvedPlan];
      const finalWaypoint = resolvedPlan[resolvedPlan.length - 1];
      if (finishAction === 'gohome') {
        const rthLat = telemetry?.home_location?.latitude ?? finalWaypoint.latitude;
        const rthLon = telemetry?.home_location?.longitude ?? finalWaypoint.longitude;
        augmentedPlan.push({
          id: `kmz-rth-${timestamp}`,
          kind: 'return_home',
          latitude: clampLat(rthLat),
          longitude: clampLon(rthLon),
          altitude: defaultTargetAltitudePreview ?? baseAltitude,
        });
      } else if (finishAction === 'autoland') {
        const landingLat = telemetry?.home_location?.latitude ?? telemetry?.location?.latitude ?? finalWaypoint.latitude;
        const landingLon = telemetry?.home_location?.longitude ?? telemetry?.location?.longitude ?? finalWaypoint.longitude;
        augmentedPlan.push({
          id: `kmz-land-${timestamp}`,
          kind: 'land',
          latitude: clampLat(landingLat),
          longitude: clampLon(landingLon),
          altitude: resolveTakeoffAltitude() ?? baseAltitude,
        });
      }

      const metadata = {
        name: selection.name,
        path: selection.path,
        size_bytes: sizeBytes,
        selected_at: timestamp,
        waypoint_count: augmentedPlan.length,
        finish_action: finishAction,
        path_mode: normalizedPathMode,
        max_speed: parsedMaxSpeed ?? null,
        security_takeoff_height: parsedSecurityHeight ?? null,
      };

      appendLog('KMZ plan imported', metadata, 'kmz');
      setLastLoadedKmz({
        name: selection.name,
        path: selection.path,
        sizeBytes,
        timestamp,
      });
      const expandedMap: Record<string, boolean> = {};
      augmentedPlan.forEach((entry) => {
        expandedMap[entry.id] = true;
      });
      setExpandedEntries(expandedMap);

      setSimPreview(null);
      replaceMissionPlan(augmentedPlan);
      setStatusMessage(`Loaded KMZ into mission plan (${augmentedPlan.length} entries). Review and simulate before execution.`);
    } catch (error) {
      console.error('KMZ load failed', error);
      setStatusMessage(error instanceof Error ? error.message : 'Failed to load KMZ');
    }
  }, [appendLog, defaultTargetAltitudePreview, resolveTakeoffAltitude, setFlightPathMode, setMaxSpeed, setSecurityTakeoffHeight, telemetry?.altitude, telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.location?.altitude, telemetry?.location?.latitude, telemetry?.location?.longitude]);

  const handleSaveKmzMission = React.useCallback(async () => {
    if (!missionPlan.length) {
      setStatusMessage('Mission plan is empty — nothing to export.');
      return;
    }

    const primaryWaypoints = missionPlan.filter((entry) => entry.kind === 'waypoint' || entry.kind === 'orbit');
    if (!primaryWaypoints.length) {
      setStatusMessage('Add at least one waypoint before exporting.');
      return;
    }

    const baseAltitude = resolveTakeoffAltitude()
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? 0;

    const finishAction = missionPlan.some((entry) => entry.kind === 'land')
      ? 'autoLand'
      : missionPlan.some((entry) => entry.kind === 'return_home')
        ? 'goHome'
        : 'noAction';

    const globalSpeed = Math.max(1, Math.round(Number.isFinite(maxSpeed) ? maxSpeed : 5));
    const securityHeight = Math.max(0, Math.round(Number.isFinite(securityTakeoffHeight) ? securityTakeoffHeight : 20));

    const curvedPath = flightPathMode === 'curved';
    const metadataPlan = missionPlan.map((entry, index) => ({
      id: entry.id ?? `plan-${index}`,
      kind: entry.kind,
      latitude: entry.latitude,
      longitude: entry.longitude,
      altitude: entry.altitude ?? null,
      radius: entry.radius ?? null,
      turns: entry.turns ?? null,
      actions: entry.actions ? entry.actions.map((action) => ({ ...action })) : [],
      turn: entry.turn ? { ...entry.turn } : null,
      heading: entry.heading
        ? {
            ...entry.heading,
            poi: entry.heading.poi ? { ...entry.heading.poi } : undefined,
          }
        : null,
      gimbalHeading: entry.gimbalHeading ? { ...entry.gimbalHeading } : null,
      poi: entry.poi ? { ...entry.poi } : null,
      gimbalStrategy: entry.gimbalStrategy ?? null,
      actionGroups: entry.actionGroups
        ? entry.actionGroups.map((group) => ({
            ...group,
            actions: group.actions.map((action) => ({
              ...action,
              params: action.params ? { ...action.params } : undefined,
            })),
          }))
        : [],
      altitudeReference: entry.altitudeReference ?? null,
    }));

    const formatParamValue = (value: unknown): string => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value.toString();
      }
      if (typeof value === 'boolean') {
        return value ? '1' : '0';
      }
      return `${value ?? ''}`;
    };

    const buildActionGroupsXml = (groups?: WaypointActionGroup[]): string => {
      if (!groups || !groups.length) {
        return '';
      }
      const xmlLines: string[] = [];
      groups.forEach((group, groupIndex) => {
        const startIndex = Number.isFinite(group.startIndex) ? group.startIndex : groupIndex;
        const endIndex = Number.isFinite(group.endIndex) ? group.endIndex : groupIndex;
        const triggerType = group.triggerType ?? 'reachPoint';
        const groupMode = group.mode ?? 'sequence';
        xmlLines.push('        <wpml:actionGroup>');
        xmlLines.push(`          <wpml:actionGroupId>${group.id ?? groupIndex}</wpml:actionGroupId>`);
        xmlLines.push(`          <wpml:actionGroupStartIndex>${startIndex}</wpml:actionGroupStartIndex>`);
        xmlLines.push(`          <wpml:actionGroupEndIndex>${endIndex}</wpml:actionGroupEndIndex>`);
        xmlLines.push(`          <wpml:actionGroupMode>${groupMode}</wpml:actionGroupMode>`);
        xmlLines.push('          <wpml:actionTrigger>');
        xmlLines.push(`            <wpml:actionTriggerType>${triggerType}</wpml:actionTriggerType>`);
        xmlLines.push('          </wpml:actionTrigger>');
        group.actions.forEach((action, actionIndex) => {
          xmlLines.push('          <wpml:action>');
          xmlLines.push(`            <wpml:actionId>${action.id ?? actionIndex}</wpml:actionId>`);
          xmlLines.push(`            <wpml:actionActuatorFunc>${action.func}</wpml:actionActuatorFunc>`);
          if (action.params && Object.keys(action.params).length > 0) {
            xmlLines.push('            <wpml:actionActuatorFuncParam>');
            Object.entries(action.params).forEach(([key, value]) => {
              const tag = sanitizeWpmlKey(key);
              xmlLines.push(`              <wpml:${tag}>${formatParamValue(value)}</wpml:${tag}>`);
            });
            xmlLines.push('            </wpml:actionActuatorFuncParam>');
          }
          xmlLines.push('          </wpml:action>');
        });
        xmlLines.push('        </wpml:actionGroup>');
      });
      return xmlLines.join('\n');

    };

    const wpmlWaypoints = primaryWaypoints.map((entry, index) => {
      const latitude = clampLat(entry.latitude);
      const longitude = clampLon(entry.longitude);
      const altitude = typeof entry.altitude === 'number' ? entry.altitude : (defaultTargetAltitudePreview ?? baseAltitude);
      const executeHeightValue = executeHeightMode === 'absolute_wgs84'
        ? (altitude ?? baseAltitude)
        : (altitude ?? baseAltitude) - baseAltitude;
      const isFirst = index === 0;
      const isLast = index === primaryWaypoints.length - 1;
      const defaultTurnMode = (!curvedPath || primaryWaypoints.length <= 1)
        ? 'toPointAndStopWithDiscontinuityCurvature'
        : (isFirst || isLast)
          ? 'toPointAndStopWithDiscontinuityCurvature'
          : 'toPointAndPassWithContinuityCurvature';
      const defaultDamping = (!curvedPath || primaryWaypoints.length <= 1 || isFirst || isLast)
        ? 0
        : CURVED_TURN_DAMPING_DISTANCE;

      const turnConfig = entry.turn ?? null;
      const turnMode = turnConfig?.mode && turnConfig.mode !== 'auto'
        ? turnConfig.mode
        : defaultTurnMode;
      const turnDamping = typeof turnConfig?.damping === 'number' && Number.isFinite(turnConfig.damping)
        ? turnConfig.damping
        : defaultDamping;
      const useStraightLine = typeof turnConfig?.useStraightLine === 'boolean'
        ? turnConfig.useStraightLine
        : !curvedPath;

      const headingConfig = entry.heading ?? null;
      const headingMode = headingConfig?.mode ?? 'followWayline';
      const headingAngle = Number.isFinite(headingConfig?.angle ?? NaN) ? headingConfig!.angle! : 0;
      const headingAngleEnable = headingConfig?.angleEnable ? 1 : 0;
      const headingPoiTarget = headingConfig?.poi ?? entry.poi;
      const headingPoiString = headingPoiTarget && Number.isFinite(headingPoiTarget.latitude) && Number.isFinite(headingPoiTarget.longitude)
        ? `${headingPoiTarget.latitude.toFixed(6)},${headingPoiTarget.longitude.toFixed(6)},${(headingPoiTarget.altitude ?? 0).toFixed(6)}`
        : '0.000000,0.000000,0.000000';
      const headingPoiIndex = Number.isFinite(headingConfig?.poiIndex ?? NaN) ? headingConfig!.poiIndex! : 0;
      const headingPathMode = headingConfig?.yawPathMode ?? '';
      const headingYawBase = headingConfig?.yawBase ?? '';

      const gimbalHeading = entry.gimbalHeading ?? null;
      const gimbalAction = entry.actions?.find((action): action is Extract<WaypointAction, { type: 'gimbal_pitch' }> => action.type === 'gimbal_pitch');
      const gimbalPitchValue = Number.isFinite(gimbalHeading?.pitch ?? NaN)
        ? gimbalHeading!.pitch!
        : gimbalAction && typeof gimbalAction.pitch === 'number'
          ? Math.max(GIMBAL_PITCH_MIN, Math.min(GIMBAL_PITCH_MAX, gimbalAction.pitch))
          : 0;
      const gimbalYawValue = Number.isFinite(gimbalHeading?.yaw ?? NaN) ? gimbalHeading!.yaw! : 0;
      const gimbalMode = gimbalHeading?.mode ?? '';

      const headingLines: string[] = [
        '        <wpml:waypointHeadingParam>',
        `          <wpml:waypointHeadingMode>${headingMode}</wpml:waypointHeadingMode>`,
        `          <wpml:waypointHeadingAngle>${headingAngle.toFixed(2)}</wpml:waypointHeadingAngle>`,
        `          <wpml:waypointPoiPoint>${headingPoiString}</wpml:waypointPoiPoint>`,
        `          <wpml:waypointHeadingAngleEnable>${headingAngleEnable}</wpml:waypointHeadingAngleEnable>`,
        `          <wpml:waypointHeadingPoiIndex>${headingPoiIndex}</wpml:waypointHeadingPoiIndex>`,
      ];
      if (headingPathMode) {
        headingLines.push(`          <wpml:waypointHeadingPathMode>${headingPathMode}</wpml:waypointHeadingPathMode>`);
      }
      if (headingYawBase) {
        headingLines.push(`          <wpml:waypointHeadingBase>${headingYawBase}</wpml:waypointHeadingBase>`);
      }
      headingLines.push('        </wpml:waypointHeadingParam>');

      const gimbalHeadingLines: string[] = ['        <wpml:waypointGimbalHeadingParam>'];
      if (gimbalMode) {
        gimbalHeadingLines.push(`          <wpml:waypointGimbalHeadingMode>${gimbalMode}</wpml:waypointGimbalHeadingMode>`);
      }
      gimbalHeadingLines.push(`          <wpml:waypointGimbalPitchAngle>${gimbalPitchValue.toFixed(2)}</wpml:waypointGimbalPitchAngle>`);
      gimbalHeadingLines.push(`          <wpml:waypointGimbalYawAngle>${gimbalYawValue.toFixed(2)}</wpml:waypointGimbalYawAngle>`);
      gimbalHeadingLines.push('        </wpml:waypointGimbalHeadingParam>');

      const actionGroupsXml = buildActionGroupsXml(entry.actionGroups);

      return [
        '      <Placemark>',
        '        <Point>',
        '          <coordinates>',
        `            ${longitude},${latitude}`,
        '          </coordinates>',
        '        </Point>',
        `        <wpml:index>${index}</wpml:index>`,
        `        <wpml:executeHeight>${executeHeightValue.toFixed(3)}</wpml:executeHeight>`,
        `        <wpml:waypointSpeed>${globalSpeed}</wpml:waypointSpeed>`,
        `        <wpml:useStraightLine>${useStraightLine ? '1' : '0'}</wpml:useStraightLine>`,
        '        <wpml:waypointTurnParam>',
        `          <wpml:waypointTurnMode>${turnMode}</wpml:waypointTurnMode>`,
        `          <wpml:waypointTurnDampingDist>${(Number.isFinite(turnDamping) ? turnDamping : 0).toFixed(1)}</wpml:waypointTurnDampingDist>`,
        '        </wpml:waypointTurnParam>',
        ...headingLines,
        actionGroupsXml ? actionGroupsXml : null,
        ...gimbalHeadingLines,
        '      </Placemark>',
      ].filter(Boolean).join('\n');
    }).join('\n');



    const metadataPayload = {
      version: 1,
      exported_at: new Date().toISOString(),
      finish_action: finishAction,
      path_mode: flightPathMode,
      orbit_mode: orbitMode,
      max_speed: globalSpeed,
      security_takeoff_height: securityHeight,
      takeoff_altitude_asl: baseAltitude,
      execute_height_mode: executeHeightMode,
      altitude_reference: altitudeReferenceForExecuteMode(executeHeightMode),
      poi_target: sanitizePoiTarget(poiTarget),
      plan: metadataPlan,
    };

    const executeHeightModeTag = executeHeightMode === 'absolute_wgs84' ? 'WGS84' : 'relativeToStartPoint';

    const wpml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>${finishAction}</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${securityHeight}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${globalSpeed}</wpml:globalTransitionalSpeed>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>${executeHeightModeTag}</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:autoFlightSpeed>${globalSpeed}</wpml:autoFlightSpeed>
${wpmlWaypoints}
    </Folder>
  </Document>
</kml>`;

    const templateKmlWaypoints = primaryWaypoints.map((entry) => `${entry.longitude},${entry.latitude},${(entry.altitude ?? baseAltitude).toFixed(3)}`).join(' ');
    const templateKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <LineString>
        <coordinates>
          ${templateKmlWaypoints}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;

    const zip = new JSZip();
    const wpmzFolder = zip.folder('wpmz');
    (wpmzFolder ?? zip).file('waylines.wpml', wpml);
    (wpmzFolder ?? zip).file('template.kml', templateKml);
    (wpmzFolder ?? zip).file('mission-metadata.json', JSON.stringify(metadataPayload, null, 2));

    const blob = await zip.generateAsync({ type: 'blob' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `mission-plan-${timestamp}.kmz`;

    const electronApi = (window as any)?.electronAPI;
    if (electronApi && typeof electronApi.saveKmzFile === 'function') {
      const base64Data = await zip.generateAsync({ type: 'base64' });
      await electronApi.saveKmzFile({ name: fileName, base64: base64Data });
    } else {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }

    appendLog('KMZ plan exported', {
      name: fileName,
      waypoint_count: primaryWaypoints.length,
      finish_action: finishAction,
    }, 'kmz');
    setStatusMessage(`Mission plan exported to ${fileName}.`);
  }, [appendLog, defaultTargetAltitudePreview, executeHeightMode, maxSpeed, missionPlan, resolveTakeoffAltitude, securityTakeoffHeight, telemetry?.altitude, telemetry?.location?.altitude]);

  React.useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onBridgeData) {
      return;
    }

    const handler = (message: any) => {
      if (!message || message.type !== 'camera_laser_result') {
        return;
      }
      const payload = message.data ?? message;
      const result = payload?.data ?? payload;
      const waypoint = result?.waypoint;
      const lat = waypoint?.lat ?? waypoint?.latitude;
      const lon = waypoint?.lon ?? waypoint?.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return;
      }
      const altitude = typeof waypoint?.alt_m === 'number' ? waypoint.alt_m : undefined;
      const clampedLat = clampLat(lat);
      const clampedLon = clampLon(lon);
      setLastLaserFix({ latitude: clampedLat, longitude: clampedLon, altitude });
      setManualTarget((prev) => {
        if (
          prev.source === 'laser' &&
          prev.latitude === clampedLat &&
          prev.longitude === clampedLon &&
          ((prev.altitude ?? undefined) === altitude)
        ) {
          return prev;
        }
        return {
          latitude: clampedLat,
          longitude: clampedLon,
          altitude: typeof altitude === 'number' ? altitude : prev.altitude ?? null,
          source: 'laser',
        };
      });
      setPlacingTarget(false);
      setSimPreview(null);
      appendLog('Laser waypoint', { waypoint: result?.waypoint, raw: result }, 'laser');
      setStatusMessage(`Laser waypoint captured (${clampedLat.toFixed(6)}, ${clampedLon.toFixed(6)})`);
    };

    api.onBridgeData(handler);

    return () => {
      // shared listener; no removal to avoid breaking other consumers
    };
  }, [appendLog]);

  const updateManualCoordinate = React.useCallback((field: 'latitude' | 'longitude', raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setManualTarget((prev) => ({ ...prev, [field]: null, source: 'manual' }));
      setSimPreview(null);
      return;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      setStatusMessage(`Invalid ${field === 'latitude' ? 'latitude' : 'longitude'} value`);
      return;
    }
    const clamped = field === 'latitude' ? clampLat(numeric) : clampLon(numeric);
    setManualTarget((prev) => ({ ...prev, [field]: clamped, source: 'manual' }));
    setSimPreview(null);
  }, []);

  const updateManualAltitude = React.useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setManualTarget((prev) => ({ ...prev, altitude: null, source: 'manual' }));
      setSimPreview(null);
      return;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      setStatusMessage('Invalid altitude value');
      return;
    }
    setManualTarget((prev) => ({ ...prev, altitude: numeric, source: 'manual' }));
    setSimPreview(null);
  }, []);

  const handleClearManualTarget = React.useCallback(() => {
    setManualTarget({ latitude: null, longitude: null, altitude: null });
    setSimPreview(null);
    setPlacingTarget(false);
    setStatusMessage('Manual target cleared.');
  }, []);

  const handleUseCurrentLocation = React.useCallback(() => {
    if (!telemetry?.location) {
      setStatusMessage('Telemetry location unavailable');
      return;
    }
    const { latitude, longitude, altitude } = telemetry.location;
    const fallbackAltitude = altitude ?? computeDefaultTargetAltitude();
    setManualTarget({
      latitude,
      longitude,
      altitude: fallbackAltitude,
      source: 'manual',
    });
    setPlacingTarget(false);
    setSimPreview(null);
    setStatusMessage('Target snapped to aircraft position.');
  }, [computeDefaultTargetAltitude, telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.location?.altitude]);

  const handleUseLaserFix = React.useCallback(() => {
    if (!lastLaserFix) {
      setStatusMessage('No laser measurement captured yet. Trigger a measurement first.');
      return;
    }
    const fallbackAltitude = typeof lastLaserFix.altitude === 'number'
      ? lastLaserFix.altitude
      : computeDefaultTargetAltitude();
    setManualTarget({
      latitude: lastLaserFix.latitude,
      longitude: lastLaserFix.longitude,
      altitude: fallbackAltitude,
      source: 'laser',
    });
    setPlacingTarget(false);
    setSimPreview(null);
    setStatusMessage('Applied last laser measurement.');
  }, [computeDefaultTargetAltitude, lastLaserFix]);

  const handleExportMissionLog = React.useCallback(() => {
    if (!logEntries.length) {
      setStatusMessage('No mission entries to export.');
      return;
    }
    const blob = new Blob([JSON.stringify(logEntries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mission-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [logEntries]);

  const simulateMissionPlan = React.useCallback(() => {
    if (!telemetry || !telemetry.location) {
      setStatusMessage('Telemetry unavailable — cannot compute mission preview.');
      return;
    }

    const telemetrySnapshot = telemetry;
    const startLocation = telemetrySnapshot.location;
    if (!startLocation || !Number.isFinite(startLocation.latitude) || !Number.isFinite(startLocation.longitude)) {
      setStatusMessage('Telemetry missing aircraft location for simulation.');
      return;
    }

    const planEntries = missionPlan.length
      ? missionPlan
      : (activeTarget && activeTarget.latitude != null && activeTarget.longitude != null
        ? [{
            id: `single-${Date.now()}`,
            kind: 'waypoint' as MissionEntryKind,
            latitude: activeTarget.latitude,
            longitude: activeTarget.longitude,
            altitude: activeTarget.altitude ?? null,
          }]
        : []);

    if (planEntries.length === 0) {
      setStatusMessage('Add a waypoint to the mission plan before simulating.');
      return;
    }

    const takeoffAsl = resolveTakeoffAltitude(telemetrySnapshot);
    const currentAsl = telemetrySnapshot.location.altitude ?? (
      (takeoffAsl ?? 0) + (telemetrySnapshot.altitude_above_takeoff ?? 0)
    );
    const securityAlt = takeoffAsl != null ? takeoffAsl + securityTakeoffHeight : null;
    const homeLocation = telemetrySnapshot.home_location;
    const defaultAltitude = defaultTargetAltitudePreview ?? telemetrySnapshot.location.altitude ?? null;

    type SimPoint = {
      latitude: number;
      longitude: number;
      altitude: number | null;
      kind: MissionEntryKind;
    };

    const resolvedPlan: SimPoint[] = [];
    for (const entry of planEntries) {
      const kind = entry.kind ?? 'waypoint';
      let latitude = entry.latitude;
      let longitude = entry.longitude;
      if (kind === 'return_home' && homeLocation && Number.isFinite(homeLocation.latitude) && Number.isFinite(homeLocation.longitude)) {
        latitude = clampLat(homeLocation.latitude);
        longitude = clampLon(homeLocation.longitude);
      }

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        continue;
      }

      let altitude = typeof entry.altitude === 'number' ? entry.altitude : defaultAltitude;
      if (kind === 'land') {
        altitude = takeoffAsl ?? telemetrySnapshot.location.altitude ?? altitude ?? 0;
      }

      resolvedPlan.push({
        latitude,
        longitude,
        altitude: altitude ?? null,
        kind,
      });
    }

    if (!resolvedPlan.length) {
      setStatusMessage('Mission plan did not contain any valid waypoints for simulation.');
      return;
    }

    const horizontalSpeed = Math.max(0.5, Number.isFinite(maxSpeed) && maxSpeed > 0 ? maxSpeed : 3);

    const segments: SimulationSegment[] = [];
    let totalHorizontalDist = 0;
    let totalVerticalDist = 0;
    let totalDuration = 0;

    let workingLat = startLocation.latitude;
    let workingLon = startLocation.longitude;
    let workingAlt = currentAsl;
    let firstLeg = true;

    resolvedPlan.forEach((target, index) => {
      const targetAlt = target.altitude ?? workingAlt;
      if (firstLeg && securityAlt != null && securityAlt > workingAlt + 0.1) {
        const climb = securityAlt - workingAlt;
        const duration = Math.abs(climb) / DEFAULT_VERTICAL_SPEED_MS;
        segments.push({
          label: 'Ascend to security height',
          distance: 0,
          speed: DEFAULT_VERTICAL_SPEED_MS,
          duration,
          startAltitude: workingAlt,
          endAltitude: securityAlt,
        });
        totalVerticalDist += Math.abs(climb);
        totalDuration += duration;
        workingAlt = securityAlt;
      }

      const horizontalDistance = haversineMeters(
        { latitude: workingLat, longitude: workingLon },
        { latitude: target.latitude, longitude: target.longitude },
      );
      if (horizontalDistance > 0.2) {
        const duration = horizontalDistance / horizontalSpeed;
        segments.push({
          label: target.kind === 'orbit' ? `Leg ${index + 1} (orbit entry)` : `Leg ${index + 1}`,
          distance: horizontalDistance,
          speed: horizontalSpeed,
          duration,
          startAltitude: workingAlt,
          endAltitude: workingAlt,
        });
        totalHorizontalDist += horizontalDistance;
        totalDuration += duration;
      }

      if (targetAlt != null && Math.abs(targetAlt - workingAlt) > 0.1) {
        const delta = targetAlt - workingAlt;
        const duration = Math.abs(delta) / DEFAULT_VERTICAL_SPEED_MS;
        segments.push({
          label: delta > 0 ? `Climb to ${target.kind}` : `Descend to ${target.kind}`,
          distance: 0,
          speed: DEFAULT_VERTICAL_SPEED_MS,
          duration,
          startAltitude: workingAlt,
          endAltitude: targetAlt,
        });
        totalVerticalDist += Math.abs(delta);
        totalDuration += duration;
        workingAlt = targetAlt;
      }

      workingLat = target.latitude;
      workingLon = target.longitude;
      firstLeg = false;
    });

    const totalDistance = totalHorizontalDist + totalVerticalDist;
    const preview: SimulationPreview = {
      segments,
      totalDistance,
      totalDuration,
    };
    setSimPreview(preview);
    appendLog('Simulated mission preview', {
      total_distance_m: totalDistance,
      horizontal_distance_m: totalHorizontalDist,
      vertical_distance_m: totalVerticalDist,
      total_duration_s: totalDuration,
      segments: segments.map((segment) => ({
        label: segment.label,
        distance: segment.distance,
        speed: segment.speed,
        duration: segment.duration,
        start_altitude: segment.startAltitude,
        end_altitude: segment.endAltitude,
      })),
    }, 'simulation');
    setStatusMessage('Simulation ready — review the mission summary below.');
  }, [telemetry, missionPlan, activeTarget, securityTakeoffHeight, maxSpeed, appendLog, defaultTargetAltitudePreview, resolveTakeoffAltitude]);

  const handleSimulateMission = React.useCallback(() => {
    simulateMissionPlan();
  }, [simulateMissionPlan]);

  const sendFlyTo = async (latitude: number, longitude: number, altitude: number | null, label: string) => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;

    setSimPreview(null);
    setPlacingTarget(false);

    const baseLocation = telemetrySnapshot.location;
    const baseAltitude = baseLocation.altitude ?? telemetrySnapshot.altitude ?? 0;
    const takeoffAltitude = resolveTakeoffAltitude(telemetrySnapshot);
    let resolvedAltitude = altitude ?? baseAltitude;

    const horizontalDistance = baseLocation
      ? haversineMeters(
          { latitude: baseLocation.latitude, longitude: baseLocation.longitude },
          { latitude, longitude },
        )
      : Number.NaN;
    const verticalDelta = altitude != null
      ? Math.abs((altitude ?? baseAltitude) - baseAltitude)
      : 0;

    if (!Number.isNaN(horizontalDistance) && horizontalDistance < MIN_HORIZONTAL_DISTANCE_M && verticalDelta < MIN_VERTICAL_DISTANCE_M) {
      setStatusMessage(`Target unchanged (<${MIN_HORIZONTAL_DISTANCE_M.toFixed(1)} m horizontal & <${MIN_VERTICAL_DISTANCE_M.toFixed(1)} m vertical). Adjust before executing.`);
      appendLog('Fly-to skipped: target too close', {
        horizontal_distance: horizontalDistance,
        vertical_delta: verticalDelta,
        from: baseLocation,
        to: { latitude, longitude, altitude },
      }, 'telemetry');
      return;
    }

    const altitudeReference = inferAltitudeReference(
      altitude ?? resolvedAltitude,
      manualTarget.source ?? activeTarget?.source,
    );

    const params: Record<string, any> = {
      target_location: {
        latitude,
        longitude,
        altitude: clampAltitude(resolvedAltitude),
      },
    };

    if (altitudeReference) {
      params.target_location.altitude_reference = altitudeReference;
    }

    if (Number.isFinite(maxSpeed) && maxSpeed > 0) {
      params.max_speed = Math.round(maxSpeed);
    }
    if (Number.isFinite(securityTakeoffHeight) && securityTakeoffHeight >= 0) {
      params.security_takeoff_height = Math.round(securityTakeoffHeight);
    }

    params.mode = flyToMode;

    if (flyToMode === 'set_height') {
      if (!Number.isFinite(flyToHeight)) {
        setStatusMessage('Fly-To height required when mode is set-height');
        return;
      }
      const requestedHeight = Math.round(flyToHeight);
      params.fly_to_height = requestedHeight;
      if (typeof takeoffAltitude === 'number') {
        resolvedAltitude = clampAltitude(takeoffAltitude + requestedHeight);
      }
    }

    params.target_location.altitude = clampAltitude(resolvedAltitude);

    appendLog(label, params, 'command');

    try {
      const result = await sendFlightCommand('fly_to_prepare', params);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'fly_to_prepare rejected');
      } else {
        setStatusMessage(`${label}: command sent`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'fly_to_prepare failed');
    }
  };

  const handleRelativeMove = async (direction: 'forward' | 'backward' | 'left' | 'right') => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    const { location } = telemetrySnapshot;
    const heading = normalizeHeadingDegrees(telemetrySnapshot.heading ?? telemetrySnapshot.compass_heading ?? 0);

    const dist = distanceMeters;
    const headingOffset =
      direction === 'forward'
        ? heading
        : direction === 'backward'
          ? heading + 180
          : direction === 'left'
            ? heading - 90
            : heading + 90;
    const { north, east } = bearingOffsetToMeters(dist, headingOffset);
    const next = addMetersToLatLon(location.latitude, location.longitude, north, east);
    const altitudeReference = activeTarget?.altitude
      ?? manualTarget.altitude
      ?? telemetrySnapshot.location.altitude
      ?? telemetrySnapshot.altitude
      ?? null;
    const horizontalDistance = haversineMeters(
      { latitude: location.latitude, longitude: location.longitude },
      { latitude: next.latitude, longitude: next.longitude },
    );
    const warning = horizontalDistance < MIN_HORIZONTAL_DISTANCE_M
      ? `Warning: DJI rejects missions with <${MIN_HORIZONTAL_DISTANCE_M.toFixed(1)} m horizontal separation.`
      : null;
    stageManualTarget(
      {
        latitude: next.latitude,
        longitude: next.longitude,
        altitude: altitudeReference,
        source: 'manual',
      },
      {
        reason: `relative_${direction}`,
        distance_commanded: dist,
        horizontal_distance: horizontalDistance,
        from: { latitude: location.latitude, longitude: location.longitude },
        to: { latitude: next.latitude, longitude: next.longitude },
      },
      warning
        ? `Target staged ${direction} ${dist} m · ${warning}`
        : `Target staged ${direction} ${dist} m. Run Simulate Mission before executing.`,
    );
  };

  const handleVerticalMove = async (direction: 'up' | 'down') => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    const { location } = telemetrySnapshot;
    const baseTarget = activeTarget && activeTarget.latitude != null && activeTarget.longitude != null
      ? activeTarget
      : {
          latitude: location.latitude,
          longitude: location.longitude,
          altitude: manualTarget.altitude ?? location.altitude ?? telemetrySnapshot.altitude ?? null,
        };
    const delta = direction === 'up' ? Math.abs(verticalMeters) : -Math.abs(verticalMeters);
    const newAltitude = (baseTarget.altitude ?? location.altitude ?? telemetrySnapshot.altitude ?? 0) + delta;
    const warning = Math.abs(delta) < MIN_VERTICAL_DISTANCE_M
      ? `Warning: DJI may reject vertical-only missions under ${MIN_VERTICAL_DISTANCE_M.toFixed(1)} m.`
      : null;
    stageManualTarget(
      {
        latitude: baseTarget.latitude ?? location.latitude,
        longitude: baseTarget.longitude ?? location.longitude,
        altitude: newAltitude,
        source: 'manual',
      },
      {
        reason: `vertical_${direction}`,
        delta_altitude: delta,
        base_altitude: baseTarget.altitude ?? location.altitude ?? telemetrySnapshot.altitude ?? null,
      },
      warning
        ? `Target staged ${direction === 'up' ? 'up' : 'down'} ${Math.abs(delta)} m · ${warning}`
        : `Target staged ${direction === 'up' ? 'up' : 'down'} ${Math.abs(delta)} m. Simulate before flying.`,
    );
  };

  const handleReturnHome = async (action: 'return_home_start' | 'return_home_stop') => {
    setSimPreview(null);
    appendLog(action === 'return_home_start' ? 'Return Home Start' : 'Return Home Stop', {}, 'command');
    try {
      const result = await sendFlightCommand(action);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || `${action} rejected`);
      } else {
        setStatusMessage(`${action === 'return_home_start' ? 'Return Home started' : 'Return Home cancelled'}`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `${action} failed`);
    }
  };

  const handlePauseMission = async () => {
    setSimPreview(null);
    appendLog('Waypoint Pause', {}, 'command');
    try {
      const result = await sendFlightCommand('waypoint_pause');
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'waypoint_pause rejected');
      } else {
        setStatusMessage('Waypoint mission pause requested');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'waypoint_pause failed');
    }
  };

  const handleResumeMission = async () => {
    setSimPreview(null);
    appendLog('Waypoint Resume', {}, 'command');
    try {
      const result = await sendFlightCommand('waypoint_resume');
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'waypoint_resume rejected');
      } else {
        setStatusMessage('Waypoint mission resume requested');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'waypoint_resume failed');
    }
  };

  const handleStopMission = async () => {
    setSimPreview(null);
    appendLog('Waypoint Stop', {}, 'command');
    try {
      const result = await sendFlightCommand('waypoint_stop');
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'waypoint_stop rejected');
      } else {
        setStatusMessage('Waypoint mission stop requested');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'waypoint_stop failed');
    }
  };

  React.useEffect(() => {
    const flightLog = bridgeData.flightCommandLog;
    if (!flightLog || flightLog.length === 0) return;
    const latest = flightLog[flightLog.length - 1] as FlightCommandAck;
    if (!latest || typeof latest.timestamp !== 'number') return;
    if (lastAckRef.current === latest.timestamp) return;
    lastAckRef.current = latest.timestamp;

    const actionNormalized = latest.action?.toLowerCase?.() ?? latest.action;
    if (
      latest.backend === 'waypoint_v2' ||
      actionNormalized === 'waypoint_stop' ||
      actionNormalized === 'waypoint_pause' ||
      actionNormalized === 'waypoint_resume'
    ) {
      appendLog(
        `Ack ${latest.action.replace(/_/g, ' ')}`,
        {
          status: latest.status,
          backend: latest.backend,
          mission_id: latest.mission_id,
          mission_path: latest.mission_path,
          message: latest.message ?? latest.error_message,
          wayline_ids: latest.wayline_ids,
        },
        'telemetry',
      );
    }
  }, [bridgeData.flightCommandLog, appendLog]);

  React.useEffect(() => {
    if (!waypointStatus) return;
    const missionId = waypointStatus.mission_id ?? waypointStatus.executing?.mission_id ?? 'unknown';
    const stateKey = `${missionId}:${waypointStatus.state ?? 'none'}`;
    if (stateKey !== lastWaypointStateRef.current) {
      lastWaypointStateRef.current = stateKey;
    }

    const waypointIndex = typeof waypointStatus.executing?.current_waypoint_index === 'number'
      ? waypointStatus.executing.current_waypoint_index
      : null;
    if (waypointIndex !== null) {
      const indexKey = `${missionId}:wp:${waypointIndex}`;
      if (indexKey !== lastWaypointIndexRef.current) {
        lastWaypointIndexRef.current = indexKey;
      }
    }

  }, [waypointStatus]);

  React.useEffect(() => {
    const entries = missionTimeline;
    if (!entries || entries.length === 0) {
      return;
    }
    const seen = waypointTimelineSeenRef.current;
    const makeKey = (entry: WaypointTimelineEntry, index: number) => {
      const base = `${entry.timestamp ?? 'na'}:${entry.type}`;
      switch (entry.type) {
        case 'state':
          return `${base}:${entry.state ?? index}`;
        case 'executing':
          return `${base}:${entry.mission_id ?? 'mission'}:${entry.wayline_id ?? 'wl'}:${entry.current_waypoint_index ?? index}`;
        case 'interrupt':
          return `${base}:${entry.error?.code ?? entry.error?.description ?? index}`;
        case 'event':
          return `${base}:${entry.event ?? 'event'}:${entry.reason ?? index}`;
        case 'breakpoint':
          return `${base}:${entry.waypoint_id ?? 'wp'}:${entry.segment_progress ?? 'progress'}`;
        case 'breakpoint_error':
          return `${base}:${entry.error?.code ?? index}`;
        default:
          return `${base}:${index}`;
      }
    };

    entries.forEach((entry, idx) => {
      const key = makeKey(entry, idx);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      if (seen.size > 200) {
        const recent = Array.from(seen).slice(-200);
        seen.clear();
        recent.forEach((value) => seen.add(value));
      }

      const entryType = entry.type;
      let label = `Timeline ${entryType}`;
      switch (entryType) {
        case 'state':
          label = `State ${formatMissionStateLabel(entry.state)}`;
          break;
        case 'executing':
          label = `Waypoint #${entry.current_waypoint_index ?? '—'}`;
          break;
        case 'interrupt':
          label = `Interrupt ${entry.error?.code ?? ''}`.trim();
          break;
        case 'event':
          label = `Event ${entry.event ?? ''}`.trim();
          break;
        case 'breakpoint':
          label = 'Break point info';
          break;
        case 'breakpoint_error':
          label = 'Break point error';
          break;
      }

      appendLog(
        label,
        { ...entry } as unknown as Record<string, any>,
        'telemetry',
      );
    });
  }, [waypointStatus?.timeline, appendLog]);

  const handleFlyToTarget = async () => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    if (!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Set a mission target (map, laser, or object memory) before flying.');
      return;
    }
    const altitude = typeof activeTarget.altitude === 'number'
      ? activeTarget.altitude
      : telemetrySnapshot.location.altitude ?? telemetrySnapshot.altitude ?? null;
    const label = activeTarget.source === 'laser'
      ? 'Fly to laser target'
      : activeTarget.source === 'map'
        ? 'Fly to map target'
        : activeTarget.source === 'object-memory'
          ? 'Fly to memory target'
          : 'Fly to manual target';
    await sendFlyTo(activeTarget.latitude, activeTarget.longitude, altitude, label);
  };

  const handleExecuteMissionPlan = React.useCallback(async (triggerSource?: string) => {
    if (!missionPlan.length) {
      setStatusMessage('Add at least one waypoint to the mission plan before executing.');
      return;
    }

    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) {
      return;
    }

    setSimPreview(null);

    const snapshotTakeoffAsl = resolveTakeoffAltitude(telemetrySnapshot);
    const requestSource = triggerSource ?? 'mission_control';

    const defaultAltitudeAsl = (() => {
      if (typeof manualTarget.altitude === 'number') {
        return manualTarget.altitude;
      }
      if (snapshotTakeoffAsl != null && Number.isFinite(securityTakeoffHeight)) {
        return snapshotTakeoffAsl + securityTakeoffHeight;
      }
      if (typeof telemetrySnapshot.location?.altitude === 'number' && Number.isFinite(securityTakeoffHeight)) {
        return telemetrySnapshot.location.altitude + securityTakeoffHeight;
      }
      return telemetrySnapshot.location?.altitude ?? telemetrySnapshot.altitude ?? null;
    })();

    const snapshotHome = telemetrySnapshot.home_location ?? homeLocation;

    const terminalAction = [...missionPlan]
      .reverse()
      .find((entry) => entry.kind === 'land' || entry.kind === 'return_home');

    const finishAction = terminalAction?.kind === 'land'
      ? 'land'
      : terminalAction?.kind === 'return_home'
        ? 'return_home'
        : 'none';

    const planPayload: MissionPlanCommandEntry[] = missionPlan
      .map((entry) => {
        let latitude = entry.latitude;
        let longitude = entry.longitude;

        if (entry.kind === 'return_home' && snapshotHome && Number.isFinite(snapshotHome.latitude) && Number.isFinite(snapshotHome.longitude)) {
          latitude = clampLat(snapshotHome.latitude);
          longitude = clampLon(snapshotHome.longitude);
        }

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        const altitudeReference = entry.altitudeReference ?? altitudeReferenceForExecuteMode(executeHeightMode);

        let altitudeAsl: number | null = null;
        if (altitudeReference === 'absolute_wgs84') {
          altitudeAsl = typeof entry.altitude === 'number'
            ? entry.altitude
            : defaultAltitudeAsl;
        } else if (altitudeReference === 'relative_to_takeoff') {
          altitudeAsl = typeof entry.altitude === 'number' && snapshotTakeoffAsl != null
            ? snapshotTakeoffAsl + entry.altitude
            : (typeof defaultAltitudeAsl === 'number' ? defaultAltitudeAsl : null);
        } else {
          altitudeAsl = typeof entry.altitude === 'number'
            ? entry.altitude
            : defaultAltitudeAsl;
        }

        if (entry.kind === 'land') {
          altitudeAsl = snapshotTakeoffAsl ?? defaultAltitudeAsl ?? altitudeAsl ?? 0;
        }

        const payload: MissionPlanCommandEntry = {
          latitude,
          longitude,
          altitude: altitudeReference === 'relative_to_takeoff'
            ? (typeof entry.altitude === 'number' ? entry.altitude : null)
            : (typeof altitudeAsl === 'number' ? altitudeAsl : null),
          kind: entry.kind,
        };
        if (typeof entry.radius === 'number') {
          payload.radius = entry.radius;
        }
        if (typeof entry.turns === 'number') {
          payload.turns = entry.turns;
        }
        if (entry.actions && entry.actions.length) {
          payload.actions = entry.actions.map((action) => ({ ...action }));
          const gimbalAction = entry.actions.find((action): action is Extract<WaypointAction, { type: 'gimbal_pitch' }> => action.type === 'gimbal_pitch');
          if (gimbalAction && typeof gimbalAction.pitch === 'number') {
            const clampedPitch = Math.max(GIMBAL_PITCH_MIN, Math.min(GIMBAL_PITCH_MAX, gimbalAction.pitch));
            (payload as any).gimbal_pitch = clampedPitch;
          }
        }
        if (entry.turn) {
          payload.turn = { ...entry.turn };
        }
        if (entry.heading) {
          payload.heading = {
            ...entry.heading,
            poi: entry.heading.poi ? { ...entry.heading.poi } : undefined,
          };
        }
        if (entry.gimbalHeading) {
          payload.gimbal_heading = { ...entry.gimbalHeading };
        }
        if (entry.poi) {
          payload.poi = { ...entry.poi };
        }
        if (entry.gimbalStrategy) {
          payload.gimbal_strategy = entry.gimbalStrategy;
        }
        if (entry.actionGroups && entry.actionGroups.length) {
          payload.action_groups = entry.actionGroups.map((group) => ({
            ...group,
            actions: group.actions.map((action) => ({
              ...action,
              params: action.params ? { ...action.params } : undefined,
            })),
          }));
        }
        if (entry.altitudeReference) {
          payload.altitude_reference = entry.altitudeReference;
        }
        return payload;
      })
      .filter((entry): entry is MissionPlanCommandEntry => Boolean(entry));

    if (!planPayload.length) {
      setStatusMessage('Mission plan has no valid waypoints to execute.');
      return;
    }

    const finalTarget = planPayload[planPayload.length - 1];
    const maxSpeedValue = Number.isFinite(maxSpeed) ? maxSpeed : undefined;
    const finalReference = finalTarget.altitude_reference ?? altitudeReferenceForExecuteMode(executeHeightMode);
    const targetAltitudeAsl = finalReference === 'absolute_wgs84'
      ? (typeof finalTarget.altitude === 'number'
        ? finalTarget.altitude
        : (snapshotTakeoffAsl != null && Number.isFinite(securityTakeoffHeight)
          ? snapshotTakeoffAsl + securityTakeoffHeight
          : snapshotTakeoffAsl))
      : (finalReference === 'relative_to_takeoff' && typeof finalTarget.altitude === 'number' && snapshotTakeoffAsl != null
        ? snapshotTakeoffAsl + finalTarget.altitude
        : snapshotTakeoffAsl);

    const commandPayload: Record<string, any> = {
      plan: planPayload.map((point) => serializePlanPoint(point)),
      mode: flyToMode,
      security_takeoff_height: securityTakeoffHeight,
      path_mode: flightPathMode,
      orbit_mode: orbitMode,
      reason: 'mission_plan',
      target_location: {
        latitude: finalTarget.latitude,
        longitude: finalTarget.longitude,
        ...(finalReference === 'absolute_wgs84' && typeof targetAltitudeAsl === 'number'
          ? { altitude: targetAltitudeAsl, altitude_reference: 'absolute_wgs84' }
          : finalReference === 'relative_to_takeoff'
            ? {
                altitude: typeof finalTarget.altitude === 'number' ? finalTarget.altitude : 0,
                altitude_reference: 'relative_to_takeoff',
              }
            : {}),
      },
    };

    const sanitizedPoiForCommand = sanitizePoiTarget(poiTarget);
    if (sanitizedPoiForCommand) {
      commandPayload.poi_target = sanitizedPoiForCommand;
    }

    if (requestSource) {
      commandPayload.trigger_source = requestSource;
    }

    if (typeof maxSpeedValue === 'number') {
      commandPayload.max_speed = maxSpeedValue;
    }

    if (flyToMode === 'set_height') {
      commandPayload.fly_to_height = Math.round(flyToHeight);
    }

    if (typeof targetAltitudeAsl === 'number') {
      commandPayload.target_altitude_asl = targetAltitudeAsl;
    }

    switch (finishAction) {
      case 'return_home':
        commandPayload.finish_action = 'go_home';
        break;
      case 'land':
        commandPayload.finish_action = 'land';
        break;
      default:
        break;
    }

    appendLog('Mission plan execute', commandPayload, 'command');

    try {
      const result = await sendFlightCommand('waypoint_execute_plan', commandPayload);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'waypoint_execute_plan rejected');
      } else {
        const sourceLabel = requestSource && requestSource !== 'mission_control'
          ? ` via ${requestSource.replace(/_/g, ' ')}`
          : '';
        setStatusMessage(`Mission plan (${planPayload.length} waypoint${planPayload.length === 1 ? '' : 's'}) dispatched${sourceLabel}.`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'waypoint_execute_plan failed');
    }
  }, [
    appendLog,
    defaultTargetAltitudePreview,
    ensureTelemetry,
    flyToHeight,
    flyToMode,
    homeLocation?.latitude,
    homeLocation?.longitude,
    manualTarget.altitude,
    maxSpeed,
    missionPlan,
    flightPathMode,
    resolveTakeoffAltitude,
    securityTakeoffHeight,
    sendFlightCommand,
    setSimPreview,
    setStatusMessage,
  ]);

  React.useEffect(() => {
    const unsubscribe = missionPlannerStore.onExecutePlanRequest((context) => {
      handleExecuteMissionPlan(context?.source);
    });
    return unsubscribe;
  }, [handleExecuteMissionPlan]);

  const simulatorBadge = React.useMemo(() => getSimulatorModeBadge(telemetry?.simulator), [telemetry?.simulator]);
  const simulatorStatus = telemetry?.simulator;
  const [simulatorActionPending, setSimulatorActionPending] = React.useState(false);

  const handleSimulatorQuickToggle = React.useCallback(async () => {
    if (simulatorActionPending) return;
    if (!telemetry) {
      setStatusMessage('Telemetry unavailable — cannot toggle simulator.');
      return;
    }
    setSimulatorActionPending(true);
    try {
      if (simulatorStatus?.enabled) {
        const result = await sendFlightCommand('simulator_disable');
        if (result?.error || result?.error_message) {
          setStatusMessage(result.error || result.error_message || 'Simulator disable rejected');
        } else {
          setStatusMessage('Simulator disable requested');
        }
        return;
      }

      const config = simulatorStatus?.configuration;
      const home = telemetry.home_location;
      const location = telemetry.location;
      const latitude = config?.latitude ?? home?.latitude ?? location?.latitude;
      const longitude = config?.longitude ?? home?.longitude ?? location?.longitude;
      if (
        typeof latitude !== 'number' || !Number.isFinite(latitude) ||
        typeof longitude !== 'number' || !Number.isFinite(longitude)
      ) {
        setStatusMessage('Set simulator coordinates in the expanded controls before enabling.');
        return;
      }

      const params: Record<string, any> = {
        latitude,
        longitude,
        satellites: typeof config?.satellites === 'number' && Number.isFinite(config.satellites)
          ? config.satellites
          : 12,
      };

      const altitudeCandidate =
        (typeof config?.altitude === 'number' && Number.isFinite(config.altitude) ? config.altitude : undefined) ??
        (typeof home?.altitude === 'number' && Number.isFinite(home.altitude) ? home.altitude : undefined) ??
        (typeof location?.altitude === 'number' && Number.isFinite(location.altitude) ? location.altitude : undefined) ??
        (typeof telemetry.takeoff_altitude === 'number' && Number.isFinite(telemetry.takeoff_altitude)
          ? telemetry.takeoff_altitude
          : undefined);

      if (typeof altitudeCandidate === 'number') {
        params.altitude = altitudeCandidate;
      }

      const result = await sendFlightCommand('simulator_enable', params);
      if (result?.error || result?.error_message) {
        setStatusMessage(result.error || result.error_message || 'Simulator enable rejected');
      } else {
        setStatusMessage('Simulator enable requested');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Simulator command failed');
    } finally {
      setSimulatorActionPending(false);
    }
  }, [simulatorActionPending, telemetry, simulatorStatus, sendFlightCommand, setStatusMessage]);

  return (
    <Panel
      title="Mission Control"
      storageKey="flyto.panel"
      visibilityEventType="flyToPanelVisibilityChange"
      defaultPosition={{ x: 1040, y: 780 }}
      defaultSize={{ w: 340, h: 360 }}
    >
      <div className="space-y-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        {statusMessage && (
          <div className="text-[11px] text-status-warning bg-black/40 border border-yellow-500/40 rounded px-2 py-1">
            {statusMessage}
          </div>
        )}

        <CollapsibleSection
          title="Simulator"
          storageKey="missionControl.section.simulator"
          defaultOpen={false}
          summary={simulatorStatus ? (simulatorStatus.enabled ? 'Enabled' : 'Disabled') : 'No link'}
          headerActions={
            <button
              type="button"
              onClick={handleSimulatorQuickToggle}
              disabled={simulatorActionPending}
              className={`px-2 py-1 text-[10px] uppercase tracking-wide rounded border transition ${
                simulatorStatus?.enabled
                  ? 'border-status-error/60 text-status-error hover:bg-status-error/10'
                  : 'border-status-good/60 text-status-good hover:bg-status-good/15'
              } ${simulatorActionPending ? 'opacity-60 cursor-not-allowed hover:bg-transparent' : ''}`}
            >
              {simulatorStatus?.enabled ? 'Disable' : 'Enable'}
            </button>
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`px-2 py-0.5 border rounded ${simulatorBadge.className}`}>
              {simulatorBadge.label}
            </span>
            <span className="text-gray-200">
              {simulatorStatus?.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className="text-gray-500">
              Updated {formatRelativeTime(simulatorStatus?.timestamp)}
            </span>
          </div>
          <div className="flex flex-wrap gap-3 text-gray-400 text-[11px]">
            <span>
              Motors {simulatorStatus?.motors_on === undefined ? '—' : simulatorStatus.motors_on ? 'ON' : 'OFF'}
            </span>
            <span>
              Flight {simulatorStatus?.flying === undefined ? '—' : simulatorStatus.flying ? 'In Air' : 'Ground'}
            </span>
            {simulatorStatus?.configuration && (
              <span>
                Config lat {formatLatLon(simulatorStatus.configuration.latitude)} · lon {formatLatLon(simulatorStatus.configuration.longitude)}
              </span>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Mission Defaults" storageKey="missionControl.section.defaults">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Max Speed (m/s)</span>
              <input
                type="number"
                value={maxSpeed}
                min={1}
                max={15}
                onChange={(event) => setMaxSpeed(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Security Takeoff Height (m)</span>
              <input
                type="number"
                value={securityTakeoffHeight}
                min={0}
                max={120}
                onChange={(event) => setSecurityTakeoffHeight(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Fly-To Mode</span>
              <select
                value={flyToMode}
                onChange={(event) => setFlyToMode(event.target.value as 'smart_height' | 'set_height')}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
              >
                {availableModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'smart_height' ? 'Smart height' : 'Set height'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Waypoint Path Mode</span>
              <select
                value={flightPathMode}
                onChange={(event) => setFlightPathMode(event.target.value as 'straight' | 'curved')}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
              >
                <option value="straight">Straight (stop at waypoint)</option>
                <option value="curved">Curved (fly-through)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Orbit / POI Mode</span>
              <select
                value={orbitMode}
                onChange={(event) => handleOrbitModeChange(event.target.value as OrbitMode)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
              >
                <option value="none">None (heading follows wayline)</option>
                <option value="drift">Drift (aircraft faces POI)</option>
                <option value="gimbal">Gimbal LookAt POI (aircraft assists)</option>
                <option value="gimbal_free">Gimbal LookAt POI (gimbal only)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Altitude Reference Mode</span>
              <select
                value={executeHeightMode}
                onChange={(event) => handleExecuteHeightModeChange(event.target.value as ExecuteHeightMode)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
              >
                <option value="relative_to_takeoff">Relative to takeoff</option>
                <option value="absolute_wgs84">Absolute (WGS84)</option>
              </select>
              {executeHeightMode === 'absolute_wgs84' && (
                <span className="text-[10px] text-gray-500">
                  Terrain preview: {terrainElevationPreview != null ? terrainElevationPreview.toFixed(1) : '—'} m
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Default Target Height (m AGL)</span>
              <input
                type="number"
                value={flyToMode === 'set_height' ? flyToHeight : securityTakeoffHeight}
                min={Math.max(1, Math.floor(heightRangeMin))}
                max={Math.max(Math.ceil(heightRangeMax), Math.floor(heightRangeMin) + 1)}
                onChange={(event) => {
                  const value = Number(event.target.value) || 0;
                  if (flyToMode === 'set_height') {
                    setFlyToHeight(value);
                  } else {
                    setSecurityTakeoffHeight(value);
                  }
                }}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
          {heightRange && (
            <span className="text-[10px] text-gray-500">
              Capability range {heightRange.min ?? '—'} – {heightRange.max ?? '—'} m
            </span>
          )}
        </label>
      </div>
      <div className="flex flex-col gap-2 border-t border-gray-700/60 pt-2 mt-1">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-gray-400 text-[11px] uppercase">POI Target</span>
            <span className="font-mono text-[11px] text-gray-200">
              {poiTarget
                ? `${formatLatLon(poiTarget.latitude)}, ${formatLatLon(poiTarget.longitude)}`
                : 'None'}
            </span>
            {poiTarget?.altitude != null && Number.isFinite(poiTarget.altitude) && (
              <span className="text-[10px] text-gray-500">
                Alt {poiTarget.altitude.toFixed(1)} m
              </span>
            )}
            {orbitMode !== 'none' && !poiTarget && (
              <span className="text-[10px] text-yellow-400">POI required for current orbit mode.</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={`px-2 py-1 rounded border ${canAssignPoi ? 'border-gray-600 text-gray-200 hover:bg-gray-800' : 'border-gray-800 text-gray-600 cursor-not-allowed'}`}
              disabled={!canAssignPoi}
              onClick={handleSetPoiFromTarget}
            >
              Use target
            </button>
            <button
              type="button"
              className={`px-2 py-1 rounded border ${poiTarget ? 'border-gray-600 text-gray-200 hover:bg-gray-800' : 'border-gray-800 text-gray-600 cursor-not-allowed'}`}
              disabled={!poiTarget}
              onClick={handleClearPoiTarget}
            >
              Clear
            </button>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px]">
            <span>Object Memory POI</span>
            <select
              value={objectMemorySelectValue}
              onChange={(event) => handleSelectObjectMemoryCluster(event.target.value)}
              disabled={objectMemoryLoading}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
            >
              <option value="">Select object memory…</option>
              {objectMemorySelectionMissing && selectedObjectMemoryClusterId && (
                <option value={selectedObjectMemoryClusterId}>
                  {targetSelection?.clusterLabel ?? selectedObjectMemoryClusterId} (staged)
                </option>
              )}
              {objectMemoryClusters.map((cluster) => {
                const optionLabel = cluster.label && cluster.label.trim().length
                  ? cluster.label
                  : cluster.cluster_id;
                const countLabel = typeof cluster.sample_count === 'number'
                  ? ` · ${cluster.sample_count}`
                  : '';
                return (
                  <option key={cluster.cluster_id} value={cluster.cluster_id}>
                    {optionLabel}
                    {countLabel}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            onClick={() => { void refreshObjectMemoryClusters(); }}
            disabled={objectMemoryLoading}
            className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-800 disabled:opacity-50 disabled:hover:bg-gray-900"
          >
            {objectMemoryLoading ? 'Loading…' : 'Reload'}
          </button>
        </div>
        {objectMemorySelectionMissing && !objectMemoryLoading && !objectMemoryError && (
          <div className="text-[10px] text-yellow-400">Selected cluster missing from latest list — reload to resync.</div>
        )}
        {objectMemoryError && (
          <div className="text-[10px] text-red-400">{objectMemoryError}</div>
        )}
        {!objectMemoryError && !objectMemoryLoading && objectMemoryClusters.length === 0 && (
          <div className="text-[10px] text-gray-500">No object memory clusters with coordinates available.</div>
        )}
        {targetSelection && derivedTarget && (
          <div className="mt-2 rounded border border-purple-700/40 bg-purple-900/15 px-2 py-2 text-[10px] text-purple-100">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-purple-200">
                {targetSelection.clusterLabel ?? targetSelection.clusterId ?? 'Object Memory'}
              </div>
              <button
                type="button"
                onClick={handleSetPoiFromObjectMemory}
                className="px-2 py-1 rounded border border-purple-500/60 bg-purple-500/15 text-purple-100 hover:bg-purple-500/25"
              >
                Use object memory
              </button>
            </div>
            <div className="mt-1 font-mono text-purple-200">
              {formatLatLon(derivedTarget.latitude)}, {formatLatLon(derivedTarget.longitude)}
            </div>
            <div className="mt-0.5 text-purple-300">
              Alt {derivedTarget.altitude != null ? derivedTarget.altitude.toFixed(1) : '—'} m
            </div>
          </div>
        )}
      </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Manual Move Presets"
          storageKey="missionControl.section.manualMove"
        >
          <div className="text-[10px] text-gray-500">
            Default AMSL target: {defaultTargetAltitudePreview != null ? defaultTargetAltitudePreview.toFixed(1) : '—'} m
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Distance (m)</span>
              <input
                type="number"
                value={distanceMeters}
                min={1}
                max={200}
                onChange={(event) => setDistanceMeters(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Δ Altitude (m)</span>
              <input
                type="number"
                value={verticalMeters}
                min={1}
                max={200}
                onChange={(event) => setVerticalMeters(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('forward')}>
              Forward
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('backward')}>
              Backward
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('left')}>
              Left
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('right')}>
              Right
            </button>
          </div>
          {flyToStatus && (
            <div className="mt-2 text-[11px] text-gray-400 space-y-0.5">
              <div className="uppercase text-gray-500 text-[10px]">Fly-To Telemetry</div>
              <div>
                Reported mode{' '}
                <span className="text-gray-200">{flyToStatus.info?.mode ?? '—'}</span>
                {typeof flyToStatus.info?.height === 'number' && (
                  <span className="ml-2 text-gray-300">height {flyToStatus.info.height} m</span>
                )}
                {typeof flyToStatus.info?.is_running === 'boolean' && (
                  <span className="ml-2 text-gray-300">
                    {flyToStatus.info.is_running ? 'running' : 'idle'}
                  </span>
                )}
              </div>
              {Array.isArray(flyToStatus.capability?.supported_modes) && (
                <div>
                  Supported modes{' '}
                  <span className="text-gray-200">
                    {flyToStatus.capability.supported_modes.join(', ')}
                  </span>
                </div>
              )}
              {heightRange && (
                <div>
                  Height limits{' '}
                  <span className="text-gray-200">
                    {heightRange.min ?? '—'} – {heightRange.max ?? '—'} m
                  </span>
                </div>
              )}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Vertical Move"
          storageKey="missionControl.section.verticalMove"
          defaultOpen={false}
        >
          <div className="flex items-center gap-3">
            <span className="text-[11px]">Δ Alt (m)</span>
            <input
              type="number"
              value={verticalMeters}
              min={1}
              max={200}
              onChange={(event) => setVerticalMeters(Number(event.target.value) || 0)}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right w-20"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleVerticalMove('up')}>
              Up
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleVerticalMove('down')}>
              Down
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Target & Planning"
          storageKey="missionControl.section.target"
          summary={manualTargetSourceLabel ? `Source: ${manualTargetSourceLabel}` : undefined}
        >
          <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
            <label className="flex flex-col gap-1">
              <span>Latitude</span>
              <input
                type="number"
                value={manualTarget.latitude ?? ''}
                onChange={(event) => updateManualCoordinate('latitude', event.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                placeholder="deg"
                step="0.000001"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Longitude</span>
              <input
                type="number"
                value={manualTarget.longitude ?? ''}
                onChange={(event) => updateManualCoordinate('longitude', event.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                placeholder="deg"
                step="0.000001"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Altitude (MSL)</span>
              <input
                type="number"
                value={manualTarget.altitude ?? ''}
                onChange={(event) => updateManualAltitude(event.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                placeholder="m"
                step="0.1"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] mb-2">
            <button
              type="button"
              className={`px-2 py-1 rounded border ${placingTarget ? 'border-amber-400 text-amber-200 bg-amber-500/10' : 'border-gray-700 text-gray-200 bg-gray-800/60 hover:bg-gray-700/60'}`}
              onClick={() => setPlacingTarget((prev) => !prev)}
            >
              {placingTarget ? 'Ctrl+click main map' : 'Enable map placement'}
            </button>
            <button
              type="button"
              className={`px-2 py-1 rounded border ${lastLaserFix ? 'border-emerald-500 text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20' : 'border-gray-700 text-gray-500 cursor-not-allowed bg-gray-800/40'}`}
              onClick={handleUseLaserFix}
              disabled={!lastLaserFix}
            >
              Use laser fix
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-200 bg-gray-800/60 hover:bg-gray-700/60"
              onClick={handleUseCurrentLocation}
            >
              Use aircraft pos
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-300 bg-gray-800/40 hover:bg-gray-700/50"
              onClick={handleClearManualTarget}
            >
              Clear target
            </button>
          </div>
          {targetSelection ? (
            <div className="text-[11px] text-gray-300 mb-2">
              Memory cluster: {targetSelection.clusterLabel ?? targetSelection.clusterId}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500 mb-2">
              Tip: select an Object Memory target or capture a laser point to seed the mission.
            </div>
          )}
          {lastLaserFix && (
            <div className="text-[11px] text-gray-400 mb-2">
              Last laser fix: {formatLatLon(lastLaserFix.latitude)} / {formatLatLon(lastLaserFix.longitude)}
              {typeof lastLaserFix.altitude === 'number' && (
                <span> · {formatMetersValue(lastLaserFix.altitude, 1)}</span>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 mb-2">
            <button
              type="button"
              className="px-2 py-1 rounded bg-dji-blue text-white hover:bg-dji-blue/80 disabled:bg-gray-700 disabled:text-gray-400"
              onClick={handleFlyToTarget}
              disabled={!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null}
            >
              Fly to Staged Target
            </button>
          </div>
          {simPreview && (
            <div className="mt-2 text-[10px] text-gray-300 space-y-1">
              {simPreview.segments.length ? (
                <table className="w-full text-left border-separate border-spacing-y-1">
                  <thead className="text-gray-400">
                    <tr>
                      <th className="pr-2">Segment</th>
                      <th className="pr-2">Distance</th>
                      <th className="pr-2">Speed</th>
                      <th className="pr-2">Duration</th>
                      <th>Altitude</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simPreview.segments.map((segment, idx) => (
                      <tr key={`${segment.label}-${idx}`} className="bg-gray-900/40">
                        <td className="pr-2 py-0.5 text-gray-200">{segment.label}</td>
                        <td className="pr-2 py-0.5">{formatMetersValue(segment.distance, 1)}</td>
                        <td className="pr-2 py-0.5">{segment.speed.toFixed(1)} m/s</td>
                        <td className="pr-2 py-0.5">{formatSeconds(segment.duration)}</td>
                        <td className="py-0.5">
                          {formatMetersValue(segment.startAltitude, 1)} → {formatMetersValue(segment.endAltitude, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div>No movement required — already at target.</div>
              )}
              <div>
                Total distance {formatMetersValue(simPreview.totalDistance, 1)} · Total time {formatSeconds(simPreview.totalDuration)}
              </div>
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="KMZ Missions"
          storageKey="missionControl.section.kmz"
          summary={lastLoadedKmz ? `${lastLoadedKmz.name} · ${formatRelativeTime(lastLoadedKmz.timestamp)}` : undefined}
        >
          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              className="px-2 py-1 rounded bg-dji-blue text-white hover:bg-dji-blue/80"
              onClick={handleLoadKmzMission}
            >
              Load KMZ into Plan
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-200 bg-gray-800/50 hover:bg-gray-700/60"
              onClick={handleSaveKmzMission}
            >
              Export Plan as KMZ
            </button>
            {lastLoadedKmz?.path && (
              <button
                type="button"
                className="px-2 py-1 rounded border border-gray-700 text-gray-200 hover:text-white hover:border-gray-500"
                onClick={() => handleCopyMissionPath(lastLoadedKmz.path!)}
              >
                Copy KMZ Path
              </button>
            )}
          </div>
          <div className="mt-2 text-[10px] text-gray-500">
            Imports a DJI Waypoint KMZ into the mission planner for review and simulation. Execute manually once satisfied with the plan.
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Mission Plan (beta)"
          storageKey="missionControl.section.plan"
          summary={missionPlan.length ? `${missionPlan.length} entries` : undefined}
        >
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-gray-400 uppercase">Mission tools</span>
            {missionPlan.length > 0 && (
              <button
                type="button"
                className="px-2 py-0.5 text-[10px] border border-gray-700 rounded text-gray-300 hover:text-white hover:border-gray-500"
                onClick={clearMissionPlan}
              >
                Clear Plan
              </button>
            )}
          </div>
          <div className="space-y-2 text-[11px]">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border border-status-good/50 bg-status-good/20 text-status-good px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addWaypointToPlan}
                disabled={!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null}
              >
                Add Staged Target
              </button>
              <button
                type="button"
                className="rounded border border-emerald-500/60 bg-emerald-500/15 text-emerald-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addReturnHomeToPlan}
                disabled={!hasHomeLocation}
              >
                Add Return Home
              </button>
              <button
                type="button"
                className="rounded border border-rose-500/60 bg-rose-500/15 text-rose-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addLandToPlan}
                disabled={missionPlan.length === 0 && !hasLandingCoordinate}
              >
                Add Land
              </button>
              <button
                type="button"
                className="rounded border border-sky-500/60 bg-sky-500/15 text-sky-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addHomeWaypointToPlan}
                disabled={!hasHomeLocation}
              >
                Add Home Waypoint
              </button>
              <button
                type="button"
                className="rounded border border-indigo-500/60 bg-indigo-500/15 text-indigo-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addOriginWaypointToPlan}
                disabled={missionPlan.length === 0}
              >
                Add Origin (W1)
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-300">
              <span className="text-gray-400 uppercase">POI Tools</span>
              <button
                type="button"
                className="rounded border border-purple-500/60 bg-purple-500/15 text-purple-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addOrbitToPlan}
                disabled={!canAssignPoi}
              >
                Use staged target
              </button>
              <button
                type="button"
                className="rounded border border-gray-600 bg-black/30 text-gray-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleClearPoiTarget}
                disabled={!poiTarget}
              >
                Clear POI
              </button>
            </div>
          </div>
          {missionPlan.length === 0 ? (
            <div className="text-[10px] text-gray-500">
              No mission plan entries. Stage a target and use the buttons above to build a multi-point mission or assign a POI.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-32 overflow-y-auto text-[10px] text-gray-300">
              {missionPlan.map((entry, index) => {
                const entryLabel = entry.kind === 'orbit'
                  ? `Orbit ${index + 1}`
                  : entry.kind === 'return_home'
                    ? 'Return Home'
                    : entry.kind === 'land'
                      ? 'Land'
                      : `Waypoint ${index + 1}`;
                const altitudeValue = entry.altitude ?? '';
                const gimbalAction = entry.actions?.find((action) => action.type === 'gimbal_pitch') as
                  | { type: 'gimbal_pitch'; pitch: number; timing?: 'before' | 'after' }
                  | undefined;
                const isExpanded = Boolean(expandedEntries[entry.id]);
                const turnModeValue = entry.turn?.mode ?? 'auto';
                const turnDampingValue = entry.turn?.damping ?? '';
                const turnStraightValue = entry.turn?.useStraightLine == null
                  ? 'inherit'
                  : entry.turn?.useStraightLine
                    ? 'true'
                    : 'false';
                const headingModeValue = entry.heading?.mode ?? 'inherit';
                const headingAngleValue = entry.heading?.angle ?? '';
                const headingAngleEnabled = entry.heading?.angleEnable ?? headingModeValue === 'fixed';
                const yawPathModeValue = entry.heading?.yawPathMode ?? '';
                const yawBaseValue = entry.heading?.yawBase ?? '';
                const poiTarget = entry.poi ?? entry.heading?.poi ?? null;
                const poiLatitudeValue = poiTarget?.latitude ?? '';
                const poiLongitudeValue = poiTarget?.longitude ?? '';
                const poiAltitudeValue = poiTarget?.altitude ?? '';
                const gimbalHeadingModeValue = entry.gimbalHeading?.mode ?? 'none';
                const gimbalHeadingPitchValue = entry.gimbalHeading?.pitch ?? '';
                const gimbalHeadingYawValue = entry.gimbalHeading?.yaw ?? '';
                const gimbalStrategyValue = entry.gimbalStrategy ?? '';
                const altitudeReferenceValue = entry.altitudeReference ?? 'inherit';
                const actionGroups = entry.actionGroups ?? [];

                const ensureTurnUpdate = (updates: Partial<WaypointTurnConfig> | null, overrideMode?: string) => {
                  if (updates === null) {
                    updatePlanEntryTurn(entry.id, null);
                    return;
                  }
                  const base: WaypointTurnConfig = {
                    ...(entry.turn ?? {}),
                    ...updates,
                  };
                  if (overrideMode) {
                    base.mode = overrideMode as WaypointTurnConfig['mode'];
                  }
                  updatePlanEntryTurn(entry.id, base);
                };

                const ensureHeadingUpdate = (updates: Partial<WaypointHeadingConfig> | null, modeOverride?: string | null) => {
                  if (modeOverride === null) {
                    updatePlanEntryHeading(entry.id, null);
                    return;
                  }
                  if (updates === null) {
                    updatePlanEntryHeading(entry.id, null);
                    return;
                  }
                  const base: WaypointHeadingConfig = {
                    ...(entry.heading ?? {}),
                    ...updates,
                  };
                  if (modeOverride) {
                    base.mode = modeOverride as WaypointHeadingConfig['mode'];
                  }
                  updatePlanEntryHeading(entry.id, base);
                };

                const ensureGimbalHeadingUpdate = (updates: Partial<WaypointGimbalHeadingConfig> | null, modeOverride?: string | null) => {
                  if (modeOverride === null || updates === null) {
                    updatePlanEntryGimbalHeading(entry.id, null);
                    return;
                  }
                  const base: WaypointGimbalHeadingConfig = {
                    ...(entry.gimbalHeading ?? {}),
                    ...updates,
                  };
                  if (modeOverride) {
                    base.mode = modeOverride as WaypointGimbalHeadingConfig['mode'];
                  }
                  updatePlanEntryGimbalHeading(entry.id, base);
                };

                const resolveGroupKey = (group: WaypointActionGroup, groupIndex: number): string => {
                  const keySource = group.id ?? `${entry.id}-${groupIndex}`;
                  return `${keySource}`;
                };

                return (
                  <div
                    key={entry.id}
                    className="border border-gray-700/60 rounded px-2 py-2 bg-black/30"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="text-xs text-gray-300 hover:text-white"
                            onClick={() => togglePlanEntryExpanded(entry.id)}
                            aria-label={isExpanded ? 'Collapse waypoint details' : 'Expand waypoint details'}
                          >
                            {isExpanded ? '▾' : '▸'}
                          </button>
                          <div className="font-semibold text-gray-200">{entryLabel}</div>
                          {entry.kind === 'orbit' && entry.radius && (
                            <span className="text-purple-200 text-[10px]">
                              Radius {entry.radius} m · {entry.turns ?? 1} turn{(entry.turns ?? 1) === 1 ? '' : 's'}
                            </span>
                          )}
                          {entry.kind === 'return_home' && (
                            <span className="text-emerald-200 text-[10px]">Return-to-Home finish</span>
                          )}
                          {entry.kind === 'land' && (
                            <span className="text-rose-200 text-[10px]">Land in place</span>
                          )}
                        </div>
                        <div className="text-gray-400">
                          {entry.latitude.toFixed(6)}, {entry.longitude.toFixed(6)}
                        </div>
                        <div className="flex flex-wrap gap-2 items-center text-[10px] text-gray-300">
                          <label className="flex items-center gap-1">
                            <span>Altitude (AMSL)</span>
                            <input
                              type="number"
                              value={altitudeValue}
                              onChange={(event) => {
                                const raw = event.target.value;
                                if (raw === '') {
                                  updatePlanEntryAltitude(entry.id, null);
                                  return;
                                }
                                const numeric = Number(raw);
                                if (Number.isFinite(numeric)) {
                                  updatePlanEntryAltitude(entry.id, numeric);
                                }
                              }}
                              className="w-24 bg-black/40 border border-gray-700/70 rounded px-1 py-0.5 text-right"
                            />
                          </label>
                          <label className="flex items-center gap-1">
                            <span>Gimbal pitch (°)</span>
                            <input
                              type="number"
                              value={gimbalAction ? gimbalAction.pitch : ''}
                              min={-90}
                              max={30}
                              onChange={(event) => {
                                const raw = event.target.value;
                                if (raw === '') {
                                  updatePlanEntryGimbalPitch(entry.id, null);
                                  return;
                                }
                                const numeric = Number(raw);
                                if (Number.isFinite(numeric)) {
                                  updatePlanEntryGimbalPitch(entry.id, numeric);
                                }
                              }}
                              className="w-20 bg-black/40 border border-gray-700/70 rounded px-1 py-0.5 text-right"
                            />
                          </label>
                          {gimbalAction && (
                            <button
                              type="button"
                              className="text-[10px] text-gray-400 hover:text-gray-200"
                              onClick={() => updatePlanEntryGimbalPitch(entry.id, null)}
                            >
                              Clear pitch cue
                            </button>
                          )}
                          {entry.altitudeReference && (
                            <span className="ml-auto text-[10px] text-gray-400">
                              Ref: {entry.altitudeReference.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="text-status-error text-[10px] border border-status-error/60 rounded px-1 py-0.5 hover:bg-status-error/10"
                        onClick={() => removePlanEntry(entry.id)}
                      >
                        Remove
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="mt-2 space-y-2 border-t border-gray-700/50 pt-2">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div className="border border-gray-700/50 rounded px-2 py-2 bg-black/20">
                            <div className="text-[10px] uppercase text-gray-400 mb-1">Turn</div>
                            <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-300">
                              <label className="flex flex-col gap-1">
                                <span>Mode</span>
                                <select
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={turnModeValue}
                                  onChange={(event) => {
                                    const next = event.target.value;
                                    if (next === 'auto') {
                                      updatePlanEntryTurn(entry.id, null);
                                    } else {
                                      ensureTurnUpdate({ mode: next as WaypointTurnConfig['mode'] });
                                    }
                                  }}
                                >
                                  {TURN_MODE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                  {!TURN_MODE_OPTIONS.some((option) => option.value === turnModeValue) && turnModeValue !== 'auto' && (
                                    <option value={turnModeValue}>{turnModeValue}</option>
                                  )}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Damping (m)</span>
                                <input
                                  type="number"
                                  className="w-20 bg-black/40 border border-gray-700/70 rounded px-2 py-1 text-right"
                                  value={turnDampingValue === '' ? '' : turnDampingValue}
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    if (raw === '') {
                                      const next = { ...(entry.turn ?? {}) };
                                      delete next.damping;
                                      const hasOtherKeys = Object.keys(next).length > 0;
                                      updatePlanEntryTurn(entry.id, hasOtherKeys ? next : null);
                                      return;
                                    }
                                    const numeric = Number(raw);
                                    if (Number.isFinite(numeric)) {
                                      ensureTurnUpdate({ damping: numeric });
                                    }
                                  }}
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Straight line</span>
                                <select
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={turnStraightValue}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    if (value === 'inherit') {
                                      const next = { ...(entry.turn ?? {}) };
                                      delete next.useStraightLine;
                                      const hasOther = Object.keys(next).length > 0;
                                      updatePlanEntryTurn(entry.id, hasOther ? next : null);
                                      return;
                                    }
                                    ensureTurnUpdate({ useStraightLine: value === 'true' });
                                  }}
                                >
                                  <option value="inherit">Inherit</option>
                                  <option value="false">Allow curvature</option>
                                  <option value="true">Force straight line</option>
                                </select>
                              </label>
                            </div>
                          </div>

                          <div className="border border-gray-700/50 rounded px-2 py-2 bg-black/20">
                            <div className="text-[10px] uppercase text-gray-400 mb-1">Heading</div>
                            <div className="flex flex-wrap gap-2 text-[10px] text-gray-300">
                              <label className="flex flex-col gap-1">
                                <span>Mode</span>
                                <select
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={headingModeValue}
                                  onChange={(event) => {
                                    const nextMode = event.target.value;
                                    if (nextMode === 'inherit') {
                                      updatePlanEntryHeading(entry.id, null);
                                      return;
                                    }
                                    ensureHeadingUpdate({
                                      mode: nextMode as WaypointHeadingConfig['mode'],
                                      ...(nextMode === 'towardPOI' && (entry.poi || poiTarget)
                                        ? { poi: entry.poi ?? poiTarget ?? undefined }
                                        : {}),
                                    });
                                  }}
                                >
                                  {HEADING_MODE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                  {!HEADING_MODE_OPTIONS.some((option) => option.value === headingModeValue) && headingModeValue !== 'inherit' && (
                                    <option value={headingModeValue}>{headingModeValue}</option>
                                  )}
                                </select>
                              </label>
                              {headingModeValue === 'fixed' && (
                                <label className="flex flex-col gap-1">
                                  <span>Angle (°)</span>
                                  <input
                                    type="number"
                                    className="w-16 bg-black/40 border border-gray-700/70 rounded px-2 py-1 text-right"
                                    value={headingAngleValue === '' ? '' : headingAngleValue}
                                    onChange={(event) => {
                                      const raw = event.target.value;
                                      if (raw === '') {
                                        ensureHeadingUpdate({ angle: undefined, angleEnable: undefined }, 'fixed');
                                        return;
                                      }
                                      const numeric = Number(raw);
                                      if (Number.isFinite(numeric)) {
                                        ensureHeadingUpdate({ angle: numeric, angleEnable: true }, 'fixed');
                                      }
                                    }}
                                  />
                                </label>
                              )}
                              {headingModeValue === 'fixed' && (
                                <label className="flex items-center gap-1 mt-4">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(headingAngleEnabled)}
                                    onChange={(event) => {
                                      ensureHeadingUpdate({ angleEnable: event.target.checked }, 'fixed');
                                    }}
                                  />
                                  <span>Enable angle lock</span>
                                </label>
                              )}
                              {(headingModeValue === 'towardPOI' || headingModeValue === 'followWayline') && (
                                <label className="flex flex-col gap-1">
                                  <span>Yaw path mode</span>
                                  <input
                                    type="text"
                                    className="w-32 bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                    value={yawPathModeValue}
                                    onChange={(event) => {
                                      const value = event.target.value.trim();
                                      ensureHeadingUpdate({ yawPathMode: value || undefined }, headingModeValue);
                                    }}
                                  />
                                </label>
                              )}
                              <label className="flex flex-col gap-1">
                                <span>Yaw base</span>
                                <input
                                  type="text"
                                  className="w-24 bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={yawBaseValue}
                                  onChange={(event) => {
                                    const value = event.target.value.trim();
                                    ensureHeadingUpdate({ yawBase: value || undefined }, headingModeValue === 'inherit' ? undefined : headingModeValue);
                                  }}
                                />
                              </label>
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div className="border border-gray-700/50 rounded px-2 py-2 bg-black/20">
                            <div className="flex items-center justify-between mb-1">
                              <div className="text-[10px] uppercase text-gray-400">Point of Interest</div>
                              <div className="flex items-center gap-1 text-[10px] text-gray-400">
                                <button
                                  type="button"
                                  className="underline hover:text-white"
                                  onClick={() => {
                                    if (activeTarget && activeTarget.latitude != null && activeTarget.longitude != null) {
                                      updatePlanEntryPoi(entry.id, {
                                        latitude: clampLat(activeTarget.latitude),
                                        longitude: clampLon(activeTarget.longitude),
                                        altitude: activeTarget.altitude ?? null,
                                      });
                                    }
                                  }}
                                  disabled={!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null}
                                >
                                  Use target
                                </button>
                                <button
                                  type="button"
                                  className="underline hover:text-white"
                                  onClick={() => {
                                    if (homeLocation?.latitude != null && homeLocation?.longitude != null) {
                                      updatePlanEntryPoi(entry.id, {
                                        latitude: clampLat(homeLocation.latitude),
                                        longitude: clampLon(homeLocation.longitude),
                                        altitude: homeLocation.altitude ?? null,
                                      });
                                    }
                                  }}
                                  disabled={!homeLocation?.latitude || !homeLocation?.longitude}
                                >
                                  Use home
                                </button>
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-[10px] text-gray-300">
                              <label className="flex flex-col gap-1">
                                <span>Latitude</span>
                                <input
                                  type="number"
                                  value={poiLatitudeValue === '' ? '' : poiLatitudeValue}
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    if (raw === '') {
                                      updatePlanEntryPoi(entry.id, null);
                                      return;
                                    }
                                    const numeric = Number(raw);
                                    if (Number.isFinite(numeric)) {
                                      const fallbackLon = poiTarget?.longitude ?? entry.longitude;
                                      const fallbackAlt = poiTarget?.altitude ?? entry.altitude ?? null;
                                      updatePlanEntryPoi(entry.id, {
                                        latitude: clampLat(numeric),
                                        longitude: clampLon(fallbackLon),
                                        altitude: fallbackAlt,
                                      });
                                    }
                                  }}
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Longitude</span>
                                <input
                                  type="number"
                                  value={poiLongitudeValue === '' ? '' : poiLongitudeValue}
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    if (raw === '') {
                                      updatePlanEntryPoi(entry.id, null);
                                      return;
                                    }
                                    const numeric = Number(raw);
                                    if (Number.isFinite(numeric)) {
                                      const fallbackLat = poiTarget?.latitude ?? entry.latitude;
                                      const fallbackAlt = poiTarget?.altitude ?? entry.altitude ?? null;
                                      updatePlanEntryPoi(entry.id, {
                                        latitude: clampLat(fallbackLat),
                                        longitude: clampLon(numeric),
                                        altitude: fallbackAlt,
                                      });
                                    }
                                  }}
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Altitude (m)</span>
                                <input
                                  type="number"
                                  value={poiAltitudeValue === '' ? '' : poiAltitudeValue}
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    if (raw === '') {
                                      if (poiTarget) {
                                        updatePlanEntryPoi(entry.id, { ...poiTarget, altitude: null });
                                      }
                                      return;
                                    }
                                    const numeric = Number(raw);
                                    if (Number.isFinite(numeric)) {
                                      const fallbackLat = poiTarget?.latitude ?? entry.latitude;
                                      const fallbackLon = poiTarget?.longitude ?? entry.longitude;
                                      updatePlanEntryPoi(entry.id, {
                                        latitude: clampLat(fallbackLat),
                                        longitude: clampLon(fallbackLon),
                                        altitude: numeric,
                                      });
                                    }
                                  }}
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                />
                              </label>
                            </div>
                          </div>

                          <div className="border border-gray-700/50 rounded px-2 py-2 bg-black/20">
                            <div className="text-[10px] uppercase text-gray-400 mb-1">Gimbal / Attitude</div>
                            <div className="flex flex-wrap gap-2 text-[10px] text-gray-300">
                              <label className="flex flex-col gap-1">
                                <span>Gimbal heading mode</span>
                                <select
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={gimbalHeadingModeValue}
                                  onChange={(event) => {
                                    const next = event.target.value;
                                    if (next === 'none') {
                                      updatePlanEntryGimbalHeading(entry.id, null);
                                      return;
                                    }
                                    ensureGimbalHeadingUpdate({}, next);
                                  }}
                                >
                                  {GIMBAL_HEADING_MODE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                  {!GIMBAL_HEADING_MODE_OPTIONS.some((option) => option.value === gimbalHeadingModeValue) && gimbalHeadingModeValue !== 'none' && (
                                    <option value={gimbalHeadingModeValue}>{gimbalHeadingModeValue}</option>
                                  )}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Pitch (°)</span>
                                <input
                                  type="number"
                                  className="w-16 bg-black/40 border border-gray-700/70 rounded px-2 py-1 text-right"
                                  value={gimbalHeadingPitchValue === '' ? '' : gimbalHeadingPitchValue}
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    if (raw === '') {
                                      ensureGimbalHeadingUpdate({ pitch: undefined }, gimbalHeadingModeValue === 'none' ? null : gimbalHeadingModeValue);
                                      return;
                                    }
                                    const numeric = Number(raw);
                                    if (Number.isFinite(numeric)) {
                                      ensureGimbalHeadingUpdate({ pitch: numeric }, gimbalHeadingModeValue === 'none' ? 'lock' : gimbalHeadingModeValue);
                                    }
                                  }}
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Yaw (°)</span>
                                <input
                                  type="number"
                                  className="w-16 bg-black/40 border border-gray-700/70 rounded px-2 py-1 text-right"
                                  value={gimbalHeadingYawValue === '' ? '' : gimbalHeadingYawValue}
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    if (raw === '') {
                                      ensureGimbalHeadingUpdate({ yaw: undefined }, gimbalHeadingModeValue === 'none' ? null : gimbalHeadingModeValue);
                                      return;
                                    }
                                    const numeric = Number(raw);
                                    if (Number.isFinite(numeric)) {
                                      ensureGimbalHeadingUpdate({ yaw: numeric }, gimbalHeadingModeValue === 'none' ? 'lock' : gimbalHeadingModeValue);
                                    }
                                  }}
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Strategy</span>
                                <select
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={gimbalStrategyValue}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    updatePlanEntryGimbalStrategy(entry.id, value || null);
                                  }}
                                >
                                  {GIMBAL_STRATEGY_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                  {gimbalStrategyValue && !GIMBAL_STRATEGY_OPTIONS.some((option) => option.value === gimbalStrategyValue) && (
                                    <option value={gimbalStrategyValue}>{gimbalStrategyValue}</option>
                                  )}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1">
                                <span>Altitude ref</span>
                                <select
                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                  value={altitudeReferenceValue}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    if (value === 'inherit') {
                                      updatePlanEntryAltitudeReference(entry.id, null);
                                    } else {
                                      updatePlanEntryAltitudeReference(entry.id, value as AltitudeReferenceMode);
                                    }
                                  }}
                                >
                                  {ALTITUDE_REFERENCE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                  {altitudeReferenceValue && !ALTITUDE_REFERENCE_OPTIONS.some((option) => option.value === altitudeReferenceValue) && (
                                    <option value={altitudeReferenceValue}>{altitudeReferenceValue}</option>
                                  )}
                                </select>
                              </label>
                            </div>
                          </div>
                        </div>

                        <div className="border border-gray-700/50 rounded px-2 py-2 bg-black/20">
                          <div className="flex items-center justify-between mb-1">
                            <div className="text-[10px] uppercase text-gray-400">Action groups</div>
                            <button
                              type="button"
                              className="text-[10px] text-gray-200 border border-gray-600 rounded px-1 py-0.5 hover:bg-gray-700/70"
                              onClick={() => addActionGroupToEntry(entry.id)}
                            >
                              Add group
                            </button>
                          </div>
                          {actionGroups.length === 0 ? (
                            <div className="text-[10px] text-gray-500">No action groups configured.</div>
                          ) : (
                            <div className="space-y-2">
                              {actionGroups.map((group, groupIndex) => {
                                const groupKey = resolveGroupKey(group, groupIndex);
                                return (
                                  <div key={groupKey} className="border border-gray-700/40 rounded px-2 py-2 bg-black/30">
                                    <div className="flex items-start justify-between gap-2 mb-1">
                                      <div className="text-gray-300 text-[10px] font-semibold">
                                        Group {groupIndex + 1}
                                      </div>
                                      <button
                                        type="button"
                                        className="text-[10px] text-status-error border border-status-error/60 rounded px-1 py-0.5 hover:bg-status-error/10"
                                        onClick={() => removeActionGroupFromEntry(entry.id, groupIndex, groupKey)}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] text-gray-300">
                                      <label className="flex flex-col gap-1">
                                        <span>Trigger</span>
                                        <select
                                          className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                          value={group.triggerType ?? ''}
                                          onChange={(event) => {
                                            const value = event.target.value;
                                            updateActionGroupMeta(entry.id, groupIndex, { triggerType: value || null });
                                          }}
                                        >
                                          <option value="">Default</option>
                                          {ACTION_TRIGGER_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>
                                              {option.label}
                                            </option>
                                          ))}
                                          {group.triggerType && !ACTION_TRIGGER_OPTIONS.some((option) => option.value === group.triggerType) && (
                                            <option value={group.triggerType}>{group.triggerType}</option>
                                          )}
                                        </select>
                                      </label>
                                      <label className="flex flex-col gap-1">
                                        <span>Mode</span>
                                        <input
                                          type="text"
                                          className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                          value={group.mode ?? ''}
                                          onChange={(event) => {
                                            const value = event.target.value.trim();
                                            updateActionGroupMeta(entry.id, groupIndex, { mode: value || null });
                                          }}
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1">
                                        <span>Start index</span>
                                        <input
                                          type="number"
                                          className="bg-black/40 border border-gray-700/70 rounded px-2 py-1 text-right"
                                          value={group.startIndex ?? ''}
                                          onChange={(event) => {
                                            const raw = event.target.value;
                                            const numeric = raw === '' ? null : Number(raw);
                                            if (raw === '' || Number.isFinite(numeric)) {
                                              updateActionGroupMeta(entry.id, groupIndex, { startIndex: numeric });
                                            }
                                          }}
                                        />
                                      </label>
                                      <label className="flex flex-col gap-1">
                                        <span>End index</span>
                                        <input
                                          type="number"
                                          className="bg-black/40 border border-gray-700/70 rounded px-2 py-1 text-right"
                                          value={group.endIndex ?? ''}
                                          onChange={(event) => {
                                            const raw = event.target.value;
                                            const numeric = raw === '' ? null : Number(raw);
                                            if (raw === '' || Number.isFinite(numeric)) {
                                              updateActionGroupMeta(entry.id, groupIndex, { endIndex: numeric });
                                            }
                                          }}
                                        />
                                      </label>
                                    </div>

                                    <div className="mt-2 space-y-2">
                                      {group.actions.map((action, actionIndex) => {
                                        const key = actionDraftKey(entry.id, groupKey, actionIndex);
                                        const draftValue = actionParamDrafts[key] ?? JSON.stringify(action.params ?? {}, null, 2);
                                        const errorMessage = actionParamErrors[key];
                                        return (
                                          <div key={key} className="border border-gray-700/40 rounded px-2 py-2 bg-black/40">
                                            <div className="flex items-start justify-between gap-2">
                                              <label className="flex flex-col gap-1 text-[10px] text-gray-300 flex-1">
                                                <span>Function</span>
                                                <input
                                                  type="text"
                                                  value={action.func}
                                                  onChange={(event) => {
                                                    const value = event.target.value.trim();
                                                    updateActionInGroup(entry.id, groupIndex, actionIndex, { func: value || action.func });
                                                  }}
                                                  className="bg-black/40 border border-gray-700/70 rounded px-2 py-1"
                                                />
                                              </label>
                                              <button
                                                type="button"
                                                className="text-[10px] text-status-error border border-status-error/60 rounded px-1 py-0.5 hover:bg-status-error/10"
                                                onClick={() => removeActionFromGroup(entry.id, groupIndex, actionIndex, groupKey)}
                                              >
                                                Remove
                                              </button>
                                            </div>
                                            <div className="mt-1 text-[10px] text-gray-300">
                                              <span className="block mb-1">Parameters (JSON)</span>
                                              <textarea
                                                className="w-full h-20 bg-black/40 border border-gray-700/70 rounded px-2 py-1 font-mono text-[10px]"
                                                value={draftValue}
                                                onChange={(event) => {
                                                  const value = event.target.value;
                                                  setActionParamDrafts((prev) => ({
                                                    ...prev,
                                                    [key]: value,
                                                  }));
                                                }}
                                                onBlur={() => {
                                                  const draft = actionParamDrafts[key] ?? JSON.stringify(action.params ?? {}, null, 2);
                                                  try {
                                                    const parsed = draft.trim() ? JSON.parse(draft) : {};
                                                    updateActionInGroup(entry.id, groupIndex, actionIndex, {}, () => parsed);
                                                    setActionParamDrafts((prev) => {
                                                      if (!(key in prev)) return prev;
                                                      const next = { ...prev };
                                                      delete next[key];
                                                      return next;
                                                    });
                                                    setActionParamErrors((prev) => {
                                                      if (!(key in prev)) return prev;
                                                      const next = { ...prev };
                                                      delete next[key];
                                                      return next;
                                                    });
                                                  } catch (error) {
                                                    const message = error instanceof Error ? error.message : 'Invalid JSON';
                                                    setActionParamErrors((prev) => ({
                                                      ...prev,
                                                      [key]: message,
                                                    }));
                                                  }
                                                }}
                                              />
                                              {errorMessage && (
                                                <div className="mt-1 text-status-error">{errorMessage}</div>
                                              )}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <button
                                      type="button"
                                      className="mt-2 text-[10px] text-gray-200 border border-gray-600 rounded px-1 py-0.5 hover:bg-gray-700/70"
                                      onClick={() => addActionToGroup(entry.id, groupIndex)}
                                    >
                                      Add action
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3">
            <div className="text-gray-400 uppercase text-[11px] mb-1">Waypoint Actions Catalog</div>
            <ul className="text-[10px] text-gray-300 space-y-1 border border-gray-700/60 rounded px-2 py-1 bg-black/30">
              {WAYPOINT_ACTION_CATALOG.map((action) => (
                <li key={action.id}>
                  <span className="text-gray-100 font-semibold">{action.label}</span>
                  <span className="ml-2 text-gray-400">{action.description}</span>
                </li>
              ))}
            </ul>
            <div className="text-[10px] text-gray-500 mt-1">
              Use the controls above to set heading, POI, turn modes, and action groups per waypoint; the catalog lists the most common cues.
            </div>
          </div>
          {missionPlan.length > 0 && (
            <div className="mt-2 flex flex-col gap-1 text-[10px]">
              <button
                type="button"
                className="px-2 py-1 rounded bg-gray-800/60 border border-gray-600 text-gray-200 hover:bg-gray-700/70"
                onClick={handleSimulateMission}
              >
                Simulate Mission Plan
              </button>
              <button
                type="button"
                className="px-2 py-1 rounded bg-dji-blue text-white hover:bg-dji-blue/80 disabled:bg-gray-700 disabled:text-gray-400"
                onClick={() => handleExecuteMissionPlan()}
                disabled={!telemetry?.location}
              >
                Execute Mission Plan ({missionPlan.length} waypoint{missionPlan.length === 1 ? '' : 's'})
              </button>
              <div className="text-gray-500">
                Converts the staged mission into a Waypoint V3 mission via the bridge; verify simulator or bench before live flight.
              </div>
            </div>
            )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Mission Execution"
          storageKey="missionControl.section.execution"
          summary={missionStateLabel}
        >
          <div className="flex items-center gap-2 text-[10px] text-gray-500">
            <span>State</span>
            <span className={`px-2 py-0.5 rounded border ${missionStateClassName(missionStateRaw)}`}>
              {missionStateLabel}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="px-2 py-1 rounded bg-gray-800/60 border border-gray-600 text-gray-200 hover:bg-gray-700/70 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handlePauseMission}
              disabled={!canPauseMission}
            >
              Pause
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded bg-gray-800/60 border border-gray-600 text-gray-200 hover:bg-gray-700/70 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleResumeMission}
              disabled={!canResumeMission}
            >
              Resume
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded bg-status-error/20 border border-status-error/60 text-status-error disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleStopMission}
              disabled={!missionActive}
            >
              Stop
            </button>
          </div>
        </CollapsibleSection>
      </div>
    </Panel>
  );
};
