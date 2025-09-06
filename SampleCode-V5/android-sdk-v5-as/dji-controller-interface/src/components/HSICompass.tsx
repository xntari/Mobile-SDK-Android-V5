import React, { useRef, useEffect } from 'react';
import { HSICompassProps } from '../types';

export const HSICompass: React.FC<HSICompassProps> = ({ 
  attitude, 
  heading, 
  homeDirection,
  size = 'normal',
  telemetryData
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawObstacleSectors = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    obstacleSectors: Array<{
      angle: number;
      distance: number;
      warning_level: 'none' | 'caution' | 'warning' | 'critical';
    }>
  ) => {
    if (!obstacleSectors.length) return;
    
    obstacleSectors.forEach(sector => {
      if (sector.warning_level === 'none') return;
      
      // Get color based on warning level
      const colors = {
        caution: '#FFEB3B',   // Yellow
        warning: '#FF9800',   // Orange  
        critical: '#F44336'   // Red
      };
      
      const color = colors[sector.warning_level];
      const sectorAngle = 20; // degrees
      const startAngle = (sector.angle - sectorAngle/2 - 90) * Math.PI / 180;
      const endAngle = (sector.angle + sectorAngle/2 - 90) * Math.PI / 180;
      
      // Calculate radius based on distance (closer = larger sector)
      const maxDistance = 10; // meters
      const sectorRadius = radius * 0.9 * Math.max(0.3, (maxDistance - Math.min(sector.distance, maxDistance)) / maxDistance);
      
      ctx.fillStyle = color + '80'; // Add transparency
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      
      // Draw triangular sector
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, sectorRadius, startAngle, endAngle);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
  };

  const drawCompassRose = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    heading: number,
    homeDirection?: number,
    attitude?: { roll: number; pitch: number; yaw: number },
    obstacleData?: Array<{
      angle: number;
      distance: number;
      warning_level: 'none' | 'caution' | 'warning' | 'critical';
    }>
  ) => {
    // Clear canvas
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    // Draw obstacle sectors first (so they appear behind other elements)
    if (obstacleData) {
      drawObstacleSectors(ctx, centerX, centerY, radius, obstacleData);
    }

    // Draw outer circle
    ctx.strokeStyle = '#4B5563';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw compass markings (rotate the compass rose instead of the arrow)
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(heading * Math.PI / 180); // Rotate compass rose by heading
    ctx.translate(-centerX, -centerY);
    
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
    
    ctx.restore();

    // Draw aircraft heading indicator (small triangle in center)
    ctx.restore(); // Exit rotated context for aircraft indicator
    
    ctx.fillStyle = '#1E88E5';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Smaller aircraft symbol in center
    ctx.moveTo(centerX, centerY - 6);
    ctx.lineTo(centerX - 4, centerY + 4);
    ctx.lineTo(centerX + 4, centerY + 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Draw heading value at top (fixed, not rotating) - positioned within canvas
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Background for heading text - positioned on the outside circle
    const headingText = Math.round(heading).toString();
    const textWidth = ctx.measureText(headingText).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(centerX - textWidth/2 - 6, centerY - radius - 10, textWidth + 12, 18);
    
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(headingText, centerX, centerY - radius - 1);
    
    // Re-enter save context for remaining elements
    ctx.save();

    // Draw home direction indicator (if available) - relative to rotated compass
    if (homeDirection !== undefined) {
      ctx.save();
      ctx.translate(centerX, centerY);
      // Rotate by (homeDirection - heading) to account for the rotated compass rose
      ctx.rotate(-(homeDirection - heading) * Math.PI / 180);
      
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
    
    ctx.restore(); // Exit any previous context
    
    // Draw obstacle distance display (like "10ft" in DJI) - fixed position
    if (obstacleData && obstacleData.length > 0) {
      const closestObstacle = obstacleData.reduce((closest, current) => 
        current.distance < closest.distance ? current : closest
      );
      
      if (closestObstacle.warning_level !== 'none') {
        const distance = closestObstacle.distance;
        const distanceText = distance < 1 ? `${(distance * 3.28).toFixed(0)}ft` : `${distance.toFixed(1)}m`;
        
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Draw background for text
        const textWidth = ctx.measureText(distanceText).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(centerX - textWidth/2 - 4, centerY + radius - 20, textWidth + 8, 16);
        
        ctx.fillStyle = closestObstacle.warning_level === 'critical' ? '#FF4444' : '#FFAA00';
        ctx.fillText(distanceText, centerX, centerY + radius - 12);
      }
    }

    // Roll indicator removed - HSI focuses on horizontal navigation only
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
    // Make compass larger, especially for small size
    const radius = size === 'small' 
      ? Math.min(centerX, centerY) - 12  // Larger radius for small HSI
      : Math.min(centerX, centerY) - 20;

    // Debug: Log heading values to console
    console.log('🎯 HSI Heading Debug:', {
      prop_heading: heading,
      telemetry_heading: telemetryData?.heading,
      telemetry_compass_heading: telemetryData?.compass_heading,
      attitude_yaw: telemetryData?.attitude?.yaw
    });
    
    // Use real obstacle data from DJI bridge
    const obstacleData = telemetryData?.obstacle_avoidance?.enabled 
      ? telemetryData.obstacle_avoidance.sectors 
      : undefined;
      
    drawCompassRose(ctx, centerX, centerY, radius, heading, homeDirection, attitude || undefined, obstacleData);
  }, [attitude, heading, homeDirection, telemetryData]);

  // Size configurations - make small HSI match Live Map width (208px)
  const sizeConfig = size === 'small' 
    ? { width: 208, height: 160, canvasWidth: 208, canvasHeight: 160 }
    : { width: 350, height: 200, canvasWidth: 350, canvasHeight: 200 };

  return (
    <div className={`glass-panel ${size === 'small' ? 'p-2' : 'p-4'}`}>
      {size === 'normal' && (
        <div className="text-center mb-2">
          <div className="text-sm font-semibold text-gray-300">
            Horizontal Situation Indicator
          </div>
        </div>
      )}
      
      <div className="flex justify-center">
        <canvas 
          ref={canvasRef}
          width={sizeConfig.canvasWidth}
          height={sizeConfig.canvasHeight}
          className="border border-gray-600 rounded"
          style={{ 
            width: `${sizeConfig.width}px`, 
            height: `${sizeConfig.height}px` 
          }}
        />
      </div>
      
      {/* Digital readouts - only show for normal size */}
      {size === 'normal' && (
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
      )}
    </div>
  );
};