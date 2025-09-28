import React from 'react';
import { TelemetryData } from '../types';

interface OrientationCompassProps {
  telemetry: TelemetryData | null;
  size?: number;
  className?: string;
  target?: {
    bearing: number;
    distance: number;
    altitudeDelta: number | null;
  };
  mission?: {
    bearing: number;
    distance?: number;
    altitudeDelta?: number | null;
  };
  homeBearing?: number;
}

export const OrientationCompass: React.FC<OrientationCompassProps> = ({
  telemetry,
  size = 240,
  className = '',
  target,
  mission,
  homeBearing,
}) => {
  const centerX = size / 2;
  const centerY = size / 2;
  const radius = size / 2 - 20;

  // Get angles
  const aircraftYaw = telemetry?.attitude?.yaw || 0;
  const compassHeading = telemetry?.compass_heading || aircraftYaw;

  // Get gimbal angles (relative to aircraft)
  const gimbal = telemetry?.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
  const gimbalYawRelative = gimbal?.yaw_relative || 0;
  const gimbalPitch = gimbal?.attitude?.pitch || 0;

  // Calculate gimbal absolute heading
  const gimbalHeading = (compassHeading + gimbalYawRelative + 360) % 360;

  // Helper to draw text at angle
  const getTextPosition = (angle: number, distance: number) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    return {
      x: centerX + Math.cos(rad) * distance,
      y: centerY + Math.sin(rad) * distance
    };
  };

  // Generate tick marks
  const ticks = [];
  for (let i = 0; i < 360; i += 10) {
    const startRadius = i % 30 === 0 ? radius - 10 : radius - 5;
    const endRadius = radius;
    const angle = (i - compassHeading + 360) % 360;
    const rad = ((angle - 90) * Math.PI) / 180;

    ticks.push(
      <line
        key={`tick-${i}`}
        x1={centerX + Math.cos(rad) * startRadius}
        y1={centerY + Math.sin(rad) * startRadius}
        x2={centerX + Math.cos(rad) * endRadius}
        y2={centerY + Math.sin(rad) * endRadius}
        stroke="#4a5568"
        strokeWidth={i % 30 === 0 ? 2 : 1}
      />
    );

    // Add cardinal direction labels
    if (i % 90 === 0) {
      const directions = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      const pos = getTextPosition(angle, radius - 20);
      ticks.push(
        <text
          key={`dir-${i}`}
          x={pos.x}
          y={pos.y}
          fill={i === 0 ? '#ef4444' : '#9ca3af'}
          fontSize="14"
          fontWeight="bold"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {directions[i as keyof typeof directions]}
        </text>
      );
    } else if (i % 30 === 0) {
      const pos = getTextPosition(angle, radius - 20);
      ticks.push(
        <text
          key={`deg-${i}`}
          x={pos.x}
          y={pos.y}
          fill="#6b7280"
          fontSize="10"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {i}
        </text>
      );
    }
  }

  // Aircraft triangle (always points up)
  const aircraftPath = `M ${centerX} ${centerY - 15} L ${centerX - 10} ${centerY + 10} L ${centerX + 10} ${centerY + 10} Z`;

  // Gimbal direction arrow (relative to compass)
  const gimbalAngle = (gimbalYawRelative) * Math.PI / 180;
  const gimbalArrowLength = radius * 0.7;
  const gimbalX = centerX + Math.sin(gimbalAngle) * gimbalArrowLength;
  const gimbalY = centerY - Math.cos(gimbalAngle) * gimbalArrowLength;

  // Gimbal FOV cone - account for camera mode
  const cameraMode = telemetry?.camera_optics?.lens_type || 'CAMERA_LENS_ZOOM';
  let fovAngle = 30; // default

  if (telemetry?.camera_optics?.display_fov?.horizontal) {
    fovAngle = telemetry.camera_optics.display_fov.horizontal;
  } else if (cameraMode === 'CAMERA_LENS_THERMAL') {
    fovAngle = 40; // Thermal typically has wider FOV
  } else if (cameraMode === 'CAMERA_LENS_WIDE') {
    fovAngle = 84; // Wide angle
  } else {
    // Zoom lens - depends on zoom ratio
    const zoomRatio = telemetry?.camera_optics?.zoom_ratio || 1;
    fovAngle = 84 / zoomRatio; // Approximate
  }

  // FOV arc
  const fovRadius = gimbalArrowLength * 0.8;
  const fovStart = gimbalYawRelative - fovAngle / 2;
  const fovEnd = gimbalYawRelative + fovAngle / 2;

  const fovStartRad = (fovStart * Math.PI) / 180;
  const fovEndRad = (fovEnd * Math.PI) / 180;

  const fovPath = `
    M ${centerX} ${centerY}
    L ${centerX + Math.sin(fovStartRad) * fovRadius} ${centerY - Math.cos(fovStartRad) * fovRadius}
    A ${fovRadius} ${fovRadius} 0 0 1 ${centerX + Math.sin(fovEndRad) * fovRadius} ${centerY - Math.cos(fovEndRad) * fovRadius}
    Z
  `;

  // Velocity vector (in body frame: x=right, y=forward, z=up)
  const velocity = telemetry?.velocity_vector;
  let velocityArrow = null;
  if (velocity && (Math.abs(velocity.x) > 0.05 || Math.abs(velocity.y) > 0.05)) {
    // Velocity is in body frame, but compass rotates, so we need to counter-rotate
    const velocityMagnitude = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
    const velocityLength = Math.min(radius * 0.6, velocityMagnitude * 50);

    // Calculate angle in body frame (x=right, y=forward)
    const bodyAngle = Math.atan2(velocity.x, velocity.y); // Note: x,y swapped for correct angle

    // Since compass rotates by -compassHeading, we need to add compassHeading back
    const displayAngle = bodyAngle - (-(compassHeading + 90.0) * Math.PI / 180);

    // Calculate display position
    const vx = centerX + Math.sin(displayAngle) * velocityLength;
    const vy = centerY + Math.cos(displayAngle) * velocityLength;

    velocityArrow = (
      <g>
        <line
          x1={centerX}
          y1={centerY}
          x2={vx}
          y2={vy}
          stroke="#fbbf24"
          strokeWidth="2"
          strokeDasharray="5,3"
        />
        <circle cx={vx} cy={vy} r="4" fill="#fbbf24" />
      </g>
    );
  }

  const targetElements = React.useMemo(() => {
    if (!target) return null;
    const relativeAngle = (target.bearing - compassHeading + 360) % 360;
    const rad = ((relativeAngle - 90) * Math.PI) / 180;
    const markerRadius = radius * 0.9;
    const markerX = centerX + Math.cos(rad) * markerRadius;
    const markerY = centerY + Math.sin(rad) * markerRadius;
    const trailRadius = radius * 0.6;
    const trailX = centerX + Math.cos(rad) * trailRadius;
    const trailY = centerY + Math.sin(rad) * trailRadius;

    return (
      <g>
        <line
          x1={trailX}
          y1={trailY}
          x2={markerX}
          y2={markerY}
          stroke="#38bdf8"
          strokeWidth={2}
          strokeDasharray="4,2"
        />
        <circle cx={markerX} cy={markerY} r={6} fill="#0ea5e9" stroke="#38bdf8" strokeWidth={2} />
        <text
          x={markerX}
          y={markerY - 10}
          fill="#bae6fd"
          fontSize="10"
          fontWeight="bold"
          textAnchor="middle"
        >
          {Math.round(target.distance)}m
        </text>
      </g>
    );
  }, [target, compassHeading, centerX, centerY, radius]);

  const missionElements = React.useMemo(() => {
    if (!mission) return null;
    const relativeAngle = (mission.bearing - compassHeading + 360) % 360;
    const rad = ((relativeAngle - 90) * Math.PI) / 180;
    const markerRadius = radius * 0.85;
    const markerX = centerX + Math.cos(rad) * markerRadius;
    const markerY = centerY + Math.sin(rad) * markerRadius;
    const trailRadius = radius * 0.6;
    const trailX = centerX + Math.cos(rad) * trailRadius;
    const trailY = centerY + Math.sin(rad) * trailRadius;

    return (
      <g>
        <line
          x1={trailX}
          y1={trailY}
          x2={markerX}
          y2={markerY}
          stroke="#fb923c"
          strokeWidth={2}
          strokeDasharray="3,2"
        />
        <circle cx={markerX} cy={markerY} r={6} fill="#f97316" stroke="#ea580c" strokeWidth={2} />
        {mission.distance !== undefined && (
          <text
            x={markerX}
            y={markerY - 12}
            fill="#ea580c"
            fontSize="10"
            fontWeight="600"
            textAnchor="middle"
          >
            {mission.distance.toFixed(0)} m
          </text>
        )}
      </g>
    );
  }, [mission, compassHeading, centerX, centerY, radius]);

  const homeElements = React.useMemo(() => {
    if (typeof homeBearing !== 'number' || Number.isNaN(homeBearing)) return null;
    const relativeAngle = (homeBearing - compassHeading + 360) % 360;
    const rad = ((relativeAngle - 90) * Math.PI) / 180;
    const arrowRadius = radius * 0.5;
    const arrowX = centerX + Math.cos(rad) * arrowRadius;
    const arrowY = centerY + Math.sin(rad) * arrowRadius;
    const arrowSize = 30;

    const leftRad = ((relativeAngle - 90 - 10) * Math.PI) / 180;
    const rightRad = ((relativeAngle - 90 + 10) * Math.PI) / 180;

    const tipX = centerX + Math.cos(rad) * (arrowRadius + arrowSize * 0.6);
    const tipY = centerY + Math.sin(rad) * (arrowRadius + arrowSize * 0.6);
    const leftX = centerX + Math.cos(leftRad) * arrowRadius;
    const leftY = centerY + Math.sin(leftRad) * arrowRadius;
    const rightX = centerX + Math.cos(rightRad) * arrowRadius;
    const rightY = centerY + Math.sin(rightRad) * arrowRadius;

    return (
      <g>
        <polygon
          points={`${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`}
          fill="#22c55e"
          stroke="#0f766e"
          strokeWidth={2}
        />
      </g>
    );
  }, [homeBearing, compassHeading, centerX, centerY, radius]);

  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${size} ${size}`}
    >
      {/* Background */}
      <circle
        cx={centerX}
        cy={centerY}
        r={radius + 10}
        fill="#0a0a0a"
        stroke="#1f2937"
        strokeWidth="1"
      />

      {/* Compass ring */}
      <circle
        cx={centerX}
        cy={centerY}
        r={radius}
        fill="none"
        stroke="#374151"
        strokeWidth="2"
      />

      {/* Tick marks and labels */}
      {ticks}

      {/* FOV cone */}
      <path
        d={fovPath}
        fill="#10b981"
        fillOpacity="0.1"
        stroke="#10b981"
        strokeWidth="1"
        strokeOpacity="0.3"
      />

      {/* Velocity vector */}
      {velocityArrow}

      {/* Home / mission / target indicators */}
      {homeElements}
      {missionElements}
      {targetElements}

      {/* Gimbal direction arrow */}
      <g>
        <line
          x1={centerX}
          y1={centerY}
          x2={gimbalX}
          y2={gimbalY}
          stroke="#10b981"
          strokeWidth="3"
        />
        <polygon
          points={`${gimbalX},${gimbalY - 8} ${gimbalX - 6},${gimbalY + 4} ${gimbalX + 6},${gimbalY + 4}`}
          fill="#10b981"
          transform={`rotate(${gimbalYawRelative} ${gimbalX} ${gimbalY})`}
        />
      </g>

      {/* Aircraft symbol (fixed, points up) */}
      <path
        d={aircraftPath}
        fill="#3b82f6"
        stroke="#60a5fa"
        strokeWidth="1"
      />

      {/* Center dot */}
      <circle cx={centerX} cy={centerY} r="3" fill="#f3f4f6" />

      {/* Current heading display */}
      <rect
        x={centerX - 30}
        y={10}
        width="60"
        height="20"
        fill="#111827"
        stroke="#374151"
        strokeWidth="1"
        rx="2"
      />
      <text
        x={centerX}
        y={24}
        fill="#f3f4f6"
        fontSize="12"
        fontWeight="bold"
        textAnchor="middle"
      >
        {Math.round(compassHeading)}°
      </text>

      {/* Gimbal pitch indicator */}
      <text
        x={size - 10}
        y={centerY}
        fill="#10b981"
        fontSize="10"
        textAnchor="end"
        dominantBaseline="middle"
      >
        P: {gimbalPitch.toFixed(0)}°
      </text>
    </svg>
  );
};
