import React from 'react';

export type GimbalMode = 'off' | 'free_look' | 'precise';


interface GimbalModeToggleProps {
  mode: GimbalMode;
  onModeChange: (mode: GimbalMode) => void;
  className?: string;
  isFreeLookActive?: boolean;
  freeLookVelocity?: { vx: number; vy: number };
}

export const GimbalModeToggle: React.FC<GimbalModeToggleProps> = ({
  mode,
  onModeChange,
  className = '',
  isFreeLookActive = false,
  freeLookVelocity = { vx: 0, vy: 0 }
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
        <div className="mt-2 text-blue-400 text-xs">
          Click to center point precisely
        </div>
      )}
    </div>
  );
};