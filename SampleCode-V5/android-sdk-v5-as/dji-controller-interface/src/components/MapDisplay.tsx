import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MapViewManager, type MapClickEvent } from '../map';
import { MapDisplayProps } from '../types';
import { telemetryShallowEqual } from '../utils/telemetryCompare';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';
import { computeTargetMetrics } from '../utils/objectMemoryTarget';
import { missionPlannerStore } from '../state/missionPlanner';
import type {
  PlannedMissionEntry,
  ManualTargetState,
  MissionWaypointTarget,
  PoiTarget,
} from '../types/missionPlanner';
import { mapSettingsStore, type MapProvider } from '../state/mapSettings';
import { terrainCache } from '../map/terrainCache';
import { CollapsibleSection } from './CollapsibleSection';

const calculateDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * 1000;
};

const getMapInfo = (telemetryData: MapDisplayProps['telemetryData']) => {
  const aircraftLocation = telemetryData?.location;
  const homeLocation = telemetryData?.home_location;

  if (!aircraftLocation || !homeLocation) {
    return { distance: 0, bearing: 0, valid: false } as const;
  }

  const distance = calculateDistance(
    aircraftLocation.latitude,
    aircraftLocation.longitude,
    homeLocation.latitude,
    homeLocation.longitude,
  );

  const bearing = telemetryData?.home_bearing || 0;

  return { distance, bearing, valid: true } as const;
};

