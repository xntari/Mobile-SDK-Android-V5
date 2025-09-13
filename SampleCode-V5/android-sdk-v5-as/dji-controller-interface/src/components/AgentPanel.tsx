import React, { useCallback, useMemo, useState } from 'react';
import { runFindMeasure, runInstruction } from '../agent/orchestrator';
import type { Detection } from '../agent/visionClient';
import { getActiveThreshold, setActiveThreshold } from '../agent/visionClient';

export interface AgentPanelProps {
  getSnapshot: () => Promise<string>;
  sendBridge: (msg: any) => Promise<any>;
  setDetections?: (boxes: Detection[]) => void;
  laserResult?: any;
}

export const AgentPanel: React.FC<AgentPanelProps> = ({ getSnapshot, sendBridge, setDetections, laserResult }) => {
  const [prompt, setPrompt] = useState('find person');
  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [result, setResult] = useState<string>('');
  const [status, setStatus] = useState<{ detector?: string; planner?: string }>(() => ({}));
  const [ribbon, setRibbon] = useState<Record<string, { state: 'running'|'done'|'error'; ms?: number }>>({});
  const [planSteps, setPlanSteps] = useState<any[] | null>(null);
  const [thr, setThr] = useState<number>(() => getActiveThreshold());
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({ x: window.innerWidth - 360 - 24, y: window.innerHeight - 320 - 24 }));
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 360, h: 240 });
  const dragRef = React.useRef<{ dx: number; dy: number; resizing: boolean } | null>(null);
  const cancelRef = React.useRef<{ cancelled: boolean }>({ cancelled: false });
  const [trace, setTrace] = useState<Array<{ text: string; kind: 'tool'|'var'|'info'|'warn'|'error' }>>([]);

  const log = useCallback((line: string) => {
    setLogLines(prev => [...prev.slice(-40), line]);
    if (line.startsWith('Detector:')) setStatus(s => ({ ...s, detector: line.replace(/^Detector:\s*/, '') }));
    if (line.startsWith('Planner:')) setStatus(s => ({ ...s, planner: line }));
  }, []);

  const onStep = useCallback((info: { id: string; state: 'running' | 'done' | 'error'; ms?: number }) => {
    setRibbon(prev => ({ ...prev, [info.id]: { state: info.state, ms: info.ms } }));
  }, []);

  const onRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResult('');
    setLogLines([]);
    try {
      // Try planner first, fallback to built-in flow
      setRibbon({});
      setPlanSteps(null);
      cancelRef.current.cancelled = false;
      await runInstruction(prompt.trim(), {
        getSnapshot,
        sendBridge,
        log,
        showDetections: setDetections,
        onResult: ({ text }) => setResult(text),
        onStep,
        onPlan: (steps) => setPlanSteps(steps),
        isCancelled: () => cancelRef.current.cancelled,
        onTrace: (line, kind='info') => setTrace(prev => [...prev, { text: line, kind }])
      });
    } finally {
      setRunning(false);
    }
  }, [prompt, running, getSnapshot, sendBridge, log, setDetections]);

  const onStop = useCallback(() => {
    cancelRef.current.cancelled = true;
    setRunning(false);
  }, []);

  // Log LRF results as they arrive
  React.useEffect(() => {
    if (!laserResult) return;
    try {
      const payload = (laserResult as any).data ?? laserResult;
      const d = payload?.distance_m;
      let ll = '';
      const lat = payload?.lat ?? payload?.latitude ?? payload?.waypoint?.lat ?? payload?.waypoint?.latitude;
      const lon = payload?.lon ?? payload?.longitude ?? payload?.waypoint?.lon ?? payload?.waypoint?.longitude;
      if (typeof lat === 'number' && typeof lon === 'number') {
        ll = ` @ ${lat.toFixed(5)},${lon.toFixed(5)}`;
      }
      if (typeof d !== 'undefined') {
        log(`LRF: ${d > 0 ? d.toFixed(1)+' m' : 'min 3 m / no return'}${ll}`);
        try { log(`LRF raw: ${JSON.stringify(payload)}`); } catch {}
      }
    } catch {}
  }, [laserResult]);

  const header = useMemo(() => (
    <div className="flex items-center justify-between mb-2 cursor-move select-text" onMouseDown={(e)=>{
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, resizing: false };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
      };
      const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    }}>
      <div className="text-xs text-gray-400 font-semibold">AGENT</div>
      <div className={`text-[10px] ${running ? 'text-green-400' : 'text-gray-500'}`}>{running ? 'running' : 'idle'}</div>
    </div>
  ), [running]);

  return (
    <div className="glass-panel p-2" style={{ position: 'fixed', left: pos.x, top: pos.y, width: size.w, height: size.h, resize: 'both' as any, overflow: 'hidden' }}>
      {header}
      {/* Status chips */}
      <div className="flex gap-1 mb-1 select-text">
        {status.detector && (
          <span className="px-1 py-[2px] bg-gray-800 rounded text-[10px] text-gray-300" title={status.detector}>detector</span>
        )}
        {status.planner && (
          <span className="px-1 py-[2px] bg-gray-800 rounded text-[10px] text-gray-300" title={status.planner}>planner</span>
        )}
      </div>
      {/* Tiny status ribbon */}
      <div className="flex flex-wrap gap-1 mb-1 text-[10px]">
        {['snapshot','detect','look_at','post_detect','laser_enable','laser_measure','respond'].map(id => {
          const st = ribbon[id]?.state || 'running';
          const ms = ribbon[id]?.ms;
          const label = id.replace('_',' ').toUpperCase();
          return (
            <span key={id} className={`px-1 py-[1px] rounded ${st==='done'?'bg-green-700 text-green-100':st==='error'?'bg-red-800 text-red-100':'bg-gray-700 text-gray-200'}`}
              title={ms? `${label} ${Math.round(ms)}ms` : label}>
              {label} {st==='done'?'✓':st==='error'?'✗':'…'}{ms? ` ${Math.round(ms)}ms`:''}
            </span>
          );
        })}
      </div>
      <div className="flex gap-1">
        <input
          className="flex-1 bg-gray-800 text-xs px-2 py-1 rounded outline-none select-text"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="e.g., find car"
        />
        <button
          className={`px-2 py-1 text-xs rounded ${running ? 'bg-gray-700 text-gray-400' : 'bg-dji-blue text-white'}`}
          onClick={onRun}
          disabled={running}
        >Run</button>
        <button
          className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-300"
          onClick={onStop}
        >Stop</button>
      </div>

      {/* Detector threshold quick presets */}
      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-300 select-text">
        <span>det thr:</span>
        {[0.15, 0.20, 0.25, 0.30].map(v => (
          <button
            key={v}
            className={`px-1.5 py-[2px] rounded ${Math.abs(thr - v) < 1e-6 ? 'bg-dji-blue text-white' : 'bg-gray-700 text-gray-200 hover:bg-gray-600'}`}
            onClick={() => { setThr(v); setActiveThreshold(v); log(`threshold set to ${v.toFixed(2)}`); }}
          >{v.toFixed(2)}</button>
        ))}
        <span className="text-gray-500">active {thr.toFixed(2)}</span>
      </div>

      {planSteps && planSteps.length > 0 && (
        <div className="mb-2 bg-gray-900/50 rounded p-1 text-[10px] text-gray-200 select-text" style={{ maxHeight: 80, overflowY: 'auto' }}>
          <div className="text-gray-400 mb-1">Plan Preview</div>
          {planSteps.map((s, i) => (
            <div key={i} className="whitespace-nowrap overflow-ellipsis overflow-hidden">
              {i+1}. {String(s.tool)} {formatArgs(s.args)}
            </div>
          ))}
        </div>
      )}

      {/* Execution trace */}
      {trace.length > 0 && (
        <div className="mb-2 bg-gray-900/60 rounded p-1 text-[10px] select-text" style={{ maxHeight: 120, overflowY: 'auto' }}>
          <div className="text-gray-400 mb-1">Execution</div>
          {trace.map((t, i) => (
            <div key={i} className={t.kind==='tool'? 'text-blue-300' : t.kind==='var'? 'text-yellow-300' : t.kind==='error'? 'text-red-300' : t.kind==='warn'? 'text-orange-300' : 'text-gray-300'}>
              {t.text}
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="mt-2 text-xs text-gray-200 select-text">{result}</div>
      )}

      <div className="mt-2 h-[calc(100%-90px)] overflow-y-auto bg-gray-900/40 rounded p-1 text-[10px] font-mono text-gray-400 select-text">
        {logLines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
};

function formatArgs(args: any): string {
  try {
    if (!args || typeof args !== 'object') return '';
    const pairs = Object.entries(args).map(([k, v]) => {
      if (typeof v === 'number') return `${k}:${v.toFixed(3).replace(/\.000$/, '')}`;
      return `${k}:${String(v)}`;
    });
    return pairs.length ? `{ ${pairs.join(' ')} }` : '';
  } catch {
    try { return JSON.stringify(args); } catch { return ''; }
  }
}
