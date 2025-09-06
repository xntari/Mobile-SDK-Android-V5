#!/usr/bin/env node

const WebSocket = require('ws');

console.log('🔗 Connecting to DJI Bridge for video frame debugging...');
const ws = new WebSocket('ws://127.0.0.1:8080');

let pendingMetadata = null;
let frameCount = 0;
let metadataCount = 0;
let binaryCount = 0;

ws.on('open', () => {
    console.log('✅ Connected! Monitoring video frames...\n');
});

ws.on('message', (data) => {
    const timestamp = Date.now();
    
    if (Buffer.isBuffer(data)) {
        // Binary frame
        binaryCount++;
        console.log(`⚪ ${timestamp}: Binary frame (${data.length} bytes)`);
        
        if (pendingMetadata) {
            console.log(`✅ Frame #${frameCount}: Matched binary (${data.length} bytes) with metadata (frame #${pendingMetadata.frameNumber})`);
            pendingMetadata = null;
            frameCount++;
        } else {
            console.log(`❌ Binary frame (${data.length} bytes) WITHOUT preceding metadata!`);
        }
    } else {
        // Text frame - could be string or buffer
        const textData = data.toString();
        console.log(`🟡 ${timestamp}: Text frame (${textData.length} chars): ${textData.substring(0, 100)}...`);
        
        try {
            const message = JSON.parse(textData);
            if (message.type === 'video_frame') {
                metadataCount++;
                pendingMetadata = message;
                console.log(`📝 Video metadata received: frame #${message.frameNumber}, ${message.frameSize} bytes, ${message.width}x${message.height}`);
            } else {
                // Other message types
                console.log(`📨 Other message: ${message.type}`);
            }
        } catch (e) {
            console.log(`❌ Failed to parse text message: ${e.message}`);
            console.log(`   Raw data: ${textData}`);
        }
    }
    
    // Stats every 30 messages
    if ((metadataCount + binaryCount) % 30 === 0) {
        console.log(`\n📊 Stats: ${metadataCount} metadata, ${binaryCount} binary, ${frameCount} matched pairs\n`);
    }
});

ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
});

ws.on('close', () => {
    console.log('\n🔌 Connection closed');
    console.log(`Final stats: ${metadataCount} metadata, ${binaryCount} binary, ${frameCount} matched pairs`);
});

// Exit on Ctrl+C
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    ws.close();
    process.exit(0);
});