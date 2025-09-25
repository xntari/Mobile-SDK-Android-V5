# Flight Control Status & Test Guide

> ***Critical** — Keep this document in sync with the product at all times. It is the authoritative source for pilots/operators to understand what is safe, what is experimental, and how to validate behaviour before flight. Never remove the safety checklist or downgrade warnings about incomplete features.

This document captures the current feature set, open work, and hands-on test procedures for the bridge + desktop flight-control workflow. Use it as a pre-flight checklist when validating new builds or gathering datapoints in the field.

---

***** IMPORTANT - keep all section updated (after every major change update status, checklist, instructions, feature reference, backlog) *****
=================================================================================
## 1. Snapshot (Sep 24 2025) 21:25 – (commit 7e33f872c0932823d96fb391b231fbee8e8e3005)

### Working today (verified)
- **Take-off / Land / Cancel / Confirm** via bridge commands with detailed acknowledgements (diagnostics, landing monitor payloads).
- **Compass calibration** start/stop surfaced in the Flight Commands panel.
  - Notifications + audio cues for *kill switch*, *manual release*, and *hardware override* events.
- **Preflight diagnostics panel** streaming DJI health + landing monitor faults.
- **Video decoder resilience** – FPV & H20N WebCodecs flush/close on errors with exponential back-off restarts.
- **Manual control tuning UI** – presets for overall stick sensitivity plus per-preset mouse-yaw slider persisted in localStorage.
- **Continuous override stream** – virtual-stick overrides run ~16 Hz, auto-resume after decoder/WebSocket resets, and every frame is captured in the session export.

###  Partial / needs validation
- **Manual keyboard/mouse flight** (partially working)
  - `virtual_stick_enable/override/disable` lifecycle automated.
  - `WASD` pitch/roll, `Space`/`Shift` vertical, `Q`/`E` or arrows for yaw.
  - Pointer-lock mouse yaw with adjustable HUD overlay (panel/inline/none) and persistent HUD theme.
- **Kill switch** (ESC button) zeros sticks, disables virtual stick, and reports success/fail in UI + toast.
- **RC override detection** – bridge streams `authority_owner`/`change_reason`, desktop shows toast + logs when control transfers.
- **Flight-command error context** – `flight_command` acks now include FC error type/code, FlySafe warning height, and a `fly_to_context` block with current altitude, height-limit/fly-safe margins, and likely violation flags in the panel (capture screenshots during tests).
- **Fly-to parameter sync** – `fly_to_prepare` now mirrors the DJI sample flow by updating FlyTo mode/height via `updateMissionParam` before launching the mission; the ack reports `fly_to_param_update` (`applied/skipped/failed`).
- **Fly-to status telemetry** – Fly-To mission info/capability listeners stream into telemetry (`fly_to_status`), so the desktop panel shows current mode/height, supported modes, and capability height ranges in real time.
- **Emergency command gating** – force-land, cancel/confirm landing, and RTH stop buttons automatically enable only when the aircraft reports AUTO LAND / GO HOME in telemetry.
- **Controller Insight panel (beta)** – view physical RC sticks, software virtual-stick command, last override acknowledgement, and current flight limits (max height/distance, go-home height). Master/slave telemetry still pending.
- **FlySafe telemetry** – desktop now pulls DJI FlySafe notifications plus surrounding zone data so you can see the exact height bubble restricting the aircraft. (UI: Controller Insight → Limits card.)
- **Relative fly-to & RTH desktop panel (beta)** – new commands for forward/back/left/right/up/down moves and RTH start/stop are available in the “Fly-To & RTH” panel, but require field validation.
- **Manual session export & FlySafe toasts (beta)** – keyboard sessions can be downloaded as CSV/JSON logs and FlySafe restrictions raise red toasts; pending field validation.
- **Auto-mode status telemetry (beta)** – flight mode + auto-landing/return flags drive UI gating; confirm on hardware that states and buttons stay in sync.
- Manual session analytics export (CSV/JSON) with command stream and diagnostics snapshot.
- Better surfacing of NFZ / height-limit blocks (e.g. `IN_NFZ_MAX_HEIGHT`) in UI.
- Remote keyframe request when decoder restarts (bridge command TBD).
- Manual flight telemetry capture (per-session CSV/JSON).
- Mission builder UI (fly-to, orbit, return) with interrupt/kill.
- Dual-controller telemetry (master/slave sticks & switch states).

