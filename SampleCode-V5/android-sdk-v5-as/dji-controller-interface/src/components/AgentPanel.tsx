import React, { useCallback, useMemo, useState } from 'react';
import { runInstruction, type PlannerMetaSnapshot, type PlannerStreamEvent } from '../agent/orchestrator';
import type { Detection } from '../agent/visionClient';
import { getActiveThreshold, setActiveThreshold } from '../agent/visionClient';
import { getNextZIndex, getBaseZIndex } from '../utils/zIndex';
import { CollapsibleSection, SectionLabel } from './CollapsibleSection';
import { agentTelemetryStore, AgentTelemetrySnapshot } from '../state/agentTelemetry';
import { getQueueSummary, subscribe as subscribeCommandQueue } from '../agent/commandQueue';
import { plannerSettingsStore, type PlannerSettingsSnapshot, type PlannerEngine, type ReasoningEffort } from '../state/plannerSettings';

export interface AgentPanelProps {
  getSnapshot: () => Promise<string>;
  sendBridge: (msg: any) => Promise<any>;
  setDetections?: (boxes: Detection[]) => void;
  laserResult?: any;
}

type ExecutionEvent = {
  key: string;
  tool: string;
  state: 'running' | 'done' | 'error';
  ms?: number;
  startedAt: number;
};

const TOOL_DISPLAY: Record<string, { label: string; category: 'flight' | 'mission' | 'vision' | 'gimbal' | 'sensor' | 'ui'; icon?: string }> = {
  snapshot: { label: 'Snapshot', category: 'vision', icon: '📷' },
  detect: { label: 'Detect', category: 'vision', icon: '🧠' },
  look_at: { label: 'Look At', category: 'gimbal', icon: '🎯' },
  laser_enable: { label: 'Laser Enable', category: 'sensor', icon: '🔦' },
  laser_measure: { label: 'Laser Measure', category: 'sensor', icon: '📏' },
  mission_self_check: { label: 'Self Check', category: 'flight', icon: '🩺' },
  flight_takeoff: { label: 'Take Off', category: 'flight', icon: '⤴' },
  flight_land: { label: 'Land', category: 'flight', icon: '⤵' },
  flight_rth: { label: 'Return Home', category: 'flight', icon: '🏠' },
  mission_fly_to: { label: 'Fly-To', category: 'mission', icon: '➡️' },
  mission_relative_move: { label: 'Relative Move', category: 'mission', icon: '⇢' },
  mission_waypoint_plan: { label: 'Waypoint Plan', category: 'mission', icon: '🗺' },
  mission_scan: { label: 'Mission Scan', category: 'mission', icon: '📡' },
  mission_patrol: { label: 'Mission Patrol', category: 'mission', icon: '🔁' },
  respond: { label: 'Respond', category: 'ui', icon: '💬' },
  sleep: { label: 'Sleep', category: 'ui', icon: '⏱' },
};

const FLIGHT_TOOLS = new Set([
  'mission_self_check',
  'flight_takeoff',
  'flight_land',
  'flight_rth',
  'mission_fly_to',
  'mission_relative_move',
  'mission_waypoint_plan',
  'mission_scan',
  'mission_patrol',
]);

const MAX_CONVERSATION_MESSAGES = 80;

const EXAMPLE_PROMPTS: Array<{ title: string; prompt: string; note?: string }> = [
  {
    title: 'Pre-flight check',
    prompt: 'Run a mission self check and report any blockers.',
  },
  {
    title: 'Takeoff & hover',
    prompt: 'Perform a self check, take off, and hold position at 25 meters.',
  },
  {
    title: 'Return and land',
    prompt: 'Return home and land safely.',
  },
  {
    title: 'Ascend to absolute altitude',
    prompt: 'Ascend to 20 meters and hold position.',
    note: 'Absolute altitude target via mission_fly_to.',
  },
  {
    title: 'Ascend by delta',
    prompt: 'Increase altitude by 10 meters.',
    note: 'Relative climb via mission_relative_move.',
  },
  {
    title: 'Descend to altitude',
    prompt: 'Descend to 12 meters and hold.',
  },
  {
    title: 'Descend by delta',
    prompt: 'Descend by 5 meters.',
  },
  {
    title: 'Fly forward',
    prompt: 'Fly forward 10 meters.',
  },
  {
    title: 'Fly back',
    prompt: 'Fly back 10 meters.',
  },
  {
    title: 'Fly lateral',
    prompt: 'Fly left 10 meters, then right 10 meters.',
  },
  {
    title: 'Cardinal move',
    prompt: 'Fly north 20 meters and report when done.',
  },
];

type PlannerMessageDisplay = { id: string; role: string; text: string };

