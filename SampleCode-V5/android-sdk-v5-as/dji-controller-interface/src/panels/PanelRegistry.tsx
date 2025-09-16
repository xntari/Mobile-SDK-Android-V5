import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo } from 'react';
import { PanelConfig, PanelState, PanelActions, UsePanelReturn, PanelBounds } from './types';
import { panelReducer, createInitialState } from './reducer';
import { saveLayout, loadLayout, clearLayout } from './persistence';

interface PanelRegistryContextValue {
  panels: Map<string, PanelConfig>;
  panelStates: Map<string, PanelState>;
  registerPanel: (config: PanelConfig) => void;
  unregisterPanel: (id: string) => void;
  resetLayout: () => void;
  getVisiblePanels: () => Array<[string, PanelConfig, PanelState]>;
}

const PanelRegistryContext = createContext<PanelRegistryContextValue | null>(null);

interface PanelRegistryProviderProps {
  children: React.ReactNode;
}


export const usePanelRegistry = (): PanelRegistryContextValue => {
  const context = useContext(PanelRegistryContext);
  if (!context) {
    throw new Error('usePanelRegistry must be used within a PanelRegistryProvider');
  }
  return context;
};

// Global dispatch hook for WindowChrome and other components
const PanelDispatchContext = createContext<React.Dispatch<any> | null>(null);

const PanelDispatchProvider: React.FC<{ children: React.ReactNode; dispatch: React.Dispatch<any> }> = ({
  children,
  dispatch
}) => (
  <PanelDispatchContext.Provider value={dispatch}>
    {children}
  </PanelDispatchContext.Provider>
);

// Main provider with dispatch context
export const PanelRegistryProvider: React.FC<PanelRegistryProviderProps> = ({ children }) => {
  const [state, dispatch] = useReducer(panelReducer, createInitialState());

  // Load saved layout on mount
  useEffect(() => {
    const savedLayout = loadLayout();
    if (savedLayout) {
      dispatch({ type: 'LOAD_LAYOUT', layout: savedLayout });
    }
  }, []);

  // Save layout when panel states change (throttled)
  useEffect(() => {
    if (state.panelStates.size === 0) return;

    const timeoutId = setTimeout(() => {
      saveLayout(state.panelStates);
    }, 250); // Throttle saves to avoid excessive localStorage writes

    return () => clearTimeout(timeoutId);
  }, [state.panelStates]);

  const registerPanel = useCallback((config: PanelConfig) => {
    dispatch({ type: 'REGISTER_PANEL', config });
  }, []);

  const unregisterPanel = useCallback((id: string) => {
    dispatch({ type: 'UNREGISTER_PANEL', id });
  }, []);

  const resetLayout = useCallback(() => {
    clearLayout();
    dispatch({ type: 'RESET_LAYOUT' });
  }, []);

  const getVisiblePanels = useCallback((): Array<[string, PanelConfig, PanelState]> => {
    const result: Array<[string, PanelConfig, PanelState]> = [];

    state.panels.forEach((config, id) => {
      const panelState = state.panelStates.get(id);
      if (panelState && !panelState.closed) {
        result.push([id, config, panelState]);
      }
    });

    // Sort by z-index (lowest to highest for rendering order)
    result.sort((a, b) => a[2].z - b[2].z);

    return result;
  }, [state.panels, state.panelStates]);

  const contextValue = useMemo((): PanelRegistryContextValue => ({
    panels: state.panels,
    panelStates: state.panelStates,
    registerPanel,
    unregisterPanel,
    resetLayout,
    getVisiblePanels
  }), [state.panels, state.panelStates, registerPanel, unregisterPanel, resetLayout, getVisiblePanels]);

  return (
    <PanelRegistryContext.Provider value={contextValue}>
      <PanelDispatchProvider dispatch={dispatch}>
        {children}
      </PanelDispatchProvider>
    </PanelRegistryContext.Provider>
  );
};

export const usePanel = (id: string): UsePanelReturn => {
  const context = useContext(PanelRegistryContext);
  const dispatch = useContext(PanelDispatchContext);

  if (!context || !dispatch) {
    throw new Error('usePanel must be used within a PanelRegistryProvider');
  }

  // Get current panel state
  const panelState = context.panelStates.get(id) || null;

  const actions = useMemo((): PanelActions => ({
    open: () => {
      dispatch({ type: 'SET_CLOSED', id, closed: false });
      dispatch({ type: 'BRING_TO_FRONT', id });
    },
    close: () => {
      dispatch({ type: 'SET_CLOSED', id, closed: true });
    },
    minimize: () => {
      dispatch({ type: 'SET_MINIMIZED', id, minimized: true });
    },
    restore: () => {
      dispatch({ type: 'SET_MINIMIZED', id, minimized: false });
      dispatch({ type: 'BRING_TO_FRONT', id });
    },
    toggle: () => {
      dispatch({ type: 'TOGGLE_PANEL', id });
    },
    bringToFront: () => {
      dispatch({ type: 'BRING_TO_FRONT', id });
    },
    setBounds: (bounds: Partial<PanelBounds>) => {
      dispatch({ type: 'UPDATE_BOUNDS', id, bounds });
    }
  }), [id, dispatch]);

  return {
    state: panelState,
    actions
  };
};

// Hook for direct dispatch access (used by WindowChrome)
export const usePanelDispatch = () => {
  const dispatch = useContext(PanelDispatchContext);
  if (!dispatch) {
    throw new Error('usePanelDispatch must be used within a PanelRegistryProvider');
  }
  return dispatch;
};