Agent Planner DSL (v0)
----------------------

Purpose
- A small, explicit language the planner uses to describe behavior with tools. Executed by a deterministic interpreter in the UI/bridge.
- Enables loops (track), branching, variables, and composition while remaining safe and auditable.

Design goals
- JSON AST (not free text), typed args, explicit outputs.
- Tools are the primitive actions; the planner composes them.
- Safety: confirmations for flight, timeouts, and bounded loops.

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

Migration path
- v0: keep emitting the flat step list we have today. Add a small subset of while/if with explicit bounds.
- v1: allow full DSL as above; interpreter executes; logger stores plan + results for audits and fine-tuning.
