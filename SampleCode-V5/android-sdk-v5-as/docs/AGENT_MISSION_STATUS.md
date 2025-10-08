# Agentic Mission Status & Test Guide

> ***Critical*** — keep this document in sync with the orchestrator codebase. It is the authoritative reference for planners, developers, and testers working on agentic missions. Update status fields, test instructions, and outstanding work immediately after every change.

---

## 1. TL;DR (Oct 06 2025 – Planner Modernisation & Multi-Model Experiments)
- **Goal** – Ship the natural-language autonomous demos (“Inspection Sweep”, “Security Patrol”, “Environmental Survey”) while transitioning the planner stack to the OpenAI Responses API with multi-model support (`gpt-4o-mini`, `gpt-5-mini`, `gpt-5-nano`).
- **LLM strategy** – Dual planner engines (legacy Chat Completions + Responses API) behind one `/plan` endpoint. Operators can pick the engine/model, reasoning effort, temperature, max output tokens, web-search toggle, and caching knobs. Both engines share the same DSL validator and capability manifest.
- **Execution stack** – Mission Orchestrator remains the deterministic executor (queue + guardrails). Planner outputs the same validated DSL, and Responses mode now streams live tokens/status/tool events to the Agent panel while still delivering the final payload + reasoning summary.
- **Current focus** – Capture regression/field telemetry for the streaming planner, tighten replay UX (duration/cost hints), and document operator workflow for choosing engines and interpreting streaming statuses.
- **Map tooling** – `map_lookup` is now an authorised planner tool. Additional tools (`directions_lookup`, `roads_snap`, `place_perimeter`) are on the roadmap; caching is shared so both engines return identical geometry.
- **Planner API** – `/plan` requests accept optional `engine` (`legacy`/`responses`) and `responses{ model, reasoning_effort, temperature, max_output_tokens, parallel_tool_calls, web_search, prompt_cache_key, previous_response_id }` overrides so operators/tests can experiment without changing global config. Responses from the Responses engine now echo the conversation history (`messages`) and raw API payload alongside the normalised program; legacy replies continue to include `high_level_program` + validated `program`.
- **UI integration** – Agent panel exposes engine switching, Responses tuning knobs, replay buttons (“Replay legacy” / “Replay responses”), and the reasoning log/raw payload for each plan so operators can debug planner behaviour without leaving the app.

### 1.2 Planner service quickstart

```
cd tools
python3 -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn pydantic openai googlemaps
export OPENAI_API_KEY=sk-...
export GOOGLE_MAPS_API_KEY=...
python planner_service.py

# Sanity checks
curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"take off and hover at 20 meters"}' \
  http://127.0.0.1:9002/plan | jq

curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"find nearest hospital","engine":"responses",
       "responses":{"model":"gpt-4o-mini","reasoning_effort":"medium"}}' \
  http://127.0.0.1:9002/plan | jq

# Streaming reasoning (Responses only)
curl -sS -N -X POST \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"scan the nearest park","engine":"responses"}' \
  http://127.0.0.1:9002/plan_stream
```

The service defaults to the legacy engine. Set `PLANNER_ENGINE=responses` to make the new path the default; the client UI can override per-request.
- Streaming responses return a JSONL feed with `token`, `message_chunk`, `status`, `tool_use`, `tool_result`, and `final` events. The Agent panel maps these into the conversation/streaming log so operators can watch plan synthesis unfold in real time.
- **Documentation discipline** – Update this file and related specs after every iteration. Capture experiment settings (model, reasoning effort, cache key) with each test log.

