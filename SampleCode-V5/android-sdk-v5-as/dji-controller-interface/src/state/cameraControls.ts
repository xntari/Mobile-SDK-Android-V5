import type { GimbalMode, GimbalAttitudeMode } from '../components/GimbalModeToggle';
import type {
  ManualTrackSettings,
  ManualTrackPresetId,
} from '../camera/manualTrack';
import {
  manualTrackPresets,
  DEFAULT_MANUAL_TRACK_SETTINGS,
  sanitizeManualTrackSettings,
  detectManualTrackPreset,
  loadManualTrackSettings,
  loadManualTrackPreset,
  MANUAL_TRACK_SETTINGS_STORAGE_KEY,
  MANUAL_TRACK_PRESET_STORAGE_KEY,
} from '../camera/manualTrack';
import type {
  LookAtCommandMode,
  CameraLensSelection,
  SnapshotCameraId,
  ThermalZoomLevel,
} from '../camera/types';

export interface CameraCapabilityEntry {
  key: string;
  label?: string;
  value: unknown;
}

export interface CameraControlSnapshot {
  gimbalMode: GimbalMode;
  gimbalAttitudeMode: GimbalAttitudeMode;
  lookAtMode: LookAtCommandMode;
  lookAtStatus: string | null;
  lookAtBusy: boolean;
  manualTrackSettings: ManualTrackSettings;
  manualTrackPreset: ManualTrackPresetId | 'custom';
  selectedLens: CameraLensSelection;
  zoomRatio: number | null;
  zoomRange?: { min?: number; max?: number };
  thermalZoom: ThermalZoomLevel;
  thermalSuperResolution: boolean;
  thermalZoomRange?: { min?: number; max?: number };
  laserEnabled: boolean;
  lastGimbalCommand: {
    status?: string | null;
    message?: string | null;
    timestamp?: number;
    coordinates?: { x: number; y: number } | null;
  } | null;
  snapshotCamera: SnapshotCameraId;
  fpvHud: {
    enabled: boolean;
    theme: 'classic' | 'contrast';
    overlayMode: 'none' | 'inline' | 'panel';
    overlayOpacity: number;
  };
  lastLaserResult: any | null;
  cameraCapabilities: CameraCapabilityEntry[];
  cameraCapabilitiesLoading: boolean;
  cameraCapabilitiesError: string | null;
}

export interface CameraControlHandlers {
  setGimbalMode?: (mode: GimbalMode) => Promise<void> | void;
  setGimbalAttitudeMode?: (mode: GimbalAttitudeMode) => Promise<void> | void;
  setLookAtMode?: (mode: LookAtCommandMode) => Promise<void> | void;
  startLookAt?: (mode: LookAtCommandMode) => Promise<void> | void;
  stopLookAt?: () => Promise<void> | void;
  setLens?: (lens: CameraLensSelection) => Promise<void> | void;
  setOpticalZoom?: (ratio: number) => Promise<void> | void;
  setThermalZoom?: (level: ThermalZoomLevel) => Promise<void> | void;
  setThermalSuperResolution?: (enabled: boolean) => Promise<void> | void;
  setLaserEnabled?: (enabled: boolean) => Promise<void> | void;
  refreshCapabilities?: () => Promise<void> | void;
  setPoiFromManualTarget?: () => Promise<void> | void;
  setPoiFromLaser?: () => Promise<void> | void;
  clearPoi?: () => Promise<void> | void;
  updateManualTrackSettings?: (updates: Partial<ManualTrackSettings>) => void;
  applyManualTrackPreset?: (preset: ManualTrackPresetId) => void;
}

type CameraControlListener = () => void;

type StoredBoolean = boolean | null | undefined;

const LOOK_AT_MODE_STORAGE_KEY = 'lookAt.defaultMode';
const GIMBAL_ATTITUDE_STORAGE_KEY = 'cameraControl.gimbalAttitudeMode';
const SNAPSHOT_CAMERA_STORAGE_KEY = 'cameraControl.snapshotCamera';
const THERMAL_SUPER_RESOLUTION_STORAGE_KEY = 'cameraControl.thermalSuperResolution';

const FPV_HUD_ENABLED_KEY = 'fpv.hud.enabled';
const FPV_HUD_THEME_KEY = 'fpv.hud.theme';
const FPV_HUD_OVERLAY_MODE_KEY = 'fpv.hud.overlay.mode';
const FPV_HUD_OVERLAY_OPACITY_KEY = 'fpv.hud.overlay.opacity';

