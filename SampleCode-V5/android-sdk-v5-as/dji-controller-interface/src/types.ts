// Bridge message types
export interface BridgeMessage {
  type: string;
  version: string;
  timestamp: number;
  priority: string;
}

export interface ControllerData extends BridgeMessage {
  type: 'controller_data';
  joystick: {
    left_horizontal: number;   // Yaw (-100 to 100)
    left_vertical: number;     // Throttle (-100 to 100)
    right_horizontal: number;  // Roll (-100 to 100)
    right_vertical: number;    // Pitch (-100 to 100)
  };
  flight_params: {
    yaw: number;      // Normalized (-1.0 to 1.0)
    throttle: number;
    roll: number;
    pitch: number;
  };
  virtual_stick_enabled: boolean;
}

export interface TelemetryData extends BridgeMessage {
  type: 'telemetry_data';
  altitude: number;
  altitude_above_home: number;
  speed: number;
  location: {
    latitude: number;
    longitude: number;
    altitude: number;
  };
  home_location: {
    latitude: number;
    longitude: number;
    altitude: number;
  };
  attitude: {
    roll: number;
    pitch: number;
    yaw: number;
  };
  flight_mode: string;
  distance_to_home: number;
  heading: number;
  compass_heading?: number;  // Real magnetometer heading
  home_bearing?: number;
  satellite_count?: number;
  gps_signal_quality?: number;
  obstacle_avoidance?: {
    enabled: boolean;
    sectors: Array<{
      angle: number;      // Angle in degrees (0 = front, clockwise)
      distance: number;   // Distance in meters
      warning_level: 'none' | 'caution' | 'warning' | 'critical';
    }>;
  };
}

export interface BatteryData extends BridgeMessage {
  type: 'sensor_data';
  battery: {
    percentage: number;
    voltage: number;
    current: number;
    temperature: number;
    cell_voltages?: number[];
    cycles?: number;
    remaining_mah?: number;
    full_charge_capacity?: number;
  };
  system_health: string;
}

export interface CameraData extends BridgeMessage {
  type: 'camera_data';
  mode: string;
  iso: string;
  shutter_speed: string;
  recording_status: boolean;
  storage_status: string;
  available_storage: number;
  gimbal_attitude: {
    pitch: number;
    roll: number;
    yaw: number;
  };
}

// Combined data interface
export interface BridgeDataState {
  controller: ControllerData | null;
  telemetry: TelemetryData | null;
  battery: BatteryData | null;
  camera: CameraData | null;
  lastUpdated: {
    controller?: number;
    telemetry?: number;
    battery?: number;
    camera?: number;
  };
}

// UI Component Props
export interface TopBarProps {
  batteryData: BatteryData | null;
  telemetryData: TelemetryData | null;
  controllerData: ControllerData | null;
  connectionStatus: ConnectionStatus;
}

export interface FPVDisplayProps {
  width?: number;
  height?: number;
  className?: string;
  children?: React.ReactNode;
}

export interface H20NDisplayProps {
  width?: number;
  height?: number;
  className?: string;
  children?: React.ReactNode;
}

export interface HSICompassProps {
  attitude: TelemetryData['attitude'] | null;
  heading: number;
  homeDirection?: number;
  size?: 'small' | 'normal';
  telemetryData?: TelemetryData | null; // Full telemetry for obstacle data
}

export interface MapDisplayProps {
  aircraftLocation: TelemetryData['location'] | null;
  homeLocation: TelemetryData['home_location'] | null;
  flightPath?: Array<{ latitude: number; longitude: number }>;
  compassHeading?: number; // For map auto-rotation
}

// Connection and status types
export type ConnectionStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error';

export interface WindowControls {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

// Command types for sending to bridge
export interface BridgeCommand {
  type: string;
  version: string;
  timestamp: number;
  command: string;
  parameters?: Record<string, any>;
}

export interface JoystickOverrideCommand extends BridgeCommand {
  command: 'joystick_override';
  parameters: {
    pitch: number;
    roll: number;
    yaw: number;
    throttle: number;
    enable: boolean;
  };
}

export interface CameraCommand extends BridgeCommand {
  command: 'camera_control';
  parameters: {
    action: 'take_photo' | 'start_recording' | 'stop_recording' | 'gimbal_rotate';
    pitch?: number;
    yaw?: number;
  };
}
