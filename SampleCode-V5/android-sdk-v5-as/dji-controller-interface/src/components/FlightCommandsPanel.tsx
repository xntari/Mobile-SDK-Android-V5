import React from "react";
import { Panel } from "./Panel";
import { CollapsibleSection, SectionLabel } from "./CollapsibleSection";
import {
  TelemetryData,
  FlightCommandAck,
  ControllerData,
  TelemetryDiagnosticEntry,
  WaypointStatusTelemetry,
  WaypointTimelineEntry,
} from "../types";
import { useBridgeCommands } from "../hooks/useBridgeCommands";
import { useManualControl } from "../context/ManualControlContext";
import { Notification } from "./Modal";
import { SimulatorControls } from "./SimulatorControls";

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
        isDisabled: (telemetry) => !telemetry?.is_auto_landing,
      },
      {
        action: "confirm_landing",
        label: "Confirm Landing",
        tone: "success",
        isDisabled: (telemetry) => !telemetry?.is_auto_landing,
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
        isDisabled: (telemetry) => {
          if (!telemetry) return true;
          if (!telemetry.motors_on) return true;
          return !(
            telemetry.is_auto_landing || telemetry.is_auto_returning_home
          );
        },
      },
      {
        action: "force_land_stop",
        label: "Abort Force",
        tone: "danger",
        isDisabled: (telemetry) => !telemetry?.is_auto_landing,
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
        isDisabled: (telemetry) =>
          !!telemetry?.is_auto_returning_home || telemetry?.motors_on === false,
      },
      {
        action: "return_home_stop",
        label: "Stop RTH",
        tone: "danger",
        isDisabled: (telemetry) => !telemetry?.is_auto_returning_home,
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

const MOUSE_YAW_MIN = 1 / 800;
const MOUSE_YAW_MAX = 1 / 120;
const DEFAULT_MOUSE_YAW = 1 / 300;
type SensitivityChoice = "precision" | "normal" | "aggressive";

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

const formatMargin = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value === 0) return "0.0 m";
  const sign = value > 0 ? "+" : "-";
  return `${sign}${Math.abs(value).toFixed(1)} m`;
};

const marginClassName = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "text-gray-400";
  if (value < 0) return "text-status-error";
  if (value < 1) return "text-yellow-300";
  return "text-status-good";
};

const formatMissionState = (state?: string) => {
  if (!state) return "IDLE";
  return state.replace(/_/g, " ").toUpperCase();
};

