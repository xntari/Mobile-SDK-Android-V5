import { AltitudeReferenceMode } from '../types/missionPlanner';

export type ExecuteHeightMode = 'relative_to_takeoff' | 'absolute_wgs84';

export interface MissionSettingsSnapshot {
  executeHeightMode: ExecuteHeightMode;
}

type Listener = (snapshot: MissionSettingsSnapshot) => void;

const STORAGE_KEY = 'mission.settings';
const storage: Storage | null = typeof window !== 'undefined' ? window.localStorage : null;
const DEFAULT_SNAPSHOT: MissionSettingsSnapshot = {
  executeHeightMode: 'relative_to_takeoff',
};

function loadSnapshot(): MissionSettingsSnapshot {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SNAPSHOT;
    }
    const parsed = JSON.parse(raw);
    const executeHeightMode = parsed?.executeHeightMode === 'absolute_wgs84'
      ? 'absolute_wgs84'
      : 'relative_to_takeoff';
    return { executeHeightMode };
  } catch (error) {
    console.warn('[MissionSettingsStore] failed to load snapshot', error);
    return DEFAULT_SNAPSHOT;
  }
}

const listeners = new Set<Listener>();
let snapshot: MissionSettingsSnapshot = loadSnapshot();

function persist(): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('[MissionSettingsStore] failed to persist snapshot', error);
  }
}

export const missionSettingsStore = {
  getSnapshot(): MissionSettingsSnapshot {
    return { ...snapshot };
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener({ ...snapshot });
    return () => listeners.delete(listener);
  },

  setExecuteHeightMode(mode: ExecuteHeightMode): void {
    if (snapshot.executeHeightMode === mode) {
      return;
    }
    snapshot = {
      ...snapshot,
      executeHeightMode: mode,
    };
    persist();
    const value = { ...snapshot };
    listeners.forEach((listener) => {
      try {
        listener(value);
      } catch (error) {
        console.warn('[MissionSettingsStore] listener error', error);
      }
    });
  },
};

export const altitudeReferenceForExecuteMode = (mode: ExecuteHeightMode): AltitudeReferenceMode => (
  mode === 'absolute_wgs84' ? 'absolute_wgs84' : 'relative_to_takeoff'
);
