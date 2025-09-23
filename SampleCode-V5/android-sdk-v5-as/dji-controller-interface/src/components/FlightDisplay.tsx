import React, { useRef, useEffect } from 'react';
import { TelemetryData } from '../types';

interface FlightDisplayProps {
  telemetryData: TelemetryData | null;
  size?: 'compact' | 'normal';
  theme?: 'classic' | 'contrast';
}

export const FlightDisplay: React.FC<FlightDisplayProps> = ({ 
  telemetryData, 
  size = 'compact',
  theme = 'classic'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const themeStyles = theme === 'contrast'
    ? {
        color: '#8aff68',
        lineWidth: 2.6,
        headingFont: '24px monospace',
        labelFont: '18px monospace',
        ladderFont: '16px monospace',
        velocityFont: '14px monospace',
        background: 'rgba(0,0,0,0.65)'
      }
    : {
        color: '#00FF00',
        lineWidth: 2,
        headingFont: '16px monospace',
        labelFont: '14px monospace',
        ladderFont: '12px monospace',
        velocityFont: '12px monospace',
        background: undefined as string | undefined
      };

  const drawHUD = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    attitude: { roll: number; pitch: number } | null,
    altitude: number,
    speed: number,
    heading: number,
    velocity?: { x: number; y: number; z: number }
  ) => {
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Set green color for all HUD elements
    if (themeStyles.background) {
      ctx.save();
      ctx.fillStyle = themeStyles.background;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    ctx.strokeStyle = themeStyles.color;
    ctx.fillStyle = themeStyles.color;
    ctx.lineWidth = themeStyles.lineWidth;

    if (attitude) {
      ctx.save();
      ctx.translate(centerX, centerY);
      
      // Rotate for roll angle
      ctx.rotate(-attitude.roll * Math.PI / 180);
      
      // Calculate pitch offset (pixels per degree)
      const pitchPixelsPerDegree = 3;
      const pitchOffset = attitude.pitch * pitchPixelsPerDegree;
      
      // Draw horizon line (wider)
      ctx.beginPath();
      ctx.moveTo(-150, -pitchOffset);
      ctx.lineTo(150, -pitchOffset);
      ctx.stroke();
      
      // Draw pitch ladder lines
      for (let pitch = -30; pitch <= 30; pitch += 10) {
        if (pitch === 0) continue; // Skip horizon line
        const lineY = -pitchOffset - (pitch * pitchPixelsPerDegree);
        const lineLength = pitch % 20 === 0 ? 60 : 40;
        
        // Draw pitch line
        ctx.beginPath();
        ctx.moveTo(-lineLength/2, lineY);
        ctx.lineTo(lineLength/2, lineY);
        ctx.stroke();
        
        // Add pitch labels
        if (pitch % 20 === 0) {
          ctx.font = themeStyles.ladderFont;
          ctx.textAlign = 'center';
          ctx.fillText(Math.abs(pitch).toString(), -lineLength/2 - 15, lineY + 4);
          ctx.fillText(Math.abs(pitch).toString(), lineLength/2 + 15, lineY + 4);
        }
      }
      
      ctx.restore();
    }
    
    // Draw aircraft symbol (fixed in center)
    ctx.beginPath();
    // Center dot
    ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
    ctx.fill();
    
    // Horizontal wings (shorter to clear center)
    ctx.beginPath();
    ctx.moveTo(centerX - 25, centerY);
    ctx.lineTo(centerX - 8, centerY);
    ctx.moveTo(centerX + 8, centerY);
    ctx.lineTo(centerX + 25, centerY);
    ctx.stroke();
    
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 8);
    ctx.lineTo(centerX, centerY + 8);
    ctx.stroke();
    
    // Draw altitude on far right side
    ctx.font = themeStyles.labelFont;
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(altitude)}m`, width - 80, centerY - 20);
    ctx.fillText('AMSL', width - 80, centerY - 5);

    // Draw speed on far left side
    ctx.textAlign = 'right';
    ctx.fillText(`${speed.toFixed(1)}`, 80, centerY - 20);
    ctx.fillText('m/s', 80, centerY - 5);
    
    // Draw heading at top
    ctx.font = themeStyles.headingFont;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(heading).toString().padStart(3, '0')}°`, centerX, 40);
    ctx.fillText('HDG', centerX, 60);

    if (velocity) {
      ctx.textAlign = 'left';
      ctx.font = themeStyles.velocityFont;
      const baseX = 20;
      let baseY = height - 70;
      ctx.fillText(`VX ${velocity.x.toFixed(1)} m/s`, baseX, baseY);
      baseY += 15;
      ctx.fillText(`VY ${velocity.y.toFixed(1)} m/s`, baseX, baseY);
      baseY += 15;
      ctx.fillText(`VZ ${velocity.z.toFixed(1)} m/s`, baseX, baseY);
      baseY += 15;
      const horiz = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      ctx.fillText(`VH ${horiz.toFixed(1)} m/s`, baseX, baseY);
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

    // Clear canvas with transparent background
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Safely extract telemetry, fallback to zeros
    const attitude = telemetryData?.attitude || { roll: 0, pitch: 0 } as any;
    // Calculate AMSL altitude (takeoff altitude + current altitude)
    const amslAltitude = telemetryData?.altitude_amsl ?? ((telemetryData?.takeoff_altitude || 0) + (telemetryData?.altitude || 0));
    const speed = telemetryData?.speed ?? 0;
    const heading = telemetryData?.compass_heading ?? telemetryData?.heading ?? 0;

    // Draw HUD overlay
    drawHUD(
      ctx,
      rect.width,
      rect.height,
      attitude,
      amslAltitude,
      speed,
      heading,
      telemetryData?.velocity_vector
    );
  }, [telemetryData, size, theme]);

  const sizeConfig = size === 'compact' 
    ? { width: 300, height: 200 }
    : { width: 600, height: 400 };

  return (
    <canvas 
      ref={canvasRef}
      className="pointer-events-none"
      style={{ 
        width: `${sizeConfig.width}px`, 
        height: `${sizeConfig.height}px`,
        background: 'transparent'
      }}
    />
  );
};
