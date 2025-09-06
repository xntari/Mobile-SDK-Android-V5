#!/usr/bin/env node

/**
 * DJI Android Bridge Test Client - Debug Filtered Data
 * 
 * Focuses on specific data types to avoid video frame flood
 * Usage: node test_bridge.js [device_ip] [filter]
 * 
 * Filters:
 * - obstacle: Show only obstacle avoidance data
 * - telemetry: Show only telemetry data (no video frames)
 * - compass: Show only compass/heading data
 * - all: Show all data (WARNING: includes video frames!)
 */

const WebSocket = require('ws');
const readline = require('readline');

// Configuration
const DEFAULT_IP = '127.0.0.1';  // Use localhost with port forwarding
const WEBSOCKET_PORT = 8080;
const RECONNECT_INTERVAL = 5000;

// Data filters
const FILTERS = {
    obstacle: ['obstacle_avoidance'],
    telemetry: ['telemetry_data', 'sensor_data', 'battery_status', 'gps_data'],
    compass: ['compass_heading', 'heading', 'attitude'],
    all: null // Show everything (dangerous with video frames)
};

class DJIBridgeClient {
    constructor(deviceIp, filter = 'obstacle') {
        this.deviceIp = deviceIp || DEFAULT_IP;
        this.filter = filter;
        this.allowedTypes = FILTERS[filter];
        this.wsUrl = `ws://${this.deviceIp}:${WEBSOCKET_PORT}`;
        this.ws = null;
        this.reconnectTimer = null;
        this.isRunning = false;
        
        console.log(`🎯 Filter mode: ${filter}`);
        if (this.allowedTypes) {
            console.log(`📋 Showing only: ${this.allowedTypes.join(', ')}`);
        } else {
            console.log(`⚠️  WARNING: Showing ALL data including video frames!`);
        }
        
        this.setupReadline();
    }
    
