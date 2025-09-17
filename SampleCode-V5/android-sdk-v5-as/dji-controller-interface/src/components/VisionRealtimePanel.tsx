import React from 'react';
import { Panel, createPanelControls } from './Panel';
import { analyzeRealtime, analyzeRealtimeSegment, analyzeRealtimePose, analyzeRealtimeClassify, analyzeRealtimeObb, getRealtimeVisionUrl } from '../agent/visionClient';

export const visionRTPanelControls = createPanelControls('visionrt.panel', 'visionrtPanelVisibilityChange');

export interface VisionRealtimePanelProps {
  getSnapshot: () => Promise<string>;
  setBoxes?: (boxes: Array<{ x1:number; y1:number; x2:number; y2:number; score:number; label?:string }>) => void;
  setMasks?: (masks: Array<{ points: Array<{x:number;y:number}>; score?: number; label?: string }>) => void;
  setPoses?: (poses: Array<Array<{x:number;y:number;conf?:number}>>) => void;
}

export const VisionRealtimePanel: React.FC<VisionRealtimePanelProps> = ({ getSnapshot, setBoxes, setMasks, setPoses }) => {
  const [running, setRunning] = React.useState<boolean>(() => {
    try { const raw = localStorage.getItem('visionrt.running'); if (raw) return JSON.parse(raw); } catch {}
    return false;
  });
  const [intervalMs, setIntervalMs] = React.useState<number>(() => {
    try { const raw = localStorage.getItem('visionrt.intervalMs'); if (raw) return JSON.parse(raw); } catch {}
    return 150; // ~6-7 FPS default
  });
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
  // Use numeric timeout handle for browser/Electron renderer
  const timerRef = React.useRef<number | null>(null);
  const runTokenRef = React.useRef<number>(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const [mode, setMode] = React.useState<'detect'|'segment'|'pose'|'classify'|'obb'>(() => {
    try { const raw = localStorage.getItem('visionrt.mode'); if (raw) return JSON.parse(raw); } catch {}
    return 'detect';
  });

  React.useEffect(() => { try { localStorage.setItem('visionrt.running', JSON.stringify(running)); } catch {} }, [running]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.intervalMs', JSON.stringify(intervalMs)); } catch {} }, [intervalMs]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.thr', JSON.stringify(thr)); } catch {} }, [thr]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.imgSize', JSON.stringify(imgSize)); } catch {} }, [imgSize]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.classes', classesText); } catch {} }, [classesText]);
  React.useEffect(() => { try { localStorage.setItem('visionrt.mode', JSON.stringify(mode)); } catch {} }, [mode]);

  const parsedClasses = React.useMemo(() => classesText.split(/\n|,|;/).map(s=>s.trim()).filter(Boolean).slice(0, 50), [classesText]);

  const step = React.useCallback(async () => {
    // Capture token to ignore late results after Stop
    const token = runTokenRef.current;
    try {
      const img = await getSnapshot();
      // Bail if stopped while capturing snapshot
      if (runTokenRef.current !== token) return;
      if (mode === 'detect') {
        const out = await analyzeRealtime({ imageBase64: img, threshold: thr, classes: parsedClasses, img_size: imgSize, signal: abortRef.current?.signal });
        if (token !== runTokenRef.current || !running) return;
        setMasks?.([]);
        setPoses?.([]);
        setClassResults([]);
        setBoxes?.(out.detections || []);
      } else {
        if (mode === 'segment') {
          const out = await analyzeRealtimeSegment({ imageBase64: img, threshold: thr, img_size: imgSize, signal: abortRef.current?.signal });
          if (token !== runTokenRef.current || !running) return;
          setBoxes?.([]);
          setPoses?.([]);
          setClassResults([]);
          setMasks?.(out.masks || []);
        } else if (mode === 'pose') {
          const out = await analyzeRealtimePose(img, imgSize, abortRef.current?.signal);
          if (token !== runTokenRef.current || !running) return;
          setBoxes?.([]);
          setMasks?.([]);
          setClassResults([]);
          setPoses?.((out.poses || []).map(p => p.keypoints));
        } else if (mode === 'classify') {
          const out = await analyzeRealtimeClassify(img, 5, imgSize, abortRef.current?.signal);
          if (token !== runTokenRef.current || !running) return;
          // Keep overlays clear; classification shows in panel below
          setBoxes?.([]);
          setMasks?.([]);
          setPoses?.([]);
          setClassResults(out.classes || []);
        } else if (mode === 'obb') {
          const out = await analyzeRealtimeObb(img, thr, imgSize, parsedClasses.length ? parsedClasses : undefined, abortRef.current?.signal);
          if (token !== runTokenRef.current || !running) return;
          setBoxes?.([]);
          setPoses?.([]);
          setClassResults([]);
          // Reuse mask overlay for OBB polygons
          setMasks?.((out.obb || []).map(o => ({ points: o.points, score: o.score, label: o.label })));
        }
      }
    } catch (e) {
      console.warn('[VisionRT] step failed:', e);
    }
  }, [getSnapshot, setBoxes, setMasks, setPoses, thr, parsedClasses, imgSize, mode, running]);

  const start = async () => {
    if (running) return;
    runTokenRef.current = Date.now();
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    abortRef.current = new AbortController();
    setRunning(true);
  };
  const stop = () => {
    setRunning(false);
    // Invalidate current run so late async results are ignored
    runTokenRef.current = 0;
    if (timerRef.current !== null) { try { clearTimeout(timerRef.current); } catch {} timerRef.current = null; }
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    setBoxes?.([]);
    setMasks?.([]);
    setPoses?.([]);
    setClassResults([]);
    };

  // Scheduler: single-flight loop that stops cleanly
  const pumpRef = React.useRef<null | ((token:number)=>void)>(null);
  pumpRef.current = (token: number) => {
    // Only continue if this invocation matches the current run token
    if (token !== runTokenRef.current || !running) return;
    step().finally(() => {
      if (token !== runTokenRef.current || !running) return;
      const delay = Math.max(50, intervalMs);
      timerRef.current = (setTimeout(() => {
        if (pumpRef.current) pumpRef.current(token);
      }, delay) as unknown) as number;
    });
  };

  React.useEffect(() => {
    // Clear any pending timeouts when changing running state
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (running) {
      const token = runTokenRef.current;
      if (pumpRef.current) pumpRef.current(token);
    }
    return () => { if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [running, intervalMs, step]);

  const [classResults, setClassResults] = React.useState<Array<{label:string; score:number}>>([]);

  const content = (
    <div className="flex flex-col gap-2 text-xs h-full">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-gray-400">Endpoint: {getRealtimeVisionUrl()}</div>
        <div className="flex items-center gap-2">
          {!running ? (
            <button className="px-2 py-1 rounded bg-green-700 hover:bg-green-600" onClick={start}>Start</button>
          ) : (
            <button className="px-2 py-1 rounded bg-red-700 hover:bg-red-600" onClick={stop}>Stop</button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">mode
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={mode} onChange={(e)=>setMode(e.target.value as any)}>
            <option value="detect">Detect</option>
            <option value="segment">Segment</option>
            <option value="pose">Pose</option>
            <option value="classify">Classify</option>
            <option value="obb">Oriented Box</option>
          </select>
        </label>
        <label className="flex items-center gap-1">thr
          <input type="range" min={0.05} max={0.50} step={0.01} value={thr} onChange={(e)=>setThr(parseFloat(e.target.value))} />
          <span className="text-gray-400">{thr.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-1">imgsz
          <input type="number" min={320} max={1280} step={32} value={imgSize} onChange={(e)=>setImgSize(parseInt(e.target.value||'640'))} className="w-20 bg-gray-800 px-2 py-1 rounded" />
        </label>
        <label className="flex items-center gap-1">interval(ms)
          <input type="number" min={50} max={2000} step={10} value={intervalMs} onChange={(e)=>setIntervalMs(parseInt(e.target.value||'150'))} className="w-20 bg-gray-800 px-2 py-1 rounded" />
        </label>
      </div>

      {mode === 'detect' && (
        <div className="flex-1 overflow-auto">
          <div className="text-[10px] text-gray-400 mb-1">Classes allowlist (optional, one per line)</div>
          <textarea className="w-full h-full bg-gray-800 text-gray-200 text-xs p-2 rounded"
            placeholder={"person\ncar\ntruck"}
            value={classesText}
            onChange={(e)=>setClassesText(e.target.value)}
          />
        </div>
      )}

      {mode === 'classify' && (
        <div className="flex-1 overflow-auto">
          <div className="text-[10px] text-gray-400 mb-1">Top classes</div>
          <ul className="text-xs text-gray-200 space-y-1">
            {classResults.map((c,i)=> (
              <li key={i}>{c.label} — {(c.score*100).toFixed(1)}%</li>
            ))}
          </ul>
        </div>
      )}
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
