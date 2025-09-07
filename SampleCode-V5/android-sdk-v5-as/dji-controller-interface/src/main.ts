import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import WebSocket from 'ws';

interface BridgeMessage {
  type: string;
  version: string;
  timestamp: number;
  priority: string;
  [key: string]: any;
}

class DJIControllerApp {
  private mainWindow: BrowserWindow | null = null;
  private wsClient: WebSocket | null = null;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private pendingVideoFrame: any = null; // Store video metadata when expecting binary data

  constructor() {
    this.createWindow = this.createWindow.bind(this);
    this.setupWebSocketConnection = this.setupWebSocketConnection.bind(this);
  }

  createWindow(): void {
    this.mainWindow = new BrowserWindow({
      width: 1920,
      height: 1080,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
      frame: true,
      resizable: true,
      alwaysOnTop: false,
      title: 'DJI Controller Interface',
      backgroundColor: '#0D1117',
      show: false, // Don't show until ready
    });

    // Load the app
    if (process.env.NODE_ENV === 'development') {
      this.mainWindow.loadFile(path.join(__dirname, 'index.html'));
      this.mainWindow.webContents.openDevTools();
    } else {
      this.mainWindow.loadFile(path.join(__dirname, 'index.html'));
    }

    // Show window when ready to prevent visual flash
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
      // Give the renderer time to initialize before sending status
      setTimeout(() => {
        this.sendConnectionStatus();
      }, 1000);
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      if (this.wsClient) {
        this.wsClient.close();
      }
    });

    // Set up WebSocket connection
    this.setupWebSocketConnection();

    // Handle IPC messages from renderer
    this.setupIPCHandlers();
  }

  setupWebSocketConnection(): void {
    this.connectionStatus = 'connecting';
    this.sendConnectionStatus();

    try {
      this.wsClient = new WebSocket('ws://127.0.0.1:8080');

      this.wsClient.on('open', () => {
        console.log('Connected to DJI Bridge');
        this.connectionStatus = 'connected';
        this.sendConnectionStatus();
      });

      this.wsClient.on('message', (data: WebSocket.Data) => {
        try {
          // Debug: Log what type of data we're receiving
          const dataLength = Buffer.isBuffer(data) ? data.length : (data instanceof ArrayBuffer ? data.byteLength : (typeof data === 'string' ? data.length : 'unknown'));
          //console.log(`Received data type: ${typeof data}, length: ${dataLength}`);
          
          // Check if data can be parsed as JSON (text message)
          let message: BridgeMessage | null = null;
          let isTextMessage = true;
          
          try {
            const dataStr = data.toString();
            message = JSON.parse(dataStr);
            //console.log(`✅ Parsed JSON message: ${message.type}`);
          } catch (parseError) {
            // Not JSON, this is binary data
            isTextMessage = false;
            const binaryDataLength = Buffer.isBuffer(data) ? data.length : (data instanceof ArrayBuffer ? data.byteLength : (typeof data === 'string' ? data.length : 'unknown'));
            //console.log(`📦 Binary data received, size: ${binaryDataLength}`);
          }
          
          if (isTextMessage && message) {
            if (message.type === 'video_frame') {
              // This is video metadata, expect binary data next
              this.pendingVideoFrame = message;
            } else {
              // Regular bridge data (controller, telemetry, etc.)
              this.mainWindow?.webContents.send('bridge-data', message);
            }
          } else {
            // Binary video frame data
            if (this.pendingVideoFrame) {
              const frameData = {
                metadata: this.pendingVideoFrame,
                data: Buffer.from(data as any)
              };
              
              // Route to appropriate channel based on camera_source
              if (this.pendingVideoFrame.camera_source === 'fpv') {
                this.mainWindow?.webContents.send('fpv-video-frame', frameData);
              } else if (this.pendingVideoFrame.camera_source === 'secondary') {
                this.mainWindow?.webContents.send('secondary-video-frame', frameData);
              } else {
                // Fallback to legacy channel for backwards compatibility
                this.mainWindow?.webContents.send('video-frame', frameData);
              }
              
              this.pendingVideoFrame = null; // Clear pending frame
            } else {
              // Just binary data without metadata - send to legacy channel
              this.mainWindow?.webContents.send('video-frame', { data: Buffer.from(data as any) });
            }
          }
        } catch (error) {
          console.error('Error processing bridge message:', error);
        }
      });

      this.wsClient.on('close', () => {
        console.log('Disconnected from DJI Bridge');
        this.connectionStatus = 'disconnected';
        this.sendConnectionStatus();
        
        // Attempt to reconnect after 3 seconds
        setTimeout(() => {
          if (!this.wsClient || this.wsClient.readyState === WebSocket.CLOSED) {
            this.setupWebSocketConnection();
          }
        }, 3000);
      });

      this.wsClient.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.connectionStatus = 'error';
        this.sendConnectionStatus();
      });

    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.connectionStatus = 'error';
      this.sendConnectionStatus();
    }
  }

  setupIPCHandlers(): void {
    // Handle window controls
    ipcMain.handle('window-minimize', () => {
      this.mainWindow?.minimize();
    });

    ipcMain.handle('window-maximize', () => {
      if (this.mainWindow?.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow?.maximize();
      }
    });

    ipcMain.handle('window-close', () => {
      this.mainWindow?.close();
    });

    // Handle bridge commands
    ipcMain.handle('send-bridge-command', async (event, command) => {
      if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
        this.wsClient.send(JSON.stringify(command));
        return { success: true };
      } else {
        return { success: false, error: 'Bridge not connected' };
      }
    });

    // Get connection status
    ipcMain.handle('get-connection-status', () => {
      return this.connectionStatus;
    });
  }

  sendConnectionStatus(): void {
    this.mainWindow?.webContents.send('connection-status', this.connectionStatus);
  }
}

// App event handlers
const djiApp = new DJIControllerApp();

app.whenReady().then(() => {
  djiApp.createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      djiApp.createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler((details) => {
    console.log('Blocked new window creation:', details.url);
    return { action: 'deny' };
  });
});