const missionStateClass = (state?: string) => {
  if (!state) return "text-gray-400";
  const normalized = state.toLowerCase();
  if (normalized.includes("error") || normalized.includes("interrupt")) {
    return "text-status-error";
  }
  if (normalized === "executing" || normalized === "flying") {
    return "text-status-good";
  }
  if (normalized === "paused" || normalized === "prepare") {
    return "text-yellow-300";
  }
  return "text-gray-300";
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
  const [exportFeedback, setExportFeedback] = React.useState<
    { type: "success" | "error"; message: string } | null
  >(null);
  const [flySafeNotification, setFlySafeNotification] = React.useState<
    { title: string; message: string } | null
  >(null);
  const lastFlySafeTimestampRef = React.useRef<number | null>(null);

  const handleExport = React.useCallback(
    (format: "csv" | "json") => {
      try {
        manualControl.exportSessionLog(format);
        setExportFeedback({
          type: "success",
          message:
            format === "csv"
              ? "Manual session CSV downloaded."
              : "Manual session JSON downloaded.",
        });
      } catch (error) {
        setExportFeedback({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to export manual session data",
        });
      }
    },
    [manualControl],
  );

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
    if (!history.length) return;
    const latest = history[history.length - 1];
    if (!latest || typeof latest.timestamp !== "number") return;
    if (lastFlySafeTimestampRef.current === latest.timestamp) return;
    const status = (latest.status || "").toLowerCase();
    if (status !== "error") return;

    const warning = latest.fly_safe?.warning_notification;
    const deviceStatusLabel =
      latest.device_status?.label || latest.device_status?.code || "";
    const deviceDescription = latest.device_status?.description;

    const isNFZDeviceStatus = deviceStatusLabel
      .toUpperCase()
      .includes("NFZ");

    if (!warning && !isNFZDeviceStatus) {
      return;
    }

    lastFlySafeTimestampRef.current = latest.timestamp;

    const parts: string[] = [];
    if (warning) {
      if (warning.description) {
        parts.push(warning.description);
      } else if (warning.event) {
        parts.push(warning.event.replace(/_/g, " "));
      }
      if (typeof warning.height_limit === "number") {
        parts.push(`Height limit ${warning.height_limit.toFixed(1)} m`);
      }
    } else if (deviceStatusLabel) {
      parts.push(deviceStatusLabel.replace(/_/g, " "));
    }

    if (deviceDescription && (!warning || deviceDescription !== warning.description)) {
      parts.push(deviceDescription);
    }

    const errorMessage = latest.error_message || latest.message;
    if (errorMessage) {
      parts.push(errorMessage);
    }

    const guidance =
      "Reduce target altitude or relocate outside the restricted bubble before retrying.";
    if (!parts.includes(guidance)) {
      parts.push(guidance);
    }

    setFlySafeNotification({
      title: "FlySafe Restriction",
      message: parts.join(" · "),
    });
  }, [history]);

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
  const flightModeRaw =
    telemetry?.flight_mode ?? telemetry?.flight_mode_label ?? "UNKNOWN";
  const flightMode = flightModeRaw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown";
  const gpsLevel = telemetry?.gps_signal_level ?? "–";
  const rcSignal = telemetry?.rc_signal_quality ?? null;
  const lastAck = history.length ? history[history.length - 1] : null;
  const autoLanding = Boolean(telemetry?.is_auto_landing);
  const autoReturn = Boolean(telemetry?.is_auto_returning_home);
  const autoModeLabel = autoLanding
    ? "Landing"
    : autoReturn
      ? "Return Home"
      : "—";

  const rcText =
    rcSignal === null || rcSignal === undefined ? "–" : `${rcSignal}%`;

  const recentEvents = React.useMemo(() => {
    return [...history].reverse().slice(0, 6);
  }, [history]);

  const renderFlyToContext = React.useCallback(
    (ctx?: FlightCommandAck["fly_to_context"]) => {
      if (!ctx) return null;
      const lines: React.ReactNode[] = [];
      const isNumber = (value: unknown): value is number =>
        typeof value === "number" && !Number.isNaN(value as number);

      if (typeof ctx.mode === "string") {
        lines.push(
          <div key="mode">
            Mode {ctx.mode}
          </div>,
        );
      }

      if (isNumber(ctx.requested_height)) {
        lines.push(
          <div key="requested-height">
            Requested height {ctx.requested_height.toFixed(1)} m
          </div>,
        );
      }

      if (isNumber(ctx.security_takeoff_height)) {
        lines.push(
          <div key="sth">
            Security take-off {ctx.security_takeoff_height.toFixed(1)} m
          </div>,
        );
      }

      if (ctx.altitude_specified === false) {
        lines.push(
          <div key="altitude-specified" className="text-yellow-200">
            Altitude not specified; aircraft should maintain current height.
          </div>,
        );
      }

      if (isNumber(ctx.current_altitude_agl) || isNumber(ctx.current_altitude_ultrasonic)) {
        const parts: string[] = [];
        if (isNumber(ctx.current_altitude_agl)) {
          parts.push(`AGL ${ctx.current_altitude_agl.toFixed(1)} m`);
        }
        if (isNumber(ctx.current_altitude_ultrasonic)) {
          parts.push(`Ultrasonic ${ctx.current_altitude_ultrasonic.toFixed(1)} m`);
        }
        if (parts.length) {
          lines.push(
            <div key="current">
              Current {parts.join(" | ")}
            </div>,
          );
        }
      }

      if (isNumber(ctx.target_altitude_relative_takeoff)) {
        const relative = formatMargin(ctx.target_altitude_relative_takeoff) ?? "–";
        lines.push(
          <div key="target">
            Target ΔTO <span className="text-gray-200">{relative}</span>
            {isNumber(ctx.target_altitude_margin_from_current) && (
              <span
                className={`ml-1 ${marginClassName(ctx.target_altitude_margin_from_current)}`}
              >
                vs now {formatMargin(ctx.target_altitude_margin_from_current)}
              </span>
            )}
          </div>,
        );
      }

      if (
        isNumber(ctx.target_altitude_asl) &&
        ctx.altitude_specified !== false
      ) {
        lines.push(
          <div key="target-asl">
            Target ASL {ctx.target_altitude_asl.toFixed(1)} m
          </div>,
        );
      }

      if (
        isNumber(ctx.takeoff_altitude_asl) &&
        isNumber(ctx.target_altitude_asl) &&
        ctx.altitude_specified !== false
      ) {
        lines.push(
          <div key="takeoff-asl">
            Takeoff ASL {ctx.takeoff_altitude_asl.toFixed(1)} m
          </div>,
        );
      }

      if (isNumber(ctx.height_limit_setting)) {
        const marginText = formatMargin(ctx.height_limit_margin);
        lines.push(
          <div key="height-limit">
            Height limit {ctx.height_limit_setting.toFixed(1)} m
            {marginText && (
              <span
                className={`ml-1 ${marginClassName(ctx.height_limit_margin)}`}
              >
                ({marginText})
              </span>
            )}
          </div>,
        );
      }

      if (isNumber(ctx.fly_safe_height_limit)) {
        const marginText = formatMargin(ctx.fly_safe_margin);
        lines.push(
          <div key="fly-safe">
            FlySafe limit {ctx.fly_safe_height_limit.toFixed(1)} m
            {marginText && (
              <span
                className={`ml-1 ${marginClassName(ctx.fly_safe_margin)}`}
              >
                ({marginText})
              </span>
            )}
            {ctx.fly_safe_warning_description && (
              <span className="ml-1 text-yellow-200">
                {ctx.fly_safe_warning_description}
              </span>
            )}
            {!ctx.fly_safe_warning_description && ctx.fly_safe_warning_event && (
              <span className="ml-1 text-yellow-200">
                {ctx.fly_safe_warning_event}
              </span>
            )}
          </div>,
        );
      } else if (ctx.fly_safe_warning_description) {
        lines.push(
          <div key="fly-safe-desc" className="text-yellow-200">
            {ctx.fly_safe_warning_description}
          </div>,
        );
      }

      if (ctx.likely_height_limit_violation) {
        lines.push(
          <div key="height-limit-violation" className="text-status-error">
            Requested altitude exceeds configured height limit.
          </div>,
        );
      }

      if (ctx.likely_fly_safe_violation) {
        lines.push(
          <div key="fly-safe-violation" className="text-status-error">
            Requested altitude exceeds FlySafe warning height.
          </div>,
        );
      }

      if (!lines.length) return null;

      return (
        <div className="mt-1 text-[10px] text-gray-300 leading-tight space-y-0.25">
          {lines}
        </div>
      );
    },
    [],
  );

  const renderFlyToSteps = React.useCallback(
    (steps?: FlightCommandAck["fly_to_param_steps"]) => {
      if (!steps || steps.length === 0) return null;
      return (
        <div className="mt-1 text-[10px] text-gray-400 leading-tight">
          Param updates:
          {steps.map((step, index) => {
            const status = step.status?.toLowerCase();
            const statusClass =
              status === "failed"
                ? "text-status-error"
                : status === "ok"
                  ? "text-status-good"
                  : "text-gray-400";
            return (
              <div key={`${index}-${step.type ?? 'step'}`} className={statusClass}>
                {(step.type ?? `step ${index + 1}`) + ':'}{' '}
                {(step.status ?? 'unknown').toUpperCase()}
                {step.message && (
                  <span className="text-gray-400"> — {step.message}</span>
                )}
              </div>
            );
          })}
        </div>
      );
    },
    [],
  );

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
  const manualSensitivity = manualControl.sensitivity;
  const mouseYawSensitivity = manualControl.mouseYawSensitivity;
  const mouseYawRatio = mouseYawSensitivity / DEFAULT_MOUSE_YAW;
  const sensitivityOptions: Array<{ value: SensitivityChoice; label: string; hint: string }> = [
    { value: "precision", label: "Precision", hint: "Tight indoor tuning" },
    { value: "normal", label: "Normal", hint: "Balanced response" },
    { value: "aggressive", label: "Aggressive", hint: "Fast stick response" },
  ];
  const presetButtonClass = (value: SensitivityChoice) =>
    manualSensitivity === value
      ? "flex-1 rounded border border-status-good/60 bg-status-good/20 text-status-good font-semibold"
      : "flex-1 rounded border border-gray-700 bg-gray-800/40 text-gray-300 hover:bg-gray-700/60";
  const lastDiagnostic = lastAck?.diagnostics?.[0];
  const lastFlySafeWarning = lastAck?.fly_safe?.warning_notification;
  const flyToContext = lastAck?.fly_to_context;
  const waypointStatus = telemetry?.waypoint_status;
  const missionTimeline = (waypointStatus?.timeline ?? []) as WaypointTimelineEntry[];
  const latestMissionState = [...missionTimeline].reverse().find((entry) => entry.type === 'state');
  const missionStateRaw = latestMissionState?.state ?? waypointStatus?.state;
  const missionStateLabel = latestMissionState?.label ?? formatMissionState(missionStateRaw);
  const missionStateBadge = missionStateClass(missionStateRaw);
  const missionId = waypointStatus?.mission_id;
  const missionPath = waypointStatus?.mission_path;
  const missionTimestamp = waypointStatus?.timestamp
    ? `${formatRelativeTime(waypointStatus.timestamp)} ago`
    : null;
  const missionExecuting = waypointStatus?.executing;
  const missionInterrupt = waypointStatus?.last_interrupt;
  const missionBackend = waypointStatus?.backend;
  const missionStateNormalized = missionStateRaw?.toLowerCase() ?? '';
  const missionActive = Boolean(
    missionStateRaw &&
      !["ready", "finished", "idle", "not_supported", "unknown"].includes(
        missionStateNormalized,
      ),
  );
  const latestPauseEvent = [...missionTimeline].reverse().find((entry) => entry.type === 'event' && entry.event === 'pause');
  const latestResumeEvent = [...missionTimeline].reverse().find((entry) => entry.type === 'event' && entry.event === 'resume');
  const pauseTimestamp = latestPauseEvent?.timestamp ?? 0;
  const resumeTimestamp = latestResumeEvent?.timestamp ?? 0;
  const pausedByEvent = Boolean(latestPauseEvent && pauseTimestamp >= resumeTimestamp);
  const missionPaused = pausedByEvent || missionStateNormalized === 'interrupted';
  const canResumeMission = missionPaused;
  const canPauseMission = missionActive && !missionPaused;
  const canStopMission = missionActive;
  const missionTimelineDisplay = [...missionTimeline].slice(-5).reverse();
  const missionTimelineTooltip = React.useCallback((entry: WaypointTimelineEntry, fallback: string) => {
    if ('reason' in entry && typeof entry.reason === 'string' && entry.reason) {
      return entry.reason.replace(/_/g, ' ');
    }
    if ('pause_reason' in entry && typeof entry.pause_reason === 'string' && entry.pause_reason) {
      return entry.pause_reason.replace(/_/g, ' ');
    }
    if ('resume_reason' in entry && typeof entry.resume_reason === 'string' && entry.resume_reason) {
      return entry.resume_reason.replace(/_/g, ' ');
    }
    if ('exit_reason' in entry && typeof entry.exit_reason === 'string' && entry.exit_reason) {
      return entry.exit_reason.replace(/_/g, ' ');
    }
    if ('error' in entry && entry.error?.description) {
      return entry.error.description;
    }
    return fallback;
  }, []);

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
      <Notification
        isOpen={Boolean(flySafeNotification)}
        onClose={() => setFlySafeNotification(null)}
        title={flySafeNotification?.title ?? "FlySafe Restriction"}
        message={flySafeNotification?.message ?? ""}
        type="error"
      />
      <Notification
        isOpen={Boolean(exportFeedback)}
        onClose={() => setExportFeedback(null)}
        title={
          exportFeedback?.type === "error"
            ? "Export Failed"
            : "Session Exported"
        }
        message={exportFeedback?.message ?? ""}
        type={exportFeedback?.type === "error" ? "error" : "success"}
      />
      <Panel
        title="Flight Commands"
        storageKey="flight.commands.panel"
        visibilityEventType="flightCommandsPanelVisibilityChange"
        defaultPosition={{ x: 1040, y: 340 }}
        defaultSize={{ w: 320, h: 420 }}
      >
        <div className="space-y-3 text-xs h-full overflow-y-auto pr-1">
          <CollapsibleSection
            title="Simulator"
            storageKey="flightCommands.section.simulator"
            defaultOpen={false}
          >
            <SimulatorControls
              telemetry={telemetry}
              onSend={handleSend}
              pendingActions={pendingActions}
              pendingMeta={pendingMeta}
              acknowledgements={acknowledgements}
            />
          </CollapsibleSection>
          <CollapsibleSection
            title="Flight Status"
            storageKey="flightCommands.section.status"
          >
            <div className="flex items-center justify-between text-[11px] uppercase text-gray-400">
              <span>Status snapshot</span>
              <span>{new Date().toLocaleTimeString()}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-gray-200">
              <div>
                Motors: <span className={motorsOn ? "text-status-good" : "text-gray-300"}>{motorsOn ? "ON" : "OFF"}</span>
              </div>
              <div>
                Mode: <span className="text-gray-100">{flightMode}</span>
              </div>
              <div>
                Auto Mode: <span className="text-gray-100">{autoModeLabel}</span>
              </div>
              <div>Alt AGL: {formatAltitude(telemetry?.altitude)}</div>
              <div>Alt TO: {formatAltitude(telemetry?.altitude_above_takeoff)}</div>
              <div>Ground Speed: {formatSpeed(telemetry?.speed)}</div>
              <div>GPS: {gpsLevel}</div>
              <div>RC Signal: {rcText}</div>
              <div>Distance Home: {formatAltitude(telemetry?.distance_to_home)}</div>
            </div>
            {lastAck && (
              <div className="mt-2 space-y-1 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-gray-400 uppercase">Last Command</span>
                  <span className="text-gray-100">{lastAck.action}</span>
                  <span className={lastAck.status === "ok" ? "text-status-good" : "text-status-error"}>
                    {lastAck.status.toUpperCase()}
                  </span>
                  {(lastAck.error_message || lastAck.message) && (
                    <span className="text-status-error">{lastAck.error_message || lastAck.message}</span>
                  )}
                </div>
                {lastDiagnostic && (
                  <div className={`${diagnosticLevelClass(lastDiagnostic.level)} leading-tight`}>
                    {summarizeDiagnostic(lastDiagnostic)}
                  </div>
                )}
                {(lastAck.error_type || lastAck.error_code || lastAck.error_domain) && (
                  <div className="text-[10px] text-status-error leading-tight">
                    {lastAck.error_type && <span>{lastAck.error_type}</span>}
                    {lastAck.error_code && (
                      <span>{lastAck.error_type ? " · " : ""}code {lastAck.error_code}</span>
                    )}
                    {typeof lastAck.error_code_value === "number" && (
                      <span> (0x{lastAck.error_code_value.toString(16).toUpperCase()})</span>
                    )}
                    {lastAck.error_domain && (
                      <span> — {lastAck.error_domain}</span>
                    )}
                  </div>
                )}
                {lastAck.target_location && (
                  <div className="text-[10px] text-gray-400 leading-tight">
                    Target: lat {typeof lastAck.target_location.latitude === "number" ? lastAck.target_location.latitude.toFixed(6) : "—"} · lon {typeof lastAck.target_location.longitude === "number" ? lastAck.target_location.longitude.toFixed(6) : "—"}
                    {typeof lastAck.target_location.altitude === "number" && (
                      <span> · alt {lastAck.target_location.altitude.toFixed(1)} m</span>
                    )}
                  </div>
                )}
                {lastAck.max_speed !== undefined && (
                  <div className="text-[10px] text-gray-400 leading-tight">
                    Max speed {lastAck.max_speed.toFixed(1)} m/s
                  </div>
                )}
                {lastFlySafeWarning && (
                  <div className="text-[10px] text-yellow-300 leading-tight">
                    FlySafe: {lastFlySafeWarning.description || lastFlySafeWarning.event}
                    {typeof lastFlySafeWarning.height_limit === "number" && (
                      <span> · limit {lastFlySafeWarning.height_limit.toFixed(1)} m</span>
                    )}
                  </div>
                )}
                {renderFlyToContext(flyToContext)}
                {lastAck.fly_to_param_update && (
                  <div className="text-[10px] text-gray-300 leading-tight">
                    Param update: {lastAck.fly_to_param_update}
                    {lastAck.fly_to_param_message && (
                      <span className="text-gray-400"> — {lastAck.fly_to_param_message}</span>
                    )}
                  </div>
                )}
                {lastAck.fly_to_param_error && (
                  <div className="text-[10px] text-status-error leading-tight">
                    Param error: {lastAck.fly_to_param_error}
                  </div>
                )}
                {renderFlyToSteps(lastAck.fly_to_param_steps)}
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title="Waypoint Mission"
            storageKey="flightCommands.section.waypoint"
          >
            <div className="flex items-center justify-between">
              <SectionLabel label="Mission" />
              <span className={`text-[11px] font-semibold ${missionStateBadge}`}>
                {missionStateLabel}
              </span>
            </div>
            <div className="text-[11px] text-gray-300 space-y-1">
              <div>
                Backend: <span className="text-gray-200">{missionBackend ?? "—"}</span>
              </div>
              <div>
                Mission ID: <span className="text-gray-200">{missionId ?? "—"}</span>
              </div>
              <div>
                Waypoint: <span className="text-gray-200">{typeof missionExecuting?.current_waypoint_index === "number" ? `#${missionExecuting.current_waypoint_index}` : "—"}</span>
                {typeof missionExecuting?.wayline_id === "number" && (
                  <span className="ml-1 text-gray-400">(Wayline {missionExecuting.wayline_id})</span>
                )}
              </div>
              <div>Updated: <span className="text-gray-200">{missionTimestamp ?? "–"}</span></div>
              {missionInterrupt?.description && (
                <div className="text-status-error">
                  Interrupt: {missionInterrupt.description}
                  {missionInterrupt.code && (
                    <span className="text-gray-400"> ({missionInterrupt.code})</span>
                  )}
                </div>
              )}
              {missionPath && (
                <div className="text-[10px] text-gray-400 leading-tight">
                  KMZ: <span className="text-gray-300" title={missionPath}>{missionPath}</span>
                </div>
              )}
            </div>
            {missionTimelineDisplay.length > 0 && (
              <div className="pt-2 border-t border-gray-800 space-y-1 text-[10px] text-gray-400 max-h-24 overflow-y-auto">
                {missionTimelineDisplay.map((entry, idx) => {
                  const fallbackLabel = entry.type === 'state'
                    ? formatMissionState(entry.state)
                    : entry.type === 'executing' && entry.execute_state
                      ? entry.execute_state.replace(/_/g, ' ').toUpperCase()
                      : entry.type.toUpperCase();
                  const entryLabel = entry.label ?? fallbackLabel;
                  const entryTime = entry.timestamp ? `${formatRelativeTime(entry.timestamp)} ago` : '–';
                  return (
                    <div
                      key={`${entry.type}-${idx}`}
                      className="flex items-center justify-between gap-2"
                      title={missionTimelineTooltip(entry, entryLabel)}
                    >
                      <span className="text-gray-200">{entryLabel}</span>
                      <span className="text-gray-500">{entryTime}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                className={`${toneClass.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                onClick={() => handleSend("waypoint_pause")}
                disabled={!canPauseMission}
              >
                Pause
              </button>
              <button
                type="button"
                className={`${toneClass.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                onClick={() => handleSend("waypoint_resume")}
                disabled={!canResumeMission}
              >
                Resume
              </button>
              <button
                type="button"
                className={`${toneClass.danger} disabled:opacity-40 disabled:cursor-not-allowed`}
                onClick={() => handleSend("waypoint_stop")}
                disabled={!canStopMission}
              >
                Stop Mission
              </button>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Manual Control"
            storageKey="flightCommands.section.manual"
          >
            <div className="flex items-center justify-between">
              <SectionLabel label="Virtual Stick" />
              <span className={`text-[11px] font-semibold ${manualStatusClass}`}>
                {manualState.status.toUpperCase()}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-gray-200">
              <div>
                Virtual Stick: <span className={vsStatusClass}>{virtualStick.enabled ? "ENABLED" : "DISABLED"}</span>
              </div>
              <div>
                Authority: <span className={manualAuthorityBadge}>{vsOwner}</span>
              </div>
              <div>Last Command: <span className="text-gray-300">{manualLastCommand} ago</span></div>
              <div>Reason: <span className="text-gray-300">{virtualStick.changeReason}</span></div>
              <div>Pitch: {formatAxisPercent(manualAxes.pitch)}</div>
              <div>Roll: {formatAxisPercent(manualAxes.roll)}</div>
              <div>Throttle: {formatAxisPercent(manualAxes.throttle)}</div>
              <div>Yaw: {formatAxisPercent(manualAxes.yaw)}</div>
            </div>
            <div className="space-y-3 mt-3">
              <div>
                <div className="flex items-center justify-between text-[11px] uppercase text-gray-400">
                  <span>Sensitivity Preset</span>
                  <span className="text-gray-300">{manualSensitivity.toUpperCase()}</span>
                </div>
                <div className="mt-1 flex gap-1">
                  {sensitivityOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`${presetButtonClass(option.value)} py-1 px-2 text-[11px] uppercase tracking-wide transition-colors`}
                      onClick={() => manualControl.setSensitivity(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                  {sensitivityOptions.find((opt) => opt.value === manualSensitivity)?.hint}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] uppercase text-gray-400">
                  <span>Mouse Yaw Gain</span>
                  <span className="text-gray-300">
                    {mouseYawSensitivity.toFixed(4)} ({mouseYawRatio.toFixed(2)}x)
                  </span>
                </div>
                <input
                  type="range"
                  min={MOUSE_YAW_MIN}
                  max={MOUSE_YAW_MAX}
                  step={0.0001}
                  value={mouseYawSensitivity}
                  onChange={(event) =>
                    manualControl.setMouseYawSensitivity(Number(event.target.value))
                  }
                  className="mt-1 h-2 w-full cursor-pointer appearance-none rounded bg-gray-800 accent-status-good"
                />
                <div className="mt-1 flex justify-between text-[10px] text-gray-500">
                  <span>Fine</span>
                  <span>Fast</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-[11px] uppercase text-gray-400">
                  <span>Session Export</span>
                  <span className="text-gray-300">
                    {manualControl.sessionLogAvailable ? "Ready" : "Run Session"}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={`${toneClass.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                    onClick={() => handleExport("csv")}
                    disabled={!manualControl.sessionLogAvailable}
                  >
                    Download CSV
                  </button>
                  <button
                    type="button"
                    className={`${toneClass.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                    onClick={() => handleExport("json")}
                    disabled={!manualControl.sessionLogAvailable}
                  >
                    Download JSON
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-gray-500 leading-tight">
                  Captures stick commands (~16 Hz) and key events (start, kill, overrides). Export once manual testing concludes and motors are safe.
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  className={toneClass.primary}
                  onClick={manualControl.start}
                  disabled={manualState.active || manualState.status === "arming"}
                >
                  {manualState.status === "arming" ? "Enabling…" : "Start Keyboard"}
                </button>
                <button
                  className={toneClass.primary}
                  onClick={manualControl.stop}
                  disabled={!manualState.active && manualState.status !== "arming"}
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
                    {manualState.pointerLocked ? "Release Mouse Yaw" : "Capture Mouse Yaw"}
                  </button>
                )}
              </div>

              {virtualStick.manualOverride && (
                <div className="text-[11px] text-status-error">
                  Manual override detected – hardware controller has authority.
                </div>
              )}
              {manualState.error && (
                <div className="text-[11px] text-status-error">{manualState.error}</div>
              )}
              <div className="text-[11px] text-gray-400 leading-tight">
                Bindings: <span className="text-gray-300">WASD</span> pitch/roll, <span className="text-gray-300">Space / Shift or Arrow Up/Down</span> vertical, <span className="text-gray-300">Q/E or Arrow Left/Right</span> yaw, mouse yaw when captured, <span className="text-gray-300">Esc</span> triggers the kill switch (zeros sticks and disables virtual stick in &lt;200&nbsp;ms).
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Commands"
            storageKey="flightCommands.section.commands"
          >
            <div className="space-y-3">
              {COMMAND_GROUPS.map((group) => (
                <div key={group.title} className="space-y-2">
                  <SectionLabel label={group.title} />
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
                </div>
              ))}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Recent Responses"
            storageKey="flightCommands.section.recent"
            defaultOpen={false}
          >
            <div className="flex flex-col gap-2">
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
                    {(event.error_type || event.error_code || event.error_domain) && (
                      <div className="text-[10px] text-status-error leading-tight">
                        {event.error_type && <span>{event.error_type}</span>}
                        {event.error_code && (
                          <span>
                            {event.error_type ? " · " : ""}
                            code {event.error_code}
                          </span>
                        )}
                        {typeof event.error_code_value === "number" && (
                          <span>
                            {" "}(0x{event.error_code_value.toString(16).toUpperCase()})
                          </span>
                        )}
                        {event.error_domain && (
                          <span>
                            {" "}— {event.error_domain}
                          </span>
                        )}
                      </div>
                    )}
                    {event.target_location && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        Target: lat {typeof event.target_location.latitude === "number" ? event.target_location.latitude.toFixed(6) : "—"}
                        {" "}· lon {typeof event.target_location.longitude === "number" ? event.target_location.longitude.toFixed(6) : "—"}
                        {typeof event.target_location.altitude === "number" && (
                          <span>
                            {" "}· alt {event.target_location.altitude.toFixed(1)} m
                          </span>
                        )}
                      </div>
                    )}
                    {event.max_speed !== undefined && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        Max speed {event.max_speed.toFixed(1)} m/s
                      </div>
                    )}
                    {event.fly_safe?.warning_notification && (
                      <div className="text-[10px] text-yellow-300 leading-tight">
                        FlySafe: {event.fly_safe.warning_notification.description || event.fly_safe.warning_notification.event}
                        {typeof event.fly_safe.warning_notification.height_limit === "number" && (
                          <span>
                            {" "}· limit {event.fly_safe.warning_notification.height_limit.toFixed(1)} m
                          </span>
                        )}
                      </div>
                    )}
                    {renderFlyToContext(event.fly_to_context)}
                    {event.fly_to_param_update && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        Param update: {event.fly_to_param_update}
                        {event.fly_to_param_message && (
                          <span className="text-gray-500"> — {event.fly_to_param_message}</span>
                        )}
                      </div>
                    )}
                    {event.fly_to_param_error && (
                      <div className="text-[10px] text-status-error leading-tight">
                        Param error: {event.fly_to_param_error}
                      </div>
                    )}
                    {renderFlyToSteps(event.fly_to_param_steps)}
                    {(event.backend || event.mission_id || event.mission_path) && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        {event.backend && (
                          <span className="text-gray-300">Backend {event.backend}</span>
                        )}
                        {event.mission_id && (
                          <span className="ml-1 text-gray-300">
                            Mission {event.mission_id}
                          </span>
                        )}
                        {event.mission_path && (
                          <span className="ml-1 text-gray-500" title={event.mission_path}>
                            ({event.mission_path})
                          </span>
                        )}
                      </div>
                    )}
                    {event.wayline_ids && event.wayline_ids.length > 0 && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        Waylines: {event.wayline_ids.join(', ')}
                      </div>
                    )}
                    {typeof event.auto_flight_speed === 'number' && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        Auto speed {event.auto_flight_speed.toFixed(1)} m/s
                      </div>
                    )}
                    {event.fallback_reason && (
                      <div className="text-[10px] text-gray-400 leading-tight">
                        Fallback: {event.fallback_reason}
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
          </CollapsibleSection>
        </div>
      </Panel>
    </>
  );
};
