import React, {
  useRef,
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { H20NDisplayProps, TelemetryData } from "../types";
import { GimbalModeToggle, GimbalMode } from "./GimbalModeToggle";
import type { Detection, Mask } from "../agent/visionClient";
import { CameraDisplay } from "./CameraDisplay";
import {
  objectMemoryTargetStore,
  type ObjectMemoryTargetSelection,
} from "../state/objectMemoryTargets";
import { computeTargetMetrics } from "../utils/objectMemoryTarget";
import { projectGeographicPointToScreen } from "../utils/rayProjection";
import {
  registerLiveViewLocationListener,
  requestLiveViewLocation,
  type LiveViewPinPoint,
} from "../agent/cameraProjectionClient";
import { normalizeAngleDeg, shortestAngleDiffDeg } from "../utils/angleUtils";
import { projectionModeStore } from "../state/projectionMode";

export interface H20NDisplayRef {
  getSnapshot: () => Promise<string>;
}

interface ClickIndicator {
  id: string;
  x: number;
  y: number;
  status: "pending" | "success" | "error";
  timestamp: number;
  message?: string;
}

export const H20NDisplay = forwardRef<H20NDisplayRef, H20NDisplayProps>(
  (
    {
      width,
      height,
      className = "",
      children,
      telemetryData,
      visionDetections = [],
      agentDetections = [],
      visionMasks = [],
      visionKeypoints = [],
      maskOpacity = 0.25,
      colorizeById = false,
      detectThickness = 1,
      visionHeatmap = null,
      visionHeatmapOpacity = 0.35,
    },
    ref,
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const videoDecoderRef = useRef<VideoDecoder | null>(null);
    const offscreenCanvasRef = useRef<OffscreenCanvas | null>(null);
    const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(
      null,
    );
    const [videoStatus, setVideoStatus] = useState<
      "waiting" | "loading" | "playing" | "error" | "receiving" | "decoding" | "simulator"
    >("waiting");
    const [frameStats, setFrameStats] = useState({
      frames: 0,
      totalBytes: 0,
      lastFrame: 0,
      decodedFrames: 0,
    });
    const [decoderSupported, setDecoderSupported] = useState<boolean | null>(
      null,
    );
    const [videoDimensions, setVideoDimensions] = useState({
      width: 1920,
      height: 1080,
    });
    const [displayRect, setDisplayRect] = useState({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    const spsRef = useRef<Uint8Array | null>(null);
    const ppsRef = useRef<Uint8Array | null>(null);
    const decoderConfiguredRef = useRef<boolean>(false);
    const decoderRestartTimerRef = useRef<number | null>(null);
    const decoderRestartAttemptsRef = useRef<number>(0);
    const [objectTarget, setObjectTarget] =
      useState<ObjectMemoryTargetSelection | null>(() =>
        objectMemoryTargetStore.getCurrent(),
      );
    const [liveViewPoint, setLiveViewPoint] = useState<LiveViewPinPoint | null>(
      null,
    );
    const simulatorActive = telemetryData?.simulator?.enabled ?? false;
    const [clickIndicators, setClickIndicators] = useState<ClickIndicator[]>(
      [],
    );
    const [lastGimbalCommand, setLastGimbalCommand] = useState<{
      coordinates: { x: number; y: number };
      status: string;
      message: string;
      timestamp: number;
    } | null>(null);
    const [droppedFrameCount, setDroppedFrameCount] = useState<number>(0);

    // Gimbal Free Look state
    const [gimbalMode, setGimbalMode] = useState<GimbalMode>("look_at");
    const [selectedLens, setSelectedLens] = useState<
      "wide" | "zoom" | "infrared"
    >("wide");
    const [laserOn, setLaserOn] = useState<boolean>(false);
    const [laserReadout, setLaserReadout] = useState<{
      text: string;
      timestamp: number;
    } | null>(null);
    const [lastLaserResult, setLastLaserResult] = useState<any | null>(null);
    const laserHideTimerRef = useRef<number | null>(null);
    const [isFreeLookActive, setIsFreeLookActive] = useState(false);
    const freeLookUpdateInterval = useRef<NodeJS.Timeout | null>(null);
    const lastMousePos = useRef<{ x: number; y: number } | null>(null);
    const freeLookOriginRef = useRef<{ x: number; y: number } | null>(null);
    const [freeLookVelocity, setFreeLookVelocity] = useState<{
      vx: number;
      vy: number;
    }>({ vx: 0, vy: 0 });
    const freeLookVelocityRef = useRef<{ vx: number; vy: number }>({
      vx: 0,
      vy: 0,
    });
    const isFreeLookActiveRef = useRef<boolean>(false);
    // Free Look tuning
    const [sensitivity, setSensitivity] = useState<number>(1.5); // 1.0 baseline
    const [smoothing, setSmoothing] = useState<number>(0.15); // 0..0.9 (client filter)
    // Precise Look tuning
    const [preciseDurationMs, setPreciseDurationMs] = useState<number>(700);
    const [preciseStrength, setPreciseStrength] = useState<number>(1.0);
    const [zoomValue, setZoomValue] = useState<number>(
      () => telemetryData?.camera_optics?.zoom_ratio ?? 1,
    );
    const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      const unsubscribe = objectMemoryTargetStore.subscribe(setObjectTarget);
      return unsubscribe;
    }, [simulatorActive]);

    // Clear vision boxes when camera moves (any gimbal command updates) - handled by parent App component now

    React.useEffect(() => {
      if (typeof telemetryData?.camera_optics?.zoom_ratio === "number") {
        setZoomValue(telemetryData.camera_optics.zoom_ratio);
      }
    }, [telemetryData?.camera_optics?.zoom_ratio]);

    React.useEffect(() => {
      const lens = telemetryData?.camera_optics?.lens;
      const lensType = telemetryData?.camera_optics?.lens_type;
      const source = lensType || lens || "";
      if (!source) return;
      const upper = source.toUpperCase();
      const normalized = upper.includes("ZOOM")
        ? "zoom"
        : upper.includes("INFRARED") || upper.includes("THERMAL")
          ? "infrared"
          : "wide";
      if (normalized !== selectedLens) {
        setSelectedLens(normalized);
      }
    }, [telemetryData?.camera_optics?.lens, selectedLens]);

    React.useEffect(
      () => () => {
        if (zoomDebounceRef.current) {
          clearTimeout(zoomDebounceRef.current);
        }
      },
      [],
    );

    const zoomRange = telemetryData?.camera_optics?.zoom_range;
    const minZoom = typeof zoomRange?.min === "number" ? zoomRange.min : 1;
    const maxZoom = typeof zoomRange?.max === "number" ? zoomRange.max : 30;

    const sendZoomCommand = React.useCallback((ratio: number) => {
      const api = (window as any)?.electronAPI;
      if (!api?.sendBridgeCommand) {
        console.warn("camera_zoom unavailable: bridge command channel missing");
        return;
      }
      api
        .sendBridgeCommand({
          type: "camera_zoom",
          data: { ratio },
        })
        .catch((error: any) => {
          console.error("camera_zoom error", error);
        });
    }, [simulatorActive]);

    const handleZoomSliderChange = React.useCallback(
      (ratio: number) => {
        const clamped = Math.min(maxZoom, Math.max(minZoom, ratio));
        setZoomValue(clamped);
        if (zoomDebounceRef.current) {
          clearTimeout(zoomDebounceRef.current);
        }
        zoomDebounceRef.current = setTimeout(() => {
          sendZoomCommand(clamped);
          zoomDebounceRef.current = null;
        }, 220);
      },
      [maxZoom, minZoom, sendZoomCommand],
    );

    const bridgeHasSendCommand =
      typeof window !== "undefined" &&
      !!(window as any).electronAPI?.sendBridgeCommand;

    // Helper: provide a snapshot of the current canvas as base64 JPEG
    const getSnapshot = async (): Promise<string> => {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Canvas not ready");
      try {
        // Constrain to displayed rectangle by drawing into an offscreen canvas
        const off = document.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const ctx = off.getContext("2d");
        if (!ctx) throw new Error("No 2D context");
        ctx.drawImage(canvas, 0, 0);
        return off.toDataURL("image/jpeg", 0.9);
      } catch (e) {
        console.error("Snapshot failed", e);
        throw e;
      }
    };

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        getSnapshot,
      }),
      [],
    );

    // Handle canvas click for gimbal tap-to-target or precise look functionality
    const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
      // Don't handle clicks during Free Look mode
      if (gimbalMode === "free_look") {
        return;
      }

      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();

      // Calculate click position relative to the canvas
      const clickX = event.clientX - rect.left;
      const clickY = event.clientY - rect.top;

      // If displayRect is not initialized, use full canvas
      const effectiveDisplayRect =
        displayRect.width > 0
          ? displayRect
          : { left: 0, top: 0, width: rect.width, height: rect.height };

      // Check if click is within the effective display area
      if (
        clickX < effectiveDisplayRect.left ||
        clickX > effectiveDisplayRect.left + effectiveDisplayRect.width ||
        clickY < effectiveDisplayRect.top ||
        clickY > effectiveDisplayRect.top + effectiveDisplayRect.height
      ) {
        return;
      }

      // Convert to normalized coordinates (0.0-1.0)
      const x =
        (clickX - effectiveDisplayRect.left) / effectiveDisplayRect.width;
      const y =
        (clickY - effectiveDisplayRect.top) / effectiveDisplayRect.height;

      const clickId = `click-${Date.now()}`;

      // Look At uses SDK tap target behavior (absolute normalized)
      const commandType = "gimbal_tap_target";
      const modeLabel = gimbalMode === "look_at" ? "Look At" : "Tap Target";

      console.log(
        `[DEV_GIMBAL] H20N ${modeLabel} at normalized coordinates: (${x.toFixed(3)}, ${y.toFixed(3)}) [ID: ${clickId}]`,
      );

      // Add pending click indicator (using actual click position relative to effective video area)
      const newIndicator: ClickIndicator = {
        id: clickId,
        x: clickX - effectiveDisplayRect.left, // Position within the effective video area
        y: clickY - effectiveDisplayRect.top, // Position within the effective video area
        status: "pending",
        timestamp: Date.now(),
      };

      setClickIndicators((prev) => [...prev.slice(-2), newIndicator]);

      // Send command via existing electronAPI
      if ((window as any).electronAPI) {
        const payload: any = { x, y };
        const type = laserOn ? "camera_laser_measure" : commandType;
        (window as any).electronAPI
          .sendBridgeCommand({ type, data: payload })
          .then((result: any) => {
            if (result.success) {
              console.log(`✅ H20N ${modeLabel} command sent successfully`);
            } else {
              console.error(
                `❌ H20N ${modeLabel} command failed:`,
                result.error,
              );
              setClickIndicators((prev) =>
                prev.map((indicator) =>
                  indicator.id === clickId
                    ? {
                        ...indicator,
                        status: "error",
                        message: result.error || "Command failed",
                      }
                    : indicator,
                ),
              );
            }
          })
          .catch((error: any) => {
            console.error(`❌ Failed to send H20N ${modeLabel}:`, error);
            setClickIndicators((prev) =>
              prev.map((indicator) =>
                indicator.id === clickId
                  ? {
                      ...indicator,
                      status: "error",
                      message: error.message || "Send failed",
                    }
                  : indicator,
              ),
            );
          });
      } else {
        console.error("❌ electronAPI not available for H20N gimbal command");
        setClickIndicators((prev) =>
          prev.map((indicator) =>
            indicator.id === clickId
              ? {
                  ...indicator,
                  status: "error",
                  message: "electronAPI not available",
                }
              : indicator,
          ),
        );
      }
    };

    // Free Look utility functions
    const computeFreeLookVelocity = (
      clientX: number,
      clientY: number,
      rect: DOMRect,
    ): { vx: number; vy: number } => {
      // Use drag origin (mouse-down) as the neutral point instead of screen center
      const origin = freeLookOriginRef.current ?? {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const originX = origin.x;
      const originY = origin.y;

      // Calculate offset from center, normalized to [-1, 1]
      const offsetX = (clientX - originX) / (rect.width / 2);
      const offsetY = (clientY - originY) / (rect.height / 2);
      const scaleX = rect.width / rect.height;
      // Apply dead zone (0.08 as specified in DEV.md)
      const deadZone = 0.0;
      const clampedOffsetX = Math.abs(offsetX) > deadZone ? offsetX : 0;
      const clampedOffsetY = Math.abs(offsetY) > deadZone ? offsetY : 0;

      // Apply ease curve: v = sign(offset) * clamp((|offset|-dz)/(1-dz), 0, 1)^1.6
      const applyEaseCurve = (offset: number): number => {
        if (Math.abs(offset) <= deadZone) return 0;
        const sign = Math.sign(offset);
        const magnitude = Math.abs(offset);
        const normalized = Math.min((magnitude - deadZone) / (1 - deadZone), 1);
        return sign * Math.pow(normalized, 1.6);
      };

      // Base velocity from pointer offset
      const base = {
        vx: applyEaseCurve(clampedOffsetX),
        vy: applyEaseCurve(clampedOffsetY),
      };
      // Apply sensitivity scaling and clamp
      let scaled = {
        vx: scaleX * base.vx * sensitivity,
        vy: base.vy * sensitivity,
      };
      scaled = {
        vx: Math.max(-1, Math.min(1, scaled.vx)),
        vy: Math.max(-1, Math.min(1, scaled.vy)),
      };
      // Client-side low-pass smoothing
      const prev = freeLookVelocityRef.current;
      const alpha = Math.max(0, Math.min(0.9, smoothing));
      const filtered = {
        vx: alpha * prev.vx + (1 - alpha) * scaled.vx,
        vy: alpha * prev.vy + (1 - alpha) * scaled.vy,
      };
      return filtered;
    };

    const startFreeLook = () => {
      if (gimbalMode !== "free_look") return;

      console.log("[DEV_GIMBAL] Starting Free Look mode");
      setIsFreeLookActive(true);
      isFreeLookActiveRef.current = true;

      // Send start command
      if ((window as any).electronAPI) {
        (window as any).electronAPI
          .sendBridgeCommand({
            type: "gimbal_free_look_start",
            data: { source: "h20n" },
          })
          .then((result: any) => {
            console.log("[DEV_GIMBAL] Free Look START command sent:", result);
          })
          .catch((error: any) => {
            console.error(
              "[DEV_GIMBAL] Failed to send Free Look START:",
              error,
            );
          });
      }

      // Start 15Hz update interval — always send updates while active to keep watchdog alive
      freeLookUpdateInterval.current = setInterval(() => {
        if (!(window as any).electronAPI) return;
        if (!isFreeLookActiveRef.current) return;
        const { vx, vy } = freeLookVelocityRef.current;
        (window as any).electronAPI
          .sendBridgeCommand({
            type: "gimbal_free_look_update",
            data: { vx, vy },
          })
          .catch((error: any) => {
            console.error(
              "[DEV_GIMBAL] Failed to send Free Look UPDATE:",
              error,
            );
          });
      }, 1000 / 15); // 15Hz
    };

    const stopFreeLook = () => {
      console.log("[DEV_GIMBAL] Stopping Free Look mode");
      setIsFreeLookActive(false);
      isFreeLookActiveRef.current = false;
      setFreeLookVelocity({ vx: 0, vy: 0 });
      freeLookVelocityRef.current = { vx: 0, vy: 0 };
      lastMousePos.current = null;

      // Clear update interval
      if (freeLookUpdateInterval.current) {
        clearInterval(freeLookUpdateInterval.current);
        freeLookUpdateInterval.current = null;
      }

      // Send stop command
      if ((window as any).electronAPI) {
        (window as any).electronAPI
          .sendBridgeCommand({
            type: "gimbal_free_look_stop",
          })
          .then((result: any) => {
            console.log("[DEV_GIMBAL] Free Look STOP command sent:", result);
          })
          .catch((error: any) => {
            console.error("[DEV_GIMBAL] Failed to send Free Look STOP:", error);
          });
      }
    };

    // Free Look mouse event handlers
    const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (gimbalMode === "free_look" && event.button === 0) {
        // Left mouse button
        event.preventDefault();
        lastMousePos.current = { x: event.clientX, y: event.clientY };
        freeLookOriginRef.current = { x: event.clientX, y: event.clientY };
        startFreeLook();
      }
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (gimbalMode === "free_look" && isFreeLookActive) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const velocity = computeFreeLookVelocity(
          event.clientX,
          event.clientY,
          rect,
        );
        freeLookVelocityRef.current = velocity;
        setFreeLookVelocity(velocity);
      }
    };

    const handleMouseUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (
        gimbalMode === "free_look" &&
        isFreeLookActive &&
        event.button === 0
      ) {
        stopFreeLook();
      }
    };

    const handleMouseLeave = () => {
      if (gimbalMode === "free_look" && isFreeLookActive) {
        stopFreeLook();
      }
    };

    // Cleanup Free Look on mode change or unmount
    useEffect(() => {
      if (gimbalMode !== "free_look" && isFreeLookActive) {
        stopFreeLook();
      }
    }, [gimbalMode]);

    useEffect(() => {
      return () => {
        if (isFreeLookActive) {
          stopFreeLook();
        }
      };
    }, [simulatorActive]);

    // Calculate actual video display rectangle with object-contain behavior
    const calculateDisplayRect = () => {
      if (!containerRef.current) return;

      const container = containerRef.current;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      const videoAspect = videoDimensions.width / videoDimensions.height;
      const containerAspect = containerWidth / containerHeight;

      let displayWidth, displayHeight, left, top;

      if (containerAspect > videoAspect) {
        // Container is wider than video - fit by height
        displayHeight = containerHeight;
        displayWidth = displayHeight * videoAspect;
        left = (containerWidth - displayWidth) / 2;
        top = 0;
      } else {
        // Container is taller than video - fit by width
        displayWidth = containerWidth;
        displayHeight = displayWidth / videoAspect;
        left = 0;
        top = (containerHeight - displayHeight) / 2;
      }

      setDisplayRect({ left, top, width: displayWidth, height: displayHeight });
    };

    const targetMetrics = React.useMemo(
      () =>
        computeTargetMetrics(
          telemetryData,
          objectTarget?.anchor,
          objectTarget?.clusterLabel ?? objectTarget?.clusterId,
        ),
      [telemetryData, objectTarget],
    );

    const targetProjection = React.useMemo(() => {
      if (!telemetryData || !objectTarget?.anchor) return null;
      const anchor = objectTarget.anchor;
      const { object_position: objectPos, object_map: extras } = anchor;
      if (
        typeof objectPos?.latitude !== "number" ||
        typeof objectPos?.longitude !== "number"
      )
        return null;
      const altitude =
        objectPos.altitude_m ??
        extras?.laser_location?.altitude_m ??
        extras?.target_point?.altitude_m ??
        telemetryData.location?.altitude ??
        telemetryData.altitude ??
        0;
      return projectGeographicPointToScreen(
        telemetryData,
        {
          latitude: objectPos.latitude,
          longitude: objectPos.longitude,
          altitude,
        },
        {
          imageWidth: videoDimensions.width,
          imageHeight: videoDimensions.height,
          cameraType: "main",
          cameraModel: "H20N",
          baseFocalLength: 25,
          zoomRatioOverride:
            telemetryData.camera_optics?.zoom_ratio ?? undefined,
        },
      );
    }, [telemetryData, objectTarget, videoDimensions]);

    const fallbackProjection = React.useMemo(() => {
      if (!telemetryData || !targetMetrics) return null;
      const fovH = telemetryData.camera_optics?.display_fov?.horizontal ?? 78;
      const fovV = telemetryData.camera_optics?.display_fov?.vertical ?? 52;
      if (
        !Number.isFinite(fovH) ||
        !Number.isFinite(fovV) ||
        fovH <= 0 ||
        fovV <= 0
      )
        return null;

      const heading =
        telemetryData.heading ?? telemetryData.compass_heading ?? 0;
      let gimbalYaw = 0;
      let gimbalPitch = 0;
      const gimbal = telemetryData.gimbals?.find(
        (g) => g.index === "LEFT_OR_MAIN",
      );
      if (gimbal) {
        if (typeof gimbal.yaw_relative === "number")
          gimbalYaw = gimbal.yaw_relative;
        if (typeof gimbal.attitude?.pitch === "number")
          gimbalPitch = gimbal.attitude.pitch;
      }

      const cameraHeading = normalizeAngleDeg(heading + gimbalYaw);
      const horizontalOffset = shortestAngleDiffDeg(
        targetMetrics.bearing,
        cameraHeading,
      );

      const enu = targetMetrics.enu;
      const horizontalDistance = Math.max(
        0.01,
        Math.sqrt(enu.east ** 2 + enu.north ** 2),
      );
      const targetPitch =
        (Math.atan2(enu.up, horizontalDistance) * 180) / Math.PI;
      const verticalOffset = targetPitch - gimbalPitch;

      const normX = 0.5 + horizontalOffset / fovH;
      const normY = 0.5 - verticalOffset / fovV;
      return {
        normX,
        normY,
        displayX: normX * displayRect.width,
        displayY: normY * displayRect.height,
        inFrame: normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1,
      };
    }, [telemetryData, targetMetrics, displayRect.width, displayRect.height]);

    useEffect(() => {
      if (!objectTarget?.anchor?.object_position) {
        setLiveViewPoint(null);
        return;
      }
      const { latitude, longitude, altitude_m } =
        objectTarget.anchor.object_position;
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        setLiveViewPoint(null);
        return;
      }
      const altitude = typeof altitude_m === "number" ? altitude_m : 0;
      const requestId = `h20n-${objectTarget.clusterId ?? ""}`;
      const component = "LEFT_OR_MAIN";

      const unsubscribe = registerLiveViewLocationListener((message) => {
        if (message.component?.toUpperCase() !== component) return;
        if (message.request_id && message.request_id !== requestId) return;
        const pin =
          Array.isArray(message.pin_points) && message.pin_points.length > 0
            ? message.pin_points[0]
            : null;
        if (
          message.valid &&
          pin &&
          typeof pin.x === "number" &&
          typeof pin.y === "number"
        ) {
          setLiveViewPoint(pin);
        } else {
          setLiveViewPoint(null);
        }
      });

      // Request projection update immediately and periodically
      const updateProjection = () => {
        requestLiveViewLocation({
          latitude,
          longitude,
          altitude,
          component,
          requestId,
          source: "h20n_overlay",
        })?.catch(() => {
          // Ignore errors; fallback to local projection
        });
      };

      updateProjection(); // Initial request
      const interval = setInterval(updateProjection, 500); // Update every 500ms

      return () => {
        clearInterval(interval);
        unsubscribe();
      };
    }, [
      objectTarget?.anchor?.object_position?.latitude,
      objectTarget?.anchor?.object_position?.longitude,
      objectTarget?.anchor?.object_position?.altitude_m,
    ]);

    const targetOverlay = React.useMemo(() => {
      if (!objectTarget || !targetMetrics || !targetProjection) return null;
      if (displayRect.width <= 0 || displayRect.height <= 0) return null;
      const px = targetProjection.screen.x * displayRect.width;
      const py = targetProjection.screen.y * displayRect.height;
      const clampedX = Math.max(0, Math.min(displayRect.width, px));
      const clampedY = Math.max(0, Math.min(displayRect.height, py));
      const angleRad = Math.atan2(
        targetProjection.normalized.y,
        targetProjection.normalized.x,
      );

      const projectionMode = projectionModeStore.getMode();
      const sdkPoint = liveViewPoint;
      const sdkNormX = sdkPoint?.x ?? null;
      const sdkNormY = sdkPoint?.y ?? null;
      const sdkDisplayX =
        sdkNormX != null ? sdkNormX * displayRect.width : null;
      const sdkDisplayY =
        sdkNormY != null ? sdkNormY * displayRect.height : null;
      const fallback = fallbackProjection;

      // Decision logic based on projection mode
      let finalNormX, finalNormY, rawDisplayX, rawDisplayY;

      if (projectionMode === "fallback") {
        // Auto-Adjust mode: Always use manual fallback calculation
        finalNormX = fallback?.normX ?? targetProjection.screen.x;
        finalNormY = fallback?.normY ?? targetProjection.screen.y;
        rawDisplayX =
          fallback?.displayX ?? (targetProjection.inFrame ? px : clampedX);
        rawDisplayY =
          fallback?.displayY ?? (targetProjection.inFrame ? py : clampedY);
      } else {
        // Real or Horizontal modes: Use SDK if valid, otherwise use fallback
        if (sdkNormX != null && sdkNormY != null) {
          // SDK returned valid coordinates
          finalNormX = sdkNormX;
          finalNormY = sdkNormY;
          rawDisplayX = sdkDisplayX;
          rawDisplayY = sdkDisplayY;
        } else {
          // SDK returned invalid - use fallback
          finalNormX = fallback?.normX ?? targetProjection.screen.x;
          finalNormY = fallback?.normY ?? targetProjection.screen.y;
          rawDisplayX =
            fallback?.displayX ?? (targetProjection.inFrame ? px : clampedX);
          rawDisplayY =
            fallback?.displayY ?? (targetProjection.inFrame ? py : clampedY);
        }
      }

      const finalDisplayX = Number.isFinite(rawDisplayX)
        ? Math.max(0, Math.min(displayRect.width, rawDisplayX))
        : clampedX;
      const finalDisplayY = Number.isFinite(rawDisplayY)
        ? Math.max(0, Math.min(displayRect.height, rawDisplayY))
        : clampedY;
      return {
        label: objectTarget.clusterLabel ?? objectTarget.clusterId,
        inFrame:
          sdkNormX != null && sdkNormY != null
            ? sdkNormX >= 0 && sdkNormX <= 1 && sdkNormY >= 0 && sdkNormY <= 1
            : (fallback?.inFrame ?? targetProjection.inFrame),
        x: px,
        y: py,
        displayX: finalDisplayX,
        displayY: finalDisplayY,
        angleDeg: (angleRad * 180) / Math.PI,
        distance: targetMetrics.slantDistance,
        altitudeDelta: targetMetrics.altitudeDelta,
        normX: finalNormX,
        normY: finalNormY,
        px,
        py,
        sdkNormX,
        sdkNormY,
        sdkValid: !!sdkPoint,
      };
    }, [
      objectTarget,
      targetMetrics,
      targetProjection,
      displayRect,
      liveViewPoint,
      fallbackProjection,
    ]);

    // Update display rect when container size or video dimensions change
    // Handle gimbal response messages from bridge
    useEffect(() => {
      const handleGimbalResponse = (responseData: any) => {
        //console.log('📡 Received H20N gimbal response:', responseData);
        //console.log('📡 DEBUG: H20N received ANY bridge message:', responseData?.type, responseData); // Debug: all bridge messages

        if (!responseData) {
          console.warn("⚠️ H20N received null/undefined bridge message");
          return;
        }

        if (responseData.type === "gimbal_response") {
          // Support both root-level and nested data payloads
          const payload: any = (responseData as any).data ?? responseData;
          const successRaw = (payload as any)?.success;
          const message = (payload as any)?.message;
          const coordinates = (payload as any)?.coordinates;
          const timestamp = (payload as any)?.timestamp;
          const ok =
            successRaw === true ||
            successRaw === "true" ||
            (!!message && /session (started|stopped)/i.test(String(message)));
          console.log("📡 Received H20N gimbal response:", responseData);

          // Update last gimbal command status
          setLastGimbalCommand({
            coordinates: (coordinates as any) || { x: 0, y: 0 },
            status: ok ? "SUCCESS" : "ERROR",
            message:
              message ||
              (ok ? "Gimbal moved successfully" : "Gimbal command failed"),
            timestamp: timestamp || Date.now(),
          });
          // On success, accelerate removal of recent click indicator (fade via cleanup)
          if (ok) {
            setClickIndicators((prev) =>
              prev.map((ind, idx) =>
                idx === prev.length - 1
                  ? { ...ind, status: "success", message: undefined }
                  : ind,
              ),
            );
          }

          // Update most recent pending indicator
          //setClickIndicators(prev => {
          //  const updated = [...prev];
          //  // Find the last pending indicator (reverse search)
          //  for (let i = updated.length - 1; i >= 0; i--) {
          //    if (updated[i].status === 'pending') {
          //      updated[i] = {
          //        ...updated[i],
          //        status: success ? 'success' : 'error',
          //        message: message
          //      };
          //      break;
          //    }
          //  }
          //  return updated;
          //});

          console.log(
            ok
              ? "✅ H20N Gimbal response: SUCCESS"
              : "❌ H20N Gimbal response: ERROR",
            message,
          ); // Essential gimbal log
        }

        if (responseData.type === "camera_laser_result") {
          const p: any = (responseData as any).data ?? responseData;
          const inner: any = (p as any).data ?? p;
          const dist =
            typeof inner?.distance_m === "number"
              ? (inner.distance_m as number)
              : undefined;
          const text =
            dist && dist > 0 ? `LRF ${dist.toFixed(1)} m` : "LRF min 3m";
          setLaserReadout({ text, timestamp: Date.now() });
          setLastLaserResult(inner);
          if (laserHideTimerRef.current) {
            window.clearTimeout(laserHideTimerRef.current);
            laserHideTimerRef.current = null;
          }
          laserHideTimerRef.current = window.setTimeout(() => {
            setLaserReadout(null);
            laserHideTimerRef.current = null;
          }, 3000);
        }
      };

      // Listen for bridge messages (including gimbal and laser responses)
      if ((window as any).electronAPI?.onBridgeData) {
        (window as any).electronAPI.onBridgeData((data: any) => {
          handleGimbalResponse(data);
          if (data?.type === "camera_laser_result") {
            console.log("[LASER] Result:", data);
          }
        });
      } else {
        console.warn(
          "⚠️ electronAPI.onBridgeData not available for H20N gimbal response handling",
        ); // Essential bridge log
      }

      return () => {
        // no-op cleanup to avoid removing shared bridge listeners
      };
    }, []);

    // Cleanup old click indicators after 5 seconds
    useEffect(() => {
      const cleanup = setInterval(() => {
        const now = Date.now();
        setClickIndicators((prev) =>
          prev.filter((indicator) => now - indicator.timestamp < 50),
        );
      }, 200);

      return () => clearInterval(cleanup);
    }, []);

    // Update display rect when container size or video dimensions change
    useEffect(() => {
      calculateDisplayRect();

      const resizeObserver = new ResizeObserver(() => {
        calculateDisplayRect();
      });

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      return () => resizeObserver.disconnect();
    }, [videoDimensions]);

    // H.264 NAL unit parsing helpers
    const parseH264NALUnits = (data: Uint8Array) => {
      const nalUnits: { type: number; data: Uint8Array }[] = [];
      let offset = 0;

      while (offset < data.length - 4) {
        // Look for start code (0x00 0x00 0x00 0x01)
        if (
          data[offset] === 0x00 &&
          data[offset + 1] === 0x00 &&
          data[offset + 2] === 0x00 &&
          data[offset + 3] === 0x01
        ) {
          // Found start code, find the next one
          let nextOffset = offset + 4;
          while (nextOffset < data.length - 3) {
            if (
              data[nextOffset] === 0x00 &&
              data[nextOffset + 1] === 0x00 &&
              data[nextOffset + 2] === 0x00 &&
              data[nextOffset + 3] === 0x01
            ) {
              break;
            }
            nextOffset++;
          }

          if (nextOffset > offset + 4) {
            const nalData = data.slice(offset + 4, nextOffset);
            const nalType = nalData[0] & 0x1f;
            nalUnits.push({ type: nalType, data: nalData });
          }

          offset = nextOffset;
        } else {
          offset++;
        }
      }

      return nalUnits;
    };

    const isKeyFrame = (nalUnits: { type: number; data: Uint8Array }[]) => {
      // NAL unit types: 1=P, 5=IDR (keyframe), 7=SPS, 8=PPS
      return nalUnits.some((nal) => nal.type === 5); // IDR frame
    };

    const extractConfigData = (
      nalUnits: { type: number; data: Uint8Array }[],
    ) => {
      const sps = nalUnits.find((nal) => nal.type === 7)?.data;
      const pps = nalUnits.find((nal) => nal.type === 8)?.data;
      return { sps, pps };
    };

    useEffect(() => {
      let cleanup: (() => void) | undefined;

      const clearDecoderRestartTimer = () => {
        if (decoderRestartTimerRef.current !== null) {
          window.clearTimeout(decoderRestartTimerRef.current);
          decoderRestartTimerRef.current = null;
        }
      };

      const destroyDecoder = () => {
        const decoder = videoDecoderRef.current;
        videoDecoderRef.current = null;
        decoderConfiguredRef.current = false;
        spsRef.current = null;
        ppsRef.current = null;

        if (decoder) {
          try {
            const flushResult = decoder.flush();
            if (
              flushResult &&
              typeof (flushResult as Promise<void>).then === "function"
            ) {
              (flushResult as Promise<void>)
                .catch(() => undefined)
                .finally(() => {
                  try {
                    decoder.close();
                  } catch {}
                });
            } else {
              decoder.close();
            }
          } catch {
            try {
              decoder.close();
            } catch {}
          }
        }

        offscreenCanvasRef.current = null;
        offscreenCtxRef.current = null;
      };

      const teardownAll = () => {
        cleanup?.();
        clearDecoderRestartTimer();
        destroyDecoder();
        window.electronAPI.removeAllListeners("secondary-video-frame");
      };

      if (simulatorActive) {
        teardownAll();
        setFrameStats({ frames: 0, totalBytes: 0, lastFrame: 0, decodedFrames: 0 });
        setVideoStatus("simulator");
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (canvas && ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        return () => {
          teardownAll();
        };
      }

      const scheduleDecoderRestart = (label: string, delayMs?: number) => {
        destroyDecoder();
        const attempts = decoderRestartAttemptsRef.current;
        const computedDelay =
          delayMs ?? Math.min(2000, 250 * Math.pow(2, Math.min(attempts, 4)));
        decoderRestartAttemptsRef.current = attempts + 1;

        if (decoderRestartTimerRef.current !== null) {
          return;
        }

        decoderRestartTimerRef.current = window.setTimeout(() => {
          decoderRestartTimerRef.current = null;
          setupVideoDecoder();
        }, computedDelay);
        console.warn(
          `[H20N] Scheduling decoder restart (${label}) in ${computedDelay}ms (attempt ${attempts + 1})`,
        );
      };

      // Check if WebCodecs is supported
      const checkWebCodecsSupport = async () => {
        if (typeof VideoDecoder === "undefined") {
          // console.warn('WebCodecs not supported in this environment');
          setDecoderSupported(false);
          setVideoStatus("error");
          return false;
        }

        try {
          const support = await VideoDecoder.isConfigSupported({
            codec: "avc1.42E01E", // H.264 Baseline Profile
          });

          if (support.supported) {
            console.log("✅ H20N H.264 WebCodecs decoding supported"); // Essential initialization log
            setDecoderSupported(true);
            return true;
          } else {
            // console.warn('❌ H.264 WebCodecs decoding not supported for H20N');
            setDecoderSupported(false);
            setVideoStatus("error");
            return false;
          }
        } catch (error) {
          console.error("Error checking H20N WebCodecs support:", error); // Essential initialization log
          setDecoderSupported(false);
          setVideoStatus("error");
          return false;
        }
      };

      // Set up WebCodecs H.264 decoder
      const setupVideoDecoder = async () => {
        if (!canvasRef.current) return;
        if (!(await checkWebCodecsSupport())) return;

        clearDecoderRestartTimer();

        try {
          const canvas = canvasRef.current;
          const ctx = canvas.getContext("2d");

          if (!ctx) {
            throw new Error("Failed to get canvas context");
          }

          // Create offscreen canvas for double buffering
          offscreenCanvasRef.current = new OffscreenCanvas(1920, 1080);
          offscreenCtxRef.current = offscreenCanvasRef.current.getContext("2d");

          if (!offscreenCtxRef.current) {
            throw new Error("Failed to get offscreen canvas context");
          }

          // Create the decoder (but don't configure until we have SPS/PPS)
          videoDecoderRef.current = new VideoDecoder({
            output: (frame: VideoFrame) => {
              try {
                // Update video dimensions if changed
                if (
                  videoDimensions.width !== frame.codedWidth ||
                  videoDimensions.height !== frame.codedHeight
                ) {
                  setVideoDimensions({
                    width: frame.codedWidth,
                    height: frame.codedHeight,
                  });
                }

                // Resize offscreen canvas if needed
                const offscreenCanvas = offscreenCanvasRef.current;
                const offscreenCtx = offscreenCtxRef.current;

                if (!offscreenCanvas || !offscreenCtx) {
                  frame.close();
                  return;
                }

                if (
                  offscreenCanvas.width !== frame.codedWidth ||
                  offscreenCanvas.height !== frame.codedHeight
                ) {
                  offscreenCanvas.width = frame.codedWidth;
                  offscreenCanvas.height = frame.codedHeight;
                }

                // Draw frame to offscreen canvas (back buffer)
                offscreenCtx.clearRect(
                  0,
                  0,
                  offscreenCanvas.width,
                  offscreenCanvas.height,
                );
                offscreenCtx.drawImage(frame, 0, 0);

                // Now atomically copy the complete frame to the visible canvas (front buffer)
                if (
                  canvas.width !== frame.codedWidth ||
                  canvas.height !== frame.codedHeight
                ) {
                  canvas.width = frame.codedWidth;
                  canvas.height = frame.codedHeight;
                }

                // This is atomic - no flicker
                ctx.drawImage(offscreenCanvas, 0, 0);

                frame.close();

                // Update stats and immediately set to playing state
                setFrameStats((prev) => {
                  const newFrameCount = prev.decodedFrames + 1;
                  // Change to playing state immediately on first decoded frame
                  if (newFrameCount === 1) {
                    setVideoStatus("playing");
                  }
                  return {
                    ...prev,
                    decodedFrames: newFrameCount,
                  };
                });
              } catch (error) {
                console.error("Error drawing video frame in H20N:", error);
                frame.close();
              }
            },
            error: (error: Error) => {
              console.error("H20N VideoDecoder error:", error);
              console.error(
                "H20N Decoder state:",
                videoDecoderRef.current?.state,
              );
              console.error("H20N Error details:", {
                name: error.name,
                message: error.message,
                stack: error.stack,
              });
              setVideoStatus("error");
              // Reset decoder state on error
              decoderConfiguredRef.current = false;

              // Reset SPS/PPS to force reconfiguration
              spsRef.current = null;
              ppsRef.current = null;

              // Trigger decoder recreation after a short delay
              scheduleDecoderRestart("decoder-error", 500);
            },
          });

          decoderRestartAttemptsRef.current = 0;

          setVideoStatus("loading");

          cleanup = () => {
            destroyDecoder();
            clearDecoderRestartTimer();
          };
        } catch (error) {
          console.error("Failed to set up H20N video decoder:", error);
          setVideoStatus("error");
        }
      };

      // Handle incoming video frames - uses onSecondaryVideoFrame for secondary camera
      const handleVideoFrame = (frameInfo: any) => {
        // ENHANCED VALIDATION - prevent frame mixing between streams
        if (!frameInfo) {
          //console.warn('🎥 H20N: Received null frameInfo - keeping current frame');
          return;
        }

        // Handle new format: { metadata: {...}, data: Buffer }
        const frameData = frameInfo.data;
        const metadata = frameInfo.metadata;

        // STRICT VALIDATION - reject frames without proper metadata
        if (!frameData) {
          //console.warn('🎥 H20N: Received video frame without data - keeping current frame');
          return;
        }

        if (!metadata) {
          //console.warn('🎥 H20N: Received binary data without metadata - dropping frame to prevent corruption');
          setDroppedFrameCount((prev) => prev + 1);
          return; // This prevents the mixing issue you're seeing
        }

        // Verify this frame is actually for secondary camera (H20N)
        if (metadata.camera_source && metadata.camera_source !== "secondary") {
          //console.warn(`🎥 H20N: Received frame for wrong stream (${metadata.camera_source}) - dropping frame`);
          setDroppedFrameCount((prev) => prev + 1);
          return; // Don't process frames meant for FPV camera
        }

        // Additional metadata validation
        if (!metadata.frameNumber && metadata.frameNumber !== 0) {
          //console.warn('🎥 H20N: Frame metadata missing frameNumber - dropping frame');
          setDroppedFrameCount((prev) => prev + 1);
          return;
        }

        // Validate frame size matches expected data
        if (metadata.frameSize && frameData.length !== metadata.frameSize) {
          //console.warn(`🎥 H20N: Frame size mismatch - expected ${metadata.frameSize}, got ${frameData.length} - dropping frame`);
          setDroppedFrameCount((prev) => prev + 1);
          return;
        }

        //console.log(`🎥 H20N: Processing validated frame ${metadata.frameNumber} (${frameData.length} bytes)`);

        // Update frame statistics and status
        const now = Date.now();
        setFrameStats((prev) => ({
          frames: prev.frames + 1,
          totalBytes: prev.totalBytes + frameData.length,
          lastFrame: now,
          decodedFrames: prev.decodedFrames,
        }));

        // Only update to 'receiving' if we're not already playing
        if (videoStatus === "waiting" || videoStatus === "loading") {
          setVideoStatus("receiving");
        }

        // Check if decoder exists
        if (!videoDecoderRef.current) {
          return;
        }

        try {
          // Convert data to Uint8Array for WebCodecs
          let h264Data: Uint8Array;

          if (frameData instanceof Uint8Array) {
            h264Data = frameData;
          } else if (frameData.buffer) {
            // Node.js Buffer (Electron)
            h264Data = new Uint8Array(
              frameData.buffer,
              frameData.byteOffset,
              frameData.byteLength,
            );
          } else {
            console.error(
              "Unsupported video data format in H20N:",
              typeof frameData,
            );
            return;
          }

          if (h264Data.length === 0) {
            console.warn("Empty video frame in H20N, skipping");
            return;
          }

          // Parse NAL units
          const nalUnits = parseH264NALUnits(h264Data);
          if (nalUnits.length === 0) {
            return;
          }

          // Extract config data (SPS/PPS) if present
          const { sps, pps } = extractConfigData(nalUnits);
          if (sps) {
            spsRef.current = sps;
          }
          if (pps) {
            ppsRef.current = pps;
          }

          // Configure decoder if we have SPS/PPS and haven't configured yet
          if (
            !decoderConfiguredRef.current &&
            spsRef.current &&
            ppsRef.current &&
            videoDecoderRef.current
          ) {
            // Check if decoder exists and is not closed
            if (videoDecoderRef.current.state === "closed") {
              console.log(
                "H20N Decoder is closed, skipping configuration until recreated",
              );
              return;
            }

            const sps = spsRef.current;
            const pps = ppsRef.current;
            const configData = new Uint8Array(sps.length + pps.length);
            let offset = 0;
            configData.set(sps, offset);
            offset += sps.length;
            configData.set(pps, offset);

            try {
              // Extract actual codec string from SPS
              const profile = sps[1]
                .toString(16)
                .padStart(2, "0")
                .toUpperCase();
              const constraints = sps[2]
                .toString(16)
                .padStart(2, "0")
                .toUpperCase();
              const level = sps[3].toString(16).padStart(2, "0").toUpperCase();
              const codecString = `avc1.${profile}${constraints}${level}`;

              // Try configuration without description first (simpler approach)
              try {
                videoDecoderRef.current.configure({
                  codec: codecString,
                });
              } catch (simpleError) {
                // Fallback to configuration with description
                videoDecoderRef.current.configure({
                  codec: codecString,
                  description: configData,
                });
              }

              decoderConfiguredRef.current = true;
            } catch (error) {
              console.error("❌ Failed to configure H20N decoder:", error);
              decoderConfiguredRef.current = false;
              setVideoStatus("error");
              return;
            }
          }

          // Skip if decoder not configured or closed
          if (
            !decoderConfiguredRef.current ||
            !videoDecoderRef.current ||
            videoDecoderRef.current.state !== "configured"
          ) {
            if (
              videoDecoderRef.current &&
              videoDecoderRef.current.state === "closed"
            ) {
              console.log("H20N Decoder closed, triggering recreation");
              decoderConfiguredRef.current = false;
              scheduleDecoderRestart("decoder-closed", 120);
            }
            return;
          }

          // Determine if this is a keyframe
          const isKey = isKeyFrame(nalUnits);

          // Skip non-key frames if decoder just configured (wait for next I-frame)
          if (!isKey && videoStatus === "decoding") {
            return;
          }

          // Create EncodedVideoChunk for WebCodecs
          try {
            const chunk = new EncodedVideoChunk({
              type: isKey ? "key" : "delta",
              timestamp: now * 1000, // Convert to microseconds
              data: h264Data,
            });

            // Only set to 'decoding' if we're not already playing or have decoded frames
            setFrameStats((prev) => {
              if (prev.decodedFrames === 0 && videoStatus !== "playing") {
                setVideoStatus("decoding");
              }
              return prev;
            });

            videoDecoderRef.current.decode(chunk);
          } catch (decodeError) {
            console.error("H20N Decode error:", decodeError);
            console.error("H20N Decode error details:", {
              name: decodeError.name,
              message: decodeError.message,
              decoderState: videoDecoderRef.current?.state,
            });

            // If this was a key frame and it failed, reset the decoder
            if (isKey) {
              console.log("H20N Key frame decode failed, resetting decoder...");
              decoderConfiguredRef.current = false;
              spsRef.current = null;
              ppsRef.current = null;
              scheduleDecoderRestart("keyframe-decode-failed", 150);
            }
          }
        } catch (error) {
          console.error("Failed to decode H20N video frame:", error);
          setVideoStatus("error");
          // Reset decoder state on error
          decoderConfiguredRef.current = false;
        }
      };

      setVideoStatus((prev) => (prev === "simulator" ? "waiting" : prev));
      setupVideoDecoder();

      // Listen for secondary video frames from main process
      (window.electronAPI as any).onSecondaryVideoFrame(handleVideoFrame);

      return () => {
        teardownAll();
      };
    }, []);

    const getStatusOverlay = () => {
      switch (videoStatus) {
        case "waiting":
          return (
            <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4">📹</div>
                <div className="text-lg text-gray-300">
                  Waiting for H20N Stream
                </div>
                <div className="text-sm text-gray-500 mt-2">
                  Secondary camera (gimbal/H20N)
                </div>
              </div>
            </div>
          );

        case "loading":
          return (
            <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4">📹</div>
                <div className="text-sm text-gray-400">H20N Display</div>
                <div className="text-xs text-gray-500 mt-2">
                  Secondary camera stream
                </div>
              </div>
            </div>
          );

        case "receiving":
          return (
            <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4 animate-pulse">📡</div>
                <div className="text-lg text-dji-blue">
                  Receiving H20N Stream
                </div>
                <div className="text-sm text-gray-400 mt-2">
                  {frameStats.frames} frames received
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Secondary camera decoder initializing...
                </div>
              </div>
            </div>
          );

        case "decoding":
          return (
            <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4 animate-pulse">🎬</div>
                <div className="text-lg text-dji-blue">
                  Decoding H20N Stream
                </div>
                <div className="text-sm text-gray-400 mt-2">
                  {frameStats.frames} received • {frameStats.decodedFrames}{" "}
                  decoded
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Secondary camera using WebCodecs
                </div>
              </div>
            </div>
          );

        case "error":
          const errorMessage =
            decoderSupported === false
              ? "WebCodecs not supported in this browser"
              : "Check bridge connection and H20N camera status";

          return (
            <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4 text-status-error">⚠️</div>
                <div className="text-lg text-status-error">
                  H20N Stream Error
                </div>
                <div className="text-sm text-gray-500 mt-2">{errorMessage}</div>
                {decoderSupported === false && (
                  <div className="text-xs text-gray-500 mt-2">
                    Try Chrome 94+ or Edge 94+ for WebCodecs support
                  </div>
                )}
              </div>
            </div>
          );

        case "simulator":
          return (
            <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
              <div className="text-center text-gray-300">
                <div className="text-4xl mb-3">🛈</div>
                <div className="text-lg">Simulator Mode</div>
                <div className="text-sm text-gray-500 mt-2">
                  H20N decoding paused while simulator is active
                </div>
              </div>
            </div>
          );

        case "playing":
        default:
          return null;
      }
    };

    return (
      <div ref={containerRef} className={`relative bg-dji-dark ${className}`}>
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          className="w-full h-full object-contain"
          style={{
            cursor:
              gimbalMode === "free_look"
                ? isFreeLookActive
                  ? "grabbing"
                  : "grab"
                : "crosshair",
          }}
        />

        {/* Gimbal Mode Toggle - default bottom-left */}
        <div className="absolute bottom-4 left-4 z-30 pointer-events-auto">
          <GimbalModeToggle
            mode={gimbalMode}
            onModeChange={setGimbalMode}
            isFreeLookActive={isFreeLookActive}
            freeLookVelocity={freeLookVelocity}
            sensitivity={sensitivity}
            smoothing={smoothing}
            onSensitivityChange={setSensitivity}
            onSmoothingChange={setSmoothing}
            selectedLens={selectedLens}
            onLensChange={(lens) => {
              setSelectedLens(lens);
              if ((window as any).electronAPI) {
                (window as any).electronAPI
                  .sendBridgeCommand({
                    type: "camera_select",
                    data: { lens },
                  })
                  .catch(() => {});
              }
            }}
            laserOn={laserOn}
            onToggleLaser={(on) => {
              setLaserOn(on);
              if ((window as any).electronAPI) {
                (window as any).electronAPI
                  .sendBridgeCommand({
                    type: "camera_laser_enable",
                    data: { enabled: on },
                  })
                  .catch(() => {});
              }
            }}
            zoomRatio={zoomValue}
            zoomRange={telemetryData?.camera_optics?.zoom_range}
            zoomEnabled={bridgeHasSendCommand}
            onZoomChange={handleZoomSliderChange}
          />
        </div>

        {/* Video content overlay area - matches actual video display rectangle */}
        <div
          className="absolute pointer-events-none"
          style={{
            left: `${displayRect.left}px`,
            top: `${displayRect.top}px`,
            width: `${displayRect.width}px`,
            height: `${displayRect.height}px`,
          }}
        >
          {targetOverlay && (
            <div className="absolute inset-0 pointer-events-none z-30">
              <div
                className="absolute"
                style={{
                  left: `${targetOverlay.displayX}px`,
                  top: `${targetOverlay.displayY}px`,
                }}
              >
                {targetOverlay.inFrame ? (
                  <div
                    className="w-4 h-4 rounded-full border border-sky-300 bg-sky-500/40 shadow-[0_0_6px_rgba(125,211,252,0.6)]"
                    style={{ transform: "translate(-50%, -50%)" }}
                  />
                ) : (
                  <div
                    className="w-0 h-0 border-l-[7px] border-r-[7px] border-b-[12px] border-l-transparent border-r-transparent border-b-sky-400 drop-shadow-[0_0_4px_rgba(125,211,252,0.7)]"
                    style={{
                      transform: `translate(-50%, -50%) rotate(${(targetOverlay.angleDeg ?? 0) + 90}deg)`,
                    }}
                  />
                )}
              </div>
              <div className="absolute top-2 left-2">
                <div className="inline-flex items-center gap-2 rounded bg-black/70 px-2 py-1 text-[10px] text-sky-200">
                  <span className="font-semibold text-sky-100">
                    {targetOverlay.label}
                  </span>
                  <span>
                    {Number.isFinite(targetOverlay.distance)
                      ? `${targetOverlay.distance.toFixed(1)} m`
                      : "—"}
                  </span>
                  {targetOverlay.altitudeDelta != null &&
                    Number.isFinite(targetOverlay.altitudeDelta) && (
                      <span>
                        Δalt {targetOverlay.altitudeDelta.toFixed(1)} m
                      </span>
                    )}
                  {Number.isFinite(targetOverlay.normX) &&
                    Number.isFinite(targetOverlay.normY) && (
                      <span>
                        screen ({targetOverlay.normX.toFixed(3)},{" "}
                        {targetOverlay.normY.toFixed(3)})
                      </span>
                    )}
                  {Number.isFinite(targetOverlay.px) &&
                    Number.isFinite(targetOverlay.py) && (
                      <span>
                        {Math.round(targetOverlay.px)}px ×{" "}
                        {Math.round(targetOverlay.py)}px
                      </span>
                    )}
                  {Number.isFinite(targetOverlay.sdkNormX ?? NaN) &&
                    Number.isFinite(targetOverlay.sdkNormY ?? NaN) && (
                      <span>
                        sdk ({targetOverlay.sdkNormX!.toFixed(3)},{" "}
                        {targetOverlay.sdkNormY!.toFixed(3)})
                      </span>
                    )}
                  {targetOverlay.sdkValid === false && (
                    <span className="text-red-300">sdk invalid</span>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* Click indicators for gimbal tap targets */}
          {clickIndicators.map((indicator) => (
            <div
              key={indicator.id}
              className="absolute pointer-events-none"
              style={{
                left: `${(indicator.x / (displayRect.width || 1)) * 100}%`,
                top: `${(indicator.y / (displayRect.height || 1)) * 100}%`,
                transform: "translate(-50%, -50%)",
              }}
            >
              {/* Crosshair indicator */}
              <div
                className={`
                  w-8 h-8 border-2 rounded-full flex items-center justify-center
                  ${indicator.status === "pending" ? "border-yellow-500 bg-yellow-500 bg-opacity-20" : ""}
                  ${indicator.status === "success" ? "border-green-500 bg-green-500 bg-opacity-20" : ""}
                  ${indicator.status === "error" ? "border-red-500 bg-red-500 bg-opacity-20" : ""}
                  ${indicator.status === "pending" ? "animate-pulse" : ""}
                `}
              >
                <div className="w-1 h-1 bg-current rounded-full"></div>
              </div>

              {/* Status message */}
              {indicator.message && (
                <div
                  className={`
                    absolute top-10 left-1/2 transform -translate-x-1/2 
                    px-2 py-1 rounded text-xs font-mono whitespace-nowrap
                    ${indicator.status === "success" ? "bg-green-900 text-green-100" : ""}
                    ${indicator.status === "error" ? "bg-red-900 text-red-100" : ""}
                    ${indicator.status === "pending" ? "bg-yellow-900 text-yellow-100" : ""}
                  `}
                >
                  {indicator.message}
                </div>
              )}
            </div>
          ))}

          {/* Agent detections overlay */}
          {agentDetections.map((d, idx) => {
            const x = d.x1 * (displayRect.width || 1);
            const y = d.y1 * (displayRect.height || 1);
            const w = (d.x2 - d.x1) * (displayRect.width || 1);
            const h = (d.y2 - d.y1) * (displayRect.height || 1);
            return (
              <div
                key={`det-${idx}`}
                className="absolute border border-emerald-400"
                style={{ left: x, top: y, width: w, height: h }}
              >
                <div className="absolute -top-5 left-0 bg-emerald-600 text-[10px] px-1 rounded text-white">
                  {d.label || "det"}
                  {d.score ? ` ${(d.score * 100).toFixed(0)}%` : ""}
                </div>
              </div>
            );
          })}

          {/* Label anti-collision system */}
          {(() => {
            // Collect all labels that need to be placed
            const allLabels: Array<{
              type: "mask" | "detection";
              idx: number;
              x: number;
              y: number;
              w: number;
              h: number;
              label: string;
              color: string;
              score?: number;
              globalId: number;
            }> = [];

            // Global ID counter for unique colors across ALL objects
            let globalIdCounter = 0;

            // Add mask labels
            visionMasks.forEach((m: Mask, idx: number) => {
              const pts = (m.points || []).map((p) => ({
                x: p.x * (displayRect.width || 1),
                y: p.y * (displayRect.height || 1),
              }));
              if (!pts.length || !m.label) return;
              const xs = pts.map((p) => p.x),
                ys = pts.map((p) => p.y);
              const x = Math.min(...xs),
                y = Math.min(...ys);
              const w = Math.max(...xs) - x;
              const h = Math.max(...ys) - y;

              // Extended palette with more distinct colors
              const palette = [
                "#10B981",
                "#60A5FA",
                "#F59E0B",
                "#EF4444",
                "#8B5CF6",
                "#14B8A6",
                "#F472B6",
                "#22C55E",
                "#FBBF24",
                "#A78BFA",
                "#34D399",
                "#FB7185",
                "#94A3B8",
                "#C084FC",
                "#2DD4BF",
                "#FCA5A5",
              ];

              // Use track_id from server for persistent tracking colors
              const colorIndex =
                (m as any).track_id !== undefined
                  ? (m as any).track_id
                  : globalIdCounter;
              const color = colorizeById
                ? palette[colorIndex % palette.length]
                : "#10B981";

              allLabels.push({
                type: "mask",
                idx,
                x,
                y,
                w,
                h,
                label: m.label,
                color,
                globalId: globalIdCounter++,
              });
            });

            // Add detection labels
            visionDetections.forEach((d, idx) => {
              const x = d.x1 * (displayRect.width || 1);
              const y = d.y1 * (displayRect.height || 1);
              const w = (d.x2 - d.x1) * (displayRect.width || 1);
              const h = (d.y2 - d.y1) * (displayRect.height || 1);

              // Extended palette with more distinct colors
              const palette = [
                "#10B981",
                "#60A5FA",
                "#F59E0B",
                "#EF4444",
                "#8B5CF6",
                "#14B8A6",
                "#F472B6",
                "#22C55E",
                "#FBBF24",
                "#A78BFA",
                "#34D399",
                "#FB7185",
                "#94A3B8",
                "#C084FC",
                "#2DD4BF",
                "#FCA5A5",
              ];

              // Use track_id from server for persistent tracking colors
              const colorIndex =
                d.track_id !== undefined ? d.track_id : globalIdCounter;
              const color = colorizeById
                ? palette[colorIndex % palette.length]
                : "#10B981";

              allLabels.push({
                type: "detection",
                idx,
                x,
                y,
                w,
                h,
                label: d.label || "obj",
                color,
                score: d.score,
                globalId: globalIdCounter++,
              });
            });

            // Place labels with anti-collision
            const placedLabels: Array<{
              x: number;
              y: number;
              w: number;
              h: number;
            }> = [];

            // Add all bounding boxes and masks to collision list
            const occupiedAreas: Array<{
              x: number;
              y: number;
              w: number;
              h: number;
            }> = [];

            // Add all detection boxes to occupied areas
            allLabels.forEach((item) => {
              occupiedAreas.push({
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
              });
            });

            const getLabelDimensions = (text: string) => {
              // Estimate label dimensions based on text length (approximation)
              const charWidth = 6; // Approximate width per character at text-[10px]
              const padding = 8; // px-1 = 4px each side
              const height = 16; // Height of label box
              const width = text.length * charWidth + padding;
              return { width, height };
            };

            const checkCollision = (
              x: number,
              y: number,
              w: number,
              h: number,
            ) => {
              // Check collision with other labels
              const labelCollision = placedLabels.some(
                (label) =>
                  !(
                    x + w <= label.x ||
                    x >= label.x + label.w ||
                    y + h <= label.y ||
                    y >= label.y + label.h
                  ),
              );

              // Check collision with bounding boxes and masks
              const boxCollision = occupiedAreas.some(
                (area) =>
                  !(
                    x + w <= area.x ||
                    x >= area.x + area.w ||
                    y + h <= area.y ||
                    y >= area.y + area.h
                  ),
              );

              return labelCollision || boxCollision;
            };

            const findNonCollidingPosition = (
              boxX: number,
              boxY: number,
              boxW: number,
              boxH: number,
              labelW: number,
              labelH: number,
            ): { x: number; y: number; position: string } => {
              // Extended positions for crowded scenes
              const spacing = 2;
              const positions = [
                // Primary positions
                { x: boxX, y: boxY - labelH - spacing, position: "above" },
                { x: boxX, y: boxY + boxH + spacing, position: "below" },
                { x: boxX - labelW - spacing, y: boxY, position: "left" },
                { x: boxX + boxW + spacing, y: boxY, position: "right" },
                // Corners
                {
                  x: boxX + boxW - labelW,
                  y: boxY - labelH - spacing,
                  position: "above-right",
                },
                {
                  x: boxX + boxW - labelW,
                  y: boxY + boxH + spacing,
                  position: "below-right",
                },
                {
                  x: boxX - labelW - spacing,
                  y: boxY + boxH - labelH,
                  position: "left-bottom",
                },
                {
                  x: boxX + boxW + spacing,
                  y: boxY + boxH - labelH,
                  position: "right-bottom",
                },
                // Mid-aligned positions
                {
                  x: boxX + (boxW - labelW) / 2,
                  y: boxY - labelH - spacing,
                  position: "above-center",
                },
                {
                  x: boxX + (boxW - labelW) / 2,
                  y: boxY + boxH + spacing,
                  position: "below-center",
                },
                {
                  x: boxX - labelW - spacing,
                  y: boxY + (boxH - labelH) / 2,
                  position: "left-center",
                },
                {
                  x: boxX + boxW + spacing,
                  y: boxY + (boxH - labelH) / 2,
                  position: "right-center",
                },
                // Additional positions with more spacing for crowded scenes
                {
                  x: boxX,
                  y: boxY - labelH - spacing * 4,
                  position: "above-far",
                },
                {
                  x: boxX,
                  y: boxY + boxH + spacing * 4,
                  position: "below-far",
                },
                {
                  x: boxX - labelW - spacing * 4,
                  y: boxY,
                  position: "left-far",
                },
                {
                  x: boxX + boxW + spacing * 4,
                  y: boxY,
                  position: "right-far",
                },
                // Diagonal positions
                {
                  x: boxX - labelW - spacing * 3,
                  y: boxY - labelH - spacing * 3,
                  position: "top-left-diag",
                },
                {
                  x: boxX + boxW + spacing * 3,
                  y: boxY - labelH - spacing * 3,
                  position: "top-right-diag",
                },
                {
                  x: boxX - labelW - spacing * 3,
                  y: boxY + boxH + spacing * 3,
                  position: "bottom-left-diag",
                },
                {
                  x: boxX + boxW + spacing * 3,
                  y: boxY + boxH + spacing * 3,
                  position: "bottom-right-diag",
                },
              ];

              // Find first non-colliding position
              for (const pos of positions) {
                // Ensure label stays within display bounds
                if (
                  pos.x < 0 ||
                  pos.y < 0 ||
                  pos.x + labelW > (displayRect.width || 0) ||
                  pos.y + labelH > (displayRect.height || 0)
                ) {
                  continue;
                }

                if (!checkCollision(pos.x, pos.y, labelW, labelH)) {
                  return pos;
                }
              }

              // Fallback to original position (above or below based on y position)
              return boxY > 14
                ? { x: boxX, y: boxY - labelH - 2, position: "above" }
                : { x: boxX, y: boxY + boxH + 2, position: "below" };
            };

            return (
              <>
                {/* Heatmap overlay (LockTrack) */}
                {visionHeatmap && (
                  <img
                    src={visionHeatmap}
                    alt="heatmap"
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: displayRect.width,
                      height: displayRect.height,
                      opacity: Math.max(0, Math.min(1, visionHeatmapOpacity)),
                      pointerEvents: "none",
                      zIndex: 9,
                    }}
                  />
                )}

                {/* Vision segmentation overlay */}
                <svg
                  width={displayRect.width}
                  height={displayRect.height}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    pointerEvents: "none",
                    zIndex: 10,
                  }}
                >
                  {visionMasks.map((m: Mask, idx: number) => {
                    const pts = (m.points || []).map((p) => ({
                      x: p.x * (displayRect.width || 1),
                      y: p.y * (displayRect.height || 1),
                    }));
                    // Find the corresponding label to get its color
                    const labelItem = allLabels.find(
                      (l) => l.type === "mask" && l.idx === idx,
                    );
                    const color = labelItem ? labelItem.color : "#10B981";
                    return (
                      <g key={`h20n-mask-${idx}`}>
                        <polygon
                          points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
                          fill={color}
                          fillOpacity={maskOpacity}
                          stroke={color}
                          strokeOpacity={maskOpacity}
                          strokeWidth={1}
                        />
                      </g>
                    );
                  })}
                </svg>

                {/* Vision detections boxes */}
                {visionDetections.map((d, idx) => {
                  const x = d.x1 * (displayRect.width || 1);
                  const y = d.y1 * (displayRect.height || 1);
                  const w = (d.x2 - d.x1) * (displayRect.width || 1);
                  const h = (d.y2 - d.y1) * (displayRect.height || 1);
                  // Find the corresponding label to get its color
                  const labelItem = allLabels.find(
                    (l) => l.type === "detection" && l.idx === idx,
                  );
                  const color = labelItem ? labelItem.color : "#10B981";
                  const borderRGBA = (hex: string, a: number) => {
                    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(
                      hex,
                    );
                    if (!m) return hex;
                    const r = parseInt(m[1], 16),
                      g = parseInt(m[2], 16),
                      b = parseInt(m[3], 16);
                    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
                  };
                  return (
                    <div
                      key={`vdet-box-${idx}`}
                      className="absolute z-10"
                      style={{
                        left: x,
                        top: y,
                        width: w,
                        height: h,
                        border: `${detectThickness}px solid ${borderRGBA(color, maskOpacity)}`,
                      }}
                    />
                  );
                })}

                {/* All labels with anti-collision */}
                {allLabels.map((item) => {
                  const labelText =
                    item.type === "detection" && item.score
                      ? `${item.label} ${(item.score * 100).toFixed(0)}%`
                      : item.label;

                  const labelDims = getLabelDimensions(labelText);
                  const labelPos = findNonCollidingPosition(
                    item.x,
                    item.y,
                    item.w,
                    item.h,
                    labelDims.width,
                    labelDims.height,
                  );

                  // Record this label's position
                  placedLabels.push({
                    x: labelPos.x,
                    y: labelPos.y,
                    w: labelDims.width,
                    h: labelDims.height,
                  });

                  return (
                    <div
                      key={`${item.type}-label-${item.idx}`}
                      className="absolute z-20 text-[10px] px-1 rounded text-white pointer-events-none"
                      style={{
                        left: labelPos.x,
                        top: labelPos.y,
                        background: item.color,
                      }}
                    >
                      {labelText}
                    </div>
                  );
                })}
              </>
            );
          })()}

          {/* Pose skeleton + keypoints overlay */}
          <svg
            width={displayRect.width}
            height={displayRect.height}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            {visionKeypoints.map((kp, i) => {
              const W = displayRect.width || 1;
              const H = displayRect.height || 1;
              const edges: Array<[number, number]> = [
                [5, 6],
                [5, 7],
                [7, 9],
                [6, 8],
                [8, 10],
                [5, 11],
                [6, 12],
                [11, 12],
                [11, 13],
                [13, 15],
                [12, 14],
                [14, 16],
                [0, 1],
                [0, 2],
                [1, 3],
                [2, 4],
              ];
              return (
                <g key={`h20n-pose-${i}`}>
                  {edges.map(([a, b], ei) => {
                    if (!kp[a] || !kp[b]) return null;
                    const x1 = kp[a].x * W,
                      y1 = kp[a].y * H;
                    const x2 = kp[b].x * W,
                      y2 = kp[b].y * H;
                    return (
                      <line
                        key={`h20n-edge-${i}-${ei}`}
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke="#22c55e"
                        strokeWidth={2}
                        strokeOpacity={0.8}
                      />
                    );
                  })}
                  {kp.map((p, j) => (
                    <circle
                      key={`h20n-pt-${i}-${j}`}
                      cx={p.x * W}
                      cy={p.y * H}
                      r={2.5}
                      fill="#22c55e"
                    />
                  ))}
                </g>
              );
            })}
          </svg>

          {/* Tiny HUD overlay near crosshair for Free Look */}
          {gimbalMode === "free_look" && isFreeLookActive && (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
              {/* Position slightly above center */}
              <div className="absolute -top-12 left-1/2 transform -translate-x-1/2">
                <div className="bg-purple-900 bg-opacity-90 px-2 py-1 rounded text-xs font-mono text-purple-100 flex items-center gap-2">
                  <span className="text-purple-300">FL</span>
                  <span>
                    {freeLookVelocity.vx.toFixed(1)},
                    {freeLookVelocity.vy.toFixed(1)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Laser readout near center crosshair */}
          {laserReadout && (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
              <div className="absolute -top-20 left-1/2 transform -translate-x-1/2">
                <div className="bg-black bg-opacity-70 px-2 py-1 rounded text-xs font-mono text-white">
                  {laserReadout.text}
                </div>
              </div>
            </div>
          )}

          {/* Only show error overlay when there's actually an error */}
          {videoStatus === "error" && getStatusOverlay()}

          {/* Video info overlay - always show when we have frames */}
          {frameStats.decodedFrames > 0 && (
            <div className="absolute top-4 right-4 glass-panel p-2 text-xs">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full animate-pulse-blue ${
                    droppedFrameCount < 5
                      ? "bg-status-good"
                      : droppedFrameCount < 20
                        ? "bg-yellow-500"
                        : "bg-red-500"
                  }`}
                ></div>
                <span>LIVE H20N</span>
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {frameStats.decodedFrames}
                {droppedFrameCount > 0 && (
                  <div
                    className={`${droppedFrameCount < 5 ? "text-gray-500" : droppedFrameCount < 20 ? "text-yellow-400" : "text-red-400"}`}
                  >
                    {droppedFrameCount} dropped
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Gimbal debug panel */}
          {lastGimbalCommand && (
            <div className="absolute bottom-4 right-4 glass-panel p-3 text-xs font-mono">
              <div className="flex items-center gap-2 mb-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    lastGimbalCommand.status === "SUCCESS"
                      ? "bg-green-500"
                      : "bg-red-500"
                  }`}
                ></div>
                <span className="text-white font-semibold">GIMBAL STATUS</span>
              </div>

              <div className="space-y-1 text-gray-300">
                <div>
                  <span className="text-gray-500">Status: </span>
                  <span
                    className={
                      lastGimbalCommand.status === "SUCCESS"
                        ? "text-green-400"
                        : "text-red-400"
                    }
                  >
                    {lastGimbalCommand.status}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Target: </span>
                  <span className="text-blue-400">
                    ({lastGimbalCommand.coordinates.x.toFixed(3)},{" "}
                    {lastGimbalCommand.coordinates.y.toFixed(3)})
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Message: </span>
                  <span className="text-white text-xs">
                    {lastGimbalCommand.message}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Time: </span>
                  <span className="text-gray-400">
                    {new Date(lastGimbalCommand.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Camera settings overlay */}
          {false && (
            <div className="absolute bottom-4 left-4 glass-panel p-3 text-sm">
              <div className="flex items-center gap-4">
                <div>
                  <span className="text-gray-400">Camera: </span>
                  <span className="text-white">H20N</span>
                </div>
                <div>
                  <span className="text-gray-400">Source: </span>
                  <span className="text-white">Secondary</span>
                </div>
                <div>
                  <span className="text-gray-400">Lens: </span>
                  <span className="text-white">Zoom</span>
                </div>
                <div>
                  <span className="text-gray-400">Quality: </span>
                  <span className="text-white">4K</span>
                </div>
              </div>
            </div>
          )}

          {/* Instructions overlay when no gimbal command has been sent yet */}
          {!lastGimbalCommand &&
            frameStats.decodedFrames > 0 &&
            gimbalMode === "look_at" && (
              <div className="absolute bottom-4 right-4 glass-panel p-3 text-sm">
                <div className="text-center">
                  <div className="text-yellow-400 mb-1">🎯</div>
                  <div className="text-white text-xs">
                    Select gimbal mode to control camera
                  </div>
                  <div className="text-gray-400 text-xs mt-1">
                    Use toggle in top-left corner
                  </div>
                </div>
              </div>
            )}

          {/* HUD Overlay - Center of camera view */}
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-30">
            <CameraDisplay />
          </div>

          {/* Custom overlays passed as children */}
          {children}
        </div>
      </div>
    );
  },
);

H20NDisplay.displayName = "H20NDisplay";
