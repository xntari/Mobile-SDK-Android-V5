import React from 'react';
import { Panel, createPanelControls } from './Panel';
import { analyzeRealtime, analyzeRealtimeSegment, getRealtimeVisionUrl } from '../agent/visionClient';
import { lockTrackLock, lockTrackStep, lockTrackAddView, lockTrackUnlock, lockTrackRemoveView, getLocktrackBase } from '../agent/locktrackClient';
import {
  ingestSample as ingestObjectMemorySample,
  searchSample as searchObjectMemorySample,
  listClusters,
  getCluster,
  fetchSampleImage,
  type ObjectMemoryCluster,
  type ObjectMemorySample,
  type SampleTelemetryPayload,
} from '../agent/objectMemoryClient';
import type { Detection } from '../agent/visionClient';
import { bridgeManager } from '../bridgeManager';
import { projectRayToGroundNormalized, geographicToENU, type GeographicPoint } from '../utils/rayProjection';
import type { TelemetryData } from '../types';

export const visionRTPanelControls = createPanelControls('visionrt.panel', 'visionrtPanelVisibilityChange');

const MAX_LOCKTRACK_VIEWS = 5;
const MAX_HISTORY_ENTRIES = 24;
const MEMORY_INGEST_INTERVAL_MS = 2000;
const MEMORY_LABEL_THRESHOLD = 0.82;

type NormalizedBox = { x: number; y: number; w: number; h: number };

async function cropImageToBox(imageDataUrl: string, box: NormalizedBox): Promise<string | null> {
  if (!imageDataUrl) return null;
  const norm = {
    x: clamp01Value(box.x ?? 0),
    y: clamp01Value(box.y ?? 0),
    w: clamp01Value(box.w ?? 1),
    h: clamp01Value(box.h ?? 1),
  };
  if (norm.w <= 0 || norm.h <= 0) return null;
  return await new Promise<string | null>((resolve) => {
    const imgEl = new Image();
    imgEl.onload = () => {
      try {
        const sx = Math.max(0, Math.floor(norm.x * imgEl.width));
        const sy = Math.max(0, Math.floor(norm.y * imgEl.height));
        const sw = Math.max(1, Math.floor(norm.w * imgEl.width));
        const sh = Math.max(1, Math.floor(norm.h * imgEl.height));
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL('image/jpeg', 0.95));
      } catch (err) {
        console.warn('[VisionRT] thumbnail crop failed:', err);
        resolve(null);
      }
    };
    imgEl.onerror = () => resolve(null);
    imgEl.src = imageDataUrl;
  });
}

type LaserResultListener = (payload: any) => void;
const objectMapLaserListeners = new Set<LaserResultListener>();
let objectMapLaserBridgeHooked = false;

function registerLaserResultListener(listener: LaserResultListener): () => void {
  objectMapLaserListeners.add(listener);
  if (!objectMapLaserBridgeHooked && typeof window !== 'undefined' && window.electronAPI?.onBridgeData) {
    window.electronAPI.onBridgeData((data: any) => {
      if (data?.type === 'camera_laser_result') {
        objectMapLaserListeners.forEach((cb) => {
          try {
            cb(data);
          } catch (err) {
            console.warn('[ObjectMap] laser listener error:', err);
          }
        });
      }
    });
    objectMapLaserBridgeHooked = true;
  }
  return () => {
    objectMapLaserListeners.delete(listener);
  };
}

const parseMaybeNumber = (value: any): number | null => {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    if (!Number.isNaN(n) && isFinite(n)) return n;
  }
  return null;
};

const extractLocation3D = (payload: any): { latitude: number; longitude: number; altitude?: number } | null => {
  if (!payload || typeof payload !== 'object') return null;
  const loc = payload.location3d || payload.location3D || payload.location_3d || payload.waypoint;
  if (!loc || typeof loc !== 'object') return null;
  const latitude = parseMaybeNumber(loc.latitude ?? loc.lat ?? loc.latitude_deg ?? loc.latDegrees);
  const longitude = parseMaybeNumber(loc.longitude ?? loc.lon ?? loc.longitude_deg ?? loc.lonDegrees);
  const altitude = parseMaybeNumber(loc.altitude ?? loc.alt ?? loc.altitude_m ?? loc.altitudeMeters ?? loc.alt_m ?? loc.height);
  if (latitude === null || longitude === null) return null;
  return {
    latitude,
    longitude,
    ...(altitude !== null ? { altitude } : {}),
  };
};

const extractScreenPoint = (payload: any): { x: number; y: number } | null => {
  if (!payload || typeof payload !== 'object') return null;
  const pt = payload.screen_point || payload.screenPoint || payload.screen_point_norm || payload.screenPointNorm || payload.target_point;
  if (!pt || typeof pt !== 'object') return null;
  let x = parseMaybeNumber(pt.x ?? pt.u ?? pt.col ?? pt.column ?? pt.cx);
  let y = parseMaybeNumber(pt.y ?? pt.v ?? pt.row ?? pt.r ?? pt.cy);
  if (x === null || y === null) return null;
  if (Math.abs(x) > 1) x = x / 100;
  if (Math.abs(y) > 1) y = y / 100;
  x = clamp01Value(x);
  y = clamp01Value(y);
  return { x, y };
};

interface LockReferenceInfo {
  trackId?: number | string;
  label?: string;
  baseLabel?: string;
  score?: number;
  box?: NormalizedBox;
  historyId?: string;
  customLabel?: string;
}

interface LockHistoryRecord {
  historyId: string;
  trackIds: Set<string>;
  baseLabel?: string;
  label?: string;
  customLabel?: string;
  lastBox?: NormalizedBox;
  lastUpdated: number;
}

const clamp01Value = (v: number) => Math.max(0, Math.min(1, v));

const sanitizeLabel = (label?: string | null): string | undefined => {
  if (!label) return undefined;
  return String(label).replace(/_[0-9]+$/, '');
};

const detectionToBox = (det: Detection): NormalizedBox => {
  const x1 = clamp01Value(det.x1);
  const y1 = clamp01Value(det.y1);
  const x2 = clamp01Value(det.x2);
  const y2 = clamp01Value(det.y2);
  const w = clamp01Value(x2 - x1);
  const h = clamp01Value(y2 - y1);
  return {
    x: x1,
    y: y1,
    w: Math.max(1e-4, w),
    h: Math.max(1e-4, h),
  };
};

const iouBoxes = (a?: NormalizedBox | null, b?: NormalizedBox | null): number => {
  if (!a || !b) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const aArea = Math.max(0, a.w) * Math.max(0, a.h);
  const bArea = Math.max(0, b.w) * Math.max(0, b.h);
  const union = aArea + bArea - inter;
  return union > 0 ? inter / union : 0;
};

const selectDetectionForHint = (
  detections: Detection[],
  reference: LockReferenceInfo | null,
  fallbackBox: NormalizedBox | null,
  minIou = 0.1,
): Detection | null => {
  if (!detections.length) return null;
  const refTrack = reference?.trackId;
  if (refTrack !== undefined && refTrack !== null) {
    const match = detections.find((det) => det.track_id !== undefined && String(det.track_id) === String(refTrack));
    if (match) return match;
  }
  const targetBox = fallbackBox || reference?.box || null;
  if (!targetBox) return null;
  let best: Detection | null = null;
  let bestIou = 0;
  for (const det of detections) {
    const box = detectionToBox(det);
    const iou = iouBoxes(targetBox, box);
    if (iou > bestIou) {
      bestIou = iou;
      best = det;
    }
  }
  if (best && bestIou >= minIou) {
    return best;
  }
  return null;
};

interface LockTrackView {
  id: number;
  thumb: string;
}

export interface VisionRealtimePanelProps {
  getSnapshot: () => Promise<string>;
  setBoxes?: (boxes: Array<{ x1:number; y1:number; x2:number; y2:number; score:number; label?:string }>) => void;
  setMasks?: (masks: Array<{ points: Array<{x:number;y:number}>; score?: number; label?: string }>) => void;
  setPoses?: (poses: Array<Array<{x:number;y:number;conf?:number}>>) => void;
  setMaskOpacity?: (v:number)=>void;
  setColorizeById?: (v:boolean)=>void;
  setDetectThickness?: (v:number)=>void;
  setHeatmap?: (dataUrl: string | null) => void;
  setHeatmapOpacity?: (v:number)=>void;
}

interface LockTrackSectionProps {
  getSnapshot: () => Promise<string>;
  setBoxes?: (boxes: Array<{ x1:number; y1:number; x2:number; y2:number; score:number; label?:string }>) => void;
  lastDetections: Detection[];
  setLastDetections: React.Dispatch<React.SetStateAction<Detection[]>>;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  promptImage: string | null;
  setPromptImage: React.Dispatch<React.SetStateAction<string | null>>;
  promptInfo: string;
  setPromptInfo: React.Dispatch<React.SetStateAction<string>>;
  setHeatmap?: (dataUrl: string | null) => void;
  setHeatmapOpacity?: (value: number) => void;
  imgSize: number;
  abortRef: React.MutableRefObject<AbortController | null>;
  views: LockTrackView[];
  setViews: React.Dispatch<React.SetStateAction<LockTrackView[]>>;
}

