import React, {
  useRef,
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { FPVDisplayProps, TelemetryData } from "../types";
import type { Detection, Mask } from "../agent/visionClient";
import { FlightDisplay } from "./FlightDisplay";
import {
  objectMemoryTargetStore,
  type ObjectMemoryTargetSelection,
} from "../state/objectMemoryTargets";
import { computeTargetMetrics } from "../utils/objectMemoryTarget";
import { projectGeographicPointToScreen } from "../utils/rayProjection";
import { normalizeAngleDeg, shortestAngleDiffDeg } from "../utils/angleUtils";
import {
  registerLiveViewLocationListener,
  requestLiveViewLocation,
  type LiveViewPinPoint,
} from "../agent/cameraProjectionClient";
import { projectionModeStore } from "../state/projectionMode";
import { telemetryShallowEqual } from "../utils/telemetryCompare";
import { usePanelVisibility } from "../hooks/usePanelVisibility";
import { fpvCameraPanelControls } from "./CameraPanel";

export interface FPVDisplayRef {
  getSnapshot: () => Promise<string>;
}

const FPVDisplayComponent = (
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
  }: FPVDisplayProps,
  ref: React.ForwardedRef<FPVDisplayRef>,
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
    const [droppedFrameCount, setDroppedFrameCount] = useState<number>(0);
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
    const panelVisible = usePanelVisibility(
      fpvCameraPanelControls.isVisible,
      "fpvCameraPanelVisibilityChange",
    );
    const lastRenderTimeRef = useRef<number>(0);
    const frameIntervalRef = useRef<number>(16);
    const shouldThrottle = simulatorActive || !panelVisible;
    frameIntervalRef.current = shouldThrottle ? 200 : 16;

    // HUD toggle
    const [hudEnabled, setHudEnabled] = useState<boolean>(() => {
      try {
        const raw = localStorage.getItem("fpv.hud.enabled");
        if (raw) return JSON.parse(raw);
      } catch {}
      return true;
    });
    useEffect(() => {
      try {
        localStorage.setItem("fpv.hud.enabled", JSON.stringify(hudEnabled));
      } catch {}
    }, [hudEnabled]);
    const [hudTheme, setHudTheme] = useState<"classic" | "contrast">(() => {
      try {
        const raw = localStorage.getItem("fpv.hud.theme");
        if (raw === "contrast") return "contrast";
      } catch {}
      return "classic";
    });
    useEffect(() => {
      try {
        localStorage.setItem("fpv.hud.theme", hudTheme);
      } catch {}
    }, [hudTheme]);
    const toggleHudTheme = () =>
      setHudTheme((prev) => (prev === "contrast" ? "classic" : "contrast"));

    const [hudOverlayMode, setHudOverlayMode] = useState<
      "panel" | "inline" | "none"
    >(() => {
      try {
        const raw = localStorage.getItem("fpv.hud.overlay.mode");
        if (raw === "panel" || raw === "inline" || raw === "none") {
          return raw;
        }
      } catch {}
      return "inline";
    });
    useEffect(() => {
      try {
        localStorage.setItem("fpv.hud.overlay.mode", hudOverlayMode);
      } catch {}
    }, [hudOverlayMode]);

    const [hudOverlayOpacity, setHudOverlayOpacity] = useState<number>(() => {
      try {
        const raw = localStorage.getItem("fpv.hud.overlay.opacity");
        if (raw != null) {
          const parsed = parseFloat(raw);
          if (!Number.isNaN(parsed)) {
            return Math.min(Math.max(parsed, 0), 1);
          }
        }
      } catch {}
      return 0.35;
    });
    useEffect(() => {
      try {
        localStorage.setItem(
          "fpv.hud.overlay.opacity",
          hudOverlayOpacity.toString(),
        );
      } catch {}
    }, [hudOverlayOpacity]);

    const cycleHudOverlayMode = () => {
      setHudOverlayMode((prev) =>
        prev === "panel" ? "inline" : prev === "inline" ? "none" : "panel",
      );
    };

    useEffect(() => {
      const unsubscribe = objectMemoryTargetStore.subscribe(setObjectTarget);
      return unsubscribe;
    }, []);

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
      const { object_position: objectPos, object_map: extras } =
        objectTarget.anchor;
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
          cameraType: "fpv",
          cameraModel: "MAVIC3",
          baseFocalLength: 24,
          zoomRatioOverride: telemetryData.fpv_optics?.zoom_ratio ?? undefined,
        },
      );
    }, [telemetryData, objectTarget, videoDimensions]);

    const fallbackProjection = React.useMemo(() => {
      if (!telemetryData || !targetMetrics) return null;
      const optics = telemetryData.fpv_optics ?? telemetryData.camera_optics;
      const fovH = optics?.display_fov?.horizontal ?? 82;
      const fovV = optics?.display_fov?.vertical ?? 60;
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
        (g) => g.index === "FPV" || g.index === "LEFT_OR_MAIN",
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
      const position = objectTarget?.anchor?.object_position;
      if (!position) {
        setLiveViewPoint(null);
        return;
      }
      const { latitude, longitude, altitude_m } = position;
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        setLiveViewPoint(null);
        return;
      }
      const altitude = typeof altitude_m === "number" ? altitude_m : 0;
      const requestId = `fpv-${objectTarget?.clusterId ?? ""}`;
      const component = "FPV";

      const unsubscribe = registerLiveViewLocationListener((message) => {
        const msgComponent = message.component?.toUpperCase();
        if (msgComponent !== component) return;
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

      const updateProjection = () => {
        requestLiveViewLocation({
          latitude,
          longitude,
          altitude,
          component,
          requestId,
          source: "fpv_overlay",
        })?.catch(() => {
          // Ignore errors; fallback to local projection path
        });
      };

      updateProjection();
      const interval = window.setInterval(updateProjection, 500);

      return () => {
        window.clearInterval(interval);
        unsubscribe();
      };
    }, [
      objectTarget?.anchor?.object_position?.latitude,
      objectTarget?.anchor?.object_position?.longitude,
      objectTarget?.anchor?.object_position?.altitude_m,
      objectTarget?.clusterId,
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

    // Provide a snapshot of the current canvas as base64 JPEG
    const getSnapshot = async (): Promise<string> => {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Canvas not ready");
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("No 2D context");
      ctx.drawImage(canvas, 0, 0);
      return off.toDataURL("image/jpeg", 0.9);
    };

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        getSnapshot,
      }),
      [],
    );

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
        window.electronAPI.removeAllListeners("fpv-video-frame");
        lastRenderTimeRef.current = 0;
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
          `[FPV] Scheduling decoder restart (${label}) in ${computedDelay}ms (attempt ${attempts + 1})`,
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
            console.log("✅ FPV H.264 WebCodecs decoding supported"); // Essential initialization log
            setDecoderSupported(true);
            return true;
          } else {
            // console.warn('❌ H.264 WebCodecs decoding not supported');
            setDecoderSupported(false);
            setVideoStatus("error");
            return false;
          }
        } catch (error) {
          console.error("Error checking FPV WebCodecs support:", error); // Essential initialization log
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
                const interval = frameIntervalRef.current;
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                if (interval > 0 && now - lastRenderTimeRef.current < interval) {
                  frame.close();
                  return;
                }
                lastRenderTimeRef.current = now;

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
                // console.error('Error drawing video frame:', error);
                frame.close();
              }
            },
            error: (error: Error) => {
              console.error("FPV VideoDecoder error:", error); // Essential error log
              // console.error('Decoder state:', videoDecoderRef.current?.state);
              // console.error('Error details:', {
              //  name: error.name,
              //  message: error.message,
              //  stack: error.stack
              //});
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
          console.error("Failed to set up FPV video decoder:", error); // Essential error log
          setVideoStatus("error");
        }
      };

      // Handle incoming video frames - new format with metadata + binary data
      const handleVideoFrame = (frameInfo: any) => {
        // ENHANCED VALIDATION - prevent frame mixing between streams
        if (!frameInfo) {
          //console.warn('🎥 FPV: Received null frameInfo - keeping current frame');
          return;
        }

        // Handle new format: { metadata: {...}, data: Buffer }
        const frameData = frameInfo.data;
        const metadata = frameInfo.metadata;

        // STRICT VALIDATION - reject frames without proper metadata
        if (!frameData) {
          //console.warn('🎥 FPV: Received video frame without data - keeping current frame');
          return;
        }

        if (!metadata) {
          //console.warn('🎥 FPV: Received binary data without metadata - dropping frame to prevent corruption');
          setDroppedFrameCount((prev) => prev + 1);
          return; // This prevents the mixing issue you're seeing
        }

        // Verify this frame is actually for FPV camera
        if (metadata.camera_source && metadata.camera_source !== "fpv") {
          //console.warn(`🎥 FPV: Received frame for wrong stream (${metadata.camera_source}) - dropping frame`);
          setDroppedFrameCount((prev) => prev + 1);
          return; // Don't process frames meant for secondary camera
        }

        // Additional metadata validation
        if (!metadata.frameNumber && metadata.frameNumber !== 0) {
          //console.warn('🎥 FPV: Frame metadata missing frameNumber - dropping frame');
          setDroppedFrameCount((prev) => prev + 1);
          return;
        }

        // Validate frame size matches expected data
        if (metadata.frameSize && frameData.length !== metadata.frameSize) {
          //console.warn(`🎥 FPV: Frame size mismatch - expected ${metadata.frameSize}, got ${frameData.length} - dropping frame`);
          setDroppedFrameCount((prev) => prev + 1);
          return;
        }

        //console.log(`🎥 FPV: Processing validated frame ${metadata.frameNumber} (${frameData.length} bytes)`);

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
            // console.error('Unsupported video data format:', typeof frameData);
            return;
          }

          if (h264Data.length === 0) {
            // console.warn('Empty video frame, skipping');
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
              // console.log('Decoder is closed, skipping configuration until recreated');
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
              console.error("❌ Failed to configure FPV decoder:", error); // Essential error log
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
              // console.log('Decoder closed, triggering recreation');
              decoderConfiguredRef.current = false;
              scheduleDecoderRestart("decoder-closed", 120);
            }
            return;
          }

          // Determine if this is a keyframe
          const isKey = isKeyFrame(nalUnits);
          //console.log(`Frame type: ${isKey ? 'KEY' : 'DELTA'} frame`);

          // Skip non-key frames if decoder just configured (wait for next I-frame)
          if (!isKey && videoStatus === "decoding") {
            //console.log('Skipping P-frame, waiting for next I-frame after configuration');
            return;
          }

          // Create EncodedVideoChunk for WebCodecs
          try {
            //console.log(`Creating chunk: type=${isKey ? 'key' : 'delta'}, size=${h264Data.length}, timestamp=${now * 1000}`);
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

            //console.log(`Decoding chunk with decoder state: ${videoDecoderRef.current.state}`);
            videoDecoderRef.current.decode(chunk);
            //console.log('Decode call successful');
          } catch (decodeError) {
            console.error("FPV Decode error:", decodeError); // Essential error log
            // console.error('Decode error details:', {
            //  name: decodeError.name,
            //  message: decodeError.message,
            //  decoderState: videoDecoderRef.current?.state
            //});

            // If this was a key frame and it failed, reset the decoder
            if (isKey) {
              // console.log('Key frame decode failed, resetting decoder...');
              decoderConfiguredRef.current = false;
              spsRef.current = null;
              ppsRef.current = null;

              scheduleDecoderRestart("keyframe-decode-failed", 150);
            }
          }
        } catch (error) {
          console.error("Failed to decode FPV video frame:", error); // Essential error log
          setVideoStatus("error");
          // Reset decoder state on error
          decoderConfiguredRef.current = false;
        }
      };

      setVideoStatus((prev) => (prev === "simulator" ? "waiting" : prev));
      setupVideoDecoder();

      // Listen for FPV video frames from main process
      (window.electronAPI as any).onFPVVideoFrame(handleVideoFrame);

      return () => {
        teardownAll();
      };
    }, [simulatorActive]);

    const getStatusOverlay = () => {
      switch (videoStatus) {
        case "waiting":
          return (
            <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4">📹</div>
                <div className="text-lg text-gray-300">
                  Waiting for Video Stream
                </div>
                <div className="text-sm text-gray-500 mt-2">
                  Make sure camera is active on controller
                </div>
              </div>
            </div>
          );

        case "loading":
          return (
            <div className="absolute inset-0 bg-gray-900 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4">📹</div>
                <div className="text-sm text-gray-400">Video Display</div>
                <div className="text-xs text-gray-500 mt-2">
                  Phase 3B - H.264 streaming ready
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
                  Receiving H.264 Stream
                </div>
                <div className="text-sm text-gray-400 mt-2">
                  {frameStats.frames} frames received
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Waiting for decoder to be ready...
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
                  Decoding H.264 Stream
                </div>
                <div className="text-sm text-gray-400 mt-2">
                  {frameStats.frames} received • {frameStats.decodedFrames}{" "}
                  decoded
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Using WebCodecs API for hardware acceleration
                </div>
              </div>
            </div>
          );

        case "error":
          const errorMessage =
            decoderSupported === false
              ? "WebCodecs not supported in this browser"
              : "Check bridge connection and camera status";

          return (
            <div className="absolute inset-0 bg-dji-dark bg-opacity-80 flex items-center justify-center">
              <div className="text-center">
                <div className="text-4xl mb-4 text-status-error">⚠️</div>
                <div className="text-lg text-status-error">
                  Video Stream Error
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
                  Video decoding paused while simulator is active
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
        <canvas ref={canvasRef} className="w-full h-full object-contain" />
        {/* Video content overlay area - matches actual video display rectangle */}
        <div
          className="absolute"
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
          {/* Label anti-collision system for masks and detections */}
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
            const occupiedAreas: Array<{
              x: number;
              y: number;
              w: number;
              h: number;
            }> = [];

            // Add bounding boxes to occupied areas
            allLabels.forEach((item) => {
              occupiedAreas.push({
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
              });
            });

            // Add vision detection boxes to occupied areas
            visionDetections.forEach((d) => {
              const x = d.x1 * (displayRect.width || 1);
              const y = d.y1 * (displayRect.height || 1);
              const w = (d.x2 - d.x1) * (displayRect.width || 1);
              const h = (d.y2 - d.y1) * (displayRect.height || 1);
              occupiedAreas.push({ x, y, w, h });
            });

            // Add mask bounding boxes to occupied areas
            visionMasks.forEach((m) => {
              const pts = (m.points || []).map((p) => ({
                x: p.x * (displayRect.width || 1),
                y: p.y * (displayRect.height || 1),
              }));
              if (pts.length > 0) {
                const minX = Math.min(...pts.map((p) => p.x));
                const maxX = Math.max(...pts.map((p) => p.x));
                const minY = Math.min(...pts.map((p) => p.y));
                const maxY = Math.max(...pts.map((p) => p.y));
                occupiedAreas.push({
                  x: minX,
                  y: minY,
                  w: maxX - minX,
                  h: maxY - minY,
                });
              }
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

              // Check collision with occupied areas (boxes/masks)
              const areaCollision = occupiedAreas.some(
                (area) =>
                  !(
                    x + w <= area.x ||
                    x >= area.x + area.w ||
                    y + h <= area.y ||
                    y >= area.y + area.h
                  ),
              );

              return labelCollision || areaCollision;
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
                      <g key={`mask-${idx}`}>
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
                      key={`vision-box-${idx}`}
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
              // COCO-17 style skeleton edges
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
                <g key={`pose-${i}`}>
                  {edges.map(([a, b], ei) => {
                    if (!kp[a] || !kp[b]) return null;
                    const x1 = kp[a].x * W,
                      y1 = kp[a].y * H;
                    const x2 = kp[b].x * W,
                      y2 = kp[b].y * H;
                    return (
                      <line
                        key={`edge-${i}-${ei}`}
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
                      key={`pt-${i}-${j}`}
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

          {/* Agent detections overlay */}
          {agentDetections.map((d, idx) => {
            const x = d.x1 * (displayRect.width || 1);
            const y = d.y1 * (displayRect.height || 1);
            const w = (d.x2 - d.x1) * (displayRect.width || 1);
            const h = (d.y2 - d.y1) * (displayRect.height || 1);
            return (
              <div
                key={`agent-${idx}`}
                className="absolute border border-blue-400 z-10"
                style={{ left: x, top: y, width: w, height: h }}
              >
                <div className="absolute -top-5 left-0 bg-blue-600 text-[10px] px-1 rounded text-white">
                  {d.label || "obj"}
                  {d.score ? ` ${(d.score * 100).toFixed(0)}%` : ""}
                </div>
              </div>
            );
          })}
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
                <span>LIVE FPV</span>
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

          {/* Camera settings overlay */}
          <div className="absolute bottom-4 left-4 glass-panel p-3 text-sm">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-gray-400">Mode: </span>
                <span className="text-white">Video</span>
              </div>
              <div>
                <span className="text-gray-400">Lens: </span>
                <span className="text-white">Wide</span>
              </div>
              <div>
                <span className="text-gray-400">ISO: </span>
                <span className="text-white">AUTO</span>
              </div>
              <div>
                <span className="text-gray-400">Quality: </span>
                <span className="text-white">4K/60</span>
              </div>
              <div>
                <span className="text-gray-400">HUD: </span>
                <button
                  className={`px-2 py-0.5 rounded text-xs ${hudEnabled ? "bg-dji-blue text-white" : "bg-gray-700 text-gray-200"}`}
                  onClick={() => setHudEnabled((v) => !v)}
                >
                  {hudEnabled ? "On" : "Off"}
                </button>
              </div>
              <div>
                <span className="text-gray-400">Style: </span>
                <button
                  className={`px-2 py-0.5 rounded text-xs ${hudTheme === "contrast" ? "bg-status-good/20 text-status-good border border-status-good/60" : "bg-gray-700 text-gray-200"}`}
                  onClick={toggleHudTheme}
                >
                  {hudTheme === "contrast" ? "High Contrast" : "Classic"}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-400">Overlay:</span>
                <button
                  className={`px-2 py-0.5 rounded text-xs ${hudOverlayMode === "none" ? "bg-gray-700 text-gray-200" : "bg-dji-blue text-white"}`}
                  onClick={cycleHudOverlayMode}
                >
                  {hudOverlayMode === "panel"
                    ? "Panel"
                    : hudOverlayMode === "inline"
                      ? "Inline"
                      : "None"}
                </button>
                <label
                  className={`flex items-center gap-2 text-[11px] ${hudOverlayMode === "none" ? "text-gray-600" : "text-gray-300"}`}
                >
                  <span>Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    step={5}
                    value={Math.round(hudOverlayOpacity * 100)}
                    disabled={hudOverlayMode === "none"}
                    onChange={(event) => {
                      const raw = Number(event.target.value) / 100;
                      setHudOverlayOpacity(Math.min(Math.max(raw, 0), 1));
                    }}
                    className="h-1 w-24 accent-status-good"
                  />
                  <span className="w-10 text-right">
                    {Math.round(hudOverlayOpacity * 100)}%
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* HUD Overlay - Center of camera view */}
          {hudEnabled && (
            <div
              className={[
                "absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none",
                hudTheme === "contrast" && hudOverlayMode === "panel"
                  ? "px-6 py-4 rounded-xl border border-status-good/60 bg-black/60 shadow-[0_0_24px_rgba(124,255,104,0.45)]"
                  : hudTheme === "contrast"
                    ? "px-4 py-2"
                    : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <FlightDisplay
                telemetryData={telemetryData}
                size={hudTheme === "contrast" ? "normal" : "compact"}
                theme={hudTheme}
                overlayMode={hudTheme === "contrast" ? hudOverlayMode : "none"}
                overlayOpacity={hudTheme === "contrast" ? hudOverlayOpacity : 0}
              />
            </div>
          )}

          {/* Custom overlays passed as children */}
          {children}
        </div>
      </div>
    );
  };

FPVDisplayComponent.displayName = "FPVDisplayComponent";

const ForwardFPVDisplay = forwardRef<FPVDisplayRef, FPVDisplayProps>(FPVDisplayComponent);
ForwardFPVDisplay.displayName = "FPVDisplay";

const fpvPropsEqual = (prev: FPVDisplayProps, next: FPVDisplayProps) => {
  if (prev.width !== next.width || prev.height !== next.height) return false;
  if (prev.className !== next.className) return false;
  if (prev.maskOpacity !== next.maskOpacity) return false;
  if (prev.colorizeById !== next.colorizeById) return false;
  if (prev.detectThickness !== next.detectThickness) return false;
  if (prev.visionHeatmapOpacity !== next.visionHeatmapOpacity) return false;
  if (prev.visionHeatmap !== next.visionHeatmap) return false;
  if (prev.children !== next.children) return false;
  if (prev.visionDetections !== next.visionDetections) return false;
  if (prev.agentDetections !== next.agentDetections) return false;
  if (prev.visionMasks !== next.visionMasks) return false;
  if (prev.visionKeypoints !== next.visionKeypoints) return false;
  if (!telemetryShallowEqual(prev.telemetryData ?? null, next.telemetryData ?? null)) return false;
  return true;
};

export const FPVDisplay = React.memo(ForwardFPVDisplay, fpvPropsEqual);