### 1.1 Strategic update – LLM centric orchestration
- **Problem** – The current orchestrator carries too much heuristic logic (manual VS fallbacks, chained waypoint handling, timeout juggling). This does not scale to long autonomous flights and hides context from the planner.
- **Direction** – Move decision-making back to the planner (LLM) by providing rich context and a thin, reliable execution layer. The orchestrator becomes a command queue with pause/resume/abort; the planner owns mission planning, restructuring, and clarification questions.
- **Core shifts**
  1. **Telemetry → Planner** – Every `/plan` request includes state: aircraft pose, VS ownership, active mission entry, queue snapshot, safety flags. The planner uses this to decide whether takeoff is needed, whether a command should wait for mission pause, etc.
  2. **Mission command queue** – Orchestrator maintains a FIFO of primitives (takeoff, waypoint, manual overrides). Each command has lifecycle states (`pending`, `active`, `completed`, `error`). Queue exposes pause/resume/abort and surfaces events to the planner.
  3. **Execution tiers** –
     - *Manual override* (last resort) – explicit commands from planner/ operator; orchestrator does not auto-activate VS unless the planner authorises it.
     - *Single waypoint legs* – planner emits `mission_fly_to` / `mission_relative_move`; orchestrator executes and reports progress/stall without inventing fallbacks.
     - *Autopilot missions* – planner generates `mission_waypoint_plan` (loops orbit/patrol). Orchestrator streams progress + alerts (battery, obstacle) back to planner; planner mutates graph as needed (e.g., “pause patrol, investigate blue car”).
  4. **Planner clarifications** – Planner is encouraged (prompt examples) to ask follow-up questions when polygon, altitude band, or timing is missing (“Which parking lot? Provide polygon or tap on map.”). Orchestrator relays the question to the operator UI.
  5. **Event bridge** – Orchestrator emits structured events (waypoint reached, stall detected, VS conflict, manual override engaged). Planner subscribes and can replan mid-flight.
- 6. **Multi-model + streaming** – Planner service now advertises available engines/models, exposes reasoning effort/web-search toggles, and streams interim responses (tool calls + text) when the Responses API is selected. UI surfaces the live trace so operators see progress instead of waiting for a single 20 s blob.
- **Outcome** – Drone missions become planner-driven programs with reliable execution primitives; orchestrator sticks to deterministic mechanics (queue, telemetry, safety checks). This unlocks the demo stories (patrol with live adjustments, inspection loops with photo tasks, environmental surveys with adaptive follow-ups).

Implementation phases:
1. **Telemetry bundle** – define `PlannerContext` JSON (pose, heading, battery, vs_state, queue summary, nearby obstacles) and include in `/plan` requests/responses.
2. **Queue skeleton** – replace ad-hoc chaining with `commandQueue`. Commands declare preconditions, confirm completion via SDK events, and support pause/resume/cancel.
3. **Planner prompt refresh** – new examples for patrol polygons, repeated loops, clarification workflow, manual override requests. Add regression cases for chained moves and “pause mission, take photo, resume”.
4. **UI updates** – display queue, mission mode (manual / single leg / autopilot), allow operator to pause/resume/abort. Tie pause button to queue + planner notification.
5. **Demo playbooks** – document end-to-end flows (Security Patrol, Inspection Sweep, Environmental Survey) using planner questions + queue-driven execution.

