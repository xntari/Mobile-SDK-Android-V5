import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  
  // Bridge communication
  sendBridgeCommand: (command: any) => ipcRenderer.invoke('send-bridge-command', command),
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),
  
  // Event listeners
  onBridgeData: (callback: (data: any) => void) => {
    ipcRenderer.on('bridge-data', (event, data) => callback(data));
  },
  
  onVideoFrame: (callback: (frame: Buffer) => void) => {
    ipcRenderer.on('video-frame', (event, frame) => callback(frame));
  },

  onFPVVideoFrame: (callback: (frame: any) => void) => {
    ipcRenderer.on('fpv-video-frame', (event, frame) => callback(frame));
  },

  onSecondaryVideoFrame: (callback: (frame: any) => void) => {
    ipcRenderer.on('secondary-video-frame', (event, frame) => callback(frame));
  },
  
  onConnectionStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('connection-status', (event, status) => callback(status));
  },
  
  // Cleanup listeners
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

// Types for TypeScript
declare global {
  interface Window {
    electronAPI: {
      minimizeWindow: () => Promise<void>;
      maximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      sendBridgeCommand: (command: any) => Promise<{ success: boolean; error?: string }>;
      getConnectionStatus: () => Promise<string>;
      onBridgeData: (callback: (data: any) => void) => void;
      onVideoFrame: (callback: (frame: Buffer) => void) => void;
      onFPVVideoFrame: (callback: (frame: any) => void) => void;
      onSecondaryVideoFrame: (callback: (frame: any) => void) => void;
      onConnectionStatus: (callback: (status: string) => void) => void;
      removeAllListeners: (channel: string) => void;
    };
  }
}