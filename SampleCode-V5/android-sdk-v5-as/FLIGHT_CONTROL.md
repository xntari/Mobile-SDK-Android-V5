# Flight Control Implementation Plan
## P0 — Foundational Setup
- Audit current flight control features against the reference repo (`eee-Andrew/Mobile-SDK-Android-V5`) to document gaps and ensure SDK usage parity.
- Inventory bridge message types, Android view models (BasicAircraftControlVM, IntelligentFlightVM, WayPointV3VM, DiagnosticVm), and desktop modules (`bridgeManager`, diagnostics panel).
- Draft JSON schema one-pagers for `flight_command`, `waypoint_command`, `diagnostic_status`, and enriched `battery_status`; review with stakeholders before coding.

## 🔄 P2 — Waypoint Command Channel

### Next Steps
1. Finish desktop "Flight Commands" panel to drive new bridge actions and display acknowledgements.
2. Flesh out `DJIBridgeServer.handleWaypointCommand` using the schema (upload/start/pause/resume/stop/set_break_point/query_state).
3. Build mission management UI (KMZ selection, progress, state board) and stream mission callbacks to the desktop.
4. Run simulator mission dry-runs; capture logs for validation.

1. **Schema Definition**
   - Define verbs: `upload_kmz`, `start`, `pause`, `resume`, `stop`, `set_break_point`, `clear_listeners`, `query_state`; include parameter validation rules.
2. **Android Implementation**
   - Flesh out `DJIBridgeServer.handleWaypointCommand` to call `WayPointV3VM`/`WaypointMissionManager`, streaming progress and state updates back to clients.
   - Ensure mission listeners propagate live telemetry to the desktop.
3. **Desktop UI**
   - Create mission management UI (file chooser, state board, progress bars, action buttons).
   - Surface errors and current waypoint data in real time.
4. **Validation**
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

## ✅ P1 — Flight Command Component

### Status
- **Done**: Flight command schema locked, VM helpers extended, and bridge dispatcher implemented (`flight_command` actions: takeoff/landing/cancel/confirm/RTH, virtual stick enable/override, fly-to prepare).
- **Desktop integration**: pending (UI to issue commands and surfacing responses).
- **Validation**: simulator + field testing still to run once UI wiring is complete.

1. **Schema & Contracts**
   - Finalize supported verbs: `arm_motors`, `disarm_motors`, `takeoff`, `land`, `cancel_landing`, `return_home_start`, `return_home_stop`, `hover`, `virtual_stick_enable`, `virtual_stick_disable`, `virtual_stick_override`, `fly_to_prepare`.
   - Specify required parameters, expected acknowledgements, and SDK preconditions (motor state, GPS health, battery warnings).
2. **Android Bridge Updates**
   - Extend `BasicAircraftControlVM` with motor arm/disarm, cancel landing, cancel RTH helpers using appropriate `FlightControllerKey` actions.
   - Implement `DJIBridgeServer.handleFlightCommand` to parse verbs, execute VM/KeyManager operations on the UI thread, and emit structured success/failure responses (include error codes and hints).
   - Add logging tags (`FLIGHT_COMMAND`, `FLIGHT_GUARD`) for traceability.
3. **Desktop Integration**
   - Build a “Flight Commands” panel with buttons bound through `bridgeManager.sendBridgeCommand`; display live status and error toasts.
   - Reflect active control mode (manual vs. virtual stick) based on controller telemetry.
4. **Validation**
   - Run simulator and hardware dry-runs; capture `adb logcat` + bridge logs for documentation.

## 🔄 P5 — Controller Insight & Override Safeguards
- Extend controller telemetry to report both master/slave sticks, switch states, and current authority; include in `CONTROLLER_DATA`.
- Surface this information in desktop UI and Android logs to guide manual override decisions.

## 🔄 P6 — Cross-Cutting Quality Gates
- Standardize logging tags and error payloads across components; ensure every failure returns `error_code`, `error_message`, and optional `recovery_hint`.
- Develop automated smoke script: launch bridge, issue command sequence, verify acknowledgements.
- Update documentation (README/docs) with new schemas, UI usage, troubleshooting, and testing procedures.
- Establish weekly progress reporting: phase status, completed validation, upcoming risks.
