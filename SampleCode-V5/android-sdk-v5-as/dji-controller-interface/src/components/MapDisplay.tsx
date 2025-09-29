import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapDisplayProps, TelemetryData } from '../types';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { computeTargetMetrics } from '../utils/objectMemoryTarget';
import { missionPlannerStore } from '../state/missionPlanner';
import type {
  PlannedMissionEntry,
  ManualTargetState,
  MissionWaypointTarget,
} from '../types/missionPlanner';

const clampLat = (value: number) => Math.max(-90, Math.min(90, value));
const clampLon = (value: number) => Math.max(-180, Math.min(180, value));
const MISSION_PLAN_SOURCE_ID = 'mission-plan';
const MISSION_PLAN_LAYER_ID = 'mission-plan-layer';

const ORBIT_COLORS = {
  text: '#7c2d12',
  background: '#fed7aa',
  border: '#ea580c',
  shadow: '0 0 4px rgba(234, 88, 12, 0.4)',
};

const WAYPOINT_COLORS = {
  text: '#1e3a8a',
  background: '#bfdbfe',
  border: '#1d4ed8',
  shadow: '0 0 4px rgba(29, 78, 216, 0.35)',
};

const RETURN_HOME_COLORS = {
  text: '#065f46',
  background: '#bbf7d0',
  border: '#047857',
  shadow: '0 0 4px rgba(4, 120, 87, 0.4)',
};

const LAND_COLORS = {
  text: '#7f1d1d',
  background: '#fecaca',
  border: '#b91c1c',
  shadow: '0 0 4px rgba(185, 28, 28, 0.35)',
};

const createPlanMarkerElement = (label: string, kind?: string, highlight = false) => {
  const element = document.createElement('div');
  element.className = 'map-plan-marker';
  element.style.width = '16px';
  element.style.height = '16px';
  element.style.borderRadius = '50%';
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.fontSize = '10px';
  element.style.fontWeight = '600';

  const palette = kind === 'orbit'
    ? ORBIT_COLORS
    : kind === 'return_home'
      ? RETURN_HOME_COLORS
      : kind === 'land'
        ? LAND_COLORS
        : WAYPOINT_COLORS;
  element.style.color = palette.text;
  element.style.backgroundColor = palette.background;
  element.style.border = highlight ? '2px solid #f97316' : `1.5px solid ${palette.border}`;
  element.style.boxShadow = highlight ? '0 0 6px rgba(249, 115, 22, 0.6)' : palette.shadow;
  element.textContent = label;
  return element;
};

