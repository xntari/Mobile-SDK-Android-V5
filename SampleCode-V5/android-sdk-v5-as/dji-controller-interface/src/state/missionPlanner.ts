import {
  PlannedMissionEntry,
  ManualTargetState,
  MissionPlannerSnapshot,
  MissionEntryKind,
  MissionWaypointTarget,
  PoiTarget,
  OrbitMode,
} from '../types/missionPlanner';

export interface MissionPlannerAddWaypointRequest {
  latitude: number;
  longitude: number;
  altitude?: number | null;
  kind?: MissionEntryKind;
  radius?: number;
  turns?: number;
  source?: string;
  turn?: PlannedMissionEntry['turn'];
  heading?: PlannedMissionEntry['heading'];
  gimbalHeading?: PlannedMissionEntry['gimbalHeading'];
  poi?: PlannedMissionEntry['poi'];
  gimbalStrategy?: PlannedMissionEntry['gimbalStrategy'];
  actionGroups?: PlannedMissionEntry['actionGroups'];
  altitudeReference?: PlannedMissionEntry['altitudeReference'];
}

export interface MissionPlannerStageTargetRequest {
  latitude: number;
  longitude: number;
  altitude?: number | null;
  source?: ManualTargetState['source'];
}

type PlanListener = (plan: PlannedMissionEntry[]) => void;
type ManualTargetListener = (target: ManualTargetState | null) => void;
type ActiveWaypointListener = (target: MissionWaypointTarget | null) => void;
type PoiListener = (poi: PoiTarget | null) => void;
type OrbitModeListener = (mode: OrbitMode) => void;
type AddWaypointRequestListener = (request: MissionPlannerAddWaypointRequest) => void;
type StageTargetRequestListener = (request: MissionPlannerStageTargetRequest) => void;
type ExecutePlanRequestListener = (context?: { source?: string }) => void;

const planListeners = new Set<PlanListener>();
const manualTargetListeners = new Set<ManualTargetListener>();
const activeWaypointListeners = new Set<ActiveWaypointListener>();
const poiListeners = new Set<PoiListener>();
const orbitModeListeners = new Set<OrbitModeListener>();
const addWaypointRequestListeners = new Set<AddWaypointRequestListener>();
const stageTargetRequestListeners = new Set<StageTargetRequestListener>();
const executePlanRequestListeners = new Set<ExecutePlanRequestListener>();

const clampLat = (value: number) => Math.max(-90, Math.min(90, value));
const clampLon = (value: number) => Math.max(-180, Math.min(180, value));

let snapshot: MissionPlannerSnapshot = {
  plan: [],
  manualTarget: null,
  activeWaypoint: null,
  poiTarget: null,
  orbitMode: 'none',
};

const clonePlan = (plan: PlannedMissionEntry[]): PlannedMissionEntry[] =>
  plan.map((entry) => ({
    ...entry,
    actions: entry.actions ? entry.actions.map((action) => ({ ...action })) : undefined,
    turn: entry.turn ? { ...entry.turn } : undefined,
    heading: entry.heading
      ? {
          ...entry.heading,
          poi: entry.heading.poi ? { ...entry.heading.poi } : undefined,
        }
      : undefined,
    gimbalHeading: entry.gimbalHeading ? { ...entry.gimbalHeading } : undefined,
    poi: entry.poi ? { ...entry.poi } : undefined,
    actionGroups: entry.actionGroups
      ? entry.actionGroups.map((group) => ({
          ...group,
          actions: group.actions.map((action) => ({
            ...action,
            params: action.params ? { ...action.params } : undefined,
          })),
        }))
      : undefined,
  }));

const isSameManualTarget = (a: ManualTargetState | null, b: ManualTargetState | null): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.altitude === b.altitude &&
    a.source === b.source
  );
};

const isSameWaypoint = (a: MissionWaypointTarget | null, b: MissionWaypointTarget | null): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.index === b.index &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.altitude === b.altitude &&
    a.kind === b.kind &&
    a.label === b.label
  );
};

const notifyPlan = () => {
  const planCopy = clonePlan(snapshot.plan);
  planListeners.forEach((listener) => listener(planCopy));
};

const notifyManualTarget = () => {
  const target = snapshot.manualTarget ? { ...snapshot.manualTarget } : null;
  manualTargetListeners.forEach((listener) => listener(target));
};

const notifyActiveWaypoint = () => {
  const waypoint = snapshot.activeWaypoint ? { ...snapshot.activeWaypoint } : null;
  activeWaypointListeners.forEach((listener) => listener(waypoint));
};

const notifyPoiTarget = () => {
  const poi = snapshot.poiTarget ? { ...snapshot.poiTarget } : null;
  poiListeners.forEach((listener) => listener(poi));
};

const notifyOrbitMode = () => {
  const mode = snapshot.orbitMode ?? 'none';
  orbitModeListeners.forEach((listener) => listener(mode));
};

