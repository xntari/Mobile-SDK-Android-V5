# Flight Control Status & Test Guide

> ***Critical** — Keep this document in sync with the product at all times. It is the authoritative source for pilots/operators to understand what is safe, what is experimental, and how to validate behaviour before flight. Never remove the safety checklist or downgrade warnings about incomplete features.*

This document captures the current feature set, open work, and test procedures for the bridge + desktop flight-control workflow. Treat it as the pre-flight reference when validating new builds or gathering datapoints in the field.
Use only standard ascii characters here - don't use ✅  or similar
---

## TL;DR (Sep 25 2025 16:45 - workspace, HEAD 20eed558b8917ef4a6fa837a01a1c34a655c3a0c)

- **Document discipline** - Update this file after every bridge/desktop change. Status, safety checklists, operator notes, and backlog items must always reflect the running code. Never mark a feature complete without field verification.
- **Manual mission tooling** - Desktop Fly-To panel now supports map clicks, laser range fixes, manual lat/lon entry, mission simulation, and timeline export; validate on hardware before relying on it in the field.
- **External KMZ playback** - Fly-To panel can ingest DJI Pilot-generated KMZ files, forward them to the bridge, and auto-execute the uploaded mission with logged metadata (name, path, size). Use bench tests/simulator first, then capture field evidence before routine use.
- **Field validation focus** - Collect hardware evidence for the 16 Hz keyboard/mouse stream, `waypoint_v2` fallback (mission id + KMZ logs), external KMZ execution, auto-mode gating, FlySafe toasts, the new mission simulation workflow, and session exports. Capture CSV/JSON logs, telemetry screenshots, and note any NFZ height bubbles blocking movement.
- **Recent changes (latest first)**
  1. 2025-09-25 - Desktop Fly-To panel can pick DJI KMZ missions, push them to the bridge, and log selection metadata (name/path/size) alongside copy-to-clipboard controls.
  2. 2025-09-25 - Waypoint execution state, waypoint index, and interrupt reasons now stream in `waypoint_status.timeline`; Flight Commands + Fly-To panels render the progress list, and fallback takeoff ASL now reuses the RTK home value (no ~6 m offset).
  3. 2025-09-25 - Fly-To panel supports manual targets (map clicks, laser fixes, keyboard entry), mission simulation preview, waypoint stop control, and JSON timeline export.
  4. 2025-09-25 - Intelligent Fly-To is now bypassed on platforms that advertise no supported modes; the bridge immediately generates a Waypoint V2 mission and reports its mission id/path.
  5. 2025-09-25 - Auto-mode telemetry now gates Force Land / RTH Stop buttons; docs updated with gating behaviour.
  6. 2025-09-24 - Fly-to context + FlySafe data stream to the desktop; Controller Insight limits card shows warning heights.
  7. 2025-09-23 - Manual control presets, kill/override audio cues, and keyboard session exports landed.
  8. 2025-09-08 - Simulator research documented (requires real aircraft, motors stay off, full API surface available for bench validation).

  Next

  1. Field-validate the waypoint execution timeline (capture command log JSON plus telemetry screenshots during an actual mission) and confirm takeoff ASL parity between telemetry and fly-to context.
  2. Run bench + field tests of the external KMZ loader (log selection metadata, mission ack, timeline entries, and flight behaviour); document any DJI error codes.
  3. Add KMZ lifecycle tooling (download link + cache rotation) and document a simulator/bench validation flow in the status doc.

---

## 1. Status Snapshot (Sep 25 2025 16:45 – commit 20eed558b8917ef4a6fa837a01a1c34a655c3a0c)

