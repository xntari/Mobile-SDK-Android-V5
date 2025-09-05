import { bridgeManager } from '../bridgeManager';

export const useBridgeCommands = () => {
  return {
    sendBridgeCommand: bridgeManager.sendBridgeCommand.bind(bridgeManager)
  };
};