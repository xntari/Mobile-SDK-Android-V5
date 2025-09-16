import React from 'react';

type Endpoints = {
  visionDetect: string;
  visionDescribe: string;
  visionGeneral: string;
  planner: string;
};

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialTab?: 'endpoints'|'models';
}

function loadEndpoints(): Endpoints {
  try { const raw = localStorage.getItem('settings.endpoints'); if (raw) return JSON.parse(raw); } catch {}
  return {
    visionDetect: (globalThis as any).__VISION_URL__ || 'http://127.0.0.1:9001/detect',
    visionDescribe: (globalThis as any).__DESCRIBE_URL__ || 'http://127.0.0.1:9001/describe',
    visionGeneral: (globalThis as any).__GENERAL_URL__ || 'http://127.0.0.1:9003/general/analyze',
    planner: (globalThis as any).__PLANNER_URL__ || 'http://127.0.0.1:9002/plan',
  };
}

function saveEndpoints(e: Endpoints) {
  try { localStorage.setItem('settings.endpoints', JSON.stringify(e)); } catch {}
  (globalThis as any).__VISION_URL__ = e.visionDetect;
  (globalThis as any).__DESCRIBE_URL__ = e.visionDescribe;
  (globalThis as any).__GENERAL_URL__ = e.visionGeneral;
  (globalThis as any).__PLANNER_URL__ = e.planner;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose, initialTab='endpoints' }) => {
  const [tab, setTab] = React.useState<'endpoints'|'models'>(initialTab);
  const [ep, setEp] = React.useState<Endpoints>(()=> loadEndpoints());

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center">
      <div className="glass-panel mt-10 w-[560px] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-gray-300">Settings</div>
          <button className="text-gray-400 hover:text-white text-sm" onClick={onClose}>Close</button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <button className={`px-2 py-1 text-xs rounded ${tab==='endpoints'?'bg-dji-blue text-white':'bg-gray-700 text-gray-200'}`} onClick={()=>setTab('endpoints')}>Endpoints</button>
          <button className={`px-2 py-1 text-xs rounded ${tab==='models'?'bg-dji-blue text-white':'bg-gray-700 text-gray-200'}`} onClick={()=>setTab('models')}>Models</button>
        </div>

        {tab==='endpoints' && (
          <div className="space-y-2 text-xs">
            <label className="block">Vision Detect URL
              <input className="w-full bg-gray-800 text-xs px-2 py-1 rounded mt-1" value={ep.visionDetect} onChange={e=>setEp({...ep, visionDetect:e.target.value})} />
            </label>
            <label className="block">Vision Describe URL
              <input className="w-full bg-gray-800 text-xs px-2 py-1 rounded mt-1" value={ep.visionDescribe} onChange={e=>setEp({...ep, visionDescribe:e.target.value})} />
            </label>
            <label className="block">General Vision URL
              <input className="w-full bg-gray-800 text-xs px-2 py-1 rounded mt-1" value={ep.visionGeneral} onChange={e=>setEp({...ep, visionGeneral:e.target.value})} />
            </label>
            <label className="block">Planner URL
              <input className="w-full bg-gray-800 text-xs px-2 py-1 rounded mt-1" value={ep.planner} onChange={e=>setEp({...ep, planner:e.target.value})} />
            </label>
            <div className="flex justify-end gap-2 mt-3">
              <button className="px-2 py-1 bg-gray-700 text-gray-200 rounded" onClick={()=> setEp(loadEndpoints())}>Reset</button>
              <button className="px-2 py-1 bg-dji-blue text-white rounded" onClick={()=> { saveEndpoints(ep); onClose(); }}>Save</button>
            </div>
          </div>
        )}

        {tab==='models' && (
          <div className="text-xs text-gray-300">
            <div className="mb-2">General vision model (server-side)</div>
            <div className="text-gray-400">Configure model selection in the general server via environment variables (e.g., QWEN_MODEL). This UI preserves endpoints only.</div>
          </div>
        )}
      </div>
    </div>
  );
};