**Manual flight refinements** (done) - pending verification
   - Validate the 16 Hz virtual-stick stream + mouse pitch control on-aircraft (capture CSV/JSON excerpt + pilot feedback).
   - Validate manual session export & FlySafe restriction toasts in field conditions (collect sample CSV/JSON + screenshots).
   - Field-validate the auto-mode gating (AUTO LAND / GO HOME) and log any unmapped flight-mode strings for follow-up.
   - Detailed NFZ / limit messaging surfaced in panel + toast (e.g. auto-toast on `IN_NFZ_MAX_HEIGHT`).


Keep open items near the top and update after each sprint/test cycle.
=================================================================================
---

## 2. Field Safety Checklist

Run this sequence at the start of every flight-test session before attempting higher-level missions. Record outcomes and any anomalies.

1. **Environment & aircraft**
   - Verify physical test range is clear; note expected NFZ/altitude limits (DJI Pilot → max alt, warnings).
   - Confirm aircraft battery, RC battery, laptop charge levels.
   - Check props, gimbal, payload secure.
   - Ensure arms unfolded, blades ok.

2. **Bridge/Desktop preflight**
   - Launch desktop client; ensure Flight Commands, Preflight, and HUD panels are visible.
   - Connect bridge (adb/logcat running). Confirm `Connection Status` turns green.
   - Review Preflight panel for active diagnostics; resolve critical items before arming.
   - Check Controller Insight → Limits card for max height/distance and FlySafe warnings (if `IN_NFZ_MAX_HEIGHT` persists, note the “Warning” details).

3. **Command channel sanity**
   - Send `compass_calibrate_start` then `stop` (no-op if already calibrated) → expect ok acks.
   - Verify compass accuracy, cross ref with map, other compass.
   - Check GPS sat count
   - Issue `Take Off`; wait for `status=ok` + hover ~1.2 m, verify telemetry `Motors: ON`.
   - Land immediately to confirm `land` → `status=ok` response and motor shutdown.

4. **Manual control core**
   - Take off again for manual tests.
   - Open the **Manual Control** card, pick a sensitivity preset, and adjust the mouse-yaw slider if needed (defaults persist per preset).
   - Click `Start Keyboard`. The app auto-enables virtual stick with smart retries; confirm the history shows `virtual_stick_enable` → `ok`.
   - If a toast reports RC ownership (e.g. `FPV_RC`), release hardware sticks before retrying.
   - `Capture Mouse Yaw/Pitch` → confirm pointer lock engages; mouse left/right adjusts yaw, mouse up drives forward pitch, mouse down drives backward pitch.
   - Press `W`/`S` or `Space`/`Shift` to verify aircraft responds (note any NFZ blocks). Record command log and drone response.
   - `Release Control` → expect release toast + audio; check `virtual_stick` disabled.
   - Re-enable manual control, then hit `ESC` → confirm kill switch toast + audio.
   - While active, move RC sticks (controller A/B) → expect override toast/audio and status `LOST`.
   - Note the **Controller Insight** limits card (max flight height/distance, go-home height, FlySafe warnings) and confirm values match DJI Pilot; capture screenshot/log if a limit blocks commands.
   - `Force Land`/`Force RTH` buttons stay disabled until the aircraft reports AUTO LAND / GO HOME; verify the status card shows `Auto Mode` before expecting them to arm.
   - When AUTO LAND/GO HOME begins, capture a screenshot/log showing the `Auto Mode` label and which buttons unlocked for traceability.
   - After completing the keyboard session (landed, VS disabled), open **Session Export** → download CSV (and optionally JSON). Verify the file contains timestamped stick rows and the `session_stop`/`session_kill_switch` events before archiving with the test notes.
   - If the environment allows a safe negative test, deliberately trigger a FlySafe block (e.g. command `fly_to` above the warning height). Confirm the desktop shows a red “FlySafe Restriction” toast and note the reported height limit.

