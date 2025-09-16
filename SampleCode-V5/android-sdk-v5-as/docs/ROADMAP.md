ROADMAP (Running Handoff)
=========================

TL;DR
- Status: Panels + Vision prototype; planner program‑only; resilient WS reconnects. Next focus is UI shell (ImGUI‑like), dual‑camera (PiP/side‑by‑side), robust map/home handling, and realtime detection+tracking (detector+tracker, object registry).
- Immediate next steps (validate with user after each):
  1) PanelRegistry + WindowChrome (floating/movable/resizable; minimize/close; Components menu; persisted layout)
  2) Dual‑camera PiP + side‑by‑side with persisted PiP position/size; correct overlay routing
  3) Live Map resilience: show drone/home even if home unknown; Set Home action; non‑blocking init
  4) Frame Bus + Core ML detector/tracker spike (YOLOv11n/s + Vision tracker) for one camera; live green boxes; lock‑on

Purpose
Single source of truth for near‑term scope and handoffs. Keep it updated after every change. Each step must be validated with the user before proceeding.

Build/Run
- UI/Electron: see README (install, build, run). Use TopBar → Settings → Endpoints to set servers.
- Detect server: `python tools/vision_detect_server.py`
- General server: `QWEN_MODEL=Qwen/Qwen2-VL-2B-Instruct python tools/vision_general_server.py`
- Planner (optional): `OPENAI_API_KEY=... python tools/planner_service.py`

- Android bridge - ' android-sdk-v5-as % ./build.sh debug'
- UI - 'npm cache clean --force && npm run build'
Next Steps (detailed)

UI‑side
1) PanelRegistry + WindowChrome (ImGUI‑like)
- Implement PanelRegistry (React context) tracking panels: id, title, x/y, w/h, z, minimized/closed, settings; persist to `ui.layout.v1`.
- WindowChrome: draggable header, minimize/close, resize handles, z‑order controls; snap‑to‑edges; keyboard focus.
- Migrate Vision, Agent, Map, HSI, Controller HUD, Logs; TopBar → Components menu to re‑enable closed panels.
- Acceptance: drag/resize/minimize/close/restore across sessions; “Reset layout” restores defaults.

2) Dual camera (PiP + side‑by‑side)
- CameraSurface manager: two canvases per camera, overlay router.
- PiP: draggable/resizable overlay with persisted bounds; Swap and Side‑by‑Side split with draggable divider.
- Acceptance: both cameras visible; overlays route to intended camera; state persists.

3) Live Map + Home handling
- Guard against missing/invalid home (render aircraft only; show “Home pending”).
- Add Set Home button (bridge command) and handle stale/unknown gracefully.
- Acceptance: app starts with missing home; map works; Set Home updates map without restart.

4) Realtime detection/tracking spike (local)
- Frame Bus: publish downscaled frames to detector/tracker workers.
- Detector: YOLOv11n/s Core ML via VNCoreMLRequest every N frames; Tracker: VNTrackObjectRequest per frame.
- Object Registry: {id, label, last_box, conf, timestamps}; region‑limited reacquire.
- Gimbal follow: rate‑limited centering (≥500ms cooldown), smooth motion.
- Acceptance: 20–30 fps lock‑on; green boxes; lock/unlock; reacquire after short occlusions.

Android‑bridge side
- Implement `set_home_position` (lat,lon,alt) command.
- Research (no movement yet): Virtual stick vs waypoint; gain/release control; primitives (takeoff, land, ascend_to, fly_to, orbit, RTH). Draft message schema + safety gates.
- Acceptance: Set Home round‑trips; primitives documented with sequence diagrams.

Research (SDK, Web)
- DJI MSDK V5 capabilities for dual stream + gimbal control.
- Vision: Core ML export for YOLOv11/YOLOv8; performance estimates on Apple Silicon; tracker selection.
- World model: 2D→3D projection using altitude & gimbal pose; LRF fusion plan.
- Acceptance: short design notes added under `docs/` (DETECTION_TRACKING.md, WORLD_STATE.md, FLIGHT_RESEARCH.md).

Validation gates (user sign‑off required)
- After each of the 4 steps above: demo live or recorded frames; confirm ImGUI‑like UX, dual‑camera behavior, map robustness, and tracking latency before integrating further.

Later (tracked separately)
- Semantics 1.0 (caption/QA), Planner v2, Interpreter v2, Evaluation harness, Operator UX.

Handoff rules
- Keep this ROADMAP.md updated in your PRs (date, owner, status). If scope changes, update acceptance criteria and dependencies.
- Keep README build/run steps current; link to new docs when adding components.
- After completing a step, add a brief “Outcome + follow‑ups” note so any teammate can resume immediately.