### 1.2 Planner data access – what the LLM can see
| Data | Source | Format | Usage examples |
| --- | --- | --- | --- |
| Aircraft telemetry | Bridge (`telemetry` topic) | `{ latitude, longitude, altitude, altitude_above_takeoff, heading, velocities, battery, gps_health }` | Decide if takeoff needed; estimate remaining waypoint distance; plan return-home triggers. |
| Virtual stick state | Bridge (`telemetry.virtual_stick`, manual control store) | `{ enabled, manual_override, owner }` | Avoid issuing commands while VS override active; request disable before waypoint execution. |
| Mission queue status | Orchestrator queue | `{ pending:[], active:?, last_completed:? }` | Planner keeps track of pending legs, can insert/resume or cancel items. |
| Map geometry | Mission planner store (`plan`, `manualTarget`) + minimal context markers (`context.map.features`) | Manual target, POI target, aircraft/home markers | Clarify patrol perimeters (“Generate polygon from map selection”), stage new waypoints, compute entry/exit using mission data. |
| Object memory | Vision/object-memory service | List of clusters with `{ label, lat, lon, altitude, last_seen, confidence }` | Use as POIs (“Fly to last known car”), maintain watchlist. |
| Vision detections | Live perception API (`detect`, `perception_watch`) | Detection stream with bounding boxes + scores | Decide when to pause patrol, take photo, or switch to follow mode. |
| Camera state | Camera control store | `{ lens, zoom, gimbal_mode, look_at_status }` | Planner can request zoom/gimbal changes before capturing imagery. |
| Rangefinder / LRF | Telemetry + last measurement | `{ distance, targetLat, targetLon, egm96_altitude }` | Confirm elevation, refine POI location. |
| Weather / obstacles | Telemetry + sensors (if available) | `{ wind_speed, obstacle_distance, nfz_warnings }` | Planner can slow down, raise altitude, or re-route. |
| Operator notes | Manual inputs / UI events | free-form text or structured clarifications | Planner gathers missing information (“Confirm which parking lot: {Polygon A, Polygon B}”). |

Integration approach:
- **PlannerContext envelope** – every `/plan` request attaches `context` containing the fields above. The planner prompt references these keys so it can branch logic (e.g., `if context.vs_state.enabled then emit virtual_stick_disable`).
- **Map interaction** – UI exposes map-selection tools (draw polygon, tap waypoint). Selected geometry is stored in mission planner snapshot and forwarded to planner context as `context.map.selection`. Planner asks for map input when lacking coordinates.
- **Perimeter and parking definitions** –
  - `parking_lot` / `perimeter` stored as polygons with metadata (`name`, `source`, `priority`).
  - Planner can query available perimeters via helper tool (`mission_map_query`).
  - If missing, planner asks operator to draw polygon or confirm default.
- **Camera/Gimbal/Rangefinder tools** – existing DSL primitives (`gimbal_mode`, `look_at`, `camera_laser_measure`) remain accessible. Planner decides when to call them; orchestrator just executes.
- **Verification loop** – Planner compares requested change with `context.telemetry` before approving (e.g., if `altitude_above_takeoff` already 20 m, skip redundant `mission_fly_to`). If mismatch occurs after execution, orchestrator reports `event/stalled`, planner replans accordingly. |

---

## 2. Mission Roadmap

### 2.1 Demo Objectives

1. **Security Patrol**
   - Interpret “patrol around X” prompts into perimeters/patrol paths (polygons, lines, or orbit).
   - Continuously monitor area; on detection (person/vehicle) pause, capture, log.
   - Work like 'Google Nest' - cluster objects/faces, make it available to label later - warning when unrecognized person/object detected, keep track of known objects/locations, maybe identify theft?
   - Support mid-flight updates (“inspect new spot”, “abort patrol”).

1. **Inspection Sweep**
   - Run pre-flight diagnostics.
   - Generate a survey pattern (grid/lawnmower) over a defined area.
   - Detect equipment/hazards, store in object memory, capture photos.
   - Produce a mission report (counts, locations, images).

3. **Environmental Survey**
   - Execute volumetric/cube/orbit patterns with thermal/visual logging.
   - Flag hotspots or anomalies (e.g., >40 °C), annotate map, store evidence.
   - Support follow-up commands (“focus on hotspot”, “repeat at lower altitude”).

---

