# Flight Control Status & Test Guide

> ***Critical** — Keep this document in sync with the product at all times. It is the authoritative source for pilots/operators to understand what is safe, what is experimental, and how to validate behaviour before flight. Never remove the safety checklist or downgrade warnings about incomplete features.*

This document captures the current feature set, open work, and test procedures for the bridge + desktop flight-control workflow. Treat it as the pre-flight reference when validating new builds or gathering datapoints in the field.
Use only standard ascii characters here - don't use ✅  or similar
---

## TL;DR (Sep 25 2025 12:03 – commit bddd9a5151fcdda85b518c3069c01fee209b7e89)

- **Document discipline** – Update this file after every bridge/desktop change. Status, safety checklists, operator notes, and backlog items must always reflect the running code. Never mark a feature complete without field verification.
- **Immediate next work** – Harden the new waypoint fallback (telemetry, abort, KMZ lifecycle) and prep the authoring flow for multi-waypoint missions while keeping the desktop UI stable.
- **Field validation focus** – Collect hardware evidence for the 16 Hz keyboard/mouse stream, relative fly-to/RTH panel, the `waypoint_v2` fallback (mission id + KMZ logs), auto-mode gating, FlySafe toasts, and session exports. Capture CSV/JSON logs, telemetry screenshots, and note any NFZ height bubbles blocking movement.
- **Recent changes (latest first)**
  1. 2025‑09‑25 – Fly-To now auto-falls back to a generated Waypoint V2 mission (`backend=waypoint_v2`) when intelligent Fly-To is unsupported; responses include mission ids and KMZ paths.
  2. 2025‑09‑25 – Auto-mode telemetry now gates Force Land / RTH Stop buttons; docs updated with gating behaviour.
  3. 2025‑09‑24 – Fly-to context + FlySafe data stream to the desktop; Controller Insight limits card shows warning heights.
  4. 2025‑09‑23 – Manual control presets, kill/override audio cues, and keyboard session exports landed.
  5. 2025‑09‑08 – Simulator research documented (requires real aircraft, motors stay off, full API surface available for bench validation).

  Next

  1. Surface the new telemetry in the desktop app (mission log entry, stop button wired to waypoint_stop, map preview of the generated waypoints).
  2. Hook map clicks/LRF targets into the Fly-To panel so field operators can populate missions without manual coordinates.
  3. Add KMZ lifecycle tooling (download link + cache rotation) and document a simulator/bench validation flow in the status doc.

---

## 1. Status Snapshot (Sep 25 2025 12:03 – commit bddd9a5151fcdda85b518c3069c01fee209b7e89)

### 1.1 Verified today
- **Take-off / Land / Cancel / Confirm** via bridge commands with detailed acknowledgements, including landing monitor payloads.
- **Compass calibration** start/stop surfaced in the Flight Commands panel, with notifications + audio cues for kill switch, manual release, and hardware override events.
- **Preflight diagnostics panel** streaming DJI health, landing monitor faults, FlySafe limits, and device warnings.
- **Video decoder resilience** – FPV & H20N WebCodecs flush/close on errors with exponential back-off restarts.
- **Manual control tuning UI** – presets for overall stick sensitivity plus per-preset mouse-yaw slider persisted in localStorage.
- **Continuous override stream** – virtual-stick overrides run ~16 Hz, auto-resume after decoder/WebSocket resets, and every frame is captured in session exports.
- **Fly-To waypoint fallback** – When intelligent Fly-To advertises no supported modes, the bridge now generates a Waypoint V2 KMZ (current position → target) and starts it automatically; command acks include mission id/path/wayline ids.
- **Waypoint telemetry/abort plumbing** – Bridge streams `waypoint_status` (execute state, active mission id/path) and exposes a `waypoint_stop` command so the fallback mission can be cancelled from the desktop.

