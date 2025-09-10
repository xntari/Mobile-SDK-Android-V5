import React, { useRef, useEffect, useState } from 'react';
import { HSICompassProps } from '../types';

export const HSICompass: React.FC<HSICompassProps> = ({ 
  attitude, 
  heading, 
  homeDirection,
  size = 'normal',
  telemetryData
}) => {
  const [useRawPerceptionData, setUseRawPerceptionData] = useState(true);
  const [scaleRange, setScaleRange] = useState(8); // Default 8m range
  const [useLogarithmicScale, setUseLogarithmicScale] = useState(true); // Logarithmic by default
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Convert distance to visual radius using linear or logarithmic scale
  const distanceToRadius = (distance: number, maxDistance: number, radius: number): number => {
    if (useLogarithmicScale) {
      // Logarithmic scale: log(1 + distance) / log(1 + maxDistance)
      // This exaggerates small distances and compresses large ones
      const normalizedLog = Math.log(1 + distance) / Math.log(1 + maxDistance);
      return normalizedLog * radius;
    } else {
      // Linear scale: distance / maxDistance
      return (distance / maxDistance) * radius;
    }
  };

  // Draw obstacle paths based on raw distance arrays (like official DJI HSI)
  const drawObstacleDistances = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    obstacleData: any
  ) => {
    if (!obstacleData) return;
    
    // Use raw distance arrays from bridge (radar_distances or perception_distances)
    const radarDistances = obstacleData.radar_distances;
    const perceptionDistances = obstacleData.perception_distances;
    
    // console.log(`🎨 Drawing obstacle paths:`, {
    //   radar_distances: radarDistances?.length || 0,
    //   perception_distances: perceptionDistances?.length || 0,
    //   closest_distance: obstacleData.closest_distance
    // });
    
    // Draw radar obstacles (like official HSI does)
    if (radarDistances && Array.isArray(radarDistances) && radarDistances.length > 0) {
      drawDistanceArray(ctx, centerX, centerY, radius, radarDistances, 'radar');
    }
    
    // Draw perception obstacles (like official HSI does)  
    if (perceptionDistances && Array.isArray(perceptionDistances) && perceptionDistances.length > 0) {
      drawDistanceArray(ctx, centerX, centerY, radius, perceptionDistances, 'perception');
    }
    
    // Use toggle to decide between raw perception data and processed sectors
    if (useRawPerceptionData && perceptionDistances && Array.isArray(perceptionDistances) && perceptionDistances.length > 0) {
      // console.log('🎨 Using raw perception distances (360° array) for infrared obstacles');
      drawDistanceArray(ctx, centerX, centerY, radius, perceptionDistances, 'perception');
    }
    else if (!useRawPerceptionData && obstacleData.sectors && Array.isArray(obstacleData.sectors)) {
      // console.log('🎨 Using processed sectors for', obstacleData.sectors.length, 'obstacles');
      drawObstacleSectors(ctx, centerX, centerY, radius, obstacleData.sectors);
    }
    // Fallback when preferred mode data is not available
    else if (obstacleData.sectors && Array.isArray(obstacleData.sectors)) {
      // console.log('🎨 Fallback: Using processed sectors for', obstacleData.sectors.length, 'obstacles');
      drawObstacleSectors(ctx, centerX, centerY, radius, obstacleData.sectors);
    }
  };

  const drawDistanceArray = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    distances: number[],
    source: 'radar' | 'perception'
  ) => {
    if (!distances.length) return;
    
    const maxVisibleDistance = scaleRange; // Dynamic scale range
    const degreesPerSector = 360 / distances.length; // degrees per array element (should be 1°)
    
    // Smooth color transition based on distance with gradual opacity
    const getObstacleColorAndAlpha = (distanceInMeters: number): { color: string; alpha: number } => {
      let r, g, b, alpha;
      
      // Special case: >= 6m (60000mm) means very critical distance < 75cm  
      if (distanceInMeters >= 6) {
        return { color: 'rgb(255, 0, 0)', alpha: 1.0 }; // Bright red, full opacity
      }
      
      if (distanceInMeters < 1) {
        // Critical: Red
        r = 255; g = 0; b = 0;
        alpha = 0.9;
      } else if (distanceInMeters < 2) {
        // Transition from red to orange (1-2m)
        const t = (distanceInMeters - 1) / 1; // 0 to 1
        r = 255;
        g = Math.round(165 * t); // 0 to 165 (orange)
        b = 0;
        alpha = 0.8 - (t * 0.2); // 0.8 to 0.6
      } else if (distanceInMeters < 5) {
        // Transition from orange to yellow (2-5m)
        const t = (distanceInMeters - 2) / 3; // 0 to 1
        r = 255;
        g = Math.round(165 + (255 - 165) * t); // 165 to 255 (yellow)
        b = 0;
        alpha = 0.6 - (t * 0.2); // 0.6 to 0.4
      } else {
        // Transition from yellow to green (5m+)
        const t = Math.min((distanceInMeters - 5) / 3, 1); // 0 to 1, capped at 1
        r = Math.round(255 - 179 * t); // 255 to 76 (green)
        g = 255;
        b = Math.round(0 + 175 * t); // 0 to 175 (green)
        alpha = 0.4 - (t * 0.2); // 0.4 to 0.2
      }
      
      return { color: `rgb(${r}, ${g}, ${b})`, alpha: Math.max(alpha, 0.1) };
    };
    
    let obstacleCount = 0;
    for (let i = 0; i < distances.length; i++) {
      const distanceInMm = distances[i];
      const distanceInMeters = distanceInMm / 1000.0;
      
      // Draw obstacles - handle special case for >= 6m readings
      const shouldDraw = (distanceInMeters >= 6) || (distanceInMeters > 0 && distanceInMeters <= maxVisibleDistance);
      
      if (shouldDraw) {
        const angle = i * degreesPerSector; // degrees
        const startAngle = (angle - degreesPerSector/2 - 90) * Math.PI / 180; // -90 to start at top
        const endAngle = (angle + degreesPerSector/2 - 90) * Math.PI / 180;
        
        // Calculate obstacle position - for >= 6m readings, treat as very close (0.75m)
        const actualDistance = distanceInMeters >= 6 ? 0.75 : distanceInMeters;
        const obstacleRadius = distanceToRadius(actualDistance, maxVisibleDistance, radius);
        
        const { color, alpha } = getObstacleColorAndAlpha(distanceInMeters);
        
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = alpha;
        
        // Draw sector from center to obstacle distance (not inverted)
        ctx.beginPath();
        ctx.moveTo(centerX, centerY); // Start at center
        
        // Arc to obstacle distance
        ctx.arc(centerX, centerY, obstacleRadius, startAngle, endAngle);
        ctx.closePath();
        ctx.fill();
        
        obstacleCount++;
      }
    }
    
    ctx.globalAlpha = 1.0; // Reset transparency
    //console.log(`🎨 Drew ${obstacleCount} ${source} obstacle sectors (360° data, ${scaleRange}m range)`);
  };

  // Draw scale legend rings and labels
  const drawScaleLegend = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number
  ) => {
    const maxDistance = scaleRange;
    const ringDistances = [maxDistance * 0.25, maxDistance * 0.5, maxDistance * 0.75, maxDistance]; // 25%, 50%, 75%, 100%
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]); // Dashed lines
    
    // Draw distance rings
    ringDistances.forEach((distance, index) => {
      const ringRadius = distanceToRadius(distance, maxDistance, radius);
      
      ctx.beginPath();
      ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      
      // Add distance labels at the top of each ring
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      
      const labelText = distance < 1 ? `${(distance * 100).toFixed(0)}cm` : `${distance.toFixed(1)}m`;
      ctx.fillText(labelText, centerX, centerY - ringRadius + 3);
    });
    
    ctx.setLineDash([]); // Reset line dash
  };

  // Primary function to draw obstacles using processed sectors from PerceptionManager
  const drawObstacleSectors = (
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radius: number,
    sectors: Array<{
      angle: number;
      distance: number;
      warning_level: 'none' | 'caution' | 'warning' | 'critical';
      source?: 'radar' | 'perception';
    }>
  ) => {
    if (!sectors.length) return;
    
    console.log(`🎨 Drawing ${sectors.length} obstacle sectors with source differentiation`);
    
    sectors.forEach((sector, index) => {
      if (sector.warning_level === 'none') return; // Skip safe sectors
      
      // Get color based on warning level (back to original)
      const colors = {
        caution: '#FFEB3B',   // Yellow
        warning: '#FF9800',   // Orange  
        critical: '#F44336'   // Red
      };
      
      const color = colors[sector.warning_level];
      const sectorAngle = 15; // degrees (smaller than before)
      const startAngle = (sector.angle - sectorAngle/2 - 90) * Math.PI / 180;
      const endAngle = (sector.angle + sectorAngle/2 - 90) * Math.PI / 180;
      
      // Calculate radius based on distance (closer = larger sector) - use dynamic scale
      const maxDistance = scaleRange; // Use the same scale as the map
      const clampedDistance = Math.min(sector.distance, maxDistance);
      const sectorRadius = distanceToRadius(clampedDistance, maxDistance, radius);
      
      ctx.fillStyle = color + '60'; // Add transparency
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      
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
    obstacleData?: any
  ) => {
    // Clear canvas
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    // Draw obstacle distance arrays first (so they appear behind other elements)
    if (obstacleData) {
      drawObstacleDistances(ctx, centerX, centerY, radius, obstacleData);
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
    // draw in the corner left top, todo : avoid hardcoded positioning
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Background for heading text - positioned further outside the circle for more space
    const headingText = `${Math.round(heading).toString()}°`;;
    const textWidth = ctx.measureText(headingText).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(centerX - textWidth/2 - 76, centerY - radius - 6, textWidth + 12, 18);
    
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(headingText, centerX - 70, centerY - radius + 4);
    
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
      // Move home direction indicator outside the circle
      ctx.moveTo(0, -radius - 5);
      ctx.lineTo(-6, -radius + 5);
      ctx.lineTo(0, -radius + 10);
      ctx.lineTo(6, -radius + 5);
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
    
    // Draw obstacle distance display (like "3m" in DJI) - fixed position
    // draw in the corner right bottom : avoid hardcoded positioning
    if (obstacleData && obstacleData.closest_distance) {
      const distance = obstacleData.closest_distance;
      const distanceText = distance < 1 ? `${(distance * 3.28).toFixed(0)}ft` : `${distance.toFixed(1)}m`;
      
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // Draw background for text - positioned outside the circle
      const textWidth = ctx.measureText(distanceText).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(centerX - textWidth/2 + 74, centerY + radius - 8, textWidth + 8, 16);
      
      // Color based on system status (from bridge)
      const statusColor = obstacleData.system_status === 'critical' ? '#FF4444' : 
                         obstacleData.system_status === 'warning' ? '#FFAA00' : '#00FF00';
      ctx.fillStyle = statusColor;
      ctx.fillText(distanceText, centerX + 78, centerY + radius + 1);
    }

    // Draw scale legend rings and distance labels
    drawScaleLegend(ctx, centerX, centerY, radius);

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
      ? Math.min(centerX, centerY) - 14  // Larger radius for small HSI
      : Math.min(centerX, centerY) - 20;

    // Debug: Log heading values to console
    //console.log('🎯 HSI Heading Debug:', {
    //  prop_heading: heading,
    //  telemetry_heading: telemetryData?.heading,
    //  telemetry_compass_heading: telemetryData?.compass_heading,
    //  attitude_yaw: telemetryData?.attitude?.yaw
    //});
    
    // Use real obstacle data from DJI bridge - use raw distance arrays (like official HSI)
    const obstacleData = telemetryData?.obstacle_avoidance || undefined;
                         
    // Debug: Log obstacle data structure to understand what we're receiving
    if (telemetryData?.obstacle_avoidance) {
      //console.log('🛡️ Obstacle Data Debug:', {
      //  full_obstacle_data: telemetryData.obstacle_avoidance,
      //  has_sectors: !!telemetryData.obstacle_avoidance.sectors,
      //  has_enabled: telemetryData.obstacle_avoidance.enabled,
      //});
    } else {
      // console.log('🛡️ No obstacle_avoidance data in telemetryData');
    }
      
    drawCompassRose(ctx, centerX, centerY, radius, heading, homeDirection, attitude || undefined, obstacleData);
  }, [attitude, heading, homeDirection, telemetryData, useRawPerceptionData, scaleRange, useLogarithmicScale]);

  // Size configurations - increased height to fit heading above and distance below
  const sizeConfig = size === 'small' 
    ? { width: 208, height: 200, canvasWidth: 208, canvasHeight: 200 }
    : { width: 350, height: 260, canvasWidth: 350, canvasHeight: 260 };

  return (
    <div className={`glass-panel ${size === 'small' ? 'p-2' : 'p-4'}`}>
      {size === 'normal' && (
        <div className="text-center mb-2">
          <div className="text-sm font-semibold text-gray-300">
            Horizontal Situation Indicator
          </div>
          <div className="mt-2 flex justify-center">
            <button
              onClick={() => setUseRawPerceptionData(!useRawPerceptionData)}
              className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                useRawPerceptionData 
                  ? 'bg-dji-blue text-white border-dji-blue' 
                  : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
              }`}
            >
              {useRawPerceptionData ? '360° Raw Data' : 'Processed Sectors'}
            </button>
          </div>
          
          <div className="mt-2 px-2">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Scale</span>
              <span>{scaleRange}m</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="8"
              step="0.5"
              value={scaleRange}
              onChange={(e) => setScaleRange(parseFloat(e.target.value))}
              className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>0.5m</span>
              <span>8m</span>
            </div>
          </div>
          
          <div className="mt-2 px-2">
            <label className="flex items-center text-xs text-gray-400">
              <input
                type="checkbox"
                checked={useLogarithmicScale}
                onChange={(e) => setUseLogarithmicScale(e.target.checked)}
                className="mr-2 rounded"
              />
              Logarithmic Scale (exaggerate close distances)
            </label>
          </div>
        </div>
      )}
      
      {size === 'small' && (
        <div className="text-center mb-1">
          <div className="text-xs font-semibold text-gray-300 mb-1">HSI</div>
          <button
            onClick={() => setUseRawPerceptionData(!useRawPerceptionData)}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              useRawPerceptionData 
                ? 'bg-dji-blue text-white border-dji-blue' 
                : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
            }`}
          >
            {useRawPerceptionData ? '360°' : 'Sectors'}
          </button>
          
          <div className="mt-1 px-1">
            <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
              <span>Scale</span>
              <span>{scaleRange}m</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="8"
              step="0.5"
              value={scaleRange}
              onChange={(e) => setScaleRange(parseFloat(e.target.value))}
              className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
            />
          </div>
          
          <div className="mt-1 px-1">
            <label className="flex items-center text-xs text-gray-400">
              <input
                type="checkbox"
                checked={useLogarithmicScale}
                onChange={(e) => setUseLogarithmicScale(e.target.checked)}
                className="mr-1 rounded scale-75"
              />
              Log Scale
            </label>
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
