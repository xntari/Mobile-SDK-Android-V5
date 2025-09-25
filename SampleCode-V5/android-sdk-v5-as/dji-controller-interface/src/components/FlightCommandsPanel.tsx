import React from "react";
import { Panel } from "./Panel";
import {
  TelemetryData,
  FlightCommandAck,
  ControllerData,
  TelemetryDiagnosticEntry,
} from "../types";
import { useBridgeCommands } from "../hooks/useBridgeCommands";
import { useManualControl } from "../context/ManualControlContext";
import { Notification } from "./Modal";

interface FlightCommandsPanelProps {
  telemetry: TelemetryData | null;
  history: FlightCommandAck[];
  controller: ControllerData | null;
}

type CommandTone = "primary" | "success" | "danger";

type CommandSpec = {
  action: string;
  label: string;
  tone?: CommandTone;
  requireConfirm?: boolean;
  confirmationText?: string;
  isDisabled?: (telemetry: TelemetryData | null) => boolean;
  params?:
    | Record<string, any>
    | ((telemetry: TelemetryData | null) => Record<string, any> | undefined);
};

const diagnosticLevelClass = (level?: string | null) => {
  if (!level) return "text-gray-400";
  const normalized = level.toLowerCase();
  if (normalized.includes("error") || normalized.includes("critical"))
    return "text-status-error";
  if (normalized.includes("warn") || normalized.includes("caution"))
    return "text-yellow-300";
  if (normalized.includes("good") || normalized.includes("normal"))
    return "text-status-good";
  return "text-gray-400";
};

const summarizeDiagnostic = (diag: TelemetryDiagnosticEntry): string => {
  if (diag.title) return diag.title;
  if (diag.description) return diag.description;
  if (diag.code) return String(diag.code);
  return "Diagnostic";
};

const COMMAND_GROUPS: Array<{ title: string; commands: CommandSpec[] }> = [
  {
    title: "Calibration",
    commands: [
      {
        action: "compass_calibrate_start",
        label: "Start Compass Cal",
        tone: "primary",
        requireConfirm: true,
        confirmationText: "START?",
      },
      {
        action: "compass_calibrate_stop",
        label: "Stop Compass Cal",
        tone: "danger",
      },
    ],
  },
  {
    title: "Flight",
    commands: [
      {
        action: "takeoff",
        label: "Take Off",
        tone: "success",
        requireConfirm: true,
        confirmationText: "GO?",
        isDisabled: (telemetry) => (telemetry?.altitude ?? 0) > 1.5,
      },
      {
        action: "land",
        label: "Land",
        tone: "primary",
        requireConfirm: true,
        confirmationText: "LAND?",
      },
      {
        action: "cancel_landing",
        label: "Cancel Landing",
        tone: "primary",
      },
      {
        action: "confirm_landing",
        label: "Confirm Landing",
        tone: "success",
      },
    ],
  },
  {
    title: "Emergency",
    commands: [
      {
        action: "force_land_start",
        label: "Force Land",
        tone: "danger",
        requireConfirm: true,
        confirmationText: "FORCE?",
      },
      {
        action: "force_land_stop",
        label: "Abort Force",
        tone: "danger",
      },
    ],
  },
  {
    title: "Return to Home",
    commands: [
      {
        action: "return_home_start",
        label: "Start RTH",
        tone: "primary",
        requireConfirm: true,
        confirmationText: "RTH?",
      },
      {
        action: "return_home_stop",
        label: "Stop RTH",
        tone: "danger",
      },
    ],
  },
  {
    title: "Virtual Stick",
    commands: [
      {
        action: "virtual_stick_enable",
        label: "Enable VS",
        tone: "primary",
      },
      {
        action: "virtual_stick_disable",
        label: "Disable VS",
        tone: "danger",
      },
    ],
  },
];

const baseButtonClasses =
  "w-full rounded border text-[11px] font-semibold uppercase tracking-wide py-1 px-2 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-offset-[1px] focus:ring-offset-black/40 flex items-center justify-center text-center";
const toneClass: Record<CommandTone, string> = {
  primary: `${baseButtonClasses} bg-gray-800/70 border-gray-600 text-gray-100 hover:bg-gray-700/70`,
  success: `${baseButtonClasses} bg-status-good/20 border-status-good/50 text-status-good hover:bg-status-good/30`,
  danger: `${baseButtonClasses} bg-status-error/20 border-status-error/60 text-status-error hover:bg-status-error/35`,
};

