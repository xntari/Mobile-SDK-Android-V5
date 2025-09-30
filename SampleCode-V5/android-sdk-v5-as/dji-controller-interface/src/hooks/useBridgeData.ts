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
  WaypointTimelineEntry,
  SimulatorTelemetry,
  SimulatorConfigurationSnapshot,
  SimulatorErrorSnapshot,
  PreflightFlightSettings,
  PreflightPowerStatus,
  PreflightControllerSettings,
  RemoteIDSnapshot
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

const sanitizeSimulator = (payload: any): SimulatorTelemetry | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const hasValues = (obj: Record<string, any> | undefined): boolean => {
    if (!obj) return false;
    return Object.values(obj).some((value) => {
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value === 'number') {
        return !Number.isNaN(value);
      }
      return true;
    });
  };

  const prune = <T extends Record<string, any>>(obj: T | undefined): T | undefined => {
    if (!obj) return undefined;
    return hasValues(obj) ? obj : undefined;
  };

  const attitudeRaw = payload.attitude;
  const attitude = prune({
    roll: typeof attitudeRaw?.roll === 'number' ? attitudeRaw.roll : undefined,
    pitch: typeof attitudeRaw?.pitch === 'number' ? attitudeRaw.pitch : undefined,
    yaw: typeof attitudeRaw?.yaw === 'number' ? attitudeRaw.yaw : undefined,
  }) as SimulatorTelemetry['attitude'];

  const positionRaw = payload.position;
  const position = prune({
    x: typeof positionRaw?.x === 'number' ? positionRaw.x : undefined,
    y: typeof positionRaw?.y === 'number' ? positionRaw.y : undefined,
    z: typeof positionRaw?.z === 'number' ? positionRaw.z : undefined,
  }) as SimulatorTelemetry['position'];

  const locationRaw = payload.location;
  const location = prune({
    latitude: typeof locationRaw?.latitude === 'number' ? locationRaw.latitude : undefined,
    longitude: typeof locationRaw?.longitude === 'number' ? locationRaw.longitude : undefined,
    altitude: typeof locationRaw?.altitude === 'number' ? locationRaw.altitude : undefined,
  }) as SimulatorTelemetry['location'];

  const configRaw = payload.configuration;
  const configuration = prune({
    latitude: typeof configRaw?.latitude === 'number' ? configRaw.latitude : undefined,
    longitude: typeof configRaw?.longitude === 'number' ? configRaw.longitude : undefined,
    altitude: typeof configRaw?.altitude === 'number' ? configRaw.altitude : undefined,
    satellites: typeof configRaw?.satellites === 'number' ? configRaw.satellites : undefined,
    frequency_hz: typeof configRaw?.frequency_hz === 'number' ? configRaw.frequency_hz : undefined,
    source: typeof configRaw?.source === 'string' ? configRaw.source : undefined,
    timestamp: typeof configRaw?.timestamp === 'number' ? configRaw.timestamp : undefined,
  }) as SimulatorConfigurationSnapshot | undefined;

  const errorRaw = payload.last_error;
  const lastError = prune({
    code: typeof errorRaw?.code === 'string' ? errorRaw.code : undefined,
    code_value: typeof errorRaw?.code_value === 'number' ? errorRaw.code_value : undefined,
    description: typeof errorRaw?.description === 'string' ? errorRaw.description : undefined,
    domain: typeof errorRaw?.domain === 'string' ? errorRaw.domain : undefined,
  }) as SimulatorErrorSnapshot | undefined;

  const modeRaw = typeof payload.mode === 'string' ? payload.mode.toLowerCase() : undefined;
  const mode = modeRaw === 'simulator' || modeRaw === 'real' ? (modeRaw as 'simulator' | 'real') : undefined;

  const sanitized: SimulatorTelemetry = {
    mode,
    enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined,
    listener_registered: typeof payload.listener_registered === 'boolean' ? payload.listener_registered : undefined,
    motors_on: typeof payload.motors_on === 'boolean' ? payload.motors_on : undefined,
    flying: typeof payload.flying === 'boolean' ? payload.flying : undefined,
    attitude,
    position,
    location,
    configuration,
    last_error: lastError,
  };

  return Object.values(sanitized).some((value) => value !== undefined) ? sanitized : undefined;
};

const sanitizeNumber = (value: any): number | undefined =>
  typeof value === 'number' && !Number.isNaN(value) ? value : undefined;

