import React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Panel } from './Panel';
import { useBridgeCommands } from '../hooks/useBridgeCommands';
import { useStableBridgeData } from '../hooks/useStableBridgeData';
import { addMetersToLatLon, bearingOffsetToMeters, normalizeHeadingDegrees } from '../utils/geo';
import { TelemetryData, FlyToStatus, WaypointStatusTelemetry, FlightCommandAck, WaypointTimelineEntry } from '../types';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';

type MissionLogKind = 'command' | 'telemetry' | 'simulation' | 'laser' | 'manual';

interface MissionLogEntry {
  id: string;
  timestamp: number;
  label: string;
  payload: Record<string, any>;
  kind: MissionLogKind;
}

interface MissionPreviewPath {
  id: string;
  start?: { latitude: number; longitude: number };
  target?: { latitude: number; longitude: number };
  missionId?: string;
  backend?: string;
  updatedAt: number;
}

interface WaypointMapPreviewProps {
  path: MissionPreviewPath | null;
  interactive?: boolean;
  onSelectTarget?: (location: { latitude: number; longitude: number }) => void;
}

const MAX_LOG_ENTRIES = 40;
const clampAltitude = (value: number) => Math.max(-500, Math.min(6000, value));

const formatLatLon = (value?: number) =>
  typeof value === 'number' ? value.toFixed(7) : '—';

const formatMissionStateLabel = (state?: string) =>
  state ? state.replace(/_/g, ' ').toUpperCase() : 'UNKNOWN';

const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return '–';
  const delta = Date.now() - timestamp;
  if (delta < 0) return 'now';
  if (delta < 1000) return '<1s';
  if (delta < 60000) return `${Math.floor(delta / 1000)}s`;
  const minutes = delta / 60000;
  return minutes < 10 ? `${minutes.toFixed(1)}m` : `${Math.floor(minutes)}m`;
};

const clampLat = (value: number) => Math.max(-90, Math.min(90, value));
const clampLon = (value: number) => Math.max(-180, Math.min(180, value));

const EARTH_RADIUS_M = 6371000;
const DEFAULT_VERTICAL_SPEED_MS = 1.5;
const MIN_HORIZONTAL_DISTANCE_M = 1.0;
const MIN_VERTICAL_DISTANCE_M = 0.5;

const haversineMeters = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(1 - h, 0)));
  return EARTH_RADIUS_M * c;
};

const formatMetersValue = (value: number, precision = 1) => `${value.toFixed(precision)} m`;

const formatSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '–';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = seconds / 60;
  return mins < 60 ? `${mins.toFixed(1)}m` : `${(mins / 60).toFixed(1)}h`;
};

interface ManualTargetState {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  source?: 'manual' | 'map' | 'laser' | 'object-memory';
}

interface SimulationSegment {
  label: string;
  distance: number;
  speed: number;
  duration: number;
  startAltitude: number;
  endAltitude: number;
}

interface SimulationPreview {
  segments: SimulationSegment[];
  totalDistance: number;
  totalDuration: number;
}

const WaypointMapPreview: React.FC<WaypointMapPreviewProps> = ({ path, interactive = false, onSelectTarget }) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const startMarkerRef = React.useRef<maplibregl.Marker | null>(null);
  const targetMarkerRef = React.useRef<maplibregl.Marker | null>(null);
  const lineSourceId = React.useRef(`flyto-preview-line-${Math.random().toString(36).slice(2, 8)}`);

  React.useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [
          {
            id: 'osm-tiles-layer',
            type: 'raster',
            source: 'osm-tiles',
          },
        ],
      },
      center: [0, 0],
      zoom: 15,
      attributionControl: false,
      logoPosition: 'bottom-right',
      interactive: true,
    });

    mapRef.current = map;

    map.on('load', () => {
      if (!map.getSource(lineSourceId.current)) {
        map.addSource(lineSourceId.current, {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [],
            },
            properties: {},
          },
        });

        map.addLayer({
          id: `${lineSourceId.current}-layer`,
          type: 'line',
          source: lineSourceId.current,
          paint: {
            'line-color': '#4ade80',
            'line-width': 3,
            'line-dasharray': [2, 2],
          },
        });
      }
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
      }
      mapRef.current = null;
      startMarkerRef.current = null;
      targetMarkerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const coordinates: Array<[number, number]> = [];

    if (path?.start && Number.isFinite(path.start.latitude) && Number.isFinite(path.start.longitude)) {
      if (!startMarkerRef.current) {
        startMarkerRef.current = new maplibregl.Marker({ color: '#38bdf8' });
      }
      startMarkerRef.current
        .setLngLat([path.start.longitude, path.start.latitude])
        .addTo(map);
      coordinates.push([path.start.longitude, path.start.latitude]);
    } else if (startMarkerRef.current) {
      startMarkerRef.current.remove();
      startMarkerRef.current = null;
    }

    if (path?.target && Number.isFinite(path.target.latitude) && Number.isFinite(path.target.longitude)) {
      if (!targetMarkerRef.current) {
        targetMarkerRef.current = new maplibregl.Marker({ color: '#f97316' });
      }
      targetMarkerRef.current
        .setLngLat([path.target.longitude, path.target.latitude])
        .addTo(map);
      coordinates.push([path.target.longitude, path.target.latitude]);
    } else if (targetMarkerRef.current) {
      targetMarkerRef.current.remove();
      targetMarkerRef.current = null;
    }

    const sourceId = lineSourceId.current;
    if (!map.isStyleLoaded()) {
      map.once('load', () => {
        const postLoadSource = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
        if (postLoadSource) {
          postLoadSource.setData({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates,
            },
            properties: {},
          });
        }
      });
      return;
    }

    if (map.getSource(sourceId)) {
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource;
      source.setData({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates,
        },
        properties: {},
      });
    }

    if (coordinates.length >= 2) {
      const bounds = coordinates.reduce(
        (acc, coord) => acc.extend(coord),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
      );
      map.fitBounds(bounds, { padding: 30, maxZoom: 18, duration: 300 });
    } else if (coordinates.length === 1) {
      map.easeTo({ center: coordinates[0], zoom: 17, duration: 300 });
    }
  }, [path]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !onSelectTarget) {
      return;
    }

    const canvas = map.getCanvas();

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if (!interactive) return;
      const { lngLat } = event;
      if (!lngLat) return;
      onSelectTarget({ latitude: clampLat(lngLat.lat), longitude: clampLon(lngLat.lng) });
    };

    map.on('click', handleClick);

    return () => {
      map.off('click', handleClick);
      if (canvas) {
        canvas.style.cursor = '';
      }
    };
  }, [interactive, onSelectTarget]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    if (!canvas) return;
    if (interactive) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
  }, [interactive]);

  return (
    <div className="relative">
      <div ref={containerRef} className="w-full h-40 rounded border border-gray-700/60 overflow-hidden" />
      {interactive && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center text-[11px] uppercase tracking-wide text-amber-200 bg-black/20">
          Click map to set target
        </div>
      )}
    </div>
  );
};

