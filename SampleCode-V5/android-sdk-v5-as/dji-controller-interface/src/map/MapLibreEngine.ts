import maplibregl, { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { TelemetryData } from '../types';
import type {
  ManualTargetState,
  MissionWaypointTarget,
  PlannedMissionEntry,
  PoiTarget,
} from '../types/missionPlanner';
import type { TargetMetrics } from '../utils/objectMemoryTarget';

import type { MapEngine, MapEngineInitOptions, MapInteractionEvent, MapViewState } from './types';

const clampLat = (value: number) => Math.max(-90, Math.min(90, value));
const clampLon = (value: number) => Math.max(-180, Math.min(180, value));
const CENTER_EPSILON_DEGREES = 5e-6;

const needsCenterUpdate = (map: MapLibreMap, lon: number, lat: number) => {
  const current = map.getCenter();
  return (
    Math.abs(current.lat - lat) > CENTER_EPSILON_DEGREES ||
    Math.abs(current.lng - lon) > CENTER_EPSILON_DEGREES
  );
};

const normalizeBearing = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  let bearing = value % 360;
  if (bearing < 0) {
    bearing += 360;
  }
  return bearing;
};

const bearingDelta = (a: number, b: number) => {
  const diff = ((a - b + 540) % 360) - 180;
  return Math.abs(diff);
};

const ORBIT_COLORS = {
  text: '#7c2d12',
  background: '#fed7aa',
  border: '#ea580c',
  shadow: '0 0 4px rgba(234, 88, 12, 0.4)',
};

