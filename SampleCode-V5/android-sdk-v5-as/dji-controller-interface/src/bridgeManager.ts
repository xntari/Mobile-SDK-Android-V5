// Global bridge state manager - survives React re-mounts
import { BridgeDataState, ConnectionStatus, ControllerData, TelemetryData, BatteryData } from './types';

class BridgeManager {
  private listeners: Set<() => void> = new Set();
  private bridgeData: BridgeDataState = {
    controller: null,
    telemetry: null,
    battery: null,
    camera: null,
    lastUpdated: {},
  };
  private connectionStatus: ConnectionStatus = 'disconnected';
  private initialized = false;

  // Initialize only once
  init() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    // Set up the browser WebSocket connection
    (window as any).electronAPI.onBridgeData((message: any) => {
      this.handleMessage(message);
    });

    (window as any).electronAPI.onConnectionStatus((status: string) => {
      this.connectionStatus = status as ConnectionStatus;
      this.notifyListeners();
    });
  }

  private handleMessage(message: any) {
    const timestamp = Date.now();

    switch (message.type) {
      case 'controller_data':
        this.bridgeData = {
          ...this.bridgeData,
          controller: message as ControllerData,
          lastUpdated: { ...this.bridgeData.lastUpdated, controller: timestamp }
        };
        break;

      case 'telemetry_data':
        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: message.heading || 0,
        } as TelemetryData;
        
        this.bridgeData = {
          ...this.bridgeData,
          telemetry: mappedTelemetry,
          lastUpdated: { ...this.bridgeData.lastUpdated, telemetry: timestamp }
        };
        break;

      case 'battery_status':
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
          system_health: 'Good'
        } as BatteryData;
        
        this.bridgeData = {
          ...this.bridgeData,
          battery: mappedBattery,
          lastUpdated: { ...this.bridgeData.lastUpdated, battery: timestamp }
        };
        break;
    }

    this.notifyListeners();
  }

  private notifyListeners() {
    this.listeners.forEach(listener => listener());
  }

  // Subscribe to data changes
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Get current state
  getState() {
    return {
      bridgeData: this.bridgeData,
      connectionStatus: this.connectionStatus
    };
  }

  // Send bridge commands
  async sendBridgeCommand(command: any): Promise<any> {
    if (!window.electronAPI) {
      throw new Error('Bridge API not available');
    }

    return await window.electronAPI.sendBridgeCommand(command);
  }
}

// Global singleton
export const bridgeManager = new BridgeManager();