export const FlyToPanel: React.FC = () => {
  const { sendFlightCommand } = useBridgeCommands();
  const { bridgeData } = useStableBridgeData();
  const telemetry = bridgeData.telemetry;
  const [distanceMeters, setDistanceMeters] = React.useState<number>(5);
  const [verticalMeters, setVerticalMeters] = React.useState<number>(2);
  const [maxSpeed, setMaxSpeed] = React.useState<number>(3);
  const [securityTakeoffHeight, setSecurityTakeoffHeight] = React.useState<number>(20);
  const [flyToMode, setFlyToMode] = React.useState<'smart_height' | 'set_height'>('smart_height');
  const [flyToHeight, setFlyToHeight] = React.useState<number>(50);
  const [logEntries, setLogEntries] = React.useState<MissionLogEntry[]>([]);
  const [previewPath, setPreviewPath] = React.useState<MissionPreviewPath | null>(null);
  const [manualTarget, setManualTarget] = React.useState<ManualTargetState>({ latitude: null, longitude: null, altitude: null });
  const [placingTarget, setPlacingTarget] = React.useState<boolean>(false);
  const [simPreview, setSimPreview] = React.useState<SimulationPreview | null>(null);
  const [lastLaserFix, setLastLaserFix] = React.useState<{ latitude: number; longitude: number; altitude?: number } | null>(null);
  const [targetSelection, setTargetSelection] = React.useState<ObjectMemoryTargetSelection | null>(() =>
    objectMemoryTargetStore.getCurrent(),
  );
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const lastAckRef = React.useRef<number | null>(null);
  const lastWaypointStateRef = React.useRef<string | null>(null);
  const lastWaypointIndexRef = React.useRef<string | null>(null);
  const waypointTimelineSeenRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => objectMemoryTargetStore.subscribe(setTargetSelection), []);

  const flyToStatus = telemetry?.fly_to_status as FlyToStatus | undefined;
  const waypointStatus = telemetry?.waypoint_status as WaypointStatusTelemetry | undefined;
  const missionStateLabel = formatMissionStateLabel(waypointStatus?.state);
  const missionActive = Boolean(
    waypointStatus?.state &&
      !['ready', 'finished', 'idle', 'not_supported', 'unknown'].includes(
        waypointStatus.state.toLowerCase(),
      ),
  );
  const missionTimestampLabel = formatRelativeTime(waypointStatus?.timestamp);
  const missionBackend = waypointStatus?.backend ?? previewPath?.backend;
  const missionId = waypointStatus?.mission_id ?? previewPath?.missionId;
  const missionInterrupt = waypointStatus?.last_interrupt;
  const derivedTarget = React.useMemo(() => {
    const anchor = targetSelection?.anchor;
    if (!anchor) return null;
    const objectPosition = anchor.object_position;
    const mapTarget = anchor.object_map?.target_point;
    const candidate = mapTarget && typeof mapTarget.latitude === 'number' && typeof mapTarget.longitude === 'number'
      ? mapTarget
      : objectPosition;

    if (!candidate || typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') {
      return null;
    }

    const altitudeCandidate = candidate.altitude_m ?? anchor.object_map?.laser_location?.altitude_m ?? objectPosition?.altitude_m;
    return {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      altitude: altitudeCandidate ?? null,
    };
  }, [targetSelection]);
  const activeTarget = React.useMemo(() => {
    if (manualTarget.latitude != null && manualTarget.longitude != null) {
      return manualTarget;
    }
    if (derivedTarget) {
      return {
        latitude: derivedTarget.latitude,
        longitude: derivedTarget.longitude,
        altitude: derivedTarget.altitude ?? null,
        source: 'object-memory' as ManualTargetState['source'],
      };
    }
    return null;
  }, [manualTarget.latitude, manualTarget.longitude, manualTarget.altitude, manualTarget.source, derivedTarget?.latitude, derivedTarget?.longitude, derivedTarget?.altitude]);

  const manualTargetSourceLabel = React.useMemo(() => {
    switch (manualTarget.source) {
      case 'map':
        return 'Map click';
      case 'laser':
        return 'Laser range';
      case 'object-memory':
        return 'Object memory';
      case 'manual':
        return 'Manual entry';
      default:
        return null;
    }
  }, [manualTarget.source]);

  React.useEffect(() => {
    if (!derivedTarget || !targetSelection) {
      return;
    }
    setManualTarget((prev) => {
      if (prev.source && prev.source !== 'object-memory') {
        return prev;
      }
      if (
        prev.latitude === derivedTarget.latitude &&
        prev.longitude === derivedTarget.longitude &&
        ((prev.altitude ?? null) === (derivedTarget.altitude ?? null))
      ) {
        return prev;
      }
      return {
        latitude: derivedTarget.latitude,
        longitude: derivedTarget.longitude,
        altitude: derivedTarget.altitude ?? prev.altitude ?? null,
        source: 'object-memory',
      };
    });
  }, [derivedTarget?.latitude, derivedTarget?.longitude, derivedTarget?.altitude, targetSelection?.clusterId]);

  React.useEffect(() => {
    if (manualTarget.latitude == null || manualTarget.longitude == null) {
      return;
    }
    setPreviewPath((prev) => {
      const same = prev?.target &&
        Math.abs(prev.target.latitude - manualTarget.latitude!) < 1e-9 &&
        Math.abs(prev.target.longitude - manualTarget.longitude!) < 1e-9;
      if (same) {
        return prev;
      }
      const now = Date.now();
      return {
        id: prev?.id ?? `manual-${now}`,
        start: prev?.start,
        target: { latitude: manualTarget.latitude!, longitude: manualTarget.longitude! },
        backend: prev?.backend,
        missionId: prev?.missionId,
        updatedAt: now,
      };
    });
    setPlacingTarget(false);
  }, [manualTarget.latitude, manualTarget.longitude]);

  React.useEffect(() => {
    setSimPreview(null);
  }, [manualTarget.latitude, manualTarget.longitude, manualTarget.altitude, flyToMode, flyToHeight, maxSpeed, securityTakeoffHeight]);
  const capabilitySupportedModes = React.useMemo(() => {
    const raw = flyToStatus?.capability?.supported_modes;
    if (!raw || !Array.isArray(raw) || raw.length === 0) return undefined;
    const mapping: Record<string, 'smart_height' | 'set_height'> = {
      smart_height: 'smart_height',
      smartheight: 'smart_height',
      smart: 'smart_height',
      set_height: 'set_height',
      setheight: 'set_height',
      set: 'set_height',
    };
    const normalized = raw
      .map((mode) => (typeof mode === 'string' ? mapping[mode.toLowerCase()] : undefined))
      .filter((value): value is 'smart_height' | 'set_height' => Boolean(value));
    if (!normalized.length) return undefined;
    return Array.from(new Set(normalized));
  }, [flyToStatus?.capability?.supported_modes]);

  const availableModes = capabilitySupportedModes ?? ['smart_height', 'set_height'];

  React.useEffect(() => {
    if (!availableModes.includes(flyToMode)) {
      setFlyToMode(availableModes[0]);
    }
  }, [availableModes, flyToMode]);

  const heightRange = flyToStatus?.capability?.height_range;
  const heightRangeMin = typeof heightRange?.min === 'number' ? heightRange.min : 1;
  const heightRangeMax = typeof heightRange?.max === 'number' ? heightRange.max : 500;

  const appendLog = React.useCallback((label: string, payload: Record<string, any>, kind: MissionLogKind = 'command') => {
    setLogEntries((prev) => {
      const entry: MissionLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        label,
        payload,
        kind,
      };
      const next = [entry, ...prev];
      return next.slice(0, MAX_LOG_ENTRIES);
    });
  }, []);

  const stageManualTarget = React.useCallback((next: ManualTargetState, context: Record<string, any>, message: string) => {
    setManualTarget(next);
    setPlacingTarget(false);
    setSimPreview(null);
    appendLog('Target staged', context, 'manual');
    setStatusMessage(message);
  }, [appendLog]);

  React.useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onBridgeData) {
      return;
    }

    const handler = (message: any) => {
      if (!message || message.type !== 'camera_laser_result') {
        return;
      }
      const payload = message.data ?? message;
      const result = payload?.data ?? payload;
      const waypoint = result?.waypoint;
      const lat = waypoint?.lat ?? waypoint?.latitude;
      const lon = waypoint?.lon ?? waypoint?.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return;
      }
      const altitude = typeof waypoint?.alt_m === 'number' ? waypoint.alt_m : undefined;
      const clampedLat = clampLat(lat);
      const clampedLon = clampLon(lon);
      setLastLaserFix({ latitude: clampedLat, longitude: clampedLon, altitude });
      setManualTarget((prev) => {
        if (
          prev.source === 'laser' &&
          prev.latitude === clampedLat &&
          prev.longitude === clampedLon &&
          ((prev.altitude ?? undefined) === altitude)
        ) {
          return prev;
        }
        return {
          latitude: clampedLat,
          longitude: clampedLon,
          altitude: typeof altitude === 'number' ? altitude : prev.altitude ?? null,
          source: 'laser',
        };
      });
      setPlacingTarget(false);
      setSimPreview(null);
      appendLog('Laser waypoint', { waypoint: result?.waypoint, raw: result }, 'laser');
      setStatusMessage(`Laser waypoint captured (${clampedLat.toFixed(6)}, ${clampedLon.toFixed(6)})`);
    };

    api.onBridgeData(handler);

    return () => {
      // shared listener; no removal to avoid breaking other consumers
    };
  }, [appendLog]);

  const ensureTelemetry = (): TelemetryData | null => {
    if (!telemetry || !telemetry.location) {
      setStatusMessage('Telemetry unavailable — cannot compute target.');
      return null;
    }
    return telemetry;
  };

  const handleMapTargetSelect = React.useCallback((location: { latitude: number; longitude: number }) => {
    setManualTarget((prev) => ({
      latitude: location.latitude,
      longitude: location.longitude,
      altitude: prev.altitude,
      source: 'map',
    }));
    setStatusMessage(`Map target set at ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`);
    setPlacingTarget(false);
    setSimPreview(null);
  }, []);

  const updateManualCoordinate = React.useCallback((field: 'latitude' | 'longitude', raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setManualTarget((prev) => ({ ...prev, [field]: null, source: 'manual' }));
      setSimPreview(null);
      return;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      setStatusMessage(`Invalid ${field === 'latitude' ? 'latitude' : 'longitude'} value`);
      return;
    }
    const clamped = field === 'latitude' ? clampLat(numeric) : clampLon(numeric);
    setManualTarget((prev) => ({ ...prev, [field]: clamped, source: 'manual' }));
    setSimPreview(null);
  }, []);

  const updateManualAltitude = React.useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setManualTarget((prev) => ({ ...prev, altitude: null, source: 'manual' }));
      setSimPreview(null);
      return;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      setStatusMessage('Invalid altitude value');
      return;
    }
    setManualTarget((prev) => ({ ...prev, altitude: numeric, source: 'manual' }));
    setSimPreview(null);
  }, []);

  const handleClearManualTarget = React.useCallback(() => {
    setManualTarget({ latitude: null, longitude: null, altitude: null });
    setSimPreview(null);
    setPlacingTarget(false);
    setStatusMessage('Manual target cleared.');
  }, []);

  const handleUseCurrentLocation = React.useCallback(() => {
    if (!telemetry?.location) {
      setStatusMessage('Telemetry location unavailable');
      return;
    }
    const { latitude, longitude, altitude } = telemetry.location;
    setManualTarget((prev) => ({
      latitude,
      longitude,
      altitude: altitude ?? prev.altitude ?? null,
      source: 'manual',
    }));
    setPlacingTarget(false);
    setSimPreview(null);
    setStatusMessage('Target snapped to aircraft position.');
  }, [telemetry?.location?.latitude, telemetry?.location?.longitude, telemetry?.location?.altitude]);

  const handleUseLaserFix = React.useCallback(() => {
    if (!lastLaserFix) {
      setStatusMessage('No laser measurement captured yet. Trigger a measurement first.');
      return;
    }
    setManualTarget((prev) => ({
      latitude: lastLaserFix.latitude,
      longitude: lastLaserFix.longitude,
      altitude: typeof lastLaserFix.altitude === 'number' ? lastLaserFix.altitude : prev.altitude ?? null,
      source: 'laser',
    }));
    setPlacingTarget(false);
    setSimPreview(null);
    setStatusMessage('Applied last laser measurement.');
  }, [lastLaserFix]);

  const handleExportMissionLog = React.useCallback(() => {
    if (!logEntries.length) {
      setStatusMessage('No mission entries to export.');
      return;
    }
    const blob = new Blob([JSON.stringify(logEntries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mission-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [logEntries]);

  const simulateMission = React.useCallback(() => {
    if (!telemetry || !telemetry.location) {
      setStatusMessage('Telemetry unavailable — cannot compute target.');
      return;
    }
    const telemetrySnapshot = telemetry;
    const startLocation = telemetrySnapshot.location;
    if (!startLocation || !Number.isFinite(startLocation.latitude) || !Number.isFinite(startLocation.longitude)) {
      setStatusMessage('Telemetry missing aircraft location for simulation.');
      return;
    }
    if (!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Set a mission target before simulating.');
      return;
    }

    const takeoffAsl = telemetrySnapshot.takeoff_altitude ?? (
      (telemetrySnapshot.location.altitude ?? 0) - (telemetrySnapshot.altitude_above_takeoff ?? 0)
    );
    const currentAsl = telemetrySnapshot.location.altitude ?? (
      (takeoffAsl ?? 0) + (telemetrySnapshot.altitude_above_takeoff ?? 0)
    );

    let targetAlt = activeTarget.altitude ?? telemetrySnapshot.location.altitude ?? currentAsl;
    if (flyToMode === 'set_height' && typeof flyToHeight === 'number' && takeoffAsl != null) {
      targetAlt = takeoffAsl + flyToHeight;
    }

    const securityAlt = takeoffAsl != null ? takeoffAsl + securityTakeoffHeight : null;
    const horizontalDistance = haversineMeters(
      { latitude: startLocation.latitude, longitude: startLocation.longitude },
      { latitude: activeTarget.latitude, longitude: activeTarget.longitude },
    );

    const segments: SimulationSegment[] = [];
    let totalHorizontalDist = 0;
    let totalVerticalDist = 0;
    let totalDuration = 0;
    let workingAlt = currentAsl;

    if (securityAlt != null && securityAlt > workingAlt + 0.1) {
      const climb = securityAlt - workingAlt;
      const duration = Math.abs(climb) / DEFAULT_VERTICAL_SPEED_MS;
      segments.push({
        label: 'Ascend to security height',
        distance: 0,
        speed: DEFAULT_VERTICAL_SPEED_MS,
        duration,
        startAltitude: workingAlt,
        endAltitude: securityAlt,
      });
      totalVerticalDist += Math.abs(climb);
      totalDuration += duration;
      workingAlt = securityAlt;
    }

    if (horizontalDistance > 0.2) {
      const horizontalSpeed = Math.max(0.5, Number.isFinite(maxSpeed) && maxSpeed > 0 ? maxSpeed : 3);
      const duration = horizontalDistance / horizontalSpeed;
      segments.push({
        label: 'Horizontal translation',
        distance: horizontalDistance,
        speed: horizontalSpeed,
        duration,
        startAltitude: workingAlt,
        endAltitude: workingAlt,
      });
      totalHorizontalDist += horizontalDistance;
      totalDuration += duration;
    }

    if (targetAlt != null && Math.abs(targetAlt - workingAlt) > 0.1) {
      const delta = targetAlt - workingAlt;
      const duration = Math.abs(delta) / DEFAULT_VERTICAL_SPEED_MS;
      segments.push({
        label: delta > 0 ? 'Climb to target altitude' : 'Descend to target altitude',
        distance: 0,
        speed: DEFAULT_VERTICAL_SPEED_MS,
        duration,
        startAltitude: workingAlt,
        endAltitude: targetAlt,
      });
      totalVerticalDist += Math.abs(delta);
      totalDuration += duration;
      workingAlt = targetAlt;
    }

    const totalDistance = totalHorizontalDist + totalVerticalDist;
    const preview: SimulationPreview = {
      segments,
      totalDistance,
      totalDuration,
    };
    setSimPreview(preview);
    appendLog('Simulated mission preview', {
      total_distance_m: totalDistance,
      horizontal_distance_m: totalHorizontalDist,
      vertical_distance_m: totalVerticalDist,
      total_duration_s: totalDuration,
      segments: segments.map((segment) => ({
        label: segment.label,
        distance: segment.distance,
        speed: segment.speed,
        duration: segment.duration,
        start_altitude: segment.startAltitude,
        end_altitude: segment.endAltitude,
      })),
    }, 'simulation');
    setStatusMessage('Simulation ready — review the mission summary below.');
  }, [activeTarget, appendLog, flyToHeight, flyToMode, maxSpeed, securityTakeoffHeight, telemetry]);

  const handleSimulateMission = React.useCallback(() => {
    simulateMission();
  }, [simulateMission]);

  const sendFlyTo = async (latitude: number, longitude: number, altitude: number | null, label: string) => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;

    setSimPreview(null);
    setPlacingTarget(false);

    const baseLocation = telemetrySnapshot.location;
    const baseAltitude = baseLocation.altitude ?? telemetrySnapshot.altitude ?? 0;
    const takeoffAltitude = telemetrySnapshot.takeoff_altitude
      ?? (typeof baseAltitude === 'number' && typeof telemetrySnapshot.altitude_above_takeoff === 'number'
        ? baseAltitude - telemetrySnapshot.altitude_above_takeoff
        : undefined);
    let resolvedAltitude = altitude ?? baseAltitude;

    const horizontalDistance = baseLocation
      ? haversineMeters(
          { latitude: baseLocation.latitude, longitude: baseLocation.longitude },
          { latitude, longitude },
        )
      : Number.NaN;
    const verticalDelta = altitude != null
      ? Math.abs((altitude ?? baseAltitude) - baseAltitude)
      : 0;

    if (!Number.isNaN(horizontalDistance) && horizontalDistance < MIN_HORIZONTAL_DISTANCE_M && verticalDelta < MIN_VERTICAL_DISTANCE_M) {
      setStatusMessage(`Target unchanged (<${MIN_HORIZONTAL_DISTANCE_M.toFixed(1)} m horizontal & <${MIN_VERTICAL_DISTANCE_M.toFixed(1)} m vertical). Adjust before executing.`);
      appendLog('Fly-to skipped: target too close', {
        horizontal_distance: horizontalDistance,
        vertical_delta: verticalDelta,
        from: baseLocation,
        to: { latitude, longitude, altitude },
      }, 'telemetry');
      return;
    }

    const params: Record<string, any> = {
      target_location: {
        latitude,
        longitude,
        altitude: clampAltitude(resolvedAltitude),
      },
    };

    if (Number.isFinite(maxSpeed) && maxSpeed > 0) {
      params.max_speed = Math.round(maxSpeed);
    }
    if (Number.isFinite(securityTakeoffHeight) && securityTakeoffHeight >= 0) {
      params.security_takeoff_height = Math.round(securityTakeoffHeight);
    }

    params.mode = flyToMode;

    if (flyToMode === 'set_height') {
      if (!Number.isFinite(flyToHeight)) {
        setStatusMessage('Fly-To height required when mode is set-height');
        return;
      }
      const requestedHeight = Math.round(flyToHeight);
      params.fly_to_height = requestedHeight;
      if (typeof takeoffAltitude === 'number') {
        resolvedAltitude = clampAltitude(takeoffAltitude + requestedHeight);
      }
    }

    params.target_location.altitude = clampAltitude(resolvedAltitude);

    const now = Date.now();
    appendLog(label, params, 'command');
    setPreviewPath({
      id: `request-${now}`,
      start: telemetrySnapshot.location
        ? {
            latitude: telemetrySnapshot.location.latitude,
            longitude: telemetrySnapshot.location.longitude,
          }
        : undefined,
      target: { latitude, longitude },
      backend: undefined,
      missionId: undefined,
      updatedAt: now,
    });

    try {
      const result = await sendFlightCommand('fly_to_prepare', params);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'fly_to_prepare rejected');
      } else {
        setStatusMessage(`${label}: command sent`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'fly_to_prepare failed');
    }
  };

  const handleRelativeMove = async (direction: 'forward' | 'backward' | 'left' | 'right') => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    const { location } = telemetrySnapshot;
    const heading = normalizeHeadingDegrees(telemetrySnapshot.heading ?? telemetrySnapshot.compass_heading ?? 0);

    const dist = distanceMeters;
    const headingOffset =
      direction === 'forward'
        ? heading
        : direction === 'backward'
          ? heading + 180
          : direction === 'left'
            ? heading - 90
            : heading + 90;
    const { north, east } = bearingOffsetToMeters(dist, headingOffset);
    const next = addMetersToLatLon(location.latitude, location.longitude, north, east);
    const altitudeReference = activeTarget?.altitude
      ?? manualTarget.altitude
      ?? telemetrySnapshot.location.altitude
      ?? telemetrySnapshot.altitude
      ?? null;
    const horizontalDistance = haversineMeters(
      { latitude: location.latitude, longitude: location.longitude },
      { latitude: next.latitude, longitude: next.longitude },
    );
    const warning = horizontalDistance < MIN_HORIZONTAL_DISTANCE_M
      ? `Warning: DJI rejects missions with <${MIN_HORIZONTAL_DISTANCE_M.toFixed(1)} m horizontal separation.`
      : null;
    stageManualTarget(
      {
        latitude: next.latitude,
        longitude: next.longitude,
        altitude: altitudeReference,
        source: 'manual',
      },
      {
        reason: `relative_${direction}`,
        distance_commanded: dist,
        horizontal_distance: horizontalDistance,
        from: { latitude: location.latitude, longitude: location.longitude },
        to: { latitude: next.latitude, longitude: next.longitude },
      },
      warning
        ? `Target staged ${direction} ${dist} m · ${warning}`
        : `Target staged ${direction} ${dist} m. Run Simulate Mission before executing.`,
    );
  };

  const handleVerticalMove = async (direction: 'up' | 'down') => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    const { location } = telemetrySnapshot;
    const baseTarget = activeTarget && activeTarget.latitude != null && activeTarget.longitude != null
      ? activeTarget
      : {
          latitude: location.latitude,
          longitude: location.longitude,
          altitude: manualTarget.altitude ?? location.altitude ?? telemetrySnapshot.altitude ?? null,
        };
    const delta = direction === 'up' ? Math.abs(verticalMeters) : -Math.abs(verticalMeters);
    const newAltitude = (baseTarget.altitude ?? location.altitude ?? telemetrySnapshot.altitude ?? 0) + delta;
    const warning = Math.abs(delta) < MIN_VERTICAL_DISTANCE_M
      ? `Warning: DJI may reject vertical-only missions under ${MIN_VERTICAL_DISTANCE_M.toFixed(1)} m.`
      : null;
    stageManualTarget(
      {
        latitude: baseTarget.latitude ?? location.latitude,
        longitude: baseTarget.longitude ?? location.longitude,
        altitude: newAltitude,
        source: 'manual',
      },
      {
        reason: `vertical_${direction}`,
        delta_altitude: delta,
        base_altitude: baseTarget.altitude ?? location.altitude ?? telemetrySnapshot.altitude ?? null,
      },
      warning
        ? `Target staged ${direction === 'up' ? 'up' : 'down'} ${Math.abs(delta)} m · ${warning}`
        : `Target staged ${direction === 'up' ? 'up' : 'down'} ${Math.abs(delta)} m. Simulate before flying.`,
    );
  };

  const handleReturnHome = async (action: 'return_home_start' | 'return_home_stop') => {
    setSimPreview(null);
    appendLog(action === 'return_home_start' ? 'Return Home Start' : 'Return Home Stop', {}, 'command');
    try {
      const result = await sendFlightCommand(action);
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || `${action} rejected`);
      } else {
        setStatusMessage(`${action === 'return_home_start' ? 'Return Home started' : 'Return Home cancelled'}`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `${action} failed`);
    }
  };

  const handleStopMission = async () => {
    setSimPreview(null);
    appendLog('Waypoint Stop', {}, 'command');
    try {
      const result = await sendFlightCommand('waypoint_stop');
      if (result?.success === false) {
        setStatusMessage(result.error || result.error_message || 'waypoint_stop rejected');
      } else {
        setStatusMessage('Waypoint mission stop requested');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'waypoint_stop failed');
    }
  };

  React.useEffect(() => {
    const flightLog = bridgeData.flightCommandLog;
    if (!flightLog || flightLog.length === 0) return;
    const latest = flightLog[flightLog.length - 1] as FlightCommandAck;
    if (!latest || typeof latest.timestamp !== 'number') return;
    if (lastAckRef.current === latest.timestamp) return;
    lastAckRef.current = latest.timestamp;

    if (latest.backend === 'waypoint_v2' || latest.action === 'waypoint_stop') {
      appendLog(
        `Ack ${latest.action.replace(/_/g, ' ')}`,
        {
          status: latest.status,
          backend: latest.backend,
          mission_id: latest.mission_id,
          mission_path: latest.mission_path,
          message: latest.message ?? latest.error_message,
          wayline_ids: latest.wayline_ids,
        },
        'telemetry',
      );

      setPreviewPath((prev) => {
        const base = prev ?? {
          id: `ack-${latest.timestamp}`,
          start: prev?.start,
          target: prev?.target,
          updatedAt: Date.now(),
        };
        const targetLocation = latest.target_location;
        const target = targetLocation && typeof targetLocation.latitude === 'number' && typeof targetLocation.longitude === 'number'
          ? { latitude: targetLocation.latitude, longitude: targetLocation.longitude }
          : base.target;
        return {
          ...base,
          backend: latest.backend ?? base.backend,
          missionId: latest.mission_id ?? base.missionId,
          target,
          updatedAt: Date.now(),
        };
      });
    }
  }, [bridgeData.flightCommandLog, appendLog]);

  React.useEffect(() => {
    if (!waypointStatus) return;
    const missionId = waypointStatus.mission_id ?? waypointStatus.executing?.mission_id ?? 'unknown';
    const stateKey = `${missionId}:${waypointStatus.state ?? 'none'}`;
    if (stateKey !== lastWaypointStateRef.current) {
      lastWaypointStateRef.current = stateKey;
    }

    const waypointIndex = typeof waypointStatus.executing?.current_waypoint_index === 'number'
      ? waypointStatus.executing.current_waypoint_index
      : null;
    if (waypointIndex !== null) {
      const indexKey = `${missionId}:wp:${waypointIndex}`;
      if (indexKey !== lastWaypointIndexRef.current) {
        lastWaypointIndexRef.current = indexKey;
      }
    }

    setPreviewPath((prev) => {
      const base = prev ?? {
        id: `status-${Date.now()}`,
        start: prev?.start,
        target: prev?.target,
        updatedAt: Date.now(),
      };
      return {
        ...base,
        backend: waypointStatus.backend ?? base.backend,
        missionId: waypointStatus.mission_id ?? base.missionId,
        updatedAt: Date.now(),
      };
    });
  }, [waypointStatus]);

  React.useEffect(() => {
    const entries = waypointStatus?.timeline;
    if (!entries || entries.length === 0) {
      return;
    }
    const seen = waypointTimelineSeenRef.current;
    const makeKey = (entry: WaypointTimelineEntry, index: number) => {
      const base = `${entry.timestamp ?? 'na'}:${entry.type}`;
      switch (entry.type) {
        case 'state':
          return `${base}:${entry.state ?? index}`;
        case 'executing':
          return `${base}:${entry.mission_id ?? 'mission'}:${entry.wayline_id ?? 'wl'}:${entry.current_waypoint_index ?? index}`;
        case 'interrupt':
          return `${base}:${entry.error?.code ?? entry.error?.description ?? index}`;
        default:
          return `${base}:${index}`;
      }
    };

    entries.forEach((entry, idx) => {
      const key = makeKey(entry, idx);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      if (seen.size > 200) {
        const recent = Array.from(seen).slice(-200);
        seen.clear();
        recent.forEach((value) => seen.add(value));
      }

      const entryType = entry.type;
      let label = `Timeline ${entryType}`;
      switch (entryType) {
        case 'state':
          label = `State ${formatMissionStateLabel(entry.state)}`;
          break;
        case 'executing':
          label = `Waypoint #${entry.current_waypoint_index ?? '—'}`;
          break;
        case 'interrupt':
          label = `Interrupt ${entry.error?.code ?? ''}`.trim();
          break;
      }

      appendLog(
        label,
        { ...entry } as unknown as Record<string, any>,
        'telemetry',
      );
    });
  }, [waypointStatus?.timeline, appendLog]);

  React.useEffect(() => {
    if (!telemetry?.location) return;
    setPreviewPath((prev) => {
      if (!prev || prev.start) return prev;
      return {
        ...prev,
        start: {
          latitude: telemetry.location.latitude,
          longitude: telemetry.location.longitude,
        },
      };
    });
  }, [telemetry?.location?.latitude, telemetry?.location?.longitude]);

  const handleFlyToTarget = async () => {
    const telemetrySnapshot = ensureTelemetry();
    if (!telemetrySnapshot) return;
    if (!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null) {
      setStatusMessage('Set a mission target (map, laser, or object memory) before flying.');
      return;
    }
    const altitude = typeof activeTarget.altitude === 'number'
      ? activeTarget.altitude
      : telemetrySnapshot.location.altitude ?? telemetrySnapshot.altitude ?? null;
    const label = activeTarget.source === 'laser'
      ? 'Fly to laser target'
      : activeTarget.source === 'map'
        ? 'Fly to map target'
        : activeTarget.source === 'object-memory'
          ? 'Fly to memory target'
          : 'Fly to manual target';
    await sendFlyTo(activeTarget.latitude, activeTarget.longitude, altitude, label);
  };

  return (
    <Panel
      title="Fly-To & RTH"
      storageKey="flyto.panel"
      visibilityEventType="flyToPanelVisibilityChange"
      defaultPosition={{ x: 1040, y: 780 }}
      defaultSize={{ w: 340, h: 360 }}
    >
      <div className="flex flex-col gap-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        {statusMessage && (
          <div className="text-[11px] text-status-warning bg-black/40 border border-yellow-500/40 rounded px-2 py-1">
            {statusMessage}
          </div>
        )}

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Relative Move</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Distance (m)</span>
              <input
                type="number"
                value={distanceMeters}
                min={1}
                max={200}
                onChange={(event) => setDistanceMeters(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Max Speed (m/s)</span>
              <input
                type="number"
                value={maxSpeed}
                min={1}
                max={15}
                onChange={(event) => setMaxSpeed(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]">
              <span>Security Takeoff Height (m)</span>
              <input
                type="number"
                value={securityTakeoffHeight}
                min={0}
                max={120}
                onChange={(event) => setSecurityTakeoffHeight(Number(event.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2 text-[11px]">
            <label className="flex flex-col gap-1">
              <span>Fly-To Mode</span>
              <select
                value={flyToMode}
                onChange={(event) => setFlyToMode(event.target.value as 'smart_height' | 'set_height')}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200"
              >
                {availableModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'smart_height' ? 'Smart height' : 'Set height'}
                  </option>
                ))}
              </select>
            </label>
            {flyToMode === 'set_height' && (
              <label className="flex flex-col gap-1">
                <span>Target Height (m AGL)</span>
                <input
                  type="number"
                  value={flyToHeight}
                  min={Math.max(1, Math.floor(heightRangeMin))}
                  max={Math.max(Math.ceil(heightRangeMax), Math.floor(heightRangeMin) + 1)}
                  onChange={(event) => setFlyToHeight(Number(event.target.value) || 0)}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                />
                {heightRange && (
                  <span className="text-[10px] text-gray-500">
                    Capability range {heightRange.min ?? '—'} – {heightRange.max ?? '—'} m
                  </span>
                )}
              </label>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('forward')}>
              Forward
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('backward')}>
              Backward
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('left')}>
              Left
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleRelativeMove('right')}>
              Right
            </button>
          </div>
          {flyToStatus && (
            <div className="mt-2 text-[11px] text-gray-400 space-y-0.5">
              <div className="uppercase text-gray-500 text-[10px]">Fly-To Telemetry</div>
              <div>
                Reported mode{' '}
                <span className="text-gray-200">{flyToStatus.info?.mode ?? '—'}</span>
                {typeof flyToStatus.info?.height === 'number' && (
                  <span className="ml-2 text-gray-300">height {flyToStatus.info.height} m</span>
                )}
                {typeof flyToStatus.info?.is_running === 'boolean' && (
                  <span className="ml-2 text-gray-300">
                    {flyToStatus.info.is_running ? 'running' : 'idle'}
                  </span>
                )}
              </div>
              {Array.isArray(flyToStatus.capability?.supported_modes) && (
                <div>
                  Supported modes{' '}
                  <span className="text-gray-200">
                    {flyToStatus.capability.supported_modes.join(', ')}
                  </span>
                </div>
              )}
              {heightRange && (
                <div>
                  Height limits{' '}
                  <span className="text-gray-200">
                    {heightRange.min ?? '—'} – {heightRange.max ?? '—'} m
                  </span>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-2">Vertical Move</div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11px]">Δ Alt (m)</span>
            <input
              type="number"
              value={verticalMeters}
              min={1}
              max={200}
              onChange={(event) => setVerticalMeters(Number(event.target.value) || 0)}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right w-20"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleVerticalMove('up')}>
              Up
            </button>
            <button className="px-2 py-1 rounded bg-gray-800/80 border border-gray-700" onClick={() => handleVerticalMove('down')}>
              Down
            </button>
          </div>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-gray-400 uppercase text-[11px]">Target & Planning</div>
            {manualTargetSourceLabel && (
              <div className="text-[10px] text-amber-300">Source: {manualTargetSourceLabel}</div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
            <label className="flex flex-col gap-1">
              <span>Latitude</span>
              <input
                type="number"
                value={manualTarget.latitude ?? ''}
                onChange={(event) => updateManualCoordinate('latitude', event.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                placeholder="deg"
                step="0.000001"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Longitude</span>
              <input
                type="number"
                value={manualTarget.longitude ?? ''}
                onChange={(event) => updateManualCoordinate('longitude', event.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                placeholder="deg"
                step="0.000001"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Altitude (MSL)</span>
              <input
                type="number"
                value={manualTarget.altitude ?? ''}
                onChange={(event) => updateManualAltitude(event.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-right"
                placeholder="m"
                step="0.1"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] mb-2">
            <button
              type="button"
              className={`px-2 py-1 rounded border ${placingTarget ? 'border-amber-400 text-amber-200 bg-amber-500/10' : 'border-gray-700 text-gray-200 bg-gray-800/60 hover:bg-gray-700/60'}`}
              onClick={() => setPlacingTarget((prev) => !prev)}
            >
              {placingTarget ? 'Click map to finish' : 'Place via map'}
            </button>
            <button
              type="button"
              className={`px-2 py-1 rounded border ${lastLaserFix ? 'border-emerald-500 text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20' : 'border-gray-700 text-gray-500 cursor-not-allowed bg-gray-800/40'}`}
              onClick={handleUseLaserFix}
              disabled={!lastLaserFix}
            >
              Use laser fix
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-200 bg-gray-800/60 hover:bg-gray-700/60"
              onClick={handleUseCurrentLocation}
            >
              Use aircraft pos
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-300 bg-gray-800/40 hover:bg-gray-700/50"
              onClick={handleClearManualTarget}
            >
              Clear target
            </button>
          </div>
          {targetSelection ? (
            <div className="text-[11px] text-gray-300 mb-2">
              Memory cluster: {targetSelection.clusterLabel ?? targetSelection.clusterId}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500 mb-2">
              Tip: select an Object Memory target or capture a laser point to seed the mission.
            </div>
          )}
          {lastLaserFix && (
            <div className="text-[11px] text-gray-400 mb-2">
              Last laser fix: {formatLatLon(lastLaserFix.latitude)} / {formatLatLon(lastLaserFix.longitude)}
              {typeof lastLaserFix.altitude === 'number' && (
                <span> · {formatMetersValue(lastLaserFix.altitude, 1)}</span>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 mb-2">
            <button
              type="button"
              className="px-2 py-1 rounded bg-gray-800/70 border border-gray-600 text-gray-100 hover:bg-gray-700/70"
              onClick={handleSimulateMission}
            >
              Simulate Mission
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded bg-dji-blue text-white hover:bg-dji-blue/80 disabled:bg-gray-700 disabled:text-gray-400"
              onClick={handleFlyToTarget}
              disabled={!activeTarget || activeTarget.latitude == null || activeTarget.longitude == null}
            >
              Fly to Target
            </button>
          </div>
          {simPreview && (
            <div className="mt-2 text-[10px] text-gray-300 space-y-1">
              {simPreview.segments.length ? (
                <table className="w-full text-left border-separate border-spacing-y-1">
                  <thead className="text-gray-400">
                    <tr>
                      <th className="pr-2">Segment</th>
                      <th className="pr-2">Distance</th>
                      <th className="pr-2">Speed</th>
                      <th className="pr-2">Duration</th>
                      <th>Altitude</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simPreview.segments.map((segment, idx) => (
                      <tr key={`${segment.label}-${idx}`} className="bg-gray-900/40">
                        <td className="pr-2 py-0.5 text-gray-200">{segment.label}</td>
                        <td className="pr-2 py-0.5">{formatMetersValue(segment.distance, 1)}</td>
                        <td className="pr-2 py-0.5">{segment.speed.toFixed(1)} m/s</td>
                        <td className="pr-2 py-0.5">{formatSeconds(segment.duration)}</td>
                        <td className="py-0.5">
                          {formatMetersValue(segment.startAltitude, 1)} → {formatMetersValue(segment.endAltitude, 1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div>No movement required — already at target.</div>
              )}
              <div>
                Total distance {formatMetersValue(simPreview.totalDistance, 1)} · Total time {formatSeconds(simPreview.totalDuration)}
              </div>
            </div>
          )}
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="text-gray-400 uppercase text-[11px] mb-1">Return to Home</div>
          <div className="grid grid-cols-2 gap-2">
            <button className="px-2 py-1 rounded bg-status-good/20 border border-status-good/50 text-status-good" onClick={() => handleReturnHome('return_home_start')}>
              Start RTH
            </button>
            <button className="px-2 py-1 rounded bg-status-error/20 border border-status-error/60 text-status-error" onClick={() => handleReturnHome('return_home_stop')}>
              Stop RTH
            </button>
          </div>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-gray-400 uppercase text-[11px]">Waypoint Preview</div>
            <div className={`text-[11px] font-semibold ${missionActive ? 'text-status-good' : 'text-gray-400'}`}>
              {missionStateLabel}
            </div>
          </div>
          <WaypointMapPreview
            path={previewPath}
            interactive={placingTarget}
            onSelectTarget={handleMapTargetSelect}
          />
          <div className="mt-2 text-[11px] text-gray-300 space-y-0.5">
            <div>
              Backend: <span className="text-gray-200">{missionBackend ?? '—'}</span>
            </div>
            <div>
              Mission ID: <span className="text-gray-200">{missionId ?? '—'}</span>
            </div>
            <div>
              Updated: <span className="text-gray-200">{missionTimestampLabel}</span>
            </div>
            {missionInterrupt?.description && (
              <div className="text-status-error">
                Interrupt: {missionInterrupt.description}
                {missionInterrupt.code && (
                  <span className="text-gray-400"> ({missionInterrupt.code})</span>
                )}
              </div>
            )}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2">
            <button
              type="button"
              className="px-2 py-1 rounded bg-status-error/20 border border-status-error/60 text-status-error disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleStopMission}
              disabled={!missionActive}
            >
              Stop Waypoint Mission
            </button>
          </div>
          <div className="mt-2 text-[10px] text-gray-500">
            {placingTarget ? 'Click the preview map to capture a manual waypoint.' : 'Toggle “Place via map” above to drop a waypoint directly on the preview.'}
          </div>
        </section>

        <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <div className="text-gray-400 uppercase text-[11px]">Mission Timeline</div>
            <button
              type="button"
              className="px-2 py-1 rounded border border-gray-700 text-gray-300 bg-gray-800/40 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleExportMissionLog}
              disabled={!logEntries.length}
            >
              Export JSON
            </button>
          </div>
          {logEntries.length === 0 ? (
            <div className="text-[11px] text-gray-500">No mission entries recorded yet.</div>
          ) : (
            <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
              {logEntries.map((entry) => (
                <div key={entry.id} className="border border-gray-700/60 rounded px-2 py-1 bg-black/30">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full ${entry.kind === 'command'
                          ? 'bg-gray-700/80 text-gray-200'
                          : entry.kind === 'telemetry'
                            ? 'bg-blue-700/40 text-blue-100'
                            : entry.kind === 'simulation'
                              ? 'bg-purple-700/40 text-purple-100'
                              : entry.kind === 'laser'
                                ? 'bg-amber-600/40 text-amber-100'
                                : 'bg-emerald-700/40 text-emerald-100'
                          }`}
                      >
                        {entry.kind.toUpperCase()}
                      </span>
                      <span className="text-[11px] text-gray-200">{entry.label}</span>
                    </div>
                    <span className="text-[10px] text-gray-500">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="text-[10px] text-gray-500 whitespace-pre-wrap break-all mt-1">
{JSON.stringify(entry.payload, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Panel>
  );
};
