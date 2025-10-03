# Flight Control Status & Test Guide

> ***Critical** — Keep this document in sync with the product at all times. It is the authoritative source for pilots/operators to understand what is safe, what is experimental, and how to validate behaviour before flight. Never remove the safety checklist or downgrade warnings about incomplete features.*

This document captures the current feature set, open work, and test procedures for the bridge + desktop flight-control workflow. Treat it as the pre-flight reference when validating new builds or gathering datapoints in the field.
Use only standard ascii characters here - don't use ✅  or similar
> **Transcript logging** - Append the user's instructions and your thought process (with ISO 8601 timestamps) to transcript.txt after every working session so we can reconstruct decision history later.
---

## TL;DR (Oct 03 2025 10:15 - workspace, HEAD a9dac908f66c7a5533ebadd768efcb85aac58a97)

- **Document discipline** - Update this file after every bridge/desktop change. Status, safety checklists, operator notes, and backlog items must always reflect the running code. Never mark a feature complete without field verification.
- **Transcript discipline** - Keep transcript.txt current: append the latest user instructions and your thought process with ISO 8601 timestamps whenever you touch the project.
- **Field validation** - Mission Control and gimbal tracking passed bench and field checks; the next focus is Section 2.1 (faster manual tracking, camera dock, collapsible panels, top-bar reflow, latency widget, and 3D terrain groundwork) with fallbacks captured for each workstream.
- **Mission planner** - The shared mission planner store feeds the main map, Fly-To panel, Orientation, and HSI; map clicks (stage/waypoint/orbit) auto-populate targets, default altitudes come from set-height or the safety floor, and multi-waypoint plans now execute through the waypoint fallback backend with logging.
- **Mission plan semantics** - Land steps now keep their mission coordinates, the Mission Control panel exposes “Add Home Waypoint” and “Add Origin (W1)” helpers, and finish actions only trigger when explicit return-home/land entries exist.
- **Mission control editor** - Each waypoint now exposes turn mode/damping, heading (angle/POI/path base), gimbal heading, POI targets, and action groups; exports patch the WPML _and_ embed `mission-metadata.json`, and the loader hydrates those fields when reopening DJI Pilot or desktop plans.
- **Realtime map & video pacing** - Map telemetry now batches through a single requestAnimationFrame cycle (no more per-update `easeTo`), skips recentering while the operator drags, and keeps manual pan smooth; FPV/H20N decoders only throttle when the simulator is running or the panel is hidden so visible feeds stay at full speed.
- **Panel visibility** - Orientation panel unsubscribes from mission/object stores when hidden, and the shared visibility bus now drives the camera throttles—closing a panel tears subscriptions down immediately.
- **Camera control dock** - The new floating dock consolidates gimbal/LookAt controls, manual-track presets, lens-specific zoom selectors (optical + thermal), capability probing, and FPV HUD/snapshot settings; thermal super-resolution toggles currently persist UI intent while we confirm SDK key support.
- **Fly-To refactor** - Fly-To now fronts the mission planner (defaults, target staging, KMZ import/export). Multi-waypoint runs with RTH/Land finish actions were validated; orbit execution/export still needs work.
- **Map controls** - Map auto-center now has a manual toggle beside auto-rotate; click drops a waypoint, Ctrl/⌘+click stages a target, and Option+click adds an orbit without breaking drag-to-pan.
- **Manual mission tooling** - Desktop Fly-To panel supports map clicks, laser fixes, manual lat/lon entry, mission-wide simulation, and timeline export; validate on hardware before relying on it in the field.
- **KMZ workflow** - Mission Control writes `waylines.wpml` plus `mission-metadata.json` when exporting, and the loader restores either metadata or raw WPML (turns/POI/gimbal/actions) so DJI Pilot plans round-trip without losing detail; execution remains manual after review.
- **Performance watch** - Map rAF batching and the camera throttles landed; FPV/H20N rendering now runs through an OffscreenCanvas worker so the renderer trace stays comfortably under frame budget (continue profiling long sessions for decoder spikes).
- **Preflight visibility** - Preflight panel now surfaces return-to-home altitude, max height/distance, failsafe action, obstacle toggles, controller stick mode, and battery warning thresholds (with telemetry fallbacks) so pilots can cross-check DJI Pilot settings at a glance.
- **Preflight configurables** - Flight limits, signal-lost behaviour, and Remote ID area/operator IDs can be edited directly from the Preflight panel; bridge commands mirror updates to the aircraft and return DJI error context.
- **Regulatory gating** - Remote ID status reports via `UASRemoteIDManager` (area strategy defaults to US, missing operator IDs surface warnings but do not block bench flights). Fly Safe refresh triggers `getFlyZonesInSurroundingArea` so nearby restrictions are visible even in private airspace.
- **Quick command strip** - Top bar shows Take-off/Land/RTH/Virtual Stick shortcuts with Shift+hotkeys, dual battery readouts (aircraft + RC placeholder), live mission status, and clickable altitude/speed tiles that open Flight Commands.
- **Mission Control rename** - Fly-To & RTH panel is retitled “Mission Control,” exposed in Components menu/top-bar mission badge, and the Land quick action now commands an in-place landing while new `set_home_current` and keyboard shortcuts wire through the bridge.
- **Power telemetry** - RC pack percentage streams with controller payloads and feeds both Preflight and the top bar; aircraft pack still derives from battery messages with preflight fallback.
- **Field validation focus** - Collect hardware evidence for the 16 Hz keyboard/mouse stream, mission-plan execution (including altitude hold versus security floor), `waypoint_v2` fallback (mission id + KMZ logs), external KMZ execution, auto-mode gating, FlySafe toasts, the new mission simulation workflow, and session exports. Capture CSV/JSON logs, telemetry screenshots, and note any NFZ height bubbles blocking movement.
- **Recent changes (latest first)**
  1. 2025-09-30 - Bridge now understands DJI Pilot WPML features: per-waypoint turn/damping overrides, mission-config drone/payload descriptors, heading/POI/yaw settings, and action groups (`gimbalRotate`, `gimbalEvenlyRotate`, `takePhoto`, `rotateYaw`). The first gimbal strategy (`poi_track_aircraft`) keeps the aircraft nose on the POI and auto-computes gimbal pitch.
  2. 2025-09-29 - Mission Control land-in-place semantics, Add Home/Origin helpers, and Preflight Remote ID & flight-limit editors shipped (`flight_settings_update`, `remote_id_update`, `flysafe_refresh`).
  3. 2025-09-29 - FPV/H20N video pipelines move draw calls to an OffscreenCanvas worker, and map animation reverted to the pre-smoothing behaviour after trace validation.
  4. 2025-09-28 - Multi-waypoint mission plans now run end-to-end (planner → bridge → waypoint fallback), security take-off height clamps plan legs, default altitudes follow set-height or the safety floor, Orientation/HSI render home + next-waypoint arrows, and `KeyK` fires the motor start/shutdown stick macro.
  5. 2025-09-27 - Flight Commands panel now exposes simulator enable/disable with location presets; bridge telemetry/command acks include simulator state and the Fly-To panel shows the active mode badge.
  6. 2025-09-27 - Waypoint telemetry now captures pause/resume events, waypoint break-point info, and DJI error detail; Flight Commands and Fly-To panels add Pause/Resume controls that dispatch the bridge commands.
  7. 2025-09-25 - Desktop Fly-To panel can pick DJI KMZ missions, push them to the bridge, and log selection metadata (name/path/size) alongside copy-to-clipboard controls.
  8. 2025-09-25 - Waypoint execution state, waypoint index, and interrupt reasons now stream in `waypoint_status.timeline`; Flight Commands + Fly-To panels render the progress list, and fallback takeoff ASL now reuses the RTK home value (no ~6 m offset).
  9. 2025-09-25 - Fly-To panel supports manual targets (map clicks, laser fixes, keyboard entry), mission simulation preview, waypoint stop control, and JSON timeline export.
  10. 2025-09-25 - Intelligent Fly-To is now bypassed on platforms that advertise no supported modes; the bridge immediately generates a Waypoint V2 mission and reports its mission id/path.
  11. 2025-09-25 - Auto-mode telemetry now gates Force Land / RTH Stop buttons; docs updated with gating behaviour.
  12. 2025-09-24 - Fly-to context + FlySafe data stream to the desktop; Controller Insight limits card shows warning heights.
  13. 2025-09-23 - Manual control presets, kill/override audio cues, and keyboard session exports landed.
  14. 2025-09-08 - Simulator research documented (requires real aircraft, motors stay off, full API surface available for bench validation).

