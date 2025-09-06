#!/usr/bin/env node

/**
 * Quick test to check camera metadata in telemetry data
 */

const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:8080');

ws.on('open', function open() {
    console.log('🔗 Connected to DJI Bridge - checking camera metadata...');
});

ws.on('message', function message(data) {
    try {
        const parsed = JSON.parse(data.toString());
        
        // Look for telemetry data
        if (parsed.type === 'telemetry_data') {
            if (parsed.cameras) {
                console.log('\n📹 CAMERA METADATA FOUND:');
                console.log('   Available cameras:', parsed.cameras.available);
                console.log('   Primary camera:', parsed.cameras.primary);
                console.log('   Secondary camera:', parsed.cameras.secondary);
                console.log('   H20N present:', parsed.cameras.h20n_present);
                console.log('   H20N sensors:', parsed.cameras.h20n_sensors);
                console.log('   H20N active sensor:', parsed.cameras.h20n_active_sensor);
                console.log('   Active streams:', parsed.cameras.active_streams);
                
                // Exit after finding camera data
                ws.close();
                process.exit(0);
            } else {
                console.log('⚠️  No camera metadata in telemetry');
            }
        }
    } catch (e) {
        // Skip parsing errors (like video frames)
    }
});

ws.on('error', function error(err) {
    console.error('❌ Connection error:', err.message);
});

// Exit after 10 seconds if no camera data found
setTimeout(() => {
    console.log('⏰ Timeout - no camera metadata found in 10 seconds');
    ws.close();
    process.exit(1);
}, 10000);