export type MissionEntryKind = 'waypoint' | 'orbit' | 'return_home' | 'land';

export type WaypointAction =
  | {
      type: 'gimbal_pitch';
      pitch: number;
      timing?: 'before' | 'after';
    }
  | {
      type: 'poi';
      latitude: number;
      longitude: number;
      altitude?: number | null;
    };

export interface PlannedMissionEntry {
  id: string;
  kind: MissionEntryKind;
  latitude: number;
  longitude: number;
  altitude: number | null;
  radius?: number;
  turns?: number;
  actions?: WaypointAction[];
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
