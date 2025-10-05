Agent Planner DSL (v0)
----------------------

Purpose
- A small, explicit language the planner uses to describe behavior with tools. Executed by a deterministic interpreter in the UI/bridge.
- Enables loops (track), branching, variables, and composition while remaining safe and auditable.

Design goals
- JSON AST (not free text), typed args, explicit outputs.
- Tools are the primitive actions; the planner composes them.
- Safety: confirmations for flight, timeouts, and bounded loops.
- Guardrails: every primitive publishes limits via the capability manifest so the planner can reject unsafe programs before they reach the orchestrator.

Core node types (JSON)
- call: { type: 'call', tool: string, args: object, assign?: string }
- let: { type: 'let', name: string, value: Expr }
- if: { type: 'if', cond: Expr, then: Stmt[], else?: Stmt[] }
- while: { type: 'while', cond: Expr, body: Stmt[], max_iter?: number, interval_ms?: number }
- repeat: { type: 'repeat', times: number, body: Stmt[] } // fixed-iteration loop
- wait: { type: 'wait', ms?: number, until?: Expr }
- respond: { type: 'respond', text?: string }

Expr
- Literals: number | string | boolean
- Var refs: { var: 'name' }
- Field refs: { get: 'name', path: ['field','subfield'] }
- Comparisons: { op: '>', left: Expr, right: Expr } (ops: >,>=,<,<=,==,!=)
- Logical: { op: 'and'|'or'|'not', ... }

Tool catalog (subset)
- snapshot {} -> { image }
- detect { query, threshold? } -> { detections: Box[] }
- look_at { x, y }
- laser_enable { enabled }
- laser_measure { x, y } -> { distance_m, lat, lon, alt_m }
- respond { text }

Flight & mission primitives (v1)
- mission_self_check {}
  - Runs the pre-flight diagnostics pipeline. Returns `{ status: 'ready' | 'blocked', issues?: Issue[] }`.
- flight_takeoff { altitude_target_m?: number }
  - Confirms motors are off and altitude < 1.5 m before delegating to `KeyStartTakeoff`.
  - Optional altitude target is clamped to the security takeoff floor.
- flight_land { mode?: 'auto' | 'force' }
  - `mode='force'` issues the emergency force-land command (requires explicit confirmation).
- flight_rth { action: 'start' | 'stop' }
  - Mirrors Return-To-Home start/abort controls; always requires confirmation for `start`.
- mission_fly_to {
    target: { latitude: number | null; longitude: number | null; altitude: number | null; altitude_reference?: 'relative_to_takeoff' },
    mode?: 'set_height' | 'smart_height',
    fly_to_height?: number,
    max_speed?: number,
    security_takeoff_height?: number,
    reason?: string
  }
  - Waypoint-first primitive. Orchestrator stages `fly_to_prepare`, auto-initiates takeoff when grounded, monitors telemetry, and falls back to manual virtual-stick climbs if the SDK refuses near-zero offsets. Only `altitude_reference: 'relative_to_takeoff'` is currently supported.
  - Planner convention: phrases like “ascend to”, “reach”, “drop to”, “go to” map to this primitive (absolute altitude targets).
- mission_relative_move { axis: 'forward' | 'backward' | 'left' | 'right' | 'vertical' | 'north' | 'south' | 'east' | 'west', distance_m: number, altitude_delta_m?: number }
  - Convenience wrapper around `mission_fly_to`: heading-relative moves convert to lat/lon offsets, `axis:'vertical'` triggers a `mission_fly_to` altitude change, and optional `altitude_delta_m` adjusts the target AGL while translating horizontally.
  - Planner convention: phrases like “ascend by”, “increase altitude by”, “descend by”, “drop altitude by” map here; use negative distances for descent.
- mission_waypoint_plan {
    plan: WaypointEntry[],
    finish_action?: 'none' | 'land' | 'go_home',
    orbit_mode?: 'none' | 'drift' | 'gimbal' | 'gimbal_free',
    poi?: Poi,
    execute?: boolean
  }
  - Hard caps: `plan.length <= 50`, serialized payload ≤64 KB. Each waypoint must have finite lat/lon and altitude/reference.
- mission_scan { area: Polygon | GridDefinition, altitude_profile: AltitudeBand[], line_spacing_m: number, speed_mps?: number, camera_profile?: string }
  - Macro → expands to `mission_waypoint_plan` (lawnmower). Guardrail: area ≤1 km², altitudes within configured min/max.
- mission_patrol { perimeter: Polygon | Path, loops?: number, dwell_s?: number, trigger?: PatrolTrigger }
  - Macro → expands to `mission_waypoint_plan` repeat loop while respecting waypoint limits.
- object_memory_store { image?: string, label?: string, telemetry?: TelemetrySnapshot, force_new_cluster?: boolean }
- object_memory_query { label?: string, cluster_id?: string, nearest?: number, limit?: number }
- perception_watch { label: string, duration_ms: number, interval_ms?: number, confidence?: number, on_detect?: PatrolTrigger }

Types
- Box: { x1,y1,x2,y2,score,label? }
- Point: { x,y }
- Measure: { distance_m, lat?, lon?, alt_m? }

Templates (syntactic sugar)
- measure_object(query): expands to snapshot → detect → look_at → wait → laser_measure → respond
- track_object(query, seconds, interval_ms=500): expands to a repeat loop with ceil(seconds*1000/interval_ms) iterations; each iteration snapshots, detects, optionally re-centers, then waits interval_ms.

