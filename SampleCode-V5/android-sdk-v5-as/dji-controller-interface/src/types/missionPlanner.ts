export type MissionEntryKind = 'waypoint' | 'orbit';

export interface PlannedMissionEntry {
  id: string;
  kind: MissionEntryKind;
  latitude: number;
  longitude: number;
  altitude: number | null;
  radius?: number;
  turns?: number;
}

export interface ManualTargetState {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  source?: 'manual' | 'map' | 'laser' | 'object-memory';
}

export interface MissionWaypointTarget {
  index?: number;
  label?: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  kind?: MissionEntryKind | string;
}

export interface MissionPlannerSnapshot {
  plan: PlannedMissionEntry[];
  manualTarget: ManualTargetState | null;
  activeWaypoint?: MissionWaypointTarget | null;
}
