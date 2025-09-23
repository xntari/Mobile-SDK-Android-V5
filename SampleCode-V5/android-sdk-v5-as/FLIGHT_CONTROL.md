# Flight Control Implementation Plan

## P0 — Foundational Setup

- Audit current flight control features against the reference repo (`eee-Andrew/Mobile-SDK-Android-V5`) to document gaps and ensure SDK usage parity.
- Inventory bridge message types, Android view models (BasicAircraftControlVM, IntelligentFlightVM, WayPointV3VM, DiagnosticVm), and desktop modules (`bridgeManager`, diagnostics panel).
- Draft JSON schema one-pagers for `flight_command`, `waypoint_command`, `diagnostic_status`, and enriched `battery_status`; review with stakeholders before coding.

## 🔄 P2 — Waypoint Command Channel

### Next Steps

1. ✅ Finish desktop "Flight Commands" panel to drive new bridge actions and display acknowledgements.
2. Flesh out `DJIBridgeServer.handleWaypointCommand` using the schema (upload/start/pause/resume/stop/set_break_point/query_state).
3. Build mission management UI (KMZ selection, progress, state board) and stream mission callbacks to the desktop.
4. Run simulator mission dry-runs; capture logs for validation.

5. **Schema Definition**
   - Define verbs: `upload_kmz`, `start`, `pause`, `resume`, `stop`, `set_break_point`, `clear_listeners`, `query_state`; include parameter validation rules.
6. **Android Implementation**
   - Flesh out `DJIBridgeServer.handleWaypointCommand` to call `WayPointV3VM`/`WaypointMissionManager`, streaming progress and state updates back to clients.
   - Ensure mission listeners propagate live telemetry to the desktop.
7. **Desktop UI**
   - Create mission management UI (file chooser, state board, progress bars, action buttons).
   - Surface errors and current waypoint data in real time.
8. **Validation**
   - Exercise simulator with sample KMZ, validate pause/resume/break-point behaviors.

## 🔄 P3 — Refactored Top Bar & Battery Telemetry

### Immediate Priority

### Status

- Altitude/telemetry stream now aligned with SDK HUD (ASL/AGL fields, system status, diagnostics, GPS/RC signal).
- Desktop Top Bar refreshed to show system state, GPS/RC strength, and diagnostic summary.
- Remaining: battery widget parity (dual pack voltages/warnings) and legacy UI updates.

- Mirror DJI Top Bar/Attitude telemetry: stream aircraft status, battery, signal, GPS, mode, and warnings via enriched telemetry messages.
- Build desktop status panel replicating UX SDK top bar (battery, RC signal, GPS, flight mode, system status).
- Integrate diagnostic/error messaging so telemetry includes current device health and active warnings.
- Once status parity is achieved, proceed with the flight-control UI wiring (motors, takeoff, landing, RTH) using the already implemented bridge actions.

1. **Android Battery Data**
   - Reimplement `createBatteryStatusMessage` using `BatteryWidgetModel` logic: dual-pack percentages, voltages, temperatures, warning levels, go-home thresholds, battery exceptions.
2. **Desktop Refactor**
   - Update `useBridgeData`/`bridgeManager` mapping for richer payloads.
   - Redesign the Top Bar to mirror UX SDK visuals, including dual-battery readouts, warning badges, and hover details.
3. **Validation**
   - Compare desktop vs. Android widget under multiple battery states (normal, warnings, overheating). Ensure legacy fallback remains stable.

## 🔄 P4 — Diagnostics Streaming & Tooling

1. **Server Enhancements**
   - Subscribe to `DiagnosticVm` listeners from the bridge and emit `diagnostic_status` messages on change and periodic intervals.
   - Include device health entries, status transitions, severity levels, and recommendations.
2. **Desktop Diagnostics**
   - Expand diagnostics UI to show live tables, severity filters, and status history; add manual refresh action.
   - Provide JSON export for debug logs.
3. **Validation**
   - Simulate diagnostic events (disconnect, sensor failure) to confirm updates and filtering.

## ✅ P1 — Flight Command Component (Current Status)

- **Primary workflow**: `takeoff` and `land` are the supported paths. `takeoff` arms the motors and climbs ~1.2 m; `land` brings the aircraft down and idles the motors.
- **Motor verbs**: `arm_motors`, `arm_motors_virtual`, and `disarm_motors` are deprecated in the bridge. They now return a structured error instructing clients to use `takeoff`/`land` instead.
- **Compass calibration**: new verbs `compass_calibrate_start` / `compass_calibrate_stop` are available, surfaced in the desktop Flight Commands panel.
- **Diagnostics**: flight command responses continue to include `motor_start_failure`, `motor_stop_reason`, and other guard rails when the FC reports them.

### Next Steps (Manual Flight Control & Safety)

1. ✅ **Keyboard/Mouse Manual Flight Controls**
   - Flight Commands panel now streams virtual-stick overrides (~16 Hz). `W`/`A`/`S`/`D` drive pitch/roll, `Space`/`Shift`/arrow up-down handle vertical velocity, and yaw can be driven by `Q`/`E`, arrow left-right, or pointer-locked mouse movement.
   - Sessions auto-enable virtual stick, push live stick positions, and expose `virtual_stick.enabled/authority_owner/change_reason` badges so operators can see who owns the sticks.
   - TODO: tune mouse yaw sensitivity & add fast/precision presets; capture session telemetry for post-flight review.

2. ✅ **Kill Switch / Human Override**
   - “Kill Switch (ESC)” instantly zeroes the sticks and disables virtual stick (<200 ms). Esc key is wired as a hardware-style emergency stop.
   - Keyboard control tears down automatically when RC/manual override is detected; the panel shows the transfer reason.
   - TODO: add UI/audio toast so operators get an immediate acknowledgement when a kill/override fires.

3. **Bridge Refactor (Upcoming)**
   - Extract `FlightCommandHandler`, `CalibrationHandler`, and telemetry streaming out of `DJIBridgeServer.kt` into dedicated files for maintainability.

4. **Upcoming Flight Features**
   - Return to Home (start/stop) validation using the same command channel.
   - Fly-to (3D coordinate) support once manual controls are stable.
   - Mission composition (fly-to, orbit, return) after basic navigation primitives are proven.
   - Home point management (`FlightControllerKey.KeyHomeLocation` setters) to mirror DJI Pilot behaviour.

## 🔄 P5 — Controller Insight & Override Safeguards

- ✓ Stream primary controller sticks with live virtual-stick authority/change reason telemetry; surface manual override flags in desktop UI.
- Extend controller telemetry to report both master/slave sticks, switch states, and current authority; include in `CONTROLLER_DATA`.
- Surface this information in desktop UI and Android logs to guide manual override decisions.

## 🔄 P6 — Cross-Cutting Quality Gates

- Standardize logging tags and error payloads across components; ensure every failure returns `error_code`, `error_message`, and optional `recovery_hint`.
- Develop automated smoke script: launch bridge, issue command sequence, verify acknowledgements.
- Update documentation (README/docs) with new schemas, UI usage, troubleshooting, and testing procedures.
- Establish weekly progress reporting: phase status, completed validation, upcoming risks.
