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
};

export type ObjectMemorySample = {
  sample_id: string;
  cluster_id: string;
  created_ts: number;
  track_ids: string[];
  image_path: string;
  telemetry?: Record<string, any>;
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

export async function ingestSample(params: { image: string; track_id?: string; label?: string }): Promise<any> {
  return http('/memory/ingest', {
    method: 'POST',
    body: JSON.stringify(params),
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
