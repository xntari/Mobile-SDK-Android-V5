import React, { useState } from 'react';
import { useBridgeCommands } from '../hooks/useBridgeCommands';

export const TakeOffButton: React.FC = () => {
  const { sendBridgeCommand } = useBridgeCommands();
  const [isLoading, setIsLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleTakeOff = async () => {
    if (!showConfirm) {
      setShowConfirm(true);
      // Auto-hide confirmation after 3 seconds
      setTimeout(() => setShowConfirm(false), 3000);
      return;
    }

    setIsLoading(true);
    setShowConfirm(false);

    try {
      const result = await sendBridgeCommand({
        command: 'flight_control',
        parameters: {
          action: 'takeoff'
        }
      });

      if (!result.success) {
        console.error('Takeoff command failed:', result.error);
      }
    } catch (error) {
      console.error('Failed to send takeoff command:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setShowConfirm(false);
  };

  if (showConfirm) {
    return (
      <div className="glass-panel p-3 text-center">
        <div className="text-xs text-gray-300 mb-2">Confirm Takeoff?</div>
        <div className="flex flex-col gap-2">
          <button
            className="dji-button-success text-xs py-1 px-2"
            onClick={handleTakeOff}
            disabled={isLoading}
          >
            {isLoading ? 'Taking Off...' : 'YES'}
          </button>
          <button
            className="dji-button text-xs py-1 px-2"
            onClick={handleCancel}
            disabled={isLoading}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      className="dji-button-success w-full py-3 text-sm font-semibold flex flex-col items-center gap-1"
      onClick={handleTakeOff}
      disabled={isLoading}
    >
      <div className="text-lg">🚁</div>
      <div>Take Off</div>
    </button>
  );
};