export type AgentMissionState =
  | 'idle'
  | 'command_pending'
  | 'executing'
  | 'fallback'
  | 'stalled'
  | 'error';

export interface AgentTelemetrySnapshot {
  missionState: AgentMissionState;
  lastCommand: string | null;
  altitudeTarget: number | null;
  altitudeCurrent: number | null;
  horizontalRemaining: number | null;
  fallbackActive: boolean;
  virtualStickEnabled: boolean;
  virtualStickOwner: string | null;
  notes: string[];
  lastUpdateMs: number;
}

type AgentTelemetryListener = (snapshot: AgentTelemetrySnapshot) => void;

const listeners = new Set<AgentTelemetryListener>();

const defaultSnapshot: AgentTelemetrySnapshot = {
  missionState: 'idle',
  lastCommand: null,
  altitudeTarget: null,
  altitudeCurrent: null,
  horizontalRemaining: null,
  fallbackActive: false,
  virtualStickEnabled: false,
  virtualStickOwner: null,
  notes: [],
  lastUpdateMs: Date.now(),
};

let snapshot: AgentTelemetrySnapshot = { ...defaultSnapshot };

function cloneSnapshot(source: AgentTelemetrySnapshot): AgentTelemetrySnapshot {
  return {
    ...source,
    notes: [...source.notes],
  };
}

function notify() {
  const snap = cloneSnapshot(snapshot);
  listeners.forEach((listener) => listener(snap));
}

export const agentTelemetryStore = {
  getSnapshot(): AgentTelemetrySnapshot {
    return cloneSnapshot(snapshot);
  },

  subscribe(listener: AgentTelemetryListener): () => void {
    listeners.add(listener);
    // Emit current snapshot immediately
    listener(cloneSnapshot(snapshot));
    return () => listeners.delete(listener);
  },

  reset(): void {
    snapshot = { ...defaultSnapshot, lastUpdateMs: Date.now() };
    notify();
  },

  update(partial: Partial<Omit<AgentTelemetrySnapshot, 'notes' | 'lastUpdateMs'>>, options?: { appendNote?: string | null; replaceNotes?: string[] }): void {
    const notes = options?.replaceNotes
      ? [...options.replaceNotes]
      : [...snapshot.notes];
    if (options?.appendNote) {
      notes.push(options.appendNote);
    }
    snapshot = {
      ...snapshot,
      ...partial,
      notes,
      lastUpdateMs: Date.now(),
    };
    notify();
  },
};