### 1.2 Needs field validation / monitoring
- **Manual keyboard/mouse flight** – lifecycle automation works in dry runs (`virtual_stick_enable → override → disable`). Validate WASD/Space/Shift/QE inputs, pointer-lock yaw/pitch (mouse up = forward, down = backward), and log aircraft response when NFZ limits intervene.
- **Kill switch & release flow** – ESC should zero sticks, disable virtual stick, and emit toast/audio. Confirm behaviour in-aircraft (include CSV/JSON excerpts + screenshots).
- **RC override detection** – bridge streams `authority_owner`/`change_reason`; desktop raises toast/logs when control transfers. Gather evidence during dual-controller swaps.
- **Flight-command error context** – acknowledgements include FC error type/code, FlySafe warning height, and `fly_to_context` (altitude, limit margins, violation flags). Record these when commands fail to build a playbook.
- **Fly-to parameter sync** – `updateMissionParam` attempts report `fly_to_param_update` (`applied/skipped/failed`). Monitor outcomes and collect raw DJI error codes.
- **Fly-to status telemetry** – mission info/capability listeners feed `fly_to_status`. Confirm live mode/height/capability data matches DJI Pilot readouts.
- **Emergency command gating** – Force Land, Cancel/Confirm Landing, and RTH Stop buttons only unlock when telemetry reports AUTO LAND / GO HOME. Validate state transitions on aircraft.
- **Controller Insight panel (beta)** – shows physical RC sticks, software virtual-stick command, last override ack, and flight limits (max height/distance, go-home height). Master/slave telemetry still pending.
- **FlySafe telemetry & toasts** – desktop surfaces DJI FlySafe notifications and surrounding zone data. Capture warning bubble screenshots whenever `IN_NFZ_MAX_HEIGHT` blocks movement.
- **Relative fly-to & RTH desktop panel (beta)** – forward/back/left/right/up/down moves plus RTH start/stop exist; verify aircraft executes commands and collect acknowledgement payloads.
- **Manual session export (CSV/JSON)** – ensure logs capture session start/stop, override frames, kill switch events, and FlySafe restrictions during real flights.
- **Auto-mode status telemetry (beta)** – track GO HOME / AUTO LAND status updates and confirm UI remains in sync with aircraft behaviour.
- **Waypoint fallback missions** – Confirm `backend=waypoint_v2` runs end-to-end (KMZ upload, mission start, completion/abort) and capture generated KMZ files for post-flight analysis.
- **Waypoint mission telemetry** – Validate the new `waypoint_status` stream (state transitions, executing info) and the `waypoint_stop` command against real hardware. Confirm abort resets the mission id and that telemetry clears once the aircraft returns to READY.

**Manual flight refinements pending field sign-off**
- Validate the 16 Hz virtual-stick stream and mouse pitch control on-aircraft (attach CSV/JSON excerpt + pilot feedback).
- Exercise manual session export + FlySafe restriction toasts in real conditions (log files + screenshots).
- Confirm auto-mode gating transitions and document any unmapped flight-mode strings.

---

## 2. Immediate Next Steps (Waypoint Mission Backend)

1. **Desktop mission UI** – Add a Fly-To mission log (backend, mission id/path, state timeline), map preview of waypoints, and wire the `waypoint_stop` command into the UI.
2. **Waypoint authoring primitives** – Extend the generator beyond a straight line: add optional climb-to-height legs, hold/hover actions, and prep the pipeline for multi-waypoint paths (orbit stubs, surveys) while enforcing a conservative safety envelope.
3. **KMZ lifecycle & logging** – Surface generated KMZ metadata (download link + checksum) in the desktop logbook and add cache rotation on the bridge so `fly_to_waypoints/` does not grow indefinitely.
4. **Operator guidance & validation** – Document the waypoint fallback checklist, collect field evidence (KMZ + telemetry) across firmware variants, and update UI messaging so pilots know when they are flying an intelligent vs. waypoint backend.

---

## 3. Safety & Core Validation Checklist

Run this sequence at the start of every flight-test session before attempting higher-level missions. Record outcomes and any anomalies.

1. **Environment & aircraft**
   - Confirm test range is clear; note expected NFZ/altitude limits (DJI Pilot → max alt, warnings).
   - Check aircraft battery, RC battery, and laptop charge levels.
   - Inspect props, gimbal, payload mounting, and ensure arms are unfolded with blades clean.

2. **Bridge/Desktop preflight**
   - Launch the desktop client; ensure Flight Commands, Preflight, and HUD panels are visible.
   - Connect the bridge tablet (adb/logcat running). Confirm `Connection Status` turns green.
   - Review the Preflight panel for active diagnostics; resolve critical items before arming.
   - Check Controller Insight → Limits card for max height/distance and FlySafe warnings (if `IN_NFZ_MAX_HEIGHT` persists, capture the warning details).

3. **Command channel sanity**
   - Send `compass_calibrate_start` then `compass_calibrate_stop` (no-op if already calibrated) and confirm `status=ok` acks.
   - Verify compass accuracy against other instruments and check GPS satellite count.
   - Issue `Take Off`; wait for `status=ok` + hover ~1.2 m, then confirm telemetry reports `Motors: ON`.
   - Land immediately to confirm `land` → `status=ok` response and motor shutdown.