### 1.1 Verified today
- **Take-off / Land / Cancel / Confirm** via bridge commands with detailed acknowledgements, including landing monitor payloads.
- **Compass calibration** start/stop surfaced in the Flight Commands panel, with notifications + audio cues for kill switch, manual release, and hardware override events.
- **Preflight diagnostics panel** streaming DJI health, landing monitor faults, FlySafe limits, and device warnings.
- **Video decoder resilience** – FPV & H20N WebCodecs flush/close on errors with exponential back-off restarts.
- **Manual control tuning UI** – presets for overall stick sensitivity plus per-preset mouse-yaw slider persisted in localStorage.
- **Continuous override stream** – virtual-stick overrides run ~16 Hz, auto-resume after decoder/WebSocket resets, and every frame is captured in session exports.
- **Fly-To waypoint fallback** – When intelligent Fly-To advertises no supported modes, the bridge now generates a Waypoint V2 KMZ (current position → target) and starts it automatically; command acks include mission id/path/wayline ids.
- **Waypoint telemetry/abort plumbing** – Bridge streams `waypoint_status` (execute state, active mission id/path) and exposes a `waypoint_stop` command so the fallback mission can be cancelled from the desktop.
- **Mission start validation** – After pushing a KMZ the bridge now waits for PREPARING/ENTER_WAYLINE telemetry before acknowledging success; early READY/FINISHED/interrupt states surface as explicit errors with DJI codes.
- **Desktop mission UI** – Fly-To panel mirrors waypoint telemetry with an inline stop control, mission log entries, and a map preview fed from the command parameters/telemetry.
- **Waypoint execution timeline telemetry** - Bridge records `waypoint_status.timeline` (state, executing info, last interrupt) and the Fly-To mission log auto-ingests those entries (bench validated with dry runs).
- **External KMZ ingestion (beta)** – Desktop app can pick DJI KMZ missions, stream them to the bridge, and auto-launch the uploaded waypoint file; command logs now include selection metadata plus copy-to-clipboard controls.
- **Waypoint upload guard** – Bridge rejects new fly-to requests while a KMZ upload/start is pending so pilots get an immediate "mission busy" error instead of opaque COMMAND_CAN_NOT_EXECUTE failures.
- **Fly-To takeoff altitude parity** - Waypoint fallback context now uses the same MSL takeoff altitude as telemetry; bench tests no longer show the ~25 m offset from earlier builds.
- **Manual mission planning** – Desktop panel accepts map clicks, laser range fixes, and manual lat/lon/alt inputs, provides a mission simulation summary, and records/exportable mission timelines.
- **Waypoint timeline surfaces** – Mission panels now show the live timeline (state/order, waypoint index, interrupt label) pulled from `waypoint_status.timeline` so operators can confirm progress without diving into logs.

### 1.2 Needs field validation / monitoring
- **Manual keyboard/mouse flight** – lifecycle automation works in dry runs (`virtual_stick_enable → override → disable`). Validate WASD/Space/Shift/QE inputs, pointer-lock yaw/pitch (mouse up = forward, down = backward), and log aircraft response when NFZ limits intervene.
- **Kill switch & release flow** – ESC should zero sticks, disable virtual stick, and emit toast/audio. Confirm behaviour in-aircraft (include CSV/JSON excerpts + screenshots).
- **RC override detection** – bridge streams `authority_owner`/`change_reason`; desktop raises toast/logs when control transfers. Gather evidence during dual-controller swaps.
- **Flight-command error context** – acknowledgements include FC error type/code, FlySafe warning height, and `fly_to_context` (altitude, limit margins, violation flags). Record these when commands fail to build a playbook.
- **Fly-to parameter sync** – `updateMissionParam` attempts report `fly_to_param_update` (`applied/skipped/failed`). Monitor outcomes and collect raw DJI error codes.
- **Waypoint timeline fidelity** – confirm the panel timeline advances through upload/ready/enter-wayline/finished (and any pauses) during real missions; attach timeline JSON + screenshots for regressions.
- **Takeoff ASL parity** – compare telemetry `takeoff_altitude` with mission context `fly_to_context.takeoff_asl` (expect RTK-derived values to match within sensor noise).
- **Fly-to status telemetry** – mission info/capability listeners feed `fly_to_status`. Confirm live mode/height/capability data matches DJI Pilot readouts.
- **Emergency command gating** – Force Land, Cancel/Confirm Landing, and RTH Stop buttons only unlock when telemetry reports AUTO LAND / GO HOME. Validate state transitions on aircraft.
- **Controller Insight panel (beta)** – shows physical RC sticks, software virtual-stick command, last override ack, and flight limits (max height/distance, go-home height). Master/slave telemetry still pending.
- **FlySafe telemetry & toasts** – desktop surfaces DJI FlySafe notifications and surrounding zone data. Capture warning bubble screenshots whenever `IN_NFZ_MAX_HEIGHT` blocks movement.
- **Relative fly-to & RTH desktop panel (beta)** – forward/back/left/right/up/down moves plus RTH start/stop exist; verify aircraft executes commands and collect acknowledgement payloads.
- **Manual session export (CSV/JSON)** – ensure logs capture session start/stop, override frames, kill switch events, and FlySafe restrictions during real flights.
- **Auto-mode status telemetry (beta)** – track GO HOME / AUTO LAND status updates and confirm UI remains in sync with aircraft behaviour.
- **Waypoint fallback missions** – Confirm `backend=waypoint_v2` runs end-to-end (KMZ upload, mission start, completion/abort) and capture generated KMZ files for post-flight analysis.
- **Waypoint mission telemetry** - Validate the new `waypoint_status` stream (state transitions, executing info, timeline entries, last interrupt) and the `waypoint_stop` command against real hardware. Confirm abort resets the mission id and that telemetry clears once the aircraft returns to READY.
- **Takeoff altitude parity** - During field runs compare `takeoff_altitude` in telemetry with `fly_to_context.takeoff_altitude_asl`; report any divergence (expect values to match within sensor noise).
- **Desktop mission preview (beta)** – Check that the Fly-To mission log, stop button, and map preview reflect actual flights (or simulator runs). Capture screenshots, ack payloads, and KMZ paths for traceability.
- **Manual targeting & simulation (beta)** – Verify map-click targets, laser fixes, mission simulation output, and timeline export during real flights; include exported JSON and screenshots in reports.
- **Close-target warnings** – Confirm the UI warnings for <1 m horizontal / <0.5 m vertical adjustments prevent mission uploads and that logs capture the advisory before execution.