5. **Video health**
   - Let FPV/H20N streams run ≥10 min. If a `Decoding error` appears, watch for automatic recovery (`[FPV]/[H20N] Scheduling decoder restart` in console). Note failures.

6. **Relative fly-to (beta)**
   - In a safe, obstacle-free area, use the Fly-To panel to command a short move (e.g. forward 5 m, up 2 m) and watch for aircraft response + acknowledgements. Record results and any deviations (mark "PASS" only after observation). Skip if location does not permit safe movement.
   - After each attempt, expand the `Last Command` card and capture the `fly_to_context` block (height-limit and FlySafe margins). Log any negative margin values—even if the aircraft moved—as part of the session notes.
   - Verify the Fly-To control settings before flight: set the security takeoff height (defaults to 20 m), choose `Smart height` for maintaining current altitude or `Set height` and enter the desired AGL target. Confirm the resulting ack shows `fly_to_param_update=applied`.
   - Cross-check the **Fly-To Telemetry** summary (mode/height/running state and capability ranges) against DJI Pilot before/after each command; note any discrepancies.

7. **Post-flight**
   - Land, stop motors, disconnect virtual stick.
   - Save logs (Electron console export, `adb logcat`, telemetry notes).

Keep this foundational checklist up to date whenever safety-critical behaviour changes.

---

## 3. Mission / Navigation Checklist (WIP)

The following items describe the desired workflow once fly-to primitives land. Update steps as we implement each capability.

### Waypoint/fly-to status
- Android bridge implements `fly_to_prepare` (uses `IntelligentFlightManager.flyToMissionManager`).
- Desktop Fly-To panel now sends **basic relative offsets** (forward/back/left/right/up/down) and RTH start/stop. Marked **beta – pending field validation**.
- Map/LRF target selection button is present but requires the upstream panels to supply coordinates; treat as experimental until confirmed on hardware.
- Full mission composition, queueing, KMZ upload, and automatic abort logic remain TODOs (see Backlog §5.2).

### Planned smoke once UI exists (placeholder)
1. Pick current coordinates + `+5 m` altitude → `fly_to_relative` (to implement) → confirm `status=ok`, observe climb.
2. `Forward 5 m` relative command → verify translation + ack.
3. `Return Home (start)` → monitor telemetry until hover above home, then `Return Home (stop)` (cancel) before land.
4. Compose mini mission (takeoff → fly forward → hover → return) via new mission UI; ensure command queue shows progress and abort works.
5. Log RC authority transitions during missions; capture `controller_data` for master/slave sticks once streamed.

Until the UI and command verbs exist, note these as future tests and do **not** attempt them in the field.

---

## 3. Troubleshooting Notes

