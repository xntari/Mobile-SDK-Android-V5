import React, { useState, useRef } from "react";
import { useStableBridgeData } from "../hooks/useStableBridgeData";
import { TopBar } from "./TopBar";
import { FPVDisplay, FPVDisplayRef } from "./FPVDisplay";
import { H20NDisplay, H20NDisplayRef } from "./H20NDisplay";
import { TakeOffButton } from "./TakeOffButton";
import { ReturnHomeButton } from "./ReturnHomeButton";
import { HSICompass } from "./HSICompass";
import { MapDisplay } from "./MapDisplay";
import { FlightDisplay } from "./FlightDisplay";
import { CameraDisplay } from "./CameraDisplay";
import { GPSTargetPanel } from "./GPSTargetPanel";
import { CameraControls } from "./CameraControls";
import { ConnectionStatus } from "./ConnectionStatus";
import { VisionPanel } from "./VisionPanel";
import { VisionRealtimePanel } from "./VisionRealtimePanel";
import { AgentPanel } from "./AgentPanel";
import { ObjectMemoryPanel } from "./ObjectMemoryPanel";
import { CameraPanel } from "./CameraPanel";
import { Panel } from "./Panel";
import {
  mapPanelControls,
  hsiPanelControls,
  controllerPanelControls,
} from "./panelControls";
import { bridgeManager } from "../bridgeManager";
import { OrientationPanel } from "./OrientationPanel";
import { ProjectionControls } from "./ProjectionControls";
import { FlightCommandsPanel } from "./FlightCommandsPanel";
import { PreflightPanel } from "./PreflightPanel";
import { FlyToPanel } from "./FlyToPanel";
import {
  ManualControlProvider,
  useManualControl,
} from "../context/ManualControlContext";
import type { ControllerData, FlightCommandAck, TelemetryData } from "../types";

