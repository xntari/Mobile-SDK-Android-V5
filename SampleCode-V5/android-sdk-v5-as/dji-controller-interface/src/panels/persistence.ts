import { LayoutSchema, PanelState } from './types';

const STORAGE_KEY = 'ui.layout.v1';
const CURRENT_VERSION = '1.0.0';

export const createDefaultLayout = (): LayoutSchema => ({
  version: CURRENT_VERSION,
  timestamp: Date.now(),
  modeLayouts: {
    default: {}
  },
  activeMode: 'default'
});

export const saveLayout = (panelStates: Map<string, PanelState>): void => {
  try {
    const layout: LayoutSchema = {
      version: CURRENT_VERSION,
      timestamp: Date.now(),
      modeLayouts: {
        default: Object.fromEntries(
          Array.from(panelStates.entries()).map(([id, state]) => [
            id,
            {
              x: state.x,
              y: state.y,
              w: state.w,
              h: state.h,
              z: state.z,
              minimized: state.minimized,
              closed: state.closed,
              settings: state.settings
            }
          ])
        )
      },
      activeMode: 'default'
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch (error) {
    console.error('Failed to save panel layout:', error);
  }
};

export const loadLayout = (): LayoutSchema | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const layout = JSON.parse(raw) as LayoutSchema;
    return migrateLayout(layout);
  } catch (error) {
    console.error('Failed to load panel layout:', error);
    return null;
  }
};

export const clearLayout = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear panel layout:', error);
  }
};

export const migrateLayout = (layout: any): LayoutSchema => {
  // Handle version migrations
  if (!layout.version || layout.version === '1.0.0') {
    // Current version, no migration needed
    return layout as LayoutSchema;
  }

  // Future version migrations would go here
  console.warn('Unknown layout version:', layout.version);
  return createDefaultLayout();
};

export const clampToViewport = (
  x: number,
  y: number,
  w: number,
  h: number,
  minSize: { w: number; h: number }
): { x: number; y: number; w: number; h: number } => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Ensure minimum size
  const clampedW = Math.max(w, minSize.w);
  const clampedH = Math.max(h, minSize.h);

  // Clamp to viewport bounds
  let clampedX = Math.max(0, Math.min(x, viewportWidth - clampedW));
  let clampedY = Math.max(0, Math.min(y, viewportHeight - clampedH));

  // If panel is too large for viewport, center it
  if (clampedW > viewportWidth) {
    clampedX = (viewportWidth - clampedW) / 2;
  }
  if (clampedH > viewportHeight) {
    clampedY = (viewportHeight - clampedH) / 2;
  }

  return {
    x: clampedX,
    y: clampedY,
    w: clampedW,
    h: clampedH
  };
};