export type PlannerEngine = 'legacy' | 'responses';
export type ReasoningEffort = 'low' | 'medium' | 'high' | null;

export interface PlannerResponsesSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  temperature: number | null;
  maxOutputTokens: number | null;
  parallelToolCalls: boolean | null;
  webSearch: boolean;
  promptCacheKey: string;
  previousResponseId: string;
}

export interface PlannerSettingsSnapshot {
  engine: PlannerEngine;
  responses: PlannerResponsesSettings;
}

type Listener = (snapshot: PlannerSettingsSnapshot) => void;

const STORAGE_KEY = 'planner.settings';
const storage: Storage | null = typeof window !== 'undefined' ? window.localStorage : null;

const DEFAULT_SNAPSHOT: PlannerSettingsSnapshot = {
  engine: 'legacy',
  responses: {
    model: 'gpt-4o-mini',
    reasoningEffort: null,
    temperature: null,
    maxOutputTokens: null,
    parallelToolCalls: null,
    webSearch: false,
    promptCacheKey: '',
    previousResponseId: '',
  },
};

function parseNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseBooleanOrNull(value: any): boolean | null {
  if (value === null || value === undefined) return null;
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function loadSnapshot(): PlannerSettingsSnapshot {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SNAPSHOT;
    }
    const parsed = JSON.parse(raw);
    const engine: PlannerEngine = parsed?.engine === 'responses' ? 'responses' : 'legacy';
    const resp = parsed?.responses ?? {};
    const snapshot: PlannerSettingsSnapshot = {
      engine,
      responses: {
        model: typeof resp.model === 'string' && resp.model.trim() ? resp.model.trim() : DEFAULT_SNAPSHOT.responses.model,
        reasoningEffort: resp.reasoningEffort === 'low' || resp.reasoningEffort === 'medium' || resp.reasoningEffort === 'high'
          ? resp.reasoningEffort
          : null,
        temperature: parseNumber(resp.temperature),
        maxOutputTokens: parseNumber(resp.maxOutputTokens),
        parallelToolCalls: parseBooleanOrNull(resp.parallelToolCalls),
        webSearch: resp.webSearch === true,
        promptCacheKey: typeof resp.promptCacheKey === 'string' ? resp.promptCacheKey : '',
        previousResponseId: typeof resp.previousResponseId === 'string' ? resp.previousResponseId : '',
      },
    };
    return snapshot;
  } catch (error) {
    console.warn('[PlannerSettingsStore] failed to load snapshot', error);
    return DEFAULT_SNAPSHOT;
  }
}

const listeners = new Set<Listener>();
let snapshot: PlannerSettingsSnapshot = loadSnapshot();

function persist(): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('[PlannerSettingsStore] failed to persist snapshot', error);
  }
}

function notify(): void {
  const current = { ...snapshot, responses: { ...snapshot.responses } };
  listeners.forEach((listener) => {
    try {
      listener(current);
    } catch (error) {
      console.warn('[PlannerSettingsStore] listener error', error);
    }
  });
}

export const plannerSettingsStore = {
  getSnapshot(): PlannerSettingsSnapshot {
    return { ...snapshot, responses: { ...snapshot.responses } };
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(this.getSnapshot());
    return () => listeners.delete(listener);
  },

  setEngine(engine: PlannerEngine): void {
    if (snapshot.engine === engine) return;
    snapshot = { ...snapshot, engine };
    persist();
    notify();
  },

  setResponses<K extends keyof PlannerResponsesSettings>(key: K, value: PlannerResponsesSettings[K]): void {
    if (snapshot.responses[key] === value) return;
    snapshot = {
      ...snapshot,
      responses: {
        ...snapshot.responses,
        [key]: value,
      },
    };
    persist();
    notify();
  },
};

export type PlannerSettingsStore = typeof plannerSettingsStore;

