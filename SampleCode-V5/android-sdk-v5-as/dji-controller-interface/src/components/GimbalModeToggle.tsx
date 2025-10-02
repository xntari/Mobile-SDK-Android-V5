import React from 'react';

export type GimbalMode = 'look_at' | 'free_look';
export type GimbalAttitudeMode = 'FREE' | 'YAW_FOLLOW' | 'FPV';


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
  // Laser controls
  laserOn?: boolean;
  onToggleLaser?: (on: boolean) => void;
  // Zoom control
  zoomRatio?: number;
  zoomRange?: { min?: number; max?: number };
  zoomEnabled?: boolean;
  onZoomChange?: (ratio: number) => void;
  gimbalAttitudeMode?: GimbalAttitudeMode;
  onGimbalAttitudeModeChange?: (mode: GimbalAttitudeMode) => void;
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
  onLensChange,
  laserOn = false,
  onToggleLaser,
  zoomRatio,
  zoomRange,
  zoomEnabled = true,
  onZoomChange,
  gimbalAttitudeMode = 'YAW_FOLLOW',
  onGimbalAttitudeModeChange,
}) => {
  const modes: { value: GimbalMode; label: string }[] = [
    { value: 'look_at', label: 'Look At' },
    { value: 'free_look', label: 'Free Look' },
  ];

  const showZoomRange = typeof zoomRange?.min === 'number' && typeof zoomRange?.max === 'number';
  const minZoom = showZoomRange ? (zoomRange!.min as number) : 1;
  const maxZoom = showZoomRange ? (zoomRange!.max as number) : 30;
  const zoomValue = typeof zoomRatio === 'number' ? zoomRatio : minZoom;
  const clampedZoom = Math.min(maxZoom, Math.max(minZoom, zoomValue));

  const attitudeModes: { value: GimbalAttitudeMode; label: string }[] = [
    { value: 'FREE', label: 'Free' },
    { value: 'YAW_FOLLOW', label: 'Yaw Follow' },
    { value: 'FPV', label: 'FPV' },
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

      <div className="mt-3">
        <div className="text-xs text-gray-400 mb-2 font-semibold">GIMBAL ATTITUDE</div>
        <div className="flex gap-1">
          {attitudeModes.map((item) => (
            <button
              key={item.value}
              onClick={() => onGimbalAttitudeModeChange?.(item.value)}
              className={`px-3 py-1 text-xs rounded ${gimbalAttitudeMode === item.value ? 'bg-dji-blue text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
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

      {/* Zoom control */}
      <div className="mt-3">
        <div className="flex justify-between text-xs text-gray-400 mb-1 font-semibold">
          <span>ZOOM</span>
          <span className="text-gray-200 font-mono">
            {typeof zoomRatio === 'number' ? `${zoomRatio.toFixed(1)}×` : '–'}
          </span>
        </div>
        <input
          type="range"
          min={minZoom}
          max={maxZoom}
          step={0.1}
          value={clampedZoom}
          onChange={(e) => onZoomChange?.(parseFloat(e.target.value))}
          className="w-full"
          disabled={!zoomEnabled || !onZoomChange}
        />
        {showZoomRange && (
          <div className="text-[10px] text-gray-500 mt-1">
            Range {(zoomRange!.min as number).toFixed(1)}× – {(zoomRange!.max as number).toFixed(1)}×
          </div>
        )}
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

      {/* Laser controls */}
      <div className="mt-3">
        <div className="text-xs text-gray-400 mb-2 font-semibold">LASER</div>
        <div className="flex gap-1">
          <button
            onClick={() => onToggleLaser?.(!laserOn)}
            className={`px-3 py-1 text-xs rounded ${laserOn ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
          >
            {laserOn ? 'On' : 'Off'}
          </button>
        </div>
      </div>
    </div>
  );
};