4. **Manual control core**
   - Take off again for manual tests.
   - In **Manual Control**, choose a sensitivity preset and adjust the mouse-yaw slider if needed (values persist per preset).
   - Click `Start Keyboard`. The app auto-enables virtual stick with smart retries; confirm the command history shows `virtual_stick_enable` → `ok`.
   - If a toast reports RC ownership (e.g. `FPV_RC`), release hardware sticks before retrying.
   - Engage `Capture Mouse Yaw/Pitch`; pointer lock should engage, mouse left/right adjusts yaw, mouse up drives forward pitch, mouse down drives backward pitch.
   - Use `W`/`S` or `Space`/`Shift` to verify aircraft response (note any NFZ blocks). Record command log and drone reaction.
   - `Release Control` → expect release toast + audio; check `virtual_stick` disabled in history.
   - Re-enable manual control, then press `ESC` → confirm kill switch toast + audio and that virtual stick disengages.
   - While active, move RC sticks (controller A/B) → expect override toast/audio and status `LOST` in history.
   - Note the **Controller Insight** limits card (max flight height/distance, go-home height, FlySafe warnings) and confirm values match DJI Pilot; capture screenshot/log if a limit blocks commands.
   - `Force Land`/`Force RTH` buttons stay disabled until the aircraft reports AUTO LAND / GO HOME; validate that the status card shows `Auto Mode` before expecting them to unlock.
   - When AUTO LAND/GO HOME begins, capture a screenshot/log showing the `Auto Mode` label and which buttons unlocked for traceability.
   - After completing the keyboard session, open **Session Export** and download the CSV (and optionally JSON). Verify the file contains timestamped stick rows plus `session_stop` / `session_kill_switch` events.
   - If safe, deliberately trigger a FlySafe block (e.g. command `fly_to` above the warning height). Confirm the desktop shows a red “FlySafe Restriction” toast and note the reported height limit.
   - When the fly-to ack reports `backend=waypoint_v2`, note the mission id/path and retrieve the KMZ under `cache/fly_to_waypoints/`; attach it to the test report for offline inspection.
   - Exercise the new `waypoint_stop` command mid-mission (or during simulator run) and verify telemetry transitions to `interrupted/finished` while the KMZ entry remains logged.

5. **Video health**
   - Let FPV/H20N streams run ≥10 min. If a `Decoding error` appears, watch for automatic recovery (`[FPV]/[H20N] Scheduling decoder restart` in console). Log failures.

6. **Relative fly-to (beta)**
   - In a clear area, use the Fly-To panel to command a short move (e.g. forward 5 m, up 2 m) and observe aircraft response + acknowledgements. Record results and deviations (mark “PASS” only after observation). Skip if unsafe.
   - After each attempt, expand the `Last Command` card and capture the `fly_to_context` block (height-limit and FlySafe margins). Log negative margins even if the aircraft moved.
   - Set the security takeoff height (defaults to 20 m). Choose `Smart height` to maintain altitude or `Set height` with the desired AGL target; confirm the ack shows `fly_to_param_update=applied`.
   - Cross-check the **Fly-To Telemetry** summary (mode/height/running state and capability ranges) against DJI Pilot before/after each command; note discrepancies.
   - Capture the waypoint fallback flow end-to-end: confirm KMZ upload progress, mission start, and completion/abort events in telemetry and logs.
   - Validate `waypoint_status` telemetry and `waypoint_stop` abort behaviour using simulator if a live flight is impractical.

7. **Post-flight**
   - Land, stop motors, disable virtual stick.
   - Save logs (Electron console export, `adb logcat`, telemetry notes, CSV/JSON session files).

Keep this checklist updated whenever safety-critical behaviour changes.

---

## 4. Operator Manual & Feature Reference

### 4.1 Manual Control UX
- **Start Keyboard** – auto-enables virtual stick (retries if busy), zeros axes, and begins ~16 Hz override stream.
- **Release Control** – disables the stream with a “Manual control released” notification.
- **Kill Switch (ESC)** – emergency disable with distinct tone and command history entry.
- **Sensitivity presets & mouse yaw gain** – three presets (precision/normal/aggressive) plus per-preset yaw slider stored in localStorage; adjust before flight to match pilot preference.
- **Pointer-lock mouse pitch** – when active, horizontal motion feeds yaw and vertical motion feeds pitch (up = forward, down = back) for fine manual trimming.
- **HUD controls** – theme toggle (classic/high-contrast), overlay mode (panel/inline/none), and opacity slider persist in localStorage.
- **Analytics** – Flight Commands panel shows command count + last command time; notifications reset counters when a session ends.

