import React, { useState } from 'react';
import { useBridgeCommands } from '../hooks/useBridgeCommands';

export const ReturnHomeButton: React.FC = () => {
  const { sendBridgeCommand } = useBridgeCommands();
  const [isLoading, setIsLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleReturnHome = async () => {
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
          action: 'return_home'
        }
      });

      if (!result.success) {
        console.error('Return home command failed:', result.error);
      }
    } catch (error) {
      console.error('Failed to send return home command:', error);
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
        <div className="text-xs text-gray-300 mb-2">Return to Home?</div>
        <div className="flex flex-col gap-2">
          <button
            className="dji-button-danger text-xs py-1 px-2"
            onClick={handleReturnHome}
            disabled={isLoading}
          >
            {isLoading ? 'Returning...' : 'YES'}
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
      className="dji-button-danger w-full py-3 text-sm font-semibold flex flex-col items-center gap-1"
      onClick={handleReturnHome}
      disabled={isLoading}
    >
      <div className="text-lg">🏠</div>
      <div>Return</div>
      <div className="text-xs">Home</div>
    </button>
  );
};