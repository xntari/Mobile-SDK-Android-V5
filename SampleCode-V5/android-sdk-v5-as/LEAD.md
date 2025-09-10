# LEAD Plan — Free Look & Precise Free Look

Role: Supervisor/QA. Goal: land Free Look (continuous gimbal pan/tilt) and Precise Free Look (single‑click center) without breaking video, telemetry, joystick, or existing gimbal tap.

Soundness & SDK cross‑reference
- Tap‑to‑target: Confirmed on V5 via `CameraKey.KeyTapZoomAtTarget` with `ZoomTargetPointInfo(x,y,…)`. Already implemented in `DJIBridgeServer.handleGimbalTapTarget` and mirrors sample `LookAtVM.startTapZoomPoint`.
- Free Look (continuous): Use gimbal velocity/angle APIs exposed via Key system (GimbalKey). We will guard actual key names by feature detection (`GimbalKey.getKeyList()`/performAction errors) and clamp rates. Backend changes are isolated and behind new message types.
- Precise Free Look (one‑click center): Start with coarse `TapZoomAtTarget`, then refine using attitude feedback (`GimbalKey …Attitude`) and small, rate‑limited adjustments. If angle/velocity keys are unavailable on hardware, fall back to multi‑tap nudge.

Working method
- DEV: Front‑end UI + Electron bridge integration only.
- ENG: Android bridge WebSocket handlers; no regressions to streaming.
- LEAD: Gate each step; verify logging, stability, and APK deploy.

Acceptance gates (per step)
1) Routing only: build ok, logs ok, zero behavior change.
2) Free Look speed: start/update/stop flows work, rates clamped, no drift on stop, no impact to video.
3) Precise Free Look: single click recenters within ~2°; fails safe if unsupported.

Incremental steps (approve each before proceeding)
- Step 1 (No‑op): Add message types + routing with logging only.
- Step 2 (Free Look): Implement `gimbal_free_look_{start,update,stop}` using safe, throttled speed/angle actions; add watchdog to auto‑stop.
- Step 3 (Precise): Implement `gimbal_precise_look {x,y}`: coarse TapZoom, then refine via attitude deltas with clamps and timeouts.

Test protocol (per step)
- Build: `./build.sh debug`; Deploy: `./deploy.sh debug --logs`.
- Logs: watch `JOYSTICK_*`, `Gimbal*` (ENG to add concise tags), and `GIMBAL_*` responses on client.
- Client: H20N view responsiveness intact; click & drag behaviors isolated to H20N mode.

Step 1 — Status
- ✅ ENG: new message types added and routed; logs show `GIMBAL_ROUTE` for START/UPDATE/STOP/PRECISE; responses use `gimbal_response`.
- ✅ DEV: UI toggle and message wiring present in `H20NDisplay.tsx` sending start/update/stop and precise/tap.
- ✅ Verification: no regressions observed; streaming unaffected; responses received in UI.

Step 2 — Plan (In Progress)
- ENG: implement Free Look velocity control with safety:
  - Keep session state, 15Hz scheduler, watchdog (auto‑stop ≥800ms idle), map `vx,vy` ∈ [-1,1] to clamped deg/s (±25) with dead‑zone.
  - Primary: use gimbal speed/angle action via DJI V5 Key APIs; Fallback: small, rate‑limited tap‑nudges toward center.
  - Always send zero on STOP and on disconnect.
- DEV: refine Free Look UX:
  - Maintain 15Hz updates; ease curve + dead‑zone (done), ensure reliable STOP on release/unmount (done), add small HUD indicator for vx/vy.
  - Add tuning sliders: Sensitivity (0.5–3.0x), Smoothing (0–0.9). Values are applied client‑side before sending updates.
  - Prevent clicks during Free Look; keep Precise click separate.

Step 2 — Issue & Fix
- Observed: Watchdog triggered despite mouse movement. Root cause: interval closure captured stale `freeLookVelocity` and gated updates on non‑zero velocity; backend saw no UPDATEs.
- Fix (DEV):
  - Use refs (`freeLookVelocityRef`, `isFreeLookActiveRef`) and send UPDATE every 15Hz while active.
  - Patch applied in `H20NDisplay.tsx` to always emit updates and refresh watchdog.

Step 2 — Acceptance
- START/UPDATE/STOP visible in logs with `GIMBAL_FREE_LOOK`; watchdog stops motion after idle.
- Free Look uses drag-origin mapping (offset from drag start), not screen center; with Sensitivity ≥2.0 and Smoothing ≤0.2, motion is snappy.
- Dead-zone small (~0.02); small jiggle does not drift, but subtle control is possible.
- No impact to video/telemetry; fallback path logs when primary control not supported.

Step 3 — Plan (Precise Look)
- ENG: Implement `gimbal_precise_look {x,y,duration_ms?,strength?}`:
  - Stop Free Look if active. Start a time-bounded ease-out velocity loop (~30 Hz) that decays rates to zero over `duration_ms`.
  - Map deltaX/deltaY from center to yaw/pitch rates (linear), scale by `strength` and backend MAX_RATE. Send zero at end; minimal logging.
  - Acceptance: start/complete acks via `gimbal_response`; visible, predictable time-to-target; no watchdog interference.
- DEV: Add UI controls for Precise:
  - Sliders: Time to target (200–2500 ms), Strength (0.5–3.0x). Send with click payload.
  - Acceptance: click → predictable ease-out motion; adjust sliders to tune feel.