const LockTrackSection: React.FC<LockTrackSectionProps> = ({
  getSnapshot,
  setBoxes,
  lastDetections,
  setLastDetections,
  selectedIndex,
  setSelectedIndex,
  promptImage,
  setPromptImage,
  promptInfo,
  setPromptInfo,
  setHeatmap,
  setHeatmapOpacity,
  imgSize,
  abortRef,
  views,
  setViews,
}) => {
  const [trackId, setTrackId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>('idle');
  React.useEffect(() => {
    console.log('[LockTrack] trackId changed', trackId);
  }, [trackId]);
  const [showHeatmap, setShowHeatmap] = React.useState<boolean>(() => { try { const raw = localStorage.getItem('locktrack.showHeatmap'); if (raw) return JSON.parse(raw); } catch {} return false; });
  const [thrLT, setThrLT] = React.useState<number>(() => { try { const raw = localStorage.getItem('locktrack.threshold'); if (raw) return JSON.parse(raw); } catch {} return 0.65; });
  const [pad, setPad] = React.useState<number>(() => { try { const raw = localStorage.getItem('locktrack.searchPad'); if (raw) return JSON.parse(raw); } catch {} return 0; });
  const [scalesText, setScalesText] = React.useState<string>(() => { try { const raw = localStorage.getItem('locktrack.scales'); if (raw) return String(raw); } catch {} return '0.85,1.0,1.2'; });
  const [lastBox, setLastBox] = React.useState<{x:number;y:number;w:number;h:number} | null>(null);
  const [lastHeatmap, setLastHeatmap] = React.useState<string | null>(null);
  const [lockRef, setLockRef] = React.useState<LockReferenceInfo | null>(null);
  const [lastBoxSource, setLastBoxSource] = React.useState<string | null>(null);
  const [ltClassesText, setLtClassesText] = React.useState<string>(()=>{ try { return localStorage.getItem('locktrack.labels') || ''; } catch {} return ''; });
  const [ltScanThr, setLtScanThr] = React.useState<number>(()=>{ try { const raw = localStorage.getItem('locktrack.scanThr'); if (raw) return JSON.parse(raw); } catch {} return 0.25; });
  const [maxSide, setMaxSide] = React.useState<number>(()=>{ try { const raw = localStorage.getItem('locktrack.maxSide'); if (raw) return JSON.parse(raw); } catch {} return 0; });
  const [trackMode, setTrackMode] = React.useState<'free_look'|'look_at'>(()=>{ try { return (localStorage.getItem('locktrack.trackMode') as any) || 'free_look'; } catch {} return 'free_look'; });
  const [vxGain, setVxGain] = React.useState<number>(()=>{ try { const v = JSON.parse(localStorage.getItem('locktrack.vxGain')||'1.0'); if (typeof v==='number') return v; } catch {} return 1.0; });
  const [deadZone, setDeadZone] = React.useState<number>(()=>{ try { const v = JSON.parse(localStorage.getItem('locktrack.deadZone')||'0.05'); if (typeof v==='number') return v; } catch {} return 0.05; });
  const [customLabelInput, setCustomLabelInput] = React.useState<string>('');
  const freeLookStartedRef = React.useRef<boolean>(false);
  const freeLookVelocityRef = React.useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });
  const freeLookIntervalRef = React.useRef<number | null>(null);
  const freeLookStopTimerRef = React.useRef<number | null>(null);
  const lookAtCooldownRef = React.useRef<number>(0);
  const FREE_LOOK_UPDATE_MS = Math.round(1000 / 15);
  const FREE_LOOK_STEP_TIMEOUT_MS = 700;
  const [hmCmap, setHmCmap] = React.useState<string>(()=>{ try { return localStorage.getItem('locktrack.hmCmap') || 'jet'; } catch {} return 'jet'; });
  const [hmOpacity, setHmOpacity] = React.useState<number>(()=>{ try { const v = JSON.parse(localStorage.getItem('locktrack.hmOpacity')||'0.35'); if (typeof v==='number') return v; } catch {} return 0.35; });
  const trackingActiveRef = React.useRef<boolean>(false);
  const [trackingActive, setTrackingActive] = React.useState<boolean>(false);
  const lockHistoryRef = React.useRef<Map<string, LockHistoryRecord>>(new Map());
  const lockHistoryByDetIdRef = React.useRef<Map<string, string>>(new Map());
  const lastMemoryIngestRef = React.useRef<number>(0);


  const clamp01 = React.useCallback((v: number) => Math.max(0, Math.min(1, v)), []);

  const linkDetTrackId = React.useCallback((record: LockHistoryRecord, trackId?: number | string | null) => {
    if (trackId === undefined || trackId === null) return;
    const key = String(trackId);
    if (!record.trackIds.has(key)) {
      record.trackIds.add(key);
    }
    lockHistoryByDetIdRef.current.set(key, record.historyId);
  }, []);

  const pruneHistory = React.useCallback(() => {
    const map = lockHistoryRef.current;
    if (map.size <= MAX_HISTORY_ENTRIES) return;
    const entries = Array.from(map.values()).sort((a, b) => a.lastUpdated - b.lastUpdated);
    const removeCount = Math.max(0, map.size - MAX_HISTORY_ENTRIES);
    for (let i = 0; i < removeCount; i += 1) {
      const rec = entries[i];
      map.delete(rec.historyId);
      for (const tid of rec.trackIds) {
        if (lockHistoryByDetIdRef.current.get(tid) === rec.historyId) {
          lockHistoryByDetIdRef.current.delete(tid);
        }
      }
    }
  }, []);

  const mutateHistory = React.useCallback((historyId: string, mutator: (rec: LockHistoryRecord) => void) => {
    const rec = lockHistoryRef.current.get(historyId);
    if (!rec) return;
    mutator(rec);
    rec.lastUpdated = Date.now();
  }, []);

  const rememberHistoryRecord = React.useCallback((record: LockHistoryRecord) => {
    lockHistoryRef.current.set(record.historyId, record);
    record.lastUpdated = Date.now();
    for (const tid of record.trackIds) {
      lockHistoryByDetIdRef.current.set(tid, record.historyId);
    }
    pruneHistory();
  }, [pruneHistory]);

  const applyHistoryToDetections = React.useCallback((detections: Detection[]): Detection[] => {
    if (!detections.length) return detections;
    const historyMap = lockHistoryRef.current;
    if (!historyMap.size) return detections;
    const result: Detection[] = [];
    for (const det of detections) {
      let record: LockHistoryRecord | undefined;
      if (det.track_id !== undefined && det.track_id !== null) {
        const hid = lockHistoryByDetIdRef.current.get(String(det.track_id));
        if (hid) {
          record = historyMap.get(hid);
        }
      }
      if (!record) {
        let best: LockHistoryRecord | undefined;
        let bestIou = 0;
        const detBox = detectionToBox(det);
        for (const rec of historyMap.values()) {
          if (!rec.lastBox) continue;
          const iou = iouBoxes(rec.lastBox, detBox);
          if (iou > bestIou) {
            bestIou = iou;
            best = rec;
          }
        }
        if (best && best.lastBox && bestIou >= 0.35) {
          record = best;
        }
      }

      let nextDet = det;
      if (record) {
        const detBox = detectionToBox(det);
        mutateHistory(record.historyId, (rec) => {
          rec.lastBox = detBox;
          linkDetTrackId(rec, det.track_id);
          if (!rec.label && det.label) {
            rec.label = det.label;
          }
        });
        const label = record.customLabel ?? record.label ?? record.baseLabel ?? det.label;
        if (label && label !== det.label) {
          nextDet = { ...det, label };
        }
      }
      result.push(nextDet);
    }
    return result;
  }, [linkDetTrackId, mutateHistory]);

  const ingestObjectMemory = React.useCallback(async (dataUrl: string | null, trackHint?: string | number | null, labelHint?: string | null) => {
    if (!dataUrl) return;
    try {
      await ingestObjectMemorySample({
        image: dataUrl,
        track_id: trackHint != null ? String(trackHint) : undefined,
        ...(labelHint && labelHint.trim() ? { label: labelHint.trim() } : {}),
      });
    } catch (err) {
      console.warn('[LockTrack] object memory ingest failed:', err);
    }
  }, []);

  const createThumbFromBox = React.useCallback((imageDataUrl: string, box: { x: number; y: number; w: number; h: number }): Promise<string | null> => {
    return cropImageToBox(imageDataUrl, {
      x: box.x ?? 0,
      y: box.y ?? 0,
      w: box.w ?? 1,
      h: box.h ?? 1,
    });
  }, []);

  React.useEffect(() => {
    if (!trackId) {
      if (trackingActiveRef.current) {
        trackingActiveRef.current = false;
        setTrackingActive(false);
      }
      setLockRef(null);
      setLastBoxSource(null);
      setCustomLabelInput('');
    }
  }, [trackId]);

  React.useEffect(() => {
    if (!lockRef?.historyId) return;
    setCustomLabelInput(lockRef.customLabel ?? lockRef.label ?? lockRef.baseLabel ?? '');
  }, [lockRef?.historyId]);

  React.useEffect(() => () => {
    trackingActiveRef.current = false;
  }, []);

  const delay = React.useCallback((ms: number) => new Promise(resolve => setTimeout(resolve, ms)), []);

  const sendBridge = React.useCallback(async (command: any) => {
    try {
      const res = await bridgeManager.sendBridgeCommand(command);
      return res;
    } catch (err) {
      console.warn('[LockTrack] bridge send failed:', err);
      return { success: false, error: String(err) };
    }
  }, []);

  const clearFreeLookInterval = React.useCallback(() => {
    if (freeLookIntervalRef.current !== null) {
      window.clearInterval(freeLookIntervalRef.current);
      freeLookIntervalRef.current = null;
    }
  }, []);

  const stopFreeLookSession = React.useCallback(async () => {
    if (!freeLookStartedRef.current) return;
    freeLookStartedRef.current = false;
    clearFreeLookInterval();
    if (freeLookStopTimerRef.current !== null) {
      window.clearTimeout(freeLookStopTimerRef.current);
      freeLookStopTimerRef.current = null;
    }
    try {
      const res = await sendBridge({ type: 'gimbal_free_look_stop' });
      if (res && res.success === false) {
        console.warn('[LockTrack] free-look stop reported failure:', res.error);
      }
    } catch (err) {
      console.warn('[LockTrack] free-look stop failed:', err);
    }
  }, [clearFreeLookInterval, sendBridge]);

  const ensureFreeLookSession = React.useCallback(async (): Promise<boolean> => {
    if (freeLookStartedRef.current) {
      return true;
    }
    try {
      const res = await sendBridge({ type: 'gimbal_free_look_start', data: { source: 'locktrack' } });
      if (res && res.success === false) {
        console.warn('[LockTrack] free-look start reported failure:', res.error);
        freeLookStartedRef.current = false;
        return false;
      }
      freeLookStartedRef.current = true;
    } catch (err) {
      console.warn('[LockTrack] free-look start failed:', err);
      freeLookStartedRef.current = false;
      return false;
    }
    if (freeLookIntervalRef.current === null) {
      freeLookIntervalRef.current = window.setInterval(() => {
        if (!freeLookStartedRef.current) return;
        const { vx, vy } = freeLookVelocityRef.current;
        sendBridge({ type: 'gimbal_free_look_update', data: { vx, vy } }).then((res) => {
          if (res && res.success === false) {
            console.warn('[LockTrack] free-look update reported failure:', res.error);
          }
        }).catch((err: unknown) => {
          console.warn('[LockTrack] free-look update failed:', err);
        });
      }, FREE_LOOK_UPDATE_MS);
    }
    return true;
  }, [FREE_LOOK_UPDATE_MS, sendBridge]);

  const scheduleFreeLookStop = React.useCallback((delayMs: number) => {
    if (freeLookStopTimerRef.current !== null) {
      window.clearTimeout(freeLookStopTimerRef.current);
    }
    freeLookStopTimerRef.current = window.setTimeout(() => {
      freeLookVelocityRef.current = { vx: 0, vy: 0 };
      void stopFreeLookSession();
    }, Math.max(150, delayMs));
  }, [stopFreeLookSession]);

  React.useEffect(() => {
    if (trackMode !== 'free_look') {
      freeLookVelocityRef.current = { vx: 0, vy: 0 };
      void stopFreeLookSession();
    }
  }, [trackMode, stopFreeLookSession]);

  React.useEffect(() => () => { void stopFreeLookSession(); }, [stopFreeLookSession]);

  const doScan = async () => {
    try {
      const img = await getSnapshot();
      const scanClasses = ltClassesText.split(/\n|,|;/).map(s=>s.trim()).filter(Boolean).slice(0, 50);
      const out = await analyzeRealtime({ imageBase64: img, threshold: ltScanThr, classes: scanClasses, img_size: imgSize, signal: abortRef.current?.signal });
      const det = applyHistoryToDetections(out.detections || []);
      setBoxes?.(det);
      setLastDetections(det);
      setPromptInfo(`scan: ${det.length} objects (thr=${ltScanThr.toFixed(2)}, imgsz=${imgSize})`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] locktrack scan failed:', e);
      setPromptInfo(`scan error: ${msg}`);
    }
  };

  const makePreview = async () => {
    try {
      if (selectedIndex < 0 || selectedIndex >= lastDetections.length) return;
      const img = await getSnapshot();
      const base = new Image();
      await new Promise((resolve, reject)=>{ base.onload=resolve as any; base.onerror=reject as any; base.src=img; });
      const d = lastDetections[selectedIndex];
      const x1 = Math.max(0, Math.min(1, d.x1));
      const y1 = Math.max(0, Math.min(1, d.y1));
      const x2 = Math.max(0, Math.min(1, d.x2));
      const y2 = Math.max(0, Math.min(1, d.y2));
      const W = base.width, H = base.height;
      const sx = Math.floor(x1*W), sy = Math.floor(y1*H), sw = Math.max(1, Math.floor((x2-x1)*W)), sh = Math.max(1, Math.floor((y2-y1)*H));
      const can = document.createElement('canvas');
      can.width = sw; can.height = sh;
      const ctx = can.getContext('2d'); if (!ctx) throw new Error('2D context');
      ctx.drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh);
      const url = can.toDataURL('image/jpeg', 0.95);
      setPromptImage(url);
      setPromptInfo(`Extracted ${sw}x${sh} at (${sx},${sy})`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] locktrack preview failed:', e);
      setPromptInfo(`extract error: ${msg}`);
    }
  };

  const doLock = async () => {
    try {
      console.log('[LockTrack] Lock: capturing snapshot');
      const img = await getSnapshot();
      let ref_image: string | undefined;
      let box: NormalizedBox | undefined;
      let detectorInfo: LockReferenceInfo | null = null;
      let detTrackId: number | string | undefined;
      let detScore: number | undefined;
      let detLabel: string | undefined;
      if (promptImage) {
        ref_image = promptImage;
      } else {
        if (selectedIndex >= 0 && selectedIndex < lastDetections.length) {
          const d = lastDetections[selectedIndex];
          box = detectionToBox(d);
          detTrackId = d.track_id !== undefined ? d.track_id : undefined;
          detScore = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : undefined;
          const sanitized = sanitizeLabel(d.label);
          detLabel = sanitized || (d.label ? String(d.label) : undefined);
          detectorInfo = {
            trackId: detTrackId,
            label: d.label,
            baseLabel: sanitized,
            score: detScore,
            box,
          };
        } else {
          setPromptInfo('Provide a reference: extract or upload an image, or select a detection.');
          return;
        }
      }
      const scales = scalesText.split(/,|\s+/).map((s) => parseFloat(s)).filter((n) => !isNaN(n) && n > 0).slice(0, 5);
      const controller = new AbortController();
      abortRef.current = controller;
      const out = await lockTrackLock({
        image: img,
        ref_image,
        box,
        return_heatmap: showHeatmap,
        threshold: thrLT,
        search_pad: pad,
        scales,
        signal: controller.signal,
        image_max_side: maxSide > 0 ? maxSide : undefined,
        heatmap_cmap: hmCmap,
        det_track_id: detTrackId,
        det_score: detScore,
        det_label: detLabel,
      });
      setTrackId(out.track_id);
      setStatus(out.status || 'locked');
      setLastBoxSource(out.box_source || null);
      const b = out.init_box;
      setLastBox(b);
      const historyId = out.track_id;
      const track = out.detector_track_id ?? detectorInfo?.trackId;
      const baseLabel = sanitizeLabel(out.detector_label ?? detectorInfo?.label ?? undefined) ?? detectorInfo?.baseLabel;
      const label = out.detector_label ?? detectorInfo?.label ?? baseLabel;
      const score = typeof out.detector_score === 'number' && Number.isFinite(out.detector_score)
        ? out.detector_score
        : detectorInfo?.score;
      let inherited: LockHistoryRecord | undefined;
      if (detTrackId !== undefined && detTrackId !== null) {
        const hid = lockHistoryByDetIdRef.current.get(String(detTrackId));
        if (hid) {
          inherited = lockHistoryRef.current.get(hid);
        }
      }
      if (!inherited && box) {
        let best: LockHistoryRecord | undefined;
        let bestIou = 0;
        for (const rec of lockHistoryRef.current.values()) {
          if (!rec.lastBox) continue;
          const iou = iouBoxes(rec.lastBox, box);
          if (iou > bestIou) {
            bestIou = iou;
            best = rec;
          }
        }
        if (best && best.lastBox && bestIou >= 0.4) {
          inherited = best;
        }
      }
      setBoxes?.([{ x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h, score: typeof out.score === 'number' ? out.score : 1.0, label: 'lock' }]);
      let initialThumb: string | null = ref_image || null;
      let memoryMatchLabel: string | undefined;
      if (!initialThumb) {
        if (box) {
          initialThumb = await createThumbFromBox(img, box);
        }
        if (!initialThumb) {
          initialThumb = await createThumbFromBox(img, b);
        }
      }
      if (initialThumb) {
        try {
          const searchRes = await searchObjectMemorySample(initialThumb);
          const match = searchRes?.match;
          if (match && match.cluster && match.similarity >= MEMORY_LABEL_THRESHOLD && match.cluster.label) {
            memoryMatchLabel = match.cluster.label;
          }
        } catch (err) {
          console.warn('[LockTrack] object memory search failed:', err);
        }
      }

      const resolvedLabel = memoryMatchLabel ?? inherited?.label ?? label ?? baseLabel ?? undefined;
      const historyRecord: LockHistoryRecord = {
        historyId,
        trackIds: inherited ? new Set<string>(inherited.trackIds) : new Set<string>(),
        baseLabel: inherited?.baseLabel ?? baseLabel ?? resolvedLabel ?? undefined,
        label: resolvedLabel,
        customLabel: inherited?.customLabel ?? undefined,
        lastBox: b,
        lastUpdated: Date.now(),
      };
      if (inherited) {
        lockHistoryRef.current.delete(inherited.historyId);
        for (const tid of inherited.trackIds) {
          if (lockHistoryByDetIdRef.current.get(tid) === inherited.historyId) {
            lockHistoryByDetIdRef.current.delete(tid);
          }
        }
      }
      linkDetTrackId(historyRecord, track);
      rememberHistoryRecord(historyRecord);
      setCustomLabelInput(historyRecord.customLabel ?? historyRecord.label ?? historyRecord.baseLabel ?? '');
      setLockRef(() => ({
        historyId,
        trackId: track,
        label: historyRecord.label,
        baseLabel: historyRecord.baseLabel,
        customLabel: historyRecord.customLabel,
        score,
        box: b,
      }));
      if (initialThumb) {
        setViews([{ id: 0, thumb: initialThumb }]);
        if (!promptImage) {
          try {
            setPromptImage(initialThumb);
          } catch {}
        }
        const ingestLabel = historyRecord.customLabel ?? historyRecord.label ?? historyRecord.baseLabel ?? null;
        void ingestObjectMemory(initialThumb, track ?? out.track_id ?? historyId, ingestLabel);
      } else {
        setViews([]);
      }
      const infoBits: string[] = [`Lock ${out.status}`];
      if (typeof out.score === 'number' && Number.isFinite(out.score)) infoBits.push(`score ${out.score.toFixed(2)}`);
      if (out.box_source) infoBits.push(`via ${out.box_source}`);
      if (typeof out.similarity === 'number' && Number.isFinite(out.similarity)) infoBits.push(`sim ${out.similarity.toFixed(2)}`);
      if (out.detector_track_id !== undefined && out.detector_track_id !== null) infoBits.push(`det ${out.detector_track_id}`);
      if (typeof out.detector_score === 'number' && Number.isFinite(out.detector_score)) infoBits.push(`detScore ${out.detector_score.toFixed(2)}`);
      if (typeof out.miss_streak === 'number') infoBits.push(`miss ${out.miss_streak}`);
      const viewInfo = typeof out?.num_views === 'number' ? ` (${out.num_views}/${MAX_LOCKTRACK_VIEWS} views)` : '';
      setPromptInfo(`${infoBits.join(', ')}${viewInfo}`);
      console.log('[LockTrack] Lock: server response', out);
      if (showHeatmap && out.heatmap) {
        const hm = `data:image/png;base64,${out.heatmap}`;
        setLastHeatmap(hm);
        setHeatmap?.(hm);
      } else if (!showHeatmap) {
        setHeatmap?.(null);
      }
      if (trackingActiveRef.current) {
        trackingActiveRef.current = false;
        setTrackingActive(false);
      }
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] lock failed:', e);
      setPromptInfo(`lock error: ${msg}`);
    }
  };

  const performStep = React.useCallback(async (origin: 'manual' | 'loop'): Promise<boolean> => {
    if (!trackId) {
      if (origin === 'manual') setPromptInfo('no track_id; Lock-On first');
      return false;
    }

    if (origin === 'manual') {
      console.log('[LockTrack] Step button pressed', { trackId });
      setPromptInfo('step: pressed');
      console.log('[LockTrack] Step: capturing snapshot', { trackId });
    }

    setPromptInfo(`${origin === 'manual' ? 'step' : 'tracking'}: gathering data...`);

    try {
      const img = await getSnapshot();
      const controller = new AbortController();
      abortRef.current = controller;

      let hintDetection: Detection | null = null;
      if (lockRef) {
        try {
          const classes = lockRef.baseLabel ? [lockRef.baseLabel] : undefined;
          const detRes = await analyzeRealtime({
            imageBase64: img,
            threshold: ltScanThr,
            classes,
            img_size: imgSize,
            signal: controller.signal,
          });
          const detections = detRes.detections || [];
          const mappedDetections = applyHistoryToDetections(detections);
          setLastDetections(mappedDetections);
          if (mappedDetections.length) {
            hintDetection = selectDetectionForHint(mappedDetections, lockRef, lastBox);
          }
        } catch (detErr) {
          console.warn('[LockTrack] hint detection failed:', detErr);
        }
      }

      const hintBox = hintDetection ? detectionToBox(hintDetection) : undefined;
      const hintLabel = hintDetection ? sanitizeLabel(hintDetection.label) || hintDetection.label : undefined;

      const out = await lockTrackStep({
        track_id: trackId,
        image: img,
        return_heatmap: showHeatmap,
        signal: controller.signal,
        image_max_side: maxSide > 0 ? maxSide : undefined,
        heatmap_cmap: hmCmap,
        hint_box: hintBox,
        hint_track_id: hintDetection?.track_id,
        hint_score: hintDetection?.score,
        hint_label: hintLabel,
      });

      if (origin === 'manual') {
        console.log('[LockTrack] Step: server response', out);
      }

      const b = out.box;
      setLastBox(b);
      setStatus(out.status);
      setLastBoxSource(out.box_source || null);
      const historyId = lockRef?.historyId ?? trackId;
      const nextBox = b || lockRef?.box || hintBox || undefined;
      const track = out.detector_track_id ?? (hintDetection?.track_id !== undefined ? hintDetection.track_id : lockRef?.trackId);
      const rawLabel = out.detector_label ?? hintDetection?.label ?? lockRef?.label;
      const baseLabel = sanitizeLabel(out.detector_label ?? hintDetection?.label ?? lockRef?.label ?? undefined) ?? lockRef?.baseLabel;
      const nextScore = typeof out.detector_score === 'number' && Number.isFinite(out.detector_score)
        ? out.detector_score
        : hintDetection && typeof hintDetection.score === 'number' && Number.isFinite(hintDetection.score)
          ? hintDetection.score
          : lockRef?.score;
      const existingCustom = lockRef?.customLabel;
      const resolvedLabel = existingCustom && existingCustom.trim()
        ? existingCustom
        : (rawLabel ?? baseLabel ?? undefined);
      setLockRef((prev) => {
        if (!nextBox && !track && !rawLabel && !nextScore) return null;
        return {
          historyId,
          trackId: track,
          label: resolvedLabel,
          baseLabel,
          customLabel: existingCustom,
          score: nextScore,
          box: nextBox,
        };
      });
      if (historyId) {
        mutateHistory(historyId, (rec) => {
          rec.lastBox = nextBox ?? b;
          if (baseLabel) rec.baseLabel = baseLabel;
          if (resolvedLabel) rec.label = resolvedLabel;
          if (existingCustom !== undefined) {
            rec.customLabel = existingCustom && existingCustom.trim() ? existingCustom : undefined;
          }
          linkDetTrackId(rec, track);
          linkDetTrackId(rec, hintDetection?.track_id);
        });
      }
      setBoxes?.([{ x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h, score: out.score, label: 'lock' }]);

      const cx = b.x + b.w * 0.5;
      const cy = b.y + b.h * 0.5;
      let promptExtra = '';

      if (out.status === 'tracking') {
        const now = Date.now();
        if (now - lastMemoryIngestRef.current >= MEMORY_INGEST_INTERVAL_MS) {
          lastMemoryIngestRef.current = now;
          try {
            const boxDataUrl = await createThumbFromBox(img, b);
            if (boxDataUrl) {
              const ingestLabel = existingCustom && existingCustom.trim() ? existingCustom : (resolvedLabel ?? undefined);
              void ingestObjectMemory(boxDataUrl, track ?? lockRef?.trackId ?? trackId, ingestLabel ?? null);
            }
          } catch (err) {
            console.warn('[LockTrack] memory ingest (step) failed:', err);
          }
        }
      }

      if (trackMode === 'look_at') {
        const now = Date.now();
        if (now - lookAtCooldownRef.current < 550) {
          const remain = Math.max(0, 550 - (now - lookAtCooldownRef.current));
          promptExtra = ` (cooldown ${remain.toFixed(0)}ms)`;
        } else {
          try {
            const res = await sendBridge({ type: 'gimbal_tap_target', data: { x: cx, y: cy } });
            if (res && res.success === false) {
              promptExtra = ` (look-at failed: ${res.error || 'bridge error'})`;
            } else {
              lookAtCooldownRef.current = now;
              promptExtra = ' (look-at sent)';
            }
          } catch (err) {
            console.warn('[LockTrack] look-at command failed:', err);
            promptExtra = ' (look-at failed)';
          }
        }
        freeLookVelocityRef.current = { vx: 0, vy: 0 };
        await stopFreeLookSession();
      } else if (trackMode === 'free_look') {
        const dx = cx - 0.5;
        const dy = cy - 0.5;
        const applyDZ = (v: number) => {
          const mag = Math.abs(v);
          if (mag < deadZone) return 0;
          const scaled = v * vxGain * 2;
          return Math.max(-1, Math.min(1, scaled));
        };
        const vx = applyDZ(dx);
        const vy = applyDZ(dy);
        freeLookVelocityRef.current = { vx, vy };
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(vx) > 0 || Math.abs(vy) > 0) {
          const sessionOk = await ensureFreeLookSession();
          if (!sessionOk) {
            promptExtra = ' (free-look start failed)';
          } else {
            try {
              const res = await sendBridge({ type: 'gimbal_free_look_update', data: { vx, vy } });
              if (res && res.success === false) {
                promptExtra = ` (free-look update failed: ${res.error || 'unknown'})`;
              }
            } catch (err) {
              console.warn('[LockTrack] free-look immediate update failed:', err);
              promptExtra = ' (free-look update threw)';
            }
            if (!promptExtra) {
              promptExtra = ` (free-look vx=${vx.toFixed(2)} vy=${vy.toFixed(2)})`;
            }
          }
          const duration = dist > 0.05 ? Math.min(1400, FREE_LOOK_STEP_TIMEOUT_MS + dist * 450) : 400;
          scheduleFreeLookStop(duration);
        } else {
          scheduleFreeLookStop(200);
          promptExtra = ' (centered)';
        }
      }

      const fmt = (v?: number) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : undefined);
      const infoBits: string[] = [
        `${origin === 'manual' ? 'step' : 'tracking'}: ${out.status}`,
      ];
      if (out.box_source) infoBits.push(`via ${out.box_source}`);
      infoBits.push(`score ${fmt(out.score) ?? 'n/a'}`);
      if (typeof out.similarity === 'number' && Number.isFinite(out.similarity)) infoBits.push(`sim ${fmt(out.similarity)}`);
      if (out.detector_track_id !== undefined && out.detector_track_id !== null) infoBits.push(`det ${out.detector_track_id}`);
      if (typeof out.detector_score === 'number' && Number.isFinite(out.detector_score)) infoBits.push(`detScore ${fmt(out.detector_score)}`);
      if (typeof out.miss_streak === 'number') infoBits.push(`miss ${out.miss_streak}`);
      if (hintDetection && hintDetection.track_id !== undefined) infoBits.push(`hint ${hintDetection.track_id}`);
      if (typeof out.hint_similarity === 'number' && Number.isFinite(out.hint_similarity)) infoBits.push(`hintSim ${fmt(out.hint_similarity)}`);
      if (typeof out.hint_iou === 'number' && Number.isFinite(out.hint_iou)) infoBits.push(`hintIoU ${fmt(out.hint_iou)}`);
      setPromptInfo(`${infoBits.join(', ')}${promptExtra}`);

      if (showHeatmap && out.heatmap) {
        const hm = `data:image/png;base64,${out.heatmap}`;
        setLastHeatmap(hm);
        setHeatmap?.(hm);
      } else if (!showHeatmap) {
        setHeatmap?.(null);
      }
      return true;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] step failed:', e);
      setPromptInfo(`${origin === 'manual' ? 'step' : 'tracking'} error: ${msg}`);
      return false;
    }
  }, [
    trackId,
    setPromptInfo,
    getSnapshot,
    lockRef,
    ltScanThr,
    imgSize,
    setLastDetections,
    lastBox,
    showHeatmap,
    maxSide,
    hmCmap,
    setLastBox,
    setStatus,
    setLastBoxSource,
    setLockRef,
    setBoxes,
    applyHistoryToDetections,
    trackMode,
    lookAtCooldownRef,
    stopFreeLookSession,
    sendBridge,
    deadZone,
    vxGain,
    ensureFreeLookSession,
    FREE_LOOK_STEP_TIMEOUT_MS,
    scheduleFreeLookStop,
    setLastHeatmap,
    setHeatmap,
    mutateHistory,
    linkDetTrackId,
  ]);

  const doStep = async () => {
    await performStep('manual');
  };

  const runTrackingLoop = React.useCallback(async () => {
    while (trackingActiveRef.current) {
      const ok = await performStep('loop');
      if (!trackingActiveRef.current) break;
      await delay(ok ? 200 : 500);
    }
  }, [performStep, delay]);

  const toggleTracking = () => {
    if (!trackId) {
      setPromptInfo('no track_id; Lock-On first');
      return;
    }
    if (trackingActiveRef.current) {
      trackingActiveRef.current = false;
      setTrackingActive(false);
      setPromptInfo('tracking stopped');
      try { abortRef.current?.abort(); } catch {}
      void stopFreeLookSession();
    } else {
      trackingActiveRef.current = true;
      setTrackingActive(true);
      setPromptInfo('tracking started');
      runTrackingLoop().catch(err => console.warn('[LockTrack] tracking loop error', err));
    }
  };

  const doAddView = async () => {
    console.log('[LockTrack] AddView button pressed', { trackId, hasPrompt: !!promptImage, hasLastBox: !!lastBox });
    try {
      if (!trackId) { setPromptInfo('no track_id; Lock-On first'); return; }
      if (promptImage) {
        const controller = new AbortController();
        abortRef.current = controller;
        const res = await lockTrackAddView({ track_id: trackId, ref_image: promptImage, signal: controller.signal });
        const newId = typeof res?.view_id === 'number' ? res.view_id : Date.now();
        setViews(prev => {
          const removed = Array.isArray(res?.removed_view_ids) ? new Set(res.removed_view_ids) : null;
          let next = removed ? prev.filter(v => !removed.has(v.id)) : [...prev];
          next = [...next, { id: newId, thumb: promptImage }];
          const target = typeof res?.num_views === 'number' ? res.num_views : MAX_LOCKTRACK_VIEWS;
          while (next.length > target) next.shift();
          while (next.length > MAX_LOCKTRACK_VIEWS) next.shift();
          return next;
        });
        const viewsInfo = typeof res?.num_views === 'number' ? ` (${res.num_views}/${MAX_LOCKTRACK_VIEWS} views)` : '';
        setPromptInfo(`added view (image)${viewsInfo}`);
      } else if (lastBox) {
        const img = await getSnapshot();
        const controller = new AbortController();
        abortRef.current = controller;
        const res = await lockTrackAddView({ track_id: trackId, image: img, box: lastBox, signal: controller.signal });
        const thumb = await createThumbFromBox(img, lastBox);
        const newId = typeof res?.view_id === 'number' ? res.view_id : Date.now();
        if (thumb) {
          setViews(prev => {
            const removed = Array.isArray(res?.removed_view_ids) ? new Set(res.removed_view_ids) : null;
            let next = removed ? prev.filter(v => !removed.has(v.id)) : [...prev];
            next = [...next, { id: newId, thumb }];
            const target = typeof res?.num_views === 'number' ? res.num_views : MAX_LOCKTRACK_VIEWS;
            while (next.length > target) next.shift();
            while (next.length > MAX_LOCKTRACK_VIEWS) next.shift();
            return next;
          });
        } else if (Array.isArray(res?.removed_view_ids)) {
          setViews(prev => prev.filter(v => !res.removed_view_ids.includes(v.id)));
        }
        const viewsInfo = typeof res?.num_views === 'number' ? ` (${res.num_views}/${MAX_LOCKTRACK_VIEWS} views)` : '';
        setPromptInfo(`added view (current box)${viewsInfo}`);
      } else {
        setPromptInfo('provide a reference or lock first');
      }
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] add_view failed:', e);
      setPromptInfo(`add_view error: ${msg}`);
    }
  };

  const handleRemoveView = async (viewId: number) => {
    if (!trackId) { setPromptInfo('no track_id; Lock-On first'); return; }
    if (views.length <= 1) { setPromptInfo('keep at least one view'); return; }
    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await lockTrackRemoveView({ track_id: trackId, view_id: viewId, signal: controller.signal });
      setViews(prev => prev.filter(v => v.id !== viewId));
      const viewsInfo = typeof res?.num_views === 'number' ? ` (${res.num_views}/${MAX_LOCKTRACK_VIEWS} views)` : '';
      setPromptInfo(`removed view${viewsInfo}`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] remove_view failed:', e);
      setPromptInfo(`remove view error: ${msg}`);
    }
  };

  const handleCustomLabelChange = React.useCallback((value: string) => {
    setCustomLabelInput(value);
    const trimmed = value.trim();
    const historyId = lockRef?.historyId;
    setLockRef(prev => {
      if (!prev) return prev;
      const nextCustom = trimmed ? trimmed : undefined;
      if (prev.customLabel === nextCustom) return prev;
      return { ...prev, customLabel: nextCustom };
    });
    if (historyId) {
      mutateHistory(historyId, (rec) => {
        rec.customLabel = trimmed ? trimmed : undefined;
        if (!rec.label && trimmed) {
          rec.label = trimmed;
        }
      });
    }
    setLastDetections(prev => applyHistoryToDetections([...prev]));
  }, [lockRef, setLockRef, mutateHistory, setLastDetections, applyHistoryToDetections]);

  const doUnlock = async () => {
    console.log('[LockTrack] Unlock button pressed', { trackId });
    try {
      if (trackId) {
        const controller = new AbortController();
        abortRef.current = controller;
        await lockTrackUnlock(trackId, controller.signal);
      }
    } catch {}
    setTrackId(null);
    setStatus('idle');
    setLastBox(null);
    setBoxes?.([]);
    setPromptInfo('unlocked');
    setViews([]);
    setLockRef(null);
    setLastDetections([]);
    setLastBoxSource(null);
    setCustomLabelInput('');
    if (trackingActiveRef.current) {
      trackingActiveRef.current = false;
      setTrackingActive(false);
      void stopFreeLookSession();
    }
  };

  const onUploadFile: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (dataUrl) setPromptImage(dataUrl);
    };
    reader.readAsDataURL(file);
    try { e.target.value = ''; } catch {}
  };

  React.useEffect(()=>{ try { localStorage.setItem('locktrack.showHeatmap', JSON.stringify(showHeatmap)); } catch {} }, [showHeatmap]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.threshold', JSON.stringify(thrLT)); } catch {} }, [thrLT]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.searchPad', JSON.stringify(pad)); } catch {} }, [pad]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.scales', scalesText); } catch {} }, [scalesText]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.labels', ltClassesText); } catch {} }, [ltClassesText]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.scanThr', JSON.stringify(ltScanThr)); } catch {} }, [ltScanThr]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.maxSide', JSON.stringify(maxSide)); } catch {} }, [maxSide]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.trackMode', trackMode); } catch {} }, [trackMode]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.vxGain', JSON.stringify(vxGain)); } catch {} }, [vxGain]);
  React.useEffect(()=>{ try { localStorage.setItem('locktrack.deadZone', JSON.stringify(deadZone)); } catch {} }, [deadZone]);

  return (
    <div className="flex flex-col gap-2 relative z-30">
      <div className="text-[10px] text-gray-400">Pick reference: select a detection and Extract, or Upload an image. Then Lock‑On, Step to track, Add View to update descriptor.</div>
      <div className="text-[10px] text-gray-500">Scan uses YOLO with its own threshold and imgsz. Lock/Step run on full snapshot resolution in the LockTrack server.</div>
      <div className="flex items-center gap-2 relative z-40 pointer-events-auto">
        <select className="bg-gray-800 text-xs px-2 py-1 rounded relative z-50 pointer-events-auto" value={selectedIndex} onMouseDown={(e)=>e.stopPropagation()} onChange={(e)=>setSelectedIndex(parseInt(e.target.value))}>
          <option value={-1}>Select object…</option>
          {lastDetections.map((d, i)=> <option key={i} value={i}>{d.label || `obj_${i}`}</option>)}
        </select>
        <button className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" onClick={doScan}>Scan</button>
        <button className="px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-600" onClick={makePreview} disabled={selectedIndex<0}>Extract</button>
        <label className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 cursor-pointer">
          <input type="file" accept="image/*" className="hidden" onChange={onUploadFile} /> Upload image
        </label>
        <button className="px-2 py-1 rounded bg-teal-700 hover:bg-teal-600" onClick={doLock}>Lock‑On</button>
        <button type="button" className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600" onClick={doStep} disabled={!trackId || trackingActive}>Step</button>
        <button
          type="button"
          className={`px-2 py-1 rounded ${trackingActive ? 'bg-orange-700 hover:bg-orange-600' : 'bg-green-700 hover:bg-green-600'}`}
          onClick={toggleTracking}
          disabled={!trackId}
        >
          {trackingActive ? 'Stop Tracking' : 'Track On'}
        </button>
        <button type="button" className="px-2 py-1 rounded bg-amber-700 hover:bg-amber-600" onClick={doAddView} disabled={!trackId}>Add View</button>
        <button type="button" className="px-2 py-1 rounded bg-red-700 hover:bg-red-600" onClick={doUnlock} disabled={!trackId}>Unlock</button>
      </div>
      {promptImage && (
        <div>
          <div className="text-[10px] text-gray-400 mb-1">Prompt image preview</div>
          <img src={promptImage} alt="prompt" className="max-w-full max-h-40 border border-gray-600" />
        </div>
      )}
      {showHeatmap && lastHeatmap && (
        <div>
          <div className="text-[10px] text-gray-400 mb-1">Heatmap (debug)</div>
          <img src={lastHeatmap} alt="heatmap" className="max-w-full max-h-40 border border-gray-600" />
        </div>
      )}
      {views.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] text-gray-400">Views ({views.length}/{MAX_LOCKTRACK_VIEWS})</div>
          <div className="flex flex-wrap gap-2">
            {views.map((view, idx) => (
              <div key={`${view.id}-${idx}`} className="relative border border-gray-600 rounded overflow-hidden">
                <img src={view.thumb} alt={`view-${idx + 1}`} className="w-16 h-16 object-cover" />
                <button
                  type="button"
                  className="absolute top-0 right-0 bg-black bg-opacity-60 text-white text-[10px] px-1"
                  onClick={() => handleRemoveView(view.id)}
                  disabled={views.length <= 1}
                  title={views.length <= 1 ? 'Keep at least one view' : 'Remove view'}
                >
                  ✕
                </button>
                <div className="text-[9px] text-gray-300 text-center w-16">V{idx + 1}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showHeatmap} onChange={(e)=>setShowHeatmap(e.target.checked)} /> show heatmap
        </label>
        <label className="flex items-center gap-2">cmap
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={hmCmap} onChange={(e)=>{ setHmCmap(e.target.value); try { localStorage.setItem('locktrack.hmCmap', e.target.value); } catch {} }}>
            <option value="jet">jet</option>
            <option value="gray">gray</option>
          </select>
        </label>
        <label className="flex items-center gap-1">opacity
          <input type="range" min={0} max={1} step={0.01} value={hmOpacity} onChange={(e)=>{ const v = parseFloat(e.target.value); setHmOpacity(v); setHeatmapOpacity?.(v); try { localStorage.setItem('locktrack.hmOpacity', JSON.stringify(v)); } catch {} }} />
          <span className="text-gray-400">{hmOpacity.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1">scan thr
          <input type="range" min={0.01} max={0.99} step={0.01} value={ltScanThr} onChange={(e)=>setLtScanThr(parseFloat(e.target.value))} />
          <span className="text-gray-400">{ltScanThr.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1">sim thr
          <input type="range" min={0.3} max={0.95} step={0.01} value={thrLT} onChange={(e)=>setThrLT(parseFloat(e.target.value))} />
          <span className="text-gray-400">{thrLT.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1">pad(px)
          <input type="number" min={0} max={2000} step={10} value={pad} onChange={(e)=>setPad(parseInt(e.target.value||'0'))} className="w-20 bg-gray-800 px-2 py-1 rounded" />
        </label>
        <label className="flex items-center gap-1">max side
          <input type="number" min={0} max={1600} step={32} value={maxSide} onChange={(e)=>setMaxSide(parseInt(e.target.value||'0'))} className="w-20 bg-gray-800 px-2 py-1 rounded" />
        </label>
        <label className="flex items-center gap-1">scales
          <input type="text" value={scalesText} onChange={(e)=>setScalesText(e.target.value)} className="w-36 bg-gray-800 px-2 py-1 rounded" />
        </label>
      </div>
      <div className="flex items-center gap-3 mt-1">
        <label className="flex items-center gap-2">track mode
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={trackMode} onChange={(e)=>setTrackMode(e.target.value as any)}>
            <option value="free_look">Free Look (smooth)</option>
            <option value="look_at">Look At (tap)</option>
          </select>
        </label>
        {trackMode === 'free_look' && (
          <>
            <label className="flex items-center gap-1">vx gain
              <input type="range" min={0.1} max={3} step={0.05} value={vxGain} onChange={(e)=>setVxGain(parseFloat(e.target.value))} />
              <span className="text-gray-400">{vxGain.toFixed(2)}</span>
            </label>
            <label className="flex items-center gap-1">dead zone
              <input type="range" min={0} max={0.25} step={0.01} value={deadZone} onChange={(e)=>setDeadZone(parseFloat(e.target.value))} />
              <span className="text-gray-400">{deadZone.toFixed(2)}</span>
            </label>
          </>
        )}
        <span className="text-[10px] text-gray-400">
          status: {status}
          {lastBoxSource ? ` via ${lastBoxSource}` : ''}
          {lockRef?.trackId !== undefined ? ` · det ${lockRef.trackId}` : ''}
          {typeof lockRef?.score === 'number' && Number.isFinite(lockRef.score) ? ` · detScore ${lockRef.score.toFixed(2)}` : ''}
          {lockRef?.customLabel ? ` · label ${lockRef.customLabel}` : lockRef?.label ? ` · label ${lockRef.label}` : ''}
        </span>
        {trackId && (
          <label className="flex items-center gap-1 text-[10px] text-gray-400">
            custom label
            <input
              className="bg-gray-800 text-xs px-2 py-1 rounded w-28"
              value={customLabelInput}
              onChange={(e)=>handleCustomLabelChange(e.target.value)}
              placeholder="name"
            />
          </label>
        )}
      </div>
      {promptInfo && <div className="text-[10px] text-gray-400">{promptInfo}</div>}
      <div className="text-[10px] text-gray-400 mt-2">Labels (optional; used for LockTrack scan; same format as Detect)</div>
      <textarea className="w-full h-20 bg-gray-800 text-gray-200 text-xs p-2 rounded" placeholder={"person\ncar\ntruck"} value={ltClassesText} onChange={(e)=>setLtClassesText(e.target.value)} />
    </div>
  );
};

type ObjectMapStepKey = 'select' | 'detect' | 'measure' | 'ingest';
type ObjectMapStatus = 'pending' | 'running' | 'done' | 'error';

type ObjectMapStep = {
  key: ObjectMapStepKey;
  label: string;
  status: ObjectMapStatus;
  detail?: string;
};

type ObjectMapLogEntry = {
  ts: number;
  message: string;
  level: 'info' | 'success' | 'error';
};

interface ObjectMapSectionProps {
  getSnapshot: () => Promise<string>;
  setBoxes?: (boxes: Detection[]) => void;
  setMasks?: (masks: any[]) => void;
  setPoses?: (poses: any[]) => void;
  clearClassifications: () => void;
  imgSize: number;
  sendBridge: (command: any) => Promise<any>;
  threshold: number;
  createThumbFromBox: (imageDataUrl: string, box: NormalizedBox) => Promise<string | null>;
}

const ObjectMapSection: React.FC<ObjectMapSectionProps> = ({
  getSnapshot,
  setBoxes,
  setMasks,
  setPoses,
  clearClassifications,
  imgSize,
  sendBridge,
  threshold,
  createThumbFromBox,
}) => {
  const [clusters, setClusters] = React.useState<ObjectMemoryCluster[]>([]);
  const [clustersLoading, setClustersLoading] = React.useState<boolean>(false);
  const [selectedId, setSelectedId] = React.useState<string>('');
  const [clusterDetail, setClusterDetail] = React.useState<{ cluster: ObjectMemoryCluster; samples: ObjectMemorySample[] } | null>(null);
  const [previewImage, setPreviewImage] = React.useState<string | null>(null);
  const [detectionPreview, setDetectionPreview] = React.useState<string | null>(null);
  const [logEntries, setLogEntries] = React.useState<ObjectMapLogEntry[]>([]);
  const [steps, setSteps] = React.useState<ObjectMapStep[]>([
    { key: 'select', label: 'Select cluster', status: 'pending' },
    { key: 'detect', label: 'Find object', status: 'pending' },
    { key: 'measure', label: 'Measure range', status: 'pending' },
    { key: 'ingest', label: 'Save sample', status: 'pending' },
  ]);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [detection, setDetection] = React.useState<Detection | null>(null);
  const [detectionBox, setDetectionBox] = React.useState<NormalizedBox | null>(null);
  const [snapshotData, setSnapshotData] = React.useState<string | null>(null);
  const [imageDims, setImageDims] = React.useState<{ width: number; height: number } | null>(null);
  const [measurement, setMeasurement] = React.useState<{
    distance?: number;
    raw?: any;
    ts?: number;
    coords?: { latitude: number; longitude: number; altitude?: number };
    screen?: { x: number; y: number };
    origin?: {
      location?: { latitude: number; longitude: number; altitude?: number };
      attitude?: { roll?: number; pitch?: number; yaw?: number };
      gimbal?: { roll?: number; pitch?: number; yaw?: number };
    };
  } | null>(null);
  const [targetPoint, setTargetPoint] = React.useState<GeographicPoint | null>(null);
  const [targetEnu, setTargetEnu] = React.useState<{ east: number; north: number; up: number } | null>(null);
  const [promptsUsed, setPromptsUsed] = React.useState<string[]>([]);
  const [metaLabelsUsed, setMetaLabelsUsed] = React.useState<string[]>([]);
  const [latestTelemetry, setLatestTelemetry] = React.useState<TelemetryData | null>(() => bridgeManager.getState().bridgeData.telemetry);
  const measurementTimeoutRef = React.useRef<number | null>(null);
  const stepsRef = React.useRef<ObjectMapStep[]>(steps);
  const detectionBoxRef = React.useRef<NormalizedBox | null>(null);
  const imageDimsRef = React.useRef<{ width: number; height: number } | null>(null);
  const telemetryRef = React.useRef<TelemetryData | null>(latestTelemetry);
  const detectionRef = React.useRef<Detection | null>(null);
  const promptsRef = React.useRef<string[]>(promptsUsed);
  const metaLabelsRef = React.useRef<string[]>(metaLabelsUsed);

  const pushLog = React.useCallback((message: string, level: 'info' | 'success' | 'error' = 'info') => {
    setLogEntries((prev) => [{ ts: Date.now(), message, level }, ...prev].slice(0, 60));
  }, []);

  const formatOffsetValue = React.useCallback((value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    const normalized = Math.abs(value) < 1e-3 ? 0 : value;
    return `${normalized.toFixed(1)} m`;
  }, []);

  const formatAngleValue = React.useCallback((value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    const normalized = Math.abs(value) < 1e-3 ? 0 : value;
    return `${normalized.toFixed(1)}°`;
  }, []);

  const updateStep = React.useCallback((key: ObjectMapStepKey, patch: Partial<ObjectMapStep>) => {
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  }, []);

  const resetSteps = React.useCallback((selectedLabel?: string) => {
    setSteps([
      { key: 'select', label: 'Select cluster', status: selectedLabel ? 'done' : 'pending', detail: selectedLabel },
      { key: 'detect', label: 'Find object', status: 'pending' },
      { key: 'measure', label: 'Measure range', status: 'pending' },
      { key: 'ingest', label: 'Save sample', status: 'pending' },
    ]);
  }, []);

  const readImageSize = React.useCallback((dataUrl: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width || 0, height: img.height || 0 });
      img.onerror = (err) => reject(err);
      img.src = dataUrl;
    });
  }, []);

  const wait = React.useCallback((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), []);

  const clearMeasurementTimeout = React.useCallback(() => {
    if (measurementTimeoutRef.current !== null) {
      window.clearTimeout(measurementTimeoutRef.current);
      measurementTimeoutRef.current = null;
    }
  }, []);

  const refreshClusters = React.useCallback(async () => {
    setClustersLoading(true);
    try {
      const res = await listClusters({ limit: 200 });
      setClusters(res.clusters);
      pushLog(`Loaded ${res.clusters.length} clusters`, 'info');
    } catch (err) {
      pushLog(`Cluster list error: ${String(err)}`, 'error');
    } finally {
      setClustersLoading(false);
    }
  }, [pushLog]);

  const loadClusterDetail = React.useCallback(async (clusterId: string) => {
    if (!clusterId) {
      setClusterDetail(null);
      setPreviewImage(null);
      resetSteps();
      setDetection(null);
      setDetectionBox(null);
      setSnapshotData(null);
      setImageDims(null);
      setMeasurement(null);
      setTargetPoint(null);
      setTargetEnu(null);
      setPromptsUsed([]);
      setMetaLabelsUsed([]);
      setDetectionPreview(null);
      setBoxes?.([]);
      setMasks?.([]);
      setPoses?.([]);
      clearClassifications();
      return;
    }
    setBusy(true);
    try {
      const detail = await getCluster(clusterId);
      setClusterDetail(detail);
      const label = detail.cluster.label || clusterId;
      resetSteps(label);
      setDetection(null);
      setDetectionBox(null);
      setSnapshotData(null);
      setImageDims(null);
      setMeasurement(null);
      setTargetPoint(null);
      setTargetEnu(null);
      setPromptsUsed([]);
      setMetaLabelsUsed([]);
      setDetectionPreview(null);
      setBoxes?.([]);
      setMasks?.([]);
      setPoses?.([]);
      clearClassifications();
      pushLog(`Selected cluster ${label}`, 'info');
      const samples = detail.samples;
      if (samples.length) {
        const lastSample = samples[samples.length - 1];
        try {
          const img = await fetchSampleImage(lastSample.sample_id);
          setPreviewImage(img);
        } catch (err) {
          pushLog(`Preview load failed: ${String(err)}`, 'error');
          setPreviewImage(null);
        }
      } else {
        setPreviewImage(null);
      }
    } catch (err) {
      pushLog(`Load cluster error: ${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [clearClassifications, pushLog, resetSteps, setBoxes, setMasks, setPoses]);

  React.useEffect(() => {
    bridgeManager.init();
    setLatestTelemetry(bridgeManager.getState().bridgeData.telemetry);
    const unsubscribe = bridgeManager.subscribe(() => {
      setLatestTelemetry(bridgeManager.getState().bridgeData.telemetry);
    });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    setBoxes?.([]);
    setMasks?.([]);
    setPoses?.([]);
    clearClassifications();
    return () => {
      setBoxes?.([]);
      setMasks?.([]);
      setPoses?.([]);
      clearClassifications();
    };
  }, [setBoxes, setMasks, setPoses, clearClassifications]);

  React.useEffect(() => { stepsRef.current = steps; }, [steps]);
  React.useEffect(() => { detectionBoxRef.current = detectionBox; }, [detectionBox]);
  React.useEffect(() => { imageDimsRef.current = imageDims; }, [imageDims]);
  React.useEffect(() => { telemetryRef.current = latestTelemetry; }, [latestTelemetry]);
  React.useEffect(() => { detectionRef.current = detection; }, [detection]);
  React.useEffect(() => { promptsRef.current = promptsUsed; }, [promptsUsed]);
  React.useEffect(() => { metaLabelsRef.current = metaLabelsUsed; }, [metaLabelsUsed]);

  const parseLaserMeasurement = React.useCallback((payload: any) => {
    const outer = payload?.data ?? payload;
    const inner = outer?.data ?? outer;
    const distance = parseMaybeNumber(inner?.distance_m ?? inner?.distanceMeters ?? inner?.distance);
    const coords = extractLocation3D(inner);
    const screen = extractScreenPoint(inner);
    return { distance, coords, screen, raw: payload };
  }, []);

  const handleLaserResult = React.useCallback((data: any) => {
    const isAwaiting = stepsRef.current.find((step) => step.key === 'measure')?.status === 'running';
    if (!isAwaiting) {
      return;
    }
    clearMeasurementTimeout();
    const measurementInfo = parseLaserMeasurement(data);
    const distance = measurementInfo.distance;
    const telemetry = telemetryRef.current;
    const box = detectionBoxRef.current;
    const dims = imageDimsRef.current;
    const originLocationRaw = telemetry?.location;
    const originLat = parseMaybeNumber(originLocationRaw?.latitude);
    const originLon = parseMaybeNumber(originLocationRaw?.longitude);
    // Use AMSL altitude directly from location (already calculated in DJIBridgeServer)
    // location.altitude is now ABSOLUTE altitude (AMSL)
    const locationAlt = parseMaybeNumber(originLocationRaw?.altitude);

    // Fallback: Use barometric altitude which is also AMSL now
    const baroAltitude = telemetry?.altitude_barometric || 0;

    // Use location altitude if available, otherwise use barometric
    const originAltitude = locationAlt ?? baroAltitude;

    // Debug log altitude values
    console.log('VisionPanel Altitude Debug:', {
      locationAlt,
      baroAltitude,
      final: originAltitude,
      motorsOn: telemetry?.motors_on
    });
    const originLocation = originLat !== null && originLon !== null
      ? {
          latitude: originLat,
          longitude: originLon,
          altitude: originAltitude,  // Always include altitude
        }
      : undefined;
    const originAttitudeRaw = telemetry?.attitude;
    const originAttitude = originAttitudeRaw
      ? {
          roll: parseMaybeNumber(originAttitudeRaw.roll) ?? undefined,
          pitch: parseMaybeNumber(originAttitudeRaw.pitch) ?? undefined,
          yaw: parseMaybeNumber(originAttitudeRaw.yaw) ?? undefined,
        }
      : undefined;
    const originGimbalAttitudeRaw = telemetry?.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN')?.attitude;
    const originGimbalAttitude = originGimbalAttitudeRaw
      ? {
          roll: parseMaybeNumber(originGimbalAttitudeRaw.roll) ?? undefined,
          pitch: parseMaybeNumber(originGimbalAttitudeRaw.pitch) ?? undefined,
          yaw: parseMaybeNumber(originGimbalAttitudeRaw.yaw) ?? undefined,
        }
      : undefined;

    setMeasurement({
      distance: distance ?? undefined,
      raw: data,
      ts: Date.now(),
      coords: measurementInfo.coords ?? undefined,
      screen: measurementInfo.screen ?? undefined,
      origin: {
        location: originLocation,
        attitude: originAttitude,
        gimbal: originGimbalAttitude,
      },
    });

    if (distance !== null && distance > 0) {
      updateStep('measure', { status: 'done', detail: `${distance.toFixed(1)} m` });
      pushLog(`Laser distance ${distance.toFixed(2)} m`, 'success');
    } else if (measurementInfo.coords) {
      updateStep('measure', { status: 'done', detail: 'coords only' });
      pushLog('Laser reported coordinates without distance', 'info');
    } else {
      updateStep('measure', { status: 'error', detail: 'no distance' });
      pushLog('Laser result missing distance', 'error');
    }

    let target: GeographicPoint | null = null;
    if (measurementInfo.coords && isFinite(measurementInfo.coords.latitude) && isFinite(measurementInfo.coords.longitude)) {
      target = {
        latitude: measurementInfo.coords.latitude,
        longitude: measurementInfo.coords.longitude,
        altitude: measurementInfo.coords.altitude ?? originAltitude ?? 0,
      };
    }

    if (!target && telemetry && box && dims && distance !== null && distance > 0) {
      const cx = clamp01Value(box.x + box.w / 2);
      const cy = clamp01Value(box.y + box.h / 2);
      target = projectRayToGroundNormalized(telemetry, cx, cy, dims.width, dims.height, false, distance ?? undefined);
    }

    if (target) {
      const altitude = parseMaybeNumber(target.altitude) ?? originAltitude ?? 0;
      target = { ...target, altitude };
    }

    if (target) {
      setTargetPoint(target);
      if (originLocation) {
        const enu = geographicToENU(target, {
          latitude: originLocation.latitude,
          longitude: originLocation.longitude,
          altitude: originAltitude ?? 0,
        });
        if ([enu.east, enu.north, enu.up].every((v) => typeof v === 'number' && isFinite(v))) {
          setTargetEnu(enu);
          pushLog(`Target offset: E ${enu.east.toFixed(1)} m, N ${enu.north.toFixed(1)} m`, 'info');
        } else {
          setTargetEnu(null);
        }
      } else {
        setTargetEnu(null);
      }
    } else {
      setTargetPoint(null);
      setTargetEnu(null);
    }

    sendBridge({ type: 'camera_laser_enable', data: { enabled: false } }).catch(() => {});
  }, [clearMeasurementTimeout, parseLaserMeasurement, pushLog, sendBridge, updateStep]);

  React.useEffect(() => {
    const unsubscribe = registerLaserResultListener(handleLaserResult);
    return unsubscribe;
  }, [handleLaserResult]);

  React.useEffect(() => {
    void refreshClusters();
  }, [refreshClusters]);

  const handleSelectCluster = React.useCallback(async (clusterId: string) => {
    setSelectedId(clusterId);
    await loadClusterDetail(clusterId);
  }, [loadClusterDetail]);

  const handleDetect = React.useCallback(async () => {
    if (!selectedId) {
      pushLog('Select a cluster first', 'error');
      return;
    }
    if (busy) return;
    setBusy(true);
    updateStep('detect', { status: 'running', detail: 'Detecting…' });
    setBoxes?.([]);
    setMasks?.([]);
    setPoses?.([]);
    clearClassifications();
    setDetection(null);
    setDetectionBox(null);
    setMeasurement(null);
    setTargetPoint(null);
    setTargetEnu(null);
    setDetectionPreview(null);
    try {
      const snapshot = await getSnapshot();
      const dims = await readImageSize(snapshot).catch(() => ({ width: imgSize, height: imgSize }));
      const labelStats = clusterDetail?.cluster.detect_label_stats || [];
      const prompts = labelStats.map((s) => s.label).filter(Boolean);
      let classes = prompts.slice(0, 6);
      if (classes.length === 0 && clusterDetail?.cluster.label) {
        classes = [clusterDetail.cluster.label];
      }
      setPromptsUsed(classes);
      pushLog(`Detect prompts: ${classes.length ? classes.join(', ') : '(prompt-free)'}`);
      const res = await analyzeRealtime({
        imageBase64: snapshot,
        threshold,
        classes,
        img_size: imgSize,
        searchDb: true,
        memoryClusterIds: [selectedId],
      });
      setMetaLabelsUsed(res.meta?.ovLabelsUsed || classes);
      if (res.meta?.memoryLabelPrompts?.length) {
        pushLog(`Memory hints: ${res.meta.memoryLabelPrompts.join(', ')}`);
      }
      const detections = res.detections || [];
      if (!detections.length) {
        updateStep('detect', { status: 'error', detail: 'no detections' });
        pushLog('No detections found', 'error');
        setBoxes?.([]);
        return;
      }
      const preferred = detections.find((det) => det.memory_cluster_id && det.memory_cluster_id === selectedId);
      const best = preferred || detections.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      const box = detectionToBox(best);
      setDetection(best);
      setDetectionBox(box);
      setSnapshotData(snapshot);
      setImageDims(dims);
      setBoxes?.(detections);
      setMasks?.([]);
      setPoses?.([]);
      clearClassifications();
      try {
        const thumb = await createThumbFromBox(snapshot, box);
        setDetectionPreview(thumb);
      } catch {
        setDetectionPreview(null);
      }
      setMeasurement(null);
      setTargetPoint(null);
      setTargetEnu(null);
      updateStep('detect', { status: 'done', detail: `${((best.score ?? 0) * 100).toFixed(1)}%` });
      updateStep('measure', { status: 'pending', detail: undefined });
      updateStep('ingest', { status: 'pending', detail: undefined });
    } catch (err) {
      updateStep('detect', { status: 'error', detail: String(err) });
      pushLog(`Detect error: ${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, clearClassifications, createThumbFromBox, getSnapshot, imgSize, analyzeRealtime, threshold, clusterDetail, pushLog, selectedId, setBoxes, setMasks, setPoses, updateStep, readImageSize]);

  const handleMeasure = React.useCallback(async () => {
    const box = detectionBoxRef.current;
    const det = detectionRef.current;
    if (!det || !box) {
      pushLog('Run detection first', 'error');
      return;
    }
    if (busy) return;
    setBusy(true);
    updateStep('measure', { status: 'running', detail: 'Centering…' });
    clearMeasurementTimeout();
    setMeasurement(null);
    setTargetPoint(null);
    setTargetEnu(null);
    const cx = clamp01Value(box.x + box.w / 2);
    const cy = clamp01Value(box.y + box.h / 2);
    try {
      //const tapRes = await sendBridge({ type: 'gimbal_tap_target', data: { x: cx, y: cy } });
      //if (tapRes && tapRes.success === false) {
      //  throw new Error(tapRes.error || 'tap_target failed');
      //}
      //await wait(400);
      pushLog('Camera centering command sent', 'success');
      updateStep('measure', { status: 'running', detail: 'Measuring…' });

      await sendBridge({ type: 'camera_laser_enable', data: { enabled: true } });
      await wait(150);
      const res = await sendBridge({ type: 'camera_laser_measure', data: { x: cx, y: cy } });
      if (res && res.success === false) {
        throw new Error(res.error || 'measure failed');
      }
      pushLog('Laser measurement triggered', 'info');
      measurementTimeoutRef.current = window.setTimeout(() => {
        updateStep('measure', { status: 'error', detail: 'timeout' });
        pushLog('Laser measurement timeout', 'error');
        setMeasurement(null);
        setTargetPoint(null);
        setTargetEnu(null);
      }, 4000);
    } catch (err) {
      updateStep('measure', { status: 'error', detail: String(err) });
      pushLog(`Measure error: ${String(err)}`, 'error');
      sendBridge({ type: 'camera_laser_enable', data: { enabled: false } }).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [busy, pushLog, sendBridge, updateStep, wait, clearMeasurementTimeout]);

  const handleIngest = React.useCallback(async () => {
    const det = detectionRef.current;
    const box = detectionBoxRef.current;
    const snapshot = snapshotData;
    const dims = imageDimsRef.current;
    if (!selectedId || !det || !box || !snapshot || !dims) {
      pushLog('Missing detection or snapshot data', 'error');
      return;
    }
    const hasDistance = typeof measurement?.distance === 'number' && measurement.distance > 0;
    const hasCoords = !!measurement?.coords;
    if (!hasDistance && !hasCoords) {
      pushLog('Measure distance before saving', 'error');
      return;
    }
    const telemetry = telemetryRef.current;
    if (!telemetry || !telemetry.location) {
      pushLog('Telemetry unavailable', 'error');
      return;
    }
    if (busy) return;
    setBusy(true);
    updateStep('ingest', { status: 'running', detail: 'Saving…' });
    try {
      const crop = await createThumbFromBox(snapshot, box);
      if (!crop) throw new Error('Crop failed');
      const rawLabel = det.memory_label || det.label || undefined;
      const normalizedLabel = sanitizeLabel(rawLabel);
      const gimbal = telemetry.gimbals?.find((g) => g.index === 'LEFT_OR_MAIN');
      const sourceCamera = telemetry.camera_optics?.index || telemetry.camera_optics?.lens_type || telemetry.camera_optics?.lens;
      const locationRaw = telemetry.location;
      const originLat = parseMaybeNumber(locationRaw?.latitude);
      const originLon = parseMaybeNumber(locationRaw?.longitude);
      // Use AMSL altitude directly from location (already calculated in DJIBridgeServer)
      // location.altitude is now ABSOLUTE altitude (AMSL)
      const originAltitude = parseMaybeNumber(locationRaw?.altitude)
        ?? (telemetry.altitude_barometric || 0);
      const dronePosition = originLat !== null && originLon !== null ? {
        latitude: originLat,
        longitude: originLon,
        ...(originAltitude !== null ? { altitude_m: originAltitude } : {}),
      } : undefined;
      const droneOrientation = telemetry.attitude ? {
        yaw: parseMaybeNumber(telemetry.attitude.yaw) ?? undefined,
        pitch: parseMaybeNumber(telemetry.attitude.pitch) ?? undefined,
        roll: parseMaybeNumber(telemetry.attitude.roll) ?? undefined,
      } : undefined;
      const gimbalOrientation = gimbal?.attitude ? {
        yaw: parseMaybeNumber(gimbal.attitude.yaw) ?? undefined,
        pitch: parseMaybeNumber(gimbal.attitude.pitch) ?? undefined,
        roll: parseMaybeNumber(gimbal.attitude.roll) ?? undefined,
      } : undefined;
      let target = targetPoint;
      if (!target && measurement?.coords) {
        target = {
          latitude: measurement.coords.latitude,
          longitude: measurement.coords.longitude,
          altitude: measurement.coords.altitude ?? originAltitude ?? 0,
        };
      }
      const objectPosition: SampleTelemetryPayload['object_position'] = target
        ? {
            latitude: target.latitude,
            longitude: target.longitude,
            altitude_m: target.altitude,
          }
        : {};
      if (hasDistance && typeof measurement?.distance === 'number') {
        objectPosition.distance_m = measurement.distance;
      }
      let enuOffset: { east: number; north: number; up: number } | undefined;
      if (target && originLat !== null && originLon !== null) {
        enuOffset = geographicToENU(target, {
          latitude: originLat,
          longitude: originLon,
          altitude: originAltitude ?? 0,
        });
      }
      const telemetryPayload: SampleTelemetryPayload = {
        drone_position: dronePosition,
        drone_orientation: droneOrientation,
        gimbal_orientation: gimbalOrientation,
        object_position: objectPosition,
        source_camera: sourceCamera,
        timestamp: Date.now() / 1000,
        extra: {
          object_map: {
            prompts: promptsRef.current,
            ov_labels_used: metaLabelsRef.current,
            detection_score: det.score,
            memory_label: det.memory_label,
            memory_similarity: det.memory_similarity,
            track_id: det.track_id ?? null,
            enu_offset: enuOffset,
            screen_point: measurement?.screen,
            laser_location: measurement?.coords,
            aircraft: {
              location: measurement?.origin?.location,
              attitude: measurement?.origin?.attitude,
              gimbal: measurement?.origin?.gimbal,
            },
          },
        },
      };
      await ingestObjectMemorySample({
        image: crop,
        track_id: det.track_id != null ? String(det.track_id) : undefined,
        label: clusterDetail?.cluster.label || undefined,
        telemetry: telemetryPayload,
        detectLabel: normalizedLabel,
        detectLabelRaw: rawLabel,
      });
      pushLog('Saved sample to object memory', 'success');
      updateStep('ingest', { status: 'done', detail: 'saved' });
      await refreshClusters();
      await loadClusterDetail(selectedId);
    } catch (err) {
      updateStep('ingest', { status: 'error', detail: String(err) });
      pushLog(`Save error: ${String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [clusterDetail, createThumbFromBox, ingestObjectMemorySample, loadClusterDetail, measurement, pushLog, refreshClusters, selectedId, snapshotData, targetPoint, telemetryRef, updateStep, busy]);

  const handleReset = React.useCallback(() => {
    setDetection(null);
    setDetectionBox(null);
    setSnapshotData(null);
    setImageDims(null);
    setDetectionPreview(null);
    setMeasurement(null);
    setTargetPoint(null);
    setTargetEnu(null);
    setBoxes?.([]);
    setMasks?.([]);
    setPoses?.([]);
    clearClassifications();
    updateStep('detect', { status: 'pending', detail: undefined });
    updateStep('measure', { status: 'pending', detail: undefined });
    updateStep('ingest', { status: 'pending', detail: undefined });
  }, [clearClassifications, setBoxes, setMasks, setPoses, updateStep]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={() => refreshClusters()} disabled={clustersLoading || busy}>Refresh</button>
        <select
          className="bg-gray-800 text-xs px-2 py-1 rounded min-w-[200px]"
          value={selectedId}
          onChange={(e) => void handleSelectCluster(e.target.value)}
        >
          <option value="">Choose cluster…</option>
          {clusters.map((c) => (
            <option key={c.cluster_id} value={c.cluster_id}>
              {(c.label || '(unlabeled)')} · {c.sample_count}
            </option>
          ))}
        </select>
        {clustersLoading && <span className="text-[10px] text-gray-500">loading…</span>}
        {busy && <span className="text-[10px] text-gray-500">working…</span>}
        <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handleReset} disabled={busy}>Clear</button>
      </div>

      {clusterDetail && (
        <div className="border border-gray-700 rounded p-2 text-[10px] text-gray-300 bg-gray-900/40">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-gray-100">{clusterDetail.cluster.label || '(unlabeled)'}</div>
            <div className="text-gray-500">{clusterDetail.cluster.sample_count} samples · μ {(clusterDetail.cluster.mean_similarity ?? 0).toFixed(3)}</div>
          </div>
          {clusterDetail.cluster.detect_label_stats?.length ? (
            <div className="text-gray-400 mt-1">YOLO labels: {clusterDetail.cluster.detect_label_stats.map((s) => `${s.label}(${s.count})`).join(', ')}</div>
          ) : (
            <div className="text-gray-500 mt-1">No detection labels recorded yet</div>
          )}
          {clusterDetail.cluster.latest_sample?.telemetry?.object_position?.distance_m && (
            <div className="text-gray-500 mt-1">
              Last range: {clusterDetail.cluster.latest_sample.telemetry.object_position.distance_m?.toFixed(2)} m
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <div className="border border-gray-700 rounded p-2 text-[10px] text-gray-400 bg-gray-900/40">
            {steps.map((step) => (
              <div key={step.key} className="flex items-center justify-between py-0.5">
                <span>{step.label}</span>
                <span className={
                  step.status === 'done'
                    ? 'text-emerald-400'
                    : step.status === 'running'
                    ? 'text-blue-300'
                    : step.status === 'error'
                    ? 'text-red-400'
                    : 'text-gray-500'
                }>
                  {step.status}{step.detail ? ` · ${step.detail}` : ''}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <button className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded" onClick={handleDetect} disabled={busy || !selectedId}>Find</button>
            <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handleMeasure} disabled={busy || !detection}>Measure</button>
            <button
              className="px-2 py-1 bg-green-700 hover:bg-green-600 rounded disabled:opacity-50 disabled:hover:bg-green-700"
              onClick={handleIngest}
              disabled={busy || !detection || !(measurement?.distance || measurement?.coords)}
            >
              Save
            </button>
          </div>

          <div className="border border-gray-700 rounded p-2 text-[10px] text-gray-400 bg-gray-900/40">
            <div className="font-semibold text-gray-200 mb-1">Measurement</div>
            <div>
              Distance: {typeof measurement?.distance === 'number' && isFinite(measurement.distance)
                ? `${measurement.distance.toFixed(2)} m`
                : measurement?.coords ? '— (coords only)' : '—'}
            </div>
            {measurement?.coords && (
              <div className="mt-1">
                <div>Laser Lat: {measurement.coords.latitude.toFixed(6)}</div>
                <div>Laser Lon: {measurement.coords.longitude.toFixed(6)}</div>
                <div>Laser Alt: {typeof measurement.coords.altitude === 'number' && isFinite(measurement.coords.altitude) ? `${measurement.coords.altitude.toFixed(1)} m` : '–'}</div>
              </div>
            )}
            {measurement?.screen && (
              <div className="text-gray-500">Screen: ({measurement.screen.x.toFixed(3)}, {measurement.screen.y.toFixed(3)})</div>
            )}
            <div className="mt-1">
              <div>Target Lat: {targetPoint ? targetPoint.latitude.toFixed(6) : '—'}</div>
              <div>Target Lon: {targetPoint ? targetPoint.longitude.toFixed(6) : '—'}</div>
              <div>Target Alt: {targetPoint ? `${targetPoint.altitude.toFixed(1)} m` : '—'}</div>
            </div>
            {measurement?.origin?.location && (
              <div className="mt-1">
                <div>Aircraft Lat: {measurement.origin.location.latitude?.toFixed(6) ?? '—'}</div>
                <div>Aircraft Lon: {measurement.origin.location.longitude?.toFixed(6) ?? '—'}</div>
                <div>Aircraft Alt (AMSL): {typeof measurement.origin.location.altitude === 'number' && isFinite(measurement.origin.location.altitude)
                  ? `${measurement.origin.location.altitude.toFixed(1)} m`
                  : '0.0 m'}</div>
              </div>
            )}
            {measurement?.origin?.attitude && (
              <div className="mt-1">
                <div>Aircraft Roll: {formatAngleValue(measurement.origin.attitude.roll)}</div>
                <div>Aircraft Pitch: {formatAngleValue(measurement.origin.attitude.pitch)}</div>
                <div>Aircraft Yaw: {formatAngleValue(measurement.origin.attitude.yaw)}</div>
              </div>
            )}
            {measurement?.origin?.gimbal && (
              <div className="mt-1">
                <div>Gimbal Pitch: {formatAngleValue(measurement.origin.gimbal.pitch)}</div>
                <div>Gimbal Yaw: {formatAngleValue(measurement.origin.gimbal.yaw)}</div>
                <div>Gimbal Roll: {formatAngleValue(measurement.origin.gimbal.roll)}</div>
              </div>
            )}
            {targetEnu && (
              <div className="mt-1">
                <div>Offset E: {formatOffsetValue(targetEnu.east)}</div>
                <div>Offset N: {formatOffsetValue(targetEnu.north)}</div>
                <div>Offset Up: {formatOffsetValue(targetEnu.up)}</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            {previewImage && (
              <div className="border border-gray-700 rounded overflow-hidden">
                <div className="bg-gray-800 text-[10px] text-gray-400 px-2 py-1">Cluster preview</div>
                <img src={previewImage} alt="cluster-preview" className="w-full h-32 object-cover" />
              </div>
            )}
            {detectionPreview && (
              <div className="border border-gray-700 rounded overflow-hidden">
                <div className="bg-gray-800 text-[10px] text-gray-400 px-2 py-1">Detection</div>
                <img src={detectionPreview} alt="detection-preview" className="w-full h-32 object-cover" />
              </div>
            )}
          </div>

          <div className="border border-gray-700 rounded p-2 text-[10px] text-gray-400 bg-gray-900/40 max-h-40 overflow-y-auto">
            <div className="font-semibold text-gray-200 mb-1">Activity</div>
            {logEntries.length === 0 && <div className="text-gray-600">No activity yet</div>}
            {logEntries.map((entry) => (
              <div key={entry.ts} className={entry.level === 'error' ? 'text-red-400' : entry.level === 'success' ? 'text-emerald-400' : 'text-gray-400'}>
                {new Date(entry.ts).toLocaleTimeString()} · {entry.message}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export const VisionRealtimePanel: React.FC<VisionRealtimePanelProps> = ({ getSnapshot, setBoxes, setMasks, setPoses, setMaskOpacity, setColorizeById, setDetectThickness, setHeatmap, setHeatmapOpacity }) => {
  const [running, setRunning] = React.useState<boolean>(() => {
    try { const raw = localStorage.getItem('visionrt.running'); if (raw) return JSON.parse(raw); } catch {}
    return false;
  });
  const runningRef = React.useRef<boolean>(false);
  // Removed intervalMs - no longer using fixed intervals
  const [thr, setThr] = React.useState<number>(() => {
    try { const raw = localStorage.getItem('visionrt.thr'); if (raw) return JSON.parse(raw); } catch {}
    return 0.25;
  });
  const [imgSize, setImgSize] = React.useState<number>(() => {
    try { const raw = localStorage.getItem('visionrt.imgSize'); if (raw) return JSON.parse(raw); } catch {}
    return 640;
  });
  const [classesText, setClassesText] = React.useState<string>(() => localStorage.getItem('visionrt.classes') || '');
  const [useSearchDb, setUseSearchDb] = React.useState<boolean>(()=>{ try { const raw = localStorage.getItem('visionrt.searchDb'); if (raw) return JSON.parse(raw); } catch {} return false; });
  const [busy, setBusy] = React.useState<boolean>(false);
  const [lastDetections, setLastDetections] = React.useState<Detection[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState<number>(-1);
  const [promptImage, setPromptImage] = React.useState<string | null>(null);
  const [promptInfo, setPromptInfo] = React.useState<string>('');
  const abortRef = React.useRef<AbortController | null>(null);
  const [mode, setMode] = React.useState<'detect'|'segment'|'locktrack'|'objectmap'>(() => {
    try {
      const raw = localStorage.getItem('visionrt.mode');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed === 'detect' || parsed === 'segment' || parsed === 'locktrack' || parsed === 'objectmap') {
          return parsed;
        }
      }
    } catch {}
    return 'detect';
  });
  const [lockViews, setLockViews] = React.useState<LockTrackView[]>([]);

  React.useEffect(() => {
    try { localStorage.setItem('visionrt.running', JSON.stringify(running)); } catch {}
    runningRef.current = running;
  }, [running]);
  // Removed intervalMs persistence
  React.useEffect(() => { try { localStorage.setItem('visionrt.thr', JSON.stringify(thr)); } catch {} }, [thr]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.imgSize', JSON.stringify(imgSize)); } catch {} }, [imgSize]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.classes', classesText); } catch {} }, [classesText]);
  React.useEffect(()=>{ try { localStorage.setItem('visionrt.searchDb', JSON.stringify(useSearchDb)); } catch {} }, [useSearchDb]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.mode', JSON.stringify(mode)); } catch {} }, [mode]);

  const parsedClasses = React.useMemo(() => classesText.split(/\n|,|;/).map(s=>s.trim()).filter(Boolean).slice(0, 50), [classesText]);

  // Removed step callback - using runContinuous instead

  // Single-step: run one request without starting the loop.
  const stepOnce = React.useCallback(async () => {
    // Cancel any in-flight work before issuing a single step
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    abortRef.current = new AbortController();
    try {
      const img = await getSnapshot();
      if (mode === 'detect') {
        const out = await analyzeRealtime({ imageBase64: img, threshold: thr, classes: parsedClasses, img_size: imgSize, searchDb: useSearchDb, signal: abortRef.current?.signal });
        setMasks?.([]);
        setPoses?.([]);
        setClassResults([]);
        setBoxes?.(out.detections || []);
      } else if (mode === 'segment') {
        const out = await analyzeRealtimeSegment({ imageBase64: img, threshold: thr, img_size: imgSize, classes: parsedClasses, signal: abortRef.current?.signal });
        setBoxes?.([]);
        setPoses?.([]);
        setClassResults([]);
        setMasks?.(out.masks || []);
      } else if (mode === 'locktrack') {
        const out = await analyzeRealtime({ imageBase64: img, threshold: thr, classes: parsedClasses, img_size: imgSize, signal: abortRef.current?.signal });
        setMasks?.([]);
        setPoses?.([]);
        setClassResults([]);
        const det = out.detections || [];
        setBoxes?.(det);
        setLastDetections(det);
      }
    } catch (e) {
      console.warn('[VisionRT] stepOnce failed:', e);
    }
  }, [getSnapshot, setBoxes, setMasks, setPoses, thr, parsedClasses, imgSize, mode]);

  const start = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    abortRef.current = new AbortController();

    // Start the continuous loop
    runContinuous();
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    setBoxes?.([]);
    setMasks?.([]);
    setPoses?.([]);
    setClassResults([]);
  };

  const clearOverlays = () => {
    setBoxes?.([]);
    setMasks?.([]);
    setPoses?.([]);
    setClassResults([]);
    setLastDetections([]);
    setSelectedIndex(-1);
    setPromptImage(null);
    setPromptInfo('');
    setLockViews([]);
  };

  const sendBridgeCommand = React.useCallback(async (command: any) => {
    try {
      const res = await bridgeManager.sendBridgeCommand(command);
      return res;
    } catch (err) {
      console.warn('[VisionRT] bridge send failed:', err);
      return { success: false, error: String(err) };
    }
  }, []);

  // Store refs for values that need to be accessed in the loop
  const modeRef = React.useRef(mode);
  const thrRef = React.useRef(thr);
  const imgSizeRef = React.useRef(imgSize);
  const parsedClassesRef = React.useRef(parsedClasses);
  const searchDbRef = React.useRef(useSearchDb);

  React.useEffect(() => { modeRef.current = mode; }, [mode]);
  React.useEffect(() => { thrRef.current = thr; }, [thr]);
  React.useEffect(() => { imgSizeRef.current = imgSize; }, [imgSize]);
  React.useEffect(() => { parsedClassesRef.current = parsedClasses; }, [parsedClasses]);
  React.useEffect(() => { searchDbRef.current = useSearchDb; }, [useSearchDb]);
  // Stop continuous loop if switching to LockTrack (prevent UI input contention)
  React.useEffect(() => {
    if ((mode === 'locktrack' || mode === 'objectmap') && runningRef.current) {
      stop();
    }
  }, [mode]);

  // Continuous loop: wait for response before sending next request
  const runContinuous = async () => {
    console.log('[VisionRT] Starting continuous loop');
    while (runningRef.current) {
      try {
        const img = await getSnapshot();
        if (!runningRef.current) break;

        const currentMode = modeRef.current;
        const currentThr = thrRef.current;
        const currentImgSize = imgSizeRef.current;
        const currentClasses = parsedClassesRef.current;

        if (currentMode === 'detect') {
          console.log('[VisionRT] Sending detect request...');
          const out = await analyzeRealtime({ imageBase64: img, threshold: currentThr, classes: currentClasses, img_size: currentImgSize, searchDb: searchDbRef.current, signal: abortRef.current?.signal });
          console.log('[VisionRT] Detect response received:', out.detections?.length, 'detections');
          if (!runningRef.current) break;
          setMasks?.([]);
          setPoses?.([]);
          setClassResults([]);
          const det = out.detections || [];
          setBoxes?.(det);
          setLastDetections(det);
        } else if (currentMode === 'segment') {
          console.log('[VisionRT] Sending segment request...');
          const out = await analyzeRealtimeSegment({ imageBase64: img, threshold: currentThr, img_size: currentImgSize, classes: currentClasses, signal: abortRef.current?.signal });
          console.log('[VisionRT] Segment response received:', out.masks?.length, 'masks');
          if (!runningRef.current) break;
          setBoxes?.([]);
          setPoses?.([]);
          setClassResults([]);
          setMasks?.(out.masks || []);
        } else if (currentMode === 'locktrack') {
          console.log('[VisionRT] Sending locktrack detect request...');
          const out = await analyzeRealtime({ imageBase64: img, threshold: currentThr, classes: currentClasses, img_size: currentImgSize, signal: abortRef.current?.signal });
          console.log('[VisionRT] Locktrack detect response received:', out.detections?.length, 'detections');
          if (!runningRef.current) break;
          setMasks?.([]);
          setPoses?.([]);
          setClassResults([]);
          const det = out.detections || [];
          setBoxes?.(det);
          setLastDetections(det);
        }
      } catch (e) {
        if (!runningRef.current) break;
        console.warn('[VisionRT] continuous loop error:', e);
        // Brief pause on error before retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    console.log('[VisionRT] Continuous loop stopped');
  };

  // Remove the useEffect that was starting multiple loops

  const [classResults, setClassResults] = React.useState<Array<{label:string; score:number}>>([]);
  const clearClassificationResults = React.useCallback(() => setClassResults([]), []);

  const content = (
    <div className="flex flex-col gap-2 text-xs h-full">
      {mode === 'detect' || mode === 'segment' ? (
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-400">Endpoint: {getRealtimeVisionUrl()}</div>
          <div className="flex items-center gap-2">
            <button className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" onClick={clearOverlays}>Clear</button>
            <button className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600" onClick={stepOnce}>Step</button>
            {!running ? (
              <button className="px-2 py-1 rounded bg-green-700 hover:bg-green-600" onClick={start}>Start</button>
            ) : (
              <button className="px-2 py-1 rounded bg-red-700 hover:bg-red-600" onClick={stop}>Stop</button>
            )}
          </div>
        </div>
      ) : mode === 'locktrack' ? (
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-400">LockTrack endpoint: {getLocktrackBase()}/lock</div>
          <div className="flex items-center gap-2">
            <button className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" onClick={clearOverlays}>Clear</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-400">Object Map mode · manual workflow</div>
          <div className="flex items-center gap-2">
            <button className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" onClick={clearOverlays}>Clear Overlays</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">mode
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={mode} onChange={(e)=>setMode(e.target.value as any)}>
            <option value="detect">Detect</option>
            <option value="segment">Segment</option>
            <option value="locktrack">LockTrack</option>
            <option value="objectmap">Object Map</option>
          </select>
        </label>
        <label className="flex items-center gap-1">thr
          <input type="range" min={0.01} max={0.99} step={0.01} value={thr} onChange={(e)=>setThr(parseFloat(e.target.value))} />
          <span className="text-gray-400">{thr.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1">imgsz
          <input type="number" min={320} max={1280} step={32} value={imgSize} onChange={(e)=>setImgSize(parseInt(e.target.value||'640'))} className="w-20 bg-gray-800 px-2 py-1 rounded" />
        </label>
      </div>

      {(mode === 'detect' || mode === 'segment') && (
        <div className="flex-1 overflow-auto">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-gray-400">Labels (optional; used for YOLO‑E open‑vocab {mode === 'segment' ? 'segmentation' : 'detection'}; leave blank for prompt‑free)</div>
            {mode === 'detect' && (
              <label className="flex items-center gap-1 text-[10px] text-gray-400">
                <input type="checkbox" className="accent-dji-blue" checked={useSearchDb} onChange={(e)=>setUseSearchDb(e.target.checked)} />
                search DB
              </label>
            )}
          </div>
          <textarea className="w-full h-full bg-gray-800 text-gray-200 text-xs p-2 rounded"
            placeholder={"person\ncar\ntruck"}
            value={classesText}
            onChange={(e)=>setClassesText(e.target.value)}
          />
        </div>
      )}

      {mode === 'segment' && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">opacity
            <input type="range" min={0} max={1} step={0.05} defaultValue={(() => { try { const raw = localStorage.getItem('visionrt.maskOpacity'); if (raw) return JSON.parse(raw); } catch {} return 0.25; })()} onChange={(e)=>{ const v = parseFloat(e.target.value); setMaskOpacity?.(v); try { localStorage.setItem('visionrt.maskOpacity', JSON.stringify(v)); } catch {} }} />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" defaultChecked={(() => { try { const raw = localStorage.getItem('visionrt.colorizeById'); if (raw) return JSON.parse(raw); } catch {} return false; })()} onChange={(e)=>{ setColorizeById?.(e.target.checked); try { localStorage.setItem('visionrt.colorizeById', JSON.stringify(e.target.checked)); } catch {} }} /> colorize by id
          </label>
          <label className="flex items-center gap-2">box thickness
            <input type="range" min={1} max={6} step={1} defaultValue={(() => { try { const raw = localStorage.getItem('visionrt.detectThickness'); if (raw) return JSON.parse(raw); } catch {} return 1; })()} onChange={(e)=>{ const v = parseInt(e.target.value); setDetectThickness?.(v); try { localStorage.setItem('visionrt.detectThickness', JSON.stringify(v)); } catch {} }} />
          </label>
        </div>
      )}

      {mode === 'locktrack' && (
        <LockTrackSection
          getSnapshot={getSnapshot}
          setBoxes={setBoxes}
          lastDetections={lastDetections}
          setLastDetections={setLastDetections}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          promptImage={promptImage}
          setPromptImage={setPromptImage}
          promptInfo={promptInfo}
          setPromptInfo={setPromptInfo}
          setHeatmap={setHeatmap}
          setHeatmapOpacity={setHeatmapOpacity}
          imgSize={imgSize}
          abortRef={abortRef}
          views={lockViews}
          setViews={setLockViews}
        />
      )}

      {mode === 'objectmap' && (
        <ObjectMapSection
          getSnapshot={getSnapshot}
          setBoxes={setBoxes}
          setMasks={setMasks}
          setPoses={setPoses}
          clearClassifications={clearClassificationResults}
          imgSize={imgSize}
          sendBridge={sendBridgeCommand}
          threshold={thr}
          createThumbFromBox={cropImageToBox}
        />
      )}

      {/* classify mode removed */}
    </div>
  );

  return (
    <Panel
      title="Vision Realtime (YOLO)"
      defaultPosition={{ x: 24, y: 360 }}
      defaultSize={{ w: 360, h: 320 }}
      storageKey="visionrt.panel"
      visibilityEventType="visionrtPanelVisibilityChange"
    >
      {content}
    </Panel>
  );
};
