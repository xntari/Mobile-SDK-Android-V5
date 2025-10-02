export type MissionEntryKind = 'waypoint' | 'orbit' | 'return_home' | 'land';

export type OrbitMode = 'none' | 'drift' | 'gimbal' | 'gimbal_free';

export type WaypointTurnMode =
  | 'toPointAndPassWithContinuityCurvature'
  | 'toPointAndStopWithContinuityCurvature'
  | 'toPointAndStopWithDiscontinuityCurvature'
  | 'coordinateTurn'
  | 'auto';

export interface WaypointTurnConfig {
  mode?: WaypointTurnMode | string;
  damping?: number | null;
  useStraightLine?: boolean | null;
}

export interface PoiTarget {
  latitude: number;
  longitude: number;
  altitude?: number | null;
}

export interface WaypointHeadingConfig {
  mode?: 'followWayline' | 'fixed' | 'towardPOI' | 'manual' | string;
  angle?: number | null;
  angleEnable?: boolean | null;
  poi?: PoiTarget | null;
  poiIndex?: number | null;
  yawPathMode?: string | null;
  yawBase?: string | null;
}

export interface WaypointGimbalHeadingConfig {
  mode?: 'lock' | 'follow' | 'poi' | string;
  pitch?: number | null;
  yaw?: number | null;
}

export type WaypointActionFunction =
  | 'gimbalRotate'
  | 'gimbalEvenlyRotate'
  | 'takePhoto'
  | 'rotateYaw'
  | string;

export interface WaypointActionConfig {
  id?: number | null;
  func: WaypointActionFunction;
  params?: Record<string, unknown>;
}

export interface WaypointActionGroup {
  id?: number | null;
  startIndex?: number | null;
  endIndex?: number | null;
  mode?: string | null;
  triggerType?: string | null;
  actions: WaypointActionConfig[];
}

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

export type AltitudeReferenceMode =
  | 'relative_to_takeoff'
  | 'absolute_wgs84'
  | 'egm96'
  | 'unknown'
  | string;

export interface PlannedMissionEntry {
  id: string;
  kind: MissionEntryKind;
  latitude: number;
  longitude: number;
  altitude: number | null;
  radius?: number;
  turns?: number;
  actions?: WaypointAction[];
  turn?: WaypointTurnConfig | null;
  heading?: WaypointHeadingConfig | null;
  gimbalHeading?: WaypointGimbalHeadingConfig | null;
  poi?: PoiTarget | null;
  gimbalStrategy?: string | null;
  actionGroups?: WaypointActionGroup[];
  altitudeReference?: AltitudeReferenceMode | null;
  orbitAutoHeading?: boolean;
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
  poiTarget?: PoiTarget | null;
  orbitMode?: OrbitMode;
}