    setupReadline() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        this.rl.on('line', (input) => {
            this.handleUserInput(input.trim().toLowerCase());
        });
    }
    
    connect() {
        if (this.ws) {
            this.ws.close();
        }
        
        console.log(`🔗 Connecting to DJI Bridge at ${this.wsUrl}...`);
        
        this.ws = new WebSocket(this.wsUrl);
        this.isRunning = true;
        
        this.ws.on('open', () => {
            console.log('✅ Connected to DJI Android Bridge!');
            console.log('🎮 Move joysticks on your DJI controller to see data stream');
            console.log('📝 Commands: status | clear | quit');
            console.log('----------------------------------------');
            
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        });
        
        this.ws.on('message', (data) => {
            this.handleMessage(data);
        });
        
        this.ws.on('error', (error) => {
            console.error('❌ WebSocket error:', error.message);
        });
        
        this.ws.on('close', () => {
            console.log('🔌 Connection to DJI Bridge closed');
            
            if (this.isRunning) {
                console.log(`🔄 Attempting to reconnect in ${RECONNECT_INTERVAL/1000} seconds...`);
                this.reconnectTimer = setTimeout(() => {
                    this.connect();
                }, RECONNECT_INTERVAL);
            }
        });
    }
    
    handleMessage(data) {
        try {
            // Skip binary data (video frames) by checking if it looks like JSON
            if (data[0] !== 123) { // 123 is '{'
                if (this.allowedTypes === null) {
                    console.log('📹 [FILTERED] Binary video frame data');
                }
                return;
            }
            
            const message = JSON.parse(data.toString());
            
            // Apply filter
            if (this.allowedTypes && !this.shouldShow(message)) {
                return; // Filtered out
            }
            
            if (message.type === 'controller_data') {
                console.log('🎮 Controller Data:', this.formatControllerData(message));
            } else if (message.type === 'telemetry_data') {
                this.displayTelemetryData(message);
            } else if (message.type === 'battery_status') {
                console.log('🔋 Battery:', this.formatBatteryData(message));
            } else if (message.type === 'test') {
                console.log('✅ Test message from bridge:', message.message);
                console.log(`   Timestamp: ${new Date(message.timestamp).toISOString()}`);
            } else {
                console.log(`📨 ${message.type}:`, JSON.stringify(message, null, 2));
            }
            
        } catch (error) {
            if (this.allowedTypes === null) {
                console.error('❌ Failed to parse message:', error.message);
            }
        }
    }
    
    shouldShow(message) {
        if (!this.allowedTypes) return true; // Show all
        
        // Check if message type matches filter
        if (this.allowedTypes.includes(message.type)) return true;
        
        // Special check for obstacle avoidance data within telemetry
        if (message.type === 'telemetry_data' && this.filter === 'obstacle') {
            return message.obstacle_avoidance !== undefined;
        }
        
        // Check data properties
        if (message.data) {
            for (const key of Object.keys(message.data)) {
                if (this.allowedTypes.includes(key)) return true;
            }
        }
        
        return false;
    }
    
    formatControllerData(data) {
        const j = data.joystick;
        return `Left:(${j.left_x.toFixed(2)}, ${j.left_y.toFixed(2)}) Right:(${j.right_x.toFixed(2)}, ${j.right_y.toFixed(2)})`;
    }
    
    formatBatteryData(data) {
        return `${data.percentage}% (${data.voltage}V, ${data.temperature}°C)`;
    }
    
    displayControllerData(data) {
        const joystick = data.joystick;
        const flight = data.flight_params;
        const timestamp = new Date(data.timestamp).toISOString().split('T')[1].split('.')[0];
        const version = data.version || 'unknown';
        const priority = data.priority || 'normal';
        
        // Check if there's actual joystick movement
        const hasMovement = Math.abs(joystick.left_horizontal) > 0 || 
                           Math.abs(joystick.left_vertical) > 0 ||
                           Math.abs(joystick.right_horizontal) > 0 || 
                           Math.abs(joystick.right_vertical) > 0;
        
        // Enhanced display with protocol info
        if (hasMovement) {
            console.log(`[${timestamp}] 🎮 Controller Data (v${version}, ${priority}):`);
        } else {
            console.log(`[${timestamp}] 🎮 Controller Data (zeros, v${version}):`);
        }
        
        console.log(`   Left:  H=${joystick.left_horizontal.toString().padStart(4)} V=${joystick.left_vertical.toString().padStart(4)} (Yaw=${flight.yaw.toFixed(2)}, Throttle=${flight.throttle.toFixed(2)})`);
        console.log(`   Right: H=${joystick.right_horizontal.toString().padStart(4)} V=${joystick.right_vertical.toString().padStart(4)} (Roll=${flight.roll.toFixed(2)}, Pitch=${flight.pitch.toFixed(2)})`);
        
        // Interpret flight commands
        const commands = this.interpretFlightCommands(flight);
        if (commands.length > 0) {
            console.log(`   ✈️  Flight: ${commands.join(' + ')}`);
        }
        
        console.log('');
    }
    
    interpretFlightCommands(flight) {
        const commands = [];
        const threshold = 0.3;
        
        if (flight.throttle > threshold) commands.push('ASCENDING');
        else if (flight.throttle < -threshold) commands.push('DESCENDING');
        
        if (flight.pitch > threshold) commands.push('FORWARD');
        else if (flight.pitch < -threshold) commands.push('BACKWARD');
        
        if (flight.roll > threshold) commands.push('RIGHT');
        else if (flight.roll < -threshold) commands.push('LEFT');
        
        if (flight.yaw > threshold) commands.push('ROTATE_RIGHT');
        else if (flight.yaw < -threshold) commands.push('ROTATE_LEFT');
        
        return commands.length > 0 ? commands : ['HOVERING'];
    }
    
    displayTelemetryData(data) {
        const timestamp = new Date(data.timestamp).toISOString().split('T')[1].split('.')[0];
        const version = data.version || 'unknown';
        const priority = data.priority || 'normal';
        
        console.log(`[${timestamp}] 📡 Telemetry Data (v${version}, ${priority}):`);
        
        if (data.error) {
            console.log(`   ❌ Error: ${data.error}`);
        } else {
            // Basic telemetry info
            console.log(`   🛸 Altitude: ${data.altitude?.toFixed(2) || 'N/A'}m`);
            console.log(`   🏃 Ground Speed: ${data.ground_speed?.toFixed(2) || 'N/A'}m/s`);
            console.log(`   📈 Vertical Speed: ${data.vertical_speed?.toFixed(2) || 'N/A'}m/s`);
            console.log(`   🧭 Flight Mode: ${data.flight_mode || 'UNKNOWN'}`);
            console.log(`   🏠 Distance to Home: ${data.distance_to_home?.toFixed(2) || 'N/A'}m`);
            
            // GPS info
            console.log(`   🛰️  GPS Satellites: ${data.gps_satellite_count || 0} (${data.gps_signal_quality || 'NONE'})`);
            
            // Location info
            if (data.location && data.location.latitude !== 0) {
                console.log(`   📍 Aircraft: ${data.location.latitude.toFixed(6)}, ${data.location.longitude.toFixed(6)}`);
            }
            if (data.home_location && data.home_location.latitude !== 0) {
                console.log(`   🏠 Home: ${data.home_location.latitude.toFixed(6)}, ${data.home_location.longitude.toFixed(6)}`);
            }
            
            // Status indicators
            const statusIndicators = [];
            if (data.are_motors_on) statusIndicators.push('🚁 MOTORS_ON');
            if (data.is_flying) statusIndicators.push('✈️ FLYING');
            if (statusIndicators.length > 0) {
                console.log(`   Status: ${statusIndicators.join(' | ')}`);
            }
            
            // 🎯 Obstacle Avoidance Data (PerceptionManager integration)
            if (data.obstacle_avoidance) {
                this.displayObstacleData(data.obstacle_avoidance);
            }
            
            // 🧭 Compass Data
            if (data.heading !== undefined || data.compass_heading !== undefined) {
                console.log(`   🧭 Heading: ${data.heading?.toFixed(1) || 'N/A'}° (Compass: ${data.compass_heading?.toFixed(1) || 'N/A'}°)`);
            }
            if (data.attitude) {
                console.log(`   ⚡ Attitude: Roll=${data.attitude.roll?.toFixed(1)}° Pitch=${data.attitude.pitch?.toFixed(1)}° Yaw=${data.attitude.yaw?.toFixed(1)}°`);
            }
        }
        console.log('');
    }
    
    displayObstacleData(obstacle) {
        if (!obstacle.enabled) {
            console.log(`   🚫 Obstacle Avoidance: DISABLED`);
            return;
        }
        
        console.log(`   🛡️  OBSTACLE AVOIDANCE (${obstacle.data_source || 'Unknown'}):`);
        console.log(`      📊 Status: ${obstacle.system_status?.toUpperCase() || 'UNKNOWN'}`);
        console.log(`      🎯 Radar Available: ${obstacle.radar_available ? '✅' : '❌'}`);
        console.log(`      👁️  Perception Available: ${obstacle.perception_available ? '✅' : '❌'}`);
        
        if (obstacle.closest_distance) {
            const distance = obstacle.closest_distance;
            let distanceIcon = '🟢'; // Green for safe
            if (distance < 5) distanceIcon = '🟡'; // Yellow for caution
            if (distance < 3) distanceIcon = '🟠'; // Orange for warning
            if (distance < 1) distanceIcon = '🔴'; // Red for critical
            
            console.log(`      📏 Closest Obstacle: ${distanceIcon} ${distance.toFixed(1)}m`);
        }
        
        if (obstacle.sectors && obstacle.sectors.length > 0) {
            console.log(`      🎯 Active Warning Sectors: ${obstacle.sectors.length}`);
            obstacle.sectors.forEach((sector, i) => {
                const angle = sector.angle?.toFixed(0) || '?';
                const dist = sector.distance?.toFixed(1) || '?';
                const level = sector.warning_level || '?';
                const source = sector.source || '?';
                const levelIcon = {critical: '🔴', warning: '🟠', caution: '🟡'}[level] || '⚪';
                console.log(`         ${levelIcon} Sector ${i+1}: ${angle}° at ${dist}m (${level}, ${source})`);
            });
        } else {
            console.log(`      ✅ No obstacles detected`);
        }
    }
    
    displayBatteryData(data) {
        const timestamp = new Date(data.timestamp).toISOString().split('T')[1].split('.')[0];
        const version = data.version || 'unknown';
        const priority = data.priority || 'normal';
        
        console.log(`[${timestamp}] 🔋 Battery Status (v${version}, ${priority}):`);
        
        if (data.error) {
            console.log(`   ❌ Error: ${data.error}`);
        } else {
            // Battery charge info
            const percentage = data.percentage || 0;
            const voltageInfo = data.voltage ? `${data.voltage.toFixed(2)}V` : 'N/A';
            const tempInfo = data.temperature ? `${data.temperature.toFixed(1)}°C` : 'N/A';
            
            // Color code battery percentage
            let batteryIcon = '🔋';
            if (percentage < 20) batteryIcon = '🪫';
            else if (percentage < 50) batteryIcon = '🔋';
            else batteryIcon = '🔋';
            
            console.log(`   ${batteryIcon} Charge: ${percentage}% (${data.remaining_mah || 0}mAh)`);
            console.log(`   ⚡ Voltage: ${voltageInfo} | Current: ${data.current?.toFixed(2) || 'N/A'}A`);
            console.log(`   🌡️  Temperature: ${tempInfo}`);
            console.log(`   📊 Capacity: ${data.full_charge_capacity || 0}mAh`);
            
            // Battery status indicators
            const statusIndicators = [];
            if (data.is_being_charged) statusIndicators.push('🔌 CHARGING');
            if (data.warning_level && data.warning_level !== 'NONE') {
                statusIndicators.push(`⚠️ ${data.warning_level}`);
            }
            if (data.connection_state && data.connection_state !== 'UNKNOWN') {
                statusIndicators.push(`🔗 ${data.connection_state}`);
            }
            
            if (statusIndicators.length > 0) {
                console.log(`   Status: ${statusIndicators.join(' | ')}`);
            }
            
            // Cell voltage details (if available)
            if (data.cell_voltages && data.cell_voltages.length > 0) {
                const cellVoltages = data.cell_voltages.map(v => `${v.toFixed(2)}V`).join(', ');
                console.log(`   🔋 Cells: [${cellVoltages}]`);
            }
        }
        console.log('');
    }
    
    handleUserInput(input) {
        switch (input) {
            case 'status':
                this.showStatus();
                break;
            case 'clear':
                console.clear();
                console.log('🎮 DJI Bridge Test Client - Cleared');
                console.log('📝 Commands: status | clear | quit');
                console.log('----------------------------------------');
                break;
            case 'quit':
            case 'exit':
            case 'q':
                this.disconnect();
                break;
            case 'help':
            case 'h':
                this.showHelp();
                break;
            default:
                if (input) {
                    console.log('❓ Unknown command. Available: status | clear | quit');
                }
                break;
        }
    }
    
    showStatus() {
        const status = this.ws && this.ws.readyState === WebSocket.OPEN ? '✅ Connected' : '❌ Disconnected';
        console.log('📊 Bridge Status:');
        console.log(`   Connection: ${status}`);
        console.log(`   Server: ${this.wsUrl}`);
        console.log(`   Protocol: WebSocket with JSON messages`);
        console.log('');
    }
    
    showHelp() {
        console.log('🎮 DJI Bridge Test Client - Phase 1');
        console.log('');
        console.log('Commands:');
        console.log('  status  - Show connection status');
        console.log('  clear   - Clear screen');
        console.log('  quit    - Exit the client');
        console.log('  help    - Show this help');
        console.log('');
        console.log('📡 This client connects to the DJI Android Bridge');
        console.log('   and displays real-time joystick data from the controller');
        console.log('');
    }
    
    disconnect() {
        console.log('👋 Disconnecting from DJI Bridge...');
        this.isRunning = false;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        
        if (this.ws) {
            this.ws.close();
        }
        
        this.rl.close();
        process.exit(0);
    }
}

// Main execution
function main() {
    console.log('🎮 DJI Android Bridge Test Client - Phase 1');
    console.log('==========================================');
    
    const deviceIp = process.argv[2];
    
    if (!deviceIp) {
        console.log(`⚠️  Using default IP: ${DEFAULT_IP}`);
        console.log('   Usage: node test_bridge.js <device_ip>');
        console.log('');
    }
    
    const client = new DJIBridgeClient(deviceIp);
    client.connect();
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n👋 Received SIGINT, shutting down gracefully...');
        client.disconnect();
    });
    
    process.on('SIGTERM', () => {
        console.log('\n👋 Received SIGTERM, shutting down gracefully...');
        client.disconnect();
    });
}

if (require.main === module) {
    main();
}