Most recent verified features (2025-10-01):
=====================================================
  **Mission Control (POI/orbit + LookAt integration)** - Curved fly-through uploads are stable; next we need to validate and refine the new POI/orbit workflow (global POI marker, orbit-mode defaults, and LookAt tooling). Upcoming work:
     - Field-verify drift and gimbal modes (sim + hardware) to confirm headings, LookAt start/stop, and telemetry all stay in sync; capture logs/ack payloads for both success and failure cases.
     - Harden POI lifecycle (altitude persistence, reset semantics) and surface LookAt command status in Mission Control/H20N so operators see when tracking fails.
     - Wire LookAt state into mission telemetry/extra fields so the desktop timeline shows when we requested/stopped tracking (and highlight any DJI errors).
     - Confirm the new LookAt altitude reference flag (`altitude_reference=egm96|wgs84`) stays accurate end-to-end: LookAt now converts EGM96 inputs to WGS84 before calling the SDK, but we still need to validate DJI's geoid offset on-aircraft and surface when a POI already provides WGS84 heights (e.g., raw LRF payloads).
     - Validate the dedicated `LOOK_AT_GIMBAL_FREE` control path in both H20N and Mission Control – the desktop now sets the gimbal attitude mode to FREE before dispatching LookAt, and Mission uploads pick `gimbal_free` vs `gimbal_following`; verify aircraft yaw behaviour matches expectations.
     - Document the operator flow (map click, staged target, LRF set, H20N panel) and update training notes once bench validation is complete.

  - Sample analysis - Keep diffing the DJI Pilot KMZ files under tmp_missions/pilot_generated/ to confirm how POI yaw lock, gimbal look-at, and orbit metadata are encoded.
  - Bridge updates - Introduce LookAt helpers (free, following, zoom circle) in the gimbal bridge, repoint orbit marker telemetry to the shared POI store, and ensure mission uploads toggle between aircraft-yaw control and LookAt gimbal control based on the selected orbit mode.
  - Geoid conversions - Audit DJI SDK helpers for geoid offsets (so far only `GpsUtils.egm96Altitude` is exposed; we backfilled EGM96→WGS84 via `GeoidModel.mslToEllipsoid`). Identify whether DJI ships an inverse helper before we rely on the bespoke model outside the West Coast.
  - Desktop planner - Update Mission Control state types and UI to surface the orbit mode selector, treat the orbit marker as the POI indicator, and round-trip the chosen mode through KMZ export/import without reintroducing legacy orbit actions.
  - Camera panel - Extend the H20N gimbal mode component with the new LookAt options plus manual target entry so operators can validate POI tracking outside of missions.
  - Verification - Bench test look-at commands (simulator + hardware) capturing yaw, gimbal pitch, and LookAt state telemetry; then run curved missions in `drift` and `gimbal` modes to confirm the aircraft or gimbal tracks the POI as expected.

  - **Object memory POI integration** – Promote named clusters from the Object Memory service into the Mission Control POI picker so a persistent cluster can seed LookAt/mission orbit runs (cluster CRUD + coordinate provenance needs to flow through `missionPlannerStore`). Bench-test with stored cluster coordinates and ensure LookAt altitude references stay consistent.
