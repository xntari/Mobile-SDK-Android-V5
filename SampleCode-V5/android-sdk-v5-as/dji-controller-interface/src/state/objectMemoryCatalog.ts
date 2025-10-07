import type { ObjectMemoryCluster } from '../agent/objectMemoryClient';

export interface ObjectMemoryLocation {
  clusterId: string;
  label?: string | null;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  updatedTs?: number;
  distanceMeters?: number | null;
  metadata?: Record<string, any>;
}

type Listener = (entries: ObjectMemoryLocation[]) => void;

class ObjectMemoryCatalogStore {
  private dynamicEntries: ObjectMemoryLocation[] = [];
  private staticEntries: ObjectMemoryLocation[] = [];
  private listeners: Set<Listener> = new Set();

  constructor() {
    // Static catalog is currently empty; external map lookups populate dynamic entries.
  }

  getSnapshot(): ObjectMemoryLocation[] {
    return [...this.staticEntries, ...this.dynamicEntries];
  }

  setClusters(clusters: ObjectMemoryCluster[]): void {
    const next: ObjectMemoryLocation[] = [];
    for (const cluster of clusters) {
      const anchor = cluster.object_map_anchor;
      const candidate = anchor?.object_map?.target_point ?? anchor?.object_map?.laser_location ?? anchor?.object_position;
      if (!candidate) continue;
      const { latitude, longitude } = candidate;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const mapMeta = (anchor?.object_map ?? {}) as Record<string, any>;
      next.push({
        clusterId: cluster.cluster_id,
        label: cluster.label ?? cluster.detect_label_stats?.[0]?.label ?? null,
        latitude,
        longitude,
        altitude: candidate.altitude_m ?? anchor?.object_map?.laser_location?.altitude_m ?? null,
        updatedTs: cluster.updated_ts ?? cluster.created_ts,
        distanceMeters: anchor?.distance_m ?? anchor?.object_map?.enu_offset?.north ?? null,
        metadata: mapMeta,
      });
    }
    this.dynamicEntries = next;
    this.listeners.forEach((listener) => {
      try {
        listener(this.getSnapshot());
      } catch (error) {
        console.warn('[ObjectMemoryCatalogStore] listener error', error);
      }
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const objectMemoryCatalogStore = new ObjectMemoryCatalogStore();
