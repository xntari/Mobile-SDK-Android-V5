import React, { useRef, useEffect } from 'react';
import { HSICompassProps } from '../types';

export const HSICompass: React.FC<HSICompassProps> = ({ 
  attitude, 
  heading, 
  homeDirection 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawCompassRose = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    heading: number,
    homeDirection?: number,
    attitude?: { roll: number; pitch: number; yaw: number }
  ) => {
    // Clear canvas
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    // Draw outer circle
    ctx.strokeStyle = '#4B5563';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw compass markings
    ctx.strokeStyle = '#9CA3AF';
    ctx.lineWidth = 1;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < 360; i += 30) {
      const angle = (i - 90) * Math.PI / 180; // -90 to start at top
      const x1 = centerX + Math.cos(angle) * (radius - 15);
      const y1 = centerY + Math.sin(angle) * (radius - 15);
      const x2 = centerX + Math.cos(angle) * (radius - 5);
      const y2 = centerY + Math.sin(angle) * (radius - 5);
      
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Add degree labels
      if (i % 90 === 0) {
        const labelX = centerX + Math.cos(angle) * (radius - 25);
        const labelY = centerY + Math.sin(angle) * (radius - 25);
        const labels = ['N', 'E', 'S', 'W'];
        ctx.fillStyle = '#F3F4F6';
        ctx.fillText(labels[i / 90], labelX, labelY);
      }
    }

    // Draw aircraft heading indicator (triangle pointing up)
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(-heading * Math.PI / 180);
    
    ctx.fillStyle = '#1E88E5';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -radius + 10);
    ctx.lineTo(-8, -radius + 25);
    ctx.lineTo(8, -radius + 25);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    ctx.restore();

    // Draw home direction indicator (if available)
    if (homeDirection !== undefined) {
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(-homeDirection * Math.PI / 180);
      
      ctx.fillStyle = '#00D084';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -radius + 15);
      ctx.lineTo(-5, -radius + 25);
      ctx.lineTo(0, -radius + 30);
      ctx.lineTo(5, -radius + 25);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      
      ctx.restore();
    }

    // Draw center dot
    ctx.fillStyle = '#F3F4F6';
    ctx.beginPath();
    ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
    ctx.fill();

    // Draw attitude indicator (roll)
    if (attitude) {
      const rollAngle = attitude.roll * Math.PI / 180;
      const rollRadius = radius - 40;
      
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(-rollAngle);
      
      // Roll indicator line
      ctx.strokeStyle = '#FBBF24';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-rollRadius, 0);
      ctx.lineTo(rollRadius, 0);
      ctx.stroke();
      
      ctx.restore();
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const radius = Math.min(centerX, centerY) - 20;

    drawCompassRose(ctx, centerX, centerY, radius, heading, homeDirection, attitude || undefined);
  }, [attitude, heading, homeDirection]);

  return (
    <div className="glass-panel p-4">
      <div className="text-center mb-2">
        <div className="text-sm font-semibold text-gray-300">
          Horizontal Situation Indicator
        </div>
      </div>
      
      <div className="flex justify-center">
        <canvas 
          ref={canvasRef}
          width={350}
          height={200}
          className="border border-gray-600 rounded"
          style={{ width: '350px', height: '200px' }}
        />
      </div>
      
      {/* Digital readouts */}
      <div className="mt-3 flex justify-between text-xs">
        <div className="text-center">
          <div className="text-gray-400">HDG</div>
          <div className="font-mono text-dji-blue">
            {heading.toFixed(0)}°
          </div>
        </div>
        
        {attitude && (
          <>
            <div className="text-center">
              <div className="text-gray-400">ROLL</div>
              <div className="font-mono text-yellow-400">
                {attitude.roll.toFixed(1)}°
              </div>
            </div>
            
            <div className="text-center">
              <div className="text-gray-400">PITCH</div>
              <div className="font-mono text-green-400">
                {attitude.pitch.toFixed(1)}°
              </div>
            </div>
          </>
        )}
        
        {homeDirection !== undefined && (
          <div className="text-center">
            <div className="text-gray-400">HOME</div>
            <div className="font-mono text-status-good">
              {homeDirection.toFixed(0)}°
            </div>
          </div>
        )}
      </div>
    </div>
  );
};