=====================================================

## Completed backlog items

- Components menu once again exposes Object Memory and Preflight, and clicking the SYSTEM badge in the top bar opens the Preflight checklist.
- FPV/H20N canvases stop rendering when panels are hidden or simulator mode is active, and drawing now occurs inside an OffscreenCanvas worker to keep the renderer responsive.
- Preflight panel shows RTH/max altitude & distance, obstacle toggles, stick mode, and battery thresholds with telemetry fallbacks; power stats now stream alongside existing diagnostics.
- Top bar status strip adds hotkeys for Take-off/Land/RTH/Set Home/Virtual Stick, dual battery readouts (aircraft + RC via `RemoteControllerKey.KeyBatteryInfo`), mission status shortcut, and clickable altitude/speed tiles that jump to Flight Commands.
- Top bar layout locked to a single-row strip; quick commands now stay on one line (scrollable when needed) so telemetry tiles remain aligned.
- Battery telemetry parity restored: bridge emits aggregated pack data (`battery.percentage`, voltage, current, temp, cell voltages) plus RC charge via `KeyBatteryInfo`, and the UI normalizes both `battery_status` shapes so top-bar/Preflight readings match SDK widgets.
- “Set Home” quick action lives alongside other mission shortcuts; Shift+H triggers the new `set_home_current` bridge command, and acknowledgements include previous/new home coordinates plus aircraft position context.
- Mission Control landing semantics updated: land steps now keep their mission coordinates, “Add Home Waypoint” and “Add Origin (W1)” helpers append map/home points, and mission plans surface finish actions without forcing a return-to-home detour.
- Mission Control altitude defaults now rely on the SDK-provided takeoff ASL; mission plan previews/exports keep that reference so smart-height vs set-height matches DJI sample logic.
- Mission planner exposes straight vs curved path selection and per-waypoint gimbal pitch editing (beta). `path_mode` is forwarded to the waypoint executor, the mission builder now sets `useStraightLine=0`, curved turn mode, and damping in both Kotlin and exported KMZs, gimbal pitch nodes are written even when missing, and the top bar adds Mission Start/Pause/Resume/Stop hotkeys (Shift+M/P/O/E) wired into mission control + waypoint pause/resume/stop commands.
- Reference KMZs (`tmp_missions/generated_tests/test-curved.kmz`, `tmp_missions/generated_tests/test-straight.kmz`) capture the updated encoding for QA—curved turn mode, damping, and gimbal pitch fields can be inspected without rerunning the planner.
- Curved missions now align with DJI WPML: patch logic writes `toPointAndPassWithContinuityCurvature` for interior legs, zeroes damping at endpoints, and clamps simulator ASL throughout sim runs; exported KMZs mirror the same structure (start/finish stop, middle pass, damping 10 m).
- Bridge now mirrors DJI Pilot waypoint metadata: mission-config overrides, per-waypoint turn/damping, heading/POI targets, gimbal heading, and action groups (`gimbalRotate`, `gimbalEvenlyRotate`, `takePhoto`, `rotateYaw`) plus the first POI gimbal strategy (`poi_track_aircraft`) that keeps the nose on target while pitching automatically.
- Additional DJI Pilot mission samples saved under `tmp_missions/pilot_generated/` (gimbal, curved stop, EGM96 altitude, coordinated turn, POI center, aircraft yaw) serve as reference material for upcoming feature parity work.
- Simulator enable now carries the requested altitude end-to-end: the desktop prefills altitude from the current takeoff ASL, the bridge records it, and telemetry reuses the configured value throughout simulator runs (including during mission execution) so home/aircraft ASL stay stable in bench tests.
- Preflight panel now exposes editable flight limits (RTH altitude, max altitude/distance, failsafe action) and Remote ID configuration; updates flow through new bridge commands (`flight_settings_update`, `remote_id_update`) with real-time telemetry snapshots.
- Remote ID snapshot stream surfaces area strategy, operator registration state, and status payloads from `UASRemoteIDManager`. Quick actions send area changes, operator IDs, or refreshes while logging DJI error feedback.
- Fly Safe refresh command invokes `getFlyZonesInSurroundingArea`, and Preflight warnings panel now offers a manual refresh shortcut for NFZ diagnostics.
- Fly-To panel is now branded “Mission Control,” reachable via Components menu and top-bar mission badge; land-in-place quick action rides along with the renaming (path-mode/orbit/gimbal actions still pending).
- Controller payloads include RC battery percentage (via `RemoteControllerKey.KeyBatteryInfo` reflection), wiring power telemetry through to Preflight and the top bar.

