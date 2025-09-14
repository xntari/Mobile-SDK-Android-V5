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

// Configurable endpoint via env or default localhost. Renderer may not have process.env;
// allow override via global.
const DEFAULT_ENDPOINT = (globalThis as any).__VISION_URL__ || 'http://127.0.0.1:9001/detect';
const DESCRIBE_ENDPOINT = (globalThis as any).__DESCRIBE_URL__ || 'http://127.0.0.1:9001/describe';

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
    const res = await fetch(DEFAULT_ENDPOINT, {
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
    return { detections, meta: { backend: 'http', url: DEFAULT_ENDPOINT, httpBoxes: boxes.length } };
  } catch (e) {
    // Fallback to empty result; caller may switch strategy
    console.warn('[visionClient] detector call failed, returning empty:', e);
    return { detections: [], meta: { backend: 'http', url: DEFAULT_ENDPOINT, httpBoxes: 0 } };
  }
}

export interface DescribeRequest {
  imageBase64: string;
  labels?: string[];
}

export async function analyzeDescribe(req: DescribeRequest): Promise<AnalyzeResponse> {
  try {
    const res = await fetch(DESCRIBE_ENDPOINT, {
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
    return { detections, meta: { backend: 'http', url: DESCRIBE_ENDPOINT, httpBoxes: boxes.length } };
  } catch (e) {
    console.warn('[visionClient] describe call failed:', e);
    return { detections: [], meta: { backend: 'http', url: DESCRIBE_ENDPOINT, httpBoxes: 0 } };
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
