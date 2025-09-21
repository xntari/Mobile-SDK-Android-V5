import { ObjectMemoryClusterAnchor } from '../agent/objectMemoryClient';

export type ObjectMemoryTargetSelection = {
  clusterId: string;
  clusterLabel?: string | null;
  anchor: ObjectMemoryClusterAnchor;
};

type Listener = (selection: ObjectMemoryTargetSelection | null) => void;

class ObjectMemoryTargetStore {
  private selection: ObjectMemoryTargetSelection | null = null;
  private listeners: Set<Listener> = new Set();

  getCurrent(): ObjectMemoryTargetSelection | null {
    return this.selection;
  }

  set(selection: ObjectMemoryTargetSelection | null): void {
    this.selection = selection;
    this.listeners.forEach((listener) => {
      try {
        listener(selection);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ObjectMemoryTargetStore] listener error', err);
      }
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const objectMemoryTargetStore = new ObjectMemoryTargetStore();