## 3. Architecture Overview
- **Capability Manifest** – JSON describing primitives (`mission.self_check`, `flight.takeoff`, `mission.scan`, `object_memory.store`, etc.), parameters, safety constraints, and sample usage. Shared with planners and orchestrator tests.
- **Mission Graph Schema** – Nodes (`primitive`, `branch`, `repeat`, `parallel`, `wait_event`, `report`, `abort`), context store (`ctx.*`), events (`perception.label_detected`, `flight.interruption`, `manual_override`). Nodes record status and support versioned mutations.
- **Mission Orchestrator** – Deterministic service responsible for validation, execution, telemetry/event subscriptions, context updates, and mutation handling (`insert_node`, `remove_node`, `replace_node`, `pause`, `resume`, `abort`).
- **LLM Planner** – OpenAI-backed service with three prompt modes: mission graph planner, primitive DSL generator, reporter/summariser. The mission planner consumes capability manifest + mission context + operator prompt to output graphs; it may also return questions for missing parameters.
- **DSL Layer** – Existing AGENT DSL extended with flight and mission primitives. Orchestrator uses it to drive bridge commands.

---

## 4. Milestones & Deliverables

### Milestone A – DSL Foundation (Status: In Progress)
**Deliverables:**
- Flight primitives (`mission.self_check`, `flight.takeoff`, `flight.land`, `flight.rth`).
- Mission primitives (`mission.fly_to`, `mission.relative_move`, `mission.waypoint_plan`, `mission.scan`, `mission.patrol`).
- Object memory / perception primitives (`object_memory.store/query`, `perception.watch`).
- Unit/integration tests (simulator) for each primitive (logs archived under `docs/test_traces/`).


------- IMPORTANT CHECKS
A set of required working primitives (always available in the Agent component). Provide one-click “Run” buttons for each sample prompt and add prompt history (Ctrl + ↑/↓) so regressions can be replayed quickly.

These behaviours **must** work at all times. Update the planner prompt template with examples for each item so the LLM always emits the expected DSL.

### Core flight primitives
1. **Basic takeoff** – prompt “Take off.” → DSL: `flight_takeoff {}` only; hover around 1.2 m.
2. **Basic land** – prompt “Land the aircraft.” → DSL: `flight_land { mode: 'auto' }`; executor escalates to `force_land_start` if required.
3. **Take off and land** – prompt “Take off and land.” → DSL: `flight_takeoff {}` followed by `flight_land { mode: 'auto' }` once.
4. **Self check** – prompt “Run a self-check.” → DSL: `mission_self_check {}` (no flight commands).
5. **Pre-flight check** – prompt “Perform a pre-flight check.” → DSL: `mission_self_check {}` + `flight_takeoff {}` + `flight_land {}`. Planner may optionally test RTH if explicitly requested.

### Altitude & navigation
6. **Ascend to hover** – prompt “Ascend to 10 meters and hold.” → DSL: `mission_fly_to { target:{ latitude:null, longitude:null, altitude:10, altitude_reference:'relative_to_takeoff' }, mode:'set_height' }` only.
7. **Climb with acknowledgement** – prompt “Climb to 25 meters and report ready.” → DSL: `mission_fly_to { … altitude:25 … }` followed by `respond { text:"Ready" }`.
8. **Forward translation** – prompt “Fly forward 15 meters.” → DSL: `mission_relative_move { axis:'forward', distance_m:15 }`; orchestrator maintains the current AGL.
9. **Compound offset** – prompt “Ascend to 20 meters, then fly right 30 meters.” → DSL: `mission_fly_to { … altitude:20 … }` followed by `mission_relative_move { axis:'right', distance_m:30 }` (no extra takeoffs/lands).

### Waypoint navigation
10. **Absolute waypoint** – prompt “Fly to 37.42453, -121.968684 at 40 meters.” → DSL: single `mission_fly_to { target:{ latitude:37.42453, longitude:-121.968684, altitude:40, altitude_reference:'relative_to_takeoff' }, mode:'set_height' }`; orchestrator handles auto-takeoff if grounded.
11. **Waypoint with hold/report** – prompt “Fly to the staging point at 45 meters and report ready.” → DSL: one `mission_fly_to` followed by `respond` only.
12. **Return home** – prompt “Return home and land.” → DSL: `flight_rth { action:'start' }` (planner adds `flight_land` only if the prompt explicitly requests an extra land command after cancelling RTH).

