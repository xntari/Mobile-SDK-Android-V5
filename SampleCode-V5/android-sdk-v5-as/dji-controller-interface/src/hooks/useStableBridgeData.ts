import { useState, useEffect } from 'react';
import { bridgeManager } from '../bridgeManager';
import { BridgeDataState, ConnectionStatus } from '../types';

export const useStableBridgeData = () => {
  const [state, setState] = useState(() => bridgeManager.getState());
  const [renderCount, setRenderCount] = useState(0);

  useEffect(() => {
    // Initialize the bridge manager (only runs once globally)
    bridgeManager.init();

    // Subscribe to changes
    const unsubscribe = bridgeManager.subscribe(() => {
      setState(bridgeManager.getState());
      setRenderCount(prev => prev + 1); // Force re-render
    });

    // Get initial connection status
    if (window.electronAPI) {
      window.electronAPI.getConnectionStatus().then(status => {
        setState(prev => ({ ...prev, connectionStatus: status as ConnectionStatus }));
      });
    }

    // Cleanup on unmount
    return unsubscribe;
  }, []); // Empty dependency array - truly runs once per component mount

  return {
    bridgeData: state.bridgeData,
    connectionStatus: state.connectionStatus,
    // Placeholder functions (can be implemented later if needed)
    sendBridgeCommand: async () => ({ success: false }),
    getConnectionStatus: async () => state.connectionStatus,
    getDataAge: () => null,
    isDataStale: () => false,
  };
};