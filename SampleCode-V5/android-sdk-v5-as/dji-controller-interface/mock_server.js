const WebSocket = require('ws');

// Create WebSocket server on port 8080
const wss = new WebSocket.Server({ port: 8080 });

console.log('Mock DJI Bridge Server running on ws://localhost:8080');

// Mock data generators
const createControllerData = () => ({
  type: 'controller_data',
  version: '1.0',
  timestamp: Date.now(),
  priority: 'high',
  joystick: {
    left_horizontal: Math.sin(Date.now() / 2000) * 50,  // Yaw
    left_vertical: Math.cos(Date.now() / 3000) * 30,    // Throttle  
    right_horizontal: Math.sin(Date.now() / 1500) * 40, // Roll
    right_vertical: Math.cos(Date.now() / 2500) * 35    // Pitch
  },
  flight_params: {
    yaw: Math.sin(Date.now() / 2000) * 0.5,
    throttle: Math.cos(Date.now() / 3000) * 0.3,
    roll: Math.sin(Date.now() / 1500) * 0.4,
    pitch: Math.cos(Date.now() / 2500) * 0.35
  },
  virtual_stick_enabled: false
});

const createTelemetryData = () => ({
  type: 'telemetry_data',
  version: '1.0',
  timestamp: Date.now(),
  priority: 'normal',
  altitude: 125.5 + Math.sin(Date.now() / 5000) * 5,
  altitude_above_home: 3.2 + Math.sin(Date.now() / 7000) * 2,
  speed: Math.abs(Math.sin(Date.now() / 4000) * 8.5),
  location: {
    latitude: 37.2268335 + Math.sin(Date.now() / 10000) * 0.0001,
    longitude: -121.968717 + Math.cos(Date.now() / 12000) * 0.0001,
    altitude: 125.5
  },
  home_location: {
    latitude: 37.2268335,
    longitude: -121.968717,
    altitude: 122.3
  },
  attitude: {
    roll: Math.sin(Date.now() / 3000) * 5,
    pitch: Math.cos(Date.now() / 4000) * 3,
    yaw: (Date.now() / 100) % 360
  },
  flight_mode: 'P-GPS',
  distance_to_home: 3.5 + Math.abs(Math.sin(Date.now() / 8000) * 2),
  heading: (Date.now() / 100) % 360,
  home_bearing: 180,
  satellite_count: 12,
  gps_signal_quality: 4
});

const createBatteryData = () => ({
  type: 'sensor_data',
  version: '1.0', 
  timestamp: Date.now(),
  priority: 'low',
  battery: {
    percentage: 78 + Math.sin(Date.now() / 20000) * 5,
    voltage: 22.2 + Math.sin(Date.now() / 15000) * 0.5,
    current: 1200 + Math.sin(Date.now() / 8000) * 200,
    temperature: 35 + Math.sin(Date.now() / 25000) * 3,
    cell_voltages: [3.7, 3.71, 3.69, 3.72, 3.68, 3.70],
    cycles: 145,
    remaining_mah: 4200,
    full_charge_capacity: 5350
  },
  system_health: 'good'
});

const createCameraData = () => ({
  type: 'camera_data',
  version: '1.0',
  timestamp: Date.now(),
  priority: 'low',
  mode: 'Video',
  iso: 'AUTO',
  shutter_speed: '1/60',
  recording_status: Math.random() > 0.7,
  storage_status: 'normal',
  available_storage: 64.5,
  gimbal_attitude: {
    pitch: Math.sin(Date.now() / 6000) * 30,
    roll: Math.cos(Date.now() / 8000) * 5,
    yaw: Math.sin(Date.now() / 7000) * 45
  }
});

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send data at different frequencies
  const controllerInterval = setInterval(() => {
    ws.send(JSON.stringify(createControllerData()));
  }, 50); // 20Hz

  const telemetryInterval = setInterval(() => {
    ws.send(JSON.stringify(createTelemetryData()));
  }, 200); // 5Hz

  const batteryInterval = setInterval(() => {
    ws.send(JSON.stringify(createBatteryData()));
  }, 1000); // 1Hz

  const cameraInterval = setInterval(() => {
    ws.send(JSON.stringify(createCameraData()));
  }, 2000); // 0.5Hz

  ws.on('message', (message) => {
    try {
      const command = JSON.parse(message);
      console.log('Received command:', command.command);
      
      // Echo back command response
      ws.send(JSON.stringify({
        type: 'command_response',
        version: '1.0',
        timestamp: Date.now(),
        command: command.command,
        status: 'success',
        message: `Command ${command.command} executed`
      }));
    } catch (error) {
      console.error('Invalid command:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clearInterval(controllerInterval);
    clearInterval(telemetryInterval);
    clearInterval(batteryInterval);
    clearInterval(cameraInterval);
  });
});

process.on('SIGINT', () => {
  console.log('Shutting down mock server...');
  wss.close();
  process.exit(0);
});