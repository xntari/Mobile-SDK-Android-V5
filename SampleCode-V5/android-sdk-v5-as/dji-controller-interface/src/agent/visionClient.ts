// Minimal, swappable vision client facade.
// For the POC, we support a single op: open-vocabulary detection.
// Later, this can call a local service (e.g., GroundingDINO) or a cloud VLM.

export type Detection = {
  x1: number; // normalized [0,1]
  y1: number; // normalized [0,1]
  x2: number; // normalized [0,1]
  y2: number; // normalized [0,1]
  score: number; // 0..1
  label?: string;
};

export interface AnalyzeRequest {
  imageBase64: string; // data URL or base64 without prefix
  query: string; // open-vocabulary phrase, e.g., "car"
}

export interface AnalyzeResponse {
  detections: Detection[];
  meta?: { backend: 'http' | 'fallback'; url?: string; httpBoxes?: number; fallbackUsed?: boolean };
}

// Endpoint helpers — read from globals or persisted settings on every call so Settings take effect immediately.
type SavedEndpoints = { visionDetect?: string; visionDescribe?: string; visionGeneral?: string; visionRealtime?: string; planner?: string };
function loadSavedEndpoints(): SavedEndpoints {
  try { const raw = localStorage.getItem('settings.endpoints'); if (raw) return JSON.parse(raw) as SavedEndpoints; } catch {}
  return {};
}
export function getDetectUrl(): string {
  const ep = loadSavedEndpoints();
  return (globalThis as any).__VISION_URL__ || ep.visionDetect || 'http://127.0.0.1:9001/detect';
}
export function getDescribeUrl(): string {
  const ep = loadSavedEndpoints();
  return (globalThis as any).__DESCRIBE_URL__ || ep.visionDescribe || 'http://127.0.0.1:9001/describe';
}
export function getGeneralVisionUrl(): string {
  const ep = loadSavedEndpoints();
  return (globalThis as any).__GENERAL_URL__ || ep.visionGeneral || 'http://127.0.0.1:9003/general/analyze';
}

export function getRealtimeVisionUrl(): string {
  const ep = loadSavedEndpoints();
  return (globalThis as any).__REALTIME_URL__ || ep.visionRealtime || 'http://127.0.0.1:9004/realtime/detect';
}

function getThreshold(): number {
  const v = (globalThis as any).__VISION_THRESHOLD__;
  if (typeof v === 'number' && isFinite(v)) return v;
  return 0.25;
}

export function setActiveThreshold(v: number) {
  (globalThis as any).__VISION_THRESHOLD__ = v;
}

export function getActiveThreshold(): number {
  return getThreshold();
}

async function callHttpDetector(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  try {
    const url = getDetectUrl();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: req.imageBase64, query: req.query, threshold: getThreshold() })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Expect shape: { boxes: [{x1,y1,x2,y2,score,label?}] }
    const boxes = Array.isArray(data?.boxes) ? data.boxes : [];
    const detections: Detection[] = boxes.map((b: any) => ({
      x1: clamp01(b.x1), y1: clamp01(b.y1), x2: clamp01(b.x2), y2: clamp01(b.y2),
      score: Number(b.score ?? 0), label: b.label
    }));
    return { detections, meta: { backend: 'http', url, httpBoxes: boxes.length } };
  } catch (e) {
    // Fallback to empty result; caller may switch strategy
    console.warn('[visionClient] detector call failed, returning empty:', e);
    return { detections: [], meta: { backend: 'http', url: getDetectUrl(), httpBoxes: 0 } };
  }
}

export interface DescribeRequest {
  imageBase64: string;
  labels?: string[];
}

