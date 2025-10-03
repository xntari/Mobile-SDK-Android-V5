import React from 'react';
import {
  manualTrackSettingDefs,
  manualTrackPresets,
  type ManualTrackSettings,
  type ManualTrackPresetId,
} from '../camera/manualTrack';

type ManualTrackSettingKey = keyof ManualTrackSettings;

const formatValue = (key: ManualTrackSettingKey, value: number): string => {
  const def = manualTrackSettingDefs.find((s) => s.key === key);
  if (def?.format) {
    return def.format(value);
  }
  if (key === 'deadband' || key === 'smoothing') {
    return value.toFixed(2);
  }
  if (key === 'yawGain' || key === 'pitchGain') {
    return value.toFixed(2);
  }
  return `${Math.round(value)}`;
};

interface ManualTrackControlsProps {
  settings: ManualTrackSettings;
  activePreset: ManualTrackPresetId | 'custom';
  onChange: (next: Partial<ManualTrackSettings>) => void;
  onSelectPreset: (preset: ManualTrackPresetId) => void;
}

export const ManualTrackControls: React.FC<ManualTrackControlsProps> = ({
  settings,
  activePreset,
  onChange,
  onSelectPreset,
}) => {
  const handleInputChange = (key: ManualTrackSettingKey, raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    onChange({ [key]: parsed });
  };

  const handleSliderChange = (key: ManualTrackSettingKey, raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    onChange({ [key]: parsed });
  };

  return (
    <div className="space-y-2 bg-black/30 border border-purple-500/30 rounded p-2">
      <div className="flex items-center justify-between text-[10px] uppercase text-purple-200 font-semibold">
        <span>Manual track tuning</span>
        <span className="text-gray-400 italic">{activePreset === 'custom' ? 'custom' : `${activePreset} preset`}</span>
      </div>
      <div className="flex gap-2">
        {(Object.keys(manualTrackPresets) as ManualTrackPresetId[]).map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onSelectPreset(preset)}
            className={`flex-1 px-2 py-1 text-[11px] rounded border transition ${
              activePreset === preset
                ? 'border-purple-400 bg-purple-500/20 text-purple-100'
                : 'border-gray-700 bg-gray-800/60 text-gray-300 hover:border-purple-400 hover:text-purple-200'
            }`}
          >
            {preset}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {manualTrackSettingDefs.map(({ key, label, min, max, step }) => {
          const value = settings[key];
          const display = formatValue(key, value);
          const sliderValue = value;
          const sliderMin = min;
          const sliderMax = max;

          return (
            <label key={key} className="flex flex-col gap-1 text-[11px] text-gray-300">
              <div className="flex justify-between">
                <span>{label}</span>
                <span className="text-gray-400">{display}</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={sliderMin}
                  max={sliderMax}
                  step={step}
                  value={sliderValue}
                  onChange={(event) => handleSliderChange(key, event.target.value)}
                  className="flex-1"
                />
                <input
                  type="number"
                  value={value}
                  min={sliderMin}
                  max={sliderMax}
                  step={step}
                  onChange={(event) => handleInputChange(key, event.target.value)}
                  className="w-16 bg-gray-900 border border-gray-700 rounded px-1 py-[2px] text-[11px] text-gray-200"
                />
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
};