| Symptom | Likely Cause | Actions |
| --- | --- | --- |
| “Capture Mouse Yaw” disabled | Virtual stick not active | Ensure `Start Keyboard` succeeded (status `ACTIVE`), check ack history for enable errors (NFZ, authority). |
| `fly_to_prepare` → `Param illegal` | FlySafe bubble or bad target altitude | Inspect the latest ack: check `error_code`/`error_domain` plus `fly_to_context.height_limit_margin` and `fly_to_context.fly_safe_margin` (negative = violation). Note the warning description + limit and adjust the requested altitude before retrying. |
| `fly_to_param_update=failed` | `updateMissionParam` rejected (mode/height invalid) | Re-send with supported Fly-To mode (`smart_height` or `set_height`) and ensure `fly_to_height` is provided for set-height missions. Collect the SDK error code for follow-up. |
| `fly_to_param_update=update_failed` but mission runs | Bridge fell back to previous parameters after param update failure (e.g. aircraft not ready) | Review `fly_to_param_message`, capture hardware warnings (`fly_to_context.diagnostics`, Preflight panel), and confirm telemetry `fly_to_status.info` reflects actual mode/height before retrying. |
| Session export button disabled | No manual session activity recorded | Ensure a manual session (keyboard active, VS enabled) ran; exports only unlock after `Start Keyboard` succeeds or a previous log exists. |
| No motion when pressing WASD | Flight controller rejected roll/pitch (NFZ, height lock, sensors) | Review latest `flight_command` ack diagnostics and Preflight panel; look for `IN_NFZ_MAX_HEIGHT`, `motor_start_failure`, etc. |
| Manual session stops immediately | RC has authority | Check controller panel `Authority` badge; if not `APP`, hardware override is owning sticks. |
| Decoder error toast persists | Bridge still streaming but decoder loop restarting | Watch dev console for `[FPV] Scheduling decoder restart` messages; if repeated >5 times, capture logs and note air-link state. |
| No toast/audio on kill/override | Notification suppressed | Inspect `manualState.notification` in dev tools; verify focus wasn’t lost (window blur clears keys). |

---

## 4. Feature Reference

### Manual Control UX
- **Start Keyboard** – auto-enables virtual stick (with retries if busy), zeros axes, begins ~16 Hz override stream.
- **Release Control** – disables stream with “Manual control released” notification.
- **Kill Switch (ESC)** – emergency disable with distinct tone.
- **Sensitivity presets & mouse yaw gain** – three presets (precision/normal/aggressive) plus per-preset yaw slider stored in localStorage; use before flight to match pilot preference.
- **Pointer-lock mouse pitch** – when mouse capture is active, horizontal motion feeds yaw and vertical motion feeds pitch (up = forward, down = back) for fine manual trimming.
- **HUD Controls** – theme toggle (classic/high-contrast), overlay mode (panel/inline/none), opacity slider persists in localStorage.
- **Analytics** – `Flight Commands` panel shows command count + last command time; notifications reset counters when session ends.

### Diagnostics & Logging
- Preflight panel auto-refreshes device status + DJI diagnostics.
- Landing monitor payloads appended to command history for post-flight analysis.
- Console logging: `[ManualControl]` for authority transitions, `[FPV]/[H20N]` for decoder restarts.
- Each fly-to ack now includes `fly_to_context` (current altitude, limit margins, violation flags); capture these values in logs/screenshots whenever diagnosing a failure.
- `fly_to_param_update` reports whether the bridge pushed FlyTo mode/height (`applied`, `skipped`, or `failed`); review alongside `fly_to_param_message` when commands are rejected.
- Telemetry exposes `fly_to_status` (info/target/capability); export it with session logs to document the aircraft’s accepted parameters.
- Command history now records `fly_to_param_steps` (mode/height update attempts) and the raw DJI error string so you can isolate which update failed.

### Fly-To Panel
- Configure **Security Takeoff Height** (m AGL) before sending missions; defaults to 20 m per DJI sample.
- Choose **Fly-To Mode**: `Smart height` keeps current altitude, `Set height` climbs/descends to the requested height (requires `Target Height`).
- Relative/absolute commands include the chosen mode and speeds in the request log and ack payload for post-flight analysis.
- The telemetry block shows live Fly-To mode/height, supported modes, and capability height range (when provided). Treat it as the ground truth for what the aircraft accepted. On Matrice 350 RTK we currently see `supported_modes=[]`, so the backend will fall back to waypoint-based “fly-to” automatically.

### Video Recovery
- On error, decoders flush, close, and restart with exponential back-off (250 ms → 2 s). Future work: request fresh keyframe from bridge to shorten recovery.

---

## 5. Backlog / TODOs