const loadBoolean = (raw: string | null): StoredBoolean => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
};

const loadSnapshotCamera = (): SnapshotCameraId => {
  if (typeof window === 'undefined') return 'fpv';
  const raw = window.localStorage.getItem(SNAPSHOT_CAMERA_STORAGE_KEY);
  return raw === 'h20n' ? 'h20n' : 'fpv';
};

const loadGimbalAttitude = (): GimbalAttitudeMode => {
  if (typeof window === 'undefined') return 'YAW_FOLLOW';
  const raw = window.localStorage.getItem(GIMBAL_ATTITUDE_STORAGE_KEY);
  return raw === 'FREE' || raw === 'FPV' || raw === 'YAW_FOLLOW' ? (raw as GimbalAttitudeMode) : 'YAW_FOLLOW';
};

const loadLookAtMode = (): LookAtCommandMode => {
  if (typeof window === 'undefined') return 'GIMBAL_FOLLOWING';
  const raw = window.localStorage.getItem(LOOK_AT_MODE_STORAGE_KEY);
  return raw === 'GIMBAL_FREE' || raw === 'GIMBAL_FOLLOWING' || raw === 'ZOOM_CIRCLE' || raw === 'MANUAL_TRACK'
    ? (raw as LookAtCommandMode)
    : 'GIMBAL_FOLLOWING';
};

const loadThermalSuperResolution = (): boolean => {
  if (typeof window === 'undefined') return false;
  const raw = window.localStorage.getItem(THERMAL_SUPER_RESOLUTION_STORAGE_KEY);
  if (!raw) return false;
  const parsed = loadBoolean(raw);
  return parsed ?? false;
};

const loadFpvHud = () => {
  if (typeof window === 'undefined') {
    return {
      enabled: true,
      theme: 'contrast' as const,
      overlayMode: 'panel' as const,
      overlayOpacity: 0.55,
    };
  }
  try {
    const enabledRaw = window.localStorage.getItem(FPV_HUD_ENABLED_KEY);
    const themeRaw = window.localStorage.getItem(FPV_HUD_THEME_KEY);
    const overlayModeRaw = window.localStorage.getItem(FPV_HUD_OVERLAY_MODE_KEY);
    const overlayOpacityRaw = window.localStorage.getItem(FPV_HUD_OVERLAY_OPACITY_KEY);

    const enabled = loadBoolean(enabledRaw);
    const theme: 'classic' | 'contrast' = themeRaw === 'classic' ? 'classic' : 'contrast';
    const overlayMode: 'none' | 'inline' | 'panel' = overlayModeRaw === 'inline'
      ? 'inline'
      : overlayModeRaw === 'none'
        ? 'none'
        : 'panel';
    const overlayOpacity = overlayOpacityRaw ? Number(overlayOpacityRaw) : 55;

    return {
      enabled: enabled ?? true,
      theme,
      overlayMode: overlayMode as 'none' | 'inline' | 'panel',
      overlayOpacity: Math.min(Math.max(overlayOpacity / 100, 0), 1),
    };
  } catch {
    return {
      enabled: true,
      theme: 'contrast' as const,
      overlayMode: 'panel' as const,
      overlayOpacity: 0.55,
    };
  }
};

const manualTrackSettingsInitial = loadManualTrackSettings();
const manualTrackPresetInitial = loadManualTrackPreset(manualTrackSettingsInitial);

const cloneSnapshot = (value: CameraControlSnapshot): CameraControlSnapshot => ({
  ...value,
  manualTrackSettings: { ...value.manualTrackSettings },
  fpvHud: { ...value.fpvHud },
  zoomRange: value.zoomRange ? { ...value.zoomRange } : undefined,
  thermalZoomRange: value.thermalZoomRange ? { ...value.thermalZoomRange } : undefined,
  cameraCapabilities: value.cameraCapabilities.map((entry) => ({ ...entry })),
  lastGimbalCommand: value.lastGimbalCommand
    ? {
        status: value.lastGimbalCommand.status ?? null,
        message: value.lastGimbalCommand.message ?? null,
        timestamp: value.lastGimbalCommand.timestamp,
        coordinates: value.lastGimbalCommand.coordinates
          ? { ...value.lastGimbalCommand.coordinates }
          : null,
      }
    : null,
});

