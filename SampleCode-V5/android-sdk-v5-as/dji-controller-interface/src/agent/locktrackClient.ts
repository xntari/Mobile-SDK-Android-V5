export type LockTrackBoxSource = 'detector' | 'heatmap' | 'manual' | 'init' | 'none' | 'fused';

export type LockTrackLockResponse = {
  track_id: string;
  init_box: { x: number; y: number; w: number; h: number };
  score?: number;
  status: 'locked' | 'searching';
  heatmap?: string; // base64 PNG
  num_views?: number;
  box_source?: LockTrackBoxSource;
  detector_track_id?: number | string;
  detector_label?: string;
  detector_score?: number;
  similarity?: number;
  miss_streak?: number;
};

export type LockTrackStepResponse = {
  box: { x: number; y: number; w: number; h: number };
  score: number;
  status: 'tracking' | 'searching' | 'lost';
  heatmap?: string;
  num_views?: number;
  box_source?: LockTrackBoxSource;
  detector_track_id?: number | string;
  detector_label?: string;
  detector_score?: number;
  similarity?: number;
  miss_streak?: number;
  hint_similarity?: number;
  hint_iou?: number;
};

function deriveLocktrackUrl(): string {
  try {
    const raw = localStorage.getItem('settings.endpoints');
    if (raw) {
      const ep = JSON.parse(raw);
      if (ep?.locktrack) return String(ep.locktrack).replace(/\/$/, '') + '/realtime/locktrack';
      if (ep?.visionRealtime) {
        try {
          const u = new URL(ep.visionRealtime);
          // Use same host; change port to 9010 and path
          if (!u.port) u.port = u.protocol === 'https:' ? '443' : '9004';
          u.port = '9010';
          u.pathname = u.pathname.replace(/\/realtime\/detect.*/, '/realtime/locktrack');
          return u.toString().replace(/\/$/, '');
        } catch {}
      }
    }
  } catch {}
  return (globalThis as any).__LOCKTRACK_BASE__ || 'http://127.0.0.1:9010/realtime/locktrack';
}

export function getLocktrackBase(): string {
  const b = deriveLocktrackUrl();
  return b.replace(/\/$/, '');
}

export async function lockTrackLock(params: {
  image: string;
  box?: { x: number; y: number; w: number; h: number };
  ref_image?: string;
  return_heatmap?: boolean;
  threshold?: number;
  search_pad?: number;
  scales?: number[];
  image_max_side?: number;
  heatmap_cmap?: string;
  det_track_id?: number | string;
  det_score?: number;
  det_label?: string;
  signal?: AbortSignal;
}): Promise<LockTrackLockResponse> {
  const url = getLocktrackBase() + '/lock';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      image: params.image,
      box: params.box,
      ref_image: params.ref_image,
      return_heatmap: !!params.return_heatmap,
      threshold: params.threshold,
      search_pad: params.search_pad,
      scales: params.scales,
      image_max_side: params.image_max_side,
      heatmap_cmap: params.heatmap_cmap,
      det_track_id: params.det_track_id,
      det_score: params.det_score,
      det_label: params.det_label,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function lockTrackStep(params: {
  track_id: string;
  image: string;
  return_heatmap?: boolean;
  image_max_side?: number;
  heatmap_cmap?: string;
  hint_box?: { x: number; y: number; w: number; h: number };
  hint_track_id?: number | string;
  hint_score?: number;
  hint_label?: string;
  signal?: AbortSignal;
}): Promise<LockTrackStepResponse> {
  const url = getLocktrackBase() + '/step';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      track_id: params.track_id,
      image: params.image,
      return_heatmap: !!params.return_heatmap,
      image_max_side: params.image_max_side,
      heatmap_cmap: params.heatmap_cmap,
      hint_box: params.hint_box,
      hint_track_id: params.hint_track_id,
      hint_score: params.hint_score,
      hint_label: params.hint_label,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function lockTrackAddView(params: {
  track_id: string;
  ref_image?: string;
  image?: string;
  box?: { x: number; y: number; w: number; h: number };
  signal?: AbortSignal;
}): Promise<{ num_views: number; view_id?: number } & Record<string, any>> {
  const url = getLocktrackBase() + '/add_view';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      track_id: params.track_id,
      ref_image: params.ref_image,
      image: params.image,
      box: params.box,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function lockTrackUnlock(track_id: string, signal?: AbortSignal): Promise<{ ack: boolean }> {
  const url = getLocktrackBase() + '/unlock';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ track_id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function lockTrackRemoveView(params: { track_id: string; view_id: number; signal?: AbortSignal }): Promise<{ num_views: number } & Record<string, any>> {
  const url = getLocktrackBase() + '/remove_view';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({ track_id: params.track_id, view_id: params.view_id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
