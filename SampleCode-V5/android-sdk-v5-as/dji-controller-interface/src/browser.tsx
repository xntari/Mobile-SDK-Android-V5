import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import './styles/index.css';

// Mock Electron API for browser development
(window as any).electronAPI = {
  // Window controls (browser-friendly)
  minimizeWindow: () => Promise.resolve(),
  maximizeWindow: () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
    return Promise.resolve();
  },
  closeWindow: () => {
    if (confirm('Close DJI Controller Interface?')) {
      window.close();
    }
    return Promise.resolve();
  },
  
  // Bridge communication (direct WebSocket)
  sendBridgeCommand: async (command: any) => {
    if (mockWs && mockWs.readyState === WebSocket.OPEN) {
      mockWs.send(JSON.stringify(command));
      return { success: true };
    }
    return { success: false, error: 'WebSocket not connected' };
  },
  
  getConnectionStatus: () => Promise.resolve(mockConnectionStatus),
  
  // Event listeners (direct handling)
  onBridgeData: (callback: (data: any) => void) => {
    callbacksSetCount++;
    console.log(`🔗 Browser: Setting bridgeDataCallback #${callbacksSetCount}`);
    
    // If this is not the first callback, we need to ensure continuity
    if (callbacksSetCount > 1) {
      console.log('⚠️ Browser: Multiple callback registrations detected');
    }
    
    bridgeDataCallback = callback;
  },
  
  onVideoFrame: (callback: (frame: any) => void) => {
    videoFrameCallback = callback;
  },
  
  onConnectionStatus: (callback: (status: string) => void) => {
    console.log('🔗 Browser: Setting connectionStatusCallback');
    connectionStatusCallback = callback;
  },
  
  // Cleanup
  removeAllListeners: (channel: string) => {
    if (channel === 'bridge-data') bridgeDataCallback = null;
    if (channel === 'video-frame') videoFrameCallback = null;
    if (channel === 'connection-status') connectionStatusCallback = null;
  }
};

// Mock WebSocket connection for browser
let mockWs: WebSocket | null = null;
let mockConnectionStatus = 'disconnected';
let bridgeDataCallback: ((data: any) => void) | null = null;
let videoFrameCallback: ((frame: any) => void) | null = null;
let connectionStatusCallback: ((status: string) => void) | null = null;
let callbacksSetCount = 0;
let pendingVideoFrame: any = null;

const connectToMockBridge = () => {
  console.log('🔄 Browser: Attempting to connect to DJI Bridge at ws://127.0.0.1:8080');
  mockConnectionStatus = 'connecting';
  connectionStatusCallback?.('connecting');
  
  try {
    mockWs = new WebSocket('ws://127.0.0.1:8080');
    console.log('🔄 Browser: WebSocket created, readyState:', mockWs.readyState);
    
    mockWs.onopen = () => {
      mockConnectionStatus = 'connected';
      connectionStatusCallback?.('connected');
      console.log('🟢 Browser: Connected to DJI Bridge at ws://127.0.0.1:8080');
      console.log('🟢 WebSocket readyState:', mockWs?.readyState);
    };
    
    mockWs.onmessage = (event) => {
      try {
        if (event.data instanceof Blob) {
          // Handle binary video data - should follow a video_frame metadata message
          if (pendingVideoFrame) {
            const reader = new FileReader();
            reader.onload = () => {
              if (reader.result instanceof ArrayBuffer && pendingVideoFrame) {
                // Use Uint8Array instead of Buffer for browser compatibility
                const uint8Array = new Uint8Array(reader.result);
                console.log(`🎬 Browser: Received H.264 frame: ${uint8Array.length} bytes, frame #${pendingVideoFrame.frameNumber}`);
                
                // Send both metadata and binary data to video callback
                videoFrameCallback?.({
                  metadata: pendingVideoFrame,
                  data: uint8Array
                });
                
                pendingVideoFrame = null; // Clear pending frame
              } else {
                console.warn('🎬 Browser: Skipping dropped frame - pendingVideoFrame is null');
              }
            };
            reader.readAsArrayBuffer(event.data);
          } else {
            console.warn('🎬 Browser: Received binary data without preceding video metadata');
            // Still process it as standalone binary data
            const reader = new FileReader();
            reader.onload = () => {
              if (reader.result instanceof ArrayBuffer) {
                const uint8Array = new Uint8Array(reader.result);
                videoFrameCallback?.({ data: uint8Array });
              }
            };
            reader.readAsArrayBuffer(event.data);
          }
        } else {
          // Handle JSON data
          const message = JSON.parse(event.data);
          
          if (message.type === 'video_frame') {
            // This is video metadata, expect binary data next
            pendingVideoFrame = message;
            console.log(`🎬 Browser: Video frame metadata: ${message.frameSize} bytes, ${message.width}x${message.height}`);
          } else {
            // Regular bridge data (controller, telemetry, etc.)
            console.log('📡 Browser: Received message:', message.type, message);
            console.log('📡 Browser: Calling bridgeDataCallback:', !!bridgeDataCallback);
            bridgeDataCallback?.(message);
          }
        }
      } catch (error) {
        console.error('Browser: Error processing bridge message:', error);
      }
    };
    
    mockWs.onclose = () => {
      mockConnectionStatus = 'disconnected';
      connectionStatusCallback?.('disconnected');
      console.log('🔴 Browser: Disconnected from DJI Bridge');
      
      // Auto-reconnect after 3 seconds
      setTimeout(() => {
        if (!mockWs || mockWs.readyState === WebSocket.CLOSED) {
          connectToMockBridge();
        }
      }, 3000);
    };
    
    mockWs.onerror = (error) => {
      mockConnectionStatus = 'error';
      connectionStatusCallback?.('error');
      console.error('❌ Browser: WebSocket error:', error);
      console.error('❌ WebSocket readyState:', mockWs?.readyState);
    };
    
  } catch (error) {
    mockConnectionStatus = 'error';
    connectionStatusCallback?.('error');
    console.error('Browser: Failed to create WebSocket connection:', error);
  }
};

// Start connection when page loads
connectToMockBridge();

// Render the app
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

const root = createRoot(container);
root.render(<App />);