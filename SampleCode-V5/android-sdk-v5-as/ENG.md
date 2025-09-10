# ENG — Android Bridge Tasks (Free Look & Precise)

Scope: Kotlin backend in `../android-sdk-v5-sample`. Maintain stability of video, telemetry, joystick, and existing `gimbal_tap_target`.

Message types (add to MessageType)
- `GIMBAL_FREE_LOOK_START("gimbal_free_look_start")`
- `GIMBAL_FREE_LOOK_UPDATE("gimbal_free_look_update")`
- `GIMBAL_FREE_LOOK_STOP("gimbal_free_look_stop")`
- `GIMBAL_PRECISE_LOOK("gimbal_precise_look")`

Step 1 — Routing only (No‑op)
- Add enum entries + `when` routing that logs payloads and returns `GIMBAL_RESPONSE` with `{ success:true, mode:'noop' }`.
- No SDK calls. Verify build, deploy, and that logs show new routes without side effects.

Step 2 — Free Look (safe velocity control)
- Handler design:
  - START: mark session active; init `lastUpdate=now`; create 15Hz scheduler that reads latest `(vx,vy)` and issues control actions.
  - UPDATE: store latest `(vx,vy)` from `data` (floats ∈ [-1,1]); set `lastUpdate=now`.
  - STOP: send zero‑velocity; cancel scheduler; clear session state.
- Mapping & clamps:
  - Dead‑zone reduced to ~0.02 (front-end also has its own); values below ~0.02 are treated as zero to avoid drift.
  - Linear mapping: `deg = v * MAX_RATE` with `MAX_RATE≈120` for snappy response; client controls sensitivity and smoothing.
- Primary control (recommended): Use DJI V5 gimbal speed/angle keys (feature‑detect at runtime):
  - Try speed: `GimbalKey.KeyRotateBySpeed.create(cameraIndex).action(GimbalSpeedRotation{ pitchAngularVelocity=..., yawAngularVelocity=... })`.
  - If unavailable, try small angle steps: `GimbalKey.KeyGimbalAngleRotation` with small deltas at 15Hz.
- Fallback (if keys unsupported): emulate with small, rate‑limited `CameraKey.KeyTapZoomAtTarget` nudges toward center (compute targetX/Y = 0.5 ± k*v).
- Safety:
  - Watchdog: if `now - lastUpdate > 800ms`, auto‑STOP (send zeros, cancel scheduler).
  - On client disconnect, call STOP.
  - Logs: `GIMBAL_FREE_LOOK` for start/step/stop; include applied deg/s.
- Threading: use existing `executor` for scheduling; never block main/UI.

Step 3 — Precise Free Look (refined center)
- Handler `gimbal_precise_look {x,y,duration_ms?,strength?}`:
  - Stop Free Look if active; ack start via `gimbal_response`.
  - Start a ~30 Hz ease-out loop for `duration_ms` (default 700 ms), mapping `dx=x-0.5`, `dy=y-0.5` to yaw/pitch rates: `yaw=dx*MAX_RATE*strength*ease`, `pitch=-dy*MAX_RATE*strength*ease`.
  - Ease-out: quadratic `ease = 1 - (t/duration)^2`. End early if rates < ~0.5°/s; always zero at end; ack completion.
  - Minimal logging: only start/complete/error.

JSON schemas
- Start: `{ type: 'gimbal_free_look_start', data?: { source?: 'h20n'|'fpv' } }`
- Free Look update: `{ type: 'gimbal_free_look_update', data: { vx: number, vy: number } }`.
- Stop: `{ type: 'gimbal_free_look_stop' }`.
- Precise: `{ type: 'gimbal_precise_look', data: { x: number, y: number } }` with 0..1 normalized.

Validation & logs
- Use concise tags: `GIMBAL_ROUTE`, `GIMBAL_FREE_LOOK`, `GIMBAL_PRECISE`, `GIMBAL_ERR`.
- Ensure existing telemetry/video logs remain unchanged.

Build & deploy
- Build: `./build.sh debug`; Deploy: `./deploy.sh debug --logs`.
- Use `deploy.sh joystick` to keep logcat sessions focused while testing.

Step 2 Test Checklist
- Send START → log `GIMBAL_FREE_LOOK start`; scheduler active.
- Move mouse (UI updates) → UPDATEs received; applied deg/s shown in log; visible gimbal motion.
- Stop sending UPDATEs → watchdog triggers STOP within ~0.8s.
- Issue STOP → velocities zeroed and scheduler canceled immediately.
