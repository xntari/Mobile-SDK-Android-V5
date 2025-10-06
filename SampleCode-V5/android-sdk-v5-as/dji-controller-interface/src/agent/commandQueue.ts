import type { PlannerContextQueueItemSummary, PlannerContextQueueSummary } from './plannerContext';

type QueueStatus = 'pending' | 'active' | 'completed' | 'error';

export interface CommandQueueItemSeed {
  tool: string;
  args?: Record<string, unknown>;
  label?: string | null;
  note?: string;
}

interface CommandQueueItem extends PlannerContextQueueItemSummary {
  index: number;
  tool: string;
  args?: Record<string, unknown>;
  status: QueueStatus;
  enqueued_at_ms: number;
  started_at_ms?: number;
  finished_at_ms?: number;
  error?: string | null;
}

interface CommandQueueState {
  pending: CommandQueueItem[];
  active: CommandQueueItem | null;
  completed: CommandQueueItem[];
  paused: boolean;
  last_error: string | null;
  generation: number;
}

const MAX_COMPLETED_HISTORY = 20;

type QueueListener = (state: CommandQueueState) => void;

const state: CommandQueueState = {
  pending: [],
  active: null,
  completed: [],
  paused: false,
  last_error: null,
  generation: 0,
};

const listeners = new Set<QueueListener>();

function cloneItem(item: CommandQueueItem): CommandQueueItem;
function cloneItem(item: CommandQueueItem | null): CommandQueueItem | null;
function cloneItem(item: CommandQueueItem | null): CommandQueueItem | null {
  if (!item) return null;
  return { ...item, args: item.args ? { ...item.args } : undefined };
}

function cloneState(): CommandQueueState {
  return {
    pending: state.pending.map((item) => cloneItem(item)),
    active: cloneItem(state.active),
    completed: state.completed.map((item) => cloneItem(item)),
    paused: state.paused,
    last_error: state.last_error,
    generation: state.generation,
  };
}

function notify() {
  const snapshot = cloneState();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[commandQueue] listener error', error);
    }
  });
}

function makeItem(seed: CommandQueueItemSeed, index: number): CommandQueueItem {
  return {
    id: `${Date.now()}-${index}`,
    tool: seed.tool,
    label: seed.label ?? null,
    status: 'pending',
    enqueued_at_ms: Date.now(),
    args: seed.args ? { ...seed.args } : undefined,
    note: seed.note,
    index,
  };
}

function toSummary(item: CommandQueueItem | null): PlannerContextQueueItemSummary | null {
  if (!item) return null;
  return {
    id: item.id,
    tool: item.tool,
    label: item.label ?? null,
    status: item.status,
    enqueued_at_ms: item.enqueued_at_ms,
    note: item.note,
  };
}

function coerceArraySummary(items: CommandQueueItem[]): PlannerContextQueueItemSummary[] {
  return items.map((item) => ({
    id: item.id,
    tool: item.tool,
    label: item.label ?? null,
    status: item.status,
    enqueued_at_ms: item.enqueued_at_ms,
    note: item.note,
  }));
}

export function getQueueSummary(): PlannerContextQueueSummary {
  return {
    paused: state.paused,
    active: toSummary(state.active),
    pending: coerceArraySummary(state.pending),
    completed: coerceArraySummary(state.completed),
    last_error: state.last_error,
  };
}

export function subscribe(listener: QueueListener): () => void {
  listeners.add(listener);
  try {
    listener(cloneState());
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[commandQueue] initial listener dispatch failed', error);
  }
  return () => listeners.delete(listener);
}

export function resetWithSeeds(seeds: CommandQueueItemSeed[]): void {
  state.pending = seeds.map((seed, index) => makeItem(seed, index));
  state.active = null;
  state.completed = [];
  state.paused = false;
  state.last_error = null;
  state.generation += 1;
  notify();
}

export function clearQueue(): void {
  if (!state.pending.length && !state.active && !state.completed.length) {
    return;
  }
  state.pending = [];
  state.active = null;
  state.completed = [];
  state.last_error = null;
  state.generation += 1;
  notify();
}

export function setPaused(paused: boolean): void {
  if (state.paused === paused) return;
  state.paused = paused;
  notify();
}

export function activateNext(expectedTool?: string): CommandQueueItem | null {
  if (state.active) {
    return state.active;
  }
  if (state.paused || state.pending.length === 0) {
    return null;
  }
  let nextIndex = 0;
  if (expectedTool) {
    const matchIndex = state.pending.findIndex((entry) => entry.tool === expectedTool);
    if (matchIndex >= 0) {
      nextIndex = matchIndex;
    }
  }
  const [next] = state.pending.splice(nextIndex, 1);
  if (!next) {
    return null;
  }
  next.status = 'active';
  next.started_at_ms = Date.now();
  state.active = next;
  notify();
  return next;
}

export function completeActive(success: boolean, options: { error?: string; note?: string } = {}): void {
  const active = state.active;
  if (!active) {
    return;
  }
  state.active = null;
  const finished: CommandQueueItem = {
    ...active,
    status: success ? 'completed' : 'error',
    finished_at_ms: Date.now(),
    note: options.note ?? active.note,
    error: success ? null : options.error ?? active.error ?? null,
  };
  state.completed = [...state.completed, finished].slice(-MAX_COMPLETED_HISTORY);
  if (!success) {
    state.last_error = finished.error ?? finished.note ?? 'Command failed';
  }
  notify();
}

export function markActiveNote(note: string): void {
  if (!state.active) return;
  state.active.note = note;
  notify();
}

export function getState(): CommandQueueState {
  return cloneState();
}