type ActionAckMap = Map<string, FlightCommandAck>;

type CommandButtonProps = {
  spec: CommandSpec;
  telemetry: TelemetryData | null;
  acknowledgements: ActionAckMap;
  isPending: boolean;
  pendingMeta?: { state: "pending" | "timeout" | "error"; message?: string };
  onSend: (action: string, params?: Record<string, any>) => Promise<void>;
};

const CONFIRM_TIMEOUT_MS = 4000;
const BRIDGE_RESPONSE_TIMEOUT_MS = 6000;
const CommandButton: React.FC<CommandButtonProps> = ({
  spec,
  telemetry,
  acknowledgements,
  isPending,
  pendingMeta,
  onSend,
}) => {
  const [confirming, setConfirming] = React.useState(false);
  const confirmTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [localError, setLocalError] = React.useState<string | null>(null);
  const ack = acknowledgements.get(spec.action);

  const disabled = Boolean(spec.isDisabled?.(telemetry)) || isPending;

  React.useEffect(() => {
    return () => {
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!ack) return;
    if (ack.status === "error" && ack.error_message) {
      setLocalError(ack.error_message);
    } else {
      setLocalError(null);
    }
  }, [ack]);

  const handleConfirmCountdown = () => {
    setConfirming(true);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
    }
    confirmTimerRef.current = setTimeout(
      () => setConfirming(false),
      CONFIRM_TIMEOUT_MS,
    );
  };

  const resolveParams = () => {
    if (!spec.params) return undefined;
    if (typeof spec.params === "function") {
      return spec.params(telemetry);
    }
    return spec.params;
  };

  const handleClick = async () => {
    if (disabled) return;

    if (spec.requireConfirm && !confirming) {
      handleConfirmCountdown();
      return;
    }

    setConfirming(false);
    try {
      await onSend(spec.action, resolveParams());
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Command failed");
    }
  };

  const statusClass =
    ack?.status === "ok"
      ? "text-status-good"
      : ack?.status === "error"
        ? "text-status-error"
        : "text-gray-400";
  const pendingState = pendingMeta?.state;
  const pendingMessage = pendingMeta?.message;
  const isBridgePending = pendingState === "pending";
  const bridgeFault = pendingState === "timeout" || pendingState === "error";
  const failureMessage =
    ack && ack.status !== "ok"
      ? ack.error_message ||
        ack.message ||
        "Bridge reported failure (no message)"
      : null;

  return (
    <div className="flex flex-col gap-1">
      <button
        className={toneClass[spec.tone ?? "primary"]}
        onClick={handleClick}
        disabled={disabled}
      >
        {isPending || isBridgePending
          ? "Sending…"
          : confirming && spec.requireConfirm
            ? (spec.confirmationText ?? "Confirm?")
            : spec.label.toUpperCase()}
      </button>
      <div
        className={`text-[11px] min-h-[14px] leading-tight ${bridgeFault ? "text-status-error" : statusClass}`}
      >
        {ack
          ? `${ack.status.toUpperCase()} • ${new Date(ack.timestamp).toLocaleTimeString()}`
          : isBridgePending
            ? (pendingMessage ?? "Awaiting bridge response…")
            : bridgeFault
              ? (pendingMessage ?? "No bridge response")
              : "Awaiting command"}
      </div>
      {ack?.diagnostics && ack.diagnostics.length > 0 && (
        <div
          className={`text-[10px] leading-tight ${diagnosticLevelClass(ack.diagnostics[0].level)}`}
        >
          {summarizeDiagnostic(ack.diagnostics[0])}
        </div>
      )}
      {(failureMessage || localError) && (
        <div className="text-[11px] text-status-error leading-tight">
          {failureMessage ?? localError}
        </div>
      )}
    </div>
  );
};

const formatAltitude = (alt?: number | null) => {
  if (typeof alt !== "number" || Number.isNaN(alt)) return "–";
  return `${alt.toFixed(1)} m`;
};

const formatSpeed = (speed?: number | null) => {
  if (typeof speed !== "number" || Number.isNaN(speed)) return "–";
  return `${speed.toFixed(1)} m/s`;
};

const formatAxisPercent = (value: number) => {
  const percent = Math.round(value * 100);
  const prefix = percent > 0 ? "+" : "";
  return `${prefix}${percent}%`;
};

