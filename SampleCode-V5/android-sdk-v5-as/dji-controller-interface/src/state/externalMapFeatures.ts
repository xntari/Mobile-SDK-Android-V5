import type {
  PlannerContextMapFeature,
  PlannerContextMapPointFeature,
  PlannerContextMapPolygonFeature,
  PlannerContextMapPolylineFeature,
} from '../agent/plannerContext';

type ExternalFeatureBase = {
  source?: string;
  createdAt: number;
};

type ExternalFeature =
  | (PlannerContextMapPointFeature & ExternalFeatureBase)
  | (PlannerContextMapPolylineFeature & ExternalFeatureBase)
  | (PlannerContextMapPolygonFeature & ExternalFeatureBase);

type Listener = (features: PlannerContextMapFeature[]) => void;

class ExternalMapFeatureStore {
  private features: ExternalFeature[] = [];

  private listeners: Set<Listener> = new Set();

  add(features: PlannerContextMapFeature[], source?: string) {
    const timestamp = Date.now();
    features.forEach((feature) => {
      const existingIndex = this.features.findIndex((item) => item.id === feature.id);
      const record: ExternalFeature = { ...feature, source, createdAt: timestamp };
      if (existingIndex >= 0) {
        this.features[existingIndex] = record;
      } else {
        this.features.push(record);
      }
    });
    this.notify();
  }

  clear() {
    this.features = [];
    this.notify();
  }

  getSnapshot(): PlannerContextMapFeature[] {
    return this.features.map((feature) => this.stripMetadata(feature));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[ExternalMapFeatureStore] listener error', error);
      }
    });
  }

  private stripMetadata(feature: ExternalFeature): PlannerContextMapFeature {
    const { source: _source, createdAt: _createdAt, ...rest } = feature;

    if (rest.type === 'point') {
      const point: PlannerContextMapPointFeature = {
        id: rest.id,
        type: 'point',
        name: rest.name,
        category: rest.category,
        latitude: rest.latitude,
        longitude: rest.longitude,
        altitude: rest.altitude ?? null,
        radius_m: rest.radius_m ?? null,
        metadata: rest.metadata,
      };
      return point;
    }

    if (rest.type === 'polyline') {
      const polyline: PlannerContextMapPolylineFeature = {
        id: rest.id,
        type: 'polyline',
        name: rest.name,
        category: rest.category,
        path: rest.path,
        length_m: rest.length_m ?? null,
        metadata: rest.metadata,
      };
      return polyline;
    }

    const polygon: PlannerContextMapPolygonFeature = {
      id: rest.id,
      type: 'polygon',
      name: rest.name,
      category: rest.category,
      rings: rest.rings,
      area_m2: rest.area_m2 ?? null,
      centroid: rest.centroid ?? null,
      metadata: rest.metadata,
    };

    return polygon;
  }
}

export const externalMapFeatureStore = new ExternalMapFeatureStore();