### 4.2 Diagnostics & Logging
- Preflight panel auto-refreshes DJI device status, diagnostics, and landing monitor payloads.
- Command history includes landing-monitor snapshots and FlySafe messages for post-flight analysis.
- Console logging: `[ManualControl]` for authority transitions, `[FPV]/[H20N]` for decoder restarts.
- Each fly-to ack includes `fly_to_context` (current altitude, limit margins, violation flags); capture these during investigations.
- `fly_to_param_update` reports whether the bridge pushed Fly-To mode/height (`applied`, `skipped`, or `failed`). Review alongside `fly_to_param_message` when commands fail.
- Telemetry exposes `fly_to_status` (info/target/capability). Export with session logs to document accepted parameters.
- Command history records `fly_to_param_steps` (mode/height update attempts) and the raw DJI error string.

### 4.3 Fly-To & RTH Panel
- Configure **Security Takeoff Height** (m AGL) before sending missions; defaults to 20 m per DJI sample.
- Choose **Fly-To Mode**: `Smart height` keeps current altitude, `Set height` climbs/descends to the requested height (requires `Target Height`).
- Relative/absolute commands include mode and speeds in the request log and ack payload for post-flight analysis.
- Telemetry shows live Fly-To mode/height, supported modes, and capability height range (when provided). Treat it as ground truth for accepted parameters. On Matrice 350 RTK we currently see `supported_modes=[]`, so the backend must fall back to waypoint missions.
- RTH Start/Stop buttons emit events in the same command log. They remain disabled unless the aircraft reports GO HOME state.
- When the backend switches to `waypoint_v2`, the ack includes `mission_id`, `mission_path`, and `wayline_ids`. Retrieve the generated KMZ from the bridge cache if additional analysis is required.
- New `waypoint_stop` commands allow operators to abort in-flight waypoint fallbacks; the command history will log the backend and mission id returned from the bridge.

### 4.4 Video Recovery
- On decoder error, streams flush, close, and restart with exponential back-off (250 ms → 2 s). Future work: request fresh keyframe from bridge to shorten recovery.

---

## 5. Mission / Navigation Checklist (WIP)

The following items describe the desired workflow once mission primitives are available. Update steps as each capability ships.

### 5.1 Waypoint / fly-to status
- Android bridge keeps the intelligent Fly-To path for supported products but now falls back to generated Waypoint V2 missions when Matrice 350 RTK reports `supported_modes=[]` or `REQUEST_HANDLER_NOT_FOUND`. Desktop Fly-To panel continues to send basic relative offsets and RTH start/stop (**beta – pending field validation**).
- Map/LRF target selection button exists but depends on upstream panels to supply coordinates; treat as experimental until confirmed on hardware.
- Full mission composition, queueing, orbiting, and automatic abort logic remain TODOs (see Backlog §7.1).

### 5.2 Planned smoke once UI exists (placeholder)
1. Pick current coordinates + `+5 m` altitude → `fly_to_relative` → confirm `status=ok`, observe climb.
2. `Forward 5 m` relative command → verify translation + acknowledgement.
3. `Return Home (start)` → monitor telemetry until hover above home, then `Return Home (stop)` before land.
4. Compose mini mission (takeoff → fly forward → hover → return) via the mission UI; ensure the queue shows progress and abort works.
5. Log RC authority transitions during missions; capture `controller_data` for master/slave sticks once streamed.

Do **not** attempt these steps until mission tooling exists and this section is updated with validated instructions.

---

## 6. Troubleshooting Reference

| Symptom | Likely Cause | Actions |
| --- | --- | --- |
| “Capture Mouse Yaw” disabled | Virtual stick not active | Ensure `Start Keyboard` succeeded (`status=ACTIVE`), check ack history for enable errors (NFZ, authority). |
| `fly_to_prepare` → `Param illegal` | FlySafe bubble or bad target altitude | Inspect the latest ack: check `error_code`/`error_domain` plus `fly_to_context.height_limit_margin`. Negative values indicate a violation—note the warning description + limit and adjust the target. |
| `fly_to_param_update=failed` | `updateMissionParam` rejected (mode/height invalid) | Re-send using a supported mode (`smart_height` or `set_height`) and provide `fly_to_height` for set-height missions. Capture the SDK error code (bridge log) for follow-up. |
| `fly_to_param_update=update_failed` but mission runs | Bridge fell back to previous parameters after param update failure (aircraft not ready) | Review `fly_to_param_message`, capture hardware warnings (Preflight panel), and confirm telemetry `fly_to_status.info` reflects the actual mode/height before retrying. |

