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
        //console.log('📡 Bridge: Received telemetry_data message');
        // Convert yaw (-180 to +180) to compass heading (0 to 360)
        const convertYawToCompass = (yaw: number): number => {
          let compass = yaw;
          if (compass < 0) compass += 360;
          return compass;
        };
        
        // Calculate bearing from aircraft to home using great circle formula
        const calculateBearing = (from: any, to: any): number => {
          if (!from || !to) return 0;

          const lat1 = from.latitude * Math.PI / 180;
          const lat2 = to.latitude * Math.PI / 180;
          const deltaLng = (to.longitude - from.longitude) * Math.PI / 180;

          const y = Math.sin(deltaLng) * Math.cos(lat2);
          const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

          let bearing = Math.atan2(y, x) * 180 / Math.PI;
          // Normalize to 0-360°
          return (bearing + 360) % 360;
        };
        
        // Use attitude yaw and convert to proper compass heading since compass_heading seems broken
        const rawYaw = message.attitude?.yaw || message.compass_heading || message.heading || 0;
        const trueCompassHeading = convertYawToCompass(rawYaw);
        const bearingToHome = calculateBearing(message.location, message.home_location);

        // Debug home bearing calculation
        //console.log('🏠 Bridge: Home bearing calculation', {
        //  aircraft_lat: message.location?.latitude,
        //  aircraft_lng: message.location?.longitude,
        //  home_lat: message.home_location?.latitude,
        //  home_lng: message.home_location?.longitude,
        //  calculated_bearing: bearingToHome,
        //  has_both_locations: !!(message.location && message.home_location)
        //});

        // Debug compass data
        // console.log('🧭 Compass Data Debug:', {
        //   received_compass_heading: message.compass_heading,
        //   received_heading: message.heading,
        //   attitude_yaw: message.attitude?.yaw,
        //   converted_compass: trueCompassHeading,
        //   bearing_to_home: bearingToHome
        // });

        // Debug obstacle avoidance data
        // console.log('🚧 Obstacle Avoidance Debug:', {
        //   obstacle_avoidance: message.obstacle_avoidance,
        //   has_obstacle_data: !!message.obstacle_avoidance,
        //   enabled: message.obstacle_avoidance?.enabled,
        //   sectors_count: message.obstacle_avoidance?.sectors?.length || 0
        // });
        
        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: trueCompassHeading,
          attitude: message.attitude || { pitch: 0, roll: 0, yaw: 0 },
          compass_heading: trueCompassHeading,
          home_bearing: bearingToHome,
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
