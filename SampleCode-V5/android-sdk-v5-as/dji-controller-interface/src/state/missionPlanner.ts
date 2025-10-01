import {
  PlannedMissionEntry,
  ManualTargetState,
  MissionPlannerSnapshot,
  MissionEntryKind,
  MissionWaypointTarget,
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
type AddWaypointRequestListener = (request: MissionPlannerAddWaypointRequest) => void;
type StageTargetRequestListener = (request: MissionPlannerStageTargetRequest) => void;
type ExecutePlanRequestListener = (context?: { source?: string }) => void;

const planListeners = new Set<PlanListener>();
const manualTargetListeners = new Set<ManualTargetListener>();
const activeWaypointListeners = new Set<ActiveWaypointListener>();
const addWaypointRequestListeners = new Set<AddWaypointRequestListener>();
const stageTargetRequestListeners = new Set<StageTargetRequestListener>();
const executePlanRequestListeners = new Set<ExecutePlanRequestListener>();

let snapshot: MissionPlannerSnapshot = {
  plan: [],
  manualTarget: null,
  activeWaypoint: null,
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

export const missionPlannerStore = {
  getSnapshot(): MissionPlannerSnapshot {
    return {
      plan: clonePlan(snapshot.plan),
      manualTarget: snapshot.manualTarget ? { ...snapshot.manualTarget } : null,
      activeWaypoint: snapshot.activeWaypoint ? { ...snapshot.activeWaypoint } : null,
    };
  },

  setPlan(plan: PlannedMissionEntry[]): void {
    snapshot = {
      ...snapshot,
      plan: clonePlan(plan),
    };
    notifyPlan();
  },

  updatePlan(updater: (prev: PlannedMissionEntry[]) => PlannedMissionEntry[]): void {
    const next = updater(clonePlan(snapshot.plan));
    snapshot = {
      ...snapshot,
      plan: clonePlan(next),
    };
    notifyPlan();
  },

  subscribePlan(listener: PlanListener): () => void {
    planListeners.add(listener);
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