const MapDisplayComponent: React.FC<MapDisplayProps> = ({
  flightPath = [],
  telemetryData: telemetryDataProp = null,
}) => {
  const telemetryData = telemetryDataProp ?? null;

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapManagerRef = useRef<MapViewManager | null>(null);
  const mapClickHandlerRef = useRef<(event: MapClickEvent) => void>(() => {});

  const [mapReady, setMapReady] = useState(false);

  const [mapSettings, setMapSettings] = useState(() => mapSettingsStore.getSnapshot());

  const [objectTarget, setObjectTarget] = useState<ObjectMemoryTargetSelection | null>(
    () => objectMemoryTargetStore.getCurrent(),
  );
  useEffect(() => objectMemoryTargetStore.subscribe(setObjectTarget), []);

  const [terrainStats, setTerrainStats] = useState(() => terrainCache.getSnapshot());
  useEffect(() => terrainCache.subscribe(setTerrainStats), []);

  const [missionPlan, setMissionPlan] = useState<PlannedMissionEntry[]>(
    () => missionPlannerStore.getSnapshot().plan,
  );
  useEffect(() => missionPlannerStore.subscribePlan(setMissionPlan), []);

  const [manualTarget, setManualTarget] = useState<ManualTargetState | null>(
    () => missionPlannerStore.getSnapshot().manualTarget,
  );
  useEffect(() => missionPlannerStore.subscribeManualTarget(setManualTarget), []);

  const [activeWaypoint, setActiveWaypoint] = useState<MissionWaypointTarget | null>(
    () => missionPlannerStore.getSnapshot().activeWaypoint ?? null,
  );
  useEffect(() => missionPlannerStore.subscribeActiveWaypoint(setActiveWaypoint), []);

  const [poiTarget, setPoiTarget] = useState<PoiTarget | null>(
    () => missionPlannerStore.getSnapshot().poiTarget ?? null,
  );
  useEffect(() => missionPlannerStore.subscribePoiTarget(setPoiTarget), []);

  const targetMetrics = useMemo(
    () => computeTargetMetrics(
      telemetryData,
      objectTarget?.anchor,
      objectTarget?.clusterLabel ?? objectTarget?.clusterId,
    ),
    [telemetryData, objectTarget],
  );

  const telemetryPlan = useMemo<PlannedMissionEntry[]>(() => {
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

  const displayedPlan = useMemo<PlannedMissionEntry[]>(() => (
    missionPlan.length ? missionPlan : telemetryPlan
  ), [missionPlan, telemetryPlan]);

  useEffect(() => mapSettingsStore.subscribe(setMapSettings), []);

  const layerPresets = useMemo(() => mapSettingsStore.getPresets(), []);
  const providerOptions = useMemo<MapProvider[]>(() => (
    Array.from(new Set(layerPresets.map((preset) => preset.provider)))
  ), [layerPresets]);
  const layerPresetOptions = useMemo(() => (
    layerPresets.filter((preset) => preset.provider === mapSettings.provider)
  ), [layerPresets, mapSettings.provider]);
  const currentPreset = useMemo(() => (
    layerPresets.find((preset) => preset.id === mapSettings.layerPresetId) ?? null
  ), [layerPresets, mapSettings.layerPresetId]);
  const terrainSupported = currentPreset?.supportsTerrain ?? false;

  const handleToggleAutoRotate = useCallback(() => {
    mapSettingsStore.setAutoRotate(!mapSettings.autoRotate);
  }, [mapSettings.autoRotate]);

  const handleToggleAutoCenter = useCallback(() => {
    mapSettingsStore.setAutoCenter(!mapSettings.autoCenter);
  }, [mapSettings.autoCenter]);

  const handleProviderChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    mapSettingsStore.setProvider(event.target.value as MapProvider);
  }, []);

  const handleLayerPresetChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    mapSettingsStore.setLayerPreset(event.target.value);
  }, []);

  const handleToggleTerrain = useCallback(() => {
    if (!terrainSupported) {
      if (mapSettings.terrainEnabled) {
        mapSettingsStore.setTerrainEnabled(false);
      }
      return;
    }
    mapSettingsStore.setTerrainEnabled(!mapSettings.terrainEnabled);
  }, [mapSettings.terrainEnabled, terrainSupported]);

  const handleTerrainExaggerationChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) {
      mapSettingsStore.setTerrainExaggeration(value);
    }
  }, []);

  const handleClearTerrainCache = useCallback(() => {
    terrainCache.clear();
  }, []);

  const handleToggleViewMode = useCallback(() => {
    mapSettingsStore.toggleViewMode();
  }, []);

  useEffect(() => {
    mapClickHandlerRef.current = (event: MapClickEvent) => {
      if (event.button !== 0) {
        return;
      }

      const { latitude, longitude, altKey, ctrlKey, metaKey, shiftKey } = event;
      const wantsOrbit = altKey;
      const wantsStageTarget = ctrlKey || metaKey;
      const wantsWaypoint = shiftKey || (!wantsOrbit && !wantsStageTarget);

      if (wantsStageTarget) {
        missionPlannerStore.requestStageTarget({
          latitude,
          longitude,
          source: 'map',
        });
        return;
      }

      if (wantsOrbit) {
        const altitudeCandidate =
          typeof manualTarget?.altitude === 'number'
            ? manualTarget.altitude
            : typeof telemetryData?.location?.altitude === 'number'
              ? telemetryData.location.altitude
              : typeof telemetryData?.altitude === 'number'
                ? telemetryData.altitude
                : null;

        missionPlannerStore.setPoiTarget({
          latitude,
          longitude,
          altitude: altitudeCandidate,
        });

        if (manualTarget?.latitude == null || manualTarget?.longitude == null) {
          missionPlannerStore.requestStageTarget({
            latitude,
            longitude,
            altitude: altitudeCandidate ?? undefined,
            source: 'map',
          });
        }

        return;
      }

      if (wantsWaypoint) {
        missionPlannerStore.requestAddWaypoint({
          latitude,
          longitude,
          kind: 'waypoint',
          source: 'map',
        });
      }
    };
  }, [manualTarget, telemetryData]);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) {
      return;
    }

    const manager = new MapViewManager({
      provider: mapSettings.provider,
      onReady: () => setMapReady(true),
      onClick: (event) => mapClickHandlerRef.current?.(event),
    });

    manager.initialize(container);
    mapManagerRef.current = manager;

    return () => {
      manager.destroy();
      mapManagerRef.current = null;
      setMapReady(false);
    };
  }, [mapSettings.provider]);

  useEffect(() => {
    const manager = mapManagerRef.current;
    if (!manager) {
      return;
    }

    manager.updateState({
      telemetry: telemetryData,
      targetMetrics,
      objectTargetLabel: objectTarget?.clusterLabel
        ?? (objectTarget?.clusterId != null ? String(objectTarget.clusterId) : null),
      autoCenter: mapSettings.autoCenter,
      autoRotate: mapSettings.autoRotate,
      layerPresetId: mapSettings.layerPresetId,
      terrainEnabled: mapSettings.terrainEnabled,
      terrainExaggeration: mapSettings.terrainExaggeration,
      viewMode: mapSettings.viewMode,
      displayedPlan,
      manualTarget,
      activeWaypoint,
      poiTarget,
      flightPath: flightPath.length ? flightPath : undefined,
    });
  }, [
    telemetryData,
    targetMetrics,
    objectTarget,
    mapSettings,
    displayedPlan,
    manualTarget,
    activeWaypoint,
    poiTarget,
    flightPath,
  ]);

  const handleRecenter = useCallback(() => {
    mapManagerRef.current?.recenter();
  }, []);

  const mapInfo = useMemo(() => getMapInfo(telemetryData), [telemetryData]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 rounded border border-gray-600 overflow-hidden relative">
        <div
          ref={mapContainerRef}
          className="w-full h-full"
          style={{ minHeight: '120px' }}
        />

        <div className="absolute top-2 left-2 text-[10px] text-gray-200 bg-black/60 px-2 py-1 rounded pointer-events-none select-none">
          Click: WP · ⌘+Click: stage target · Alt+Click: POI
        </div>
        <button
          type="button"
          className="absolute top-2 right-2 text-[10px] text-gray-200 bg-black/60 hover:bg-black/70 px-2 py-1 rounded border border-gray-600"
          onClick={handleRecenter}
        >
          Recenter map
        </button>

        {activeWaypoint && (
          <div className="absolute top-2 right-2 text-[10px] font-semibold text-slate-900 bg-sky-300/95 px-2 py-1 rounded shadow pointer-events-none select-none whitespace-nowrap">
            Next: {activeWaypoint.label ?? 'Waypoint'}
          </div>
        )}

        {!mapReady && (
          <div className="absolute inset-0 bg-gray-900 bg-opacity-80 flex items-center justify-center">
            <div className="text-xs text-gray-400">Loading Map...</div>
          </div>
        )}
      </div>

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

      <div className="mt-3 space-y-3">
        <CollapsibleSection
          title="Map Settings"
          storageKey="map.settings.basic"
          defaultOpen
          bodyClassName="space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-gray-300">
                <span>Provider</span>
                <select
                  value={mapSettings.provider}
                  onChange={handleProviderChange}
                  className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-200"
                >
                  {providerOptions.map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-gray-300">
                <span>Layer</span>
                <select
                  value={mapSettings.layerPresetId}
                  onChange={handleLayerPresetChange}
                  className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-200"
                >
                  {layerPresetOptions.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleToggleAutoRotate}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  mapSettings.autoRotate
                    ? 'bg-dji-blue text-white border-dji-blue'
                    : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
                }`}
              >
                {mapSettings.autoRotate ? 'Auto-rotate' : 'North up'}
              </button>
              <button
                onClick={handleToggleAutoCenter}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  mapSettings.autoCenter
                    ? 'bg-dji-blue text-white border-dji-blue'
                    : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
                }`}
              >
                {mapSettings.autoCenter ? 'Auto-center' : 'Center off'}
              </button>
              <button
                onClick={handleToggleTerrain}
                disabled={!terrainSupported}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  !terrainSupported
                    ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed'
                    : mapSettings.terrainEnabled
                      ? 'bg-sky-700 text-white border-sky-500'
                      : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
                }`}
              >
                {terrainSupported
                  ? mapSettings.terrainEnabled ? 'Terrain on' : 'Terrain off'
                  : 'Terrain unavailable'}
              </button>
              <button
                onClick={handleToggleViewMode}
                className={`px-3 py-1 text-xs rounded border transition-colors ${
                  mapSettings.viewMode === '3d'
                    ? 'bg-sky-700 text-white border-sky-500'
                    : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'
                }`}
              >
                {mapSettings.viewMode === '3d' ? 'Switch to 2D' : 'Switch to 3D'}
              </button>
            </div>
          </div>

          {targetMetrics && (
            <div className="text-[11px] text-center text-purple-200">
              {(objectTarget?.clusterLabel ?? objectTarget?.clusterId) ?? 'Target'}
              {targetMetrics.altitudeDelta != null ? ` · Δalt ${targetMetrics.altitudeDelta.toFixed(1)} m` : ''}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Advanced"
          storageKey="map.settings.advanced"
          defaultOpen={false}
          bodyClassName="text-xs text-gray-200 space-y-2"
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-gray-300">
              <label className="flex items-center gap-2">
                <span>Terrain exaggeration</span>
                <input
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={mapSettings.terrainExaggeration}
                  onChange={handleTerrainExaggerationChange}
                  disabled={!mapSettings.terrainEnabled || !terrainSupported}
                  className="accent-sky-400"
                />
                <span className="w-10 text-right text-sm text-gray-200">
                  {mapSettings.terrainExaggeration.toFixed(1)}×
                </span>
              </label>
            </div>
            <div className="bg-gray-900/40 border border-gray-700 rounded px-3 py-2 text-[11px] text-gray-400 space-y-1">
              <div className="text-gray-300 font-semibold">Terrain cache</div>
              <div>Tiles cached: {terrainStats.tileCount}</div>
              <div>Requests: {terrainStats.requests} (hits {terrainStats.hits}, misses {terrainStats.misses})</div>
              <div>Pending loads: {terrainStats.pending}</div>
              {!terrainSupported && (
                <div className="text-[10px] text-yellow-400">Current layer does not support terrain. Switch to Street, Satellite, or Hybrid to enable terrain rendering.</div>
              )}
              <button
                type="button"
                onClick={handleClearTerrainCache}
                disabled={terrainStats.tileCount === 0}
                className={`mt-2 px-2 py-1 rounded border ${terrainStats.tileCount === 0 ? 'border-gray-700 text-gray-600 cursor-not-allowed' : 'border-gray-500 text-gray-200 hover:bg-gray-800'}`}
              >
                Clear cache
              </button>
            </div>
          </div>
        </CollapsibleSection>
      </div>

      <div className="mt-2 flex justify-between text-xs font-mono leading-tight">
        {telemetryData?.location && (
          <div className="text-gray-500">
            <div className="text-gray-400 text-[10px] mb-1">AIRCRAFT</div>
            <div>{telemetryData.location.latitude.toFixed(6)}</div>
            <div>{telemetryData.location.longitude.toFixed(6)}</div>
            <div className="text-yellow-400">
              {(telemetryData.altitude_amsl
                ?? ((telemetryData.takeoff_altitude || 0) + (telemetryData.altitude || 0)))
                .toFixed(1)} m AMSL
            </div>
          </div>
        )}

        {telemetryData?.home_location && (
          <div className="text-gray-500">
            <div className="text-gray-400 text-[10px] mb-1">HOME</div>
            <div>{telemetryData.home_location.latitude.toFixed(6)}</div>
            <div>{telemetryData.home_location.longitude.toFixed(6)}</div>
            <div className="text-yellow-400">
              {(telemetryData.home_location.altitude
                ?? telemetryData.takeoff_altitude
                ?? 0).toFixed(1)} m AMSL
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

const flightPathEqual = (
  a?: Array<{ latitude: number; longitude: number }> | null,
  b?: Array<{ latitude: number; longitude: number }> | null,
) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].latitude !== b[i].latitude || a[i].longitude !== b[i].longitude) {
      return false;
    }
  }
  return true;
};

const mapPropsEqual = (prev: MapDisplayProps, next: MapDisplayProps) => {
  if (!flightPathEqual(prev.flightPath ?? null, next.flightPath ?? null)) {
    return false;
  }
  return telemetryShallowEqual(prev.telemetryData ?? null, next.telemetryData ?? null);
};

export const MapDisplay = React.memo(MapDisplayComponent, mapPropsEqual);
