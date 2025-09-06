import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapDisplayProps } from '../types';

export const MapDisplay: React.FC<MapDisplayProps> = ({ 
  aircraftLocation, 
  homeLocation, 
  flightPath = [],
  compassHeading = 0
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const aircraftMarkerRef = useRef<maplibregl.Marker | null>(null);
  const homeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Calculate distance and bearing for display
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
      return { distance: 0, bearing: 0, valid: false };
    }

    const distance = calculateDistance(
      aircraftLocation.latitude, aircraftLocation.longitude,
      homeLocation.latitude, homeLocation.longitude
    );

    const bearing = calculateBearing(
      homeLocation.latitude, homeLocation.longitude,
      aircraftLocation.latitude, aircraftLocation.longitude
    );

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
    };
  }, []);

  // Update map center and markers when location changes
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const map = mapRef.current;

    // Center map on aircraft if available, otherwise on home
    const centerLocation = aircraftLocation || homeLocation;
    if (centerLocation) {
      map.setCenter([centerLocation.longitude, centerLocation.latitude]);
    }

    // Remove existing markers
    if (homeMarkerRef.current) {
      homeMarkerRef.current.remove();
      homeMarkerRef.current = null;
    }
    if (aircraftMarkerRef.current) {
      aircraftMarkerRef.current.remove();
      aircraftMarkerRef.current = null;
    }

    // Add home marker
    if (homeLocation) {
      const homeEl = document.createElement('div');
      homeEl.style.width = '8px';
      homeEl.style.height = '8px';
      homeEl.style.borderRadius = '50%';
      homeEl.style.backgroundColor = '#4ade80';
      homeEl.style.border = '2px solid white';

      homeMarkerRef.current = new maplibregl.Marker({ element: homeEl })
        .setLngLat([homeLocation.longitude, homeLocation.latitude])
        .addTo(map);
    }

    // Add aircraft marker
    if (aircraftLocation) {
      const aircraftEl = document.createElement('div');
      aircraftEl.style.width = '20px';
      aircraftEl.style.height = '20px';
      aircraftEl.style.fontSize = '16px';
      aircraftEl.style.color = '#ef4444';  // Red color
      aircraftEl.style.textShadow = '0 0 3px rgba(0,0,0,0.8)';
      aircraftEl.style.display = 'flex';
      aircraftEl.style.alignItems = 'center';
      aircraftEl.style.justifyContent = 'center';
      aircraftEl.innerHTML = '▲';

      aircraftMarkerRef.current = new maplibregl.Marker({ element: aircraftEl })
        .setLngLat([aircraftLocation.longitude, aircraftLocation.latitude])
        .addTo(map);
    }
  }, [mapReady, aircraftLocation, homeLocation]);

  // Auto-rotate map based on compass heading
  useEffect(() => {
    if (!mapReady || !mapRef.current || !aircraftLocation) return;

    const map = mapRef.current;
    
    // Rotate map counter to compass heading so aircraft always points "up"
    // No offset needed - MapLibre 0° points north, compass heading 0° is north
    map.rotateTo(-compassHeading, { duration: 500 });
  }, [mapReady, compassHeading, aircraftLocation]);

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
    <div className="glass-panel p-3 w-52">
      <div className="text-xs text-gray-400 mb-2 text-center">Live Map</div>
      
      {/* MapLibre container */}
      <div className="w-44 h-32 rounded border border-gray-600 overflow-hidden relative mx-auto">
        <div 
          ref={mapContainer} 
          className="w-full h-full"
          style={{ minHeight: '128px' }}
        />
        

        {/* Connection status indicator */}
        {!mapReady && (
          <div className="absolute inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center">
            <div className="text-xs text-gray-400">Loading Map...</div>
          </div>
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

        <div className="text-center">
          <div className="text-gray-400">HDG</div>
          <div className="font-mono text-white">
            {compassHeading?.toFixed(0) || '--'}°
          </div>
        </div>
      </div>

      {/* GPS coordinates */}
      {aircraftLocation && (
        <div className="mt-2 text-xs text-gray-500 font-mono leading-tight">
          <div>{aircraftLocation.latitude.toFixed(6)}</div>
          <div>{aircraftLocation.longitude.toFixed(6)}</div>
        </div>
      )}
    </div>
  );
};