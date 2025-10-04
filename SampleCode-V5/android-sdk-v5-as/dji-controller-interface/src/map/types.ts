import type { TelemetryData } from '../types';
import type {
  ManualTargetState,
  MissionWaypointTarget,
  PlannedMissionEntry,
  PoiTarget,
} from '../types/missionPlanner';
import type { TargetMetrics } from '../utils/objectMemoryTarget';

export type MapProvider = 'maplibre';

export interface MapClickEvent {
  latitude: number;
  longitude: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  button: number;
}

export type MapInteractionEvent =
  | 'dragstart'
  | 'dragend'
  | 'rotatestart'
  | 'rotateend'
  | 'pitchstart'
  | 'pitchend'
  | 'zoomstart'
  | 'zoomend'
  | 'moveend';

export interface MapViewState {
  telemetry: TelemetryData | null;
  targetMetrics: TargetMetrics | null;
  objectTargetLabel: string | null;
  autoCenter: boolean;
  autoRotate: boolean;
  layerPresetId: string;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  viewMode: '2d' | '3d';
  displayedPlan: PlannedMissionEntry[];
  manualTarget: ManualTargetState | null;
  activeWaypoint: MissionWaypointTarget | null;
  poiTarget: PoiTarget | null;
  flightPath?: Array<{ latitude: number; longitude: number }>;
}

export interface MapEngineInitOptions {
  onReady?: () => void;
  onClick?: (event: MapClickEvent) => void;
  onInteraction?: (event: MapInteractionEvent, phase: 'start' | 'end') => void;
}

export interface MapEngine {
  initialize(container: HTMLDivElement, options: MapEngineInitOptions): void;
  destroy(): void;
  updateState(state: MapViewState): void;
  recenter(): void;
}

export interface MapViewManagerOptions extends MapEngineInitOptions {
  provider: MapProvider;
}