### Planner → DSL mapping (canonical sequences)
| NL intent | DSL sequence | Notes |
| --- | --- | --- |
| Basic takeoff | `flight_takeoff {}` | No implicit climbs; orchestrator skips if already airborne. |
| Basic land | `flight_land { mode:'auto' }` | Executor escalates to `force_land` if hover persists. |
| Self check | `mission_self_check {}` | No motion commands. |
| Ascend to X m | `mission_fly_to { target:{ latitude:null, longitude:null, altitude:X, altitude_reference:'relative_to_takeoff' } }` | Planner must not emit extra takeoff commands; orchestrator handles auto-takeoff + fallback. |
| Fly forward/right/back | `mission_relative_move { axis:'forward'|'left'|…, distance_m:N }` | Altitude preserved via set-height path. |
| Fly to lat/lon/alt | `mission_fly_to { target:{lat,lon,alt}, mode:'set_height' }` | Remains a single command; executor performs takeoff if needed. |
| Return home | `flight_rth { action:'start' }` | Avoid redundant `flight_land` unless explicitly requested. |

### Immediate next steps (planner & DSL robustness)
1. **Planner prompt updates** – keep the relative-vs-absolute guidance in sync with observed language; extend the example bank when new intents appear.
2. **Planner regression harness** – run `python tools/tests/run_planner_regressions.py` after every planner/orchestrator change and expand `planner_cases.json` as coverage grows; wire the script into CI once a non-interactive planner endpoint is available.
3. **Agent UI ergonomics** – expose each regression prompt in the Agent panel for single-click execution (including “Ascend to 25 m” and “Increase altitude by 10 m”) and store the last N prompts locally for deterministic replays.
4. **Orchestrator checks** – add unit/integration tests covering auto-takeoff, waypoint completion monitoring, and the virtual-stick altitude fallback (including abort-on-cancel behaviour).
5. **Documentation sync** – mirror the canonical table into `docs/AGENT_DSL.md`, note prompt/harness deltas here, and capture simulator traces when heuristics change.
6. **Mission-state telemetry** – formalise a set of orchestrator context variables (e.g., `ctx.altitude_target`, `ctx.horizontal_delta`, `ctx.stalled_since_ms`) and surface them in the Agent panel so testers can observe state transitions without parsing logs.

### Milestone A – refactor plan (Status: Needs Rework)
- **Current state**
  - Planner prompt template now emphasises waypoint-first outputs: altitude changes use `mission_fly_to` with `altitude_reference: 'relative_to_takeoff'`, horizontal offsets rely on `mission_relative_move`, and the server no longer rewrites takeoff/altitude pairs.
  - Orchestrator stages `fly_to_prepare`, watches telemetry, and automatically falls back to virtual-stick climbs when the SDK refuses very short waypoint moves (enabling takeoff if the aircraft is still on the ground).
  - Agent panel exposes quick-run buttons for the core regressions (self-check, takeoff, land, RTH, ascend 10 m, fly forward 15 m) and preserves prompt history for rapid replay; higher-level mission panels remain hidden.
  - Latest Agent panel build adds single-click prompts for absolute/relative altitude moves and basic cardinal translations to mirror the planner regression set.
  - Monitor loop now detects stalled altitude/horizontal progress (progress <0.25 m over several samples) and logs fallback reasons so testers can diagnose waypoint failures without full timeouts.
  - Mission-wide planners (`mission_waypoint_plan`, `mission_scan`, `mission_patrol`) are still disabled pending graph/orchestrator integration.