const sanitizeBoolean = (value: any): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const sanitizeVirtualStickSettings = (input: any): PreflightControllerSettings['virtual_stick'] => {
  if (!input || typeof input !== 'object') return undefined;
  const enabled = sanitizeBoolean(input.enabled);
  const owner = typeof input.authority_owner === 'string' ? input.authority_owner : undefined;
  const manualOverride = sanitizeBoolean(input.manual_override);
  if (enabled === undefined && owner === undefined && manualOverride === undefined) {
    return undefined;
  }
  return {
    enabled,
    authority_owner: owner,
    manual_override: manualOverride,
  };
};

const sanitizeControllerDataMessage = (data: any): ControllerData => {
  const joystick = data?.joystick || {};
  const flightParams = data?.flight_params || {};
  const virtualStickRaw = data?.virtual_stick || {};
  const virtualStick = {
    enabled: Boolean(virtualStickRaw.enabled),
    advanced_enabled: sanitizeBoolean(virtualStickRaw.advanced_enabled),
    authority_owner: typeof virtualStickRaw.authority_owner === 'string' ? virtualStickRaw.authority_owner : undefined,
    manual_override: sanitizeBoolean(virtualStickRaw.manual_override),
    change_reason: typeof virtualStickRaw.change_reason === 'string' ? virtualStickRaw.change_reason : undefined,
  };
  return {
    type: 'controller_data',
    version: typeof data?.version === 'string' ? data.version : '1.0',
    timestamp: typeof data?.timestamp === 'number' ? data.timestamp : Date.now(),
    priority: typeof data?.priority === 'string' ? data.priority : 'normal',
    joystick: {
      left_horizontal: sanitizeNumber(joystick.left_horizontal) ?? 0,
      left_vertical: sanitizeNumber(joystick.left_vertical) ?? 0,
      right_horizontal: sanitizeNumber(joystick.right_horizontal) ?? 0,
      right_vertical: sanitizeNumber(joystick.right_vertical) ?? 0,
    },
    flight_params: {
      yaw: sanitizeNumber(flightParams.yaw) ?? 0,
      throttle: sanitizeNumber(flightParams.throttle) ?? 0,
      roll: sanitizeNumber(flightParams.roll) ?? 0,
      pitch: sanitizeNumber(flightParams.pitch) ?? 0,
    },
    virtual_stick_enabled: Boolean(data?.virtual_stick_enabled),
    authority_owner: typeof data?.authority_owner === 'string' ? data.authority_owner : undefined,
    virtual_stick: virtualStick,
    battery_percent: sanitizeNumber(data?.battery_percent),
  };
};

const sanitizeObstacleSettings = (input: any): PreflightFlightSettings['obstacle_avoidance'] | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const collision = sanitizeBoolean(input.collision_avoidance);
  const vision = sanitizeBoolean(input.vision_positioning);
  const landing = typeof input.landing_protection === 'string' ? input.landing_protection : undefined;
  if (collision === undefined && vision === undefined && landing === undefined) return undefined;
  return {
    collision_avoidance: collision,
    vision_positioning: vision,
    landing_protection: landing,
  };
};

const sanitizeFlightSettings = (input: any): PreflightFlightSettings | null => {
  if (!input || typeof input !== 'object') return null;
  const settings: PreflightFlightSettings = {};
  const rth = sanitizeNumber(input.return_home_altitude);
  const maxAlt = sanitizeNumber(input.max_altitude);
  const maxDist = sanitizeNumber(input.max_distance);
  const maxDistEnabled = sanitizeBoolean(input.max_distance_enabled);
  const signalLost = typeof input.signal_lost_action === 'string' ? input.signal_lost_action : undefined;
  const avoidance = sanitizeObstacleSettings(input.obstacle_avoidance);
  if (rth !== undefined) settings.return_home_altitude = rth;
  if (maxAlt !== undefined) settings.max_altitude = maxAlt;
  if (maxDist !== undefined) settings.max_distance = maxDist;
  if (maxDistEnabled !== undefined) settings.max_distance_enabled = maxDistEnabled;
  if (signalLost) settings.signal_lost_action = signalLost;
  if (avoidance) settings.obstacle_avoidance = avoidance;
  return Object.keys(settings).length ? settings : null;
};