export async function analyzeDescribe(req: DescribeRequest): Promise<AnalyzeResponse> {
  try {
    const url = getDescribeUrl();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: req.imageBase64, labels: req.labels, threshold: getThreshold(), top_k: 50 })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const boxes = Array.isArray(data?.boxes) ? data.boxes : [];
    const detections: Detection[] = boxes.map((b: any) => ({
      x1: clamp01(b.x1), y1: clamp01(b.y1), x2: clamp01(b.x2), y2: clamp01(b.y2),
      score: Number(b.score ?? 0), label: String(b.label || '')
    }));
    return { detections, meta: { backend: 'http', url, httpBoxes: boxes.length } };
  } catch (e) {
    console.warn('[visionClient] describe call failed:', e);
    return { detections: [], meta: { backend: 'http', url: getDescribeUrl(), httpBoxes: 0 } };
  }
}

function clamp01(v: number) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Very small heuristic fallback: return center as a pseudo-detection
function naiveFallback(req: AnalyzeRequest): AnalyzeResponse {
  const label = (req.query || '').toLowerCase();
  if (!label) return { detections: [] };
  // Produce a small box at the center to allow end-to-end testing without a model
  const cx = 0.5, cy = 0.5, w = 0.2, h = 0.2;
  return { detections: [{ x1: cx - w/2, y1: cy - h/2, x2: cx + w/2, y2: cy + h/2, score: 0.1, label: `${label} (fallback)` }], meta: { backend: 'fallback', fallbackUsed: true } };
}

export async function analyzeDetect(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  // Try HTTP detector first; if it yields nothing, fall back to naive with explicit marker.
  const http = await callHttpDetector(req);
  if (http.detections && http.detections.length > 0) return http;
  const fb = naiveFallback(req);
  fb.meta = { ...(fb.meta || {}), httpBoxes: http.meta?.httpBoxes ?? 0, url: http.meta?.url, backend: 'fallback', fallbackUsed: true } as any;
  return fb;
}

// Experimental: YOLO realtime detect (multi-class) via new endpoint
export interface RealtimeDetectRequest {
  imageBase64: string;
  threshold?: number;
  classes?: string[];   // optional allowlist
  img_size?: number;    // optional server downscale control
  signal?: AbortSignal; // optional abort
}