### Remote ID & Fly Safe Notes
- Area strategy defaults to `US_STRATEGY`; switch to the appropriate region (EUROPEAN/JAPAN/FRANCE/CHINA) before live flights to match local regulations and clear Remote ID warnings.
- Operator registration numbers are optional for bench testing—the aircraft still arms, but `UASRemoteIDStatus` reports the missing identifier until populated. Capture status snapshots before/after updates for compliance evidence.
- Fly Safe refresh triggers `getFlyZonesInSurroundingArea` so nearby NFZs are visible; missions outside DJI polygons continue to arm, but height-limited zones still return DJI warning codes in command acknowledgements.

  4. Camera pipelines: implement full pacing logic—feeds run at 60 FPS when visible, drop frames (rather than render late) under burst load, and only throttle/stop when the sim is active or the panel is hidden. Goal: eliminate the intermittent “System” (drawImage) spikes without sacrificing real-flight frame rate.
  5. After the UI stays responsive in long bench sessions, move back to field validation (multi-waypoint + Return Home/Land, orbit behaviour) and capture logs/screens once the mission pipeline is exercised on-aircraft.

---

## 1. Status Snapshot (Sep 25 2025 16:45 – commit 20eed558b8917ef4a6fa837a01a1c34a655c3a0c)

### 1.1 Verified today
- **Take-off / Land / Cancel / Confirm** via bridge commands with detailed acknowledgements, including landing monitor payloads.
- **Compass calibration** start/stop surfaced in the Flight Commands panel, with notifications + audio cues for kill switch, manual release, and hardware override events.
- **Preflight diagnostics panel** streaming DJI health, landing monitor faults, FlySafe limits, and device warnings.
- **Video decoder resilience** – FPV & H20N WebCodecs flush/close on errors with exponential back-off restarts.
- **Manual control tuning UI** – presets for overall stick sensitivity plus per-preset mouse-yaw slider persisted in localStorage.
- **Continuous override stream** – virtual-stick overrides run ~16 Hz, auto-resume after decoder/WebSocket resets, and every frame is captured in session exports.
- **Simulator controls (bench)** – Flight Commands panel enable/disable calls bring up DJI simulator with location presets (motors stay off); telemetry + command acks now report simulator state and the Fly-To badge tracks the active mode.
- **Simulator video gating** – FPV and H20N decoders automatically pause (status overlay + listener cleanup) while simulator mode is enabled to keep desktop performance snappy.
- **Mission plan drafting (beta)** – Fly-To panel can stage multiple waypoints/orbits, renders them on the live telemetry map, logs each addition, and now dispatches the entire plan via the waypoint backend (watch the new Execute button).
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
- **Pause/resume telemetry & controls** – Bridge emits mission pause/resume events with DJI error context and latest break-point info; desktop adds Pause/Resume buttons so operators can clear a pause without adb or Pilot.
- **Manual keyboard/mouse flight** – lifecycle automation works in dry runs (`virtual_stick_enable → override → disable`). Validate WASD/Space/Shift/QE inputs, pointer-lock yaw/pitch (mouse up = forward, down = backward), and log aircraft response when NFZ limits intervene.
- **Manual session export (CSV/JSON)** – ensure logs capture session start/stop, override frames, kill switch events, and FlySafe restrictions during real flights.
- **Waypoint fallback missions** – Confirm `backend=waypoint_v2` runs end-to-end (KMZ upload, mission start, completion/abort) and capture generated KMZ files for post-flight analysis.
- **FlySafe telemetry & toasts** – desktop surfaces DJI FlySafe notifications and surrounding zone data. Capture warning bubble screenshots whenever `IN_NFZ_MAX_HEIGHT` blocks movement.

