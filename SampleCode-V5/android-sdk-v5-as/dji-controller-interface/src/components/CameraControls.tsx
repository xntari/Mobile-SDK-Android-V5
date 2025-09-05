import React, { useState } from 'react';
import { CameraData } from '../types';
import { useBridgeCommands } from '../hooks/useBridgeCommands';

interface CameraControlsProps {
  cameraData: CameraData | null;
}

export const CameraControls: React.FC<CameraControlsProps> = ({ cameraData }) => {
  const { sendBridgeCommand } = useBridgeCommands();
  const [isLoading, setIsLoading] = useState<string | null>(null);

  const handleCameraCommand = async (action: string, parameters?: Record<string, any>) => {
    setIsLoading(action);
    
    try {
      const result = await sendBridgeCommand({
        command: 'camera_control',
        parameters: {
          action,
          ...parameters
        }
      });
      
      if (!result.success) {
        console.error(`Camera command ${action} failed:`, result.error);
      }
    } catch (error) {
      console.error(`Failed to send camera command ${action}:`, error);
    } finally {
      setIsLoading(null);
    }
  };

  const handleTakePhoto = () => handleCameraCommand('take_photo');
  
  const handleStartRecording = () => handleCameraCommand('start_recording');
  
  const handleStopRecording = () => handleCameraCommand('stop_recording');

  const handleGimbalControl = (direction: 'up' | 'down' | 'left' | 'right') => {
    const gimbalMoves = {
      up: { pitch: -10, yaw: 0 },
      down: { pitch: 10, yaw: 0 },
      left: { pitch: 0, yaw: -10 },
      right: { pitch: 0, yaw: 10 }
    };
    
    handleCameraCommand('gimbal_rotate', gimbalMoves[direction]);
  };

  const isRecording = cameraData?.recording_status || false;
  const storageInfo = cameraData?.available_storage || 0;

  return (
    <div className="p-4 space-y-4">
      {/* Camera Status */}
      <div className="glass-panel p-3">
        <div className="text-sm font-semibold text-gray-300 mb-2">Camera Status</div>
        <div className="space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-400">Mode:</span>
            <span className="text-white">{cameraData?.mode || 'Unknown'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">ISO:</span>
            <span className="text-white">{cameraData?.iso || 'AUTO'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Shutter:</span>
            <span className="text-white">{cameraData?.shutter_speed || 'AUTO'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Storage:</span>
            <span className="text-white">{storageInfo.toFixed(1)}GB</span>
          </div>
        </div>
      </div>

      {/* Camera Controls */}
      <div className="glass-panel p-3">
        <div className="text-sm font-semibold text-gray-300 mb-3">Camera Controls</div>
        
        {/* Photo/Video Controls */}
        <div className="flex gap-2 mb-4">
          <button
            className="dji-button flex-1 py-2 text-sm flex flex-col items-center gap-1"
            onClick={handleTakePhoto}
            disabled={isLoading === 'take_photo'}
          >
            <div className="text-lg">📸</div>
            <div>{isLoading === 'take_photo' ? 'Taking...' : 'Photo'}</div>
          </button>
          
          {isRecording ? (
            <button
              className="dji-button-danger flex-1 py-2 text-sm flex flex-col items-center gap-1"
              onClick={handleStopRecording}
              disabled={isLoading === 'stop_recording'}
            >
              <div className="text-lg">⏹️</div>
              <div>{isLoading === 'stop_recording' ? 'Stopping...' : 'Stop'}</div>
            </button>
          ) : (
            <button
              className="dji-button-success flex-1 py-2 text-sm flex flex-col items-center gap-1"
              onClick={handleStartRecording}
              disabled={isLoading === 'start_recording'}
            >
              <div className="text-lg">🔴</div>
              <div>{isLoading === 'start_recording' ? 'Starting...' : 'Record'}</div>
            </button>
          )}
        </div>

        {/* Gimbal Controls */}
        <div className="text-xs text-gray-400 mb-2">Gimbal Control</div>
        <div className="grid grid-cols-3 gap-1 mb-2">
          <div></div>
          <button
            className="dji-button py-1 text-xs"
            onClick={() => handleGimbalControl('up')}
            disabled={isLoading === 'gimbal_rotate'}
          >
            ↑
          </button>
          <div></div>
          
          <button
            className="dji-button py-1 text-xs"
            onClick={() => handleGimbalControl('left')}
            disabled={isLoading === 'gimbal_rotate'}
          >
            ←
          </button>
          <div className="flex items-center justify-center text-xs text-gray-500">
            🎥
          </div>
          <button
            className="dji-button py-1 text-xs"
            onClick={() => handleGimbalControl('right')}
            disabled={isLoading === 'gimbal_rotate'}
          >
            →
          </button>
          
          <div></div>
          <button
            className="dji-button py-1 text-xs"
            onClick={() => handleGimbalControl('down')}
            disabled={isLoading === 'gimbal_rotate'}
          >
            ↓
          </button>
          <div></div>
        </div>

        {/* Gimbal Attitude Display */}
        {cameraData?.gimbal_attitude && (
          <div className="mt-3 pt-3 border-t border-gray-700">
            <div className="text-xs text-gray-400 mb-1">Gimbal Position</div>
            <div className="flex justify-between text-xs">
              <div>
                <span className="text-gray-400">P:</span>
                <span className="font-mono text-white ml-1">
                  {cameraData.gimbal_attitude.pitch.toFixed(1)}°
                </span>
              </div>
              <div>
                <span className="text-gray-400">R:</span>
                <span className="font-mono text-white ml-1">
                  {cameraData.gimbal_attitude.roll.toFixed(1)}°
                </span>
              </div>
              <div>
                <span className="text-gray-400">Y:</span>
                <span className="font-mono text-white ml-1">
                  {cameraData.gimbal_attitude.yaw.toFixed(1)}°
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Camera Settings */}
      <div className="glass-panel p-3">
        <div className="text-sm font-semibold text-gray-300 mb-3">Settings</div>
        
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="rounded" />
            <label className="text-gray-300">Auto Exposure Lock</label>
          </div>
          
          <div className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="rounded" />
            <label className="text-gray-300">Focus Peaking</label>
          </div>
          
          <div className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="rounded" />
            <label className="text-gray-300">Histogram</label>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-gray-700">
          <div className="text-xs text-gray-400 mb-2">Lens Control</div>
          <div className="flex gap-1">
            <button className="dji-button flex-1 py-1 text-xs">Wide</button>
            <button className="dji-button flex-1 py-1 text-xs">Zoom</button>
            <button className="dji-button flex-1 py-1 text-xs">Tele</button>
          </div>
        </div>
      </div>
    </div>
  );
};