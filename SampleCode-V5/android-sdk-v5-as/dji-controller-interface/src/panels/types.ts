export interface PanelBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelMinSize {
  w: number;
  h: number;
}

export interface PanelState {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  closed: boolean;
  focused: boolean;
  settings?: Record<string, any>;
}

export interface PanelConfig {
  id: string;
  title: string;
  defaultBounds: PanelBounds;
  minSize: PanelMinSize;
  component: React.ComponentType<any>;
  resizable?: boolean;
  closeable?: boolean;
}

export interface LayoutSchema {
  version: string;
  timestamp: number;
  modeLayouts: {
    default: Record<string, Omit<PanelState, 'id' | 'title' | 'focused'>>;
    fpv?: Record<string, Omit<PanelState, 'id' | 'title' | 'focused'>>;
    h20n?: Record<string, Omit<PanelState, 'id' | 'title' | 'focused'>>;
    dual?: Record<string, Omit<PanelState, 'id' | 'title' | 'focused'>>;
  };
  activeMode: string;
}

export type PanelAction =
  | { type: 'REGISTER_PANEL'; config: PanelConfig }
  | { type: 'UNREGISTER_PANEL'; id: string }
  | { type: 'UPDATE_BOUNDS'; id: string; bounds: Partial<PanelBounds> }
  | { type: 'SET_MINIMIZED'; id: string; minimized: boolean }
  | { type: 'SET_CLOSED'; id: string; closed: boolean }
  | { type: 'SET_FOCUSED'; id: string; focused: boolean }
  | { type: 'BRING_TO_FRONT'; id: string }
  | { type: 'TOGGLE_PANEL'; id: string }
  | { type: 'RESET_LAYOUT' }
  | { type: 'LOAD_LAYOUT'; layout: LayoutSchema };

export interface PanelActions {
  open: () => void;
  close: () => void;
  minimize: () => void;
  restore: () => void;
  toggle: () => void;
  bringToFront: () => void;
  setBounds: (bounds: Partial<PanelBounds>) => void;
}

export interface UsePanelReturn {
  state: PanelState | null;
  actions: PanelActions;
}