const describeOverrideValue = (value: any): string => {
  if (value === null || value === undefined) return 'default';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : 'NaN';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

type QueueSummary = ReturnType<typeof getQueueSummary>;
type QueueItem = QueueSummary['pending'][number];
type ConversationEntry = {
  id: string;
  role: 'user' | 'planner';
  text: string;
  timestamp: number;
  streaming?: boolean;
};

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
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [status, setStatus] = useState<{ detector?: string; planner?: string }>(() => ({}));
  const [timeline, setTimeline] = useState<ExecutionEvent[]>([]);
  const pendingStepsRef = React.useRef<Record<string, string[]>>({});
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
  const [telemetry, setTelemetry] = useState<AgentTelemetrySnapshot>(() => agentTelemetryStore.getSnapshot());
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
  const [zIndex, setZIndex] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('agent.panel.zIndex');
      return stored ? parseInt(stored) : getBaseZIndex();
    } catch {
      return getBaseZIndex();
    }
  });
  const dragRef = React.useRef<{ dx: number; dy: number; resizing: boolean } | null>(null);
  const cancelRef = React.useRef<{ cancelled: boolean }>({ cancelled: false });
  const [trace, setTrace] = useState<Array<{ text: string; kind: 'tool'|'var'|'info'|'warn'|'error' }>>([]);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  // Persist panel size across restarts
  usePersistPanelSize(panelRef, (s) => setSize(s));
  React.useEffect(()=>{ try{ localStorage.setItem('agent.panel.zIndex', zIndex.toString());}catch{} }, [zIndex]);
  const programRef = React.useRef<HTMLDivElement | null>(null);
  const execRef = React.useRef<HTMLDivElement | null>(null);
  usePersistElementHeight(programRef, 'agent.h.program', 180);
  usePersistElementHeight(execRef, 'agent.h.exec', 220);
  const planRef = React.useRef<HTMLDivElement | null>(null);
  usePersistElementHeight(planRef, 'agent.h.plan', 120);
  const [queueSummary, setQueueSummary] = useState<QueueSummary>(() => getQueueSummary());
  const conversationContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [plannerSettings, setPlannerSettings] = React.useState<PlannerSettingsSnapshot>(() => plannerSettingsStore.getSnapshot());
  const [plannerMeta, setPlannerMeta] = React.useState<PlannerMetaSnapshot | null>(null);
  const [plannerStream, setPlannerStream] = React.useState<PlannerStreamEvent[]>([]);
  const [lastInstruction, setLastInstruction] = React.useState<string | null>(null);
  const streamingIdRef = React.useRef<string | null>(null);

  const handleClearConversation = useCallback(() => {
    setConversation([]);
    streamingIdRef.current = null;
  }, []);

  const finalizeStreamingEntry = useCallback(() => {
    const id = streamingIdRef.current;
    if (!id) return;
    streamingIdRef.current = null;
    setConversation((prev) => prev.map((entry) => (entry.id === id ? { ...entry, streaming: false } : entry)));
  }, []);

  React.useEffect(() => {
    return agentTelemetryStore.subscribe((snapshot) => {
      setTelemetry(snapshot);
    });
  }, []);

  React.useEffect(() => {
    const unsubscribe = subscribeCommandQueue(() => {
      setQueueSummary(getQueueSummary());
    });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    if (conversationContainerRef.current) {
      conversationContainerRef.current.scrollTop = 0;
    }
  }, [conversation]);

  React.useEffect(() => plannerSettingsStore.subscribe(setPlannerSettings), []);

  const log = useCallback((line: string) => {
    setLogLines(prev => [...prev.slice(-40), line]);
    if (line.startsWith('Detector:')) setStatus(s => ({ ...s, detector: line.replace(/^Detector:\s*/, '') }));
    if (line.startsWith('Planner:')) setStatus(s => ({ ...s, planner: line }));
  }, []);

  const queueSummaryLabel = useMemo(() => {
    const parts: string[] = [];
    if (queueSummary.active) {
      parts.push(`Active ${queueSummary.active.tool}`);
    }
    if (queueSummary.pending.length) {
      parts.push(`${queueSummary.pending.length} pending`);
    }
    if (queueSummary.paused) {
      parts.push('paused');
    }
    if (parts.length === 0) {
      return queueSummary.paused ? 'Paused' : 'Idle';
    }
    return parts.join(' · ');
  }, [queueSummary]);

  const onStep = useCallback((info: { id: string; state: 'running' | 'done' | 'error'; ms?: number }) => {
    setTimeline((prev) => {
      if (info.state === 'running') {
        const key = `${info.id}-${performance.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const stack = pendingStepsRef.current[info.id] ?? [];
        pendingStepsRef.current[info.id] = [...stack, key];
        return [
          ...prev,
          {
            key,
            tool: info.id,
            state: 'running',
            ms: info.ms,
            startedAt: Date.now(),
          },
        ];
      }

      const stack = pendingStepsRef.current[info.id];
      if (!stack || stack.length === 0) {
        return prev;
      }
      const key = stack[stack.length - 1];
      pendingStepsRef.current[info.id] = stack.slice(0, -1);

      return prev.map((entry) =>
        entry.key === key
          ? { ...entry, state: info.state, ms: info.ms ?? entry.ms }
          : entry
      );
    });
  }, []);

  const executeInstruction = useCallback(async (text: string, options?: { engineOverride?: PlannerEngine; label?: string }) => {
    if (running) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const timestamp = Date.now();
    setRunning(true);
    setResult('');
    setLogLines([]);
    setPlanSteps(null);
    setPlanProgram(null);
    setPlanProgramHigh(null);
    setPlanErrors([]);
    setTrace([]);
    setTimeline([]);
    setPlannerMeta(null);
    setPlannerStream([]);
    streamingIdRef.current = null;
    setLastInstruction(trimmed);
    pendingStepsRef.current = {};
    cancelRef.current.cancelled = false;
    setConversation((prev) => {
      const prefix = options?.label ? `[${options.label}] ` : '';
      const entry: ConversationEntry = { id: `user:${timestamp}`, role: 'user', text: `${prefix}${trimmed}`, timestamp };
      const next: ConversationEntry[] = [...prev, entry];
      return next.slice(-MAX_CONVERSATION_MESSAGES);
    });
    try {
      await runInstruction(trimmed, {
        getSnapshot,
        sendBridge,
        log,
        showDetections: setDetections,
        onResult: ({ text }) => {
          setResult(text);
          const response = text?.trim();
          if (response) {
            const ts = Date.now();
            const entry: ConversationEntry = { id: `planner:${ts}`, role: 'planner', text: response, timestamp: ts };
            setConversation((prev) => {
              const next: ConversationEntry[] = [...prev, entry];
              return next.slice(-MAX_CONVERSATION_MESSAGES);
            });
          }
        },
        onStep,
        onPlan: (steps) => setPlanSteps(steps),
        onProgram: (program) => setPlanProgram(program),
        onHighLevelProgram: (hp) => setPlanProgramHigh(hp),
        isCancelled: () => cancelRef.current.cancelled,
        onTrace: (line, kind='info') => setTrace(prev => [...prev, { text: line, kind }]),
        onPlanErrors: (errs) => setPlanErrors(errs),
        onPlannerMeta: (meta) => setPlannerMeta(meta),
        onPlannerStream: (event) => {
          setPlannerStream((prev) => [...prev.slice(-200), event]);

          switch (event.type) {
            case 'token':
            case 'message_chunk': {
              const addition = event.text ?? '';
              if (!addition) break;
              setConversation((prev) => {
                const now = Date.now();
                const id = streamingIdRef.current ?? `planner:stream:${now}`;
                if (!streamingIdRef.current) {
                  streamingIdRef.current = id;
                }
                const existingIndex = prev.findIndex((entry) => entry.id === id);
                if (existingIndex >= 0) {
                  const updated = {
                    ...prev[existingIndex],
                    text: prev[existingIndex].text + addition,
                    timestamp: now,
                    streaming: true,
                  } as ConversationEntry;
                  const next = [...prev];
                  next[existingIndex] = updated;
                  return next;
                }
                const entry: ConversationEntry = {
                  id,
                  role: 'planner',
                  text: addition,
                  timestamp: now,
                  streaming: true,
                };
                const next = [...prev, entry];
                if (next.length > MAX_CONVERSATION_MESSAGES) {
                  return next.slice(-MAX_CONVERSATION_MESSAGES);
                }
                return next;
              });
              break;
            }
            case 'status': {
              if (event.stage === 'program_ready' || event.stage === 'completed') {
                finalizeStreamingEntry();
              }
              break;
            }
            case 'error':
            case 'final': {
              finalizeStreamingEntry();
              break;
            }
            default:
              break;
          }
        },
      }, undefined, options?.engineOverride);
    } finally {
      setRunning(false);
    }
  }, [running, getSnapshot, sendBridge, log, setDetections, finalizeStreamingEntry]);

  const onRun = useCallback(() => {
    void executeInstruction(prompt);
  }, [executeInstruction, prompt]);

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

  // Listen for layout refresh events
  React.useEffect(() => {
    const handleLayoutRefresh = () => {
      // Reload position, size, and zIndex from localStorage
      try {
        const storedPos = localStorage.getItem('agent.panel.pos');
        const storedSize = localStorage.getItem('agent.panel.size');
        const storedZIndex = localStorage.getItem('agent.panel.zIndex');
        const storedVisible = localStorage.getItem('agent.panel.visible');

        if (storedPos) {
          const newPos = JSON.parse(storedPos);
          setPos(newPos);
        }
        if (storedSize) {
          const newSize = JSON.parse(storedSize);
          setSize(newSize);
        }
        if (storedZIndex) {
          setZIndex(parseInt(storedZIndex));
        }
        if (storedVisible) {
          setVisible(JSON.parse(storedVisible));
        }
      } catch (error) {
        console.error('Failed to refresh AgentPanel layout:', error);
      }
    };

    window.addEventListener('layoutRefresh', handleLayoutRefresh);
    return () => window.removeEventListener('layoutRefresh', handleLayoutRefresh);
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

  const handleMouseDown = (e: React.MouseEvent) => {
    // Bring to front when starting drag - simple and fast
    setZIndex(getNextZIndex());

    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, resizing: false };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const header = useMemo(() => (
    <div className="flex items-center justify-between mb-2 cursor-move select-text" onMouseDown={handleMouseDown}>
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

  const timelineChips = React.useMemo(() => {
    return timeline.slice(-12).map((entry) => {
      const display = getToolDisplay(entry.tool);
      const stateClass = entry.state === 'done'
        ? 'bg-status-good/20 border-status-good/60 text-status-good'
        : entry.state === 'error'
          ? 'bg-status-error/20 border-status-error/60 text-status-error'
          : 'bg-amber-500/10 border-amber-400/50 text-amber-200';
      const categoryClass = display.category === 'flight' || display.category === 'mission'
        ? 'shadow-[0_0_6px_rgba(0,150,255,0.35)]'
        : '';
      return (
        <span
          key={entry.key}
          className={`px-2 py-[3px] rounded border text-[10px] uppercase tracking-wide whitespace-nowrap ${stateClass} ${categoryClass}`}
          title={`${display.label} · ${entry.state}${entry.ms != null ? ` · ${Math.round(entry.ms)} ms` : ''}`}
        >
          {display.icon ? `${display.icon} ` : ''}{display.label}
        </span>
      );
    });
  }, [timeline]);

  const flightEvents = React.useMemo(() => timeline.filter((t) => FLIGHT_TOOLS.has(t.tool)).slice(-6), [timeline]);

  const executionSummary = React.useMemo(() => {
    if (!timeline.length) return 'Awaiting execution';
    const completed = timeline.filter((e) => e.state === 'done').length;
    const errors = timeline.filter((e) => e.state === 'error').length;
    if (errors) return `${errors} error${errors === 1 ? '' : 's'}`;
    if (completed === timeline.length) return `${completed} step${completed === 1 ? '' : 's'} complete`;
    return `${completed}/${timeline.length} complete`;
  }, [timeline]);

  const currentEngine = plannerMeta?.engine ?? plannerSettings.engine;

  const plannerSummary = useMemo(() => {
    const base = planErrors.length
      ? `${planErrors.length} error${planErrors.length === 1 ? '' : 's'}`
      : planProgram
        ? `${planSteps?.length || 0} step${(planSteps?.length || 0) === 1 ? '' : 's'}`
        : 'Waiting';
    return `${base} · ${currentEngine}`;
  }, [planErrors, planProgram, planSteps, currentEngine]);

  const conversationSummary = useMemo(() => {
    if (!conversation.length) return 'No messages';
    return `${conversation.length} message${conversation.length === 1 ? '' : 's'}`;
  }, [conversation.length]);

  const plannerConfigSummary = useMemo(() => {
    if (plannerSettings.engine === 'responses') {
      const model = plannerSettings.responses.model.trim() || 'model?';
      return `responses · ${model}`;
    }
    return 'legacy';
  }, [plannerSettings.engine, plannerSettings.responses.model]);

  const detectorSummary = useMemo(() => `threshold ${thr.toFixed(2)}`, [thr]);

  const reasoningSelectValue = plannerSettings.responses.reasoningEffort ?? 'default';
  const parallelSelectValue = plannerSettings.responses.parallelToolCalls === null
    ? 'default'
    : (plannerSettings.responses.parallelToolCalls ? 'true' : 'false');

  const plannerRequestOverrides = useMemo(() => {
    const responses = plannerMeta?.request?.responses;
    if (!responses) return [] as string[];
    return Object.entries(responses).map(([key, value]) => `${key}: ${describeOverrideValue(value)}`);
  }, [plannerMeta]);

  const plannerMessages = useMemo<PlannerMessageDisplay[]>(() => {
    if (!plannerMeta?.messages || !Array.isArray(plannerMeta.messages)) return [];
    return plannerMeta.messages
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null;
        const role = typeof entry.role === 'string' ? entry.role : 'assistant';
        const content = Array.isArray(entry.content) ? entry.content : [];
        const parts: string[] = [];
        content.forEach((part: any) => {
          if (!part || typeof part !== 'object') return;
          const type = part.type;
          if ((type === 'text' || type === 'output_text') && typeof part.text === 'string') {
            parts.push(part.text);
          } else if (type === 'tool_use') {
            const name = typeof part.name === 'string' ? part.name : 'tool';
            parts.push(`[tool:${name}] ${describeOverrideValue(part.input)}`);
          } else if (type === 'tool_result') {
            const output = part.output ?? part.text ?? part.content;
            parts.push(`[tool result] ${describeOverrideValue(output)}`);
          }
        });
        const text = parts.map((p) => p.trim()).filter((p) => p.length > 0).join('\n');
        if (!text) return null;
        return { id: `${index}-${role}`, role, text } as PlannerMessageDisplay;
      })
      .filter((value): value is PlannerMessageDisplay => value !== null);
  }, [plannerMeta]);

  const plannerRawJson = useMemo(() => {
    if (!plannerMeta?.rawResponse) return null;
    try {
      return JSON.stringify(plannerMeta.rawResponse, null, 2);
    } catch {
      return '[unserializable]';
    }
  }, [plannerMeta]);

  const plannerStreamDisplay = useMemo(() => {
    return plannerStream
      .filter((event) => event.type !== 'token' && event.type !== 'message_chunk' && event.type !== 'tool_arguments_delta')
      .map((event, idx) => {
        switch (event.type) {
          case 'tool_use':
            return { key: idx, text: `▶ ${event.tool ?? 'tool'} ${describeOverrideValue(event.arguments)}`, variant: 'tool' as const };
          case 'tool_result':
            return { key: idx, text: `◀ result ${describeOverrideValue(event.result)}`, variant: 'tool' as const };
          case 'tool_arguments_complete':
            return { key: idx, text: `Args ready ${event.callId}: ${event.arguments}`, variant: 'status' as const };
          case 'status':
            return { key: idx, text: `ℹ ${event.stage}${event.responseId ? ` (${event.responseId})` : ''}`, variant: 'status' as const };
          case 'error':
            return { key: idx, text: `⚠ ${event.message}`, variant: 'error' as const };
          case 'final':
            return { key: idx, text: 'Planner completed', variant: 'status' as const };
        }
        const fallbackType = (event as any)?.type ?? 'unknown';
        return { key: idx, text: `${fallbackType}: ${describeOverrideValue(event as any)}`, variant: 'status' as const };
      });
  }, [plannerStream]);

  const handleReplayLegacy = useCallback(() => {
    if (!lastInstruction || running) return;
    void executeInstruction(lastInstruction, { engineOverride: 'legacy', label: 'Replay legacy' });
  }, [executeInstruction, lastInstruction, running]);

  const handleReplayResponses = useCallback(() => {
    if (!lastInstruction || running) return;
    void executeInstruction(lastInstruction, { engineOverride: 'responses', label: 'Replay responses' });
  }, [executeInstruction, lastInstruction, running]);

  const logSummary = logLines.length
    ? `${logLines.length} line${logLines.length === 1 ? '' : 's'}`
    : 'Empty';

  const statusChips = (
    <div className="flex flex-wrap gap-1 text-[10px] text-gray-300">
      <span className="px-2 py-[3px] rounded bg-gray-800/70 border border-gray-700/70 uppercase tracking-wide">
        Engine: {currentEngine}
      </span>
      {status.detector && (
        <span className="px-2 py-[3px] rounded bg-gray-800/70 border border-gray-700/70 uppercase tracking-wide">Detector</span>
      )}
      {status.planner && (
        <span className="px-2 py-[3px] rounded bg-gray-800/70 border border-gray-700/70 uppercase tracking-wide">Planner ready</span>
      )}
      {timeline.length === 0 && !running && (
        <span className="px-2 py-[3px] rounded bg-gray-800/40 border border-gray-700/40 uppercase tracking-wide text-gray-400">No execution yet</span>
      )}
    </div>
  );

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
      zIndex: zIndex,
      display: visible ? 'block' : 'none' // Hide without unmounting
    }}>
      {header}
      <div className="flex flex-col h-[calc(100%-24px)] overflow-hidden select-text">
        <div className="flex-1 overflow-y-auto pr-1 space-y-3">
          <CollapsibleSection
            title="Prompt & Conversation"
            storageKey="agent.section.prompt"
            summary={conversationSummary}
          >
            {statusChips}
            <div className="flex gap-2 items-start">
              <textarea
                className="flex-1 bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue resize-none"
                rows={Math.min(8, Math.max(3, prompt.split('\n').length))}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter') && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (!running) {
                      void onRun();
                    }
                  }
                }}
                placeholder="Describe the desired action…"
              />
              <div className="flex flex-col gap-2 min-w-[96px]">
                <button
                  className={`px-2 py-1 text-xs uppercase tracking-wide rounded ${running ? 'bg-gray-700 text-gray-400' : 'bg-dji-blue text-white hover:bg-dji-blue/80'}`}
                  onClick={onRun}
                  disabled={running}
                >Run</button>
                <button
                  className="px-2 py-1 text-xs uppercase tracking-wide rounded border border-gray-700/60 bg-gray-900/70 text-gray-300 hover:bg-gray-800"
                  onClick={onStop}
                >Stop</button>
              </div>
            </div>
            <div className="text-[10px] text-gray-500 mt-1">Ctrl/⌘ + Enter to run · Shift+Enter adds a newline.</div>
            {running && streamingIdRef.current ? (
              <div className="mt-1 text-[10px] text-amber-300 uppercase tracking-wide">Streaming planner response…</div>
            ) : null}
            <div className="flex items-center justify-between mt-2">
              <SectionLabel label="Conversation" hint={conversationSummary} />
              <button
                type="button"
                className="px-2 py-[3px] text-[10px] uppercase tracking-wide rounded border border-gray-700/60 bg-gray-900/60 text-gray-300 hover:bg-gray-800"
                onClick={handleClearConversation}
                disabled={conversation.length === 0}
              >Clear</button>
            </div>
            <div
              ref={conversationContainerRef}
              className="mt-1 bg-gray-900/60 border border-gray-800/70 rounded p-2 text-[11px] text-gray-200"
              style={{ maxHeight: 270, overflowY: 'auto' }}
            >
              {conversation.length === 0 && (
                <div className="text-gray-500">No planner responses yet.</div>
              )}
              {[...conversation]
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((entry) => {
                  const isPlanner = entry.role === 'planner';
                  const roleLabel = isPlanner ? 'Planner' : 'Operator';
                  const messageClasses = isPlanner
                    ? 'bg-emerald-900/40 border border-emerald-500/60 text-emerald-200'
                    : 'bg-dji-blue/10 border border-dji-blue/40 text-dji-blue';
                  const headerClass = isPlanner ? 'text-emerald-300' : 'text-gray-500';
                  return (
                    <div key={entry.id} className="mb-2 last:mb-0">
                      <div className={`text-[10px] uppercase tracking-wide flex items-center gap-2 ${headerClass}`}>
                        <span>{roleLabel}</span>
                        <span>•</span>
                        <span>{formatTimestamp(entry.timestamp)}</span>
                        {entry.streaming ? <span className="text-emerald-200">streaming…</span> : null}
                      </div>
                      <div className={`mt-1 whitespace-pre-wrap leading-snug rounded px-2 py-1 ${messageClasses}`}>
                        {entry.text || (entry.streaming ? '…' : '')}
                      </div>
                    </div>
                  );
                })}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Planner Config"
            storageKey="agent.section.plannerConfig"
            summary={plannerConfigSummary}
          >
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-200">
              <select
                className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                value={plannerSettings.engine}
                onChange={(e) => plannerSettingsStore.setEngine(e.target.value as PlannerEngine)}
              >
                <option value="legacy">Legacy (Chat Completions)</option>
                <option value="responses">Responses API (experimental)</option>
              </select>
              <span className="text-gray-500">switch to experiment with new planner models</span>
            </div>
            {plannerSettings.engine === 'responses' && (
              <div className="mt-2 grid gap-2 text-[10px] text-gray-200 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Model</span>
                  <input
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={plannerSettings.responses.model}
                    onChange={(e) => plannerSettingsStore.setResponses('model', e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Reasoning effort</span>
                  <select
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={reasoningSelectValue}
                    onChange={(e) => plannerSettingsStore.setResponses('reasoningEffort', e.target.value === 'default' ? null : e.target.value as ReasoningEffort)}
                  >
                    <option value="default">Default</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Temperature</span>
                  <input
                    type="number"
                    step="0.1"
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={plannerSettings.responses.temperature ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (!value) {
                        plannerSettingsStore.setResponses('temperature', null);
                        return;
                      }
                      const num = Number(value);
                      plannerSettingsStore.setResponses('temperature', Number.isFinite(num) ? num : null);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Max output tokens</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={plannerSettings.responses.maxOutputTokens ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (!value) {
                        plannerSettingsStore.setResponses('maxOutputTokens', null);
                        return;
                      }
                      const num = Number(value);
                      plannerSettingsStore.setResponses('maxOutputTokens', Number.isFinite(num) ? num : null);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Parallel tool calls</span>
                  <select
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={parallelSelectValue}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'default') {
                        plannerSettingsStore.setResponses('parallelToolCalls', null);
                      } else {
                        plannerSettingsStore.setResponses('parallelToolCalls', val === 'true');
                      }
                    }}
                  >
                    <option value="default">Default</option>
                    <option value="true">Enable</option>
                    <option value="false">Disable</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-dji-blue"
                    checked={plannerSettings.responses.webSearch}
                    onChange={(e) => plannerSettingsStore.setResponses('webSearch', e.target.checked)}
                  />
                  <span className="uppercase tracking-wide text-gray-500">Enable web search</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Prompt cache key</span>
                  <input
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={plannerSettings.responses.promptCacheKey}
                    onChange={(e) => plannerSettingsStore.setResponses('promptCacheKey', e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="uppercase tracking-wide text-gray-500">Previous response ID</span>
                  <input
                    className="bg-gray-900/70 border border-gray-700/70 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-dji-blue"
                    value={plannerSettings.responses.previousResponseId}
                    onChange={(e) => plannerSettingsStore.setResponses('previousResponseId', e.target.value)}
                  />
                </label>
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Detector Config"
            storageKey="agent.section.detector"
            summary={detectorSummary}
          >
            <SectionLabel label="Detector threshold" />
            <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-300 flex-wrap">
              {[0.15, 0.2, 0.25, 0.3].map((v) => (
                <button
                  key={v}
                  className={`px-1.5 py-[2px] rounded border ${Math.abs(thr - v) < 1e-6 ? 'bg-dji-blue text-white border-dji-blue' : 'bg-gray-800 text-gray-200 border-gray-700 hover:bg-gray-700'}`}
                  onClick={() => { setThr(v); setActiveThreshold(v); log(`threshold set to ${v.toFixed(2)}`); }}
                >{v.toFixed(2)}</button>
              ))}
              <span className="text-gray-500">active {thr.toFixed(2)}</span>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Planner Output"
            storageKey="agent.section.planner"
            summary={plannerSummary}
          >
            {planErrors.length > 0 && (
              <div className="bg-red-950/60 border border-red-800/60 rounded p-2 text-[11px] text-red-200 space-y-1" style={{ maxHeight: 140, overflowY: 'auto' }}>
                {planErrors.map((e, i) => (
                  <div key={i}>• {e.message}{e.path ? ` (${e.path})` : ''}</div>
                ))}
              </div>
            )}
            <div className="mt-2 bg-gray-900/40 border border-gray-800/60 rounded p-2 text-[10px] text-gray-300 space-y-1">
              <div>Engine: {currentEngine}</div>
              {plannerRequestOverrides.length > 0 && (
                <div>
                  Overrides:
                  <ul className="list-disc list-inside mt-1 space-y-[2px] text-gray-400">
                    {plannerRequestOverrides.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </div>
              )}
              {plannerMeta?.highLevelProgram && !planErrors.length && (
                <div className="text-gray-500">High-level plan captured</div>
              )}
            </div>
            {lastInstruction && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className="px-2 py-1 text-[10px] uppercase tracking-wide rounded border border-gray-700/70 bg-gray-900/60 text-gray-200 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleReplayLegacy}
                  disabled={running || currentEngine === 'legacy'}
                >Replay legacy</button>
                <button
                  className="px-2 py-1 text-[10px] uppercase tracking-wide rounded border border-gray-700/70 bg-gray-900/60 text-gray-200 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleReplayResponses}
                  disabled={running || currentEngine === 'responses'}
                >Replay responses</button>
              </div>
            )}
            {(planProgram || planProgramHigh) && (
              <div>
                <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
                  <SectionLabel label="Program" hint={programView === 'final' ? 'Expanded DSL' : 'High-level plan'} />
                  <div className="flex gap-1">
                    <button className={`px-1 py-[1px] rounded ${programView==='final'?'bg-dji-blue text-white':'bg-gray-800 text-gray-300'}`} onClick={()=>setProgramView('final')}>Final</button>
                    <button className={`px-1 py-[1px] rounded ${programView==='high'?'bg-dji-blue text-white':'bg-gray-800 text-gray-300'}`} onClick={()=>setProgramView('high')}>High-level</button>
                  </div>
                </div>
                <div ref={programRef} className="bg-gray-900/60 border border-gray-800/80 rounded p-2 text-[10px] font-mono text-gray-200" style={{ height: 170, overflowY: 'auto', resize: 'vertical' as any }}>
                  <pre className="whitespace-pre-wrap leading-tight">{safeStringify(programView==='final'? planProgram : planProgramHigh)}</pre>
                </div>
              </div>
            )}
            {planSteps && planSteps.length > 0 && (
              <div>
                <SectionLabel label="Plan preview" hint={`${planSteps.length} tool${planSteps.length===1?'':'s'}`} />
                <div ref={planRef} className="mt-1 bg-gray-900/50 border border-gray-800/80 rounded p-2 text-[10px] text-gray-200" style={{ height: 120, overflowY: 'auto', resize: 'vertical' as any }}>
                  {planSteps.map((s, i) => (
                    <div key={i} className="whitespace-nowrap overflow-hidden text-ellipsis">
                      {i+1}. {String(s.tool)} {formatArgs(s.args)}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {plannerMessages.length > 0 && (
              <div className="mt-2">
                <SectionLabel label="Planner reasoning" hint={`${plannerMessages.length} message${plannerMessages.length === 1 ? '' : 's'}`} />
                <div className="mt-1 bg-gray-900/60 border border-gray-800/70 rounded p-2 text-[10px] text-gray-200" style={{ maxHeight: 160, overflowY: 'auto' }}>
                  {plannerMessages.map((msg) => (
                    <div key={msg.id} className="mb-2 last:mb-0">
                      <div className="uppercase tracking-wide text-gray-500">{msg.role}</div>
                      <div className="mt-1 whitespace-pre-wrap leading-snug">{msg.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {plannerStreamDisplay.length > 0 && (
              <div className="mt-2">
                <SectionLabel label="Planning stream" hint={`${plannerStreamDisplay.length} event${plannerStreamDisplay.length === 1 ? '' : 's'}`} />
                <div className="mt-1 bg-gray-900/60 border border-gray-800/70 rounded p-2 text-[10px] text-gray-200" style={{ maxHeight: 160, overflowY: 'auto' }}>
                  {plannerStreamDisplay.map((entry) => {
                    const variantClass = entry.variant === 'error'
                      ? 'text-red-300'
                      : entry.variant === 'tool'
                        ? 'text-sky-300'
                        : 'text-emerald-300';
                    return (
                      <div key={entry.key} className={`mb-1 last:mb-0 whitespace-pre-wrap leading-snug ${variantClass}`}>
                        {entry.text}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {plannerRawJson && (
              <div className="mt-2">
                <details className="text-[10px] text-gray-400">
                  <summary className="cursor-pointer text-gray-300">Raw planner response</summary>
                  <pre className="mt-1 bg-gray-900/60 border border-gray-800/70 rounded p-2 text-[10px] text-gray-200 whitespace-pre-wrap max-h-48 overflow-y-auto">{plannerRawJson}</pre>
                </details>
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Execution"
            storageKey="agent.section.execution"
            summary={executionSummary}
          >
            <SectionLabel label="Command ribbon" hint="Most recent steps" />
            <div className="flex flex-wrap gap-1 mb-2">
              {timelineChips.length ? timelineChips : <span className="text-[10px] text-gray-500">No commands executed yet.</span>}
            </div>

            <SectionLabel label="Flight timeline" hint="Last 6 flight primitives" />
            <div className="space-y-2 mb-2">
              {flightEvents.length === 0 && (
                <div className="text-[11px] text-gray-500">No flight actions in this run.</div>
              )}
              {flightEvents.map((event) => {
                const display = getToolDisplay(event.tool);
                return (
                  <div key={event.key} className="flex items-start gap-2 text-[11px]">
                    <span className="w-6 h-6 flex items-center justify-center rounded-full bg-gray-800/70 border border-gray-700/60 text-sm">
                      {display.icon ?? '✦'}
                    </span>
                    <div className="flex-1">
                      <div className="text-gray-200">{display.label}</div>
                      <div className="text-[10px] text-gray-500">{event.state === 'done' ? 'Completed' : event.state === 'error' ? 'Error' : 'Running'}{event.ms != null ? ` · ${Math.round(event.ms)} ms` : ''}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {result && (
              <div className="text-[11px] text-gray-200 bg-gray-900/40 border border-gray-800/70 rounded p-2">{result}</div>
            )}

            {trace.length > 0 && (
              <div>
                <SectionLabel label="Trace" hint="Live interpreter output" />
                <div ref={execRef} className="mt-1 bg-gray-900/60 border border-gray-800/80 rounded p-2 text-[10px] font-mono" style={{ height: 200, overflowY: 'auto', resize: 'vertical' as any }}>
                  {trace.map((t, i) => (
                    <div key={i} className={t.kind==='tool'? 'text-blue-300' : t.kind==='var'? 'text-yellow-300' : t.kind==='error'? 'text-red-300' : t.kind==='warn'? 'text-orange-300' : 'text-gray-300'}>
                      {t.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Command Queue"
            storageKey="agent.section.queue"
            summary={queueSummaryLabel}
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-200">
              <div className="text-gray-400">State</div>
              <div>{queueSummary.paused ? 'Paused' : 'Active'}</div>

              <div className="text-gray-400">Active command</div>
              <div>{queueSummary.active ? formatQueueItem(queueSummary.active) : 'None'}</div>

              <div className="text-gray-400">Pending</div>
              <div className="space-y-1">
                {queueSummary.pending.length === 0 ? (
                  <div className="text-gray-500">None</div>
                ) : (
                  queueSummary.pending.slice(0, 4).map((item) => (
                    <div key={item.id} className="bg-gray-900/45 border border-gray-800/70 rounded px-2 py-1">
                      {formatQueueItem(item)}
                    </div>
                  ))
                )}
                {queueSummary.pending.length > 4 && (
                  <div className="text-[10px] text-gray-500">+ {queueSummary.pending.length - 4} more</div>
                )}
              </div>

              <div className="text-gray-400">Recent complete</div>
              <div className="space-y-1">
                {queueSummary.completed && queueSummary.completed.length > 0 ? (
                  queueSummary.completed.slice(-3).reverse().map((item) => (
                    <div key={item.id} className="text-gray-500">{formatQueueItem(item)}</div>
                  ))
                ) : (
                  <div className="text-gray-500">None</div>
                )}
              </div>

              <div className="text-gray-400">Last error</div>
              <div>{queueSummary.last_error ? queueSummary.last_error : 'None'}</div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Mission Telemetry"
            storageKey="agent.section.telemetry"
            summary={`${telemetry.missionState}${telemetry.fallbackActive ? ' · fallback' : ''}`}
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-200">
              <div className="text-gray-400">Mission state</div>
              <div>{telemetry.missionState}</div>

              <div className="text-gray-400">Last command</div>
              <div>{telemetry.lastCommand ?? '—'}</div>

              <div className="text-gray-400">Altitude target</div>
              <div>{telemetry.altitudeTarget != null ? `${telemetry.altitudeTarget.toFixed(1)} m` : '—'}</div>

              <div className="text-gray-400">Altitude current</div>
              <div>{telemetry.altitudeCurrent != null ? `${telemetry.altitudeCurrent.toFixed(1)} m` : '—'}</div>

              <div className="text-gray-400">Horizontal remaining</div>
              <div>{telemetry.horizontalRemaining != null ? `${telemetry.horizontalRemaining.toFixed(1)} m` : '—'}</div>

              <div className="text-gray-400">Virtual stick</div>
              <div>
                {telemetry.virtualStickEnabled ? 'ENABLED' : 'disabled'}
                {telemetry.virtualStickOwner ? ` (${telemetry.virtualStickOwner})` : ''}
              </div>

              <div className="text-gray-400">Fallback active</div>
              <div>{telemetry.fallbackActive ? 'Yes' : 'No'}</div>

              <div className="text-gray-400">Last update</div>
              <div>{formatTimestamp(telemetry.lastUpdateMs)}</div>
            </div>
            {telemetry.notes.length > 0 && (
              <div className="mt-2 bg-gray-900/50 border border-gray-800/70 rounded p-2 text-[10px] text-gray-300 space-y-1">
                {telemetry.notes.slice(-5).map((note, idx) => (
                  <div key={idx}>• {note}</div>
                ))}
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Console Log"
            storageKey="agent.section.logs"
            summary={logSummary}
          >
            <div className="bg-gray-900/45 border border-gray-800/70 rounded p-2 text-[10px] font-mono text-gray-300" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {logLines.length === 0 ? <div className="text-gray-500">No log messages yet.</div> : null}
              {logLines.map((line, index) => (
                <div key={index}>{line}</div>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Help & Examples"
            storageKey="agent.section.help"
            summary={`${EXAMPLE_PROMPTS.length} example${EXAMPLE_PROMPTS.length === 1 ? '' : 's'}`}
            defaultOpen={false}
          >
            <div className="space-y-2 text-[11px] text-gray-300">
              {EXAMPLE_PROMPTS.map((item, idx) => (
                <div key={idx} className="bg-gray-900/40 border border-gray-800/70 rounded p-2">
                  <div className="font-semibold text-gray-100 mb-1">{item.title}</div>
                  <div className="font-mono text-[10px] text-dji-blue break-words">{item.prompt}</div>
                  {item.note ? <div className="mt-1 text-[10px] text-gray-500">{item.note}</div> : null}
                </div>
              ))}
              <div className="text-[10px] text-gray-500">Tip: update examples in `EXAMPLE_PROMPTS` when new primitives land.</div>
            </div>
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
};

function getToolDisplay(tool: string) {
  if (TOOL_DISPLAY[tool]) return TOOL_DISPLAY[tool];
  return {
    label: tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    category: 'mission',
    icon: '⚙️',
  } as const;
}

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

function formatQueueItem(item: QueueItem): string {
  const label = item.label && item.label.trim().length ? item.label : item.tool;
  if (item.note && item.note.trim().length) {
    return `${label} — ${item.note}`;
  }
  return label;
}

function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - timestamp);
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60000)} min ago`;
  const date = new Date(timestamp);
  return date.toLocaleTimeString();
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
