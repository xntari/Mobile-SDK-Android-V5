
export type MapCoordinate = {
  latitude: number;
  longitude: number;
  altitude?: number | null;
};

interface BaseFeature {
  id: string;
  name?: string;
  category?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface PointFeature extends BaseFeature {
  type: 'point';
  location: MapCoordinate;
  radius_m?: number | null;
}

export interface PolylineFeature extends BaseFeature {
  type: 'polyline';
  points: MapCoordinate[];
  closed?: boolean;
}

export interface PolygonFeature extends BaseFeature {
  type: 'polygon';
  rings: MapCoordinate[][]; // first ring is outer boundary, subsequent rings are holes
}

export type StaticMapFeature = PointFeature | PolylineFeature | PolygonFeature;

type OSMPointFeature = {
  id: string;
  type: 'point';
  name?: string;
  category?: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  metadata?: Record<string, any>;
};

type OSMPolylineFeature = {
  id: string;
  type: 'polyline';
  name?: string;
  category?: string;
  path: Array<{ latitude: number; longitude: number; altitude?: number | null }>;
  metadata?: Record<string, any>;
};

type OSMPolygonFeature = {
  id: string;
  type: 'polygon';
  name?: string;
  category?: string;
  rings: Array<Array<{ latitude: number; longitude: number; altitude?: number | null }>>;
  metadata?: Record<string, any>;
};

type OSMFeature = OSMPointFeature | OSMPolylineFeature | OSMPolygonFeature;

// Static catalog of known geometry near the demo airspace.
// Coordinates are approximate WGS84 lat/lon pairs.
export const STATIC_MAP_FEATURES: StaticMapFeature[] = [
  {
    id: 'hospital_good_samaritan_perimeter',
    name: 'Good Samaritan Hospital',
    category: 'hospital',
    description: 'Approximate campus footprint for perimeter patrol missions.',
    tags: ['medical', 'campus', 'patrol'],
    type: 'polygon',
    rings: [
      [
        { latitude: 37.25205, longitude: -121.95190 },
        { latitude: 37.25213, longitude: -121.94963 },
        { latitude: 37.24996, longitude: -121.94947 },
        { latitude: 37.24982, longitude: -121.95201 },
        { latitude: 37.25205, longitude: -121.95190 },
      ],
    ],
    metadata: {
      address: '2425 Samaritan Dr, San Jose, CA',
      notes: 'Use finish_action return_to_launch for default missions.',
    },
  },
  {
    id: 'hospital_good_samaritan_helipad',
    name: 'Good Samaritan Helipad',
    category: 'hospital',
    description: 'Preferred landing/approach reference point.',
    type: 'point',
    location: { latitude: 37.25127, longitude: -121.95047, altitude: null },
    metadata: {
      radius_m: 20,
      notes: 'Keep holding pattern radius ≥35 m when circling.',
    },
  },
  {
    id: 'park_vasona_lake_loop',
    name: 'Vasona Lake Park Perimeter',
    category: 'park',
    description: 'Outer loop around Vasona Lake County Park for patrol demos.',
    type: 'polygon',
    rings: [
      [
        { latitude: 37.23590, longitude: -121.97197 },
        { latitude: 37.23758, longitude: -121.96577 },
        { latitude: 37.23441, longitude: -121.96262 },
        { latitude: 37.23078, longitude: -121.96527 },
        { latitude: 37.23126, longitude: -121.97083 },
        { latitude: 37.23364, longitude: -121.97292 },
        { latitude: 37.23590, longitude: -121.97197 },
      ],
    ],
    metadata: {
      surface: 'mixed',
      suggested_altitude_agl_m: 60,
    },
  },
  {
    id: 'parking_lot_demo_north',
    name: 'North Campus Parking',
    category: 'parking_lot',
    description: 'Demo parking lot near the staging area. Useful for perimeter sweeps.',
    type: 'polygon',
    rings: [
      [
        { latitude: 37.22705, longitude: -121.96924 },
        { latitude: 37.22705, longitude: -121.96828 },
        { latitude: 37.22655, longitude: -121.96828 },
        { latitude: 37.22655, longitude: -121.96924 },
        { latitude: 37.22705, longitude: -121.96924 },
      ],
    ],
    metadata: {
      surface: 'asphalt',
      default_altitude_agl_m: 25,
    },
  },
  {
    id: 'trail_creek_northbound',
    name: 'Los Gatos Creek Trail (North)',
    category: 'trail',
    description: 'Polyline following the creek trail north of the launch site.',
    type: 'polyline',
    points: [
      { latitude: 37.22660, longitude: -121.96865 },
      { latitude: 37.22778, longitude: -121.96743 },
      { latitude: 37.22915, longitude: -121.96652 },
      { latitude: 37.23051, longitude: -121.96569 },
      { latitude: 37.23182, longitude: -121.96462 },
    ],
    metadata: {
      suggested_altitude_agl_m: 40,
      caution: 'Watch for tree canopy; prefer gimbal-only look-at.',
    },
  },
];

export function getStaticMapFeatures(): StaticMapFeature[] {
  return STATIC_MAP_FEATURES.slice();
}

function convertOsmFeature(feature: OSMFeature): StaticMapFeature | null {
  if (feature.type === 'point') {
    if (!Number.isFinite(feature.latitude) || !Number.isFinite(feature.longitude)) {
      return null;
    }
    return {
      id: feature.id,
      type: 'point',
      name: feature.name,
      category: feature.category,
      location: {
        latitude: feature.latitude,
        longitude: feature.longitude,
        altitude: feature.altitude ?? null,
      },
      metadata: feature.metadata,
    };
  }
  if (feature.type === 'polyline') {
    if (!Array.isArray(feature.path) || feature.path.length < 2) {
      return null;
    }
    const points = feature.path
      .filter((pt) => Number.isFinite(pt.latitude) && Number.isFinite(pt.longitude))
      .map((pt) => ({ latitude: pt.latitude, longitude: pt.longitude, altitude: pt.altitude ?? null }));
    if (points.length < 2) return null;
    return {
      id: feature.id,
      type: 'polyline',
      name: feature.name,
      category: feature.category,
      points,
      metadata: feature.metadata,
    };
  }
  if (feature.type === 'polygon') {
    if (!Array.isArray(feature.rings) || feature.rings.length === 0) {
      return null;
    }
    const rings = feature.rings
      .map((ring) => ring
        .filter((pt) => Number.isFinite(pt.latitude) && Number.isFinite(pt.longitude))
        .map((pt) => ({ latitude: pt.latitude, longitude: pt.longitude, altitude: pt.altitude ?? null })))
      .filter((ring) => ring.length >= 3);
    if (!rings.length) return null;
    return {
      id: feature.id,
      type: 'polygon',
      name: feature.name,
      category: feature.category,
      rings,
      metadata: feature.metadata,
    };
  }
  return null;
}

// Large OSM imports are temporarily disabled while the map_lookup service is built.
const OSM_FEATURES: StaticMapFeature[] = [];

export function getOsmMapFeatures(): StaticMapFeature[] {
  return OSM_FEATURES.slice();
}

export function getAllMapFeatures(): StaticMapFeature[] {
  return [...STATIC_MAP_FEATURES, ...OSM_FEATURES];
}
