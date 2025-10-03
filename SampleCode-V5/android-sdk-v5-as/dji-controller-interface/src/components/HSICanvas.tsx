import React, { useEffect, useRef, useState } from 'react';
import type { TelemetryData } from '../types';

type HeadingTarget = {
  bearing: number;
  distance?: number;
  altitudeDelta?: number | null;
  pitch?: number | null;
} | null;

export interface HSICanvasProps {
  telemetry: TelemetryData | null;
  target?: HeadingTarget;
  mission?: HeadingTarget;
  poi?: HeadingTarget;
  scaleRange: number;
  useLogarithmicScale: boolean;
  useRawPerceptionData: boolean;
  className?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const HSICanvas: React.FC<HSICanvasProps> = ({
  telemetry,
  target,
  mission,
  poi,
  scaleRange,
  useLogarithmicScale,
  useRawPerceptionData,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const { width, height } = entry.contentRect;
      setDimensions({ width, height });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dimensions.width === 0 || dimensions.height === 0) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(dimensions.width * dpr);
    canvas.height = Math.round(dimensions.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const minEdge = Math.min(dimensions.width, dimensions.height);
    const radius = clamp(minEdge / 2 - 30, 80, 240);

    const convertYawToCompass = (yaw?: number | null): number => {
      if (typeof yaw !== 'number' || Number.isNaN(yaw)) return 0;
      let compass = yaw;
      while (compass < 0) compass += 360;
      while (compass >= 360) compass -= 360;
      return compass;
    };

    const compassHeading = convertYawToCompass(
      telemetry?.compass_heading ?? telemetry?.heading ?? telemetry?.attitude?.yaw ?? 0,
    );

    const gimbal = telemetry?.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
    const gimbalYawRelative = gimbal?.yaw_relative ?? 0;
    const gimbalPitch = gimbal?.attitude?.pitch ?? 0;

    const velocity = telemetry?.velocity_vector;

    const distanceToRadius = (distance: number, maxDistance: number, baseRadius: number): number => {
      if (distance <= 0) return 0;
      if (useLogarithmicScale) {
        const normalizedLog = Math.log(1 + distance) / Math.log(1 + maxDistance);
        return clamp(normalizedLog, 0, 1) * baseRadius;
      }
      return clamp(distance / maxDistance, 0, 1) * baseRadius;
    };

    const drawHeadingReadout = () => {
      const headingText = `${Math.round(compassHeading).toString().padStart(3, '0')}°`;
      const boxWidth = 48;
      const boxHeight = 18;
      const boxX = centerX - boxWidth / 2;
      const boxY = centerY - radius - boxHeight + 8;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(boxX, boxY, boxWidth, boxHeight);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#e0f2fe';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(headingText, centerX, boxY + boxHeight / 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius + 12, 0, Math.PI * 2);
      ctx.stroke();
    };
    const drawScaleLegend = () => {
      const maxDistance = scaleRange;
      const rings = [0.25, 0.5, 0.75, 1].map((fraction) => fraction * maxDistance);

      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;

      rings.forEach((distance) => {
        const ringRadius = distanceToRadius(distance, maxDistance, radius);
        ctx.beginPath();
        ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        const label = distance < 1 ? `${(distance * 100).toFixed(0)}cm` : `${distance.toFixed(1)}m`;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, centerX, centerY - ringRadius + 3);
      });

      ctx.restore();
    };

    const drawTickMarks = () => {
      ctx.strokeStyle = '#4a5568';
      ctx.lineWidth = 1;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let i = 0; i < 360; i += 10) {
        const relativeAngle = (i - compassHeading + 360) % 360;
        const rad = ((relativeAngle - 90) * Math.PI) / 180;
        const startRadius = i % 30 === 0 ? radius - 10 : radius - 5;
        const endRadius = radius;

        ctx.beginPath();
        ctx.moveTo(centerX + Math.cos(rad) * startRadius, centerY + Math.sin(rad) * startRadius);
        ctx.lineTo(centerX + Math.cos(rad) * endRadius, centerY + Math.sin(rad) * endRadius);
        ctx.stroke();

        if (i % 90 === 0) {
          const directions: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
          const textRadius = radius - 18;
          ctx.fillStyle = i === 0 ? '#ef4444' : '#9ca3af';
          ctx.font = 'bold 14px monospace';
          ctx.fillText(
            directions[i as keyof typeof directions],
            centerX + Math.cos(rad) * textRadius,
            centerY + Math.sin(rad) * textRadius,
          );
        } else if (i % 30 === 0) {
          const textRadius = radius - 18;
          ctx.fillStyle = '#6b7280';
          ctx.font = '10px monospace';
          ctx.fillText(i.toString(), centerX + Math.cos(rad) * textRadius, centerY + Math.sin(rad) * textRadius);
        }
      }
    };

