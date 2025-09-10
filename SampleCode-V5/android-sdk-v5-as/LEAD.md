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

Step 1 — Immediate Checklist
- ENG: add enum + routing (no SDK calls), respond with `{ type:'gimbal_response', data:{ success:true, mode:'noop' } }` and log tags `GIMBAL_ROUTE`.
- DEV: add UI toggle + send `{type:'gimbal_free_look_start|update|stop'}` and `{type:'gimbal_precise_look'}`; render server responses.
- Verification: bridge logs show routes hit; UI receives `gimbal_response`; no change to video/telemetry behavior.