const formatRelativeTime = (timestamp: number | null) => {
  if (!timestamp) return "–";
  const delta = Date.now() - timestamp;
  if (delta < 0) return "now";
  if (delta < 1000) return "<1s";
  if (delta < 60000) return `${Math.floor(delta / 1000)}s`;
  const minutes = delta / 60000;
  if (minutes < 10) return `${minutes.toFixed(1)}m`;
  return `${Math.floor(minutes)}m`;
};

export const FlightCommandsPanel: React.FC<FlightCommandsPanelProps> = ({
  telemetry,
  history,
  controller,
}) => {
  const { sendFlightCommand } = useBridgeCommands();
  const [pendingActions, setPendingActions] = React.useState<Set<string>>(
    new Set(),
  );
  const [pendingMeta, setPendingMeta] = React.useState<
    Map<string, { state: "pending" | "timeout" | "error"; message?: string }>
  >(new Map());
  const pendingTimersRef = React.useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const pendingMetaRef = React.useRef(pendingMeta);
  const manualControl = useManualControl();
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const lastManualCueRef = React.useRef<number | null>(null);
  const manualState = manualControl.state;

  const playManualCue = React.useCallback(
    (type: "kill" | "override" | "release") => {
      try {
        const AudioCtor = (window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext) as typeof AudioContext | undefined;
        if (!AudioCtor) {
          return;
        }
        const context = audioContextRef.current ?? new AudioCtor();
        audioContextRef.current = context;
        if (context.state === "suspended") {
          context.resume().catch(() => undefined);
        }

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;
        const frequency =
          type === "kill" ? 440 : type === "override" ? 640 : 520;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, now);

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(
          type === "kill" ? 0.35 : 0.28,
          now + 0.015,
        );
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

        oscillator.connect(gain);
        gain.connect(context.destination);

        oscillator.start(now);
        oscillator.stop(now + 0.45);
      } catch (error) {
        console.warn("Manual control audio cue failed", error);
      }
    },
    [],
  );

  React.useEffect(() => {
    const notification = manualState.notification;
    if (!notification) {
      return;
    }
    if (lastManualCueRef.current === notification.timestamp) {
      return;
    }
    lastManualCueRef.current = notification.timestamp;
    playManualCue(notification.type);
  }, [manualState.notification, playManualCue]);

  React.useEffect(() => {
    pendingMetaRef.current = pendingMeta;
  }, [pendingMeta]);

  React.useEffect(() => {
    return () => {
      pendingTimersRef.current.forEach((timer) => clearTimeout(timer));
      pendingTimersRef.current.clear();
    };
  }, []);

  const acknowledgements = React.useMemo<ActionAckMap>(() => {
    const map = new Map<string, FlightCommandAck>();
    history.forEach((ack) => {
      map.set(ack.action, ack);
    });
    return map;
  }, [history]);

  React.useEffect(() => {
    if (!history.length) return;
    const latest = history[history.length - 1];
    setPendingActions((prev) => {
      if (!prev.has(latest.action)) return prev;
      const next = new Set(prev);
      next.delete(latest.action);
      return next;
    });
    setPendingMeta((prev) => {
      if (!prev.has(latest.action)) return prev;
      const next = new Map(prev);
      next.delete(latest.action);
      return next;
    });
    const existingTimer = pendingTimersRef.current.get(latest.action);
    if (existingTimer) {
      clearTimeout(existingTimer);
      pendingTimersRef.current.delete(latest.action);
    }
  }, [history]);

  const handleSend = async (action: string, params?: Record<string, any>) => {
    setPendingActions((prev) => {
      const next = new Set(prev);
      next.add(action);
      return next;
    });
    setPendingMeta((prev) => {
      const next = new Map(prev);
      next.set(action, { state: "pending" });
      return next;
    });
    try {
      const result = await sendFlightCommand(action, params);
      if (result && result.success === false) {
        setPendingMeta((prev) => {
          const next = new Map(prev);
          next.set(action, {
            state: "error",
            message: result.error || "Bridge rejected command",
          });
          return next;
        });
        setPendingActions((prev) => {
          if (!prev.has(action)) return prev;
          const next = new Set(prev);
          next.delete(action);
          return next;
        });
      }
    } catch (error) {
      setPendingMeta((prev) => {
        const next = new Map(prev);
        next.set(action, {
          state: "error",
          message: error instanceof Error ? error.message : "Command failed",
        });
        return next;
      });
      setPendingActions((prev) => {
        if (!prev.has(action)) return prev;
        const next = new Set(prev);
        next.delete(action);
        return next;
      });
    } finally {
      const previousTimer = pendingTimersRef.current.get(action);
      if (previousTimer) {
        clearTimeout(previousTimer);
      }
      const entry = pendingMetaRef.current.get(action);
      if (!entry || entry.state !== "pending") {
        pendingTimersRef.current.delete(action);
        return;
      }
      const timer = setTimeout(() => {
        setPendingActions((prev) => {
          if (!prev.has(action)) return prev;
          const next = new Set(prev);
          next.delete(action);
          return next;
        });
        setPendingMeta((prev) => {
          const current = prev.get(action);
          if (!current || current.state !== "pending") return prev;
          const next = new Map(prev);
          next.set(action, {
            state: "timeout",
            message: "No response from bridge",
          });
          return next;
        });
        pendingTimersRef.current.delete(action);
      }, BRIDGE_RESPONSE_TIMEOUT_MS);
      pendingTimersRef.current.set(action, timer);
    }
  };

  const motorsOn = Boolean(telemetry?.motors_on);
  const flightMode = telemetry?.flight_mode ?? "Unknown";
  const gpsLevel = telemetry?.gps_signal_level ?? "–";
  const rcSignal = telemetry?.rc_signal_quality ?? null;
  const lastAck = history.length ? history[history.length - 1] : null;

  const rcText =
    rcSignal === null || rcSignal === undefined ? "–" : `${rcSignal}%`;

  const recentEvents = React.useMemo(() => {
    return [...history].reverse().slice(0, 6);
  }, [history]);

  const manualAxes = manualState.axes;
  const manualNotification = manualState.notification;
  const manualStatusClass =
    manualState.status === "active"
      ? "text-status-good"
      : manualState.status === "error" || manualState.status === "lost"
        ? "text-status-error"
        : manualState.status === "arming"
          ? "text-orange-300"
          : "text-gray-300";
  const virtualStick = manualControl.virtualStick;
  const vsStatusClass = virtualStick.enabled
    ? "text-status-good"
    : "text-status-error";
  const vsOwner = virtualStick.owner || "UNKNOWN";
  const manualLastCommand = formatRelativeTime(manualState.lastCommandMs);
  const manualAuthorityBadge =
    virtualStick.manualOverride || (vsOwner !== "APP" && vsOwner !== "UNKNOWN")
      ? "text-status-error"
      : "text-gray-300";
  const lastDiagnostic = lastAck?.diagnostics?.[0];

  return (
    <>
      <Notification
        isOpen={Boolean(manualNotification)}
        onClose={manualControl.acknowledgeNotification}
        title={
          manualNotification?.type === "kill"
            ? "Kill Switch Executed"
            : manualNotification?.type === "override"
              ? "Manual Override"
              : "Manual Control Released"
        }
        message={
          manualNotification?.message ??
          (manualNotification?.type === "kill"
            ? "Manual control terminated and virtual stick disabled."
            : manualNotification?.type === "override"
              ? "Authority transferred to hardware controller."
              : "Virtual stick disabled; remote controller may fly now.")
        }
        type={
          manualNotification?.type === "kill"
            ? "error"
            : manualNotification?.type === "override"
              ? "error"
              : "info"
        }
      />
      <Panel
        title="Flight Commands"
        storageKey="flight.commands.panel"
        visibilityEventType="flightCommandsPanelVisibilityChange"
        defaultPosition={{ x: 1040, y: 340 }}
        defaultSize={{ w: 320, h: 420 }}
      >
        <div className="flex flex-col gap-4 text-xs text-gray-200 h-full overflow-y-auto">
          <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
            <div className="flex justify-between text-[11px] uppercase text-gray-400 mb-1">
              <span>Status</span>
              <span>{new Date().toLocaleTimeString()}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
              <div>
                Motors:{" "}
                <span
                  className={motorsOn ? "text-status-good" : "text-gray-300"}
                >
                  {motorsOn ? "ON" : "OFF"}
                </span>
              </div>
              <div>
                Mode: <span className="text-white">{flightMode}</span>
              </div>
              <div>Alt AGL: {formatAltitude(telemetry?.altitude)}</div>
              <div>
                Alt TO: {formatAltitude(telemetry?.altitude_above_takeoff)}
              </div>
              <div>Ground Speed: {formatSpeed(telemetry?.speed)}</div>
              <div>GPS: {gpsLevel}</div>
              <div>RC Signal: {rcText}</div>
              <div>
                Distance Home: {formatAltitude(telemetry?.distance_to_home)}
              </div>
            </div>
            {lastAck && (
              <div className="mt-2 text-[11px]">
                <span className="text-gray-400 uppercase">Last Command:</span>
                <span className="ml-2 text-white">{lastAck.action}</span>
                <span
                  className={`ml-2 ${lastAck.status === "ok" ? "text-status-good" : "text-status-error"}`}
                >
                  {lastAck.status.toUpperCase()}
                </span>
                {(lastAck.error_message || lastAck.message) && (
                  <span className="ml-2 text-status-error">
                    {lastAck.error_message || lastAck.message}
                  </span>
                )}
                {lastDiagnostic && (
                  <div
                    className={`mt-1 ${diagnosticLevelClass(lastDiagnostic.level)} leading-tight`}
                  >
                    {summarizeDiagnostic(lastDiagnostic)}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="glass-panel border border-gray-700/60 rounded-md px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-gray-400 uppercase text-[11px]">
                Manual Control
              </div>
              <div className={`text-[11px] font-semibold ${manualStatusClass}`}>
                {manualState.status.toUpperCase()}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-gray-200">
              <div>
                Virtual Stick:{" "}
                <span className={vsStatusClass}>
                  {virtualStick.enabled ? "ENABLED" : "DISABLED"}
                </span>
              </div>
              <div>
                Authority:{" "}
                <span className={manualAuthorityBadge}>{vsOwner}</span>
              </div>
              <div>
                Last Command:{" "}
                <span className="text-gray-300">{manualLastCommand} ago</span>
              </div>
              <div>
                Reason:{" "}
                <span className="text-gray-300">
                  {virtualStick.changeReason}
                </span>
              </div>
              <div>
                Pitch:{" "}
                <span className="text-gray-200">
                  {formatAxisPercent(manualAxes.pitch)}
                </span>
              </div>
              <div>
                Roll:{" "}
                <span className="text-gray-200">
                  {formatAxisPercent(manualAxes.roll)}
                </span>
              </div>
              <div>
                Throttle:{" "}
                <span className="text-gray-200">
                  {formatAxisPercent(manualAxes.throttle)}
                </span>
              </div>
              <div>
                Yaw:{" "}
                <span className="text-gray-200">
                  {formatAxisPercent(manualAxes.yaw)}
                </span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <button
                className={toneClass.primary}
                onClick={manualControl.start}
                disabled={manualState.active || manualState.status === "arming"}
              >
                {manualState.status === "arming"
                  ? "Enabling…"
                  : "Start Keyboard"}
              </button>
              <button
                className={toneClass.primary}
                onClick={manualControl.stop}
                disabled={
                  !manualState.active && manualState.status !== "arming"
                }
              >
                Release Control
              </button>
              <button className={toneClass.danger} onClick={manualControl.kill}>
                Kill Switch (ESC)
              </button>
              {manualControl.pointerLockSupported && (
                <button
                  className={toneClass.primary}
                  onClick={manualControl.togglePointerLock}
                  disabled={!manualState.active}
                >
                  {manualState.pointerLocked
                    ? "Release Mouse Yaw"
                    : "Capture Mouse Yaw"}
                </button>
              )}
            </div>
            {virtualStick.manualOverride && (
              <div className="mt-2 text-[11px] text-status-error">
                Manual override detected – hardware controller has authority.
              </div>
            )}
            {manualState.error && (
              <div className="mt-2 text-[11px] text-status-error">
                {manualState.error}
              </div>
            )}
            <div className="mt-2 text-[11px] text-gray-400 leading-tight">
              Bindings: <span className="text-gray-300">WASD</span> pitch/roll,{" "}
              <span className="text-gray-300">
                Space / Shift or Arrow Up/Down
              </span>{" "}
              vertical,{" "}
              <span className="text-gray-300">Q/E or Arrow Left/Right</span>{" "}
              yaw, mouse yaw when captured,{" "}
              <span className="text-gray-300">Esc</span> triggers the kill
              switch (zeros sticks and disables virtual stick in
              &lt;200&nbsp;ms).
            </div>
          </section>

          {COMMAND_GROUPS.map((group) => (
            <section key={group.title}>
              <div className="text-gray-400 uppercase text-[11px] mb-1">
                {group.title}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {group.commands.map((command) => (
                  <CommandButton
                    key={command.action}
                    spec={command}
                    telemetry={telemetry}
                    acknowledgements={acknowledgements}
                    isPending={pendingActions.has(command.action)}
                    pendingMeta={pendingMeta.get(command.action)}
                    onSend={handleSend}
                  />
                ))}
              </div>
            </section>
          ))}

          <section>
            <div className="text-gray-400 uppercase text-[11px] mb-1">
              Recent Responses
            </div>
            <div className="bg-black/50 border border-gray-700 rounded-md px-2 py-2 flex flex-col gap-1">
              {recentEvents.length === 0 && (
                <div className="text-gray-500 text-[11px]">
                  No command responses yet.
                </div>
              )}
              {recentEvents.map((event) => (
                <div
                  key={`${event.timestamp}-${event.action}`}
                  className="flex justify-between items-start text-[11px]"
                >
                  <div>
                    <div className="text-white capitalize">
                      {event.action.replace(/_/g, " ")}
                    </div>
                    <div
                      className={
                        event.error_message || event.status === "error"
                          ? "text-status-error"
                          : "text-gray-400"
                      }
                    >
                      {event.error_message ||
                        event.message ||
                        (event.status === "error"
                          ? "Bridge reported failure (no message)"
                          : "—")}
                    </div>
                    {event.diagnostics && event.diagnostics.length > 0 && (
                      <div className="mt-1 flex flex-col gap-0.5">
                        {event.diagnostics.slice(0, 2).map((diag, idx) => (
                          <div
                            key={`${event.timestamp}-diag-${idx}`}
                            className={`text-[10px] leading-tight ${diagnosticLevelClass(diag.level)}`}
                          >
                            {summarizeDiagnostic(diag)}
                          </div>
                        ))}
                      </div>
                    )}
                    {event.device_status && (
                      <div className="text-[10px] text-gray-400 mt-1 leading-tight">
                        Status:{" "}
                        <span
                          className={diagnosticLevelClass(
                            event.device_status.level,
                          )}
                        >
                          {event.device_status.label ||
                            event.device_status.code ||
                            "Device"}
                        </span>
                        {event.device_status.description && (
                          <span className="text-gray-400">
                            {" "}
                            — {event.device_status.description}
                          </span>
                        )}
                      </div>
                    )}
                    {event.landing_monitor && (
                      <div className="text-[10px] text-status-error mt-1 leading-tight">
                        Monitor: motors{" "}
                        {event.landing_monitor.motors_on ? "ON" : "OFF"};
                        {typeof event.landing_monitor.altitude === "number" &&
                          ` alt ${event.landing_monitor.altitude.toFixed(1)}m;`}
                        {typeof event.landing_monitor.elapsed_ms === "number" &&
                          ` ${(event.landing_monitor.elapsed_ms / 1000).toFixed(1)}s elapsed`}
                      </div>
                    )}
                  </div>
                  <div
                    className={
                      event.status === "ok"
                        ? "text-status-good"
                        : event.status === "error"
                          ? "text-status-error"
                          : "text-gray-400"
                    }
                  >
                    {event.status.toUpperCase()}
                    <br />
                    <span className="text-gray-500">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
              {[...pendingMeta.entries()]
                .filter(([, meta]) => meta.state !== undefined)
                .map(([action, meta]) => (
                  <div
                    key={`pending-${action}`}
                    className="flex justify-between items-start text-[11px]"
                  >
                    <div>
                      <div className="text-white capitalize">
                        {action.replace(/_/g, " ")}
                      </div>
                      <div
                        className={
                          meta.state === "pending"
                            ? "text-gray-400"
                            : "text-status-error"
                        }
                      >
                        {meta.message ??
                          (meta.state === "pending"
                            ? "Awaiting bridge response…"
                            : "No response from bridge")}
                      </div>
                    </div>
                    <div
                      className={
                        meta.state === "pending"
                          ? "text-gray-400"
                          : "text-status-error"
                      }
                    >
                      {meta.state === "pending" ? "PENDING" : "FAILED"}
                    </div>
                  </div>
                ))}
            </div>
          </section>
        </div>
      </Panel>
    </>
  );
};
