export type ObjectMemoryClusterAnchor = {
  sample_id: string;
  sample_created_ts: number;
  timestamp?: number;
  distance_m?: number;
  source_camera?: string;
  object_position: { latitude: number; longitude: number; altitude_m?: number };
  drone_position: { latitude: number; longitude: number; altitude_m?: number };
  drone_orientation?: { yaw?: number; pitch?: number; roll?: number };
  gimbal_orientation?: { yaw?: number; pitch?: number; roll?: number };
  object_map?: {
    enu_offset?: { east?: number; north?: number; up?: number };
    screen_point?: { x?: number; y?: number };
    laser_location?: { latitude: number; longitude: number; altitude_m?: number };
    target_point?: { latitude: number; longitude: number; altitude_m?: number };
    aircraft?: {
      location?: { latitude: number; longitude: number; altitude_m?: number };
      attitude?: { yaw?: number; pitch?: number; roll?: number };
      gimbal?: { yaw?: number; pitch?: number; roll?: number };
    };
    prompts?: string[];
    ov_labels_used?: string[];
    detection_score?: number;
    memory_label?: string;
    memory_similarity?: number;
    track_id?: string;
  };
};

export type ObjectMemoryCluster = {
  cluster_id: string;
  created_ts: number;
  sample_count: number;
  label?: string | null;
  status: 'named' | 'unknown';
  merged_from: string[];
  preview_sample_id?: string | null;
  max_samples?: number;
  dedupe_threshold?: number;
  mean_similarity?: number;
  updated_ts?: number;
  nearest_neighbor_id?: string | null;
  nearest_neighbor_similarity?: number | null;
  detect_label_stats?: ObjectMemoryLabelStat[];
  latest_sample?: {
    sample_id: string;
    created_ts: number;
    detect_label?: string | null;
    detect_label_raw?: string | null;
    telemetry?: SampleTelemetryPayload;
  } | null;
  object_map_anchor?: ObjectMemoryClusterAnchor | null;
};

export type ObjectMemorySample = {
  sample_id: string;
  cluster_id: string;
  created_ts: number;
  track_ids: string[];
  image_path: string;
  telemetry?: SampleTelemetryPayload;
  detect_label?: string | null;
  detect_label_raw?: string | null;
};

export type ObjectMemoryLabelStat = {
  label: string;
  count: number;
};

export type SampleTelemetryPayload = {
  drone_position?: { latitude?: number; longitude?: number; altitude_m?: number };
  drone_orientation?: { yaw?: number; pitch?: number; roll?: number };
  gimbal_orientation?: { yaw?: number; pitch?: number; roll?: number };
  object_position?: { latitude?: number; longitude?: number; altitude_m?: number; distance_m?: number };
  object_orientation?: { yaw?: number; pitch?: number; roll?: number };
  source_camera?: string;
  timestamp?: number;
  extra?: Record<string, any>;
};

export type MoveSamplesResponse = {
  target: ObjectMemoryCluster;
  created: boolean;
  moved: string[];
  missing: string[];
  updated_sources: ObjectMemoryCluster[];
  removed_clusters: string[];
};

export type IngestSampleParams = {
  image: string;
  track_id?: string;
  label?: string;
  telemetry?: SampleTelemetryPayload;
  forceNewCluster?: boolean;
  avoidClusterIds?: string[];
  detectLabel?: string;
  detectLabelRaw?: string;
};

type SavedEndpoints = { objectMemory?: string };

function loadSavedEndpoints(): SavedEndpoints {
  try { const raw = localStorage.getItem('settings.endpoints'); if (raw) return JSON.parse(raw) as SavedEndpoints; } catch {}
  return {};
}

function deriveObjectMemoryUrl(): string {
  const ep = loadSavedEndpoints();
  const base = (globalThis as any).__OBJECT_MEMORY_BASE__ || ep.objectMemory || 'http://127.0.0.1:9012';
  return String(base).replace(/\/$/, '');
}

export function getObjectMemoryBase(): string {
  return deriveObjectMemoryUrl();
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getObjectMemoryBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export async function ingestSample(params: IngestSampleParams): Promise<any> {
  const payload: Record<string, any> = {
    image: params.image,
  };
  if (params.track_id) payload.track_id = params.track_id;
  if (params.label) payload.label = params.label;
  if (params.telemetry) payload.telemetry = params.telemetry;
  if (params.forceNewCluster) payload.force_new_cluster = true;
  if (params.avoidClusterIds && params.avoidClusterIds.length) {
    payload.avoid_cluster_ids = params.avoidClusterIds;
  }
  if (params.detectLabel) payload.detect_label = params.detectLabel;
  if (params.detectLabelRaw) payload.detect_label_raw = params.detectLabelRaw;
  return http('/memory/ingest', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function searchSample(image: string): Promise<{ match: { cluster: ObjectMemoryCluster; similarity: number } | null }> {
  return http('/memory/search', {
    method: 'POST',
    body: JSON.stringify({ image }),
  });
}

export async function listClusters(params: { status?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; clusters: ObjectMemoryCluster[] }> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (typeof params.limit === 'number') query.set('limit', String(params.limit));
  if (typeof params.offset === 'number') query.set('offset', String(params.offset));
  const path = `/memory/clusters${query.toString() ? `?${query.toString()}` : ''}`;
  return http(path);
}

export async function getCluster(clusterId: string): Promise<{ cluster: ObjectMemoryCluster; samples: ObjectMemorySample[] }> {
  return http(`/memory/clusters/${clusterId}`);
}

export async function deleteCluster(clusterId: string): Promise<{ deleted: string }> {
  return http(`/memory/clusters/${clusterId}`, {
    method: 'DELETE',
  });
}

export async function labelCluster(clusterId: string, label: string): Promise<{ cluster: ObjectMemoryCluster }> {
  return http(`/memory/clusters/${clusterId}/label`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
}

export async function mergeClusters(targetId: string, sourceIds: string[]): Promise<{ target: ObjectMemoryCluster; merged: string[] }> {
  return http('/memory/clusters/merge', {
    method: 'POST',
    body: JSON.stringify({ target_id: targetId, source_ids: sourceIds }),
  });
}

export async function deleteSample(sampleId: string): Promise<{ deleted: string }> {
  return http(`/memory/samples/${sampleId}`, { method: 'DELETE' });
}

export async function moveSamples(params: { sampleIds: string[]; targetClusterId?: string; newLabel?: string }): Promise<MoveSamplesResponse> {
  const payload: Record<string, any> = {
    sample_ids: params.sampleIds,
  };
  if (params.targetClusterId) payload.target_cluster_id = params.targetClusterId;
  if (params.newLabel) payload.new_label = params.newLabel;
  return http('/memory/samples/move', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchSampleImage(sampleId: string): Promise<string> {
  const res = await http<{ image: string }>(`/memory/samples/${sampleId}/image`);
  return res.image;
}

export async function updateClusterConfig(clusterId: string, params: { maxSamples?: number; dedupeThreshold?: number }): Promise<{ cluster: ObjectMemoryCluster }> {
  const payload: Record<string, any> = {};
  if (typeof params.maxSamples === 'number') payload.max_samples = params.maxSamples;
  if (typeof params.dedupeThreshold === 'number') payload.dedupe_threshold = params.dedupeThreshold;
  return http(`/memory/clusters/${clusterId}/config`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function pruneCluster(clusterId: string, similarity: number): Promise<{ removed: string[]; cluster: ObjectMemoryCluster }> {
  return http(`/memory/clusters/${clusterId}/prune`, {
    method: 'POST',
    body: JSON.stringify({ similarity }),
  });
}