**Manual flight refinements pending field sign-off**
- Validate the 16 Hz virtual-stick stream and mouse pitch control on-aircraft (attach CSV/JSON excerpt + pilot feedback).
- Exercise manual session export + FlySafe restriction toasts in real conditions (log files + screenshots).
- Confirm auto-mode gating transitions and document any unmapped flight-mode strings.

---

## 2. Immediate Next Steps (Waypoint Mission Backend)

1. **Field validation package** – Exercise the map/laser/manual targeting + simulation flow and the new external-KMZ loader on hardware (or simulator). Capture screenshots, ack JSON, selection metadata, KMZ paths, and exported timelines for the status archive.
2. **Waypoint authoring expansion** – Extend mission authoring toward multi-point paths (climb legs, loiter/orbit primitives) while preserving the conservative safety defaults.
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
   - While aircraft is intentionally unable to take off (arms folded, compass error, etc.), send a fly-to command and verify the response surfaces the DJI `COMMAND_CAN_NOT_EXECUTE` (or equivalent) error instead of reporting success. Record the mission timeline and command payload.
   - With props secured (or in simulator), press **Select & Execute KMZ** to load a known-good DJI mission file. Ensure the mission log records the name/path/size, the ack reports `backend=waypoint_v2` plus mission id/path, and the timeline steps through UPLOADING → READY → ENTER WAYLINE → FINISHED. Use `waypoint_stop` if the aircraft cannot take off.
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
- Configure **Security Takeoff Height** (m AGL) before sending missions; defaults to 20 m per DJI sample. Combined with `Set height`, this determines the climb profile used by both simulation and execution.
- Takeoff altitude fields (telemetry + fly-to context) now share the SDK-provided MSL value. Use this as the reference for `Target ΔTO` and simulation checks; report any new divergence in field logs.
- Drone metadata in KMZ now uses the actual aircraft enum (M350=89 today); if the SDK cannot match a type we log the enum list and fall back to UNKNOWN. Ack `debug` includes the resolved enum value.
- **Targeting** now supports three inputs: manual lat/lon/alt fields, “Place via map” (click the preview map to drop a waypoint), and “Use laser fix” (captures the most recent LRF result). The source badge beside the heading reflects the current input.
- The **Relative** and **Vertical** quick buttons now stage a target in the planning panel instead of launching immediately; review the simulation (and adjust altitude/offsets) before pressing **Fly to Target**.
- Use **Simulate Mission** to preview the vertical/horizontal legs, distance, and estimated time before committing. Export the results alongside real mission logs for analysis.
- Execute with **Fly to Target** once satisfied with the target/simulation. The command history records all parameters (speed, security height, backend) for post-flight review.
- Telemetry shows live Fly-To mode/height, supported modes, and capability height range. Treat it as ground truth for accepted parameters. On Matrice 350 RTK we currently see `supported_modes=[]`, so the backend must fall back to waypoint missions.
- **Waypoint Preview** displays current backend, mission id/path, and exposes `Stop Waypoint Mission` when a fallback is running. The panel also indicates when placement mode is active.
- KMZ field includes a Copy button so you can drop the generated path into logs before rotating the cache (full KMZ lifecycle tooling still pending).
- **Mission Timeline** (bottom of the panel) aggregates commands, telemetry, simulations, laser captures, and the live `waypoint_status.timeline` (state/executing/interrupt). The mini progress list beside Waypoint Preview mirrors the same data for quick checks. Use `Export JSON` to attach a structured log to field reports. The executing entries now include the raw DJI execute state (preparing/executing/exit) so you can confirm the stage even if the top-level state skips it, and flight-command acks carry a `debug.takeoff_*` bundle for altitude troubleshooting.
- Flight-command acks include `debug.takeoff_*` with the raw SDK values (RTK altitude, geoid conversion inputs) for troubleshooting the ASL offset. Attach these when reporting discrepancies.
- Every Fly-To context now carries `device_status_raw` so the command log shows DJI’s current takeoff blocker (e.g. `CAN'T_TAKEOFF_HMS`). Reference it when missions auto-cancel because arms are folded or GEO locks are active.
- RTH Start/Stop buttons remain available; they stay disabled unless GO HOME is active and their acks continue to populate the mission timeline.
- When the backend switches to `waypoint_v2`, acks include `mission_id`, `mission_path`, and `wayline_ids`. Retrieve the generated KMZ from the bridge cache if additional analysis is required.

