import React, { useRef, useEffect } from 'react';
import { TelemetryData } from '../types';

interface FlightDisplayProps {
  telemetryData: TelemetryData | null;
  size?: 'compact' | 'normal';
}

export const FlightDisplay: React.FC<FlightDisplayProps> = ({ 
  telemetryData, 
  size = 'compact' 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawArtificialHorizon = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    attitude: { roll: number; pitch: number } | null
  ) => {
    if (!attitude) return;

    ctx.save();
    ctx.translate(x, y);
    
    // Create circular clipping mask
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    
    // Rotate for roll angle
    ctx.rotate(-attitude.roll * Math.PI / 180);
    
    // Calculate pitch offset
    const pitchOffset = attitude.pitch * 2; // Scale pitch for visual effect
    
    // Draw sky (blue)
    ctx.fillStyle = '#4A90E2';
    ctx.fillRect(-radius, -radius - pitchOffset, radius * 2, radius + pitchOffset);
    
    // Draw ground (brown)
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(-radius, -pitchOffset, radius * 2, radius * 2);
    
    // Draw horizon line
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-radius, -pitchOffset);
    ctx.lineTo(radius, -pitchOffset);
    ctx.stroke();
    
    // Draw pitch lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    for (let i = -30; i <= 30; i += 10) {
      if (i === 0) continue; // Skip horizon line
      const lineY = -pitchOffset - (i * 2);
      const lineLength = i % 20 === 0 ? radius * 0.3 : radius * 0.2;
      
      ctx.beginPath();
      ctx.moveTo(-lineLength, lineY);
      ctx.lineTo(lineLength, lineY);
      ctx.stroke();
      
      // Add degree labels for major lines
      if (i % 20 === 0 && Math.abs(i) <= 20) {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(Math.abs(i).toString(), 0, lineY + 3);
      }
    }
    
    ctx.restore();
    
    // Draw aircraft symbol (fixed in center)
    ctx.strokeStyle = '#FFFF00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    // Aircraft wings
    ctx.moveTo(x - radius * 0.3, y);
    ctx.lineTo(x - radius * 0.1, y);
    ctx.moveTo(x + radius * 0.1, y);
    ctx.lineTo(x + radius * 0.3, y);
    // Aircraft center
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.stroke();
    
    // Draw outer ring
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  };

  const drawAltitudeIndicator = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    altitude: number
  ) => {
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
    
    // Altitude tape
    const centerY = y + height / 2;
    const pixelsPerMeter = height / 200; // 200m range
    
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    ctx.textAlign = 'right';
    
    // Draw altitude scale
    for (let alt = Math.floor(altitude / 10) * 10 - 100; alt <= altitude + 100; alt += 20) {
      const altY = centerY - (alt - altitude) * pixelsPerMeter;
      if (altY > y && altY < y + height) {
        // Tick mark
        ctx.strokeStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(x + width - 10, altY);
        ctx.lineTo(x + width, altY);
        ctx.stroke();
        
        // Altitude label
        if (alt % 40 === 0) {
          ctx.fillText(alt.toString(), x + width - 12, altY + 4);
        }
      }
    }
    
    // Current altitude box
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + width - 50, centerY - 12, 48, 24);
    ctx.strokeStyle = '#FFFF00';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + width - 50, centerY - 12, 48, 24);
    
    ctx.fillStyle = '#FFFF00';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(altitude).toString(), x + width - 26, centerY + 5);
  };

  const drawSpeedIndicator = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    speed: number
  ) => {
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
    
    // Speed tape
    const centerY = y + height / 2;
    const pixelsPerMps = height / 20; // 20 m/s range
    
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    
    // Draw speed scale
    for (let spd = Math.floor(speed / 2) * 2 - 10; spd <= speed + 10; spd += 2) {
      if (spd < 0) continue;
      const spdY = centerY - (spd - speed) * pixelsPerMps;
      if (spdY > y && spdY < y + height) {
        // Tick mark
        ctx.strokeStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(x, spdY);
        ctx.lineTo(x + 10, spdY);
        ctx.stroke();
        
        // Speed label
        if (spd % 4 === 0) {
          ctx.fillText(spd.toString(), x + 12, spdY + 4);
        }
      }
    }
    
    // Current speed box
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + 2, centerY - 12, 48, 24);
    ctx.strokeStyle = '#00FF00';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 2, centerY - 12, 48, 24);
    
    ctx.fillStyle = '#00FF00';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(speed.toFixed(1), x + 26, centerY + 5);
  };

  const drawCompass = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    heading: number
  ) => {
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
    
    // Compass tape
    const centerX = x + width / 2;
    const pixelsPerDegree = width / 60; // 60 degree range
    
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    
    // Draw heading scale
    for (let hdg = Math.floor(heading / 10) * 10 - 30; hdg <= heading + 30; hdg += 10) {
      let normalizedHdg = ((hdg % 360) + 360) % 360;
      const hdgX = centerX - (hdg - heading) * pixelsPerDegree;
      
      if (hdgX > x && hdgX < x + width) {
        // Tick mark
        ctx.strokeStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(hdgX, y);
        ctx.lineTo(hdgX, y + 10);
        ctx.stroke();
        
        // Heading label
        if (normalizedHdg % 30 === 0) {
          const label = normalizedHdg === 0 ? 'N' : 
                       normalizedHdg === 90 ? 'E' :
                       normalizedHdg === 180 ? 'S' :
                       normalizedHdg === 270 ? 'W' :
                       normalizedHdg.toString();
          ctx.fillText(label, hdgX, y + 22);
        }
      }
    }
    
    // Current heading indicator
    ctx.strokeStyle = '#FFFF00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX - 8, y);
    ctx.lineTo(centerX, y + 8);
    ctx.lineTo(centerX + 8, y);
    ctx.stroke();
    
    // Current heading box
    ctx.fillStyle = '#000000';
    ctx.fillRect(centerX - 25, y + height - 20, 50, 18);
    ctx.strokeStyle = '#FFFF00';
    ctx.strokeRect(centerX - 25, y + height - 20, 50, 18);
    
    ctx.fillStyle = '#FFFF00';
    ctx.font = '14px monospace';
    ctx.fillText(Math.round(heading).toString().padStart(3, '0'), centerX, y + height - 7);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !telemetryData) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    // Clear canvas
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (size === 'compact') {
      // Compact layout: attitude indicator + digital displays
      const centerX = rect.width / 2;
      const attRadius = Math.min(rect.width, rect.height) * 0.25;
      
      // Artificial horizon
      drawArtificialHorizon(ctx, centerX, attRadius + 20, attRadius, telemetryData.attitude);
      
      // Digital readouts below
      const startY = attRadius * 2 + 50;
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      
      ctx.fillText(`ALT: ${telemetryData.altitude.toFixed(0)}m`, centerX, startY);
      ctx.fillText(`SPD: ${telemetryData.speed.toFixed(1)}m/s`, centerX, startY + 20);
      ctx.fillText(`HDG: ${telemetryData.heading.toFixed(0)}°`, centerX, startY + 40);
      
    } else {
      // Full layout: attitude indicator + analog tapes
      const ahSize = Math.min(rect.width * 0.4, rect.height * 0.6);
      const ahX = rect.width / 2;
      const ahY = rect.height / 2;
      
      drawArtificialHorizon(ctx, ahX, ahY, ahSize / 2, telemetryData.attitude);
      
      // Speed tape (left)
      drawSpeedIndicator(ctx, 20, ahY - ahSize / 2, 60, ahSize, telemetryData.speed);
      
      // Altitude tape (right) 
      drawAltitudeIndicator(ctx, rect.width - 80, ahY - ahSize / 2, 60, ahSize, telemetryData.altitude);
      
      // Compass tape (bottom)
      drawCompass(ctx, ahX - 100, rect.height - 50, 200, 40, telemetryData.heading);
    }
  }, [telemetryData, size]);

  const sizeConfig = size === 'compact' 
    ? { width: 200, height: 200 }
    : { width: 400, height: 350 };

  return (
    <div className="glass-panel p-3">
      <div className="text-xs text-gray-400 mb-2 text-center">
        Primary Flight Display
      </div>
      
      <canvas 
        ref={canvasRef}
        className="border border-gray-600 rounded"
        style={{ 
          width: `${sizeConfig.width}px`, 
          height: `${sizeConfig.height}px` 
        }}
      />
    </div>
  );
};