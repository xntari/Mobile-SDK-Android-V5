import React from 'react';
import { Panel, createPanelControls } from './Panel';
import { analyzeRealtime, analyzeRealtimeSegment, getRealtimeVisionUrl } from '../agent/visionClient';
import { lockTrackLock, lockTrackStep, lockTrackAddView, lockTrackUnlock, getLocktrackBase } from '../agent/locktrackClient';
import type { Detection } from '../agent/visionClient';
import { bridgeManager } from '../bridgeManager';

export const visionRTPanelControls = createPanelControls('visionrt.panel', 'visionrtPanelVisibilityChange');

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
  const [ltClassesText, setLtClassesText] = React.useState<string>(()=>{ try { return localStorage.getItem('locktrack.labels') || ''; } catch {} return ''; });
  const [ltScanThr, setLtScanThr] = React.useState<number>(()=>{ try { const raw = localStorage.getItem('locktrack.scanThr'); if (raw) return JSON.parse(raw); } catch {} return 0.25; });
  const [maxSide, setMaxSide] = React.useState<number>(()=>{ try { const raw = localStorage.getItem('locktrack.maxSide'); if (raw) return JSON.parse(raw); } catch {} return 0; });
  const [trackMode, setTrackMode] = React.useState<'free_look'|'look_at'>(()=>{ try { return (localStorage.getItem('locktrack.trackMode') as any) || 'free_look'; } catch {} return 'free_look'; });
  const [vxGain, setVxGain] = React.useState<number>(()=>{ try { const v = JSON.parse(localStorage.getItem('locktrack.vxGain')||'1.0'); if (typeof v==='number') return v; } catch {} return 1.0; });
  const [deadZone, setDeadZone] = React.useState<number>(()=>{ try { const v = JSON.parse(localStorage.getItem('locktrack.deadZone')||'0.05'); if (typeof v==='number') return v; } catch {} return 0.05; });
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

  React.useEffect(() => {
    if (!trackId && trackingActiveRef.current) {
      trackingActiveRef.current = false;
      setTrackingActive(false);
    }
  }, [trackId]);

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
      const det = out.detections || [];
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
      let ref_image: string | undefined = undefined;
      let box: {x:number;y:number;w:number;h:number} | undefined = undefined;
      if (promptImage) {
        ref_image = promptImage;
      } else {
        if (selectedIndex >= 0 && selectedIndex < lastDetections.length) {
          const d = lastDetections[selectedIndex];
          const x = Math.max(0, Math.min(1, d.x1));
          const y = Math.max(0, Math.min(1, d.y1));
          const w = Math.max(0, Math.min(1, d.x2 - d.x1));
          const h = Math.max(0, Math.min(1, d.y2 - d.y1));
          box = { x, y, w, h };
        } else {
          setPromptInfo('Provide a reference: extract or upload an image, or select a detection.');
          return;
        }
      }
      const scales = scalesText.split(/,|\s+/).map(s=>parseFloat(s)).filter(n=>!isNaN(n) && n>0).slice(0,5);
      const controller = new AbortController();
      abortRef.current = controller;
      const out = await lockTrackLock({ image: img, ref_image, box, return_heatmap: showHeatmap, threshold: thrLT, search_pad: pad, scales, signal: controller.signal, image_max_side: maxSide>0?maxSide:undefined, heatmap_cmap: hmCmap });
      setTrackId(out.track_id);
      setStatus(out.status || 'locked');
      const b = out.init_box;
      setLastBox(b);
      setBoxes?.([{ x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h, score: typeof out.score==='number'? out.score : 1.0, label: `lock` }]);
      setPromptInfo(`Lock ${out.status}${typeof out.score==='number' ? `, score ${out.score.toFixed(2)}` : ''}`);
      console.log('[LockTrack] Lock: server response', out);
      if (showHeatmap && out.heatmap) {
        const hm = `data:image/png;base64,${out.heatmap}`;
        setLastHeatmap(hm);
        setHeatmap?.(hm);
      } else if (!showHeatmap) {
        setHeatmap?.(null);
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
    }
    if (origin === 'manual') {
      console.log('[LockTrack] Step: capturing snapshot', { trackId });
    }

    setPromptInfo(`${origin === 'manual' ? 'step' : 'tracking'}: sending snapshot...`);

    try {
      const img = await getSnapshot();
      const controller = new AbortController();
      abortRef.current = controller;
      const out = await lockTrackStep({ track_id: trackId, image: img, return_heatmap: showHeatmap, signal: controller.signal, image_max_side: maxSide>0?maxSide:undefined, heatmap_cmap: hmCmap });
      if (origin === 'manual') {
        console.log('[LockTrack] Step: server response', out);
      }

      const b = out.box;
      setLastBox(b);
      setStatus(out.status);
      setBoxes?.([{ x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h, score: out.score, label: `lock` }]);

      const cx = b.x + b.w * 0.5;
      const cy = b.y + b.h * 0.5;
      let promptExtra = '';

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

      setPromptInfo(`${origin === 'manual' ? 'step' : 'tracking'}: ${out.status}, score ${out.score.toFixed(2)}${promptExtra}`);
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
  }, [trackId, getSnapshot, showHeatmap, maxSide, hmCmap, setLastBox, setStatus, setBoxes, trackMode, ensureFreeLookSession, stopFreeLookSession, deadZone, vxGain, sendBridge, scheduleFreeLookStop, setHeatmap, setPromptInfo]);

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
        await lockTrackAddView({ track_id: trackId, ref_image: promptImage, signal: controller.signal });
        setPromptInfo('added view (image)');
      } else if (lastBox) {
        const img = await getSnapshot();
        const controller = new AbortController();
        abortRef.current = controller;
        await lockTrackAddView({ track_id: trackId, image: img, box: lastBox, signal: controller.signal });
        setPromptInfo('added view (current box)');
      } else {
        setPromptInfo('provide a reference or lock first');
      }
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn('[VisionRT] add_view failed:', e);
      setPromptInfo(`add_view error: ${msg}`);
    }
  };

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
        <span className="text-[10px] text-gray-400">status: {status}</span>
      </div>
      {promptInfo && <div className="text-[10px] text-gray-400">{promptInfo}</div>}
      <div className="text-[10px] text-gray-400 mt-2">Labels (optional; used for LockTrack scan; same format as Detect)</div>
      <textarea className="w-full h-20 bg-gray-800 text-gray-200 text-xs p-2 rounded" placeholder={"person\ncar\ntruck"} value={ltClassesText} onChange={(e)=>setLtClassesText(e.target.value)} />
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
  const [busy, setBusy] = React.useState<boolean>(false);
  const [lastDetections, setLastDetections] = React.useState<Detection[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState<number>(-1);
  const [promptImage, setPromptImage] = React.useState<string | null>(null);
  const [promptInfo, setPromptInfo] = React.useState<string>('');
  const abortRef = React.useRef<AbortController | null>(null);
  const [mode, setMode] = React.useState<'detect'|'segment'|'locktrack'>(() => {
    try { const raw = localStorage.getItem('visionrt.mode'); if (raw) return JSON.parse(raw); } catch {}
    return 'detect';
  });

  React.useEffect(() => {
    try { localStorage.setItem('visionrt.running', JSON.stringify(running)); } catch {}
    runningRef.current = running;
  }, [running]);
  // Removed intervalMs persistence
  React.useEffect(() => { try { localStorage.setItem('visionrt.thr', JSON.stringify(thr)); } catch {} }, [thr]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.imgSize', JSON.stringify(imgSize)); } catch {} }, [imgSize]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.classes', classesText); } catch {} }, [classesText]);
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
        const out = await analyzeRealtime({ imageBase64: img, threshold: thr, classes: parsedClasses, img_size: imgSize, signal: abortRef.current?.signal });
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
  };

  // Store refs for values that need to be accessed in the loop
  const modeRef = React.useRef(mode);
  const thrRef = React.useRef(thr);
  const imgSizeRef = React.useRef(imgSize);
  const parsedClassesRef = React.useRef(parsedClasses);

  React.useEffect(() => { modeRef.current = mode; }, [mode]);
  React.useEffect(() => { thrRef.current = thr; }, [thr]);
  React.useEffect(() => { imgSizeRef.current = imgSize; }, [imgSize]);
  React.useEffect(() => { parsedClassesRef.current = parsedClasses; }, [parsedClasses]);
  // Stop continuous loop if switching to LockTrack (prevent UI input contention)
  React.useEffect(() => { if (mode === 'locktrack' && runningRef.current) { stop(); } }, [mode]);

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
          const out = await analyzeRealtime({ imageBase64: img, threshold: currentThr, classes: currentClasses, img_size: currentImgSize, signal: abortRef.current?.signal });
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

  const content = (
    <div className="flex flex-col gap-2 text-xs h-full">
      {mode !== 'locktrack' ? (
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
      ) : (
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-gray-400">LockTrack endpoint: {getLocktrackBase()}/lock</div>
          <div className="flex items-center gap-2">
            <button className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600" onClick={clearOverlays}>Clear</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">mode
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={mode} onChange={(e)=>setMode(e.target.value as any)}>
            <option value="detect">Detect</option>
            <option value="segment">Segment</option>
            <option value="locktrack">LockTrack</option>
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
          <div className="text-[10px] text-gray-400 mb-1">Labels (optional; used for YOLO‑E open‑vocab {mode === 'segment' ? 'segmentation' : 'detection'}; leave blank for prompt‑free)</div>
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