export const MapDisplay: React.FC<MapDisplayProps> = ({
  flightPath = []
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const aircraftMarkerRef = useRef<maplibregl.Marker | null>(null);
  const homeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const targetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const manualTargetMarkerRef = useRef<maplibregl.Marker | null>(null);
  const activeWaypointMarkerRef = useRef<maplibregl.Marker | null>(null);
  const planMarkerRefs = useRef<Map<string, maplibregl.Marker>>(new Map());
  const initialCenterAppliedRef = useRef(false);
  const manualTargetPanRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const planIdsRef = useRef<Set<string>>(new Set());
  const [mapReady, setMapReady] = useState(false);

  // Direct telemetry data state - updated via electronAPI listener like camera components
  const [telemetryData, setTelemetryData] = useState<TelemetryData | null>(null);
  const [objectTarget, setObjectTarget] = useState<ObjectMemoryTargetSelection | null>(() => objectMemoryTargetStore.getCurrent());
  const [missionPlan, setMissionPlan] = useState<PlannedMissionEntry[]>(() => missionPlannerStore.getSnapshot().plan);
  const [manualTarget, setManualTarget] = useState<ManualTargetState | null>(() => missionPlannerStore.getSnapshot().manualTarget);
  const [activeWaypoint, setActiveWaypoint] = useState<MissionWaypointTarget | null>(() => missionPlannerStore.getSnapshot().activeWaypoint ?? null);

  const [autoCenter, setAutoCenter] = useState(() => {
    try {
      const stored = localStorage.getItem('map.autoCenter');
      return stored ? JSON.parse(stored) : true;
    } catch {
      return true;
    }
  });

  const autoCenterEnabled = React.useMemo(() => {
    const missionState = telemetryData?.waypoint_status?.state?.toLowerCase();
    const missionActive = missionState ? !['ready', 'idle', 'unknown', 'not_ready', 'paused'].includes(missionState) : false;
    return autoCenter && Boolean(telemetryData?.motors_on || missionActive);
  }, [telemetryData?.motors_on, telemetryData?.waypoint_status?.state, autoCenter]);

  useEffect(() => {
    const unsubscribe = objectMemoryTargetStore.subscribe(setObjectTarget);
    return unsubscribe;
  }, []);

  useEffect(() => missionPlannerStore.subscribePlan(setMissionPlan), []);
  useEffect(() => missionPlannerStore.subscribeManualTarget(setManualTarget), []);
  useEffect(() => missionPlannerStore.subscribeActiveWaypoint(setActiveWaypoint), []);

  const targetMetrics = React.useMemo(
    () => computeTargetMetrics(telemetryData, objectTarget?.anchor, objectTarget?.clusterLabel ?? objectTarget?.clusterId),
    [telemetryData, objectTarget]
  );

  const telemetryPlan = React.useMemo<PlannedMissionEntry[]>(() => {
    const waypoints = telemetryData?.waypoint_status?.waypoints;
    if (!Array.isArray(waypoints)) {
      return [];
    }
    return waypoints
      .map((wp: any, index: number): PlannedMissionEntry | null => {
        const lat = typeof wp?.latitude === 'number' ? wp.latitude : undefined;
        const lon = typeof wp?.longitude === 'number' ? wp.longitude : undefined;
        if (lat == null || lon == null) {
          return null;
        }
        const id = `telemetry-${typeof wp.index === 'number' ? wp.index : index}`;
        const kind = typeof wp.kind === 'string' && wp.kind === 'orbit' ? 'orbit' : 'waypoint';
        const altitude = typeof wp.execute_height === 'number' ? wp.execute_height : null;
        return {
          id,
          kind,
          latitude: lat,
          longitude: lon,
          altitude,
          radius: typeof wp.radius === 'number' ? wp.radius : undefined,
          turns: typeof wp.turns === 'number' ? wp.turns : undefined,
        };
      })
      .filter((entry): entry is PlannedMissionEntry => Boolean(entry));
  }, [telemetryData?.waypoint_status?.waypoints]);

  const displayedPlan = missionPlan.length ? missionPlan : telemetryPlan;

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

  const handleRecenter = React.useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const target = telemetryData?.location ?? telemetryData?.home_location;
    if (!target || !Number.isFinite(target.latitude) || !Number.isFinite(target.longitude)) {
      return;
    }
    map.easeTo({ center: [target.longitude, target.latitude], duration: 600, essential: true });
  }, [telemetryData?.location?.latitude, telemetryData?.location?.longitude, telemetryData?.home_location?.latitude, telemetryData?.home_location?.longitude]);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if (!event?.lngLat) return;
      const pointerEvent = event.originalEvent as MouseEvent | undefined;
      const clampedLat = clampLat(event.lngLat.lat);
      const clampedLon = clampLon(event.lngLat.lng);

      if (pointerEvent?.altKey || pointerEvent?.metaKey) {
        missionPlannerStore.requestAddWaypoint({
          latitude: clampedLat,
          longitude: clampedLon,
          kind: 'orbit',
          source: 'map',
        });
        return;
      }

      if (pointerEvent?.shiftKey) {
        missionPlannerStore.requestAddWaypoint({
          latitude: clampedLat,
          longitude: clampedLon,
          kind: 'waypoint',
          source: 'map',
        });
        return;
      }

      if (pointerEvent?.ctrlKey) {
        missionPlannerStore.requestStageTarget({
          latitude: clampedLat,
          longitude: clampedLon,
          source: 'map',
        });
      }
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
    };
  }, [mapReady]);

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
      const targetCenter: [number, number] = [centerLocation.longitude, centerLocation.latitude];
      if (!initialCenterAppliedRef.current) {
        map.setCenter(targetCenter);
        initialCenterAppliedRef.current = true;
      } else if (autoCenterEnabled) {
        map.easeTo({ center: targetCenter, duration: 750, essential: true });
      }
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
            <svg width="24" height="24" viewBox="0 0 16 16" style="fill: #ef4444; transform: rotate(${arrowRotation}deg);">
              <path d="M8 2 L12 10 L8 8 L4 10 Z"/>
            </svg>
          `;
        }
      } else {
        // Create new aircraft marker
        const aircraftEl = document.createElement('div');
        aircraftEl.style.width = '30px';
        aircraftEl.style.height = '30px';
        aircraftEl.style.fontSize = '24px';
        aircraftEl.style.color = '#ef4444';
        aircraftEl.style.textShadow = '0 0 3px rgba(0,0,0,0.8)';
        aircraftEl.style.display = 'flex';
        aircraftEl.style.alignItems = 'center';
        aircraftEl.style.justifyContent = 'center';

        // Arrow rotation depends on mode
        aircraftEl.style.transform = `rotate(0deg)`;  // Never rotate container
        const arrowRotation = autoRotate ? 0 : compassHeading;  // Auto-rotate: point up, Fixed north: show heading
        aircraftEl.innerHTML = `
          <svg width="24" height="24" viewBox="0 0 16 16" style="fill: #ef4444; transform: rotate(${arrowRotation}deg);">
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
        homeEl.style.width = '12px';
        homeEl.style.height = '12px';
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
  }, [mapReady, telemetryData, autoRotate, targetMetrics, autoCenterEnabled]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      planIdsRef.current = new Set(missionPlan.map((entry) => entry.id));
      return;
    }

    const currentIds = new Set<string>();
    missionPlan.forEach((entry) => {
      if (entry?.id) {
        currentIds.add(entry.id);
      }
    });

    if (!autoCenterEnabled) {
      const previousIds = planIdsRef.current;
      const newEntries = missionPlan.filter((entry) => entry?.id && !previousIds.has(entry.id));
      const latest = newEntries.length ? newEntries[newEntries.length - 1] : null;
      if (latest && Number.isFinite(latest.latitude) && Number.isFinite(latest.longitude)) {
        mapRef.current.easeTo({ center: [latest.longitude, latest.latitude], duration: 600, essential: true });
      }
    }

    planIdsRef.current = currentIds;
  }, [missionPlan, mapReady, autoCenterEnabled]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    planMarkerRefs.current.forEach((marker) => marker.remove());
    planMarkerRefs.current.clear();

    displayedPlan.forEach((entry, index) => {
      if (!Number.isFinite(entry.latitude) || !Number.isFinite(entry.longitude)) {
        return;
      }
      const label = (() => {
        if (entry.kind === 'orbit') return `O${index + 1}`;
        if (entry.kind === 'return_home') return 'R';
        if (entry.kind === 'land') return 'L';
        return `${index + 1}`;
      })();
      const element = createPlanMarkerElement(label, entry.kind);

      const marker = new maplibregl.Marker({ element })
        .setLngLat([entry.longitude, entry.latitude])
        .addTo(map);
      planMarkerRefs.current.set(entry.id, marker);
    });

    return () => {
      planMarkerRefs.current.forEach((marker) => marker.remove());
      planMarkerRefs.current.clear();
    };
  }, [mapReady, displayedPlan]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;

    if (map.getLayer(MISSION_PLAN_LAYER_ID)) {
      map.removeLayer(MISSION_PLAN_LAYER_ID);
    }
    if (map.getSource(MISSION_PLAN_SOURCE_ID)) {
      map.removeSource(MISSION_PLAN_SOURCE_ID);
    }

    if (displayedPlan.length < 2) {
      return;
    }

    const coordinates = displayedPlan
      .filter((entry) => Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude))
      .map((entry) => [entry.longitude, entry.latitude]);

    if (coordinates.length < 2) {
      return;
    }

    map.addSource(MISSION_PLAN_SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates,
        },
      },
    });

    map.addLayer({
      id: MISSION_PLAN_LAYER_ID,
      type: 'line',
      source: MISSION_PLAN_SOURCE_ID,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#38bdf8',
        'line-width': 2,
        'line-opacity': 0.7,
        'line-dasharray': [2, 2],
      },
    });
  }, [mapReady, displayedPlan]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    if (!manualTarget || manualTarget.latitude == null || manualTarget.longitude == null) {
      if (manualTargetMarkerRef.current) {
        manualTargetMarkerRef.current.remove();
        manualTargetMarkerRef.current = null;
      }
      return;
    }

    const map = mapRef.current;
    if (manualTargetMarkerRef.current) {
      manualTargetMarkerRef.current.remove();
      manualTargetMarkerRef.current = null;
    }

    const element = document.createElement('div');
    element.style.width = '14px';
    element.style.height = '14px';
    element.style.borderRadius = '50%';
    element.style.backgroundColor = '#38bdf8';
    element.style.border = '2px solid #ffffff';
    element.style.boxShadow = '0 0 6px rgba(59, 130, 246, 0.8)';

    manualTargetMarkerRef.current = new maplibregl.Marker({ element })
      .setLngLat([manualTarget.longitude, manualTarget.latitude])
      .addTo(map);
  }, [mapReady, manualTarget]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    if (autoCenterEnabled) {
      manualTargetPanRef.current = null;
      return;
    }
    if (!manualTarget || manualTarget.latitude == null || manualTarget.longitude == null) {
      manualTargetPanRef.current = null;
      return;
    }

    const lat = manualTarget.latitude;
    const lon = manualTarget.longitude;
    const previous = manualTargetPanRef.current;
    if (!previous || Math.abs(previous.latitude - lat) > 1e-6 || Math.abs(previous.longitude - lon) > 1e-6) {
      mapRef.current.easeTo({ center: [lon, lat], duration: 600, essential: true });
      manualTargetPanRef.current = { latitude: lat, longitude: lon };
    }
  }, [mapReady, manualTarget?.latitude, manualTarget?.longitude, autoCenterEnabled]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    if (!activeWaypoint || !Number.isFinite(activeWaypoint.latitude) || !Number.isFinite(activeWaypoint.longitude)) {
      if (activeWaypointMarkerRef.current) {
        activeWaypointMarkerRef.current.remove();
        activeWaypointMarkerRef.current = null;
      }
      return;
    }

    const map = mapRef.current;
    if (activeWaypointMarkerRef.current) {
      activeWaypointMarkerRef.current.remove();
      activeWaypointMarkerRef.current = null;
    }

    const element = createPlanMarkerElement(activeWaypoint.label ?? 'NEXT', activeWaypoint.kind, true);

    activeWaypointMarkerRef.current = new maplibregl.Marker({ element })
      .setLngLat([activeWaypoint.longitude, activeWaypoint.latitude])
      .addTo(map);
  }, [mapReady, activeWaypoint]);

  // Persist autoRotate setting
  useEffect(() => {
    try {
      localStorage.setItem('map.autoRotate', JSON.stringify(autoRotate));
    } catch {}
  }, [autoRotate]);

  useEffect(() => {
    try {
      localStorage.setItem('map.autoCenter', JSON.stringify(autoCenter));
    } catch {}
  }, [autoCenter]);

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

        <div className="absolute top-2 left-2 flex flex-col gap-2 pointer-events-none select-none">
          <div className="text-[10px] text-gray-200 bg-black/60 px-2 py-1 rounded whitespace-nowrap">
            Ctrl+Click: stage target · Shift+Click: waypoint · Alt/Option+Click: orbit · Drag: pan
          </div>
          <button
            type="button"
            className="pointer-events-auto text-[10px] text-gray-200 bg-black/60 hover:bg-black/70 px-2 py-1 rounded border border-gray-600 self-start"
            onClick={handleRecenter}
          >
            Recenter map
          </button>
        </div>

        {activeWaypoint && (
          <div className="absolute top-2 right-2 text-[10px] font-semibold text-slate-900 bg-sky-300/95 px-2 py-1 rounded shadow pointer-events-none select-none whitespace-nowrap">
            Next: {activeWaypoint.label ?? 'Waypoint'}
          </div>
        )}



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

        {activeWaypoint && (
          <div className="text-center">
            <div className="text-gray-400">NEXT WP</div>
            <div className="font-mono text-sky-300">
              {activeWaypoint.label ?? 'WP'}
            </div>
          </div>
        )}

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
      <div className="mt-2 flex justify-center gap-2">
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
        <button
          onClick={() => setAutoCenter((prev) => !prev)}
          className={`px-3 py-1 text-xs rounded border transition-colors ${
            autoCenter
              ? 'bg-dji-blue text-white border-dji-blue'
              : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
          }`}
        >
          {autoCenter ? 'Auto-center' : 'Center off'}
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
              {(telemetryData.altitude_amsl ?? ((telemetryData.takeoff_altitude || 0) + (telemetryData.altitude || 0))).toFixed(1)} m AMSL
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
              {(telemetryData.home_location.altitude ?? telemetryData.takeoff_altitude ?? 0).toFixed(1)} m AMSL
            </div>
          </div>
        )}

        {manualTarget?.latitude != null && manualTarget.longitude != null && (
          <div className="text-gray-500">
            <div className="text-gray-400 text-[10px] mb-1">MISSION TARGET</div>
            <div>{manualTarget.latitude.toFixed(6)}</div>
            <div>{manualTarget.longitude.toFixed(6)}</div>
            {typeof manualTarget.altitude === 'number' && (
              <div className="text-sky-300">{manualTarget.altitude.toFixed(1)} m rel</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
