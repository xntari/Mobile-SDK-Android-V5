import React from 'react';

export type GimbalMode = 'look_at' | 'free_look';


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
  // Camera selection
  selectedLens?: 'wide' | 'zoom' | 'infrared';
  onLensChange?: (lens: 'wide' | 'zoom' | 'infrared') => void;
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
  selectedLens = 'wide',
  onLensChange
}) => {
  const modes: { value: GimbalMode; label: string }[] = [
    { value: 'look_at', label: 'Look At' },
    { value: 'free_look', label: 'Free Look' },
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
      
      {/* Camera selection */}
      <div className="mt-3">
        <div className="text-xs text-gray-400 mb-2 font-semibold">CAMERA</div>
        <div className="flex gap-1">
          {[
            { key: 'wide', label: 'Wide' },
            { key: 'zoom', label: 'Zoom' },
            { key: 'infrared', label: 'IR' }
          ].map(opt => (
            <button
              key={opt.key}
              onClick={() => onLensChange?.(opt.key as any)}
              className={`px-3 py-1 text-xs rounded ${selectedLens === opt.key ? 'bg-dji-blue text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

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
