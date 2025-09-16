import React from 'react';
import { analyzeDetect, setActiveThreshold, getGeneralVisionUrl } from '../agent/visionClient';

type Detection = { x1:number; y1:number; x2:number; y2:number; score:number; label?:string };

export interface VisionPanelProps {
  getSnapshot: () => Promise<string>;
  setBoxes?: (boxes: Detection[]) => void; // overlay boxes on the active camera view
}

function getGeneralUrl(): string { return getGeneralVisionUrl(); }

export const VisionPanel: React.FC<VisionPanelProps> = ({ getSnapshot, setBoxes }) => {
  const [pos, setPos] = React.useState<{x:number;y:number}>(()=>{
    try { const raw = localStorage.getItem('vision.panel.pos'); if (raw) return JSON.parse(raw); } catch {}
    return { x: 24, y: 24 };
  });
  const [size, setSize] = React.useState<{w:number;h:number}>(()=>{
    try { const raw = localStorage.getItem('vision.panel.size'); if (raw) return JSON.parse(raw); } catch {}
    return { w: 360, h: 300 }; 
  });
  const [thr, setThr] = React.useState<number>(()=>{
    try { const v = JSON.parse(localStorage.getItem('vision.thr')||'0.1'); if (typeof v==='number') return v; } catch{}
    return 0.10;
  });
  const [objects, setObjects] = React.useState<Array<{label:string;count?:number;score?:number}>>([]);
  const [objText, setObjText] = React.useState<string>(()=> localStorage.getItem('vision.objText') || '');
  const [caption, setCaption] = React.useState<string>('');
  const [query, setQuery] = React.useState<string>('');
  const [answer, setAnswer] = React.useState<string>('');
  const [busy, setBusy] = React.useState<boolean>(false);
  const [boxesOn, setBoxesOn] = React.useState<boolean>(false);
  const dragRef = React.useRef<{dx:number;dy:number}|null>(null);
  const panelRef = React.useRef<HTMLDivElement|null>(null);

  React.useEffect(()=>{ try{ localStorage.setItem('vision.panel.pos', JSON.stringify(pos)); }catch{} }, [pos]);
  React.useEffect(()=>{ try{ localStorage.setItem('vision.thr', JSON.stringify(thr)); }catch{} }, [thr]);
  React.useEffect(()=>{
    if (!panelRef.current) return;
    const el = panelRef.current;
    const ro = new ResizeObserver(()=>{
      const r = el.getBoundingClientRect();
      const s = { w: Math.round(r.width), h: Math.round(r.height) };
      setSize(s);
      try { localStorage.setItem('vision.panel.size', JSON.stringify(s)); } catch {}
    });
    ro.observe(el);
    return ()=>ro.disconnect();
  },[]);
  React.useEffect(()=>{ try{ localStorage.setItem('vision.objText', objText);}catch{} }, [objText]);

  async function callGeneral(params: { question?: string; task?: 'objects'|'describe'|'query' }): Promise<{ objects?: any[]; caption?: string; answer?: string }>{
    const img = await getSnapshot();
    const res = await fetch(getGeneralUrl(), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ image: img, question: params.question, task: params.task, threshold: thr, top_k: 50 })});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  const runBoxes = async () => {
    if (busy) return; setBusy(true);
    try {
      // Use the editable text form. If empty, fetch objects first.
      let labels = objText.split(/\n|,|;/).map(s=>s.trim()).filter(Boolean);
      if (labels.length === 0) {
        const out = await callGeneral({ task: 'objects' });
        const list: Array<{label:string;count?:number}> = Array.isArray(out.objects) ? out.objects : [];
        labels = Array.from(new Set(list.map(o=>String(o.label||'').trim()).filter(Boolean)));
        setObjects(list);
        setObjText(labels.join('\n'));
      }
      labels = labels.slice(0, 10);
      // 2) For each label, call OWL-ViT detector to get boxes
      const all: Detection[] = [];
      setActiveThreshold(thr);
      for (const label of labels) {
        try {
          const img = await getSnapshot();
          const det = await analyzeDetect({ imageBase64: img, query: label });
          (det.detections||[]).forEach(d=> all.push({ ...d, label }));
        } catch {}
      }
      setBoxes?.(all);
    } catch (e) {
      console.warn('[Vision] boxes failed:', e);
      setBoxes?.([]);
    } finally { setBusy(false); }
  };

  const runFindObjects = async () => {
    if (busy) return; setBusy(true);
    try {
      const out = await callGeneral({ task: 'objects' });
      const list = Array.isArray(out.objects) ? out.objects : [];
      setObjects(list);
      const labels = Array.from(new Set(list.map((o:any)=>String(o.label||'').trim()).filter(Boolean)));
      setObjText(labels.join('\n'));
    } catch (e) {
      console.warn('[Vision] find objects failed:', e);
      setObjects([]);
    } finally { setBusy(false); }
  };

  const runDescribe = async () => {
    if (busy) return; setBusy(true);
    try {
      const out = await callGeneral({ task: 'describe' });
      setCaption(out.caption || '');
    } catch (e) {
      console.warn('[Vision] describe failed:', e);
      setCaption('');
    } finally { setBusy(false); }
  };

  const runQuery = async () => {
    if (!query.trim()) return;
    if (busy) return; setBusy(true);
    try {
      const out = await callGeneral({ task: 'query', question: query.trim() });
      setAnswer(out.answer || '');
    } catch (e) {
      console.warn('[Vision] query failed:', e);
      setAnswer('');
    } finally { setBusy(false); }
  };

  const header = (
    <div className="flex items-center justify-between mb-2 cursor-move select-text"
      onMouseDown={(e)=>{
        dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        const onMove = (ev:MouseEvent)=>{ if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy }); };
        const onUp = ()=>{ dragRef.current=null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
      }}>
      <div className="text-xs text-gray-400 font-semibold">VISION</div>
      <div className={`text-[10px] ${busy? 'text-green-400':'text-gray-500'}`}>{busy? 'busy':'idle'}</div>
    </div>
  );

  return (
    <div ref={panelRef} className="glass-panel p-2" style={{ position: 'fixed', left: pos.x, top: pos.y, width: size.w, height: size.h, minWidth: 320, minHeight: 260, resize: 'both' as any, overflow: 'hidden', zIndex: 50 }}>
      {header}
      <div className="mb-2 text-[10px] text-gray-300 select-text">thr
        <input type="range" min={0.05} max={0.20} step={0.01} value={thr} onChange={(e)=>setThr(parseFloat(e.target.value))} className="mx-2 align-middle" />
        <span className="text-gray-400">{thr.toFixed(2)}</span>
      </div>

      {/* Find objects */}
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200" onClick={runFindObjects}>Find objects</button>
          <span className="text-[10px] text-gray-400">List detected objects</span>
        </div>
        {/* Editable object list used by Boxes */}
        <div className="mt-1">
          <textarea className="w-full bg-gray-800 text-xs p-1 rounded text-gray-200" rows={5}
            placeholder={'Enter one label per line, e.g.\nchair\nsofa\nplant'}
            value={objText} onChange={(e)=>setObjText(e.target.value)} />
          <div className="text-[10px] text-gray-500 mt-1">One label per line. Boxes uses this list.</div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <button className={`px-2 py-1 text-xs rounded ${boxesOn? 'bg-green-700 text-white':'bg-gray-700 text-gray-200 hover:bg-gray-600'}`}
            onClick={async()=>{
              if (boxesOn) { setBoxes?.([]); setBoxesOn(false); }
              else { setBoxesOn(true); await runBoxes(); }
            }}>
            Boxes {boxesOn? 'On':'Off'}
          </button>
          <span className="text-[10px] text-gray-400">Draw bounding boxes using OWL‑ViT for labels above</span>
        </div>
      </div>

      {/* Describe */}
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200" onClick={runDescribe}>Describe</button>
          <span className="text-[10px] text-gray-400">Short scene description</span>
        </div>
        {caption && (<div className="mt-1 bg-gray-900/60 rounded p-1 text-[10px] text-gray-200 select-text" style={{ maxHeight: 80, overflowY: 'auto' }}>{caption}</div>)}
      </div>

      {/* Query */}
      <div>
        <div className="flex items-center gap-1">
          <input className="flex-1 bg-gray-800 text-xs px-2 py-1 rounded outline-none select-text" placeholder="Ask a question about the image" value={query} onChange={(e)=>setQuery(e.target.value)} />
          <button className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200" onClick={runQuery}>Query</button>
        </div>
        {answer && (<div className="mt-1 text-[10px] text-gray-200 select-text">{answer}</div>)}
      </div>
    </div>
  );
};