    const drawAircraftSymbol = () => {
      ctx.fillStyle = '#1d4ed8';
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY - 7);
      ctx.lineTo(centerX - 5, centerY + 5);
      ctx.lineTo(centerX + 5, centerY + 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };

    const drawGimbalOverlay = () => {
      const arrowLength = radius * 0.9;
      const yawRad = (gimbalYawRelative * Math.PI) / 180;
      const gimbalX = centerX + Math.sin(yawRad) * arrowLength;
      const gimbalY = centerY - Math.cos(yawRad) * arrowLength;

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(gimbalX, gimbalY);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(gimbalX, gimbalY, 6, 0, Math.PI * 2);
      ctx.fill();

      const fovRadius = radius * 0.9;
      const horizontalFov = telemetry?.camera_optics?.display_fov?.horizontal ?? (() => {
        const lensType = telemetry?.camera_optics?.lens_type;
        if (lensType === 'CAMERA_LENS_THERMAL') return 40;
        if (lensType === 'CAMERA_LENS_WIDE') return 84;
        const zoomRatio = telemetry?.camera_optics?.zoom_ratio ?? 1;
        return 84 / zoomRatio;
      })();

      const fovStart = ((gimbalYawRelative - horizontalFov / 2) * Math.PI) / 180;
      const fovEnd = ((gimbalYawRelative + horizontalFov / 2) * Math.PI) / 180;

      ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + Math.sin(fovStart) * fovRadius, centerY - Math.cos(fovStart) * fovRadius);
      ctx.arc(
        centerX,
        centerY,
        fovRadius,
        -Math.PI / 2 + fovStart,
        -Math.PI / 2 + fovEnd,
        false,
      );
      ctx.closePath();
      ctx.fill();

      
    };

    const drawVelocityVector = () => {
      if (!velocity) return;
      const { x = 0, y = 0 } = velocity;
      if (Math.abs(x) < 0.05 && Math.abs(y) < 0.05) return;

      const magnitude = Math.sqrt(x * x + y * y);
      const length = clamp(magnitude * 45, 0, radius * 0.55);
      const angle = Math.atan2(x, y);
      const vx = centerX + Math.sin(angle) * length;
      const vy = centerY + Math.cos(angle) * length;

      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(vx, vy);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#fb923c';
      ctx.beginPath();
      ctx.arc(vx, vy, 4, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawBearingMarker = (
      marker: HeadingTarget,
      color: string,
      accent: string,
      label: string,
    ) => {
      if (!marker) return;
      const labelRadius = radius + 30;
      const labelAngle = ((marker.bearing - compassHeading + 360) % 360 - 90) * Math.PI / 180;
      const labelX = centerX + Math.cos(labelAngle) * labelRadius;
      const labelY = centerY + Math.sin(labelAngle) * labelRadius;
      const relativeAngle = (marker.bearing - compassHeading + 360) % 360;
      const rad = ((relativeAngle - 90) * Math.PI) / 180;
      const markerRadius = radius * 0.92;
      const markerX = centerX + Math.cos(rad) * markerRadius;
      const markerY = centerY + Math.sin(rad) * markerRadius;
      const trailRadius = radius * 0.8;
      const trailX = centerX + Math.cos(rad) * trailRadius;
      const trailY = centerY + Math.sin(rad) * trailRadius;

      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      //ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(trailX, trailY);
      ctx.lineTo(markerX, markerY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(markerX, markerY);
      ctx.lineTo(labelX, labelY);
      ctx.stroke();
      ctx.beginPath();
      const arrowLength = 12;
      const arrowAngle = Math.atan2(labelY - markerY, labelX - markerX);
      ctx.moveTo(labelX, labelY);
      ctx.lineTo(labelX - Math.cos(arrowAngle - Math.PI / 6) * arrowLength, labelY - Math.sin(arrowAngle - Math.PI / 6) * arrowLength);
      ctx.lineTo(labelX - Math.cos(arrowAngle + Math.PI / 6) * arrowLength, labelY - Math.sin(arrowAngle + Math.PI / 6) * arrowLength);
      ctx.fillStyle = accent;
      ctx.fill();

      //ctx.fillStyle = accent;
      //ctx.font = '10px monospace';
      //ctx.textAlign = 'center';
      //ctx.textBaseline = 'middle';
      //ctx.fillText(label, labelX, labelY - 10);
      //ctx.fillText(`${marker.distance != null ? marker.distance.toFixed(1) : ''}`, labelX, labelY + 5);
    };

    const drawHomeDirection = () => {
      if (typeof telemetry?.home_bearing !== 'number') return;
      const relativeAngle = (telemetry.home_bearing - compassHeading + 360) % 360;
      const rad = ((relativeAngle - 90) * Math.PI) / 180;
      const arrowRadius = radius * 0.9;
      const markerX = centerX + Math.cos(rad) * arrowRadius;
      const markerY = centerY + Math.sin(rad) * arrowRadius;
      const labelRadius = radius + 22;
      const labelX = centerX + Math.cos(rad) * labelRadius;
      const labelY = centerY + Math.sin(rad) * labelRadius;

      ctx.strokeStyle = '#80f7d0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(markerX, markerY);
      ctx.lineTo(labelX, labelY);
      ctx.stroke();
      ctx.beginPath();
      const arrowLength = 12;
      const arrowAngle = Math.atan2(labelY - markerY, labelX - markerX);
      ctx.moveTo(labelX, labelY);
      ctx.lineTo(labelX - Math.cos(arrowAngle - Math.PI / 6) * arrowLength, labelY - Math.sin(arrowAngle - Math.PI / 6) * arrowLength);
      ctx.lineTo(labelX - Math.cos(arrowAngle + Math.PI / 6) * arrowLength, labelY - Math.sin(arrowAngle + Math.PI / 6) * arrowLength);
      ctx.fillStyle = '#bbf7d0';
      ctx.fill();

      //ctx.fillStyle = '#bbf7d0';
      //ctx.font = '10px monospace';
      //ctx.textAlign = 'center';
      //ctx.textBaseline = 'middle';
      //ctx.fillText('HOME', labelX, labelY - 8);
    };

    const drawObstacleDistances = (
      obstacleData: any,
    ) => {
      if (!obstacleData) return;
      const radarDistances = obstacleData.radar_distances;
      const perceptionDistances = obstacleData.perception_distances;

      if (Array.isArray(radarDistances) && radarDistances.length) {
        drawDistanceArray(radarDistances, 'radar');
      }

      if (useRawPerceptionData) {
        if (Array.isArray(perceptionDistances) && perceptionDistances.length) {
          drawDistanceArray(perceptionDistances, 'perception');
        }
      } else if (Array.isArray(obstacleData.sectors) && obstacleData.sectors.length) {
        drawObstacleSectors(obstacleData.sectors);
      } else if (Array.isArray(perceptionDistances) && perceptionDistances.length) {
        drawDistanceArray(perceptionDistances, 'perception');
      }
    };

    const getObstacleColor = (distance: number) => {
      if (distance >= 6) {
        return { color: 'rgb(255,0,0)', alpha: 1 };
      }
      if (distance < 1) {
        return { color: 'rgb(255,0,0)', alpha: 0.9 };
      }
      if (distance < 2) {
        const t = distance - 1;
        return { color: `rgb(255,${Math.round(165 * t)},0)`, alpha: 0.6 };
      }
      if (distance < 5) {
        const t = (distance - 2) / 3;
        return { color: `rgb(255,${Math.round(165 + (255 - 165) * t)},0)`, alpha: 0.5 };
      }
      const t = clamp((distance - 5) / 3, 0, 1);
      const r = Math.round(255 - 179 * t);
      const b = Math.round(0 + 175 * t);
      return { color: `rgb(${r},255,${b})`, alpha: 0.3 };
    };

    const drawDistanceArray = (distances: number[], source: 'radar' | 'perception') => {
      if (!distances.length) return;
      const degreesPerSector = 360 / distances.length;

      ctx.lineWidth = 1;

      distances.forEach((distanceMm, i) => {
        const meters = distanceMm / 1000;
        if (!(meters >= 6 || (meters > 0 && meters <= scaleRange))) {
          return;
        }
        const angle = i * degreesPerSector;
        const relative = (angle - compassHeading + 360) % 360;
        const startRad = ((relative - degreesPerSector / 2 - 90) * Math.PI) / 180;
        const endRad = ((relative + degreesPerSector / 2 - 90) * Math.PI) / 180;
        const useDistance = meters >= 6 ? 0.75 : meters;
        const sectorRadius = distanceToRadius(useDistance, scaleRange, radius);
        const { color, alpha } = getObstacleColor(meters);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, sectorRadius, startRad, endRad);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    };

    const drawObstacleSectors = (
      sectors: Array<{
        angle: number;
        distance: number;
        warning_level: 'none' | 'caution' | 'warning' | 'critical';
        source?: 'radar' | 'perception';
      }>,
    ) => {
      sectors.forEach((sector) => {
        if (sector.warning_level === 'none') return;
        const colors: Record<string, string> = {
          critical: '#ff375f',
          warning: '#f97316',
          caution: '#facc15',
        };
        const color = colors[sector.warning_level] || '#facc15';
        const relative = (sector.angle - compassHeading + 360) % 360;
        const spread = sector.source === 'radar' ? 10 : 6;
        const startRad = ((relative - spread / 2 - 90) * Math.PI) / 180;
        const endRad = ((relative + spread / 2 - 90) * Math.PI) / 180;
        const sectorRadius = distanceToRadius(sector.distance, scaleRange, radius);

        ctx.save();
        ctx.globalAlpha = sector.warning_level === 'critical' ? 0.9 : sector.warning_level === 'warning' ? 0.6 : 0.4;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, sectorRadius, startRad, endRad);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    };

    const drawObstacleSummary = (obstacleData: any) => {
      if (!obstacleData?.closest_distance) return;
      const distance = obstacleData.closest_distance;
      const text = distance < 1 ? `${(distance * 3.28).toFixed(0)}ft` : `${distance.toFixed(1)}m`;
      const textX = centerX + 0;
      const textY = centerY + radius * 0.7;

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(textX - 40, textY - 12, 80, 24);
      ctx.fillStyle = obstacleData.system_status === 'critical' ? '#ef4444'
        : obstacleData.system_status === 'warning' ? '#facc15'
        : '#22c55e';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, textX, textY);
      ctx.restore();
    };

    drawScaleLegend();
    drawObstacleDistances(telemetry?.obstacle_avoidance);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
    drawTickMarks();
    drawAircraftSymbol();
    drawGimbalOverlay();
    drawVelocityVector();
    drawBearingMarker(target, '#0ea5e9', '#38bdf8', 'TARGET');
    drawBearingMarker(mission, '#f97316', '#fb923c', 'MISSION');
    drawBearingMarker(poi, '#a855f7', '#d8b4fe', 'POI');
    drawHeadingReadout();
    drawHomeDirection();
    drawObstacleSummary(telemetry?.obstacle_avoidance);
  }, [dimensions, telemetry, target, mission, poi, scaleRange, useLogarithmicScale, useRawPerceptionData]);

  return (
    <div ref={containerRef} className={`relative w-full h-full ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
};