const POI_COLORS = {
  text: '#4c1d95',
  background: '#ede9fe',
  border: '#7c3aed',
  shadow: '0 0 6px rgba(124, 58, 237, 0.45)',
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

const SVG_NS = 'http://www.w3.org/2000/svg';

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

const createPoiMarkerElement = () => {
  const element = document.createElement('div');
  element.style.width = '20px';
  element.style.height = '20px';
  element.style.borderRadius = '50%';
  element.style.border = `2px solid ${POI_COLORS.border}`;
  element.style.backgroundColor = POI_COLORS.background;
  element.style.boxShadow = POI_COLORS.shadow;
  element.style.display = 'flex';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.fontSize = '9px';
  element.style.fontWeight = '700';
  element.style.color = POI_COLORS.text;
  element.textContent = 'POI';
  return element;
};

const isFiniteCoordinate = (coord?: { latitude?: number | null; longitude?: number | null } | null) => (
  coord ? Number.isFinite(coord.latitude) && Number.isFinite(coord.longitude) : false
);

interface TelemetryPayload {
  telemetry: TelemetryData | null;
  targetMetrics: TargetMetrics | null;
  autoCenter: boolean;
  autoRotate: boolean;
  objectTargetLabel: string | null;
  layerPresetId: string;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  viewMode: '2d' | '3d';
}

export class MapLibreEngine implements MapEngine {
  private map: MapLibreMap | null = null;
  private options: MapEngineInitOptions | null = null;
  private mapReady = false;

  private aircraftMarker: MapLibreMarker | null = null;
  private aircraftArrow: SVGSVGElement | null = null;
  private homeMarker: MapLibreMarker | null = null;
  private targetMarker: MapLibreMarker | null = null;
  private manualTargetMarker: MapLibreMarker | null = null;
  private activeWaypointMarker: MapLibreMarker | null = null;
  private poiMarker: MapLibreMarker | null = null;
  private planMarkers = new Map<string, MapLibreMarker>();

  private lastMapBearing: number | null = null;
  private lastArrowRotation: number | null = null;
  private userInteracting = false;
  private initialCenterApplied = false;
  private lastCenter: [number, number] | null = null;

  private telemetryPayload: TelemetryPayload | null = null;
  private animationFrame: number | null = null;
  private pendingTerrainRestore: number | null = null;
  private latestState: MapViewState | null = null;

  private terrainSourceId = 'maplibre-terrain-dem';
  private terrainSkyLayerId = 'maplibre-sky';
  private terrainActive = false;
  private lastTerrainExaggeration = 1;
  private lastTerrainEnabled = false;
  private lastAutoRotate = false;
  private lastAppliedViewMode: '2d' | '3d' = '2d';

  private readonly interactionEvents: Array<{ event: MapInteractionEvent; phase: 'start' | 'end' }> = [
    { event: 'dragstart', phase: 'start' },
    { event: 'dragend', phase: 'end' },
    { event: 'rotatestart', phase: 'start' },
    { event: 'rotateend', phase: 'end' },
    { event: 'pitchstart', phase: 'start' },
    { event: 'pitchend', phase: 'end' },
    { event: 'zoomstart', phase: 'start' },
    { event: 'zoomend', phase: 'end' },
    { event: 'moveend', phase: 'end' },
  ];

  private readonly boundInteractionHandlers = new Map<MapInteractionEvent, () => void>();

  initialize(container: HTMLDivElement, options: MapEngineInitOptions): void {
    this.options = options;

    this.map = new maplibregl.Map({
      container,
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
      zoom: 16,
      attributionControl: false,
      logoPosition: 'bottom-right',
    });

    this.map.once('load', () => {
      this.mapReady = true;
      this.options?.onReady?.();
    });

    this.map.on('click', this.handleMapClick);

    this.interactionEvents.forEach(({ event, phase }) => {
      const handler = () => this.handleInteraction(event, phase);
      this.boundInteractionHandlers.set(event, handler);
      this.map?.on(event, handler);
    });

    this.map.boxZoom.disable();
    this.map.dragRotate.enable();
    this.map.touchZoomRotate.enableRotation();
    this.map.dragPan.enable();
  }

  destroy(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.pendingTerrainRestore !== null) {
      cancelAnimationFrame(this.pendingTerrainRestore);
      this.pendingTerrainRestore = null;
    }

    if (this.map) {
      this.map.off('click', this.handleMapClick);
      this.boundInteractionHandlers.forEach((handler, event) => {
        this.map?.off(event, handler);
      });
      this.map.setTerrain(null);
      this.map.remove();
    }

    this.map = null;
    this.mapReady = false;
    this.aircraftMarker = null;
    this.aircraftArrow = null;
    this.homeMarker = null;
    this.targetMarker = null;
    this.manualTargetMarker = null;
    this.activeWaypointMarker = null;
    this.poiMarker = null;
    this.planMarkers.forEach((marker) => marker.remove());
    this.planMarkers.clear();
    this.boundInteractionHandlers.clear();
    this.terrainActive = false;
  }

  updateState(state: MapViewState): void {
    this.latestState = state;

    if (!this.mapReady || !this.map) {
      return;
    }

    this.telemetryPayload = {
      telemetry: state.telemetry,
      targetMetrics: state.targetMetrics,
      autoCenter: state.autoCenter,
      autoRotate: state.autoRotate,
      objectTargetLabel: state.objectTargetLabel,
      layerPresetId: state.layerPresetId,
      terrainEnabled: state.terrainEnabled,
      terrainExaggeration: state.terrainExaggeration,
      viewMode: state.viewMode,
    };

    if (this.animationFrame === null) {
      this.animationFrame = requestAnimationFrame(this.applyTelemetryUpdate);
    }

    this.updateTerrain(state.terrainEnabled, state.terrainExaggeration);
    this.applyViewMode(state.viewMode);
    this.updatePlanMarkers(state.displayedPlan);
    this.updatePoiTarget(state.poiTarget);
    this.updateManualTarget(state.manualTarget);
    this.updateActiveWaypoint(state.activeWaypoint);
    this.updateFlightPath(state.flightPath);
  }

  recenter(): void {
    if (!this.map || !this.mapReady) {
      return;
    }

    const state = this.latestState;
    let center: [number, number] | null = null;

    const target = state?.telemetry?.location ?? state?.telemetry?.home_location;
    if (target && Number.isFinite(target.latitude) && Number.isFinite(target.longitude)) {
      center = [target.longitude, target.latitude];
    } else if (this.lastCenter) {
      center = this.lastCenter;
    }

    if (center) {
      this.map.easeTo({ center, duration: 220, essential: true, easing: (t) => t });
      this.lastCenter = center;
    }
  }

  private handleMapClick = (event: maplibregl.MapMouseEvent) => {
    if (!event?.lngLat) {
      return;
    }

    const pointerEvent = event.originalEvent as MouseEvent | PointerEvent | undefined;
    if (pointerEvent && pointerEvent.button !== 0) {
      return;
    }
    if (this.map?.isMoving()) {
      return;
    }
    if (this.userInteracting) {
      return;
    }

    const info = {
      latitude: clampLat(event.lngLat.lat),
      longitude: clampLon(event.lngLat.lng),
      altKey: Boolean(pointerEvent?.altKey),
      ctrlKey: Boolean(pointerEvent?.ctrlKey),
      metaKey: Boolean(pointerEvent?.metaKey),
      shiftKey: Boolean(pointerEvent?.shiftKey),
      button: pointerEvent?.button ?? 0,
    };

    this.options?.onClick?.(info);
  };

  private handleInteraction(event: MapInteractionEvent, phase: 'start' | 'end') {
    if (phase === 'start') {
      this.userInteracting = true;
    } else {
      this.userInteracting = false;
    }

    this.options?.onInteraction?.(event, phase);
  }

  private applyTelemetryUpdate = () => {
    this.animationFrame = null;
    const map = this.map;
    if (!map || !this.mapReady || !this.telemetryPayload) {
      return;
    }

    const { telemetry, targetMetrics, autoCenter, autoRotate, objectTargetLabel, viewMode } = this.telemetryPayload;
    const aircraftLocation = telemetry?.location;
    const homeLocation = telemetry?.home_location;
    const manualTarget = this.latestState?.manualTarget;
    const manualTargetCenter =
      manualTarget &&
      typeof manualTarget.latitude === 'number' &&
      typeof manualTarget.longitude === 'number' &&
      Number.isFinite(manualTarget.latitude) &&
      Number.isFinite(manualTarget.longitude)
        ? [manualTarget.longitude, manualTarget.latitude] as [number, number]
        : null;
    const compassHeading = normalizeBearing(
      typeof telemetry?.compass_heading === 'number'
        ? telemetry.compass_heading
        : typeof telemetry?.heading === 'number'
          ? telemetry.heading
          : 0,
    );

    const tryCenter = (lon: number, lat: number, animate: boolean) => {
      if (!needsCenterUpdate(map, lon, lat)) {
        return;
      }
      const center = [lon, lat] as [number, number];
      if (animate) {
        map.easeTo({ center, duration: 220, easing: (t) => t, essential: true });
      } else {
        map.jumpTo({ center });
      }
      this.lastCenter = center;
    };

    if (!this.initialCenterApplied) {
      let initialTarget: [number, number] | null = null;
      if (isFiniteCoordinate(aircraftLocation)) {
        initialTarget = [aircraftLocation!.longitude!, aircraftLocation!.latitude!];
      } else if (isFiniteCoordinate(homeLocation)) {
        initialTarget = [homeLocation!.longitude!, homeLocation!.latitude!];
      } else if (manualTargetCenter) {
        initialTarget = manualTargetCenter;
      }
      if (initialTarget) {
        map.jumpTo({ center: initialTarget });
        this.initialCenterApplied = true;
        this.lastCenter = initialTarget;
      }
    } else if (autoCenter && !this.userInteracting) {
      if (isFiniteCoordinate(aircraftLocation)) {
        tryCenter(aircraftLocation!.longitude!, aircraftLocation!.latitude!, true);
      } else if (isFiniteCoordinate(homeLocation)) {
        tryCenter(homeLocation!.longitude!, homeLocation!.latitude!, true);
      } else if (manualTargetCenter) {
        tryCenter(manualTargetCenter[0], manualTargetCenter[1], true);
      }
    }

    if (isFiniteCoordinate(aircraftLocation)) {
      this.ensureAircraftMarker(map, aircraftLocation!, compassHeading);
    }

    if (isFiniteCoordinate(homeLocation)) {
      this.ensureHomeMarker(map, homeLocation!);
    } else if (this.homeMarker) {
      this.homeMarker.remove();
      this.homeMarker = null;
    }

    const targetPosition = targetMetrics?.targetPosition;
    if (
      targetPosition &&
      Number.isFinite(targetPosition.latitude) &&
      Number.isFinite(targetPosition.longitude)
    ) {
      const lng = targetPosition.longitude!;
      const lat = targetPosition.latitude!;
      if (!this.targetMarker) {
        const targetEl = document.createElement('div');
        targetEl.style.width = '8px';
        targetEl.style.height = '8px';
        targetEl.style.borderRadius = '50%';
        targetEl.style.backgroundColor = '#0ea5e9';
        targetEl.style.border = '2px solid white';
        targetEl.style.boxShadow = '0 0 6px rgba(14, 165, 233, 0.7)';

        const label = document.createElement('div');
        label.style.position = 'absolute';
        label.style.top = '10px';
        label.style.left = '50%';
        label.style.transform = 'translateX(-50%)';
        label.style.fontSize = '10px';
        label.style.fontWeight = '600';
        label.style.color = '#bae6fd';
        label.style.textShadow = '0 0 4px rgba(15, 118, 110, 0.4)';
        label.textContent = objectTargetLabel || targetMetrics?.label || 'Target';

        const wrapper = document.createElement('div');
        wrapper.style.position = 'relative';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.justifyContent = 'center';
        wrapper.appendChild(targetEl);
        wrapper.appendChild(label);

        this.targetMarker = new maplibregl.Marker({ element: wrapper })
          .setLngLat([lng, lat])
          .addTo(map);
      } else {
        const markerElement = this.targetMarker.getElement();
        const label = markerElement.querySelector('div:last-child');
        if (label) {
          label.textContent = objectTargetLabel || targetMetrics?.label || 'Target';
        }
        this.targetMarker.setLngLat([lng, lat]);
      }
    } else if (this.targetMarker) {
      this.targetMarker.remove();
      this.targetMarker = null;
    }

    const currentBearing = normalizeBearing(map.getBearing());
    const normalizedHeading = normalizeBearing(compassHeading);
    const desiredBearing = autoRotate ? normalizedHeading : 0;

    if (!this.userInteracting) {
      if (this.lastMapBearing == null || bearingDelta(desiredBearing, currentBearing) > 0.5) {
        map.easeTo({
          bearing: desiredBearing > 180 ? desiredBearing - 360 : desiredBearing,
          duration: 250,
          essential: true,
        });
        this.lastMapBearing = desiredBearing;
      }
    }

    const arrowRotation = autoRotate ? 0 : normalizedHeading;
    if (this.aircraftArrow && (this.lastArrowRotation == null || Math.abs(this.lastArrowRotation - arrowRotation) > 0.5)) {
      this.aircraftArrow.style.transform = `rotate(${arrowRotation}deg)`;
      this.lastArrowRotation = arrowRotation;
    }

    this.lastAutoRotate = autoRotate;
  };

  private updateTerrain(enabled: boolean, exaggeration: number) {
    if (!this.mapReady || !this.map) {
      return;
    }

    const map = this.map;
    const preservedCenter = map.getCenter();
    const preservedZoom = map.getZoom();
    const preservedBearing = map.getBearing();
    const preservedPitch = map.getPitch();

    let viewNeedsRestore = false;

    if (this.pendingTerrainRestore !== null) {
      cancelAnimationFrame(this.pendingTerrainRestore);
      this.pendingTerrainRestore = null;
    }

    if (!enabled) {
      if (this.terrainActive) {
        map.setTerrain(null);
        if (map.getLayer(this.terrainSkyLayerId)) {
          try {
            map.removeLayer(this.terrainSkyLayerId);
          } catch (error) {
            console.warn('[MapLibreEngine] Failed to remove sky layer', error);
          }
        }
        if (map.getLayer(`${this.terrainSourceId}-hillshade`)) {
          try {
            map.removeLayer(`${this.terrainSourceId}-hillshade`);
          } catch (error) {
            console.warn('[MapLibreEngine] Failed to remove hillshade layer', error);
          }
        }
        this.terrainActive = false;
        this.lastTerrainEnabled = false;
        viewNeedsRestore = true;
      }
    } else {
      const needsActivation = !this.terrainActive || !this.lastTerrainEnabled;
      const exaggerationChanged = Math.abs(this.lastTerrainExaggeration - exaggeration) >= 0.01;

      if (needsActivation || exaggerationChanged) {
        try {
          if (!map.getSource(this.terrainSourceId)) {
            map.addSource(this.terrainSourceId, {
              type: 'raster-dem',
              tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: 'Terrain data © Mapzen / AWS Terrain Tiles',
              maxzoom: 15,
              encoding: 'terrarium',
            } as any);
          }

          if (!map.getLayer(this.terrainSkyLayerId)) {
            map.addLayer({
              id: this.terrainSkyLayerId,
              type: 'sky',
              paint: {
                'sky-type': 'atmosphere',
                'sky-atmosphere-sun': [0.0, 0.0],
                'sky-atmosphere-sun-intensity': 10,
              },
            } as any);
          }

          if (!map.getLayer(`${this.terrainSourceId}-hillshade`)) {
            map.addLayer({
              id: `${this.terrainSourceId}-hillshade`,
              type: 'hillshade',
              source: this.terrainSourceId,
              paint: {
                'hillshade-exaggeration': exaggeration,
              },
            }, 'osm-tiles-layer');
          } else {
            map.setPaintProperty(`${this.terrainSourceId}-hillshade`, 'hillshade-exaggeration', exaggeration);
          }

          map.setTerrain({ source: this.terrainSourceId, exaggeration });
          this.terrainActive = true;
          this.lastTerrainExaggeration = exaggeration;
          this.lastTerrainEnabled = true;
          viewNeedsRestore = true;
        } catch (error) {
          console.warn('[MapLibreEngine] Failed to enable terrain', error);
        }
      }
    }

    if (viewNeedsRestore) {
      const restore = () => {
        if (!this.map || !this.mapReady) {
          this.pendingTerrainRestore = null;
          return;
        }
        this.map.jumpTo({
          center: [preservedCenter.lng, preservedCenter.lat],
          zoom: preservedZoom,
          bearing: preservedBearing,
          pitch: preservedPitch,
        });
        this.lastCenter = [preservedCenter.lng, preservedCenter.lat];
        this.lastMapBearing = normalizeBearing(preservedBearing);
        this.pendingTerrainRestore = null;
      };

      this.pendingTerrainRestore = requestAnimationFrame(restore);
    }
  }

  private applyViewMode(viewMode: '2d' | '3d') {
    if (!this.mapReady || !this.map) {
      return;
    }

    if (this.userInteracting) {
      return;
    }

    const targetPitch = viewMode === '3d' ? 55 : 0;
    const currentPitch = this.map.getPitch();
    const pitchDelta = Math.abs(currentPitch - targetPitch);

    if (pitchDelta > 0.5) {
      this.map.easeTo({
        pitch: targetPitch,
        duration: viewMode === '3d' ? 500 : 400,
        essential: true,
      });
    }

    this.lastAppliedViewMode = viewMode;
  }

  private ensureAircraftMarker(map: MapLibreMap, location: NonNullable<TelemetryData['location']>, heading: number) {
    const lng = location.longitude ?? 0;
    const lat = location.latitude ?? 0;

    if (!this.aircraftMarker) {
      const container = document.createElement('div');
      container.style.width = '36px';
      container.style.height = '36px';
      container.style.display = 'flex';
      container.style.alignItems = 'center';
      container.style.justifyContent = 'center';

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '32');
      svg.setAttribute('height', '32');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.style.fill = '#ef4444';
      svg.style.transformOrigin = '50% 50%';
      svg.style.filter = 'drop-shadow(0 0 3px rgba(0, 0, 0, 0.6))';

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M8 1 L13 13 L8 10 L3 13 Z');
      svg.appendChild(path);
      container.appendChild(svg);
      this.aircraftArrow = svg;

      this.aircraftMarker = new maplibregl.Marker({ element: container })
        .setLngLat([lng, lat])
        .addTo(map);
    } else {
      this.aircraftMarker.setLngLat([lng, lat]);
    }

  }

  private ensureHomeMarker(map: MapLibreMap, location: NonNullable<TelemetryData['home_location']>) {
    const lng = location.longitude ?? 0;
    const lat = location.latitude ?? 0;

    if (!this.homeMarker) {
      const element = document.createElement('div');
      element.style.width = '14px';
      element.style.height = '14px';
      element.style.borderRadius = '50%';
      element.style.backgroundColor = '#4ade80';
      element.style.border = '2px solid white';
      element.style.boxShadow = '0 0 4px rgba(34, 211, 238, 0.6)';

      this.homeMarker = new maplibregl.Marker({ element })
        .setLngLat([lng, lat])
        .addTo(map);
    } else {
      this.homeMarker.setLngLat([lng, lat]);
    }
  }

  private updatePlanMarkers(displayedPlan: PlannedMissionEntry[]) {
    if (!this.mapReady || !this.map) {
      return;
    }

    const nextIds = new Set<string>();

    displayedPlan.forEach((entry, index) => {
      if (!Number.isFinite(entry.latitude) || !Number.isFinite(entry.longitude)) {
        return;
      }
      const id = entry.id ?? `plan-${index}`;
      nextIds.add(id);

      const label = (() => {
        if (entry.kind === 'orbit') return `O${index + 1}`;
        if (entry.kind === 'return_home') return 'R';
        if (entry.kind === 'land') return 'L';
        return `${index + 1}`;
      })();

      const existing = this.planMarkers.get(id);
      if (existing) {
        existing.setLngLat([entry.longitude!, entry.latitude!]);
      } else {
        const element = createPlanMarkerElement(label, entry.kind);
        const marker = new maplibregl.Marker({ element })
          .setLngLat([entry.longitude!, entry.latitude!])
          .addTo(this.map);
        this.planMarkers.set(id, marker);
      }
    });

    this.planMarkers.forEach((marker, id) => {
      if (!nextIds.has(id)) {
        marker.remove();
        this.planMarkers.delete(id);
      }
    });
  }

  private updatePoiTarget(poi: PoiTarget | null) {
    if (!this.mapReady || !this.map) {
      if (this.poiMarker) {
        this.poiMarker.remove();
        this.poiMarker = null;
      }
      return;
    }

    if (!poi || !Number.isFinite(poi.latitude) || !Number.isFinite(poi.longitude)) {
      if (this.poiMarker) {
        this.poiMarker.remove();
        this.poiMarker = null;
      }
      return;
    }

    const clampedLat = clampLat(poi.latitude);
    const clampedLon = clampLon(poi.longitude);

    if (!this.poiMarker) {
      const element = createPoiMarkerElement();
      this.poiMarker = new maplibregl.Marker({ element })
        .setLngLat([clampedLon, clampedLat])
        .addTo(this.map);
    } else {
      this.poiMarker.setLngLat([clampedLon, clampedLat]);
    }
  }

  private updateManualTarget(manualTarget: ManualTargetState | null) {
    if (!this.mapReady || !this.map) {
      if (this.manualTargetMarker) {
        this.manualTargetMarker.remove();
        this.manualTargetMarker = null;
      }
      return;
    }

    if (!manualTarget || manualTarget.latitude == null || manualTarget.longitude == null) {
      if (this.manualTargetMarker) {
        this.manualTargetMarker.remove();
        this.manualTargetMarker = null;
      }
      return;
    }

    const lng = manualTarget.longitude;
    const lat = manualTarget.latitude;

    if (!this.manualTargetMarker) {
      const element = document.createElement('div');
      element.style.width = '14px';
      element.style.height = '14px';
      element.style.borderRadius = '50%';
      element.style.backgroundColor = '#38bdf8';
      element.style.border = '2px solid #ffffff';
      element.style.boxShadow = '0 0 6px rgba(59, 130, 246, 0.8)';

      this.manualTargetMarker = new maplibregl.Marker({ element })
        .setLngLat([lng, lat])
        .addTo(this.map);
      return;
    }

    this.manualTargetMarker.setLngLat([lng, lat]);
  }

  private updateActiveWaypoint(activeWaypoint: MissionWaypointTarget | null) {
    if (!this.mapReady || !this.map) {
      if (this.activeWaypointMarker) {
        this.activeWaypointMarker.remove();
        this.activeWaypointMarker = null;
      }
      return;
    }

    if (!activeWaypoint || !Number.isFinite(activeWaypoint.latitude) || !Number.isFinite(activeWaypoint.longitude)) {
      if (this.activeWaypointMarker) {
        this.activeWaypointMarker.remove();
        this.activeWaypointMarker = null;
      }
      return;
    }

    if (this.activeWaypointMarker) {
      this.activeWaypointMarker.remove();
      this.activeWaypointMarker = null;
    }

    const element = createPlanMarkerElement(activeWaypoint.label ?? 'NEXT', activeWaypoint.kind, true);

    this.activeWaypointMarker = new maplibregl.Marker({ element })
      .setLngLat([activeWaypoint.longitude, activeWaypoint.latitude])
      .addTo(this.map);
  }

  private updateFlightPath(flightPath?: Array<{ latitude: number; longitude: number }>) {
    if (!this.mapReady || !this.map) {
      return;
    }

    if (this.map.getSource('flight-path')) {
      this.map.removeLayer('flight-path-layer');
      this.map.removeSource('flight-path');
    }

    if (!flightPath || flightPath.length < 2) {
      return;
    }

    const coordinates = flightPath
      .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
      .map((point) => [point.longitude, point.latitude] as [number, number]);

    if (coordinates.length < 2) {
      return;
    }

    this.map.addSource('flight-path', {
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

    this.map.addLayer({
      id: 'flight-path-layer',
      type: 'line',
      source: 'flight-path',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#1E88E5',
        'line-width': 2,
        'line-opacity': 0.7,
      },
    });
  }
}