### 1.2 Needs field validation / monitoring
- **Kill switch & release flow** – ESC should zero sticks, disable virtual stick, and emit toast/audio. Confirm behaviour in-aircraft (include CSV/JSON excerpts + screenshots).
- **RC override detection** – bridge streams `authority_owner`/`change_reason`; desktop raises toast/logs when control transfers. Gather evidence during dual-controller swaps.
- **Flight-command error context** – acknowledgements include FC error type/code, FlySafe warning height, and `fly_to_context` (altitude, limit margins, violation flags). Record these when commands fail to build a playbook.
- **Fly-to parameter sync** – `updateMissionParam` attempts report `fly_to_param_update` (`applied/skipped/failed`). Monitor outcomes and collect raw DJI error codes.
- **Waypoint timeline fidelity** – confirm the panel timeline advances through upload/ready/enter-wayline/finished, records pause/resume events, and populates break-point info during real missions; attach timeline JSON + screenshots for regressions.
- **Takeoff ASL parity** – compare telemetry `takeoff_altitude` with mission context `fly_to_context.takeoff_asl` (expect RTK-derived values to match within sensor noise).
- **Fly-to status telemetry** – mission info/capability listeners feed `fly_to_status`. Confirm live mode/height/capability data matches DJI Pilot readouts.
- **Emergency command gating** – Force Land, Cancel/Confirm Landing, and RTH Stop buttons only unlock when telemetry reports AUTO LAND / GO HOME. Validate state transitions on aircraft.
- **Controller Insight panel (beta)** – shows physical RC sticks, software virtual-stick command, last override ack, and flight limits (max height/distance, go-home height). Master/slave telemetry still pending.
- **Relative fly-to & RTH desktop panel (beta)** – forward/back/left/right/up/down moves plus RTH start/stop exist; verify aircraft executes commands and collect acknowledgement payloads.
- **Auto-mode status telemetry (beta)** – track GO HOME / AUTO LAND status updates and confirm UI remains in sync with aircraft behaviour.
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

## 2. Immediate Next Steps

### 2.1 UI/UX and Gimbal Enhancements (Oct 2025)

1. **Accelerate manual gimbal tracking loop**
   Status: Adjustable yaw/pitch gains, deadband, smoothing, and loop-rate presets now live in the camera control dock and persist per payload. Next step is to capture field feedback (real aircraft + sim) to tune preset defaults and confirm we stay clear of ±300° yaw saturation.
   Risks: Over-aggressive presets may still oscillate on specific payload firmware; loop-rate increases can collide with bridge latency during poor links.
   Alternatives: Provide a “stability” preset that clamps rates and widen documentation on how to revert to SDK LookAt if oscillations appear.

