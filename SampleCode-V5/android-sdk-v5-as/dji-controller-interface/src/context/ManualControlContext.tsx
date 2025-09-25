import React from "react";
import {
  useManualFlightControl,
  ManualFlightControlHook,
} from "../hooks/useManualFlightControl";
import type { ControllerData } from "../types";

const ManualControlContext =
  React.createContext<ManualFlightControlHook | null>(null);

interface ManualControlProviderProps {
  controller: ControllerData | null;
  children: React.ReactNode;
}

export const ManualControlProvider: React.FC<ManualControlProviderProps> = ({
  controller,
  children,
}) => {
  const manualControl = useManualFlightControl(controller);
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
