import React from 'react';

interface CameraDisplayProps {
  className?: string;
}

export const CameraDisplay: React.FC<CameraDisplayProps> = ({ className = '' }) => {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      {/* Simple crosshair in the center */}
      <div className="absolute">
        {/* Horizontal line */}
        <div className="absolute w-4 h-px bg-green-500 opacity-80" 
             style={{ left: '-8px', top: '0px' }}></div>
        <div className="absolute w-4 h-px bg-green-500 opacity-80" 
             style={{ right: '-8px', top: '0px' }}></div>
        
        {/* Vertical line */}
        <div className="absolute h-4 w-px bg-green-500 opacity-80" 
             style={{ top: '-8px', left: '0px' }}></div>
        <div className="absolute h-4 w-px bg-green-500 opacity-80" 
             style={{ bottom: '-8px', left: '0px' }}></div>
        
        {/* Center dot */}
        <div className="absolute w-1 h-1 bg-green-500 rounded-full"
             style={{ top: '-2px', left: '-2px' }}></div>
      </div>
    </div>
  );
};