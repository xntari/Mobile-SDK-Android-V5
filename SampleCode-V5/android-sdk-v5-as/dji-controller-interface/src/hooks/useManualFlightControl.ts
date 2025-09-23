import { useBridgeCommands } from "./useBridgeCommands";
import { ControllerData } from "../types";
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

const createZeroAxes = (): AxisState => ({
  yaw: 0,
  throttle: 0,
  roll: 0,
  pitch: 0,
});
const AXIS_EPSILON = 0.02;
const CONTROL_TICK_MS = 60; // ~16 Hz command stream
const PITCH_SCALE = 0.6;
const ROLL_SCALE = 0.6;
const THROTTLE_SCALE = 0.6;
const YAW_SCALE = 0.5;
const MOUSE_YAW_SENSITIVITY = 1 / 300;
const MOUSE_YAW_DECAY = 0.65;

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

interface ManualFlightControlState {
  active: boolean;
  status: ManualFlightControlStatus;
  axes: AxisState;
  pointerLocked: boolean;
  lastCommandMs: number | null;
  error: string | null;
}

interface VirtualStickSnapshot {
  enabled: boolean;
  advancedEnabled: boolean;
  owner: string;
  manualOverride: boolean;
  changeReason: string;
}

interface ManualFlightControlHook {
  state: ManualFlightControlState;
  virtualStick: VirtualStickSnapshot;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  kill: () => Promise<void>;
  togglePointerLock: () => void;
  pointerLockSupported: boolean;
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
): ManualFlightControlHook => {
  const { sendFlightCommand } = useBridgeCommands();
  const [state, setState] = useState<ManualFlightControlState>({
    active: false,
    status: "idle",
    axes: createZeroAxes(),
    pointerLocked: false,
    lastCommandMs: null,
    error: null,
  });

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const keysRef = useRef<Set<string>>(new Set());
  const mouseYawRef = useRef(0);
  const tickTimerRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const lastCommandRef = useRef<number | null>(null);

  const pointerSupported = useMemo(pointerLockAvailable, []);

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
        PITCH_SCALE,
      ),
      roll: computeAxisWithKeys(
        KEY_GROUPS.rollRight,
        KEY_GROUPS.rollLeft,
        ROLL_SCALE,
      ),
      throttle: computeAxisWithKeys(
        KEY_GROUPS.throttleUp,
        KEY_GROUPS.throttleDown,
        THROTTLE_SCALE,
      ),
      yaw: computeAxisWithKeys(
        KEY_GROUPS.yawRight,
        KEY_GROUPS.yawLeft,
        YAW_SCALE,
      ),
    }),
    [computeAxisWithKeys],
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

  const stopTickLoop = useCallback(() => {
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  const cleanupSession = useCallback(
    (options?: { exitPointerLock?: boolean }) => {
      stopTickLoop();
      keysRef.current.clear();
      mouseYawRef.current = 0;

      if (
        pointerSupported &&
        options?.exitPointerLock !== false &&
        document.pointerLockElement
      ) {
        document.exitPointerLock();
      }
    },
    [pointerSupported, stopTickLoop],
  );

  const handleSendError = useCallback(
    (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Manual command failed";
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
    [cleanupSession],
  );

  const tick = useCallback(() => {
    if (!stateRef.current.active) {
      return;
    }

    const keyAxes = computeKeyAxes();
    const yawWithMouse = clamp(keyAxes.yaw + mouseYawRef.current, -1, 1);

    if (Math.abs(mouseYawRef.current) > 0.0001) {
      mouseYawRef.current *= MOUSE_YAW_DECAY;
      if (Math.abs(mouseYawRef.current) < 0.001) {
        mouseYawRef.current = 0;
      }
    }

    const nextAxes: AxisState = {
      yaw: yawWithMouse,
      throttle: clamp(keyAxes.throttle, -1, 1),
      roll: clamp(keyAxes.roll, -1, 1),
      pitch: clamp(keyAxes.pitch, -1, 1),
    };

    if (!axesEqual(stateRef.current.axes, nextAxes)) {
      setState((prev) => ({
        ...prev,
        axes: nextAxes,
      }));
    }

    if (sendingRef.current) {
      return;
    }
    sendingRef.current = true;

    sendFlightCommand("virtual_stick_override", nextAxes)
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
          }));
        }

        if (result && result.success === false) {
          const errMessage =
            result.error ||
            result.error_message ||
            result.message ||
            "Bridge rejected manual command";
          handleSendError(new Error(errMessage));
        }
      })
      .catch(handleSendError)
      .finally(() => {
        sendingRef.current = false;
      });
  }, [computeKeyAxes, handleSendError, sendFlightCommand]);

  const startTickLoop = useCallback(() => {
    if (tickTimerRef.current === null) {
      tickTimerRef.current = window.setInterval(tick, CONTROL_TICK_MS);
    }
  }, [tick]);

  const start = useCallback(async () => {
    if (stateRef.current.active || stateRef.current.status === "arming") {
      return;
    }

    setState((prev) => ({
      ...prev,
      status: "arming",
      error: null,
    }));

    try {
      const enableResult = await sendFlightCommand("virtual_stick_enable");
      if (enableResult && enableResult.success === false) {
        const errMessage =
          enableResult.error ||
          enableResult.error_message ||
          enableResult.message ||
          "Bridge rejected enable";
        throw new Error(errMessage);
      }

      await sendFlightCommand("virtual_stick_override", createZeroAxes());

      setState((prev) => ({
        ...prev,
        active: true,
        status: "active",
        axes: createZeroAxes(),
        lastCommandMs: Date.now(),
        error: null,
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to enable virtual stick";
      setState((prev) => ({
        ...prev,
        active: false,
        status: "error",
        error: message,
      }));
    }
  }, [sendFlightCommand]);

  const stop = useCallback(async () => {
    if (!stateRef.current.active && stateRef.current.status !== "arming") {
      return;
    }

    cleanupSession({ exitPointerLock: true });
    setState((prev) => ({
      ...prev,
      active: false,
      status: "stopping",
      axes: createZeroAxes(),
      pointerLocked: false,
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
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to disable virtual stick";
      setState((prev) => ({
        ...prev,
        status: "error",
        error: message,
      }));
    }
  }, [cleanupSession, sendFlightCommand]);

  const kill = useCallback(async () => {
    cleanupSession({ exitPointerLock: true });
    setState((prev) => ({
      ...prev,
      active: false,
      status: "idle",
      axes: createZeroAxes(),
      pointerLocked: false,
      error: null,
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
      setState((prev) => ({
        ...prev,
        error: message,
      }));
    }
  }, [cleanupSession, sendFlightCommand]);

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

      if (!SUPPORTED_KEYS.has(event.code)) {
        return;
      }

      event.preventDefault();
      if (!event.repeat) {
        keysRef.current.add(event.code);
        updateAxesSnapshot();
      }
    },
    [kill, updateAxesSnapshot],
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
    updateAxesSnapshot();
  }, [updateAxesSnapshot]);

  const handlePointerLockChange = useCallback(() => {
    if (!pointerSupported) {
      return;
    }

    const locked = document.pointerLockElement === document.body;
    if (!locked) {
      mouseYawRef.current = 0;
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

      const delta = event.movementX || 0;
      if (delta === 0) {
        return;
      }

      mouseYawRef.current = clamp(
        mouseYawRef.current + delta * MOUSE_YAW_SENSITIVITY,
        -1,
        1,
      );
      updateAxesSnapshot();
    },
    [pointerSupported, updateAxesSnapshot],
  );

  useEffect(() => {
    if (!state.active) {
      stopTickLoop();
      return;
    }

    startTickLoop();
    return () => {
      stopTickLoop();
    };
  }, [startTickLoop, state.active, stopTickLoop]);

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

    if (!state.active) {
      return;
    }

    if (!vsEnabled) {
      cleanupSession({ exitPointerLock: true });
      setState((prev) => ({
        ...prev,
        active: false,
        status: "lost",
        axes: createZeroAxes(),
        pointerLocked: false,
        error: prev.error ?? "Virtual stick disabled externally",
      }));
      return;
    }

    if (manualOverride || (owner && owner !== "APP" && owner !== "UNKNOWN")) {
      cleanupSession({ exitPointerLock: true });
      setState((prev) => ({
        ...prev,
        active: false,
        status: "lost",
        axes: createZeroAxes(),
        pointerLocked: false,
        error: `Virtual stick authority transferred to ${owner || "controller"}`,
      }));
    }
  }, [cleanupSession, controller, state.active]);

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
    togglePointerLock,
    pointerLockSupported: pointerSupported,
  };
};