- **Required changes before closing Milestone A**
  1. Keep the planner regression harness (`tools/tests/planner_cases.json`) authoritative, run it in CI once feasible, and document any prompt overrides used during tests.
  2. Extend Agent quick-run coverage (and tooltips) to the full regression list, logging pass/fail timestamps in Section 7 after each simulator run.
  3. Add orchestrator unit/integration tests covering auto-takeoff, waypoint completion monitoring, and the virtual-stick altitude fallback (including abort-on-cancel behaviour).
  4. Instrument the orchestrator with structured logs for fallback usage and residual offsets so testers can attach evidence when a climb still fails (initial trace hooks now record absolute targets and fallback triggers).
  5. Sync capability manifest + `docs/AGENT_DSL.md` whenever primitive semantics change; include a changelog note in this status doc.

- **Status update (geometry feed)** – `context.map.features` now carries only the essentials (mission preview, manual/POI targets, aircraft/home markers). Static catalogs are dropped; the planner acquires additional geometry by calling `map_lookup` and using the trimmed payload (`formatted_address`, `place_id`, `types`, `viewport`, optional `distance_m`, and `limit`).
- **Tooling** – run `node tools/osm_build_catalog.js [input] [output]` to refresh the cached OpenStreetMap-derived catalog (`src/config/osmFeatures.json`) whenever coverage needs to grow.
- **Coverage** – by default the catalog builder now queries the broader Bay Area (≈36.8–38.7°N, −123.1––121.2°W). Tweak `--bbox`/`--tile` if you only need a smaller slice or want even denser tiling. Each run rewrites both `dji-controller-interface/src/config/osmFeatures.json` and the mirrored `tools/data/object_memory/osm_catalog.json`.
- **Live lookups** – the planner calls `map_lookup` (Google Places) directly via OpenAI function calling. The interpreter returns `{results, best, query, anchor, radius_m, types, limit}` with results sorted by proximity (default 5) and minimal metadata; no catalog injection required.
- **Road/route tooling (planned)** – upcoming `directions_lookup`, `roads_snap`, and `place_perimeter` tools will reuse the same plumbing to deliver polylines/perimeters once the Responses planner stabilises.

- **Acceptance criteria for Milestone A**
  - All prompts listed in “IMPORTANT CHECKS” succeed end-to-end (planner → orchestrator → bridge) in simulator runs, including altitude climbs, horizontal offsets, and coordinate fly-to commands.
  - Planner regression harness matches the canonical DSL JSON and runs clean locally; CI integration ready once OpenAI usage is automated and budgeted.
  - Agent panel exposes single-click buttons for every regression prompt and records the last execution outcome for QA.
  - Documentation (DSL + Mission Status) reflects the current behaviour and logs any deviations or fallback usage.
-----------------------

**Responsibilities:**
- *Desktop team*: expose primitives in DSL, add validation + documentation.
- *Bridge team*: verify underlying commands + telemetry coverage.
- *QA/Testing*: create simulator scripts verifying success/failure cases.

### Milestone B – Mission Orchestrator Core (Status: Planned)
**Deliverables:**
- Mission graph schema + validator.
- Orchestrator engine with context store, event handling, graph mutation API (`POST /mission_graph`, `PATCH /mission_graph/{id}`), pause/resume/abort functionality.
- Manual mission graphs (JSON) for each demo scenario executed end-to-end via simulator; logs captured.

**Responsibilities:**
- *Desktop team*: implement orchestrator module + store; integrate with DSL.
- *Bridge team*: ensure telemetry feeds required context (obstacle data, detection events).
- *QA/Testing*: run scripted simulator missions, record telemetry and orchestrator logs.

### Milestone C – LLM Integration (Status: Planned)
**Deliverables:**
- Capability manifest generator (auto-sourced from DSL definitions).
- Planner service updates: mission planner prompt, primitive planner prompt, reporter prompt.
- Operator UI for mission preview/approval, graph editing, and live status.

**Responsibilities:**
- *AI/Planner team*: craft prompts, manage OpenAI usage, implement fallback logic for incomplete plans.
- *Desktop team*: UI integration, manifest export.
- *QA/Testing*: evaluation prompts + acceptance tests.

