import React, { useCallback, useMemo, useState } from 'react';
import { runInstruction } from '../agent/orchestrator';
import type { Detection } from '../agent/visionClient';
import { getActiveThreshold, setActiveThreshold } from '../agent/visionClient';

export interface AgentPanelProps {
  getSnapshot: () => Promise<string>;
  sendBridge: (msg: any) => Promise<any>;
  setDetections?: (boxes: Detection[]) => void;
  laserResult?: any;
}

// Global visibility controls for Components menu
export const agentPanelControls = {
  isVisible: (): boolean => {
    try {
      const raw = localStorage.getItem('agent.panel.visible');
      return raw ? JSON.parse(raw) : true;
    } catch {
      return true;
    }
  },
  setVisible: (visible: boolean): void => {
    try {
      localStorage.setItem('agent.panel.visible', JSON.stringify(visible));
      // Trigger a custom event to notify the panel
      window.dispatchEvent(new CustomEvent('agentPanelVisibilityChange', { detail: visible }));
    } catch {}
  }
};

export const AgentPanel: React.FC<AgentPanelProps> = ({ getSnapshot, sendBridge, setDetections, laserResult }) => {
  const [prompt, setPrompt] = useState('find person');
  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [result, setResult] = useState<string>('');
  const [status, setStatus] = useState<{ detector?: string; planner?: string }>(() => ({}));
  const [ribbon, setRibbon] = useState<Record<string, { state: 'running'|'done'|'error'; ms?: number }>>({});
  const [planSteps, setPlanSteps] = useState<any[] | null>(null);
  const [planProgram, setPlanProgram] = useState<any | null>(null);
  const [planProgramHigh, setPlanProgramHigh] = useState<any | null>(null);
  const [programView, setProgramView] = useState<'final'|'high'>('final');
  const [planErrors, setPlanErrors] = useState<Array<{ message: string; path?: string }>>([]);
  const [thr, setThr] = useState<number>(() => getActiveThreshold());
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('agent.panel.visible');
      return raw ? JSON.parse(raw) : true;
    } catch {}
    return true;
  });
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem('agent.panel.pos');
      if (raw) return JSON.parse(raw);
    } catch {}
    return { x: window.innerWidth - 460 - 24, y: window.innerHeight - 420 - 24 };
  });
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem('agent.panel.size');
      if (raw) return JSON.parse(raw);
    } catch {}
    return { w: 460, h: 420 };
  });
  const dragRef = React.useRef<{ dx: number; dy: number; resizing: boolean } | null>(null);
  const cancelRef = React.useRef<{ cancelled: boolean }>({ cancelled: false });
  const [trace, setTrace] = useState<Array<{ text: string; kind: 'tool'|'var'|'info'|'warn'|'error' }>>([]);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  // Persist panel size across restarts
  usePersistPanelSize(panelRef, (s) => setSize(s));
  const programRef = React.useRef<HTMLDivElement | null>(null);
  const execRef = React.useRef<HTMLDivElement | null>(null);
  usePersistElementHeight(programRef, 'agent.h.program', 180);
  usePersistElementHeight(execRef, 'agent.h.exec', 220);
  const planRef = React.useRef<HTMLDivElement | null>(null);
  usePersistElementHeight(planRef, 'agent.h.plan', 120);

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
      setPlanProgram(null);
      setPlanErrors([]);
      cancelRef.current.cancelled = false;
      await runInstruction(prompt.trim(), {
        getSnapshot,
        sendBridge,
        log,
        showDetections: setDetections,
        onResult: ({ text }) => setResult(text),
        onStep,
        onPlan: (steps) => setPlanSteps(steps),
        onProgram: (program) => setPlanProgram(program),
        onHighLevelProgram: (hp) => setPlanProgramHigh(hp),
        isCancelled: () => cancelRef.current.cancelled,
        onTrace: (line, kind='info') => setTrace(prev => [...prev, { text: line, kind }]),
        onPlanErrors: (errs) => setPlanErrors(errs)
      });
    } finally {
      setRunning(false);
    }
  }, [prompt, running, getSnapshot, sendBridge, log, setDetections]);

  const onStop = useCallback(() => {
    cancelRef.current.cancelled = true;
    setRunning(false);
  }, []);

  // Persist position and visibility when they change
  React.useEffect(() => {
    try { localStorage.setItem('agent.panel.pos', JSON.stringify(pos)); } catch {}
  }, [pos]);

  React.useEffect(() => {
    try { localStorage.setItem('agent.panel.visible', JSON.stringify(visible)); } catch {}
  }, [visible]);

  // Listen for external visibility changes
  React.useEffect(() => {
    const handleVisibilityChange = (e: CustomEvent) => {
      setVisible(e.detail);
    };
    window.addEventListener('agentPanelVisibilityChange', handleVisibilityChange as EventListener);
    return () => window.removeEventListener('agentPanelVisibilityChange', handleVisibilityChange as EventListener);
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

  // Auto-scroll execution trace while running
  React.useEffect(() => {
    if (!execRef.current) return;
    execRef.current.scrollTop = execRef.current.scrollHeight;
  }, [trace.length]);

  const header = useMemo(() => (
    <div className="flex items-center justify-between mb-2 cursor-move select-text" onMouseDown={(e)=>{
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, resizing: false };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        try { localStorage.setItem('agent.panel.pos', JSON.stringify(pos)); } catch {}
      };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    }}>
      <div className="text-xs text-gray-400 font-semibold">AGENT</div>
      <div className="flex items-center gap-2">
        <div className={`text-[10px] ${running ? 'text-green-400' : 'text-gray-500'}`}>{running ? 'running' : 'idle'}</div>
        <button
          className="text-[10px] text-gray-400 hover:text-white"
          onClick={(e) => { e.stopPropagation(); setVisible(false); }}
          title="Hide panel"
        >✕</button>
      </div>
    </div>
  ), [running, pos]);

  return (
    <div ref={panelRef} className="glass-panel p-2" style={{
      position: 'fixed',
      left: pos.x,
      top: pos.y,
      width: size.w,
      height: size.h,
      minWidth: 320,
      minHeight: 260,
      resize: 'both' as any,
      overflow: 'hidden',
      display: visible ? 'block' : 'none' // Hide without unmounting
    }}>
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

      {planErrors.length > 0 && (
        <div className="mb-2 bg-red-950/70 rounded p-2 text-[10px] text-red-200 select-text" style={{ maxHeight: 120, overflowY: 'auto' }}>
          <div className="text-red-300 mb-1">Plan errors</div>
          {planErrors.map((e, i) => (
            <div key={i}>• {e.message}{e.path ? ` (${e.path})` : ''}</div>
          ))}
        </div>
      )}

      {/* Pretty JSON program preview w/ toggle */}
      {(planProgram || planProgramHigh) && (
        <div ref={programRef} className="mb-2 bg-gray-900/60 rounded p-1 text-[10px] text-gray-200 select-text font-mono" style={{ height: 180, overflowY: 'auto', resize: 'vertical' as any }}>
          <div className="flex items-center justify-between text-gray-400 mb-1">
            <div>Program</div>
            <div className="flex gap-1">
              <button className={`px-1 py-[1px] rounded ${programView==='final'?'bg-dji-blue text-white':'bg-gray-700 text-gray-200'}`} onClick={()=>setProgramView('final')}>Final</button>
              <button className={`px-1 py-[1px] rounded ${programView==='high'?'bg-dji-blue text-white':'bg-gray-700 text-gray-200'}`} onClick={()=>setProgramView('high')}>High-level</button>
            </div>
          </div>
          <pre className="whitespace-pre-wrap leading-tight">{safeStringify(programView==='final'? planProgram : planProgramHigh)}</pre>
        </div>
      )}

      {planSteps && planSteps.length > 0 && (
        <div ref={planRef} className="mb-2 bg-gray-900/50 rounded p-1 text-[10px] text-gray-200 select-text" style={{ height: 120, overflowY: 'auto', resize: 'vertical' as any }}>
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
        <div ref={execRef} className="mb-2 bg-gray-900/60 rounded p-1 text-[10px] select-text" style={{ height: 220, overflowY: 'auto', resize: 'vertical' as any }}>
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

function safeStringify(obj: any): string {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

// Persist size whenever user resizes the panel
export function usePersistPanelSize(ref: React.RefObject<HTMLDivElement>, setSize: (s:{w:number;h:number})=>void) {
  React.useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const s = { w: Math.round(rect.width), h: Math.round(rect.height) };
      // Only update if panel has actual size (not hidden with display:none)
      if (s.w > 0 && s.h > 0) {
        setSize(s);
        try { localStorage.setItem('agent.panel.size', JSON.stringify(s)); } catch {}
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

// Persist child panel height via ResizeObserver; set initial height if available
function usePersistElementHeight(ref: React.RefObject<HTMLDivElement>, storageKey: string, defaultHeight: number) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const h = Math.max(80, Math.min(800, Number(JSON.parse(raw)) || defaultHeight));
        el.style.height = `${h}px`;
      } else {
        el.style.height = `${defaultHeight}px`;
      }
    } catch {
      el.style.height = `${defaultHeight}px`;
    }
    const ro = new ResizeObserver(() => {
      try { localStorage.setItem(storageKey, JSON.stringify(Math.round(el.clientHeight))); } catch {}
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, storageKey, defaultHeight]);
}