### 4.4 External KMZ Missions
- **Select & Execute KMZ** opens the Electron file picker (filters to `.kmz`). After choosing a file the mission log records the name, on-disk path, estimated size, and timestamp so you can reference it in reports.
- The bridge command `waypoint_load_kmz` is sent immediately; expect an ack with `status=ok`, `backend=waypoint_v2`, `mission_id`, `mission_path`, `wayline_ids`, and `source=external_kmz`. Capture these fields alongside `debug` payloads for traceability.
- Use **Copy KMZ Path** to place the cached path on the clipboard before rotating bridge storage. The file lives under `cache/external_waypoints/` on Android.
- Missions start as soon as the upload finishes. Bench test with props removed or in DJI simulator first; live flights should only run vetted missions from Pilot.
- If the aircraft cannot take off (e.g. folded arms), the mission will report `CAN'T_TAKEOFF_HMS`. Use **Stop Waypoint Mission** to abort and close out the timeline entry.
- The mission timeline should show UPLOADING → READY → ENTER WAYLINE → FINISHED. If EXECUTING never appears, include the flight-command ack + telemetry snapshot in the report.

### 4.5 Video Recovery
- On decoder error, streams flush, close, and restart with exponential back-off (250 ms → 2 s). Future work: request fresh keyframe from bridge to shorten recovery.

---

## 5. Mission / Navigation Checklist (WIP)

The following items describe the desired workflow once mission primitives are available. Update steps as each capability ships.

### 5.1 Waypoint / fly-to status
- Android bridge keeps the intelligent Fly-To path for supported products but now falls back to generated Waypoint V2 missions when Matrice 350 RTK reports `supported_modes=[]` or `REQUEST_HANDLER_NOT_FOUND`. Desktop Fly-To panel continues to send basic relative offsets and RTH start/stop (**beta – pending field validation**).
- Desktop mission panel provides map placement, laser capture, manual entry, simulation, and timeline export. These features are ready for bench testing and require on-aircraft validation before operational use.
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
- Waypoint-based fly-to fallback + bridge telemetry/abort controls implemented; desktop mission log/stop/map preview shipped—next up is on-aircraft validation and multi-waypoint authoring.
- Modularise the bridge further so intelligent and waypoint backends share a common telemetry/logging layer and the desktop can annotate which path executed.
- Extend mission authoring toward multi-waypoint workflows (climb-to-altitude legs, hold/orbit primitives, HSI overlays, “record manual flight”).
- Validate the simulation preview against flight telemetry and expose additional configuration (wind assumptions, speed caps, loiter duration).
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
