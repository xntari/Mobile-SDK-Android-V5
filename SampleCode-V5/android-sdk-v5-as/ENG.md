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
- Implement handlers:
  - START: mark session active; set lastUpdate=now; schedule watchdog (auto‑stop after 800ms without UPDATE).
  - UPDATE: map `vx,vy` ∈ [-1,1] → clamped angular velocities with dead‑zone; throttle to 10–15Hz.
  - STOP: send zero‑velocity and clear session state.
- SDK: prefer speed/angle keys; if unavailable, emulate with small `TapZoomAtTarget` nudges toward center. Always clamp and catch errors.
- Safety: auto‑stop on client disconnect; log tag `GIMBAL_FREE_LOOK`.

Step 3 — Precise Free Look (refined center)
- Handler `gimbal_precise_look {x,y}`:
  - Phase A: coarse `TapZoomAtTarget(x,y)`.
  - Phase B: read gimbal attitude; compute small deltas to center; apply limited speed/angle correction for ≤400ms.
  - Exit on timeout, low error (< ~2°), or error event. Log `GIMBAL_PRECISE`.

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
