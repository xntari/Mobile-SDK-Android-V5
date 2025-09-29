// Bridge message types
export interface TelemetryDiagnosticEntry {
  title?: string;
  description?: string;
  code?: string;
  component_id?: number;
  sensor_index?: number;
  level?: string;
  level_value?: number | null;
}

export interface DeviceStatusInfo {
  code?: string;
  label?: string;
  description?: string;
  level?: string;
}

export interface LandingMonitorInfo {
  elapsed_ms?: number;
  motors_on?: boolean;
  altitude?: number;
  [key: string]: any;
}

export interface FlySafeWarningNotification {
  event?: string;
  description?: string;
  height_limit?: number | null;
}

export interface FlySafeZoneInfo {
  id?: number;
  name?: string;
  category?: string;
  type?: string;
  shape?: string;
  lower_limit?: number | null;
  upper_limit?: number | null;
  center_latitude?: number | null;
  center_longitude?: number | null;
}

export interface FlySafeSnapshot {
  warning_notification?: FlySafeWarningNotification;
  surrounding_zones?: FlySafeZoneInfo[];
}

export interface FlyToContextLocation {
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

export interface FlyToContext {
  timestamp?: number;
  altitude_specified?: boolean;
  current_altitude_agl?: number;
  current_altitude_ultrasonic?: number | null;
  takeoff_altitude_asl?: number;
  current_location?: FlyToContextLocation;
  home_location?: {
    latitude?: number;
    longitude?: number;
  };
  target_altitude_asl?: number | null;
  target_altitude_relative_takeoff?: number;
  target_altitude_margin_from_current?: number;
  height_limit_setting?: number;
  height_limit_margin?: number;
  fly_safe_height_limit?: number;
  fly_safe_margin?: number;
  fly_safe_warning_event?: string;
  fly_safe_warning_description?: string;
  likely_fly_safe_violation?: boolean;
  likely_height_limit_violation?: boolean;
  mode?: string;
  max_speed?: number;
  security_takeoff_height?: number;
  requested_height?: number;
}

export interface FlyToInfoStatus {
  mode?: string;
  height?: number;
  is_running?: boolean;
  target_location?: FlyToContextLocation;
  raw?: string;
}

export interface FlyToTargetStatus {
  target_location?: FlyToContextLocation;
  max_speed?: number;
  security_takeoff_height?: number;
  raw?: string;
}

export interface FlyToCapabilityStatus {
  supported_modes?: string[];
  height_range?: { min?: number | null; max?: number | null };
  raw?: string;
}

export interface FlyToStatus {
  timestamp?: number;
  info?: FlyToInfoStatus;
  target?: FlyToTargetStatus;
  capability?: FlyToCapabilityStatus;
}

export interface SimulatorConfigurationSnapshot {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  satellites?: number;
  frequency_hz?: number;
  source?: string;
  timestamp?: number;
}

export interface SimulatorErrorSnapshot {
  code?: string;
  code_value?: number;
  description?: string;
  domain?: string;
}

export interface SimulatorTelemetry {
  mode?: 'simulator' | 'real';
  enabled?: boolean;
  timestamp?: number;
  listener_registered?: boolean;
  motors_on?: boolean;
  flying?: boolean;
  attitude?: { roll?: number; pitch?: number; yaw?: number };
  position?: { x?: number; y?: number; z?: number };
  location?: { latitude?: number; longitude?: number; altitude?: number };
  configuration?: SimulatorConfigurationSnapshot;
  last_error?: SimulatorErrorSnapshot;
}

export interface WaypointExecutingStatus {
  wayline_id?: number;
  current_waypoint_index?: number;
  mission_id?: string;
}

export interface WaypointInterruptStatus {
  code?: string;
  description?: string;
}

export type WaypointTimelineEntry =
  | {
      type: 'state';
      timestamp?: number;
      state?: string;
      label?: string;
    }
  | {
      type: 'executing';
      timestamp?: number;
      mission_id?: string;
      wayline_id?: number;
      current_waypoint_index?: number;
      raw?: string;
      label?: string;
      execute_state?: string;
      pause_reason?: string;
      resume_reason?: string;
      exit_reason?: string;
    }
  | {
      type: 'interrupt';
      timestamp?: number;
      error?: WaypointInterruptStatus;
      label?: string;
    }
  | {
      type: 'event';
      timestamp?: number;
      event?: string;
      reason?: string;
      mission_id?: string;
      wayline_id?: number;
      current_waypoint_index?: number;
      label?: string;
    }
  | {
      type: 'breakpoint';
      timestamp?: number;
      mission_id?: string;
      wayline_id?: number | null;
      waypoint_id?: number | null;
      segment_progress?: number | null;
      recover_action?: string | null;
      location?: {
        latitude?: number | null;
        longitude?: number | null;
        altitude?: number | null;
      };
      source?: string;
      label?: string;
    }
  | {
      type: 'breakpoint_error';
      timestamp?: number;
      mission_id?: string;
      error?: WaypointInterruptStatus;
      source?: string;
      label?: string;
    };

export interface WaypointStatusTelemetry {
  timestamp?: number;
  state?: string;
  executing?: WaypointExecutingStatus;
  last_interrupt?: WaypointInterruptStatus;
  mission_id?: string;
  mission_path?: string;
  backend?: string;
  timeline?: WaypointTimelineEntry[];
  waypoints?: WaypointStatusWaypoint[];
  security_takeoff_height?: number;
}

export interface WaypointStatusWaypoint {
  index?: number;
  latitude?: number;
  longitude?: number;
  execute_height?: number;
  kind?: string;
}

export interface BridgeMessage {
  type: string;
  version: string;
  timestamp: number;
  priority: string;
}

export interface FlightCommandAck extends BridgeMessage {
  type: 'flight_command';
  action: string;
  status: 'ok' | 'error' | string;
  message?: string;
  error_message?: string;
  error_code?: string;
  error_code_value?: number;
  error_type?: string;
  error_domain?: string;
  enabled?: boolean;
  joystick?: {
    left_horizontal?: number;
    left_vertical?: number;
    right_horizontal?: number;
    right_vertical?: number;
  };
  target_location?: {
    latitude?: number;
    longitude?: number;
    altitude?: number | null;
  };
  max_speed?: number;
  security_takeoff_height?: number;
  mode?: string;
  diagnostics?: TelemetryDiagnosticEntry[];
  device_status?: DeviceStatusInfo | null;
  source?: string;
  landing_monitor?: LandingMonitorInfo;
  fly_safe?: FlySafeSnapshot;
  fly_to_context?: FlyToContext;
  fly_to_param_update?: string;
  fly_to_param_message?: string;
  fly_to_param_error?: string;
  fly_to_param_steps?: Array<{ type?: string; status?: string; message?: string }>;
  fly_to_status_snapshot?: FlyToStatus;
  backend?: string;
  mission_id?: string;
  mission_path?: string;
  file_path?: string;
  wayline_ids?: number[];
  auto_flight_speed?: number;
  fallback_reason?: string;
  debug?: Record<string, any> | null;
  simulator?: SimulatorTelemetry;
}

export interface PreflightStatus extends BridgeMessage {
  type: 'preflight_status';
  diagnostics: TelemetryDiagnosticEntry[];
  device_status?: DeviceStatusInfo | null;
  fly_safe?: any;
  flight_settings?: PreflightFlightSettings | null;
  power?: PreflightPowerStatus | null;
  controller_settings?: PreflightControllerSettings | null;
}

export interface PreflightObstacleAvoidanceSettings {
  collision_avoidance?: boolean;
  vision_positioning?: boolean;
  landing_protection?: string;
}

export interface PreflightFlightSettings {
  return_home_altitude?: number;
  max_altitude?: number;
  max_distance?: number;
  max_distance_enabled?: boolean;
  signal_lost_action?: string;
  obstacle_avoidance?: PreflightObstacleAvoidanceSettings;
}

export interface PreflightPowerStatus {
  aircraft_percent?: number;
  controller_percent?: number;
  low_warning_threshold?: number;
  critical_warning_threshold?: number;
}

export interface PreflightVirtualStickSettings {
  enabled?: boolean;
  authority_owner?: string;
  manual_override?: boolean;
}

export interface PreflightControllerSettings {
  stick_mode?: string;
  rc_mode?: string;
  virtual_stick?: PreflightVirtualStickSettings;
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
  authority_owner?: string;
  virtual_stick?: {
    enabled: boolean;
    advanced_enabled?: boolean;
    authority_owner?: string;
    manual_override?: boolean;
    change_reason?: string;
  };
  battery_percent?: number;
}

export interface TelemetryData extends BridgeMessage {
  type: 'telemetry_data';
  altitude: number;
  altitude_above_home: number;
  altitude_above_takeoff?: number;
  altitude_barometric?: number;
  altitude_amsl?: number;
  altitude_gps_relative?: number;
  altitude_ultrasonic?: number;
  takeoff_altitude?: number;
  max_flight_height?: number;
  max_flight_distance?: number;
  max_flight_distance_enabled?: boolean;
  go_home_height?: number;
  motors_on?: boolean;
  speed: number;
  flight_mode?: string;
  flight_mode_label?: string;
  is_auto_landing?: boolean;
  is_auto_returning_home?: boolean;
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
  distance_to_home: number;
  heading: number;
  compass_heading?: number;
  home_bearing?: number;
  satellite_count?: number;
  gps_signal_level?: string;
  rc_signal_quality?: number;
  system_status?: {
    code?: string;
    label?: string;
    description?: string;
    level?: string;
  } | null;
  system_status_level?: string;
  diagnostics?: TelemetryDiagnosticEntry[];
  diagnostics_severity?: string;
  fly_safe?: any;
  fly_to_status?: FlyToStatus;
  simulator?: SimulatorTelemetry;
  waypoint_status?: WaypointStatusTelemetry;
  obstacle_avoidance?: {
    enabled: boolean;
    sectors: Array<{
      angle: number;
      distance: number;
      warning_level: 'none' | 'caution' | 'warning' | 'critical';
    }>;
  };
  velocity_vector?: {
    x: number;
    y: number;
    z: number;
  };
  gimbals?: Array<{
    index: string;
    connected: boolean;
    attitude?: { pitch: number; roll: number; yaw: number };
    yaw_relative?: number;
    limits?: {
      pitch?: { min?: number; max?: number };
      yaw?: { min?: number; max?: number };
      roll?: { min?: number; max?: number };
    };
  }>;
  camera_optics?: {
    index: string;
    lens?: string;
    lens_type?: string;
    zoom_ratio?: number;
    zoom_range?: { min?: number; max?: number };
    focal_length?: number;
    display_fov?: { horizontal?: number; vertical?: number };
    laser_measurement?: string;
  };
  fpv_optics?: {
    index?: string;
    lens?: string;
    lens_type?: string;
    zoom_ratio?: number;
    zoom_range?: { min?: number; max?: number };
    focal_length?: number;
    display_fov?: { horizontal?: number; vertical?: number };
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
  flightCommandLog: FlightCommandAck[];
  preflight: PreflightStatus | null;
  lastUpdated: {
    controller?: number;
    telemetry?: number;
    battery?: number;
    camera?: number;
    flightCommand?: number;
    preflight?: number;
  };
}

// UI Component Props
export interface TopBarProps {
  batteryData: BatteryData | null;
  telemetryData: TelemetryData | null;
  connectionStatus: ConnectionStatus;
  controllerData?: ControllerData | null;
  preflightStatus?: PreflightStatus | null;
}

export interface FPVDisplayProps {
  width?: number;
  height?: number;
  className?: string;
  children?: React.ReactNode;
  telemetryData?: TelemetryData | null;
  visionDetections?: any[];
  agentDetections?: any[];
  visionMasks?: any[];
  visionKeypoints?: Array<Array<{ x:number; y:number; conf?: number }>>;
  maskOpacity?: number;
  colorizeById?: boolean;
  detectThickness?: number;
  visionHeatmap?: string | null;
  visionHeatmapOpacity?: number;
}

export interface H20NDisplayProps {
  width?: number;
  height?: number;
  className?: string;
  children?: React.ReactNode;
  telemetryData?: TelemetryData | null;
  visionDetections?: any[];
  agentDetections?: any[];
  visionMasks?: any[];
  visionKeypoints?: Array<Array<{ x:number; y:number; conf?: number }>>;
  maskOpacity?: number;
  colorizeById?: boolean;
  detectThickness?: number;
  visionHeatmap?: string | null;
  visionHeatmapOpacity?: number;
}

export interface HSICompassProps {
  size?: 'small' | 'normal';
  standalone?: boolean; // Whether to show own glass-panel container
  // Note: HSI now uses direct electronAPI listeners for telemetry like camera components
}

export interface MapDisplayProps {
  flightPath?: Array<{ latitude: number; longitude: number }>;
  telemetryData?: TelemetryData | null;
  // Note: Map now uses direct electronAPI listeners for telemetry like camera components
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