### Milestone D – Demo Hardening (Status: Planned)
**Deliverables:**
- Final mission scripts for the three demos (validated in simulator + field). Each accompanied by step-by-step instructions, example prompts, expected telemetry signatures, and artifacts (photos, logs).
- Reporting pipeline (mission summary, object memory snapshots, map overlays).
- Performance & safety guardrails (battery thresholds, NFZ detection, fail-safe behaviours).

**Responsibilities:**
- *Desktop team*: final mission graph tuning, UI polish.
- *Bridge team*: field validation, hardware logs, fail-safe verification.
- *QA/Testers*: run regression suite, capture pass/fail results, maintain test matrix.

---

## 5. Maintenance Instructions
- Update this document after every change to planner/orchestrator/DSL.
- Record milestone status (`Planned`, `In Progress`, `Completed`, `Needs Verification`).
- Log simulator & field test results (date, build hash, prompt, outcome) in Section 7.
- Archive mission graphs, prompts, and telemetry under `docs/missions/<mission_name>/`.
- When handing off work, ensure latest orchestrator logs and manifest versions are linked here.

---

## 6. Testing Strategy

### 6.1 Test Levels
- **Unit tests**: DSL primitive emulation (bridge mocked) verifying parameter translation and ack handling.
- **Integration tests**: Simulator-driven missions executed via orchestrator; validate context updates, event handling, and graph transitions.
- **Field tests**: Controlled hardware runs capturing video, telemetry, mission reports. Mandatory before marking demos as completed.

### 6.2 Test Matrix (Initial)
| Demo | Scenario | Expected Outcome | Status | Notes |
| --- | --- | --- | --- | --- |
| Inspection Sweep | Simulated area scan with objects | Report contains object count + coordinates; photos archived | Pending | |
| Security Patrol | Simulated perimeter with mock intrusion | Patrol loops; detection triggers capture + report; mission resumes | Pending | |
| Environmental Survey | Thermal hotspot detection | Mission flags >40 °C region, logs location, generates summary | Pending | |

### 6.3 Example Prompts
- Inspection: “Perform a self-check, then survey the equipment yard at 45 m altitude. Log all heavy machinery you find.”
- Patrol: “Patrol around the parking lot polygon. If you see a person, photograph them and resume patrol.”
- Survey: “Fly a cube pattern over the forest clearing at 60 m to 30 m, and flag any hotspots above 40 degrees Celsius.”

### 6.4 Test Procedure Template
1. Ensure simulator/aircraft ready; run `mission.self_check` primitive.
2. Submit prompt via planner; review mission graph in UI; approve.
3. Start orchestrator execution; monitor status view and logs.
4. Inject detection events (simulated or staged) per scenario.
5. On completion/abort, collect mission report, object memory snapshot, log bundle.
6. Record results in Section 7.

---

## 7. Test Log (append rows as tests run)
| Date | Build | Demo | Environment (Sim/HW) | Prompt | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| *TBD* | | | | | | |

---

## 8. Outstanding Work & Risk Register
- **Mission primitives** – `mission_waypoint_plan`/`mission_scan`/`mission_patrol` still disabled; `mission_fly_to` + `mission_relative_move` need simulator regressions and fallback telemetry review.
- **Mission graph schema** – design pending; coordinate with planner team before LLM integration.
- **Perception events** – need consistent JSON schema for vision/object memory updates.
- **Safety guardrails** – define battery/NFZ thresholds and fallback behaviours.
- **LLM cost monitoring** – plan logging and usage limits before large-scale tests.

---

## 9. Handoff Checklist
- Latest version of this document committed.
- Capability manifest JSON generated and linked.
- Mission graphs & prompts for demos stored under `docs/missions/`.
- Test logs updated with most recent simulator/field runs.
- Contact points for planner, orchestrator, and QA teams documented in `/docs/OWNERS.md` (TBD).

---

_Maintainers: update this header whenever the orchestrator code or planner prompts change._
