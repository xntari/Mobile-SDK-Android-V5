import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapDisplayProps, TelemetryData } from '../types';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { computeTargetMetrics } from '../utils/objectMemoryTarget';

export const MapDisplay: React.FC<MapDisplayProps> = ({
  flightPath = []
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const aircraftMarkerRef = useRef<maplibregl.Marker | null>(null);
  const homeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Direct telemetry data state - updated via electronAPI listener like camera components
  const [telemetryData, setTelemetryData] = useState<TelemetryData | null>(null);
  const [objectTarget, setObjectTarget] = useState<ObjectMemoryTargetSelection | null>(() => objectMemoryTargetStore.getCurrent());

  useEffect(() => {
    const unsubscribe = objectMemoryTargetStore.subscribe(setObjectTarget);
    return unsubscribe;
  }, []);

  const targetMetrics = React.useMemo(
    () => computeTargetMetrics(telemetryData, objectTarget?.anchor, objectTarget?.clusterLabel ?? objectTarget?.clusterId),
    [telemetryData, objectTarget]
  );

  // Map rotation toggle
  const [autoRotate, setAutoRotate] = useState(() => {
    try {
      const stored = localStorage.getItem('map.autoRotate');
      return stored ? JSON.parse(stored) : true;
    } catch {
      return true;
    }
  });

  // Calculate distance for display (bearing comes from telemetry)
  const calculateDistance = (
    lat1: number, lon1: number,
    lat2: number, lon2: number
  ): number => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c * 1000;
  };

  const getMapInfo = () => {
    const aircraftLocation = telemetryData?.location;
    const homeLocation = telemetryData?.home_location;

    if (!aircraftLocation || !homeLocation) {
      return { distance: 0, bearing: 0, valid: false };
    }

    const distance = calculateDistance(
      aircraftLocation.latitude, aircraftLocation.longitude,
      homeLocation.latitude, homeLocation.longitude
    );

    // Use bearing from telemetry data (calculated in bridgeManager)
    const bearing = telemetryData?.home_bearing || 0;

    return { distance, bearing, valid: true };
  };

  const mapInfo = getMapInfo();

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current) return;

    // Initialize MapLibre map with OpenStreetMap tiles
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: [
              'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors'
          }
        },
        layers: [
          {
            id: 'osm-tiles-layer',
            type: 'raster',
            source: 'osm-tiles'
          }
        ]
      },
      center: [0, 0],
      zoom: 16,
      attributionControl: false,
      logoPosition: 'bottom-right'
    });

    mapRef.current = map;

    map.on('load', () => {
      setMapReady(true);
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
      }
      aircraftMarkerRef.current = null;
      homeMarkerRef.current = null;
      targetMarkerRef.current = null;
    };
  }, []);

  // Direct electronAPI listener for telemetry data like camera components
  useEffect(() => {
    if (!window.electronAPI || !(window.electronAPI as any).onBridgeData) {
      console.warn('⚠️ electronAPI not available for Map telemetry updates');
      return;
    }

    const handleTelemetryData = (message: any) => {
      if (message.type === 'telemetry_data' && message.location) {
        // Convert yaw (-180 to +180) to compass heading (0 to 360)
        const convertYawToCompass = (yaw: number): number => {
          let compass = yaw;
          if (compass < 0) compass += 360;
          return compass;
        };

        // Calculate bearing from aircraft to home using great circle formula
        const calculateBearing = (from: any, to: any): number => {
          if (!from || !to) return 0;

          const lat1 = from.latitude * Math.PI / 180;
          const lat2 = to.latitude * Math.PI / 180;
          const deltaLng = (to.longitude - from.longitude) * Math.PI / 180;

          const y = Math.sin(deltaLng) * Math.cos(lat2);
          const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

          let bearing = Math.atan2(y, x) * 180 / Math.PI;
          return (bearing + 360) % 360;
        };

        const rawYaw = message.attitude?.yaw || message.compass_heading || message.heading || 0;
        const trueCompassHeading = convertYawToCompass(rawYaw);
        const bearingToHome = calculateBearing(message.location, message.home_location);

        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: trueCompassHeading,
          attitude: message.attitude || { pitch: 0, roll: 0, yaw: 0 },
          compass_heading: trueCompassHeading,
          home_bearing: bearingToHome,
        } as TelemetryData;

        setTelemetryData(mappedTelemetry);
      }
    };

    const listener = (message: any) => {
      handleTelemetryData(message);
    };

    (window.electronAPI as any).onBridgeData(listener);

    return () => {
      // Cleanup would go here if electronAPI supports removeListener
      if (window.electronAPI && (window.electronAPI as any).removeAllListeners) {
        try {
          (window.electronAPI as any).removeAllListeners('bridge-data-map');
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    };
  }, []);

  // Removed dual data source system - using props only

  // Update map center and markers when location changes
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;

    const map = mapRef.current;
    const aircraftLocation = telemetryData?.location;
    const homeLocation = telemetryData?.home_location;
    const compassHeading = telemetryData?.compass_heading || telemetryData?.heading || 0;

    // Center map on aircraft if available, otherwise on home
    const centerLocation = aircraftLocation || homeLocation;
    if (centerLocation) {
      map.setCenter([centerLocation.longitude, centerLocation.latitude]);
    }

    // Update aircraft marker position and rotation
    if (aircraftLocation) {
      if (aircraftMarkerRef.current) {
        // Update existing marker position and rotation
        aircraftMarkerRef.current.setLngLat([aircraftLocation.longitude, aircraftLocation.latitude]);

        const aircraftEl = aircraftMarkerRef.current.getElement();
        if (aircraftEl) {
          // Arrow rotation depends on mode
          aircraftEl.style.transform = `rotate(0deg)`;  // Never rotate container
          const arrowRotation = autoRotate ? 0 : compassHeading;  // Auto-rotate: point up, Fixed north: show heading
          aircraftEl.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 16 16" style="fill: #ef4444; transform: rotate(${arrowRotation}deg);">
              <path d="M8 2 L12 10 L8 8 L4 10 Z"/>
            </svg>
          `;
        }
      } else {
        // Create new aircraft marker
        const aircraftEl = document.createElement('div');
        aircraftEl.style.width = '20px';
        aircraftEl.style.height = '20px';
        aircraftEl.style.fontSize = '16px';
        aircraftEl.style.color = '#ef4444';
        aircraftEl.style.textShadow = '0 0 3px rgba(0,0,0,0.8)';
        aircraftEl.style.display = 'flex';
        aircraftEl.style.alignItems = 'center';
        aircraftEl.style.justifyContent = 'center';

        // Arrow rotation depends on mode
        aircraftEl.style.transform = `rotate(0deg)`;  // Never rotate container
        const arrowRotation = autoRotate ? 0 : compassHeading;  // Auto-rotate: point up, Fixed north: show heading
        aircraftEl.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 16 16" style="fill: #ef4444; transform: rotate(${arrowRotation}deg);">
            <path d="M8 2 L12 10 L8 8 L4 10 Z"/>
          </svg>
        `;

        aircraftMarkerRef.current = new maplibregl.Marker({ element: aircraftEl })
          .setLngLat([aircraftLocation.longitude, aircraftLocation.latitude])
          .addTo(map);
      }
    }

    // Update home marker
    if (homeLocation) {
      if (!homeMarkerRef.current) {
        const homeEl = document.createElement('div');
        homeEl.style.width = '8px';
        homeEl.style.height = '8px';
        homeEl.style.borderRadius = '50%';
        homeEl.style.backgroundColor = '#4ade80';
        homeEl.style.border = '2px solid white';

        homeMarkerRef.current = new maplibregl.Marker({ element: homeEl })
          .setLngLat([homeLocation.longitude, homeLocation.latitude])
          .addTo(map);
      } else {
        homeMarkerRef.current.setLngLat([homeLocation.longitude, homeLocation.latitude]);
      }
    }

    const targetPosition = targetMetrics?.targetPosition;
    if (targetPosition && Number.isFinite(targetPosition.latitude) && Number.isFinite(targetPosition.longitude)) {
      if (!targetMarkerRef.current) {
        const targetEl = document.createElement('div');
        targetEl.style.width = '8px';
        targetEl.style.height = '8px';
        targetEl.style.borderRadius = '50%';
        targetEl.style.backgroundColor = '#0ea5e9';
        targetEl.style.border = '2px solid white';
        targetEl.style.boxShadow = '0 0 6px rgba(14, 165, 233, 0.7)';

        targetMarkerRef.current = new maplibregl.Marker({ element: targetEl })
          .setLngLat([targetPosition.longitude, targetPosition.latitude])
          .addTo(map);
      } else {
        targetMarkerRef.current.setLngLat([targetPosition.longitude, targetPosition.latitude]);
      }
    } else if (targetMarkerRef.current) {
      targetMarkerRef.current.remove();
      targetMarkerRef.current = null;
    }
  }, [mapReady, telemetryData, autoRotate, targetMetrics]);

  // Persist autoRotate setting
  useEffect(() => {
    try {
      localStorage.setItem('map.autoRotate', JSON.stringify(autoRotate));
    } catch {}
  }, [autoRotate]);

  // Auto-rotate map based on compass heading (if enabled)
  useEffect(() => {
    if (!mapReady || !mapRef.current || !telemetryData?.location) return;

    const map = mapRef.current;
    const compassHeading = telemetryData?.compass_heading || telemetryData?.heading || 0;

    if (autoRotate) {
      // Use exact same logic as HSI compass: rotate by -heading
      map.rotateTo(compassHeading, { duration: 500 });
    } else {
      // Fixed north orientation
      map.rotateTo(0, { duration: 500 });
    }
  }, [mapReady, telemetryData, autoRotate]);

  // Add flight path
  useEffect(() => {
    if (!mapReady || !mapRef.current || flightPath.length < 2) return;

    const map = mapRef.current;

    // Remove existing flight path
    if (map.getSource('flight-path')) {
      map.removeLayer('flight-path-layer');
      map.removeSource('flight-path');
    }

    // Add flight path as GeoJSON
    map.addSource('flight-path', {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: flightPath.map(point => [point.longitude, point.latitude])
        }
      }
    });

    map.addLayer({
      id: 'flight-path-layer',
      type: 'line',
      source: 'flight-path',
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#1E88E5',
        'line-width': 2,
        'line-opacity': 0.7
      }
    });
  }, [mapReady, flightPath]);

  return (
    <div className="w-full h-full flex flex-col">
      {/* MapLibre container */}
      <div className="flex-1 rounded border border-gray-600 overflow-hidden relative">
        <div
          ref={mapContainer}
          className="w-full h-full"
          style={{ minHeight: '120px' }}
        />
        


        {/* Connection status indicator */}
        {!mapReady && (
          <div className="absolute inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center">
            <div className="text-xs text-gray-400">Loading Map...</div>
          </div>
        )}
      </div>
      
      {/* Map info */}
      <div className="mt-2 flex flex-wrap justify-around gap-4 text-xs">
        <div className="text-center">
          <div className="text-gray-400">DIST HOME</div>
          <div className="font-mono text-white">
            {mapInfo.valid ? mapInfo.distance.toFixed(0) : '--'}m
          </div>
        </div>

        <div className="text-center">
          <div className="text-gray-400">BRG HOME</div>
          <div className="font-mono text-white">
            {mapInfo.valid ? mapInfo.bearing.toFixed(0) : '--'}°
          </div>
        </div>

        <div className="text-center">
          <div className="text-gray-400">AC HDG</div>
          <div className="font-mono text-white">
            {(telemetryData?.compass_heading || telemetryData?.heading || 0).toFixed(0)}°
          </div>
        </div>

        {targetMetrics && (
          <>
            <div className="text-center">
              <div className="text-purple-200">OBJ DIST</div>
              <div className="font-mono text-purple-300">
                {targetMetrics.slantDistance.toFixed(0)}m
              </div>
            </div>
            <div className="text-center">
              <div className="text-purple-200">OBJ BRG</div>
              <div className="font-mono text-purple-300">
                {targetMetrics.bearing.toFixed(0)}°
              </div>
            </div>
          </>
        )}
      </div>

      {targetMetrics && (
        <div className="mt-1 text-[11px] text-center text-purple-200">
          {(objectTarget?.clusterLabel ?? objectTarget?.clusterId) ?? 'Target'}
          {targetMetrics.altitudeDelta != null ? ` · Δalt ${targetMetrics.altitudeDelta.toFixed(1)} m` : ''}
        </div>
      )}

      {/* Map rotation toggle */}
      <div className="mt-2 flex justify-center">
        <button
          onClick={() => setAutoRotate(!autoRotate)}
          className={`px-3 py-1 text-xs rounded border transition-colors ${
            autoRotate
              ? 'bg-dji-blue text-white border-dji-blue'
              : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
          }`}
        >
          {autoRotate ? 'Auto-rotate' : 'North up'}
        </button>
      </div>

      {/* GPS coordinates */}
      <div className="mt-2 flex justify-between text-xs font-mono leading-tight">
        {/* Aircraft coordinates */}
        {telemetryData?.location && (
          <div className="text-gray-500">
            <div className="text-gray-400 text-[10px] mb-1">AIRCRAFT</div>
            <div>{telemetryData.location.latitude.toFixed(6)}</div>
            <div>{telemetryData.location.longitude.toFixed(6)}</div>
            <div className="text-yellow-400">
              {((telemetryData.takeoff_altitude || 0) + (telemetryData.altitude || 0)).toFixed(1)} m AMSL
            </div>
          </div>
        )}

        {/* Home coordinates */}
        {telemetryData?.home_location && (
          <div className="text-gray-500">
            <div className="text-gray-400 text-[10px] mb-1">HOME</div>
            <div>{telemetryData.home_location.latitude.toFixed(6)}</div>
            <div>{telemetryData.home_location.longitude.toFixed(6)}</div>
            <div className="text-yellow-400">
              {(telemetryData.takeoff_altitude || telemetryData.home_location.altitude || 0).toFixed(1)} m AMSL
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