const sanitizePowerStatus = (input: any): PreflightPowerStatus | null => {
  if (!input || typeof input !== 'object') return null;
  const aircraft = sanitizeNumber(input.aircraft_percent);
  const controller = sanitizeNumber(input.controller_percent);
  const low = sanitizeNumber(input.low_warning_threshold);
  const critical = sanitizeNumber(input.critical_warning_threshold);
  if (aircraft === undefined && controller === undefined && low === undefined && critical === undefined) return null;
  const status: PreflightPowerStatus = {};
  if (aircraft !== undefined) status.aircraft_percent = aircraft;
  if (controller !== undefined) status.controller_percent = controller;
  if (low !== undefined) status.low_warning_threshold = low;
  if (critical !== undefined) status.critical_warning_threshold = critical;
  return status;
};

const sanitizeControllerSettings = (input: any): PreflightControllerSettings | null => {
  if (!input || typeof input !== 'object') return null;
  const stickMode = typeof input.stick_mode === 'string' ? input.stick_mode : undefined;
  const rcMode = typeof input.rc_mode === 'string' ? input.rc_mode : undefined;
  const virtualStick = sanitizeVirtualStickSettings(input.virtual_stick);
  if (!stickMode && !rcMode && !virtualStick) return null;
  const settings: PreflightControllerSettings = {};
  if (stickMode) settings.stick_mode = stickMode;
  if (rcMode) settings.rc_mode = rcMode;
  if (virtualStick) settings.virtual_stick = virtualStick;
  return settings;
};