const formatPercent = (value: number) => {
  const percent = Math.round(value * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
};

const formatStickFromInt = (value?: number | null) => {
  if (value === undefined || value === null) return "–";
  const normalized = value / 660;
  return formatPercent(normalized);
};

const formatAxis = (value: number) =>
  `${formatPercent(value)} (${value.toFixed(2)})`;

const formatMeters = (value?: number | null, precision = 1) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(precision)} m`
    : "–";

const ControllerInsightPanel: React.FC<{
  controller: ControllerData | null;
  history: FlightCommandAck[];
  telemetry: TelemetryData | null;
}> = ({ controller, history, telemetry }) => {
  const manualControl = useManualControl();
  const manualAxes = manualControl.state.axes;
  const virtualStick = manualControl.virtualStick;

  const lastOverrideAck = React.useMemo(() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const entry = history[i];
      if (entry.action === "virtual_stick_override") {
        return entry;
      }
    }
    return null;
  }, [history]);

  return (
    <Panel
      title="Controller Insight"
      defaultPosition={{ x: 380, y: 20 }}
      defaultSize={{ w: 320, h: 160 }}
      storageKey="controller.panel"
      visibilityEventType="controllerPanelVisibilityChange"
    >
      <div className="flex flex-col gap-2 text-[11px] text-gray-200">
        <div className="flex flex-col gap-1 bg-black/30 rounded px-2 py-1 border border-gray-700/60">
          <div className="text-gray-400 uppercase tracking-wide text-[10px]">
            Physical RC
          </div>
          {controller ? (
            <div className="flex flex-col gap-1 font-mono text-sm text-dji-blue">
              <div>
                L: {controller.joystick.left_horizontal.toFixed(0)},{" "}
                {controller.joystick.left_vertical.toFixed(0)}
              </div>
              <div>
                R: {controller.joystick.right_horizontal.toFixed(0)},{" "}
                {controller.joystick.right_vertical.toFixed(0)}
              </div>
              <div className="text-[10px] text-gray-400">
                VS: {controller.virtual_stick?.enabled ? "ENABLED" : "DISABLED"}{" "}
                · Authority:{" "}
                {controller.virtual_stick?.authority_owner ?? "UNKNOWN"}
              </div>
              {controller.virtual_stick?.manual_override && (
                <div className="text-[10px] text-status-error">
                  Hardware override active
                </div>
              )}
              {controller.virtual_stick?.change_reason && (
                <div className="text-[10px] text-gray-500">
                  Reason:{" "}
                  {controller.virtual_stick.change_reason.replace(/_/g, " ")}
                </div>
              )}
            </div>
          ) : (
            <div className="text-gray-500">
              Controller telemetry unavailable
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="bg-black/30 rounded border border-gray-700/60 px-2 py-1">
            <div className="text-gray-400 uppercase tracking-wide text-[10px]">
              SW Command
            </div>
            <div className="text-[10px] text-gray-400">
              Status: {manualControl.state.status.toUpperCase()}
            </div>
            <div className="text-[10px] text-gray-400">
              Pointer:{" "}
              {manualControl.state.pointerLocked ? "Locked" : "Released"}
            </div>
            <div className="font-mono text-sm mt-1">
              <div>Pitch {formatAxis(manualAxes.pitch)}</div>
              <div>Roll {formatAxis(manualAxes.roll)}</div>
              <div>Throttle {formatAxis(manualAxes.throttle)}</div>
              <div>Yaw {formatAxis(manualAxes.yaw)}</div>
            </div>
          </div>
          <div className="bg-black/30 rounded border border-gray-700/60 px-2 py-1">
            <div className="text-gray-400 uppercase tracking-wide text-[10px]">
              Ack (Bridge)
            </div>
            {lastOverrideAck?.joystick ? (
              <div className="font-mono text-sm">
                <div>
                  LH{" "}
                  {formatStickFromInt(lastOverrideAck.joystick.left_horizontal)}
                </div>
                <div>
                  LV{" "}
                  {formatStickFromInt(lastOverrideAck.joystick.left_vertical)}
                </div>
                <div>
                  RH{" "}
                  {formatStickFromInt(
                    lastOverrideAck.joystick.right_horizontal,
                  )}
                </div>
                <div>
                  RV{" "}
                  {formatStickFromInt(lastOverrideAck.joystick.right_vertical)}
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-gray-500">
                No override ack yet
              </div>
            )}
            <div className="text-[10px] text-gray-400 mt-1">
              VS Owner: {virtualStick.owner} · Mode:{" "}
              {virtualStick.enabled ? "Enabled" : "Disabled"}
            </div>
          </div>
          <div className="bg-black/30 rounded border border-gray-700/60 px-2 py-1">
            <div className="text-gray-400 uppercase tracking-wide text-[10px]">
              Limits
            </div>
            <div className="text-[10px] text-gray-300">
              Max Height: {formatMeters(telemetry?.max_flight_height, 0)}
            </div>
            <div className="text-[10px] text-gray-300">
              Go-Home Height: {formatMeters(telemetry?.go_home_height, 0)}
            </div>
            <div className="text-[10px] text-gray-300">
              Distance Limit:{" "}
              {telemetry?.max_flight_distance_enabled === false
                ? "Disabled"
                : formatMeters(telemetry?.max_flight_distance, 0)}
            </div>
            <div className="text-[10px] text-gray-500 mt-1">
              Current AGL: {formatMeters(telemetry?.altitude)}
            </div>
            {telemetry?.fly_safe?.warning_notification && (
              <div className="text-[10px] text-status-warning mt-1">
                Warning:{" "}
                {telemetry.fly_safe.warning_notification.event || "UNKNOWN"} ·
                Limit:{" "}
                {formatMeters(
                  telemetry.fly_safe.warning_notification.height_limit,
                  0,
                )}
              </div>
            )}
            {Array.isArray(telemetry?.fly_safe?.surrounding_zones) &&
              telemetry.fly_safe.surrounding_zones.length > 0 && (
                <div className="text-[10px] text-gray-400 mt-1">
                  Zones nearby: {telemetry.fly_safe.surrounding_zones.length}
                </div>
              )}
          </div>
        </div>
      </div>
    </Panel>
  );
};

export const App: React.FC = () => {
  const { bridgeData, connectionStatus } = useStableBridgeData();

  // Camera selection for snapshot functionality
  const [selectedCamera, setSelectedCamera] = useState<"fpv" | "h20n">("fpv");

  // Shared detection state for vision/agent integration
  const [visionDetections, setVisionDetections] = useState<any[]>([]);
  const [visionMasks, setVisionMasks] = useState<any[]>([]);
  const [visionHeatmap, setVisionHeatmap] = useState<string | null>(null);
  const [visionHeatmapOpacity, setVisionHeatmapOpacity] = useState<number>(
    () => {
      try {
        const v = JSON.parse(
          localStorage.getItem("locktrack.hmOpacity") || "0.35",
        );
        if (typeof v === "number") return v;
      } catch {}
      return 0.35;
    },
  );
  React.useEffect(() => {
    try {
      localStorage.setItem(
        "locktrack.hmOpacity",
        JSON.stringify(visionHeatmapOpacity),
      );
    } catch {}
  }, [visionHeatmapOpacity]);
  const [maskOpacity, setMaskOpacity] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("visionrt.maskOpacity");
      if (raw) return JSON.parse(raw);
    } catch {}
    return 0.25;
  });
  const [colorizeById, setColorizeById] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("visionrt.colorizeById");
      if (raw) return JSON.parse(raw);
    } catch {}
    return false;
  });
  const [detectThickness, setDetectThickness] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("visionrt.detectThickness");
      if (raw) return JSON.parse(raw);
    } catch {}
    return 1;
  });
  React.useEffect(() => {
    try {
      localStorage.setItem("visionrt.maskOpacity", JSON.stringify(maskOpacity));
    } catch {}
  }, [maskOpacity]);
  React.useEffect(() => {
    try {
      localStorage.setItem(
        "visionrt.colorizeById",
        JSON.stringify(colorizeById),
      );
    } catch {}
  }, [colorizeById]);
  React.useEffect(() => {
    try {
      localStorage.setItem(
        "visionrt.detectThickness",
        JSON.stringify(detectThickness),
      );
    } catch {}
  }, [detectThickness]);
  const [visionKeypoints, setVisionKeypoints] = useState<
    Array<Array<{ x: number; y: number; conf?: number }>>
  >([]);
  const [agentDetections, setAgentDetections] = useState<any[]>([]);

  // References to camera displays for snapshot functionality
  const fpvDisplayRef = useRef<FPVDisplayRef>(null);
  const h20nDisplayRef = useRef<H20NDisplayRef>(null);

  // Bridge integration functions
  const getSnapshot = async (): Promise<string> => {
    try {
      // Use the selected camera for snapshot
      const targetRef =
        selectedCamera === "fpv"
          ? fpvDisplayRef.current
          : h20nDisplayRef.current;
      if (targetRef?.getSnapshot) {
        return await targetRef.getSnapshot();
      }

      // Fallback to any available camera
      const fallbackRef = fpvDisplayRef.current || h20nDisplayRef.current;
      if (fallbackRef?.getSnapshot) {
        return await fallbackRef.getSnapshot();
      }
      throw new Error("No camera display available for snapshot");
    } catch (error) {
      console.error("Snapshot failed:", error);
      return "data:image/jpeg;base64,"; // Return empty base64 as fallback
    }
  };

  const sendBridge = async (msg: any): Promise<any> => {
    try {
      return await bridgeManager.sendBridgeCommand(msg);
    } catch (error) {
      console.error("Bridge command failed:", error);
      return { success: false, error: error.message };
    }
  };

  // Show connection screen while not connected or no data at all
  const hasAnyData =
    bridgeData.controller || bridgeData.telemetry || bridgeData.battery;
  const shouldShowUI =
    (connectionStatus === "connected" ||
      connectionStatus === "connecting" ||
      connectionStatus === "reconnecting") &&
    hasAnyData;

  if (!shouldShowUI) {
    return (
      <div className="h-screen bg-dji-dark flex items-center justify-center">
        <ConnectionStatus status={connectionStatus} />
      </div>
    );
  }

  try {
  return (
    <ManualControlProvider
      controller={bridgeData.controller}
      connectionStatus={connectionStatus}
    >
        <div className="h-screen bg-dji-dark text-white flex flex-col overflow-hidden no-select">
          {/* Top Status Bar */}
          <TopBar
            batteryData={bridgeData.battery}
            telemetryData={bridgeData.telemetry}
            connectionStatus={connectionStatus}
          />

          {/* Main Content Area - Dark background for floating panels */}
          <div className="flex-1 relative bg-dji-dark">
            {/* FPV Camera Panel */}
            <CameraPanel
              title="FPV Camera"
              defaultPosition={{ x: 50, y: 50 }}
              defaultSize={{ w: 640, h: 480 }}
              storageKey="fpv.panel"
              visibilityEventType="fpvCameraPanelVisibilityChange"
            >
              <FPVDisplay
                ref={fpvDisplayRef}
                className="w-full h-full"
                telemetryData={bridgeData.telemetry}
                visionDetections={
                  selectedCamera === "fpv" ? visionDetections : []
                }
                visionMasks={selectedCamera === "fpv" ? visionMasks : []}
                visionKeypoints={
                  selectedCamera === "fpv" ? visionKeypoints : []
                }
                agentDetections={
                  selectedCamera === "fpv" ? agentDetections : []
                }
                maskOpacity={maskOpacity}
                colorizeById={colorizeById}
                detectThickness={detectThickness}
                visionHeatmap={selectedCamera === "fpv" ? visionHeatmap : null}
                visionHeatmapOpacity={visionHeatmapOpacity}
              />
            </CameraPanel>

            {/* H20N Camera Panel */}
            <CameraPanel
              title="H20N Camera"
              defaultPosition={{ x: 720, y: 50 }}
              defaultSize={{ w: 640, h: 480 }}
              storageKey="h20n.panel"
              visibilityEventType="h20nCameraPanelVisibilityChange"
            >
              <H20NDisplay
                ref={h20nDisplayRef}
                className="w-full h-full"
                telemetryData={bridgeData.telemetry}
                visionDetections={
                  selectedCamera === "h20n" ? visionDetections : []
                }
                visionMasks={selectedCamera === "h20n" ? visionMasks : []}
                visionKeypoints={
                  selectedCamera === "h20n" ? visionKeypoints : []
                }
                agentDetections={
                  selectedCamera === "h20n" ? agentDetections : []
                }
                maskOpacity={maskOpacity}
                colorizeById={colorizeById}
                detectThickness={detectThickness}
                visionHeatmap={selectedCamera === "h20n" ? visionHeatmap : null}
                visionHeatmapOpacity={visionHeatmapOpacity}
              />
            </CameraPanel>

            {/* Map Display Panel */}
            <Panel
              title="Map"
              defaultPosition={{ x: 20, y: 100 }}
              defaultSize={{ w: 250, h: 200 }}
              storageKey="map.panel"
              visibilityEventType="mapPanelVisibilityChange"
            >
              <MapDisplay />
            </Panel>

            {/* HSI Compass Panel */}
            <Panel
              title="HSI Compass"
              defaultPosition={{ x: 20, y: 320 }}
              defaultSize={{ w: 250, h: 250 }}
              storageKey="hsi.panel"
              visibilityEventType="hsiPanelVisibilityChange"
            >
              <HSICompass size="small" standalone={false} />
            </Panel>

            <ObjectMemoryPanel
              defaultPosition={{ x: 20, y: 600 }}
              defaultSize={{ w: 420, h: 320 }}
            />

            {/* GPS Target Panel */}
            <Panel
              title="GPS Targets"
              defaultPosition={{ x: 450, y: 600 }}
              defaultSize={{ w: 380, h: 400 }}
              storageKey="gps.targets.panel"
              visibilityEventType="gpsTargetsPanelVisibilityChange"
            >
              <GPSTargetPanel telemetryData={bridgeData.telemetry} />
            </Panel>

            <ControllerInsightPanel
              controller={bridgeData.controller}
              history={bridgeData.flightCommandLog}
              telemetry={bridgeData.telemetry}
            />

            {/* Camera Selector for Vision/Agent */}
            <div className="absolute top-4 right-4 z-30">
              <div className="glass-panel p-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400">Snapshot Camera:</span>
                  <button
                    onClick={() => setSelectedCamera("fpv")}
                    className={`px-3 py-1 rounded ${
                      selectedCamera === "fpv"
                        ? "bg-dji-blue text-white"
                        : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                    }`}
                  >
                    FPV
                  </button>
                  <button
                    onClick={() => setSelectedCamera("h20n")}
                    className={`px-3 py-1 rounded ${
                      selectedCamera === "h20n"
                        ? "bg-dji-blue text-white"
                        : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                    }`}
                  >
                    H20N
                  </button>
                </div>
              </div>
            </div>

            {/* Global panels - persist across camera switching */}
            <VisionPanel
              getSnapshot={getSnapshot}
              setBoxes={setVisionDetections}
            />

            <AgentPanel
              getSnapshot={getSnapshot}
              sendBridge={sendBridge}
              setDetections={setAgentDetections}
              laserResult={null}
            />

            <VisionRealtimePanel
              getSnapshot={getSnapshot}
              setBoxes={setVisionDetections}
              setMasks={setVisionMasks}
              setPoses={(poses) => setVisionKeypoints(poses)}
              setMaskOpacity={setMaskOpacity}
              setColorizeById={setColorizeById}
              setDetectThickness={setDetectThickness}
              setHeatmap={setVisionHeatmap}
              setHeatmapOpacity={setVisionHeatmapOpacity}
            />

            <FlightCommandsPanel
              telemetry={bridgeData.telemetry}
              history={bridgeData.flightCommandLog}
              controller={bridgeData.controller}
            />

            <FlyToPanel />

            <PreflightPanel
              preflight={bridgeData.preflight}
              history={bridgeData.flightCommandLog}
            />

            <OrientationPanel
              telemetry={bridgeData.telemetry}
              sendCommand={sendBridge}
            />

            <ProjectionControls />
          </div>
        </div>
      </ManualControlProvider>
    );
  } catch (error) {
    return (
      <div className="h-screen bg-dji-dark flex items-center justify-center">
        <div className="text-white text-center">
          <div className="text-xl mb-4">UI Render Error</div>
          <div className="text-sm text-gray-400">{error.message}</div>
        </div>
      </div>
    );
  }
};
