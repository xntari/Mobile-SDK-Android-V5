#!/usr/bin/env node

/**
 * DJI Android Bridge Test Client - Phase 1
 * 
 * Simple WebSocket client to test the DJI controller data streaming
 * Usage: node test_bridge.js [device_ip]
 */

const WebSocket = require('ws');
const readline = require('readline');

// Configuration
const DEFAULT_IP = '192.168.1.100';  // Replace with your DJI controller IP
const WEBSOCKET_PORT = 8080;
const RECONNECT_INTERVAL = 5000;

class DJIBridgeClient {
    constructor(deviceIp) {
        this.deviceIp = deviceIp || DEFAULT_IP;
        this.wsUrl = `ws://${this.deviceIp}:${WEBSOCKET_PORT}`;
        this.ws = null;
        this.reconnectTimer = null;
        this.isRunning = false;
        
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
            const message = JSON.parse(data.toString());
            
            if (message.type === 'controller_data') {
                console.log('🔍 DEBUG: Received controller_data message');
                this.displayControllerData(message);
            } else if (message.type === 'test') {
                console.log('✅ Test message from bridge:', message.message);
                console.log(`   Timestamp: ${new Date(message.timestamp).toISOString()}`);
                console.log('');
            } else {
                console.log('📨 Unknown message type:', message.type);
            }
            
        } catch (error) {
            console.error('❌ Failed to parse message:', error.message);
            console.log('   Raw data:', data.toString());
        }
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