Repeat loops
- Use `repeat` for instructions like "Repeat these steps three times".
- Example: repeat 3× a mini-sequence
```
{
  "type":"program",
  "body":[
    {"type":"repeat","times":3,"body":[
      {"type":"call","tool":"snapshot","args":{}},
      {"type":"call","tool":"detect","args":{"query":"toothpaste"},"assign":"det"},
      {"type":"let","name":"p","value":{"get":"det","path":["detections",0]}},
      {"type":"call","tool":"look_at","args":{"x":{"get":"p","path":["cx"]},"y":{"get":"p","path":["cy"]}}},
      {"type":"wait","ms":1000}
    ]}
  ]
}
```

Example 1: measure distance to picture
{
  "type":"program",
  "body":[
    {"type":"call","tool":"snapshot","args":{},"assign":"snap"},
    {"type":"call","tool":"detect","args":{"query":"picture"},"assign":"det"},
    {"type":"let","name":"p","value":{"get":"det","path":["detections",0]}},
    {"type":"call","tool":"look_at","args":{"x":{"get":"p","path":["cx"]},"y":{"get":"p","path":["cy"]}}},
    {"type":"wait","ms":600},
    {"type":"call","tool":"laser_measure","args":{"x":0.5,"y":0.5},"assign":"m"},
    {"type":"respond","text":"Done"}
  ]
}

Example 2: track picture for 10 seconds
{
  "type":"program",
  "body":[
    {"type":"while","cond":{"op":"<","left":{"var":"elapsed_ms"},"right":10000},"interval_ms":500,"max_iter":40,
      "body":[
        {"type":"call","tool":"snapshot","args":{},"assign":"s"},
        {"type":"call","tool":"detect","args":{"query":"picture"},"assign":"d"},
        {"type":"if","cond":{"op":">","left":{"get":"d","path":["detections","length"]},"right":0},
          "then":[{"type":"let","name":"p","value":{"get":"d","path":["detections",0]}},
                  {"type":"call","tool":"look_at","args":{"x":{"get":"p","path":["cx"]},"y":{"get":"p","path":["cy"]}}}],
          "else":[{"type":"respond","text":"lost"}]}
      ]
    }
  ]
}

Interpreter responsibilities
- Variable store; helper functions to compute centers from boxes.
- Timeouts for calls; Stop button breaks loops.
- Enforces SDK realities (e.g., `look_at` cooldown ~500ms) and detection retries (up to 3) when no boxes.
- `elapsed_ms` within a `while` is measured from the start of that loop (not the program start). This keeps tracking loops correct inside `repeat`.
- Safety hooks: before flight/mission tools, require a confirm gate.
- Reject execution when planner returns validation errors; show them in the UI.

Planner responsibilities
- Parse NL → DSL (JSON AST) and emit a high‑level macro program.
- Expand macros recursively on the server side until only non‑reducible nodes remain (`call/let/if/while/repeat/wait/respond`).
- Validate: undefined variables; bounded `while` (`max_iter` and `interval_ms`); positive `repeat.times`; reject any unexpanded macros.
- Return both `high_level_program` and final `program` for debugging.

 Validation (strict)
 - Undefined variables referenced by { get:'name' } cause a validation error (program rejected).
 - While loops must include bounded fields: `max_iter` (1..10000) and `interval_ms` (≥0). Missing/invalid values cause a validation error.
 - Repeat loops must have `times` as a positive integer (≤1000).
 - No unexpanded macros allowed.
 - Basic argument checks are enforced (e.g., detect.query must be a non‑empty string; wait.ms must be an integer).
 - `flight_takeoff`, `flight_land`, `mission_fly_to`, and `mission_relative_move` must follow the canonical patterns documented in `docs/AGENT_MISSION_STATUS.md` (planner may return them, runtime enforces guardrails).

Capability manifest
- Source of truth for tool signatures, guardrails, and return payloads.
- Canonical JSON: `dji-controller-interface/src/agent/agent_capability_manifest.json` (the TypeScript helper loads this at run time). Run `node tools/update_capability_manifest.js` to mirror it into `docs/agent_capability_manifest.json` for planners/testers.
- Schema (simplified):
```
{
  "version": "2025-10-05",
  "tools": [
    {
      "id": "mission_fly_to",
      "category": "flight",
      "description": "Fly to a precise coordinate",
      "args": {
        "target": {
          "type": "object",
          "required": true,
          "fields": {
            "latitude": { "type": "number", "min": -90, "max": 90 },
            "longitude": { "type": "number", "min": -180, "max": 180 },
            "altitude": { "type": "number|null" },
            "altitude_reference": { "type": "enum", "values": ["relative_to_takeoff", "absolute_wgs84", "egm96"], "default": "relative_to_takeoff" }
          }
        },
        "mode": { "type": "enum", "values": ["smart_height", "set_height"], "default": "smart_height" },
        "fly_to_height": { "type": "number", "min": 1, "max": 120, "optional": true }
      },
      "returns": { "type": "object", "fields": { "success": { "type": "boolean" } } },
      "guardrails": [
        { "type": "waypoint_limit", "max": 50 },
        { "type": "payload_bytes", "max": 65536 },
        { "type": "horizontal_separation", "min_m": 1.0 }
      ],
      "requires_confirm": true
    }
  ]
}
```
- The planner service reads the manifest to seed prompt instructions and reject requests that violate guardrails (e.g. waypoint plans over 50 entries).
- Update both the TypeScript source and committed JSON whenever a primitive changes.

Migration path
- v0: keep emitting the flat step list we have today. Add a small subset of while/if with explicit bounds.
- v1: allow full DSL as above; interpreter executes; logger stores plan + results for audits and fine-tuning.