2. **Unified camera control dock follow-ups**
   Status: Dock now drives lens selection, thermal zoom (2×/4×/8×), laser enable, and FPV HUD presets, and the panel scrolls cleanly after resizing; H20N crosshair/aim cues are restored and FPV overlays were decluttered. Still pending: wiring remaining payload widgets (object memory staging, orientation debug), refining resize handles, and expanding telemetry readouts.
   Risks: Additional modules may bloat the dock or reintroduce heavy render costs; dragging over video feeds still needs focus/keyboard QA.
   Next: Audit hover/focus behaviour, add keyboard shortcuts, and document layout import/export conventions before broader rollout.

3. **Collapsible architecture across major panels**
   Status: ✅ Mission Control, Object Memory, Preflight, Orientation/HSI, and Flight Commands now share the collapsible section framework. Each panel stores open state in localStore, exposes section summaries (e.g., warning counts, RTH altitude), and keeps telemetry blocks accessible without scrolling. HSI visualisation still lives inside Orientation; merging obstacle cues + HSI overlays into that component remains outstanding.
   Next: Finish the HSI merge (obstacle sectors, altitude bands) and badge collapsed headings when alerts are active so operators cannot hide faults accidentally. Verify subscription teardown costs after long sessions and profile layout persistence against legacy saves.
   Risks: Legacy layouts depend on fixed heights; hiding warnings behind collapsed headings could mask critical alerts if badges regress.
   Alternatives: Keep legacy HSI as optional component until merged view proves reliable; badge collapsed headings with warning counts to avoid silent failures.

4. **Style presets and tokenisation**
   Plan: Define theme tokens (default, minimal, jet-fighter, tight spacing) and expose a style preset picker in Settings. Persist preset + custom overrides via localStore/layouts while keeping accessibility contrast thresholds. Provide one-click resets for new operators.
   Risks: Token refactor may conflict with bespoke CSS in existing panels; older saved layouts might require migration shims.
   Alternatives: Ship presets gradually (default + experimental) and maintain a compatibility layer that maps legacy class names until users migrate.

5. **Top bar density, simulator badge, and latency widget**
   Plan: Reflow the top bar to remove macOS window dots, group status blocks on the left, push hotkeys mid-bar, and anchor GPS/battery/time/right. Add a simulator mode indicator with quick toggles and surface a latency badge (UI→bridge ping or health timestamp delta) with alert thresholds.
   Risks: Narrow viewports and localisation may overflow; naive ping loops could contend with command traffic.
   Alternatives: If active probing is too noisy, reuse telemetry timestamps and only display delta; offer a “classic bar” toggle until responsive layout stabilises.

6. **Latency + bandwidth diagnostics widget**
   Plan: Build a collapsible diagnostics strip (likely adjacent to the new dock) that shows UI↔bridge RTT, WebSocket backlog, and optional command retry counts. Persist sampling rate and history depth per user.
   Risks: Extra instrumentation may consume bandwidth on weak links; inaccurate RTT during heavy traffic could mislead operators.
   Alternatives: Allow operators to throttle/disable probes and rely on existing logbook entries if the widget proves noisy.

7. **3D terrain-aware mission planning**
   Plan: Prototype MapLibre GL JS terrain (Terrain-RGB) with offline caching, overlay 2D/3D mission paths, and tie probes back into the EGM96 workflow. Document fallback options (CesiumJS, Mapbox GL JS, Google Maps) with cost/performance comparisons.
   Risks: Terrain tiles may blow through cache budgets; differing geoid models can confuse altitude previews; older GPUs might stutter under 3D load.
   Alternatives: Fall back to hybrid 2D map plus terrain cross-section while we validate caching; gate 3D mode behind a beta toggle if geoid alignment remains suspect.

8. **Mission planning UX groundwork for agent-driven flows**
   Plan: Streamline object-memory/POI selection to a guided, two-click experience, unify layout export/import so agent services can choose presets, and align data structures with upcoming natural-language planner APIs.
   Risks: Simplifying the UI may hide expert features; designing around unfinalised agent APIs could cause rework.
   Alternatives: Provide “basic” and “pro” modes while we iterate with the agent team; keep manual controls accessible via the Components menu until automation stabilises.

### 2.2 Waypoint Mission Backend (backlog)

1. **Field validation package** – Exercise the map/laser/manual targeting + simulation flow and the new external-KMZ loader on hardware (or simulator). Capture screenshots, ack JSON, selection metadata, KMZ paths, and exported timelines for the status archive.
2. **Waypoint authoring expansion** – Extend mission authoring toward multi-point paths (climb legs, loiter/orbit primitives) while preserving the conservative safety defaults.
3. **KMZ lifecycle & logging** – Surface generated KMZ metadata (download link + checksum) in the desktop logbook and add cache rotation on the bridge so `fly_to_waypoints/` does not grow indefinitely.
4. **Operator guidance & validation** – Document the waypoint fallback checklist, collect field evidence (KMZ + telemetry) across firmware variants, and update UI messaging so pilots know when they are flying an intelligent vs. waypoint backend.