let snapshot: CameraControlSnapshot = {
  gimbalMode: 'look_at',
  gimbalAttitudeMode: loadGimbalAttitude(),
  lookAtMode: loadLookAtMode(),
  lookAtStatus: null,
  lookAtBusy: false,
  manualTrackSettings: manualTrackSettingsInitial,
  manualTrackPreset: manualTrackPresetInitial,
  selectedLens: 'wide',
  zoomRatio: null,
  zoomRange: undefined,
  thermalZoom: 1,
  thermalSuperResolution: loadThermalSuperResolution(),
  thermalZoomRange: undefined,
  laserEnabled: false,
  lastGimbalCommand: null,
  snapshotCamera: loadSnapshotCamera(),
  fpvHud: loadFpvHud(),
  lastLaserResult: null,
  cameraCapabilities: [],
  cameraCapabilitiesLoading: false,
  cameraCapabilitiesError: null,
};

let publishedSnapshot: CameraControlSnapshot = cloneSnapshot(snapshot);

let handlers: CameraControlHandlers = {};
const listeners = new Set<CameraControlListener>();

const persistManualTrackSettings = (settings: ManualTrackSettings) => {
  try {
    window.localStorage.setItem(MANUAL_TRACK_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
};

const persistManualTrackPreset = (preset: ManualTrackPresetId | 'custom') => {
  if (preset === 'custom') return;
  try {
    window.localStorage.setItem(MANUAL_TRACK_PRESET_STORAGE_KEY, preset);
  } catch {
    // ignore
  }
};

const persistLookAtMode = (mode: LookAtCommandMode) => {
  try {
    window.localStorage.setItem(LOOK_AT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
};

const persistGimbalAttitude = (mode: GimbalAttitudeMode) => {
  try {
    window.localStorage.setItem(GIMBAL_ATTITUDE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
};

const persistSnapshotCamera = (camera: SnapshotCameraId) => {
  try {
    window.localStorage.setItem(SNAPSHOT_CAMERA_STORAGE_KEY, camera);
  } catch {
    // ignore
  }
};

const persistThermalSuperResolution = (enabled: boolean) => {
  try {
    window.localStorage.setItem(THERMAL_SUPER_RESOLUTION_STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    // ignore
  }
};

const persistFpvHud = (fpvHud: CameraControlSnapshot['fpvHud']) => {
  try {
    window.localStorage.setItem(FPV_HUD_ENABLED_KEY, JSON.stringify(fpvHud.enabled));
    window.localStorage.setItem(FPV_HUD_THEME_KEY, fpvHud.theme);
    window.localStorage.setItem(FPV_HUD_OVERLAY_MODE_KEY, fpvHud.overlayMode);
    window.localStorage.setItem(FPV_HUD_OVERLAY_OPACITY_KEY, Math.round(fpvHud.overlayOpacity * 100).toString());
  } catch {
    // ignore
  }
};

const publishSnapshot = () => {
  publishedSnapshot = cloneSnapshot(snapshot);
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('CameraControl listener error', error);
    }
  });
};

const setState = (partial: Partial<CameraControlSnapshot>) => {
  snapshot = {
    ...snapshot,
    ...partial,
  };
  publishSnapshot();
};

const cameraControlStore = {
  getSnapshot(): CameraControlSnapshot {
    return publishedSnapshot;
  },

  subscribe(listener: CameraControlListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  registerHandlers(nextHandlers: CameraControlHandlers): void {
    handlers = { ...handlers, ...nextHandlers };
  },

  getHandlers(): CameraControlHandlers {
    return handlers;
  },

  setGimbalMode(mode: GimbalMode): void {
    if (snapshot.gimbalMode === mode) return;
    setState({ gimbalMode: mode });
  },

  setGimbalAttitudeMode(mode: GimbalAttitudeMode): void {
    if (snapshot.gimbalAttitudeMode === mode) return;
    setState({ gimbalAttitudeMode: mode });
    persistGimbalAttitude(mode);
  },

  setLookAtMode(mode: LookAtCommandMode): void {
    if (snapshot.lookAtMode === mode) return;
    setState({ lookAtMode: mode });
    persistLookAtMode(mode);
  },

  setLookAtStatus(status: string | null): void {
    if (snapshot.lookAtStatus === status) return;
    setState({ lookAtStatus: status });
  },

  setLookAtBusy(busy: boolean): void {
    if (snapshot.lookAtBusy === busy) return;
    setState({ lookAtBusy: busy });
  },

  setManualTrackSettings(settings: Partial<ManualTrackSettings>): void {
    const sanitized = sanitizeManualTrackSettings({ ...snapshot.manualTrackSettings, ...settings });
    const preset = detectManualTrackPreset(sanitized);
    snapshot = {
      ...snapshot,
      manualTrackSettings: sanitized,
      manualTrackPreset: preset,
    };
    publishSnapshot();
    persistManualTrackSettings(sanitized);
    persistManualTrackPreset(preset);
  },

  applyManualTrackPreset(preset: ManualTrackPresetId): void {
    const template = sanitizeManualTrackSettings(manualTrackPresets[preset]);
    snapshot = {
      ...snapshot,
      manualTrackSettings: template,
      manualTrackPreset: preset,
    };
    publishSnapshot();
    persistManualTrackSettings(template);
    persistManualTrackPreset(preset);
  },

  setManualTrackPreset(preset: ManualTrackPresetId | 'custom'): void {
    if (snapshot.manualTrackPreset === preset) return;
    snapshot = {
      ...snapshot,
      manualTrackPreset: preset,
    };
    publishSnapshot();
    if (preset !== 'custom') {
      persistManualTrackPreset(preset);
    }
  },

  setSelectedLens(lens: CameraLensSelection): void {
    if (snapshot.selectedLens === lens) return;
    setState({ selectedLens: lens });
  },

  setZoomRatio(ratio: number | null): void {
    if (snapshot.zoomRatio === ratio) return;
    setState({ zoomRatio: ratio });
  },

  setZoomRange(range?: { min?: number; max?: number }): void {
    const current = snapshot.zoomRange ?? {};
    const next = range ?? {};
    if (current.min === next.min && current.max === next.max) return;
    setState({ zoomRange: range });
  },

  setThermalZoom(level: ThermalZoomLevel): void {
    if (snapshot.thermalZoom === level) return;
    setState({ thermalZoom: level });
  },

  setThermalSuperResolution(enabled: boolean): void {
    if (snapshot.thermalSuperResolution === enabled) return;
    setState({ thermalSuperResolution: enabled });
    persistThermalSuperResolution(enabled);
  },

  setThermalZoomRange(range?: { min?: number; max?: number }): void {
    const current = snapshot.thermalZoomRange ?? {};
    const next = range ?? undefined;
    if (next && current.min === next.min && current.max === next.max) {
      return;
    }
    setState({ thermalZoomRange: next });
  },

  setLaserEnabled(enabled: boolean): void {
    if (snapshot.laserEnabled === enabled) return;
    setState({ laserEnabled: enabled });
  },

  setLastGimbalCommand(entry: CameraControlSnapshot['lastGimbalCommand']): void {
    if (!entry) {
      if (snapshot.lastGimbalCommand === null) return;
      setState({ lastGimbalCommand: null });
      return;
    }
    setState({
      lastGimbalCommand: {
        status: entry.status ?? snapshot.lastGimbalCommand?.status ?? null,
        message: entry.message ?? snapshot.lastGimbalCommand?.message ?? null,
        timestamp: entry.timestamp ?? Date.now(),
        coordinates: entry.coordinates
          ? { ...entry.coordinates }
          : snapshot.lastGimbalCommand?.coordinates ?? null,
      },
    });
  },

  setSnapshotCamera(camera: SnapshotCameraId): void {
    if (snapshot.snapshotCamera === camera) return;
    setState({ snapshotCamera: camera });
    persistSnapshotCamera(camera);
  },

  setFpvHudSettings(partial: Partial<CameraControlSnapshot['fpvHud']>): void {
    const next = { ...snapshot.fpvHud, ...partial };
    snapshot = { ...snapshot, fpvHud: next };
    publishSnapshot();
    persistFpvHud(next);
  },

  setLastLaserResult(result: any | null): void {
    snapshot = { ...snapshot, lastLaserResult: result ?? null };
    publishSnapshot();
  },

  setCameraCapabilities(entries: CameraCapabilityEntry[]): void {
    setState({
      cameraCapabilities: entries.map((entry) => ({ ...entry })),
      cameraCapabilitiesLoading: false,
      cameraCapabilitiesError: null,
    });
  },

  setCameraCapabilitiesLoading(loading: boolean): void {
    if (snapshot.cameraCapabilitiesLoading === loading) return;
    setState({ cameraCapabilitiesLoading: loading });
  },

  setCameraCapabilitiesError(error: string | null): void {
    if (snapshot.cameraCapabilitiesError === error) return;
    setState({ cameraCapabilitiesError: error, cameraCapabilitiesLoading: false });
  },
};

export { cameraControlStore };
