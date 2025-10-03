export type ManualTrackSettings = {
  yawGain: number;
  pitchGain: number;
  yawRateLimit: number;
  pitchRateLimit: number;
  deadband: number;
  smoothing: number;
  intervalMs: number;
};

export type ManualTrackPresetId = 'smooth' | 'balanced' | 'aggressive';

export const MANUAL_TRACK_SETTINGS_STORAGE_KEY = 'h20n.manualTrack.settings.v1';
export const MANUAL_TRACK_PRESET_STORAGE_KEY = 'h20n.manualTrack.preset.v1';

export const manualTrackPresets: Record<ManualTrackPresetId, ManualTrackSettings> = {
  smooth: {
    yawGain: 1.0,
    pitchGain: 0.9,
    yawRateLimit: 80,
    pitchRateLimit: 60,
    deadband: 0.35,
    smoothing: 0.45,
    intervalMs: 110,
  },
  balanced: {
    yawGain: 1.4,
    pitchGain: 1.1,
    yawRateLimit: 110,
    pitchRateLimit: 80,
    deadband: 0.28,
    smoothing: 0.25,
    intervalMs: 90,
  },
  aggressive: {
    yawGain: 1.75,
    pitchGain: 1.4,
    yawRateLimit: 130,
    pitchRateLimit: 95,
    deadband: 0.2,
    smoothing: 0.15,
    intervalMs: 70,
  },
};

export const manualTrackSettingDefs: Array<{
  key: keyof ManualTrackSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}> = [
  { key: 'yawGain', label: 'Yaw gain', min: 0.6, max: 2.4, step: 0.05 },
  { key: 'pitchGain', label: 'Pitch gain', min: 0.6, max: 2.4, step: 0.05 },
  { key: 'yawRateLimit', label: 'Yaw limit (°/s)', min: 40, max: 150, step: 5 },
  { key: 'pitchRateLimit', label: 'Pitch limit (°/s)', min: 30, max: 120, step: 5 },
  { key: 'deadband', label: 'Deadband (°)', min: 0, max: 1.2, step: 0.05 },
  { key: 'smoothing', label: 'Smoothing', min: 0, max: 0.9, step: 0.05 },
  {
    key: 'intervalMs',
    label: 'Loop interval (ms)',
    min: 50,
    max: 200,
    step: 5,
    format: (value) => `${Math.round(value)} ms (~${Math.round(1000 / value)} Hz)`,
  },
];

export const DEFAULT_MANUAL_TRACK_SETTINGS: ManualTrackSettings = {
  ...manualTrackPresets.balanced,
};

const manualTrackSettingMap = manualTrackSettingDefs.reduce(
  (acc, def) => {
    acc[def.key] = def;
    return acc;
  },
  {} as Record<keyof ManualTrackSettings, (typeof manualTrackSettingDefs)[number]>,
);

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampManualTrackSetting = (key: keyof ManualTrackSettings, value: unknown): number => {
  const def = manualTrackSettingMap[key];
  const fallback = DEFAULT_MANUAL_TRACK_SETTINGS[key];
  const numeric = toNumberOrNull(value);
  if (numeric == null) {
    return fallback;
  }
  return Math.min(def.max, Math.max(def.min, numeric));
};

export const sanitizeManualTrackSettings = (
  input?: Partial<ManualTrackSettings>,
): ManualTrackSettings => ({
  yawGain: clampManualTrackSetting('yawGain', input?.yawGain),
  pitchGain: clampManualTrackSetting('pitchGain', input?.pitchGain),
  yawRateLimit: clampManualTrackSetting('yawRateLimit', input?.yawRateLimit),
  pitchRateLimit: clampManualTrackSetting('pitchRateLimit', input?.pitchRateLimit),
  deadband: clampManualTrackSetting('deadband', input?.deadband),
  smoothing: clampManualTrackSetting('smoothing', input?.smoothing),
  intervalMs: clampManualTrackSetting('intervalMs', input?.intervalMs),
});

const MANUAL_TRACK_TOLERANCE: Record<keyof ManualTrackSettings, number> = {
  yawGain: 0.05,
  pitchGain: 0.05,
  yawRateLimit: 4,
  pitchRateLimit: 4,
  deadband: 0.05,
  smoothing: 0.05,
  intervalMs: 6,
};

export const detectManualTrackPreset = (
  settings: ManualTrackSettings,
): ManualTrackPresetId | 'custom' => {
  for (const presetId of ['smooth', 'balanced', 'aggressive'] as ManualTrackPresetId[]) {
    const preset = manualTrackPresets[presetId];
    const matches = (Object.keys(preset) as Array<keyof ManualTrackSettings>).every((key) => {
      const tolerance = MANUAL_TRACK_TOLERANCE[key] ?? 0.01;
      return Math.abs(settings[key] - preset[key]) <= tolerance;
    });
    if (matches) {
      return presetId;
    }
  }
  return 'custom';
};

export const loadManualTrackSettings = (): ManualTrackSettings => {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_MANUAL_TRACK_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(MANUAL_TRACK_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_MANUAL_TRACK_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    return sanitizeManualTrackSettings(parsed);
  } catch {
    return { ...DEFAULT_MANUAL_TRACK_SETTINGS };
  }
};

export const loadManualTrackPreset = (
  settings: ManualTrackSettings,
): ManualTrackPresetId | 'custom' => {
  if (typeof window === 'undefined') {
    return detectManualTrackPreset(settings);
  }
  try {
    const stored = window.localStorage.getItem(MANUAL_TRACK_PRESET_STORAGE_KEY);
    if (stored === 'smooth' || stored === 'balanced' || stored === 'aggressive') {
      const presetSettings = manualTrackPresets[stored];
      const matches = detectManualTrackPreset(settings) === stored;
      return matches ? stored : 'custom';
    }
  } catch {
    // ignore storage errors
  }
  return detectManualTrackPreset(settings);
};