### 3. Identify why the app crashes sometimes:

```
 - sysctlbyname for kern.hv_vmm_present failed with status -1[33455:0929/164428.308724:ERROR:tile_manager.cc(835)] WARNING: tile memory limits exceeded, some content may 
not draw                                                                           
[33455:0929/164428.310136:ERROR:tile_manager.cc(835)] WARNING: tile memory limits exceeded, some content may not draw                                                  
[33455:0929/164428.310772:ERROR:tile_manager.cc(835)] WARNING: tile memory limits exceeded, some content may not draw
```
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
- **Motor macro (KeyK)** – Press `KeyK` while manual control is active to send the dual-stick arm/disarm pattern (~1.2 s hold). The command log records the override event; always confirm props are clear before using it on hardware.

### 4.2 Simulator Mode (bench)
- The Flight Commands panel now includes simulator controls. Set latitude/longitude (defaults pull from the latest home point or aircraft position), choose a satellite count (defaults to 12), optionally add an altitude hint, then press **Enable Simulator**. Command acknowledgements capture the `requested` payload and telemetry flips `simulator.mode=simulator`.
- Quick presets — **Use Home**, **Use Aircraft**, and **Use Config** — make bench setups faster. A powered aircraft connection is still required; props stay off while simulator telemetry reflects the virtual flight.
- Use **Disable Simulator** to return to live control. The Fly-To panel mirrors the REAL/SIMULATOR badge so mission planning stays aligned with bridge state.
- FPV and H20N video pipelines automatically stop decoding when the simulator is active; the cards show a “Simulator Mode” overlay until you return to live flight.
- Capture bench evidence (command ack JSON, telemetry snapshot, `adb logcat`) whenever you exercise the simulator so field crews can trust the workflow.

### 4.3 Diagnostics & Logging
- Preflight panel auto-refreshes DJI device status, diagnostics, and landing monitor payloads.
- Command history includes landing-monitor snapshots and FlySafe messages for post-flight analysis.
- Console logging: `[ManualControl]` for authority transitions, `[FPV]/[H20N]` for decoder restarts.
- Each fly-to ack includes `fly_to_context` (current altitude, limit margins, violation flags); capture these during investigations.
- `fly_to_param_update` reports whether the bridge pushed Fly-To mode/height (`applied`, `skipped`, or `failed`). Review alongside `fly_to_param_message` when commands fail.
- Telemetry exposes `fly_to_status` (info/target/capability). Export with session logs to document accepted parameters.
- Command history records `fly_to_param_steps` (mode/height update attempts) and the raw DJI error string.

### 4.4 Fly-To & RTH Panel
- A mode badge (REAL/SIMULATOR) now sits above the panel; confirm it reads SIMULATOR before running bench missions and REAL before live flights.
- Configure **Security Takeoff Height** (m AGL) before sending missions; defaults to 20 m per DJI sample. Combined with `Set height`, this determines the climb profile used by both simulation and execution.
- Waypoint fallback now clamps both the climb waypoint and target waypoint to that security height unless the pilot explicitly requests a lower altitude (Set Height / absolute target). Expect no more 2 m hover after takeoff; report any regressions with command/telemetry logs.
- The live map now shares the primary MapDisplay feed: aircraft/home markers update with telemetry, staged targets highlight immediately, and planned waypoints/orbits render as you build a mission.
- The main **Map** panel is now interactive: Click to stage the mission target, `Shift+Click` to append a waypoint, and `Option/Alt+Click` to add an orbit placeholder (radius/turns honour the Fly-To panel settings). These updates stream straight into the mission timeline and HSI.
- Use the new **Mission Plan (beta)** card to queue multiple waypoints or orbit placeholders (radius + turns). Entries log to the mission timeline so benches capture context even before waypoint generation ships.
- The Execute button converts the staged plan into a Waypoint V3 mission; confirm the geometry in simulator/bench first, especially for orbit placeholders (currently treated as straight fly-to points).
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