export async function analyzeRealtime(req: RealtimeDetectRequest): Promise<AnalyzeResponse> {
  try {
    const url = getRealtimeVisionUrl();
    // Attach a per-client session header to diagnose duplicate clients
    const sid = (globalThis as any).__VISION_SESSION_ID__ || ((globalThis as any).__VISION_SESSION_ID__ = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Session': String(sid) },
      signal: req.signal,
      // If labels provided, send them as open‑vocab labels for YOLO‑E; otherwise use closed‑vocab YOLO (all classes by default)
      body: JSON.stringify({
        image: req.imageBase64,
        threshold: req.threshold ?? getThreshold(),
        img_size: req.img_size ?? 640,
        ...(Array.isArray(req.classes) && req.classes.length > 0
          ? { ov_labels: req.classes }
          : {})
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const boxes = Array.isArray(data?.boxes) ? data.boxes : [];
    const detections: Detection[] = boxes.map((b: any) => ({
      x1: clamp01(b.x1), y1: clamp01(b.y1), x2: clamp01(b.x2), y2: clamp01(b.y2),
      score: Number(b.score ?? 0), label: b.label ? String(b.label) : undefined
    }));
    return { detections, meta: { backend: 'http', url, httpBoxes: boxes.length } };
  } catch (e) {
    console.warn('[visionClient] realtime detect call failed:', e);
    return { detections: [], meta: { backend: 'http', url: getRealtimeVisionUrl(), httpBoxes: 0 } };
  }
}

// Segmentation types and client
export type Mask = {
  points: Array<{ x: number; y: number }>; // normalized [0,1]
  score?: number;
  label?: string;
};

export interface RealtimeSegmentRequest {
  imageBase64: string;
  threshold?: number;
  img_size?: number;
  classes?: string[]; // optional labels (open-vocab segmentation)
}

export async function analyzeRealtimeSegment(req: RealtimeSegmentRequest & { signal?: AbortSignal }): Promise<{ masks: Mask[]; meta?: any }> {
  try {
    const url = getRealtimeVisionUrl().replace('/realtime/detect', '/realtime/segment');
    const sid = (globalThis as any).__VISION_SESSION_ID__ || ((globalThis as any).__VISION_SESSION_ID__ = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Session': String(sid) },
      signal: (req as any).signal,
      body: JSON.stringify({
        image: req.imageBase64,
        threshold: req.threshold ?? getThreshold(),
        img_size: req.img_size ?? 640,
        ...(Array.isArray(req.classes) && req.classes.length > 0 ? { ov_labels: req.classes } : {})
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const instances = Array.isArray(data?.instances) ? data.instances : [];
    const masks: Mask[] = instances.map((ins: any) => ({
      points: Array.isArray(ins.points) ? ins.points.map((p: any) => ({ x: clamp01(p.x), y: clamp01(p.y) })) : [],
      score: typeof ins.score === 'number' ? ins.score : undefined,
      label: typeof ins.label === 'string' ? ins.label : undefined
    })).filter((m: Mask) => m.points.length >= 3);
    return { masks, meta: { backend: 'http', url } };
  } catch (e) {
    console.warn('[visionClient] realtime segment call failed:', e);
    return { masks: [], meta: { backend: 'http' } };
  }
}

// Oriented object detection
export type OrientedBox = { points: Array<{ x:number; y:number }>; score?: number; label?: string };
export async function analyzeRealtimeObb(imageBase64: string, threshold?: number, img_size?: number, classes?: string[], signal?: AbortSignal): Promise<{ obb: OrientedBox[]; meta?: any }> {
  try {
    const base = getRealtimeVisionUrl().replace('/realtime/detect', '/realtime/obb');
    const res = await fetch(base, { method:'POST', headers:{'Content-Type':'application/json'}, signal, body: JSON.stringify({ image: imageBase64, threshold: threshold ?? getThreshold(), img_size: img_size ?? 640, classes }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const obb: OrientedBox[] = Array.isArray(data?.obb) ? data.obb : [];
    return { obb, meta: { backend: 'http', url: base } };
  } catch (e) {
    console.warn('[visionClient] realtime obb call failed:', e);
    return { obb: [], meta: { backend: 'http' } };
  }
}

// Pose endpoint
export interface PoseKeypoint { x: number; y: number; conf?: number }
export interface Pose { keypoints: PoseKeypoint[] }
export async function analyzeRealtimePose(imageBase64: string, img_size?: number, signal?: AbortSignal): Promise<{ poses: Pose[]; meta?: any }> {
  try {
    const base = getRealtimeVisionUrl().replace('/realtime/detect', '/realtime/pose');
    const res = await fetch(base, { method:'POST', headers:{'Content-Type':'application/json'}, signal, body: JSON.stringify({ image: imageBase64, img_size: img_size ?? 640 }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const poses: Pose[] = Array.isArray(data?.poses) ? data.poses : [];
    return { poses, meta: { backend: 'http', url: base } };
  } catch (e) {
    console.warn('[visionClient] realtime pose call failed:', e);
    return { poses: [], meta: { backend: 'http' } };
  }
}

// Classification endpoint
export interface ClassProb { label: string; score: number }
export async function analyzeRealtimeClassify(imageBase64: string, top_k: number = 5, img_size?: number, signal?: AbortSignal): Promise<{ classes: ClassProb[]; meta?: any }> {
  try {
    const base = getRealtimeVisionUrl().replace('/realtime/detect', '/realtime/classify');
    const res = await fetch(base, { method:'POST', headers:{'Content-Type':'application/json'}, signal, body: JSON.stringify({ image: imageBase64, top_k, img_size: img_size ?? 640 }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const classes: ClassProb[] = Array.isArray(data?.classes) ? data.classes : [];
    return { classes, meta: { backend: 'http', url: base } };
  } catch (e) {
    console.warn('[visionClient] realtime classify call failed:', e);
    return { classes: [], meta: { backend: 'http' } };
  }
}