---

## 7. Backlog / TODOs

Keep this list groomed; link each item to task tracking where applicable.

### 7.1 Navigation primitives (immediate, in progress)
- Validate existing relative fly-to UI (forward/back/left/right/up/down, optional speed) and RTH start/stop buttons in the field; log any FlySafe/NFZ rejections with `fly_to_context` snapshots.
- Extend Fly-To logging with raw DJI error codes, target altitude, and FlySafe warning height so pilots can diagnose failures quickly (confirm coverage with `waypoint_v2` extras).
- ✅ Waypoint-based fly-to fallback + bridge telemetry/abort controls implemented; next: expose the data and stop button through the desktop UI.
- Modularise the bridge further so intelligent and waypoint backends share a common telemetry/logging layer and the desktop can annotate which path executed.
- Flesh out mission authoring UX inside the Fly-To panel: map-based waypoint creation (MapLibre), HSI/compass overlays, reverse projection from camera taps, laser range finder integration, and “record manual flight” to capture waypoints.
- Add simulation tooling so operators can preview a mission (map trajectory, ETA, simulated telemetry) before execution.
- Determine if DJI simulator can be used to debug mission planning/execution (see docs/SIMULATOR.md) once waypoint telemetry is exposed.

### 7.2 Controller insight & FlySafe
- Gather field validation screenshots/logs for the Controller Insight panel (RC vs SW vs Ack + limits).
- Stream master/slave sticks, switch positions, and active authority reason codes.
- Display RC mode (P/Sport/Tripod) and switch state in UI.
- Surface detailed FlySafe zone listings and auto-highlight violating zones when `IN_NFZ_MAX_HEIGHT` is active.
- Expose flight-controller settings (RTK state, max altitude, avoidance modes) per SDK references for faster diagnosis.

### 7.3 Video & telemetry
- Request a keyframe from the bridge when the decoder restarts.
- HUD speed/altitude units toggle (m/s ↔︎ mph, meters ↔︎ feet).
- Battery widget parity with DJI Pilot (dual packs, warnings).
- Extend manual session exports with full telemetry (altitude, speed, attitude) per frame.

### 7.4 Simulator enablement
- Add bridge command + desktop controls for `SimulatorManager` (enable/disable with location & satellite presets) so we can bench-test without props spinning.
- Document a bench-test checklist: connect aircraft via USB, enable simulator, confirm motors remain off, run takeoff/land/manual overrides, and collect telemetry to ensure parity with live flights.
- Evaluate CI feasibility: script simulator sessions (takeoff → relative fly-to → land) for regression tests once waypoint backend is in place.
- Track limitations in docs (needs physical aircraft, limited physics, wind only via presets) and call out scenarios that still require field validation.

### 7.5 UI polish / Components
- Add Object Memory panel to the Components menu/top bar and fix popover z-order.
- When re-enabling a component via the Components menu, bring its panel to the top-most z-order while keeping saved geometry.
- Promote the Snapshot Camera selector to a movable/resizable panel (persisted in localStorage) and integrate with H20N gimbal mode/zoom selectors.
- Make HSI indicator settings (mode, scale) persistent in localStorage.

### 7.6 Automation & QA
- Scriptable smoke test (takeoff → manual session → kill → land) driven via CLI.
- Simulator mission regression (upload, start, pause/resume, stop, break-point).

---

## 8. Field Test Prep Template

Before heading on-site:
1. Sync repo + rebuild desktop (`npm run build`) and Android (`./build.sh debug`).
2. Verify bridge tablet has latest APK; confirm `adb` connectivity.
3. Print or cache this checklist offline (bridge device may be offline).
4. Prepare data capture: screen recorder, logcat capture (`adb logcat -v time > bridge.log`), telemetry CSV template.
5. Identify safe flight zone with known NFZ limits and altitude caps.

During the test, annotate each significant event (command, toast, diagnostic) with timestamps so logs can be aligned later.

---

_Last updated: Sep 25 2025 – waypoint fallback telemetry + abort controls wired; desktop mission UI next._
