import { PanelAction, PanelState, PanelConfig } from './types';
import { clampToViewport } from './persistence';

export interface PanelRegistryState {
  panels: Map<string, PanelConfig>;
  panelStates: Map<string, PanelState>;
  nextZIndex: number;
}

export const createInitialState = (): PanelRegistryState => ({
  panels: new Map(),
  panelStates: new Map(),
  nextZIndex: 1000
});

export const panelReducer = (
  state: PanelRegistryState,
  action: PanelAction
): PanelRegistryState => {
  switch (action.type) {
    case 'REGISTER_PANEL': {
      const { config } = action;
      const newPanels = new Map(state.panels);
      const newStates = new Map(state.panelStates);

      newPanels.set(config.id, config);

      // Create default state if not exists
      if (!newStates.has(config.id)) {
        const clamped = clampToViewport(
          config.defaultBounds.x,
          config.defaultBounds.y,
          config.defaultBounds.w,
          config.defaultBounds.h,
          config.minSize
        );

        newStates.set(config.id, {
          id: config.id,
          title: config.title,
          x: clamped.x,
          y: clamped.y,
          w: clamped.w,
          h: clamped.h,
          z: state.nextZIndex,
          minimized: false,
          closed: false,
          focused: false,
          settings: {}
        });
      }

      return {
        ...state,
        panels: newPanels,
        panelStates: newStates,
        nextZIndex: state.nextZIndex + 1
      };
    }

    case 'UNREGISTER_PANEL': {
      const newPanels = new Map(state.panels);
      const newStates = new Map(state.panelStates);
      newPanels.delete(action.id);
      newStates.delete(action.id);

      return {
        ...state,
        panels: newPanels,
        panelStates: newStates
      };
    }

    case 'UPDATE_BOUNDS': {
      const { id, bounds } = action;
      const currentState = state.panelStates.get(id);
      if (!currentState) return state;

      const config = state.panels.get(id);
      if (!config) return state;

      const newX = bounds.x ?? currentState.x;
      const newY = bounds.y ?? currentState.y;
      const newW = bounds.w ?? currentState.w;
      const newH = bounds.h ?? currentState.h;

      const clamped = clampToViewport(newX, newY, newW, newH, config.minSize);

      const newStates = new Map(state.panelStates);
      newStates.set(id, {
        ...currentState,
        x: clamped.x,
        y: clamped.y,
        w: clamped.w,
        h: clamped.h
      });

      return {
        ...state,
        panelStates: newStates
      };
    }

    case 'SET_MINIMIZED': {
      const { id, minimized } = action;
      const currentState = state.panelStates.get(id);
      if (!currentState) return state;

      const newStates = new Map(state.panelStates);
      newStates.set(id, {
        ...currentState,
        minimized,
        focused: minimized ? false : currentState.focused
      });

      return {
        ...state,
        panelStates: newStates
      };
    }

    case 'SET_CLOSED': {
      const { id, closed } = action;
      const currentState = state.panelStates.get(id);
      if (!currentState) return state;

      const newStates = new Map(state.panelStates);
      newStates.set(id, {
        ...currentState,
        closed,
        minimized: closed ? false : currentState.minimized,
        focused: closed ? false : currentState.focused
      });

      return {
        ...state,
        panelStates: newStates
      };
    }

    case 'SET_FOCUSED': {
      const { id, focused } = action;
      const newStates = new Map(state.panelStates);

      // Unfocus all panels first
      newStates.forEach((panelState, panelId) => {
        if (panelId !== id) {
          newStates.set(panelId, { ...panelState, focused: false });
        }
      });

      // Focus the target panel
      const currentState = newStates.get(id);
      if (currentState) {
        newStates.set(id, { ...currentState, focused });
      }

      return {
        ...state,
        panelStates: newStates
      };
    }

    case 'BRING_TO_FRONT': {
      const { id } = action;
      const currentState = state.panelStates.get(id);
      if (!currentState) return state;

      const newStates = new Map(state.panelStates);

      // Unfocus all other panels and focus this one
      newStates.forEach((panelState, panelId) => {
        if (panelId !== id) {
          newStates.set(panelId, { ...panelState, focused: false });
        }
      });

      newStates.set(id, {
        ...currentState,
        z: state.nextZIndex,
        focused: true
      });

      return {
        ...state,
        panelStates: newStates,
        nextZIndex: state.nextZIndex + 1
      };
    }

    case 'TOGGLE_PANEL': {
      const { id } = action;
      const currentState = state.panelStates.get(id);
      if (!currentState) return state;

      const newStates = new Map(state.panelStates);

      if (currentState.closed) {
        // Open and bring to front
        newStates.forEach((panelState, panelId) => {
          if (panelId !== id) {
            newStates.set(panelId, { ...panelState, focused: false });
          }
        });

        newStates.set(id, {
          ...currentState,
          closed: false,
          minimized: false,
          focused: true,
          z: state.nextZIndex
        });

        return {
          ...state,
          panelStates: newStates,
          nextZIndex: state.nextZIndex + 1
        };
      } else {
        // Close
        newStates.set(id, {
          ...currentState,
          closed: true,
          minimized: false,
          focused: false
        });

        return {
          ...state,
          panelStates: newStates
        };
      }
    }

    case 'RESET_LAYOUT': {
      const newStates = new Map<string, PanelState>();
      let zIndex = 1000;

      // Reset all registered panels to their default bounds
      state.panels.forEach((config, id) => {
        const clamped = clampToViewport(
          config.defaultBounds.x,
          config.defaultBounds.y,
          config.defaultBounds.w,
          config.defaultBounds.h,
          config.minSize
        );

        newStates.set(id, {
          id: config.id,
          title: config.title,
          x: clamped.x,
          y: clamped.y,
          w: clamped.w,
          h: clamped.h,
          z: zIndex++,
          minimized: false,
          closed: false,
          focused: false,
          settings: {}
        });
      });

      return {
        ...state,
        panelStates: newStates,
        nextZIndex: zIndex
      };
    }

    case 'LOAD_LAYOUT': {
      const { layout } = action;
      const newStates = new Map(state.panelStates);
      const activeLayout = layout.modeLayouts[layout.activeMode] || layout.modeLayouts.default;

      let maxZ = state.nextZIndex;

      // Apply layout to existing panels only
      Object.entries(activeLayout).forEach(([id, savedState]) => {
        const config = state.panels.get(id);
        if (config && newStates.has(id)) {
          // Type assertion for saved state
          const typedSavedState = savedState as {
            x: number;
            y: number;
            w: number;
            h: number;
            z: number;
            minimized: boolean;
            closed: boolean;
            settings?: Record<string, any>;
          };

          const clamped = clampToViewport(
            typedSavedState.x,
            typedSavedState.y,
            typedSavedState.w,
            typedSavedState.h,
            config.minSize
          );

          const currentState = newStates.get(id)!;
          newStates.set(id, {
            ...currentState,
            x: clamped.x,
            y: clamped.y,
            w: clamped.w,
            h: clamped.h,
            z: typedSavedState.z,
            minimized: typedSavedState.minimized,
            closed: typedSavedState.closed,
            focused: false, // Focus will be managed separately
            settings: typedSavedState.settings || {}
          });

          maxZ = Math.max(maxZ, typedSavedState.z);
        }
      });

      return {
        ...state,
        panelStates: newStates,
        nextZIndex: maxZ + 1
      };
    }

    default:
      return state;
  }
};