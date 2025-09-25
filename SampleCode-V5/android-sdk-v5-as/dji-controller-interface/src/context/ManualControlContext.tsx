import React from "react";
import {
  useManualFlightControl,
  ManualFlightControlHook,
} from "../hooks/useManualFlightControl";
import type { ConnectionStatus, ControllerData } from "../types";

const ManualControlContext =
  React.createContext<ManualFlightControlHook | null>(null);

interface ManualControlProviderProps {
  controller: ControllerData | null;
  connectionStatus: ConnectionStatus;
  children: React.ReactNode;
}

export const ManualControlProvider: React.FC<ManualControlProviderProps> = ({
  controller,
  connectionStatus,
  children,
}) => {
  const manualControl = useManualFlightControl(controller, connectionStatus);
  return (
    <ManualControlContext.Provider value={manualControl}>
      {children}
    </ManualControlContext.Provider>
  );
};

export const useManualControl = (): ManualFlightControlHook => {
  const context = React.useContext(ManualControlContext);
  if (!context) {
    throw new Error(
      "useManualControl must be used within a ManualControlProvider",
    );
  }
  return context;
};
