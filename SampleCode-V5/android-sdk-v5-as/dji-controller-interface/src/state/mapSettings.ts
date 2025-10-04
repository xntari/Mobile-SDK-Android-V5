export type MapProvider = 'maplibre';

export interface MapLayerPreset {
  id: string;
  label: string;
  provider: MapProvider;
  supportsTerrain: boolean;
  description?: string;
}

export interface MapSettingsSnapshot {
  provider: MapProvider;
  layerPresetId: string;
  autoCenter: boolean;
  autoRotate: boolean;
  showAdvanced: boolean;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  viewMode: '2d' | '3d';
}

type Listener = (snapshot: MapSettingsSnapshot) => void;

const STORAGE_KEY_SETTINGS = 'map.settings';
const STORAGE_KEY_PRESET = 'map.layerPreset';
const STORAGE_KEY_PROVIDER = 'map.provider';

// Temporary preset list until multi-provider rollout
const DEFAULT_LAYER_PRESETS: MapLayerPreset[] = [
  {
    id: 'osm-street',
    label: 'OpenStreetMap Street',
    provider: 'maplibre',
    supportsTerrain: false,
  },
];

const DEFAULT_SNAPSHOT: MapSettingsSnapshot = {
  provider: 'maplibre',
  layerPresetId: DEFAULT_LAYER_PRESETS[0].id,
  autoCenter: false,
  autoRotate: false,
  showAdvanced: false,
  terrainEnabled: false,
  terrainExaggeration: 1,
  viewMode: '2d',
};

function loadSnapshot(): MapSettingsSnapshot {
  try {
    const explicit = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (explicit) {
      const parsed = JSON.parse(explicit);
      if (parsed && typeof parsed === 'object') {
        return {
          provider: parsed.provider ?? DEFAULT_SNAPSHOT.provider,
          layerPresetId: parsed.layerPresetId ?? DEFAULT_SNAPSHOT.layerPresetId,
          autoCenter: typeof parsed.autoCenter === 'boolean' ? parsed.autoCenter : DEFAULT_SNAPSHOT.autoCenter,
          autoRotate: typeof parsed.autoRotate === 'boolean' ? parsed.autoRotate : DEFAULT_SNAPSHOT.autoRotate,
          showAdvanced: typeof parsed.showAdvanced === 'boolean' ? parsed.showAdvanced : DEFAULT_SNAPSHOT.showAdvanced,
          terrainEnabled: typeof parsed.terrainEnabled === 'boolean' ? parsed.terrainEnabled : DEFAULT_SNAPSHOT.terrainEnabled,
          terrainExaggeration: Number.isFinite(parsed.terrainExaggeration) ? parsed.terrainExaggeration : DEFAULT_SNAPSHOT.terrainExaggeration,
          viewMode: parsed.viewMode === '3d' ? '3d' : '2d',
        };
      }
    }

    const provider = (localStorage.getItem(STORAGE_KEY_PROVIDER) as MapProvider | null) ?? DEFAULT_SNAPSHOT.provider;
    const preset = localStorage.getItem(STORAGE_KEY_PRESET) ?? DEFAULT_SNAPSHOT.layerPresetId;
    const autoCenterRaw = localStorage.getItem('map.autoCenter');
    const autoRotateRaw = localStorage.getItem('map.autoRotate');

    return {
      provider,
      layerPresetId: preset,
      autoCenter: autoCenterRaw != null ? JSON.parse(autoCenterRaw) : DEFAULT_SNAPSHOT.autoCenter,
      autoRotate: autoRotateRaw != null ? JSON.parse(autoRotateRaw) : DEFAULT_SNAPSHOT.autoRotate,
      showAdvanced: DEFAULT_SNAPSHOT.showAdvanced,
      terrainEnabled: DEFAULT_SNAPSHOT.terrainEnabled,
      terrainExaggeration: DEFAULT_SNAPSHOT.terrainExaggeration,
      viewMode: DEFAULT_SNAPSHOT.viewMode,
    };
  } catch (error) {
    console.warn('[MapSettingsStore] Failed to load settings, using defaults', error);
    return DEFAULT_SNAPSHOT;
  }
}

class MapSettingsStore {
  private snapshot: MapSettingsSnapshot = loadSnapshot();
  private listeners: Set<Listener> = new Set();
  private presets: MapLayerPreset[] = DEFAULT_LAYER_PRESETS;

  getSnapshot(): MapSettingsSnapshot {
    return this.snapshot;
  }

  getPresets(): MapLayerPreset[] {
    return this.presets;
  }

  setProvider(provider: MapProvider): void {
    if (this.snapshot.provider === provider) {
      return;
    }
    this.updateSnapshot({ provider });
  }

  setLayerPreset(presetId: string): void {
    if (this.snapshot.layerPresetId === presetId) {
      return;
    }
    this.updateSnapshot({ layerPresetId: presetId });
  }

  setAutoCenter(autoCenter: boolean): void {
    if (this.snapshot.autoCenter === autoCenter) {
      return;
    }
    this.updateSnapshot({ autoCenter });
  }

  setAutoRotate(autoRotate: boolean): void {
    if (this.snapshot.autoRotate === autoRotate) {
      return;
    }
    this.updateSnapshot({ autoRotate });
  }

  toggleAdvanced(): void {
    this.updateSnapshot({ showAdvanced: !this.snapshot.showAdvanced });
  }

  setTerrainEnabled(enabled: boolean): void {
    if (this.snapshot.terrainEnabled === enabled) {
      return;
    }
    this.updateSnapshot({ terrainEnabled: enabled });
  }

  setTerrainExaggeration(value: number): void {
    const clamped = Math.min(Math.max(value, 0.5), 3);
    if (this.snapshot.terrainExaggeration === clamped) {
      return;
    }
    this.updateSnapshot({ terrainExaggeration: clamped });
  }

  toggleViewMode(): MapSettingsSnapshot {
    const next = this.snapshot.viewMode === '3d' ? '2d' : '3d';
    this.updateSnapshot({ viewMode: next });
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private updateSnapshot(partial: Partial<MapSettingsSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...partial,
    };

    this.persist();

    this.listeners.forEach((listener) => {
      try {
        listener(this.snapshot);
      } catch (error) {
        console.warn('[MapSettingsStore] listener error', error);
      }
    });
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(this.snapshot));
    } catch (error) {
      console.warn('[MapSettingsStore] Failed to persist settings', error);
    }
  }
}

export const mapSettingsStore = new MapSettingsStore();
