// Global bridge state manager - survives React re-mounts
import { BridgeDataState, ConnectionStatus, ControllerData, TelemetryData, BatteryData, FlightCommandAck, PreflightStatus, TelemetryDiagnosticEntry, DeviceStatusInfo, WaypointTimelineEntry, SimulatorTelemetry, SimulatorConfigurationSnapshot, SimulatorErrorSnapshot } from './types';

class BridgeManager {
  private listeners: Set<() => void> = new Set();
  private bridgeData: BridgeDataState = {
    controller: null,
    telemetry: null,
    battery: null,
    camera: null,
    flightCommandLog: [],
    preflight: null,
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
        
        const sanitizeGimbals = (): TelemetryData['gimbals'] => {
          if (!Array.isArray(message.gimbals)) return undefined;
          return message.gimbals.map((entry: any) => {
            const attitude = entry?.attitude;
            const limits = entry?.limits;
            return {
              index: String(entry?.index ?? ''),
              connected: Boolean(entry?.connected),
              attitude: attitude ? {
                pitch: Number(attitude.pitch ?? 0),
                roll: Number(attitude.roll ?? 0),
                yaw: Number(attitude.yaw ?? 0),
              } : undefined,
              yaw_relative: typeof entry?.yaw_relative === 'number' ? entry.yaw_relative : undefined,
              limits: limits ? {
                pitch: limits.pitch ? {
                  min: typeof limits.pitch.min === 'number' ? limits.pitch.min : undefined,
                  max: typeof limits.pitch.max === 'number' ? limits.pitch.max : undefined,
                } : undefined,
                yaw: limits.yaw ? {
                  min: typeof limits.yaw.min === 'number' ? limits.yaw.min : undefined,
                  max: typeof limits.yaw.max === 'number' ? limits.yaw.max : undefined,
                } : undefined,
                roll: limits.roll ? {
                  min: typeof limits.roll.min === 'number' ? limits.roll.min : undefined,
                  max: typeof limits.roll.max === 'number' ? limits.roll.max : undefined,
                } : undefined,
              } : undefined,
            };
          });
        };

        const sanitizeCameraOptics = (): TelemetryData['camera_optics'] => {
          const optics = message.camera_optics;
          if (!optics || typeof optics !== 'object') return undefined;
          return {
            index: String(optics.index ?? ''),
            lens: typeof optics.lens === 'string' ? optics.lens : undefined,
            lens_type: typeof optics.lens_type === 'string' ? optics.lens_type : undefined,
            zoom_ratio: typeof optics.zoom_ratio === 'number' ? optics.zoom_ratio : undefined,
            zoom_range: optics.zoom_range && typeof optics.zoom_range === 'object'
              ? {
                  min: typeof optics.zoom_range.min === 'number' ? optics.zoom_range.min : undefined,
                  max: typeof optics.zoom_range.max === 'number' ? optics.zoom_range.max : undefined,
                }
              : undefined,
            focal_length: typeof optics.focal_length === 'number' ? optics.focal_length : undefined,
            display_fov: optics.display_fov && typeof optics.display_fov === 'object'
              ? {
                  horizontal: typeof optics.display_fov.horizontal === 'number' ? optics.display_fov.horizontal : undefined,
                  vertical: typeof optics.display_fov.vertical === 'number' ? optics.display_fov.vertical : undefined,
                }
              : undefined,
            laser_measurement: typeof optics.laser_measurement === 'string' ? optics.laser_measurement : undefined,
          };
        };

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
              const entryTimestamp = typeof entry.timestamp === 'number' ? entry.timestamp : undefined;
              if (type === 'state') {
                return {
                  type: 'state',
                  timestamp: entryTimestamp,
                  state: typeof entry.state === 'string' ? entry.state : undefined,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                };
              }
              if (type === 'executing') {
                return {
                  type: 'executing',
                  timestamp: entryTimestamp,
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
                  type: 'interrupt',
                  timestamp: entryTimestamp,
                  error,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
                };
              }
              if (type === 'event') {
                return {
                  type: 'event',
                  timestamp: entryTimestamp,
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
                  type: 'breakpoint',
                  timestamp: entryTimestamp,
                  mission_id: typeof entry.mission_id === 'string' ? entry.mission_id : undefined,
                  wayline_id: typeof entry.wayline_id === 'number' ? entry.wayline_id : undefined,
                  waypoint_id: typeof entry.waypoint_id === 'number' ? entry.waypoint_id : undefined,
                  segment_progress: typeof entry.segment_progress === 'number' ? entry.segment_progress : undefined,
                  recover_action: typeof entry.recover_action === 'string' ? entry.recover_action : undefined,
                  source: typeof entry.source === 'string' ? entry.source : undefined,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
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
                  type: 'breakpoint_error',
                  timestamp: entryTimestamp,
                  mission_id: typeof entry.mission_id === 'string' ? entry.mission_id : undefined,
                  source: typeof entry.source === 'string' ? entry.source : undefined,
                  label: typeof entry.label === 'string' ? entry.label : undefined,
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

        const simulatorTelemetry = this.sanitizeSimulatorPayload(message.simulator);

        const mappedTelemetry = {
          ...message,
          speed: message.ground_speed || message.speed || 0,
          heading: trueCompassHeading,
          attitude: message.attitude || { pitch: 0, roll: 0, yaw: 0 },
          compass_heading: trueCompassHeading,
          home_bearing: bearingToHome,
          gimbals: sanitizeGimbals(),
          camera_optics: sanitizeCameraOptics(),
          waypoint_status: sanitizeWaypointStatus(),
          simulator: simulatorTelemetry,
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

      case 'preflight_status':
        const diagnostics = Array.isArray(message.diagnostics)
          ? (message.diagnostics as any[])
              .map((entry) => this.sanitizeDiagnostic(entry))
              .filter(Boolean) as TelemetryDiagnosticEntry[]
          : [];
        const deviceStatus = this.sanitizeDeviceStatus(message.device_status);
        const preflightSnapshot = {
          type: 'preflight_status',
          version: message.version || '1.0',
          timestamp: message.timestamp || timestamp,
          priority: message.priority || 'normal',
          diagnostics,
          device_status: deviceStatus ?? undefined,
        } as PreflightStatus;

        this.bridgeData = {
          ...this.bridgeData,
          preflight: preflightSnapshot,
          lastUpdated: { ...this.bridgeData.lastUpdated, preflight: timestamp }
        };
        break;

      case 'flight_command':
        const ack = {
          ...message,
          status: message.status || message.result || 'unknown',
          action: message.action || 'unknown'
        } as FlightCommandAck;

        if (Array.isArray(message.diagnostics)) {
          ack.diagnostics = (message.diagnostics as any[])
            .map((entry) => this.sanitizeDiagnostic(entry))
            .filter(Boolean) as TelemetryDiagnosticEntry[];
        }
        if (message.device_status) {
          ack.device_status = this.sanitizeDeviceStatus(message.device_status);
        }
        if (message.landing_monitor && typeof message.landing_monitor === 'object') {
          ack.landing_monitor = { ...message.landing_monitor } as any;
        }

        const simulatorAck = this.sanitizeSimulatorPayload(message.simulator);
        if (simulatorAck) {
          ack.simulator = simulatorAck;
        }

        const history = [...this.bridgeData.flightCommandLog, ack];
        const MAX_HISTORY = 20;
        const trimmed = history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;

        this.bridgeData = {
          ...this.bridgeData,
          flightCommandLog: trimmed,
          lastUpdated: { ...this.bridgeData.lastUpdated, flightCommand: timestamp }
        };
        break;
    }

    this.notifyListeners();
  }

  private notifyListeners() {
    this.listeners.forEach(listener => listener());
  }

  private sanitizeSimulatorPayload(payload: any): SimulatorTelemetry | undefined {
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
  }

  private sanitizeDiagnostic(entry: any): TelemetryDiagnosticEntry | null {
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
  }

  private sanitizeDeviceStatus(status: any): DeviceStatusInfo | null {
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

  async sendFlightCommand(action: string, params?: Record<string, any>) {
    const payload: any = {
      type: 'flight_command',
      data: {
        action
      }
    };

    if (params && Object.keys(params).length > 0) {
      payload.data.params = params;
    }

    return this.sendBridgeCommand(payload);
  }
}

// Global singleton
export const bridgeManager = new BridgeManager();
