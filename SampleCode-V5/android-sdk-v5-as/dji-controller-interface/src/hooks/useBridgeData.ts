import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  BridgeDataState, 
  ControllerData, 
  TelemetryData, 
  BatteryData, 
  CameraData,
  ConnectionStatus,
  FlightCommandAck,
  BridgeCommand,
  PreflightStatus,
  TelemetryDiagnosticEntry,
  DeviceStatusInfo,
  WaypointTimelineEntry
} from '../types';

const sanitizeDiagnostic = (entry: any): TelemetryDiagnosticEntry | null => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const code = entry.code ?? entry.information_code;
  const level = entry.warning_level ?? entry.level;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : undefined,
    title: typeof entry.title === 'string' ? entry.title : undefined,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    component_id: typeof entry.component_id === 'number' ? entry.component_id : undefined,
    sensor_index: typeof entry.sensor_index === 'number' ? entry.sensor_index : undefined,
    level: typeof level === 'string' ? level.toLowerCase() : undefined,
    level_value: typeof entry.level_value === 'number' ? entry.level_value : null,
  };
};

const sanitizeDeviceStatus = (status: any): DeviceStatusInfo | null => {
  if (!status || typeof status !== 'object') {
    return null;
  }
  return {
    code: typeof status.code === 'string' ? status.code : (typeof status.status_code === 'string' ? status.status_code : undefined),
    label: typeof status.label === 'string' ? status.label : undefined,
    description: typeof status.description === 'string' ? status.description : undefined,
    level: typeof status.level === 'string'
      ? status.level.toLowerCase()
      : (typeof status.warning_level === 'string' ? status.warning_level.toLowerCase() : undefined),
  };
};

export const useBridgeData = () => {
  const [bridgeData, setBridgeData] = useState<BridgeDataState>({
    controller: null,
    telemetry: null,
    battery: null,
    camera: null,
    flightCommandLog: [],
    preflight: null,
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
        const sanitizeWaypointStatus = (): TelemetryData['waypoint_status'] => {
          const status = message.waypoint_status;
          if (!status || typeof status !== 'object') return undefined;
          const executingRaw = status.executing;
          const interruptRaw = status.last_interrupt;
          const timelineRaw = Array.isArray(status.timeline) ? status.timeline : undefined;
          const executing = executingRaw && typeof executingRaw === 'object'
            ? {
                wayline_id: typeof executingRaw.wayline_id === 'number' ? executingRaw.wayline_id : undefined,
                current_waypoint_index: typeof executingRaw.current_waypoint_index === 'number'
                  ? executingRaw.current_waypoint_index
                  : undefined,
                mission_id: typeof executingRaw.mission_id === 'string' ? executingRaw.mission_id : undefined,
              }
            : undefined;
          const interrupt = interruptRaw && typeof interruptRaw === 'object'
            ? {
                code: typeof interruptRaw.code === 'string' ? interruptRaw.code : undefined,
                description: typeof interruptRaw.description === 'string' ? interruptRaw.description : undefined,
              }
            : undefined;
          const timelineEntries = timelineRaw
            ?.map((entry: any): WaypointTimelineEntry | null => {
              if (!entry || typeof entry !== 'object') return null;
              const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
              const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : undefined;
              if (type === 'state') {
                return {
                  type: 'state' as const,
                  timestamp,
                  state: typeof entry.state === 'string' ? entry.state : undefined,
                };
              }
              if (type === 'executing') {
                return {
                  type: 'executing' as const,
                  timestamp,
                  mission_id: typeof entry.mission_id === 'string' ? entry.mission_id : undefined,
                  wayline_id: typeof entry.wayline_id === 'number' ? entry.wayline_id : undefined,
                  current_waypoint_index: typeof entry.current_waypoint_index === 'number'
                    ? entry.current_waypoint_index
                    : undefined,
                  raw: typeof entry.raw === 'string' ? entry.raw : undefined,
                };
              }
              if (type === 'interrupt') {
                const errorRaw = entry.error;
                const error = errorRaw && typeof errorRaw === 'object'
                  ? {
                      code: typeof errorRaw.code === 'string' ? errorRaw.code : undefined,
                      description: typeof errorRaw.description === 'string' ? errorRaw.description : undefined,
                    }
                  : undefined;
                return {
                  type: 'interrupt' as const,
                  timestamp,
                  error,
                };
              }
              return null;
            })
            .filter((entry): entry is WaypointTimelineEntry => Boolean(entry));
          const missionId = typeof status.mission_id === 'string'
            ? status.mission_id
            : (executing?.mission_id ?? undefined);
          return {
            timestamp: typeof status.timestamp === 'number' ? status.timestamp : undefined,
            state: typeof status.state === 'string' ? status.state : undefined,
            mission_id: missionId,
            mission_path: typeof status.mission_path === 'string' ? status.mission_path : undefined,
            backend: typeof status.backend === 'string' ? status.backend : undefined,
            executing,
            last_interrupt: interrupt,
            timeline: timelineEntries && timelineEntries.length ? timelineEntries : undefined,
          };
        };

        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: message.heading || 0, // Default if not provided
          waypoint_status: sanitizeWaypointStatus(),
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

      case 'preflight_status':
        const diagList = Array.isArray(message.diagnostics)
          ? (message.diagnostics as any[])
              .map(entry => sanitizeDiagnostic(entry))
              .filter(Boolean) as TelemetryDiagnosticEntry[]
          : [];
        const deviceStatus = sanitizeDeviceStatus(message.device_status);
        const snapshot = {
          type: 'preflight_status',
          version: message.version || '1.0',
          timestamp: message.timestamp || timestamp,
          priority: message.priority || 'normal',
          diagnostics: diagList,
          device_status: deviceStatus || undefined,
        } as PreflightStatus;

        setBridgeData(prev => ({
          ...prev,
          preflight: snapshot,
          lastUpdated: { ...prev.lastUpdated, preflight: timestamp }
        }));
        break;

      case 'flight_command':
        setBridgeData(prev => {
          const ack = {
            ...message,
            status: message.status || message.result || 'unknown',
            action: message.action || 'unknown'
          } as FlightCommandAck;
          if (Array.isArray(message.diagnostics)) {
            ack.diagnostics = (message.diagnostics as any[])
              .map(entry => sanitizeDiagnostic(entry))
              .filter(Boolean) as TelemetryDiagnosticEntry[];
          }
          if (message.device_status) {
            ack.device_status = sanitizeDeviceStatus(message.device_status);
          }
          if (message.landing_monitor && typeof message.landing_monitor === 'object') {
            ack.landing_monitor = { ...message.landing_monitor } as any;
          }
          const history = [...prev.flightCommandLog, ack];
          const MAX_HISTORY = 20;
          const trimmed = history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;
          return {
            ...prev,
            flightCommandLog: trimmed,
            lastUpdated: { ...prev.lastUpdated, flightCommand: timestamp }
          };
        });
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
        flightCommandLog: [],
        preflight: null,
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
      // no-op: shared bridge listeners should remain available globally
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
