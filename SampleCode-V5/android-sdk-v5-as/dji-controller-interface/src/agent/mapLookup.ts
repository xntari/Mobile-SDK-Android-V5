import { externalMapFeatureStore } from '../state/externalMapFeatures';
import type { PlannerContextMapPointFeature } from './plannerContext';

export interface MapLookupOptions {
  query: string;
  near?: { latitude: number; longitude: number };
  radiusMeters?: number;
  types?: string[];
}

export interface MapLookupResult {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  category?: string;
  raw?: unknown;
}

const cache = new Map<string, MapLookupResult[]>();

const GOOGLE_PLACES_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

function buildCacheKey(options: MapLookupOptions): string {
  return JSON.stringify({
    q: options.query,
    near: options.near,
    radius: options.radiusMeters,
    types: options.types?.slice().sort(),
  });
}

function normalizeCategory(result: any): string | undefined {
  if (Array.isArray(result.types) && result.types.length) {
    return result.types[0];
  }
  return undefined;
}

function toPointFeature(result: MapLookupResult): PlannerContextMapPointFeature {
  return {
    id: `map_lookup:${result.id}`,
    type: 'point',
    name: result.name,
    category: result.category,
    latitude: result.latitude,
    longitude: result.longitude,
    altitude: null,
    radius_m: null,
    metadata: { source: 'map_lookup', raw: result.raw },
  };
}

export async function mapLookup(options: MapLookupOptions): Promise<MapLookupResult[]> {
  const cacheKey = buildCacheKey(options);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.MAP_LOOKUP_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY environment variable missing.');
  }

  const url = new URL(GOOGLE_PLACES_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('query', options.query);
  if (options.near) {
    url.searchParams.set('location', `${options.near.latitude},${options.near.longitude}`);
  }
  if (options.radiusMeters) {
    url.searchParams.set('radius', String(options.radiusMeters));
  }
  if (options.types && options.types.length) {
    url.searchParams.set('type', options.types[0]);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`map_lookup request failed (${response.status})`);
  }
  const payload = await response.json();
  if (payload.status && payload.status !== 'OK') {
    const message = payload.error_message || payload.status || 'Unknown error';
    throw new Error(`map_lookup error: ${message}`);
  }

  const results: MapLookupResult[] = Array.isArray(payload.results)
    ? payload.results.map((item: any) => ({
        id: item.place_id,
        name: item.name || item.formatted_address || options.query,
        latitude: item.geometry?.location?.lat,
        longitude: item.geometry?.location?.lng,
        category: normalizeCategory(item),
        raw: item,
      }))
        .filter((item) => typeof item.latitude === 'number' && typeof item.longitude === 'number')
    : [];

  cache.set(cacheKey, results);

  if (results.length) {
    const features = results.map(toPointFeature);
    externalMapFeatureStore.add(features, 'google');
  }

  return results;
}
