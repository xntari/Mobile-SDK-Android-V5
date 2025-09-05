import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  BridgeDataState, 
  ControllerData, 
  TelemetryData, 
  BatteryData, 
  CameraData,
  ConnectionStatus,
  BridgeCommand 
} from '../types';

export const useBridgeData = () => {
  const [bridgeData, setBridgeData] = useState<BridgeDataState>({
    controller: null,
    telemetry: null,
    battery: null,
    camera: null,
    lastUpdated: {},
  });

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [updateCount, setUpdateCount] = useState(0); // Force re-render counter

  // Handle incoming bridge data
  const handleBridgeData = useCallback((message: any) => {
    console.log('🎯 useBridgeData: Received message', message.type, message);
    const timestamp = Date.now();

    switch (message.type) {
      case 'controller_data':
        console.log('🎯 useBridgeData: Updating controller state, joystick:', message.joystick);
        setBridgeData(prev => ({
          ...prev,
          controller: message as ControllerData,
          lastUpdated: { ...prev.lastUpdated, controller: timestamp }
        }));
        setUpdateCount(prev => prev + 1); // Force re-render
        break;

      case 'telemetry_data':
        // Map real bridge fields to our interface format
        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: message.heading || 0, // Default if not provided
        } as TelemetryData;
        
        console.log('🎯 useBridgeData: Setting telemetry data:', mappedTelemetry);
        console.log('🎯 useBridgeData: Original message ground_speed:', message.ground_speed);
        setBridgeData(prev => ({
          ...prev,
          telemetry: mappedTelemetry,
          lastUpdated: { ...prev.lastUpdated, telemetry: timestamp }
        }));
        break;

      case 'sensor_data':
        // Battery data comes through sensor_data type
        if (message.battery) {
          setBridgeData(prev => ({
            ...prev,
            battery: message as BatteryData,
            lastUpdated: { ...prev.lastUpdated, battery: timestamp }
          }));
        }
        break;

      case 'battery_status':
        // Handle real bridge battery_status messages - map to our interface format
        const mappedBattery = {
          type: 'sensor_data',
          version: message.version || '1.0',
          timestamp: message.timestamp || timestamp,
          priority: message.priority || 'low',
          battery: {
            percentage: message.battery?.charge_remaining_percent || message.charge_remaining_percent || 0,
            voltage: message.battery?.voltage || message.voltage || 0,
            current: message.battery?.current || message.current || 0,
            temperature: message.battery?.temperature || message.temperature || 0,
            cell_voltages: message.battery?.cell_voltages || message.cell_voltages || [],
          },
          system_health: 'Good' // Default for compatibility
        } as BatteryData;
        
        setBridgeData(prev => ({
          ...prev,
          battery: mappedBattery,
          lastUpdated: { ...prev.lastUpdated, battery: timestamp }
        }));
        break;

      case 'camera_data':
        setBridgeData(prev => ({
          ...prev,
          camera: message as CameraData,
          lastUpdated: { ...prev.lastUpdated, camera: timestamp }
        }));
        break;

      default:
        console.log('Unhandled bridge message type:', message.type);
        break;
    }
  }, []);

  // Handle connection status changes
  const handleConnectionStatus = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
    
    // Clear data when disconnected
    if (status === 'disconnected' || status === 'error') {
      setBridgeData({
        controller: null,
        telemetry: null,
        battery: null,
        camera: null,
        lastUpdated: {},
      });
    }
  }, []);

  // Send command to bridge
  const sendBridgeCommand = useCallback(async (command: Partial<BridgeCommand>) => {
    const fullCommand: BridgeCommand = {
      type: 'command',
      version: '1.0',
      timestamp: Date.now(),
      command: command.command || 'unknown',
      parameters: command.parameters || {},
      ...command
    };

    try {
      const result = await window.electronAPI.sendBridgeCommand(fullCommand);
      return result;
    } catch (error) {
      console.error('Failed to send bridge command:', error);
      return { success: false, error: 'Failed to send command' };
    }
  }, []);

  // Get current connection status
  const getConnectionStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.getConnectionStatus();
      setConnectionStatus(status as ConnectionStatus);
      return status;
    } catch (error) {
      console.error('Failed to get connection status:', error);
      return 'error';
    }
  }, []);

  // Data freshness helpers
  const getDataAge = useCallback((dataType: keyof BridgeDataState['lastUpdated']) => {
    const lastUpdate = bridgeData.lastUpdated[dataType];
    if (!lastUpdate) return null;
    return Date.now() - lastUpdate;
  }, [bridgeData.lastUpdated]);

  const isDataStale = useCallback((dataType: keyof BridgeDataState['lastUpdated'], maxAge: number = 5000) => {
    const age = getDataAge(dataType);
    return age === null || age > maxAge;
  }, [getDataAge]);

  // Stable callback refs to prevent re-registering
  const bridgeDataRef = useRef(handleBridgeData);
  const connectionStatusRef = useRef(handleConnectionStatus);
  
  // Update refs when callbacks change
  bridgeDataRef.current = handleBridgeData;
  connectionStatusRef.current = handleConnectionStatus;

  // Set up event listeners - run only once
  useEffect(() => {
    console.log('🎯 useBridgeData: Setting up event listeners (ONCE)');
    
    // Use stable wrapper functions
    const stableBridgeCallback = (data: any) => bridgeDataRef.current(data);
    const stableConnectionCallback = (status: string) => connectionStatusRef.current(status as ConnectionStatus);
    
    // Listen for bridge data
    window.electronAPI.onBridgeData(stableBridgeCallback);
    
    // Listen for connection status changes  
    window.electronAPI.onConnectionStatus(stableConnectionCallback);

    // Get initial connection status
    getConnectionStatus();

    // Cleanup on unmount
    return () => {
      window.electronAPI.removeAllListeners('bridge-data');
      window.electronAPI.removeAllListeners('connection-status');
    };
  }, []); // Empty array - run only once

  return {
    bridgeData,
    connectionStatus,
    sendBridgeCommand,
    getConnectionStatus,
    getDataAge,
    isDataStale,
  };
};