const sanitizeRemoteId = (input: any): RemoteIDSnapshot | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const snapshot: RemoteIDSnapshot = {};
  if (typeof input.area_strategy === 'string') snapshot.areaStrategy = input.area_strategy;
  if (typeof input.operator_registration_number === 'string') {
    snapshot.operatorRegistrationNumber = input.operator_registration_number;
  }
  if (typeof input.operator_registration === 'string') {
    snapshot.operatorRegistrationNumber = input.operator_registration;
  }
  if (input.status && typeof input.status === 'object') snapshot.status = input.status;
  if (input.operator_status && typeof input.operator_status === 'object') snapshot.operatorStatus = input.operator_status;
  if (typeof input.last_error === 'string') snapshot.lastError = input.last_error;
  return Object.keys(snapshot).length ? snapshot : undefined;
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
          controller: sanitizeControllerDataMessage(message),
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
                  label: typeof entry.label === 'string' ? entry.label : undefined,
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
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                  execute_state: typeof entry.execute_state === 'string' ? entry.execute_state : undefined,
                  pause_reason: typeof entry.pause_reason === 'string' ? entry.pause_reason : undefined,
                  resume_reason: typeof entry.resume_reason === 'string' ? entry.resume_reason : undefined,
                  exit_reason: typeof entry.exit_reason === 'string' ? entry.exit_reason : undefined,
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
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                };
              }
              if (type === 'event') {
                return {
                  type: 'event' as const,
                  timestamp,
                  event: typeof entry.event === 'string' ? entry.event : undefined,
                  reason: typeof entry.reason === 'string' ? entry.reason : undefined,
                  mission_id: typeof entry.mission_id === 'string' ? entry.mission_id : undefined,
                  wayline_id: typeof entry.wayline_id === 'number' ? entry.wayline_id : undefined,
                  current_waypoint_index: typeof entry.current_waypoint_index === 'number'
                    ? entry.current_waypoint_index
                    : undefined,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                };
              }
              if (type === 'breakpoint') {
                const locationRaw = entry.location;
                const location = locationRaw && typeof locationRaw === 'object'
                  ? {
                      latitude: typeof locationRaw.latitude === 'number' ? locationRaw.latitude : undefined,
                      longitude: typeof locationRaw.longitude === 'number' ? locationRaw.longitude : undefined,
                      altitude: typeof locationRaw.altitude === 'number' ? locationRaw.altitude : undefined,
                    }
                  : undefined;
                return {
                  type: 'breakpoint' as const,
                  timestamp,
                  mission_id: typeof entry.mission_id === 'string' ? entry.mission_id : undefined,
                  wayline_id: typeof entry.wayline_id === 'number' ? entry.wayline_id : undefined,
                  waypoint_id: typeof entry.waypoint_id === 'number' ? entry.waypoint_id : undefined,
                  segment_progress: typeof entry.segment_progress === 'number' ? entry.segment_progress : undefined,
                  recover_action: typeof entry.recover_action === 'string' ? entry.recover_action : undefined,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                  source: typeof entry.source === 'string' ? entry.source : undefined,
                  location,
                };
              }
              if (type === 'breakpoint_error') {
                const errorRaw = entry.error;
                const error = errorRaw && typeof errorRaw === 'object'
                  ? {
                      code: typeof errorRaw.code === 'string' ? errorRaw.code : undefined,
                      description: typeof errorRaw.description === 'string' ? errorRaw.description : undefined,
                    }
                  : undefined;
                return {
                  type: 'breakpoint_error' as const,
                  timestamp,
                  mission_id: typeof entry.mission_id === 'string' ? entry.mission_id : undefined,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                  source: typeof entry.source === 'string' ? entry.source : undefined,
                  error,
                };
              }
              return null;
            })
            .filter((entry): entry is WaypointTimelineEntry => Boolean(entry));
          const missionId = typeof status.mission_id === 'string'
            ? status.mission_id
            : (executing?.mission_id ?? undefined);
          const waypointsRaw = Array.isArray(status.waypoints) ? status.waypoints : undefined;
          const waypoints = waypointsRaw
            ?.map((entry: any) => {
              if (!entry || typeof entry !== 'object') return null;
              const latitude = typeof entry.latitude === 'number' ? entry.latitude : typeof entry.lat === 'number' ? entry.lat : undefined;
              const longitude = typeof entry.longitude === 'number' ? entry.longitude : typeof entry.lng === 'number' ? entry.lng : undefined;
              const executeHeight = typeof entry.execute_height === 'number'
                ? entry.execute_height
                : typeof entry.height === 'number'
                  ? entry.height
                  : undefined;
              if (typeof latitude !== 'number' || typeof longitude !== 'number') {
                return null;
              }
              return {
                index: typeof entry.index === 'number' ? entry.index : undefined,
                latitude,
                longitude,
                execute_height: executeHeight,
                kind: typeof entry.kind === 'string' ? entry.kind : undefined,
              };
            })
            .filter((entry): entry is { index?: number; latitude: number; longitude: number; execute_height?: number; kind?: string } => Boolean(entry));

          const securityTakeoffHeight = typeof status.security_takeoff_height === 'number'
            ? status.security_takeoff_height
            : undefined;

          return {
            timestamp: typeof status.timestamp === 'number' ? status.timestamp : undefined,
            state: typeof status.state === 'string' ? status.state : undefined,
            mission_id: missionId,
            mission_path: typeof status.mission_path === 'string' ? status.mission_path : undefined,
            backend: typeof status.backend === 'string' ? status.backend : undefined,
            executing,
            last_interrupt: interrupt,
            timeline: timelineEntries && timelineEntries.length ? timelineEntries : undefined,
            waypoints: waypoints && waypoints.length ? waypoints : undefined,
            security_takeoff_height: securityTakeoffHeight,
          };
        };

        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: message.heading || 0, // Default if not provided
          waypoint_status: sanitizeWaypointStatus(),
          simulator: sanitizeSimulator(message.simulator),
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
        const batteryPayload = (message && typeof message.battery === 'object' ? message.battery : {}) || {};
        const percentage = sanitizeNumber(batteryPayload.percentage)
          ?? sanitizeNumber(batteryPayload.charge_remaining_percent)
          ?? sanitizeNumber(message.charge_remaining_percent)
          ?? sanitizeNumber(message.percentage);
        const voltage = sanitizeNumber(batteryPayload.voltage) ?? sanitizeNumber(message.voltage);
        const current = sanitizeNumber(batteryPayload.current) ?? sanitizeNumber(message.current);
        const temperature = sanitizeNumber(batteryPayload.temperature) ?? sanitizeNumber(message.temperature);
        const cellVoltages = Array.isArray(batteryPayload.cell_voltages)
          ? batteryPayload.cell_voltages
          : Array.isArray(message.cell_voltages)
            ? message.cell_voltages
            : [];

        const mappedBattery = {
          type: 'sensor_data',
          version: message.version || '1.0',
          timestamp: message.timestamp || timestamp,
          priority: message.priority || 'low',
          battery: {
            percentage: typeof percentage === 'number' ? percentage : 0,
            voltage: typeof voltage === 'number' ? voltage : 0,
            current: typeof current === 'number' ? current : 0,
            temperature: typeof temperature === 'number' ? temperature : 0,
            cell_voltages: cellVoltages,
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
          fly_safe: typeof message.fly_safe === 'object' ? message.fly_safe : undefined,
          flight_settings: sanitizeFlightSettings(message.flight_settings) || undefined,
          power: sanitizePowerStatus(message.power) || undefined,
          controller_settings: sanitizeControllerSettings(message.controller_settings) || undefined,
          remote_id: sanitizeRemoteId(message.remote_id) || undefined,
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
          const simulatorAck = sanitizeSimulator(message.simulator);
          if (simulatorAck) {
            ack.simulator = simulatorAck;
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
