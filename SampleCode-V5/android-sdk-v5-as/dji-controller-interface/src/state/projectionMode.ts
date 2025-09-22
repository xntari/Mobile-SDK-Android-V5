export type ProjectionMode = 'real' | 'horizontal' | 'fallback';

type Listener = (mode: ProjectionMode) => void;

class ProjectionModeStore {
  private mode: ProjectionMode = 'fallback';
  private listeners: Set<Listener> = new Set();

  constructor() {
    // Load from localStorage on init
    const saved = localStorage.getItem('projectionMode');
    if (saved === 'real' || saved === 'horizontal' || saved === 'fallback') {
      this.mode = saved;
    }
  }

  getMode(): ProjectionMode {
    return this.mode;
  }

  setMode(mode: ProjectionMode): void {
    this.mode = mode;
    localStorage.setItem('projectionMode', mode);

    // Notify all listeners
    this.listeners.forEach((listener) => {
      try {
        listener(mode);
      } catch (err) {
        console.warn('[ProjectionModeStore] listener error', err);
      }
    });

    // Send to bridge if available
    if ((window as any).dji?.sendCommand) {
      (window as any).dji.sendCommand({
        type: 'set_projection_mode',
        mode: mode
      });
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const projectionModeStore = new ProjectionModeStore();