### 4.5 External KMZ Missions
- **Select & Execute KMZ** opens the Electron file picker (filters to `.kmz`). After choosing a file the mission log records the name, on-disk path, estimated size, and timestamp so you can reference it in reports.
- The bridge command `waypoint_load_kmz` is sent immediately; expect an ack with `status=ok`, `backend=waypoint_v2`, `mission_id`, `mission_path`, `wayline_ids`, and `source=external_kmz`. Capture these fields alongside `debug` payloads for traceability.
- Use **Copy KMZ Path** to place the cached path on the clipboard before rotating bridge storage. The file lives under `cache/external_waypoints/` on Android.
- Missions start as soon as the upload finishes. Bench test with props removed or in DJI simulator first; live flights should only run vetted missions from Pilot.
- If the aircraft cannot take off (e.g. folded arms), the mission will report `CAN'T_TAKEOFF_HMS`. Use **Stop Waypoint Mission** to abort and close out the timeline entry.
- The mission timeline should show UPLOADING → READY → ENTER WAYLINE → FINISHED. If EXECUTING never appears, include the flight-command ack + telemetry snapshot in the report.

### 4.6 Video Recovery
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
- Waypoint fallback + mission planner execution path is live; next step is on-aircraft validation (security-height hold, pause/resume, break-point recovery, KMZ import/export) with full timeline/export logs.
- Modularise the bridge further so intelligent and waypoint backends share a common telemetry/logging layer and the desktop can annotate which path executed.
- Mission Control rename: expose the panel as a first-class component, land-in-place by default, and surface Waypoint flight-path mode (straight vs curved).
- Add orbit mission authoring that actually executes via Waypoint V3 (radius/turns persisted) and layer in gimbal actions/POI locks for scripted camera moves.
- Inventory all available Waypoint mission actions (breakpoints, gimbal cues, payload triggers) and document which APIs we need to surface in Mission Control.
- Validate the mission-wide simulation preview against flight telemetry and expose additional configuration (wind assumptions, speed caps, loiter duration).
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
- Battery widget/top-bar parity with DJI Pilot (dual aircraft packs + RC pack, warnings).
- Extend manual session exports with full telemetry (altitude, speed, attitude) per frame.
- FPV/H20N decode loops now tear down when panels are hidden or the simulator is active, and visible streams render through an OffscreenCanvas worker to lighten the main thread; gather long-session traces to confirm restarts behave when returning to live video.

### 7.4 Simulator enablement
- Simulator controls (enable/disable with location & satellite presets) ship in the Flight Commands panel; gather bench evidence that telemetry/video gating behaves and capture ack/error logs.
- Document a bench-test checklist: connect aircraft via USB, enable simulator, confirm motors remain off, run takeoff/land/manual overrides, and collect telemetry to ensure parity with live flights.
- Evaluate CI feasibility: script simulator sessions (takeoff -> relative fly-to -> land) for regression tests once waypoint backend is in place.
- Track limitations in docs (needs physical aircraft, limited physics, wind only via presets) and call out scenarios that still require field validation.

### 7.5 UI polish / Components
- Expand Preflight to surface RTH/max altitude, obstacle avoidance toggles, signal lost action, max flight distance, stick mode, and battery warning thresholds (match DJI Pilot layout).
- Add a compact top-bar status strip (flight mode, mission shortcuts for take-off/land/RTH, VS enable/disable + keyboard, set home, live altitude/speed with click-through to Flight Commands).
- When re-enabling a component via the Components menu, bring its panel to the top-most z-order while keeping saved geometry.
- Promote the Snapshot Camera selector to a movable/resizable panel (persisted in localStorage) and integrate with H20N gimbal mode/zoom selectors.
- Make HSI indicator settings (mode, scale) persistent in localStorage.

### 7.6 Automation & QA
- Scriptable smoke test (takeoff → manual session → kill → land) driven via CLI.
- Simulator mission regression (upload, start, pause/resume, stop, break-point).

### 7.7 Performance & Profiling
- Verify the new rAF-driven map update path during long bench sessions (dragging, zoom, live telemetry); capture a fresh trace if jitter returns or if jump-to still competes with manual pans.
- Move heavy computation (mission preview math, large KMZ parsing) off the renderer main thread via Web Workers/worker_threads.
- Audit BrowserWindow hardware acceleration/offscreen settings; ensure OffscreenCanvas/WebCodecs are actually engaged when available.
- Use Chrome DevTools (Performance/Web Vitals, `about:tracing`) to isolate the remaining FPV/H20N "system" spikes and compare frame times with single vs dual video streams.

### 7.8 Mapping enhancements
- Add a 3D mission planning view (incl. edit mode) with optional street/satellite/topographic layers; evaluate MapLibre plugins vs alternative map providers.

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
Keep conversation history updated in transcript.txt. Read-friendly formatting. Use verbose/full transcript
_Last updated: Sep 29 2025 - Map telemetry now batches via rAF, FPV/H20N throttles respect simulator/visibility state, and performance follow-ups focus on decoder spikes._