export const missionPlannerStore = {
  getSnapshot(): MissionPlannerSnapshot {
    return {
      plan: clonePlan(snapshot.plan),
      manualTarget: snapshot.manualTarget ? { ...snapshot.manualTarget } : null,
      activeWaypoint: snapshot.activeWaypoint ? { ...snapshot.activeWaypoint } : null,
      poiTarget: snapshot.poiTarget ? { ...snapshot.poiTarget } : null,
      orbitMode: snapshot.orbitMode ?? 'none',
    };
  },

  setPlan(plan: PlannedMissionEntry[]): void {
    try {
      console.info('[MissionPlanner] setPlan()', plan.length, 'entries', plan);
    } catch {}
    snapshot = {
      ...snapshot,
      plan: clonePlan(plan),
    };
    notifyPlan();
  },

  updatePlan(updater: (prev: PlannedMissionEntry[]) => PlannedMissionEntry[]): void {
    try {
      const prev = clonePlan(snapshot.plan);
      const next = updater(prev);
      console.info('[MissionPlanner] updatePlan() from', prev.length, 'to', next.length, 'entries');
      snapshot = {
        ...snapshot,
        plan: clonePlan(next),
      };
      notifyPlan();
      return;
    } catch (err) {
      console.warn('[MissionPlanner] updatePlan() failed, propagating', err);
    }
    const next = updater(clonePlan(snapshot.plan));
    snapshot = {
      ...snapshot,
      plan: clonePlan(next),
    };
    notifyPlan();
  },

  subscribePlan(listener: PlanListener): () => void {
    planListeners.add(listener);
    try {
      console.info('[MissionPlanner] subscribePlan()', snapshot.plan.length, 'entries');
    } catch {}
    listener(clonePlan(snapshot.plan));
    return () => planListeners.delete(listener);
  },

  setManualTarget(target: ManualTargetState | null): void {
    if (isSameManualTarget(snapshot.manualTarget, target)) {
      return;
    }
    snapshot = {
      ...snapshot,
      manualTarget: target ? { ...target } : null,
    };
    notifyManualTarget();
  },

  subscribeManualTarget(listener: ManualTargetListener): () => void {
    manualTargetListeners.add(listener);
    listener(snapshot.manualTarget ? { ...snapshot.manualTarget } : null);
    return () => manualTargetListeners.delete(listener);
  },

  setActiveWaypoint(target: MissionWaypointTarget | null): void {
    if (isSameWaypoint(snapshot.activeWaypoint, target)) {
      return;
    }
    snapshot = {
      ...snapshot,
      activeWaypoint: target ? { ...target } : null,
    };
    notifyActiveWaypoint();
  },

  subscribeActiveWaypoint(listener: ActiveWaypointListener): () => void {
    activeWaypointListeners.add(listener);
    listener(snapshot.activeWaypoint ? { ...snapshot.activeWaypoint } : null);
    return () => activeWaypointListeners.delete(listener);
  },

  getPoiTarget(): PoiTarget | null {
    return snapshot.poiTarget ? { ...snapshot.poiTarget } : null;
  },

  setPoiTarget(target: PoiTarget | null): void {
    const next = target
      ? {
          latitude: clampLat(target.latitude),
          longitude: clampLon(target.longitude),
          altitude: typeof target.altitude === 'number' && Number.isFinite(target.altitude)
            ? target.altitude
            : null,
        }
      : null;

    const prev = snapshot.poiTarget;
    if (
      (prev == null && next == null) ||
      (prev != null && next != null &&
        prev.latitude === next.latitude &&
        prev.longitude === next.longitude &&
        (prev.altitude ?? null) === (next.altitude ?? null))
    ) {
      return;
    }

    snapshot = {
      ...snapshot,
      poiTarget: next,
    };
    notifyPoiTarget();
  },

  subscribePoiTarget(listener: PoiListener): () => void {
    poiListeners.add(listener);
    listener(snapshot.poiTarget ? { ...snapshot.poiTarget } : null);
    return () => poiListeners.delete(listener);
  },

  getOrbitMode(): OrbitMode {
    return snapshot.orbitMode ?? 'none';
  },

  setOrbitMode(mode: OrbitMode): void {
    if (snapshot.orbitMode === mode) {
      return;
    }
    snapshot = {
      ...snapshot,
      orbitMode: mode,
    };
    notifyOrbitMode();
  },

  subscribeOrbitMode(listener: OrbitModeListener): () => void {
    orbitModeListeners.add(listener);
    listener(snapshot.orbitMode ?? 'none');
    return () => orbitModeListeners.delete(listener);
  },

  requestAddWaypoint(request: MissionPlannerAddWaypointRequest): void {
    const payload = { ...request };
    addWaypointRequestListeners.forEach((listener) => listener(payload));
  },

  onAddWaypointRequest(listener: AddWaypointRequestListener): () => void {
    addWaypointRequestListeners.add(listener);
    return () => addWaypointRequestListeners.delete(listener);
  },

  requestStageTarget(request: MissionPlannerStageTargetRequest): void {
    const payload = { ...request };
    stageTargetRequestListeners.forEach((listener) => listener(payload));
  },

  onStageTargetRequest(listener: StageTargetRequestListener): () => void {
    stageTargetRequestListeners.add(listener);
    return () => stageTargetRequestListeners.delete(listener);
  },

  requestExecutePlan(context?: { source?: string }): void {
    const payload = context ? { ...context } : undefined;
    executePlanRequestListeners.forEach((listener) => listener(payload));
  },

  onExecutePlanRequest(listener: ExecutePlanRequestListener): () => void {
    executePlanRequestListeners.add(listener);
    return () => executePlanRequestListeners.delete(listener);
  },

  reset(): void {
    snapshot = {
      plan: [],
      manualTarget: null,
      activeWaypoint: null,
    };
    notifyPlan();
    notifyManualTarget();
    notifyActiveWaypoint();
  },
};
