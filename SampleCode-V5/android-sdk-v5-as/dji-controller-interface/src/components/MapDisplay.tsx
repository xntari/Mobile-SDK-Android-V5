import React from 'react';
import { MapDisplayProps } from '../types';

export const MapDisplay: React.FC<MapDisplayProps> = ({ 
  aircraftLocation, 
  homeLocation, 
  flightPath = [] 
}) => {
  const calculateDistance = (
    lat1: number, lon1: number, 
    lat2: number, lon2: number
  ): number => {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c * 1000; // Convert to meters
  };

  const calculateBearing = (
    lat1: number, lon1: number,
    lat2: number, lon2: number
  ): number => {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  };

  const getMapInfo = () => {
    if (!aircraftLocation || !homeLocation) {
      return {
        distance: 0,
        bearing: 0,
        valid: false
      };
    }

    const distance = calculateDistance(
      aircraftLocation.latitude, aircraftLocation.longitude,
      homeLocation.latitude, homeLocation.longitude
    );

    const bearing = calculateBearing(
      aircraftLocation.latitude, aircraftLocation.longitude,
      homeLocation.latitude, homeLocation.longitude
    );

    return { distance, bearing, valid: true };
  };

  const mapInfo = getMapInfo();

  // Calculate relative positions for display (simplified 2D projection)
  const getRelativePosition = (
    targetLat: number, targetLon: number,
    refLat: number, refLon: number,
    mapWidth: number, mapHeight: number
  ) => {
    if (!mapInfo.valid) return { x: 50, y: 50 }; // Center if no data

    // Simple approximation for small distances
    const deltaLat = (targetLat - refLat) * 111000; // meters per degree lat
    const deltaLon = (targetLon - refLon) * 111000 * Math.cos(refLat * Math.PI / 180);

    // Scale to fit in map (arbitrary scale factor)
    const scale = 0.01; // Adjust based on typical flight distances
    const x = 50 + (deltaLon * scale);
    const y = 50 - (deltaLat * scale); // Flip Y axis

    // Clamp to map bounds
    return {
      x: Math.max(5, Math.min(95, x)),
      y: Math.max(5, Math.min(95, y))
    };
  };

  const aircraftPos = aircraftLocation && homeLocation ? 
    getRelativePosition(
      aircraftLocation.latitude, aircraftLocation.longitude,
      homeLocation.latitude, homeLocation.longitude,
      160, 112
    ) : { x: 50, y: 50 };

  const homePos = { x: 50, y: 50 }; // Home is always at center

  return (
    <div className="glass-panel p-3">
      <div className="text-xs text-gray-400 mb-2 text-center">Mini Map</div>
      
      <div className="w-40 h-28 bg-gray-900 border border-gray-600 relative overflow-hidden rounded">
        {/* Map background grid */}
        <div className="absolute inset-0">
          {/* Vertical lines */}
          {[25, 50, 75].map(x => (
            <div
              key={`v-${x}`}
              className="absolute top-0 bottom-0 w-px bg-gray-700 opacity-30"
              style={{ left: `${x}%` }}
            />
          ))}
          {/* Horizontal lines */}
          {[25, 50, 75].map(y => (
            <div
              key={`h-${y}`}
              className="absolute left-0 right-0 h-px bg-gray-700 opacity-30"
              style={{ top: `${y}%` }}
            />
          ))}
        </div>

        {/* Flight path */}
        {flightPath.length > 1 && (
          <svg className="absolute inset-0 w-full h-full">
            <polyline
              points={flightPath.map(point => {
                if (!homeLocation) return '0,0';
                const pos = getRelativePosition(
                  point.latitude, point.longitude,
                  homeLocation.latitude, homeLocation.longitude,
                  160, 112
                );
                return `${pos.x * 1.6},${pos.y * 1.12}`;
              }).join(' ')}
              fill="none"
              stroke="#1E88E5"
              strokeWidth="1"
              opacity="0.7"
            />
          </svg>
        )}

        {/* Home position (center) */}
        <div 
          className="absolute w-3 h-3 transform -translate-x-1.5 -translate-y-1.5"
          style={{ 
            left: `${homePos.x}%`, 
            top: `${homePos.y}%` 
          }}
        >
          <div className="w-full h-full bg-status-good rounded-full border border-white animate-pulse-blue"></div>
          <div className="absolute -top-1 -left-1 w-5 h-5 border border-status-good rounded-full opacity-50"></div>
        </div>
        
        {/* Aircraft position */}
        <div 
          className="absolute w-3 h-3 transform -translate-x-1.5 -translate-y-1.5"
          style={{ 
            left: `${aircraftPos.x}%`, 
            top: `${aircraftPos.y}%` 
          }}
        >
          <div className="w-full h-full bg-dji-blue rounded-full border border-white"></div>
          {/* Direction indicator */}
          {aircraftLocation && (
            <div 
              className="absolute top-0 left-1/2 w-px h-2 bg-dji-blue transform -translate-x-1/2 -translate-y-2"
              style={{ 
                transform: `translateX(-50%) translateY(-8px) rotate(${mapInfo.bearing}deg)` 
              }}
            ></div>
          )}
        </div>

        {/* Connection line between aircraft and home */}
        {mapInfo.valid && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            <line
              x1={`${homePos.x}%`}
              y1={`${homePos.y}%`}
              x2={`${aircraftPos.x}%`}
              y2={`${aircraftPos.y}%`}
              stroke="#6B7280"
              strokeWidth="1"
              strokeDasharray="2,2"
              opacity="0.5"
            />
          </svg>
        )}
      </div>
      
      {/* Map info */}
      <div className="mt-2 flex justify-between text-xs">
        <div className="text-center">
          <div className="text-gray-400">DIST</div>
          <div className="font-mono text-white">
            {mapInfo.valid ? mapInfo.distance.toFixed(0) : '--'}m
          </div>
        </div>
        
        <div className="text-center">
          <div className="text-gray-400">BRG</div>
          <div className="font-mono text-white">
            {mapInfo.valid ? mapInfo.bearing.toFixed(0) : '--'}°
          </div>
        </div>
      </div>

      {/* GPS coordinates */}
      {aircraftLocation && (
        <div className="mt-2 text-xs text-gray-500">
          <div>{aircraftLocation.latitude.toFixed(6)}</div>
          <div>{aircraftLocation.longitude.toFixed(6)}</div>
        </div>
      )}
    </div>
  );
};