1. **Navigation primitives** (partial, immediate next steps - Waypoint mission refactor)
   - Initial relative fly-to UI (forward/back/left/right/up/down, optional speed) — **needs field validation**. Show waypoint projections on map/compass/orientation/frame similar to points from object memory (reuse the same logic which visualizes 3d coords).
   - RTH start/stop buttons — **validate cancel behaviour**.
   - Validate the new `fly_to_context` metrics (height-limit/fly-safe margins) against DJI Pilot readouts; extend logging if FC still returns ambiguous errors.
   - Target selection from map/LRF to feed fly-to commands.
   - Mission builder UI (queue commands, show projected path, allow abort).
   - **Waypoint Mission refactor**
     - Implement a waypoint-based fly-to backend via `IWaypointMissionManager` (Matrice 350 RTK supports Waypoint V2). Initial target: single waypoint missions that mimic the current Fly-To commands, with the mission planner designed to evolve toward multi-point paths (orbit, surveys, etc.).
     - Detect intelligent Fly-To capability at runtime (`fly_to_status.capability.supported_modes`). If the list is empty or missing the requested mode, route commands through the waypoint mission pipeline instead of calling `updateMissionParam`.
     - Modularise the bridge: keep the existing Intelligent Flight handler for products that support it, add a waypoint mission module responsible for mission construction/upload/execute/stop, and expose capability state up to the UI.
     - Flesh out mission authoring UX inside the Fly-To panel: map-based waypoint creation (MapLibre), HSI/compass overlays, reverse projection from camera taps, laser range finder integration, and “record manual flight” to capture waypoints.
     - Add simulation tooling so operators can preview a mission (map trajectory, ETA, simulated telemetry) before committing.
  Next steps:

  a. Implement the waypoint mission backend (Waypoints V2 for M350) and switch the bridge to it whenever the capability snapshot lacks supported modes.
  b. Once the waypoint path is working, extend the UI with mission authoring/simulation as described in the doc.

2. **Controller insight & FlySafe**
   - Controller Insight panel (RC vs SW vs Ack + limits) — gather field validation screenshots/logs.
   - Stream master/slave sticks, switch positions, and active authority reason codes.
   - Display RC mode (P/Sport/Tripod) and switch state in UI.
   - Surface detailed FlySafe zone listings and auto-highlight violating zones when `IN_NFZ_MAX_HEIGHT` is active.
   - Flight controller settings (example RTK on/off, max alt, avoidEnable, avoidMode, max distance) - ref https://github.com/dji-sdk/Onboard-SDK/blob/118e2825a347499efb8ed253146552c5b9b10779/osdk-core/api/inc/dji_flight_controller.hpp
3. **Video & telemetry**
   - Force-keyframe request on decoder restart.
   - HUD speed/altitude units toggle (m/s ↔︎ mph, meters ↔︎ feet).
   - Battery widget parity with DJI Pilot (dual packs, warnings).

4. **UI polish / Components**
   - Add Object Memory panel to Components menu/top bar and fix popover z-order.
   - When a component is re-enabled via the Components menu, bring its panel to the top-most z-order while keeping saved geometry.
   - Promote the Snapshot Camera selector to a movable/resizable panel (persisted in localStorage) and integrate it with H20N gimbal mode/zoom selectors.
   - Make HSI indicator settings (Mode, scale) persistent in localstore

5. **Automation & QA**
   - Scriptable smoke test (takeoff → manual session → kill → land) driven via CLI.
   - Simulator mission regression (upload, start, pause/resume, stop, break-point).

Keep this list groomed; link each item to a Jira/task ID where applicable.

---

## 6. Field Test Prep Template

Before heading on-site:
1. Sync repo + rebuild desktop (`npm run build`) and Android (`./build.sh debug`).
2. Verify bridge tablet has latest APK; confirm adb connectivity.
3. Print or cache this checklist offline (device may be offline).
4. Prepare data capture: screen recorder, logcat capture (`adb logcat -v time > bridge.log`), telemetry CSV stub.
5. Identify safe flight zone with known NFZ limits and altitude caps.

During test, annotate each significant event (command, toast, diagnostic) with timestamp so logs can be aligned later.

---

_Last updated: Sep 25 2025 – keep the snapshot/date current when edits are made._
