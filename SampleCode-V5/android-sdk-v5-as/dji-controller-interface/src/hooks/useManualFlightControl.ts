import { useBridgeCommands } from "./useBridgeCommands";
import { ConnectionStatus, ControllerData } from "../types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ManualFlightControlStatus =
  | "idle"
  | "arming"
  | "active"
  | "stopping"
  | "lost"
  | "error";

interface AxisState {
  yaw: number;
  throttle: number;
  roll: number;
  pitch: number;
}

type SensitivityPreset = "precision" | "normal" | "aggressive";

const SENSITIVITY_PRESETS: Record<
  SensitivityPreset,
  { pitch: number; roll: number; throttle: number; yaw: number; mouseYaw: number }
> = {
  precision: {
    pitch: 0.35,
    roll: 0.35,
    throttle: 0.35,
    yaw: 0.3,
    mouseYaw: 1 / 450,
  },
  normal: {
    pitch: 0.6,
    roll: 0.6,
    throttle: 0.6,
    yaw: 0.5,
    mouseYaw: 1 / 300,
  },
  aggressive: {
    pitch: 0.85,
    roll: 0.85,
    throttle: 0.75,
    yaw: 0.7,
    mouseYaw: 1 / 220,
  },
};

type ManualSessionEntry =
  | {
      kind: "axes";
      timestamp: number;
      yaw: number;
      throttle: number;
      roll: number;
      pitch: number;
      status: "sent" | "rejected" | "error";
      message?: string;
    }
  | {
      kind: "event";
      timestamp: number;
      event: string;
      detail?: string;
    };

interface ManualSessionMeta {
  start?: number;
  end?: number;
  preset?: SensitivityPreset;
}

type ManualNotification = {
  type: "kill" | "override" | "release";
  message: string;
  timestamp: number;
};

interface ManualAnalytics {
  commandCount: number;
  sessionStart: number | null;
}

const createZeroAxes = (): AxisState => ({
  yaw: 0,
  throttle: 0,
  roll: 0,
  pitch: 0,
});
const AXIS_EPSILON = 0.02;
const CONTROL_TICK_MS = 60; // ~16 Hz command stream
const DEFAULT_MOUSE_YAW_SENSITIVITY = 1 / 300;
const MOUSE_YAW_DECAY = 0.65;
const DEFAULT_MOUSE_PITCH_SENSITIVITY = 1 / 300;
const MOUSE_PITCH_DECAY = 0.65;
const MOUSE_YAW_STORAGE_KEY = "manualControl.mouseYawSensitivity";
const MOUSE_YAW_MIN = 1 / 800;
const MOUSE_YAW_MAX = 1 / 120;

const KEY_GROUPS = {
  forward: ["KeyW"],
  backward: ["KeyS"],
  rollLeft: ["KeyA"],
  rollRight: ["KeyD"],
  throttleUp: ["Space", "ArrowUp", "KeyR"],
  throttleDown: [
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "ArrowDown",
    "KeyF",
    "KeyC",
  ],
  yawLeft: ["KeyQ", "ArrowLeft", "KeyZ"],
  yawRight: ["KeyE", "ArrowRight", "KeyX"],
};

const SUPPORTED_KEYS = new Set<string>(Object.values(KEY_GROUPS).flat());

const MOTOR_STICK_KEY = 'KeyK';
const MOTOR_STICK_MACRO_DURATION_MS = 1200;
const MOTOR_STICK_AXES: AxisState = {
  yaw: 1,
  throttle: -1,
  roll: -1,
  pitch: -1,
};

interface ManualFlightControlState {
  active: boolean;
  status: ManualFlightControlStatus;
  axes: AxisState;
  pointerLocked: boolean;
  lastCommandMs: number | null;
  error: string | null;
  notification: ManualNotification | null;
  analytics: ManualAnalytics;
}

interface VirtualStickSnapshot {
  enabled: boolean;
  advancedEnabled: boolean;
  owner: string;
  manualOverride: boolean;
  changeReason: string;
}

