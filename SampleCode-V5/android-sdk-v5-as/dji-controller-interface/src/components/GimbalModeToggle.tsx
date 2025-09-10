import React from 'react';

export type GimbalMode = 'off' | 'free_look' | 'precise';


interface GimbalModeToggleProps {
  mode: GimbalMode;
  onModeChange: (mode: GimbalMode) => void;
  className?: string;
  isFreeLookActive?: boolean;
  freeLookVelocity?: { vx: number; vy: number };
  sensitivity?: number; // 0.5 - 3.0
  smoothing?: number;   // 0.0 - 0.9 (client-side low-pass)
  onSensitivityChange?: (v: number) => void;
  onSmoothingChange?: (v: number) => void;
  // Precise look controls
  preciseDurationMs?: number; // 200 - 2500
  preciseStrength?: number;   // 0.5 - 3.0
  onPreciseDurationChange?: (v: number) => void;
  onPreciseStrengthChange?: (v: number) => void;
}

export const GimbalModeToggle: React.FC<GimbalModeToggleProps> = ({
  mode,
  onModeChange,
  className = '',
  isFreeLookActive = false,
  freeLookVelocity = { vx: 0, vy: 0 },
  sensitivity = 3.0,
  smoothing = 0.05,
  onSensitivityChange,
  onSmoothingChange,
  preciseDurationMs = 700,
  preciseStrength = 1.0,
  onPreciseDurationChange,
  onPreciseStrengthChange
}) => {
  const modes: { value: GimbalMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'free_look', label: 'Free Look' },
    { value: 'precise', label: 'Precise' }
  ];

  return (
    <div className={`glass-panel p-2 ${className}`}>
      <div className="text-xs text-gray-400 mb-2 font-semibold">GIMBAL MODE</div>
      <div className="flex gap-1">
        {modes.map((modeOption) => (
          <button
            key={modeOption.value}
            onClick={() => onModeChange(modeOption.value)}
            className={`
              px-3 py-1 text-xs rounded transition-colors
              ${mode === modeOption.value
                ? 'bg-dji-blue text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }
            `}
          >
            {modeOption.label}
          </button>
        ))}
      </div>
      
      {/* Status and debug info */}
      {mode === 'free_look' && isFreeLookActive && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse"></div>
            <span className="text-purple-200 text-xs font-semibold">Free Look Active</span>
          </div>
          <div className="text-purple-300 text-xs font-mono">
            vx:{freeLookVelocity.vx.toFixed(2)} vy:{freeLookVelocity.vy.toFixed(2)}
          </div>
        </div>
      )}
      
      {mode === 'free_look' && !isFreeLookActive && (
        <div className="mt-2 text-purple-400 text-xs">
          Click and drag to control gimbal
        </div>
      )}
      
      {mode === 'precise' && (
        <div className="mt-3 space-y-3">
          <div className="text-blue-400 text-xs">Click to center point precisely</div>
          {/* Time to target */}
          <div>
            <div className="flex justify-between text-xs text-gray-300 mb-1">
              <span>Time to target</span>
              <span className="font-mono">{preciseDurationMs} ms</span>
            </div>
            <input
              type="range"
              min={200}
              max={2500}
              step={50}
              value={preciseDurationMs}
              onChange={(e) => onPreciseDurationChange?.(parseInt(e.target.value))}
              className="w-full"
            />
          </div>
          {/* Strength */}
          <div>
            <div className="flex justify-between text-xs text-gray-300 mb-1">
              <span>Strength</span>
              <span className="font-mono">{preciseStrength.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={3.0}
              step={0.05}
              value={preciseStrength}
              onChange={(e) => onPreciseStrengthChange?.(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
      )}

      {/* Free Look tuning controls */}
      {mode === 'free_look' && (
        <div className="mt-3 space-y-3">
          {/* Sensitivity Slider */}
          <div>
            <div className="flex justify-between text-xs text-gray-300 mb-1">
              <span>Sensitivity</span>
              <span className="font-mono">{sensitivity.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={5.0}
              step={0.05}
              value={sensitivity}
              onChange={(e) => onSensitivityChange?.(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          {/* Smoothing Slider */}
          <div>
            <div className="flex justify-between text-xs text-gray-300 mb-1">
              <span>Smoothing</span>
              <span className="font-mono">{smoothing.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.0}
              max={0.9}
              step={0.05}
              value={smoothing}
              onChange={(e) => onSmoothingChange?.(parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="text-[10px] text-gray-500 mt-1">0 = snappy, 0.9 = very smooth</div>
          </div>
        </div>
      )}
    </div>
  );
};
