import React from 'react';
import { Panel, createPanelControls } from './Panel';
import { analyzeRealtime, analyzeRealtimeSegment, getRealtimeVisionUrl } from '../agent/visionClient';
import { analyzeRealtimePromptImage } from '../agent/visionPromptClient';
import type { Detection } from '../agent/visionClient';

export const visionRTPanelControls = createPanelControls('visionrt.panel', 'visionrtPanelVisibilityChange');

export interface VisionRealtimePanelProps {
  getSnapshot: () => Promise<string>;
  setBoxes?: (boxes: Array<{ x1:number; y1:number; x2:number; y2:number; score:number; label?:string }>) => void;
  setMasks?: (masks: Array<{ points: Array<{x:number;y:number}>; score?: number; label?: string }>) => void;
  setPoses?: (poses: Array<Array<{x:number;y:number;conf?:number}>>) => void;
  setMaskOpacity?: (v:number)=>void;
  setColorizeById?: (v:boolean)=>void;
  setDetectThickness?: (v:number)=>void;
}

export const VisionRealtimePanel: React.FC<VisionRealtimePanelProps> = ({ getSnapshot, setBoxes, setMasks, setPoses, setMaskOpacity, setColorizeById, setDetectThickness }) => {
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
  const [mode, setMode] = React.useState<'detect'|'segment'|'prompt'>(() => {
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
      } else if (mode === 'prompt') {
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
        } else if (currentMode === 'prompt') {
          console.log('[VisionRT] Sending prompt detect request...');
          const out = await analyzeRealtime({ imageBase64: img, threshold: currentThr, classes: currentClasses, img_size: currentImgSize, signal: abortRef.current?.signal });
          console.log('[VisionRT] Prompt detect response received:', out.detections?.length, 'detections');
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

  const ImagePromptSection: React.FC<{ getSnapshot: ()=>Promise<string>; setBoxes?: (b:any[])=>void }>= ({ getSnapshot, setBoxes }) => {
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
        console.warn('[VisionRT] prompt preview failed:', e);
        setPromptInfo(`extract error: ${msg}`);
      }
    };
    const detectWithPrompt = async () => {
      try {
        if (!promptImage) { setPromptInfo('no prompt image'); return; }
        const img = await getSnapshot();
        const out = await analyzeRealtimePromptImage(img, promptImage, imgSize, abortRef.current?.signal);
        setBoxes?.(out.boxes || []);
        setPromptInfo(`prompt detect: ${out.boxes?.length||0} boxes`);
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        console.warn('[VisionRT] prompt detect failed:', e);
        setPromptInfo(`detect error: ${msg}`);
      }
    };
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[10px] text-gray-400">1) Run Detect (normal) Step to populate list, 2) Select item, 3) Extract and Detect (prompt)</div>
        <div className="flex items-center gap-2">
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={selectedIndex} onChange={(e)=>setSelectedIndex(parseInt(e.target.value))}>
            <option value={-1}>Select object…</option>
            {lastDetections.map((d, i)=> <option key={i} value={i}>{d.label || `obj_${i}`}</option>)}
          </select>
          <button className="px-2 py-1 rounded bg-indigo-700 hover:bg-indigo-600" onClick={makePreview} disabled={selectedIndex<0}>Extract</button>
          <button className="px-2 py-1 rounded bg-teal-700 hover:bg-teal-600" onClick={detectWithPrompt} disabled={!promptImage}>Detect (prompt)</button>
        </div>
        {promptImage && (
          <div>
            <div className="text-[10px] text-gray-400 mb-1">Prompt image preview</div>
            <img src={promptImage} alt="prompt" className="max-w-full max-h-40 border border-gray-600" />
          </div>
        )}
        {promptInfo && <div className="text-[10px] text-gray-400">{promptInfo}</div>}
      </div>
    );
  };

  const content = (
    <div className="flex flex-col gap-2 text-xs h-full">
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

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">mode
          <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={mode} onChange={(e)=>setMode(e.target.value as any)}>
            <option value="detect">Detect</option>
            <option value="segment">Segment</option>
            <option value="prompt">Image Prompt</option>
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

      {mode === 'prompt' && (
        <ImagePromptSection getSnapshot={getSnapshot} setBoxes={setBoxes} />
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
