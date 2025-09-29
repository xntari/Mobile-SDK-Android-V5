import React from 'react';
import JSZip from 'jszip';
import { Panel } from './Panel';
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
} from '../types/missionPlanner';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { missionPlannerStore } from '../state/missionPlanner';

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
}

const MAX_LOG_ENTRIES = 40;
const clampAltitude = (value: number) => Math.max(-500, Math.min(6000, value));

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
  const [distanceMeters, setDistanceMeters] = React.useState<number>(5);
  const [verticalMeters, setVerticalMeters] = React.useState<number>(2);
  const [maxSpeed, setMaxSpeed] = React.useState<number>(10);
  const [securityTakeoffHeight, setSecurityTakeoffHeight] = React.useState<number>(20);
  const [flyToMode, setFlyToMode] = React.useState<'smart_height' | 'set_height'>('set_height');
  const [flyToHeight, setFlyToHeight] = React.useState<number>(20);
  const [logEntries, setLogEntries] = React.useState<MissionLogEntry[]>([]);
  const [manualTarget, setManualTarget] = React.useState<ManualTargetState>({ latitude: null, longitude: null, altitude: null });
  const [placingTarget, setPlacingTarget] = React.useState<boolean>(false);
  const [simPreview, setSimPreview] = React.useState<SimulationPreview | null>(null);
  const [missionPlan, setMissionPlan] = React.useState<PlannedMissionEntry[]>([]);
  const [orbitRadius, setOrbitRadius] = React.useState<number>(25);
  const [orbitTurns, setOrbitTurns] = React.useState<number>(1);
  const [lastLaserFix, setLastLaserFix] = React.useState<{ latitude: number; longitude: number; altitude?: number } | null>(null);
  const [targetSelection, setTargetSelection] = React.useState<ObjectMemoryTargetSelection | null>(() =>
    objectMemoryTargetStore.getCurrent(),
  );
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const lastAckRef = React.useRef<number | null>(null);
  const lastWaypointStateRef = React.useRef<string | null>(null);
  const lastWaypointIndexRef = React.useRef<string | null>(null);
  const waypointTimelineSeenRef = React.useRef<Set<string>>(new Set());
  const [lastLoadedKmz, setLastLoadedKmz] = React.useState<{
    name: string;
    path?: string;
    sizeBytes?: number;
    timestamp: number;
  } | null>(null);

  React.useEffect(() => objectMemoryTargetStore.subscribe(setTargetSelection), []);

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

  const ensureTelemetry = (): TelemetryData | null => {
    if (!telemetry || !telemetry.location) {
      setStatusMessage('Telemetry unavailable — cannot compute target.');
      return null;
    }
    return telemetry;
  };

  const computeDefaultTargetAltitude = React.useCallback((): number | null => {
    const takeoffAltitudeAsl = telemetry?.takeoff_altitude
      ?? telemetry?.home_location?.altitude
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? null;

    if (flyToMode === 'set_height' && Number.isFinite(flyToHeight)) {
      if (takeoffAltitudeAsl != null) {
        return takeoffAltitudeAsl + flyToHeight;
      }
      const baseAlt = telemetry?.location?.altitude ?? telemetry?.altitude;
      return typeof baseAlt === 'number' ? baseAlt + flyToHeight : null;
    }

    if (Number.isFinite(securityTakeoffHeight)) {
      if (takeoffAltitudeAsl != null) {
        return takeoffAltitudeAsl + securityTakeoffHeight;
      }
      const baseAlt = telemetry?.location?.altitude ?? telemetry?.altitude;
      return typeof baseAlt === 'number' ? baseAlt + securityTakeoffHeight : null;
    }

    return telemetry?.location?.altitude ?? telemetry?.altitude ?? null;
  }, [flyToHeight, flyToMode, securityTakeoffHeight, telemetry?.altitude, telemetry?.location?.altitude, telemetry?.home_location?.altitude, telemetry?.takeoff_altitude]);

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
    missionPlannerStore.setPlan(missionPlan);
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

  const defaultTargetAltitudePreview = computeDefaultTargetAltitude();
  const homeLocation = telemetry?.home_location;
  const hasHomeLocation = Boolean(homeLocation
    && Number.isFinite(homeLocation.latitude)
    && Number.isFinite(homeLocation.longitude));
  const hasLandingCoordinate = hasHomeLocation
    || Boolean(telemetry?.location
      && Number.isFinite(telemetry.location.latitude)
      && Number.isFinite(telemetry.location.longitude));

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

  const handleClearMissionLog = React.useCallback(() => {
    setLogEntries([]);
    setStatusMessage('Mission timeline cleared');
  }, []);

  const addWaypointToPlan = React.useCallback(() => {
    if (!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Stage a target before adding a waypoint to the plan.');
      return;
    }
    const altitudeCandidate = defaultTargetAltitudePreview
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? activeTarget.altitude
      ?? null;
    const entry: PlannedMissionEntry = {
      id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'waypoint',
      latitude: activeTarget.latitude,
      longitude: activeTarget.longitude,
      altitude: altitudeCandidate,
    };
    setMissionPlan((prev) => [...prev, entry]);
    appendLog('Plan waypoint added', entry, 'manual');
    setStatusMessage('Waypoint added to mission plan.');
  }, [activeTarget, telemetry?.location?.altitude, telemetry?.altitude, appendLog, defaultTargetAltitudePreview]);

  const addOrbitToPlan = React.useCallback(() => {
    if (!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Stage a target before adding an orbit.');
      return;
    }
    if (!Number.isFinite(orbitRadius) || orbitRadius <= 0) {
      setStatusMessage('Orbit radius must be a positive number.');
      return;
    }
    if (!Number.isFinite(orbitTurns) || orbitTurns <= 0) {
      setStatusMessage('Orbit turns must be at least 1.');
      return;
    }
    const radiusMeters = Math.max(5, Math.round(orbitRadius));
    const turns = Math.max(1, Math.round(orbitTurns));
    const altitudeCandidate = defaultTargetAltitudePreview
      ?? telemetry?.location?.altitude
      ?? telemetry?.altitude
      ?? activeTarget.altitude
      ?? null;
    const entry: PlannedMissionEntry = {
      id: `orbit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'orbit',
      latitude: activeTarget.latitude,
      longitude: activeTarget.longitude,
      altitude: altitudeCandidate,
      radius: radiusMeters,
      turns,
    };
    setMissionPlan((prev) => [...prev, entry]);
    appendLog('Plan orbit added', entry, 'manual');
    setStatusMessage(`Orbit added (radius ${radiusMeters} m, ${turns} turn${turns === 1 ? '' : 's'}).`);
  }, [activeTarget, telemetry?.location?.altitude, telemetry?.altitude, orbitRadius, orbitTurns, appendLog, defaultTargetAltitudePreview]);

  const addReturnHomeToPlan = React.useCallback(() => {
    const home = telemetry?.home_location;
    if (!home || !Number.isFinite(home.latitude) || !Number.isFinite(home.longitude)) {
      setStatusMessage('Home location unavailable; cannot add Return Home waypoint.');
      return;
    }

    const entry: PlannedMissionEntry = {
      id: `return-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'return_home',
      latitude: clampLat(home.latitude),
      longitude: clampLon(home.longitude),
      altitude: defaultTargetAltitudePreview ?? telemetry?.takeoff_altitude ?? telemetry?.location?.altitude ?? null,
    };
    setMissionPlan((prev) => [...prev, entry]);
    appendLog('Plan return-to-home added', entry, 'manual');
    setStatusMessage('Return-to-home added to mission plan.');
  }, [telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.takeoff_altitude, telemetry?.location?.altitude, appendLog, defaultTargetAltitudePreview]);

  const addLandToPlan = React.useCallback(() => {
    const landingCoordinate = telemetry?.home_location ?? telemetry?.location;
    if (!landingCoordinate || !Number.isFinite(landingCoordinate.latitude) || !Number.isFinite(landingCoordinate.longitude)) {
      setStatusMessage('Landing coordinate unavailable; cannot add Land waypoint.');
      return;
    }

    const landingAltitude = telemetry?.takeoff_altitude
      ?? telemetry?.location?.altitude
      ?? defaultTargetAltitudePreview
      ?? 0;

    const entry: PlannedMissionEntry = {
      id: `land-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'land',
      latitude: clampLat(landingCoordinate.latitude),
      longitude: clampLon(landingCoordinate.longitude),
      altitude: landingAltitude,
    };
    setMissionPlan((prev) => [...prev, entry]);
    appendLog('Plan land added', entry, 'manual');
    setStatusMessage('Landing step added to mission plan.');
  }, [telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.takeoff_altitude, telemetry?.location?.altitude, appendLog, defaultTargetAltitudePreview]);

  const removePlanEntry = React.useCallback((id: string) => {
    setMissionPlan((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const clearMissionPlan = React.useCallback(() => {
    setMissionPlan([]);
    setStatusMessage('Mission plan cleared.');
  }, []);

  const updatePlanEntryAltitude = React.useCallback((id: string, altitude: number | null) => {
    setMissionPlan((prev) => prev.map((entry) => (
      entry.id === id
        ? { ...entry, altitude }
        : entry
    )));
  }, []);

  const stageManualTarget = React.useCallback((next: ManualTargetState, context: Record<string, any>, message: string) => {
    const resolvedAltitude = typeof next.altitude === 'number' ? next.altitude : computeDefaultTargetAltitude();
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
  }, [appendLog, computeDefaultTargetAltitude]);

  React.useEffect(() => {
    const unsubscribeAdd = missionPlannerStore.onAddWaypointRequest((request) => {
      const { latitude, longitude } = request;
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return;
      }
      const clampedLat = clampLat(latitude);
      const clampedLon = clampLon(longitude);
      const altitudeCandidate = typeof request.altitude === 'number'
        ? request.altitude
        : (typeof manualTarget.altitude === 'number'
            ? manualTarget.altitude
            : computeDefaultTargetAltitude());

      if (request.kind === 'orbit') {
        const radius = request.radius ?? orbitRadius;
        const turns = request.turns ?? orbitTurns;
        const entry: PlannedMissionEntry = {
          id: `orbit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'orbit',
          latitude: clampedLat,
          longitude: clampedLon,
          altitude: altitudeCandidate,
          radius,
          turns,
        };
        setMissionPlan((prev) => [...prev, entry]);
        appendLog('Plan orbit added (map)', entry, 'manual');
        setStatusMessage(
          `Orbit added from map (radius ${radius} m, ${turns} turn${turns === 1 ? '' : 's'})`,
        );
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
        altitude: altitudeCandidate,
      };
      setMissionPlan((prev) => [...prev, entry]);
      appendLog('Plan waypoint added (map)', entry, 'manual');
      setStatusMessage('Waypoint added from map.');
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
    orbitRadius,
    orbitTurns,
    stageManualTarget,
    computeDefaultTargetAltitude,
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

      const parseKmzWaypoints = async (base64: string) => {
        const binary = atob(base64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          data[i] = binary.charCodeAt(i);
        }
        const zip = await JSZip.loadAsync(data);
        const waylineEntry = Object.keys(zip.files).find((name) => /waylines\.wpml$/i.test(name));
        if (!waylineEntry) {
          throw new Error('No waylines.wpml found in KMZ');
        }
        const xmlString = await zip.file(waylineEntry)!.async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, 'text/xml');
        const ns = 'http://www.dji.com/wpmz/1.0.6';
        const finishNode = doc.getElementsByTagNameNS(ns, 'finishAction')?.[0];
        const finishAction = finishNode?.textContent?.trim().toLowerCase() ?? '';
        const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
        const waypoints = placemarks.map((placemark) => {
          const coordText = placemark.getElementsByTagName('coordinates')?.[0]?.textContent ?? '';
          const executeHeightText = placemark.getElementsByTagNameNS(ns, 'executeHeight')?.[0]?.textContent ?? '';
          const parts = coordText.trim().split(',');
          const longitude = parseFloat(parts[0]);
          const latitude = parseFloat(parts[1]);
          const executeHeight = parseFloat(executeHeightText);
          return {
            latitude: Number.isFinite(latitude) ? latitude : NaN,
            longitude: Number.isFinite(longitude) ? longitude : NaN,
            relativeHeight: Number.isFinite(executeHeight) ? executeHeight : undefined,
          };
        }).filter((wp) => Number.isFinite(wp.latitude) && Number.isFinite(wp.longitude));

        return { waypoints, finishAction };
      };

      const { waypoints, finishAction } = await parseKmzWaypoints(selection.base64);

      if (!waypoints.length) {
        setStatusMessage('Loaded KMZ does not contain any waypoints.');
        return;
      }

      const baseAltitude = telemetry?.takeoff_altitude
        ?? telemetry?.home_location?.altitude
        ?? telemetry?.location?.altitude
        ?? telemetry?.altitude
        ?? 0;

      const resolvedPlan: PlannedMissionEntry[] = waypoints.map((wp, index) => {
        const altitudeAbs = wp.relativeHeight != null
          ? baseAltitude + wp.relativeHeight
          : defaultTargetAltitudePreview ?? baseAltitude;
        return {
          id: `kmz-${Date.now()}-${index}`,
          kind: 'waypoint',
          latitude: clampLat(wp.latitude),
          longitude: clampLon(wp.longitude),
          altitude: altitudeAbs,
        };
      });

      const augmentedPlan = [...resolvedPlan];
      const finalWaypoint = resolvedPlan[resolvedPlan.length - 1];
      if (finishAction === 'gohome') {
        const rthLat = telemetry?.home_location?.latitude ?? finalWaypoint.latitude;
        const rthLon = telemetry?.home_location?.longitude ?? finalWaypoint.longitude;
        augmentedPlan.push({
          id: `kmz-rth-${Date.now()}`,
          kind: 'return_home',
          latitude: clampLat(rthLat),
          longitude: clampLon(rthLon),
          altitude: defaultTargetAltitudePreview ?? baseAltitude,
        });
      } else if (finishAction === 'autoland') {
        const landingLat = telemetry?.home_location?.latitude ?? telemetry?.location?.latitude ?? finalWaypoint.latitude;
        const landingLon = telemetry?.home_location?.longitude ?? telemetry?.location?.longitude ?? finalWaypoint.longitude;
        augmentedPlan.push({
          id: `kmz-land-${Date.now()}`,
          kind: 'land',
          latitude: clampLat(landingLat),
          longitude: clampLon(landingLon),
          altitude: telemetry?.takeoff_altitude ?? baseAltitude,
        });
      }

      const sizeBytes = Math.floor((selection.base64.length * 3) / 4);
      const timestamp = Date.now();
      const metadata = {
        name: selection.name,
        path: selection.path,
        size_bytes: sizeBytes,
        selected_at: timestamp,
        waypoint_count: resolvedPlan.length,
        finish_action: finishAction,
      };

      appendLog('KMZ plan imported', metadata, 'kmz');
      setLastLoadedKmz({
        name: selection.name,
        path: selection.path,
        sizeBytes,
        timestamp,
      });
      setSimPreview(null);
      setMissionPlan(augmentedPlan);
      setStatusMessage(`Loaded KMZ into mission plan (${augmentedPlan.length} entries). Review and simulate before execution.`);
    } catch (error) {
      console.error('KMZ load failed', error);
      setStatusMessage(error instanceof Error ? error.message : 'Failed to load KMZ');
    }
  }, [appendLog, telemetry?.home_location?.latitude, telemetry?.home_location?.longitude, telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.takeoff_altitude, telemetry?.location?.altitude, telemetry?.altitude, defaultTargetAltitudePreview]);

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

    const baseAltitude = telemetry?.takeoff_altitude
      ?? telemetry?.home_location?.altitude
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

    const wpmlWaypoints = primaryWaypoints.map((entry, index) => {
      const latitude = clampLat(entry.latitude);
      const longitude = clampLon(entry.longitude);
      const altitude = typeof entry.altitude === 'number' ? entry.altitude : (defaultTargetAltitudePreview ?? baseAltitude);
      const relativeHeight = (altitude ?? baseAltitude) - baseAltitude;
      return `      <Placemark>
        <Point>
          <coordinates>
            ${longitude},${latitude}
          </coordinates>
        </Point>
        <wpml:index>${index}</wpml:index>
        <wpml:executeHeight>${relativeHeight.toFixed(3)}</wpml:executeHeight>
        <wpml:waypointSpeed>${globalSpeed}</wpml:waypointSpeed>
      </Placemark>`;
    }).join('\n');

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
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
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
    zip.file('waylines.wpml', wpml);
    zip.file('template.kml', templateKml);

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
  }, [missionPlan, telemetry?.takeoff_altitude, telemetry?.home_location?.altitude, telemetry?.location?.altitude, telemetry?.altitude, maxSpeed, securityTakeoffHeight, appendLog, defaultTargetAltitudePreview]);

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

    const takeoffAsl = telemetrySnapshot.takeoff_altitude ?? (
      (telemetrySnapshot.location.altitude ?? 0) - (telemetrySnapshot.altitude_above_takeoff ?? 0)
    );
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
      if ((kind === 'return_home' || kind === 'land') && homeLocation && Number.isFinite(homeLocation.latitude) && Number.isFinite(homeLocation.longitude)) {
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
  }, [telemetry, missionPlan, activeTarget, securityTakeoffHeight, maxSpeed, appendLog, defaultTargetAltitudePreview]);

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
    const takeoffAltitude = telemetrySnapshot.takeoff_altitude
      ?? (typeof baseAltitude === 'number' && typeof telemetrySnapshot.altitude_above_takeoff === 'number'
        ? baseAltitude - telemetrySnapshot.altitude_above_takeoff
        : undefined);
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

    const params: Record<string, any> = {
      target_location: {
        latitude,
        longitude,
        altitude: clampAltitude(resolvedAltitude),
      },
    };

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

  const handleExecuteMissionPlan = async () => {
    if (!missionPlan.length) {
      setStatusMessage('Add at least one waypoint to the mission plan before executing.');
      return;
    }

    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) {
      return;
    }

    const takeoffAltitudeAsl = telemetrySnapshot.takeoff_altitude
      ?? telemetrySnapshot.home_location?.altitude
      ?? telemetrySnapshot.location?.altitude
      ?? telemetrySnapshot.altitude
      ?? null;

    const defaultAltitudeAsl = (() => {
      if (typeof manualTarget.altitude === 'number') {
        return manualTarget.altitude;
      }
      if (takeoffAltitudeAsl != null && Number.isFinite(securityTakeoffHeight)) {
        return takeoffAltitudeAsl + securityTakeoffHeight;
      }
      if (typeof telemetrySnapshot.location?.altitude === 'number' && Number.isFinite(securityTakeoffHeight)) {
        return telemetrySnapshot.location.altitude + securityTakeoffHeight;
      }
      return telemetrySnapshot.location?.altitude ?? telemetrySnapshot.altitude ?? null;
    })();

    let finishAction: string = 'none';
    const planPayload: MissionPlanCommandEntry[] = missionPlan
      .map((entry) => {
        let latitude = entry.latitude;
        let longitude = entry.longitude;

        if ((entry.kind === 'return_home' || entry.kind === 'land') && homeLocation && Number.isFinite(homeLocation.latitude) && Number.isFinite(homeLocation.longitude)) {
          latitude = clampLat(homeLocation.latitude);
          longitude = clampLon(homeLocation.longitude);
        }

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        if (entry.kind === 'return_home') {
          finishAction = 'return_home';
        }
        if (entry.kind === 'land') {
          finishAction = 'land';
        }

        let altitudeAsl = typeof entry.altitude === 'number'
          ? entry.altitude
          : defaultAltitudeAsl;

        if (entry.kind === 'land') {
          altitudeAsl = takeoffAltitudeAsl ?? defaultAltitudeAsl ?? altitudeAsl ?? 0;
        }

        const payload: MissionPlanCommandEntry = {
          latitude,
          longitude,
          altitude: typeof altitudeAsl === 'number' ? altitudeAsl : null,
          kind: entry.kind,
        };
        if (typeof entry.radius === 'number') {
          payload.radius = entry.radius;
        }
        if (typeof entry.turns === 'number') {
          payload.turns = entry.turns;
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
    const targetAltitudeAsl = finalTarget.altitude
      ?? (takeoffAltitudeAsl != null && Number.isFinite(securityTakeoffHeight)
        ? takeoffAltitudeAsl + securityTakeoffHeight
        : takeoffAltitudeAsl);

    const commandPayload: Record<string, any> = {
      plan: planPayload.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        altitude: point.altitude,
        kind: point.kind,
        ...(typeof point.radius === 'number' ? { radius: point.radius } : {}),
        ...(typeof point.turns === 'number' ? { turns: point.turns } : {}),
      })),
      mode: flyToMode,
      security_takeoff_height: securityTakeoffHeight,
      reason: 'mission_plan',
      target_location: {
        latitude: finalTarget.latitude,
        longitude: finalTarget.longitude,
        altitude: targetAltitudeAsl ?? null,
      },
    };

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
        setStatusMessage(`Mission plan (${planPayload.length} waypoint${planPayload.length === 1 ? '' : 's'}) dispatched.`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'waypoint_execute_plan failed');
    }
  };

  const simulatorBadge = React.useMemo(() => getSimulatorModeBadge(telemetry?.simulator), [telemetry?.simulator]);
  const simulatorStatus = telemetry?.simulator;

  return (
    <Panel
      title="Mission Control"
      storageKey="flyto.panel"
      visibilityEventType="flyToPanelVisibilityChange"
      defaultPosition={{ x: 1040, y: 780 }}
      defaultSize={{ w: 340, h: 360 }}
    >
      <div className="flex flex-col gap-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        {statusMessage && (
          <div className="text-[11px] text-status-warning bg-black/40 border border-yellow-500/40 rounded px-2 py-1">
            {statusMessage}
          </div>
        )}

        <div className="flex flex-col gap-1 border border-gray-700/60 bg-black/30 rounded-md px-3 py-2 text-[11px] text-gray-300">
          <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex flex-wrap gap-3 text-gray-400">
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
        </div>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Mission Defaults</div>
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
          <div className="text-[10px] text-gray-500 mb-3">
            Default AMSL target: {defaultTargetAltitudePreview != null ? defaultTargetAltitudePreview.toFixed(1) : '—'} m
          </div>
          <div className="text-gray-400 uppercase text-[11px] mb-2">Manual Move Presets</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
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
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Vertical Move</div>
          <div className="flex items-center gap-3 mb-2">
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
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-gray-400 uppercase text-[11px]">Target & Planning</div>
            {manualTargetSourceLabel && (
              <div className="text-[10px] text-amber-300">Source: {manualTargetSourceLabel}</div>
            )}
          </div>
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
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <div className="text-gray-400 uppercase text-[11px]">KMZ Missions</div>
            {lastLoadedKmz && (
              <div className="text-[10px] text-gray-400 truncate">
                Last: <span className="text-gray-200">{lastLoadedKmz.name}</span>
                {lastLoadedKmz.sizeBytes ? (
                  <span className="text-gray-500"> · {formatBytes(lastLoadedKmz.sizeBytes)}</span>
                ) : null}
                <span className="text-gray-500"> · {formatRelativeTime(lastLoadedKmz.timestamp)}</span>
              </div>
            )}
          </div>
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
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-gray-400 uppercase text-[11px]">Mission Plan (beta)</div>
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
                disabled={!hasLandingCoordinate}
              >
                Add Land
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1 text-[10px] text-gray-300">
              <label className="flex items-center gap-1">
                Radius (m)
                <input
                  type="number"
                  value={orbitRadius}
                  min={5}
                  max={500}
                  onChange={(event) => setOrbitRadius(Number(event.target.value) || 0)}
                  className="w-16 bg-black/40 border border-gray-700/70 rounded px-1 py-0.5 text-right"
                />
              </label>
              <label className="flex items-center gap-1">
                Turns
                <input
                  type="number"
                  value={orbitTurns}
                  min={1}
                  max={10}
                  onChange={(event) => setOrbitTurns(Number(event.target.value) || 1)}
                  className="w-12 bg-black/40 border border-gray-700/70 rounded px-1 py-0.5 text-right"
                />
              </label>
              <button
                type="button"
                className="ml-auto rounded border border-purple-500/60 bg-purple-500/15 text-purple-200 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={addOrbitToPlan}
                disabled={!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null}
              >
                Add Orbit
              </button>
            </div>
          </div>
          {missionPlan.length === 0 ? (
            <div className="text-[10px] text-gray-500">
              No mission plan entries. Stage a target and use the buttons above to build a multi-point mission or orbit.
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
                return (
                  <div
                    key={entry.id}
                    className="flex items-start justify-between gap-2 border border-gray-700/60 rounded px-2 py-1 bg-black/30"
                  >
                    <div className="space-y-1">
                      <div className="font-semibold text-gray-200">{entryLabel}</div>
                      <div className="text-gray-400">
                        {entry.latitude.toFixed(6)}, {entry.longitude.toFixed(6)}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-gray-300">
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
                      </div>
                      {entry.kind === 'orbit' && entry.radius && (
                        <div className="text-purple-200">
                          Radius {entry.radius} m · {entry.turns ?? 1} turn{(entry.turns ?? 1) === 1 ? '' : 's'}
                        </div>
                      )}
                      {entry.kind === 'return_home' && (
                        <div className="text-emerald-200 text-[10px]">Will trigger Return-to-Home at mission end.</div>
                      )}
                      {entry.kind === 'land' && (
                        <div className="text-rose-200 text-[10px]">Will descend to the landing coordinate.</div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="text-status-error text-[10px] border border-status-error/60 rounded px-1 py-0.5 hover:bg-status-error/10"
                      onClick={() => removePlanEntry(entry.id)}
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
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
                onClick={handleExecuteMissionPlan}
                disabled={!telemetry?.location}
              >
                Execute Mission Plan ({missionPlan.length} waypoint{missionPlan.length === 1 ? '' : 's'})
              </button>
              <div className="text-gray-500">
                Converts the staged mission into a Waypoint V3 mission via the bridge; verify simulator or bench before live flight.
              </div>
            </div>
          )}
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <div className="text-gray-400 uppercase text-[11px]">Mission Execution</div>
            <div className="flex items-center gap-2 text-[10px] text-gray-500">
              <span>State</span>
              <span className={`px-2 py-0.5 rounded border ${missionStateClassName(missionStateRaw)}`}>
                {missionStateLabel}
              </span>
            </div>
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
        </section>
      </div>
    </Panel>
  );
};