export interface ManualFlightControlHook {
  state: ManualFlightControlState;
  virtualStick: VirtualStickSnapshot;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  kill: () => Promise<void>;
  acknowledgeNotification: () => void;
  togglePointerLock: () => void;
  pointerLockSupported: boolean;
  sensitivity: SensitivityPreset;
  setSensitivity: (preset: SensitivityPreset) => void;
  mouseYawSensitivity: number;
  setMouseYawSensitivity: (value: number) => void;
  sessionLogAvailable: boolean;
  exportSessionLog: (format: "csv" | "json") => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const axesEqual = (a: AxisState, b: AxisState) =>
  Math.abs(a.yaw - b.yaw) < AXIS_EPSILON &&
  Math.abs(a.throttle - b.throttle) < AXIS_EPSILON &&
  Math.abs(a.roll - b.roll) < AXIS_EPSILON &&
  Math.abs(a.pitch - b.pitch) < AXIS_EPSILON;

const resolveOwner = (controller?: ControllerData | null) => {
  const vs = controller?.virtual_stick;
  const owner = vs?.authority_owner ?? controller?.authority_owner ?? "UNKNOWN";
  return owner.toString().toUpperCase();
};

const pointerLockAvailable = () =>
  typeof document !== "undefined" &&
  !!document.body &&
  "pointerLockElement" in document &&
  typeof document.body.requestPointerLock === "function" &&
  typeof document.exitPointerLock === "function";

export const useManualFlightControl = (
  controller: ControllerData | null | undefined,
  connectionStatus: ConnectionStatus,
): ManualFlightControlHook => {
  const { sendFlightCommand } = useBridgeCommands();
  const [state, setState] = useState<ManualFlightControlState>({
    active: false,
    status: "idle",
    axes: createZeroAxes(),
    pointerLocked: false,
    lastCommandMs: null,
    error: null,
    notification: null,
    analytics: { commandCount: 0, sessionStart: null },
  });

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const controllerRef = useRef(controller);
  useEffect(() => {
    controllerRef.current = controller;
  }, [controller]);

  const sessionLogRef = useRef<ManualSessionEntry[]>([]);
  const sessionMetaRef = useRef<ManualSessionMeta>({});
  const [sessionLogAvailable, setSessionLogAvailable] = useState(false);

  const [sensitivity, setSensitivity] = useState<SensitivityPreset>(() => {
    try {
      const raw = localStorage.getItem("manualControl.sensitivity");
      if (raw === "precision" || raw === "aggressive" || raw === "normal") {
        return raw as SensitivityPreset;
      }
    } catch {}
    return "normal";
  });
  useEffect(() => {
    try {
      localStorage.setItem("manualControl.sensitivity", sensitivity);
    } catch {}
  }, [sensitivity]);

  const readMouseYawValue = (preset: SensitivityPreset): number | null => {
    try {
      const raw = localStorage.getItem(MOUSE_YAW_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      const value = parsed?.[preset];
      return typeof value === "number" ? value : null;
    } catch {
      return null;
    }
  };

  const [mouseYawSensitivity, setMouseYawSensitivityState] = useState<number>(() => {
    const stored = readMouseYawValue(sensitivity);
    if (typeof stored === "number") {
      return clamp(stored, MOUSE_YAW_MIN, MOUSE_YAW_MAX);
    }
    const presetDefault = SENSITIVITY_PRESETS[sensitivity]?.mouseYaw;
    return clamp(presetDefault ?? DEFAULT_MOUSE_YAW_SENSITIVITY, MOUSE_YAW_MIN, MOUSE_YAW_MAX);
  });

  useEffect(() => {
    const stored = readMouseYawValue(sensitivity);
    const presetDefault = SENSITIVITY_PRESETS[sensitivity]?.mouseYaw;
    const next = clamp(
      typeof stored === "number" ? stored : presetDefault ?? DEFAULT_MOUSE_YAW_SENSITIVITY,
      MOUSE_YAW_MIN,
      MOUSE_YAW_MAX,
    );
    setMouseYawSensitivityState((prev) =>
      Math.abs(prev - next) < 1e-6 ? prev : next,
    );
  }, [sensitivity]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MOUSE_YAW_STORAGE_KEY);
      const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
      parsed[sensitivity] = mouseYawSensitivity;
      localStorage.setItem(MOUSE_YAW_STORAGE_KEY, JSON.stringify(parsed));
    } catch {}
  }, [mouseYawSensitivity, sensitivity]);

  const mouseYawSensitivityRef = useRef(mouseYawSensitivity);
  useEffect(() => {
    mouseYawSensitivityRef.current = mouseYawSensitivity;
  }, [mouseYawSensitivity]);

  const setMouseYawSensitivity = useCallback((value: number) => {
    const clamped = clamp(value, MOUSE_YAW_MIN, MOUSE_YAW_MAX);
    setMouseYawSensitivityState(clamped);
  }, []);

  const preset = useMemo(() => SENSITIVITY_PRESETS[sensitivity], [sensitivity]);

  const keysRef = useRef<Set<string>>(new Set());
  const mouseYawRef = useRef(0);
  const mousePitchRef = useRef(0);
  const lastCommandRef = useRef<number | null>(null);
  const lastOverrideEventRef = useRef<string | null>(null);
  const lastAuthorityOwnerRef = useRef<string | null>(null);
  const connectionStatusRef = useRef(connectionStatus);
  const pendingResumeRef = useRef(false);
  const bridgeLostNotifiedRef = useRef(false);
  const resumeInProgressRef = useRef(false);
  const tickRef = useRef<() => void>(() => {});
  const macroOverrideRef = useRef<{ axes: AxisState; until: number } | null>(null);

  const pointerSupported = useMemo(pointerLockAvailable, []);

  const clearSessionLog = useCallback(() => {
    sessionLogRef.current = [];
    setSessionLogAvailable(false);
  }, []);

  const recordSessionEntry = useCallback((entry: ManualSessionEntry) => {
    sessionLogRef.current.push(entry);
    setSessionLogAvailable(true);
  }, []);

  const recordSessionEvent = useCallback(
    (event: string, detail?: string) => {
      recordSessionEntry({
        kind: "event",
        timestamp: Date.now(),
        event,
        detail,
      });
    },
    [recordSessionEntry],
  );

  const exportSessionLog = useCallback(
    (format: "csv" | "json") => {
      const entries = sessionLogRef.current;
      if (!entries.length) {
        throw new Error("No manual session data available for export");
      }

      const meta = sessionMetaRef.current;
      const start = meta.start ?? entries[0]?.timestamp ?? Date.now();
      const end = meta.end ?? (stateRef.current.active ? Date.now() : meta.end);
      const preset = meta.preset ?? sensitivity;
      const commandCount = stateRef.current.analytics.commandCount;

      const startIso = new Date(start).toISOString();
      const endIso = end ? new Date(end).toISOString() : null;
      const durationMs = end ? end - start : null;

      const filenameBase = `manual-session-${startIso.replace(/[:]/g, "-")}`;

      const triggerDownload = (content: string, mime: string, extension: string) => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${filenameBase}.${extension}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      };

      if (format === "json") {
      const payload = {
          meta: {
            start_iso: startIso,
            end_iso: endIso,
            duration_ms: durationMs,
            preset,
            command_count: entries.filter((entry) => entry.kind === "axes").length,
          },
          entries,
        };
        triggerDownload(
          JSON.stringify(payload, null, 2),
          "application/json;charset=utf-8",
          "json",
        );
        recordSessionEvent("session_export_json");
        return;
      }

      const csvHeader = [
        "timestamp_iso",
        "kind",
        "yaw",
        "throttle",
        "roll",
        "pitch",
        "status",
        "message",
        "event",
        "detail",
      ];

      const escapeCsv = (value: string | number | null | undefined): string => {
        if (value === null || value === undefined) return "";
        const str = String(value);
        if (str.includes("\"") || str.includes(",") || str.includes("\n")) {
          return `"${str.replace(/\"/g, '""')}"`;
        }
        return str;
      };

      const csvRows: string[] = [
        "# Manual control session export",
        `# start_iso=${startIso}`,
        `# end_iso=${endIso ?? ""}`,
        `# duration_ms=${durationMs ?? ""}`,
        `# preset=${preset}`,
        `# command_count=${entries.filter((entry) => entry.kind === "axes").length}`,
        csvHeader.join(","),
      ];

      entries.forEach((entry) => {
        const timestampIso = new Date(entry.timestamp).toISOString();
        if (entry.kind === "axes") {
          csvRows.push(
            [
              escapeCsv(timestampIso),
              "axes",
              escapeCsv(entry.yaw.toFixed(3)),
              escapeCsv(entry.throttle.toFixed(3)),
              escapeCsv(entry.roll.toFixed(3)),
              escapeCsv(entry.pitch.toFixed(3)),
              escapeCsv(entry.status),
              escapeCsv(entry.message ?? ""),
              "",
              "",
            ].join(","),
          );
        } else {
          csvRows.push(
            [
              escapeCsv(timestampIso),
              "event",
              "",
              "",
              "",
              "",
              "",
              "",
              escapeCsv(entry.event),
              escapeCsv(entry.detail ?? ""),
            ].join(","),
          );
        }
      });

      triggerDownload(csvRows.join("\n"), "text/csv;charset=utf-8", "csv");
      recordSessionEvent("session_export_csv");
    }, [recordSessionEvent, sensitivity]);

  const createNotification = useCallback(
    (
      type: ManualNotification["type"],
      message: string,
    ): ManualNotification => ({
      type,
      message,
      timestamp: Date.now(),
    }),
    [],
  );

  const acknowledgeNotification = useCallback(() => {
    setState((prev) =>
      prev.notification
        ? {
            ...prev,
            notification: null,
          }
        : prev,
    );
  }, []);

  const computeAxisWithKeys = useCallback(
    (positive: string[], negative: string[], scale: number) => {
      const hasPositive = positive.some((code) => keysRef.current.has(code));
      const hasNegative = negative.some((code) => keysRef.current.has(code));
      const magnitude = (Number(hasPositive) - Number(hasNegative)) * scale;
      return clamp(magnitude, -scale, scale);
    },
    [],
  );

  const computeKeyAxes = useCallback(
    (): AxisState => ({
      pitch: computeAxisWithKeys(
        KEY_GROUPS.forward,
        KEY_GROUPS.backward,
        preset.pitch,
      ),
      roll: computeAxisWithKeys(
        KEY_GROUPS.rollRight,
        KEY_GROUPS.rollLeft,
        preset.roll,
      ),
      throttle: computeAxisWithKeys(
        KEY_GROUPS.throttleUp,
        KEY_GROUPS.throttleDown,
        preset.throttle,
      ),
      yaw: computeAxisWithKeys(
        KEY_GROUPS.yawRight,
        KEY_GROUPS.yawLeft,
        preset.yaw,
      ),
    }),
    [computeAxisWithKeys, preset],
  );

  const updateAxesSnapshot = useCallback(() => {
    const keyAxes = computeKeyAxes();
    const combinedYaw = clamp(keyAxes.yaw + mouseYawRef.current, -1, 1);
    const nextAxes: AxisState = {
      yaw: combinedYaw,
      throttle: clamp(keyAxes.throttle, -1, 1),
      roll: clamp(keyAxes.roll, -1, 1),
      pitch: clamp(keyAxes.pitch, -1, 1),
    };

    setState((prev) =>
      axesEqual(prev.axes, nextAxes)
        ? prev
        : {
            ...prev,
            axes: nextAxes,
          },
    );

    return nextAxes;
  }, [computeKeyAxes]);

  const cleanupSession = useCallback(
    (options?: { exitPointerLock?: boolean }) => {
      keysRef.current.clear();
      mouseYawRef.current = 0;
      mousePitchRef.current = 0;
      macroOverrideRef.current = null;

      if (
        pointerSupported &&
        options?.exitPointerLock !== false &&
        document.pointerLockElement
      ) {
        document.exitPointerLock();
      }
    },
    [pointerSupported],
  );

  const handleSendError = useCallback(
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Manual command failed";
      recordSessionEvent("command_error", message);
      sessionMetaRef.current = {
        ...sessionMetaRef.current,
        end: Date.now(),
      };
      cleanupSession({ exitPointerLock: true });
      setState((prev) => ({
        ...prev,
        active: false,
        status: "error",
        axes: createZeroAxes(),
        pointerLocked: false,
        error: message,
      }));
    },
    [cleanupSession, recordSessionEvent],
  );

  const ensureVirtualStickReady = useCallback(async () => {
    const snapshot = controllerRef.current;
    const owner = resolveOwner(snapshot);
    const manualOverride = snapshot?.virtual_stick?.manual_override ?? false;
    const enabled =
      snapshot?.virtual_stick?.enabled ?? snapshot?.virtual_stick_enabled ?? false;

    const ownerBlocked =
      manualOverride ||
      (owner && owner !== "APP" && owner !== "UNKNOWN" && owner !== "NONE");
    if (ownerBlocked) {
      recordSessionEvent("vs_enable_blocked", owner || "unknown_owner");
      throw new Error(
        `Virtual stick currently owned by ${owner || "hardware controller"}. Release RC override to continue.`,
      );
    }

    if (enabled) {
      recordSessionEvent("vs_enable_already_enabled");
      return;
    }

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        recordSessionEvent("vs_enable_attempt", `attempt=${attempt}`);
        const result = await sendFlightCommand("virtual_stick_enable");
        if (!result || result.success !== false) {
          recordSessionEvent("vs_enable_success", `attempt=${attempt}`);
          return;
        }
        lastError =
          result.error ||
          result.error_message ||
          result.message ||
          "Bridge rejected enable request";
        recordSessionEvent("vs_enable_rejected", lastError);
      } catch (error) {
        lastError =
          error instanceof Error
            ? error.message
            : "Virtual stick enable failed";
        recordSessionEvent("vs_enable_failure", lastError);
      }

      if (attempt < 3) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 180 * attempt),
        );

        const latest = controllerRef.current;
        const latestOwner = resolveOwner(latest);
        const latestManualOverride =
          latest?.virtual_stick?.manual_override ?? false;
        const latestEnabled =
          latest?.virtual_stick?.enabled ??
          latest?.virtual_stick_enabled ??
          false;

        const latestBlocked =
          latestManualOverride ||
          (latestOwner &&
            latestOwner !== "APP" &&
            latestOwner !== "UNKNOWN" &&
            latestOwner !== "NONE");
        if (latestBlocked) {
          recordSessionEvent("vs_enable_blocked", latestOwner || "unknown_owner");
          throw new Error(
            `Virtual stick taken by ${latestOwner || "hardware controller"}. Release RC override.`,
          );
        }
        if (latestEnabled) {
          recordSessionEvent("vs_enable_success", `attempt=${attempt} (external)`);
          return;
        }
      }
    }

    recordSessionEvent("vs_enable_failed_final", lastError ?? "unknown_error");
    throw new Error(lastError ?? "Unable to enable virtual stick");
  }, [recordSessionEvent, sendFlightCommand]);

  useEffect(() => {
    const previousStatus = connectionStatusRef.current;
    connectionStatusRef.current = connectionStatus;

    if (
      (connectionStatus === "disconnected" || connectionStatus === "error") &&
      stateRef.current.active &&
      !bridgeLostNotifiedRef.current
    ) {
      bridgeLostNotifiedRef.current = true;
      pendingResumeRef.current = true;
      recordSessionEvent("bridge_connection_lost", connectionStatus);
    }

    if (connectionStatus === "connected") {
      if (bridgeLostNotifiedRef.current) {
        bridgeLostNotifiedRef.current = false;
        recordSessionEvent("bridge_connection_restored");
      }

      if (
        pendingResumeRef.current &&
        stateRef.current.active &&
        !resumeInProgressRef.current
      ) {
        resumeInProgressRef.current = true;
        recordSessionEvent("session_resume_attempt");
        ensureVirtualStickReady()
          .then(() => {
            pendingResumeRef.current = false;
            recordSessionEvent("session_resume_success");
            return sendFlightCommand(
              "virtual_stick_override",
              stateRef.current.axes,
            ).then((result: any) => {
              if (result && result.success === false) {
                const errMessage =
                  result.error ||
                  result.error_message ||
                  result.message ||
                  "Bridge rejected manual command";
                recordSessionEvent("session_resume_stream_failed", errMessage);
              } else {
                recordSessionEvent("session_resume_stream");
              }
            });
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            recordSessionEvent("session_resume_failed", message);
            handleSendError(error);
          })
          .finally(() => {
            resumeInProgressRef.current = false;
          });
      }
    }

    if (
      previousStatus === "connected" &&
      connectionStatus !== "connected" &&
      connectionStatus !== "reconnecting"
    ) {
      pendingResumeRef.current = true;
    }
  }, [
    connectionStatus,
    ensureVirtualStickReady,
    handleSendError,
    recordSessionEvent,
    sendFlightCommand,
  ]);

  const tick = useCallback(() => {
    if (!stateRef.current.active) {
      return;
    }

    const keyAxes = computeKeyAxes();
    const yawWithMouse = clamp(keyAxes.yaw + mouseYawRef.current, -1, 1);
    const pitchWithMouse = clamp(keyAxes.pitch + mousePitchRef.current, -1, 1);

    if (Math.abs(mouseYawRef.current) > 0.0001) {
      mouseYawRef.current *= MOUSE_YAW_DECAY;
      if (Math.abs(mouseYawRef.current) < 0.001) {
        mouseYawRef.current = 0;
      }
    }

    if (Math.abs(mousePitchRef.current) > 0.0001) {
      mousePitchRef.current *= MOUSE_PITCH_DECAY;
      if (Math.abs(mousePitchRef.current) < 0.001) {
        mousePitchRef.current = 0;
      }
    }

    const nextAxes: AxisState = {
      yaw: yawWithMouse,
      throttle: clamp(keyAxes.throttle, -1, 1),
      roll: clamp(keyAxes.roll, -1, 1),
      pitch: pitchWithMouse,
    };
    const sendTimestamp = Date.now();
    const macro = macroOverrideRef.current;
    let commandAxes = nextAxes;
    if (macro) {
      if (sendTimestamp >= macro.until) {
        macroOverrideRef.current = null;
      } else {
        commandAxes = macro.axes;
      }
    }

    setState((prev) => ({
      ...prev,
      axes: axesEqual(prev.axes, commandAxes) ? prev.axes : commandAxes,
      lastCommandMs: sendTimestamp,
      analytics: {
        ...prev.analytics,
        commandCount: prev.analytics.commandCount + 1,
        sessionStart: prev.analytics.sessionStart ?? sendTimestamp,
      },
    }));

    recordSessionEntry({
      kind: "axes",
      timestamp: sendTimestamp,
      yaw: commandAxes.yaw,
      throttle: commandAxes.throttle,
      roll: commandAxes.roll,
      pitch: commandAxes.pitch,
      status: "sent",
    });

    sendFlightCommand("virtual_stick_override", commandAxes)
      .then((result: any) => {
        const now = Date.now();
        lastCommandRef.current = now;
        if (
          stateRef.current.active &&
          (stateRef.current.lastCommandMs === null ||
            now - stateRef.current.lastCommandMs > 120)
        ) {
          setState((prev) => ({
            ...prev,
            lastCommandMs: now,
            analytics: {
              ...prev.analytics,
              commandCount: prev.analytics.commandCount + 1,
            },
          }));
        }

        if (pendingResumeRef.current) {
          pendingResumeRef.current = false;
          recordSessionEvent("session_resume_stream");
        }

        if (result && result.success === false) {
          const errMessage =
            result.error ||
            result.error_message ||
            result.message ||
            "Bridge rejected manual command";
          if (errMessage.toLowerCase().includes("bridge not connected")) {
            if (!bridgeLostNotifiedRef.current) {
              recordSessionEvent("bridge_not_connected", errMessage);
            }
            pendingResumeRef.current = true;
            bridgeLostNotifiedRef.current = true;
            return;
          }
        recordSessionEvent("command_rejected", errMessage);
        handleSendError(new Error(errMessage));
        }
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Manual command failed";
        if (message.toLowerCase().includes("bridge not connected")) {
          if (!bridgeLostNotifiedRef.current) {
            recordSessionEvent("bridge_not_connected", message);
          }
          pendingResumeRef.current = true;
          bridgeLostNotifiedRef.current = true;
          return;
        }
        recordSessionEvent("command_error", message);
        handleSendError(error);
      });
  }, [
    computeKeyAxes,
    handleSendError,
    recordSessionEntry,
    recordSessionEvent,
    sendFlightCommand,
  ]);

  const start = useCallback(async () => {
    if (stateRef.current.active || stateRef.current.status === "arming") {
      return;
    }

    clearSessionLog();
    sessionMetaRef.current = { start: Date.now(), preset: sensitivity };
    recordSessionEvent("session_start", `preset=${sensitivity}`);
    pendingResumeRef.current = false;
    resumeInProgressRef.current = false;
    bridgeLostNotifiedRef.current = false;

    setState((prev) => ({
      ...prev,
      status: "arming",
      error: null,
    }));

    try {
      await ensureVirtualStickReady();
      await sendFlightCommand("virtual_stick_override", createZeroAxes());

      setState((prev) => ({
        ...prev,
        active: true,
        status: "active",
        axes: createZeroAxes(),
        lastCommandMs: Date.now(),
        error: null,
        notification: null,
        analytics: { commandCount: 0, sessionStart: Date.now() },
      }));
      recordSessionEvent("session_control_active");
      console.info(
        "[ManualControl] Virtual stick enabled (sensitivity:",
        sensitivity,
        ")",
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to enable virtual stick";
      recordSessionEvent("session_start_failed", message);
      setState((prev) => ({
        ...prev,
        active: false,
        status: "error",
        error: message,
        analytics: { commandCount: 0, sessionStart: null },
      }));
    }
  }, [
    clearSessionLog,
    ensureVirtualStickReady,
    recordSessionEvent,
    sendFlightCommand,
    sensitivity,
  ]);

  const stop = useCallback(async () => {
    if (!stateRef.current.active && stateRef.current.status !== "arming") {
      return;
    }

    cleanupSession({ exitPointerLock: true });
    const releaseNotification = createNotification(
      "release",
      "Manual control released; virtual stick disabled.",
    );
    const stopTimestamp = Date.now();
    sessionMetaRef.current = {
      ...sessionMetaRef.current,
      end: stopTimestamp,
    };
    recordSessionEvent("session_stop");
    pendingResumeRef.current = false;
    resumeInProgressRef.current = false;
    bridgeLostNotifiedRef.current = false;
    setState((prev) => ({
      ...prev,
      active: false,
      status: "stopping",
      axes: createZeroAxes(),
      pointerLocked: false,
      analytics: { commandCount: 0, sessionStart: null },
      notification: null,
    }));

    try {
      await sendFlightCommand("virtual_stick_override", createZeroAxes());
    } catch (error) {
      console.warn(
        "Failed to send zeroed virtual stick command during stop",
        error,
      );
    }

    try {
      const disableResult = await sendFlightCommand("virtual_stick_disable");
      if (disableResult && disableResult.success === false) {
        const errMessage =
          disableResult.error ||
          disableResult.error_message ||
          disableResult.message ||
          "Bridge rejected disable";
        throw new Error(errMessage);
      }
      setState((prev) => ({
        ...prev,
        status: "idle",
        error: null,
        analytics: { commandCount: 0, sessionStart: null },
        notification: releaseNotification,
      }));
      console.info("[ManualControl] Virtual stick disabled");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to disable virtual stick";
      recordSessionEvent("session_stop_failed", message);
      setState((prev) => ({
        ...prev,
        status: "error",
        error: message,
        analytics: { commandCount: 0, sessionStart: null },
      }));
    }
  }, [cleanupSession, createNotification, recordSessionEvent, sendFlightCommand]);

  const kill = useCallback(async () => {
    cleanupSession({ exitPointerLock: true });
    macroOverrideRef.current = null;
    const killNotification = createNotification(
      "kill",
      "Kill switch executed; manual control released",
    );
    const killTimestamp = Date.now();
    sessionMetaRef.current = {
      ...sessionMetaRef.current,
      end: killTimestamp,
    };
    recordSessionEvent("session_kill_switch");
    pendingResumeRef.current = false;
    resumeInProgressRef.current = false;
    bridgeLostNotifiedRef.current = false;
    setState((prev) => ({
      ...prev,
      active: false,
      status: "idle",
      axes: createZeroAxes(),
      pointerLocked: false,
      error: null,
      notification: killNotification,
      analytics: { commandCount: 0, sessionStart: null },
    }));

    try {
      await sendFlightCommand("virtual_stick_override", createZeroAxes());
    } catch (error) {
      console.warn("Kill switch: failed to zero virtual stick", error);
    }

    try {
      await sendFlightCommand("virtual_stick_disable");
    } catch (error) {
      console.warn("Kill switch: failed to disable virtual stick", error);
      const message =
        error instanceof Error
          ? error.message
          : "Failed to disable virtual stick";
      recordSessionEvent("session_kill_switch_failed", message);
      setState((prev) => ({
        ...prev,
        error: message,
      }));
    }
  }, [cleanupSession, createNotification, recordSessionEvent, sendFlightCommand]);

  const triggerMotorMacro = useCallback(() => {
    if (!stateRef.current.active) {
      return;
    }
    macroOverrideRef.current = {
      axes: { ...MOTOR_STICK_AXES },
      until: Date.now() + MOTOR_STICK_MACRO_DURATION_MS,
    };
    recordSessionEvent('motor_macro_trigger');
    setState((prev) => ({
      ...prev,
      notification:
        prev.notification ?? {
          type: 'override',
          message: 'Motor start macro sent',
          timestamp: Date.now(),
        },
    }));
  }, [recordSessionEvent]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!stateRef.current.active) {
        return;
      }

      if (event.code === "Escape") {
        event.preventDefault();
        kill();
        return;
      }

      if (event.code === MOTOR_STICK_KEY) {
        event.preventDefault();
        if (!event.repeat) {
          triggerMotorMacro();
        }
        return;
      }

      if (!SUPPORTED_KEYS.has(event.code)) {
        return;
      }

      event.preventDefault();
      if (!event.repeat) {
        keysRef.current.add(event.code);
        updateAxesSnapshot();
      }
  },
    [kill, triggerMotorMacro, updateAxesSnapshot],
  );

  const handleKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (!stateRef.current.active) {
        return;
      }

      if (SUPPORTED_KEYS.has(event.code)) {
        event.preventDefault();
        keysRef.current.delete(event.code);
        updateAxesSnapshot();
      }
    },
    [updateAxesSnapshot],
  );

  const handleWindowBlur = useCallback(() => {
    if (!stateRef.current.active) {
      return;
    }

    keysRef.current.clear();
    mouseYawRef.current = 0;
    mousePitchRef.current = 0;
    updateAxesSnapshot();
  }, [updateAxesSnapshot]);

  const handlePointerLockChange = useCallback(() => {
    if (!pointerSupported) {
      return;
    }

    const locked = document.pointerLockElement === document.body;
    if (!locked) {
      mouseYawRef.current = 0;
      mousePitchRef.current = 0;
      keysRef.current.delete("ArrowLeft");
      keysRef.current.delete("ArrowRight");
    }

    setState((prev) => ({
      ...prev,
      pointerLocked: locked,
      axes: locked ? prev.axes : { ...prev.axes, yaw: prev.axes.yaw },
    }));

    if (!locked) {
      updateAxesSnapshot();
    }
  }, [pointerSupported, updateAxesSnapshot]);

  const handlePointerLockError = useCallback(() => {
    if (!pointerSupported) {
      return;
    }
    setState((prev) => ({
      ...prev,
      pointerLocked: false,
      error: prev.error ?? "Failed to engage pointer lock for yaw control",
    }));
  }, [pointerSupported]);

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!stateRef.current.active) {
        return;
      }
      if (!pointerSupported || document.pointerLockElement !== document.body) {
        return;
      }

      const deltaX = event.movementX || 0;
      const deltaY = event.movementY || 0;
      let changed = false;

      if (deltaX !== 0) {
        mouseYawRef.current = clamp(
          mouseYawRef.current + deltaX * mouseYawSensitivityRef.current,
          -1,
          1,
        );
        changed = true;
      }

      if (deltaY !== 0) {
        mousePitchRef.current = clamp(
          mousePitchRef.current + -deltaY * mouseYawSensitivityRef.current,
          -1,
          1,
        );
        changed = true;
      }

      if (changed) {
        updateAxesSnapshot();
      }
    },
    [pointerSupported, updateAxesSnapshot],
  );

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      tickRef.current();
    }, CONTROL_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!state.active) {
      return;
    }

    document.addEventListener("keydown", handleKeyDown, { passive: false });
    document.addEventListener("keyup", handleKeyUp, { passive: false });
    document.addEventListener("mousemove", handleMouseMove, { passive: false });
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [
    handleKeyDown,
    handleKeyUp,
    handleMouseMove,
    handleWindowBlur,
    state.active,
  ]);

  useEffect(() => {
    if (!pointerSupported) {
      return;
    }

    document.addEventListener("pointerlockchange", handlePointerLockChange);
    document.addEventListener("pointerlockerror", handlePointerLockError);

    return () => {
      document.removeEventListener(
        "pointerlockchange",
        handlePointerLockChange,
      );
      document.removeEventListener("pointerlockerror", handlePointerLockError);
    };
  }, [handlePointerLockChange, handlePointerLockError, pointerSupported]);

  useEffect(() => {
    const owner = resolveOwner(controller);
    const vsEnabled =
      controller?.virtual_stick?.enabled ??
      controller?.virtual_stick_enabled ??
      false;
    const manualOverride = controller?.virtual_stick?.manual_override ?? false;

    if (owner !== lastAuthorityOwnerRef.current) {
      console.info(
        "[ManualControl] Virtual stick owner update:",
        lastAuthorityOwnerRef.current,
        "→",
        owner,
        "(enabled=",
        vsEnabled,
        ", manualOverride=",
        manualOverride,
        ")",
      );
      lastAuthorityOwnerRef.current = owner;
    }

    const stateSnapshot = stateRef.current;

    if (!stateSnapshot.active) {
      return;
    }

    if (!vsEnabled) {
      cleanupSession({ exitPointerLock: true });
      sessionMetaRef.current = {
        ...sessionMetaRef.current,
        end: Date.now(),
      };
      recordSessionEvent("session_virtual_stick_disabled_external");
      setState((prev) => ({
        ...prev,
        active: false,
        status: "lost",
        axes: createZeroAxes(),
        pointerLocked: false,
        error: prev.error ?? "Virtual stick disabled externally",
        analytics: { commandCount: 0, sessionStart: null },
      }));
      lastOverrideEventRef.current = null;
      return;
    }

    const authorityTransferred =
      manualOverride || (owner && owner !== "APP" && owner !== "UNKNOWN");
    if (authorityTransferred) {
      cleanupSession({ exitPointerLock: true });
      const overrideKey = `${owner ?? "unknown"}-${manualOverride}`;
      sessionMetaRef.current = {
        ...sessionMetaRef.current,
        end: Date.now(),
      };
      recordSessionEvent("session_authority_transferred", owner || "unknown");
      setState((prev) => {
        const overrideMessage = `Virtual stick authority transferred to ${
          owner || "controller"
        }`;
        const nextState: ManualFlightControlState = {
          ...prev,
          active: false,
          status: "lost",
          axes: createZeroAxes(),
          pointerLocked: false,
          error: overrideMessage,
          notification: prev.notification,
          analytics: { commandCount: 0, sessionStart: null },
        };
        if (lastOverrideEventRef.current !== overrideKey) {
          nextState.notification = createNotification(
            "override",
            overrideMessage,
          );
          lastOverrideEventRef.current = overrideKey;
        }
        return nextState;
      });
    } else {
      lastOverrideEventRef.current = null;
    }
  }, [cleanupSession, controller, createNotification, recordSessionEvent]);

  useEffect(
    () => () => {
      cleanupSession({ exitPointerLock: true });
    },
    [cleanupSession],
  );

  const togglePointerLock = useCallback(() => {
    if (!pointerSupported || !stateRef.current.active) {
      return;
    }

    if (document.pointerLockElement) {
      document.exitPointerLock();
    } else {
      document.body?.requestPointerLock();
    }
  }, [pointerSupported]);

  const virtualStick = useMemo<VirtualStickSnapshot>(() => {
    const vs = controller?.virtual_stick;
    return {
      enabled: vs?.enabled ?? controller?.virtual_stick_enabled ?? false,
      advancedEnabled: vs?.advanced_enabled ?? false,
      owner: resolveOwner(controller),
      manualOverride: vs?.manual_override ?? false,
      changeReason: vs?.change_reason ?? "UNKNOWN",
    };
  }, [controller]);

  return {
    state,
    virtualStick,
    start,
    stop,
    kill,
    acknowledgeNotification,
    togglePointerLock,
    pointerLockSupported: pointerSupported,
    sensitivity,
    setSensitivity,
    mouseYawSensitivity,
    setMouseYawSensitivity,
    sessionLogAvailable,
    exportSessionLog,
  };
};
