import React from 'react';
import { ConnectionStatus as ConnectionStatusType } from '../types';

interface ConnectionStatusProps {
  status: ConnectionStatusType;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({ status }) => {
  const getStatusInfo = () => {
    switch (status) {
      case 'connecting':
        return {
          text: 'Connecting to DJI Bridge...',
          color: 'text-status-warning',
          icon: '⏳',
          description: 'Attempting to establish WebSocket connection'
        };
      case 'connected':
        return {
          text: 'Connected to DJI Bridge',
          color: 'text-status-good',
          icon: '✅',
          description: 'Ready to receive data'
        };
      case 'error':
        return {
          text: 'Connection Error',
          color: 'text-status-error',
          icon: '❌',
          description: 'Failed to connect to bridge server'
        };
      case 'disconnected':
      default:
        return {
          text: 'Disconnected from DJI Bridge',
          color: 'text-gray-400',
          icon: '⚪',
          description: 'No connection to bridge server'
        };
    }
  };

  const statusInfo = getStatusInfo();

  return (
    <div className="glass-panel p-8 max-w-md mx-auto text-center">
      <div className="text-6xl mb-4">{statusInfo.icon}</div>
      <h1 className={`text-2xl font-semibold mb-2 ${statusInfo.color}`}>
        {statusInfo.text}
      </h1>
      <p className="text-gray-400 mb-6">{statusInfo.description}</p>
      
      {status === 'connecting' && (
        <div className="flex justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-dji-blue"></div>
        </div>
      )}
      
      {status === 'error' && (
        <div className="mt-4 p-4 bg-status-error bg-opacity-20 rounded border border-status-error">
          <p className="text-sm text-gray-300">
            Make sure the DJI Bridge is running on the controller:
          </p>
          <div className="mt-2 text-xs text-gray-400 font-mono">
            <div>adb shell am start -a dji.sampleV5.aircraft.action.START_BRIDGE</div>
            <div>adb forward tcp:8080 tcp:8080</div>
          </div>
        </div>
      )}
      
      {status === 'disconnected' && (
        <div className="mt-4 text-sm text-gray-400">
          Waiting for bridge connection...
        </div>
      )}
    </div>
  );
};