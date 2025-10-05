#!/usr/bin/env python3
"""
Planner service (program-only) for Agent DSL

- The planner is authoritative for NL → DSL (JSON) translation.
- The client executes exactly the returned program; no client-side parsing.
- Macros are allowed in the program and are expanded server-side into core primitives.

Endpoint:
  POST /plan { instruction: str, status?: {...} }
Response:
  { program: { type:'program', body:[ ... ] } }

Run:
  pip install fastapi uvicorn pydantic openai
  OPENAI_API_KEY=sk-... python tools/planner_service.py
  # http://127.0.0.1:9002/plan
"""
import json
import os
from pathlib import Path
from typing import Any, Dict, List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status":"ok"}


class PlanRequest(BaseModel):
    instruction: str
    status: Dict[str, Any] | None = None


# Formal DSL grammar and tools included in the LLM prompt
BASE_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = BASE_DIR / 'dji-controller-interface' / 'src' / 'agent' / 'agent_capability_manifest.json'
try:
    _MANIFEST_RAW = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
except FileNotFoundError:
    _MANIFEST_RAW = {}


def _lookup_guardrail(tool_id: str, rail_type: str, default: int | None = None) -> int | None:
    for tool in _MANIFEST_RAW.get('tools', []):
        if tool.get('id') != tool_id:
            continue
        for guard in tool.get('guardrails', []) or []:
            if guard.get('type') == rail_type:
                for key in ('max', 'max_m', 'max_m2', 'min_m'):
                    if key in guard:
                        val = guard[key]
                        if isinstance(val, (int, float)):
                            return int(val)
    return default


WAYPOINT_LIMIT = _lookup_guardrail('mission_waypoint_plan', 'waypoint_limit', 50) or 50
WAYPOINT_PAYLOAD_MAX_BYTES = _lookup_guardrail('mission_waypoint_plan', 'payload_bytes', 65536) or 65536
REL_MOVE_MIN_DISTANCE = _lookup_guardrail('mission_relative_move', 'horizontal_separation', None)
ALLOWED_REL_MOVE_AXES = {
    'forward', 'forwards', 'fwd', 'front', 'back', 'backward', 'backwards', 'reverse',
    'left', 'right', 'port', 'starboard',
    'up', 'down', 'vertical', 'ascend', 'descend', 'upward', 'upwards', 'downward',
    'north', 'south', 'east', 'west', 'n', 's', 'e', 'w',
    'x', '+x', '-x', 'y', '+y', '-y', 'z', '+z', '-z'
}


GRAMMAR_SPEC = """
DSL (JSON only)
- Program: {"type":"program","body":[Stmt,…]}
- Stmt:
  - Call: {"type":"call","tool":<str>,"args":{…},"assign"?:<var>}
  - Let:  {"type":"let","name":<var>,"value":Expr}
  - If:   {"type":"if","cond":Expr,"then":[Stmt,…],"else"?:[Stmt,…]}
  - While:{"type":"while","cond":Expr,"body":[Stmt,…],"max_iter"?:<int>,"interval_ms"?:<int>}
  - Wait: {"type":"wait","ms":<int>}
  - Respond:{"type":"respond","text"?:<str>}
  - Repeat:{"type":"repeat","times":<int>,"body":[Stmt,…]}  // exact N iterations, no condition
- Expr: literal | {"var":<name>} | {"get":<var>,"path":[…]} |
        {"op":"<|<=|>|>=|==|!=|and|or|not","left"?:Expr,"right"?:Expr}

Core tools (primitives)
- snapshot {}
- detect { query }
- look_at { x, y }
- laser_enable { enabled }
- laser_measure { x, y }
- respond { text }

Flight & mission primitives
- mission_self_check {}
- flight_takeoff { altitude_target_m? }
- flight_land { mode?: 'auto' | 'force' }
- flight_rth { action: 'start' | 'stop' }
- mission_fly_to { target:{latitude,longitude,altitude?,altitude_reference?}, mode?, fly_to_height?, max_speed?, security_takeoff_height?, reason? } // altitude_reference must be 'relative_to_takeoff'; enforce ≥1 m horizontal separation
- mission_relative_move { axis, distance_m, altitude_delta_m? }
- mission_waypoint_plan { plan:Waypoint[] (≤50 entries), finish_action?, orbit_mode?, poi?, execute? }
- mission_scan { area, altitude_profile, line_spacing_m, speed_mps?, camera_profile? }
- mission_patrol { perimeter, loops?, dwell_s?, trigger? }
- object_memory_store { image?, label?, telemetry?, force_new_cluster? }
- object_memory_query { label?, cluster_id?, nearest?, limit? }
- perception_watch { label, duration_ms, interval_ms?, confidence?, on_detect? }

Macros (expanded server-side until no macros remain)
- measure_object { query }
  => snapshot; detect{query}->det; let p=det.detections[0]; look_at{p.cx,p.cy}; sleep{600};
     laser_enable{true}; laser_measure{0.5,0.5}; respond{"Done"}
 - track_object { query, seconds, interval_ms=500 }
  => repeat ceil(seconds*1000/interval_ms) times { snapshot; detect{query}->det; if det.detections.length>0 { let p=det.detections[0]; look_at{p.cx,p.cy} } wait{interval_ms} }

Output strictly: {"program": { … }} (JSON only)
"""


def _expand_macros(program: Dict[str, Any]) -> Dict[str, Any]:
    """Expand macros recursively until no macros remain.
    Keeps structural nodes (if/while/repeat) but ensures no {type:'macro'} remain.
    """
    def expand_node(n: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not isinstance(n, dict):
            return [n]
        if n.get('type') != 'macro':
            for k in ('then','else','body'):
                if isinstance(n.get(k), list):
                    n[k] = [m for node in n[k] for m in expand_node(node)]
            return [n]
        name = n.get('name'); args = n.get('args', {})
        if name == 'measure_object':
            q = args.get('query','')
            out = [
                {"type":"call","tool":"snapshot","args":{},"assign":"snap"},
                {"type":"call","tool":"detect","args":{"query":q},"assign":"det"},
                {"type":"let","name":"p","value":{"get":"det","path":["detections",0]}},
                {"type":"call","tool":"look_at","args":{"x":{"get":"p","path":["cx"]},"y":{"get":"p","path":["cy"]}}},
                {"type":"call","tool":"sleep","args":{"ms":600}},
                {"type":"call","tool":"laser_enable","args":{"enabled":True}},
                {"type":"call","tool":"laser_measure","args":{"x":0.5,"y":0.5},"assign":"m"},
                {"type":"call","tool":"respond","args":{"text":"Done"}}
            ]
            return [m for node in out for m in expand_node(node)]
        if name == 'track_object':
            q = args.get('query',''); seconds = int(args.get('seconds',10)); interval = int(args.get('interval_ms',500))
            times = max(1, (seconds*1000 + max(1,interval)-1)//max(1,interval))
            out = [{
                "type":"repeat","times": times,
                "body":[
                    {"type":"call","tool":"snapshot","args":{},"assign":"snap"},
                    {"type":"call","tool":"detect","args":{"query":q},"assign":"det"},
                    {"type":"if","cond":{"op":">","left":{"get":"det","path":["detections","length"]},"right":0},
                     "then":[{"type":"let","name":"p","value":{"get":"det","path":["detections",0]}},
                              {"type":"call","tool":"look_at","args":{"x":{"get":"p","path":["cx"]},"y":{"get":"p","path":["cy"]}}}]},
                    {"type":"wait","ms": interval}
                ]
            }]
            return [m for node in out for m in expand_node(node)]
        return [{"type":"call","tool":"respond","args":{"text":f"Unknown macro: {name}"}}]
    body = program.get('body', [])
    program['body'] = [m for node in body for m in expand_node(node)]
    return program


def _normalize_program(program: Dict[str, Any]) -> Dict[str, Any]:
    """Canonically normalise tool arguments without altering intent."""

    def canonicalize_nodes(nodes: List[Any]) -> List[Any]:
        normalised: List[Any] = []
        for node in nodes or []:
            if not isinstance(node, dict):
                normalised.append(node)
                continue

            node_type = node.get('type')
            if node_type in ('if', 'while', 'repeat'):
                for key in ('then', 'else', 'body'):
                    if isinstance(node.get(key), list):
                        node[key] = canonicalize_nodes(node[key])
                normalised.append(node)
                continue

            if node_type != 'call':
                normalised.append(node)
                continue

            tool = node.get('tool')
            args = dict(node.get('args') or {})

            if tool == 'mission_fly_to':
                target = dict(args.get('target') or {})
                if target:
                    # Default altitude reference to relative if altitude supplied but ref omitted
                    if 'altitude_reference' not in target and target.get('altitude') is not None:
                        target['altitude_reference'] = 'relative_to_takeoff'
                    # Allow shorthand by letting planner omit lat/lon (executor fills from telemetry)
                    if target.get('latitude') == 'current':
                        target['latitude'] = None
                    if target.get('longitude') == 'current':
                        target['longitude'] = None
                    args['target'] = target
                mode_value = str(args.get('mode') or '').strip().lower()
                if mode_value not in ('set_height', 'smart_height'):
                    if target.get('altitude') is not None:
                        args['mode'] = 'set_height'
                    else:
                        args['mode'] = 'smart_height'
                else:
                    args['mode'] = mode_value
                normalised.append({'type': 'call', 'tool': tool, 'args': args})
                continue

            if tool == 'mission_relative_move':
                axis = str(args.get('axis') or '').strip().lower()
                axis_aliases = {
                    'up': 'vertical',
                    'upward': 'vertical',
                    'upwards': 'vertical',
                    'ascend': 'vertical',
                    'down': 'vertical',
                    'downward': 'vertical',
                    'descend': 'vertical',
                }
                if axis in axis_aliases:
                    args['axis'] = axis_aliases[axis]
                if isinstance(args.get('distance_m'), (int, float)):
                    args['distance_m'] = float(args['distance_m'])
                normalised.append({'type': 'call', 'tool': tool, 'args': args})
                continue

            if tool == 'flight_takeoff':
                # Strip NaN altitude targets; executor decides follow-up handling
                alt = args.get('altitude_target_m')
                if alt is not None and not isinstance(alt, (int, float)):
                    args.pop('altitude_target_m', None)
                normalised.append({'type': 'call', 'tool': tool, 'args': args})
                continue

            normalised.append({'type': 'call', 'tool': tool, 'args': args})

        return normalised

    program['body'] = canonicalize_nodes(program.get('body', []))
    return program


def openai_program(instruction: str) -> Dict[str, Any]:
    try:
        from openai import OpenAI  # type: ignore
    except Exception as e:
        raise RuntimeError(f"OpenAI SDK import failed: {e!r}")
    client = OpenAI()
    model = os.environ.get("PLANNER_MODEL", "gpt-4o-mini")
    system = (
        "You are a planner that emits a single JSON object with a DSL program. "
        "Only output JSON. No prose. Always return {\"program\":{…}} with valid JSON."
    )

    PROMPT_EXAMPLES = """
Example 1 – find/measure distance to an object
Instruction: measure the distance to OBJECT_A
Response:
{"program": {"type":"program","body":[
  {"type":"macro","name":"measure_object","args":{"query":"OBJECT_A"}}
]}}

Example 2 – track an object for N seconds
Instruction: track OBJECT_A for 5 seconds
Response:
{"program": {"type":"program","body":[
  {"type":"macro","name":"track_object","args":{"query":"OBJECT_A","seconds":5}}
]}}

Example 3 – compose multiple actions
Instruction: find OBJECT_A, track it for 3 seconds, then find OBJECT_B
Response:
{"program": {"type":"program","body":[
  {"type":"macro","name":"measure_object","args":{"query":"OBJECT_A"}},
  {"type":"macro","name":"track_object","args":{"query":"OBJECT_A","seconds":3}},
  {"type":"macro","name":"measure_object","args":{"query":"OBJECT_B"}}
]}}

Example 4 – repeat a block of steps
Instruction: find OBJECT_A and track it for 3 seconds, then find OBJECT_B. wait one second. Repeat these steps three times.
Response:
{"program": {"type":"program","body":[
  {"type":"repeat","times":3,"body":[
    {"type":"macro","name":"measure_object","args":{"query":"OBJECT_A"}},
    {"type":"macro","name":"track_object","args":{"query":"OBJECT_A","seconds":3}},
    {"type":"macro","name":"measure_object","args":{"query":"OBJECT_B"}},
    {"type":"wait","ms":1000}
  ]}
]}}

Example 5 – absolute altitude target (hold over current location)
Instruction: ascend to 42 meters
Response:
{"program": {"type":"program","body":[
  {"type":"call","tool":"mission_fly_to","args":{"target":{"latitude":null,"longitude":null,"altitude":42,"altitude_reference":"relative_to_takeoff"},"mode":"set_height"}}
]}}

Example 6 – relative altitude delta
Instruction: increase altitude by 12 meters
Response:
{"program": {"type":"program","body":[
  {"type":"call","tool":"mission_relative_move","args":{"axis":"vertical","distance_m":12}}
]}}

Example 7 – relative descent delta
Instruction: descend by 8 meters
Response:
{"program": {"type":"program","body":[
  {"type":"call","tool":"mission_relative_move","args":{"axis":"vertical","distance_m":-8}}
]}}

Example 8 – absolute altitude with acknowledgement
Instruction: reach 35 meters altitude and report ready
Response:
{"program": {"type":"program","body":[
  {"type":"call","tool":"mission_fly_to","args":{"target":{"latitude":null,"longitude":null,"altitude":35,"altitude_reference":"relative_to_takeoff"},"mode":"set_height"}},
  {"type":"call","tool":"respond","args":{"text":"Ready"}}
]}}
"""

    print(f"{instruction=}")
    user = (
        f"Instruction: {instruction}\n\n"
        f"{GRAMMAR_SPEC}\n"
        "Waypoint-first guidelines: prefer mission_fly_to with altitude_reference 'relative_to_takeoff' for altitude or position changes. Only emit flight_takeoff {} when the operator explicitly requests a simple takeoff check. Omit latitude/longitude in mission_fly_to to remain at the current horizontal position. mission_relative_move expresses offsets relative to the aircraft heading (forward/back/left/right) or absolute cardinal directions (north/south/east/west) and 'vertical' for pure altitude changes.\n"
        "Relative vs absolute altitude hints:\n"
        "- Phrases such as 'ascend to', 'reach', 'drop to', 'go to', 'take off to' describe absolute targets → emit mission_fly_to with the requested altitude.\n"
        "- Phrases such as 'ascend by', 'increase altitude by', 'go up another', 'descend by', 'drop altitude by' describe deltas → emit mission_relative_move with axis:'vertical' and a signed distance (negative for descent).\n"
        "- Combine altitude and horizontal moves as separate calls so each step can be monitored individually.\n"
        "Use macros when appropriate. Expand nothing yourself; macros will be expanded server-side.\n"
        "Do not include prose or comments.\n"
        "Respond with JSON only in the form {\"program\":{…}}.\n\n"
        f"{PROMPT_EXAMPLES}\n"
        "Now respond for the given Instruction above." 
    )
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role":"system","content":system},{"role":"user","content":user}],
            temperature=0.2,
            response_format={"type":"json_object"},
        )
    except Exception as e:
        raise RuntimeError(f"LLM call failed: {e}")
    content = resp.choices[0].message.content or "{}"
    try:
        data = json.loads(content)
    except Exception as e:
        raise RuntimeError(f"Planner returned non-JSON. raw={content[:200]}… err={e}")
    if not isinstance(data, dict) or "program" not in data:
        raise RuntimeError(f"LLM did not return program key. raw={content[:200]}…")
    program = data.get("program")
    if not isinstance(program, dict):
        raise RuntimeError("Planner response missing program")
    return program


def validate_program(program: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Strict validation: undefined variables and unbounded loops.
    Returns a list of {message, path} errors. Empty list means valid.
    """
    errors: List[Dict[str, Any]] = []
    call_sequence: List[tuple[str, str, Dict[str, Any]]] = []

    def check_expr(expr: Any, defined: set, path: str):
        if isinstance(expr, dict):
            if 'get' in expr:
                v = expr.get('get')
                if v not in defined:
                    errors.append({"message": f"Undefined variable '{v}'", "path": path})
            if 'left' in expr:
                check_expr(expr.get('left'), defined, path+".left")
            if 'right' in expr:
                check_expr(expr.get('right'), defined, path+".right")

    def walk(nodes: List[Dict[str, Any]], defined: set, base_path: str):
        for idx, n in enumerate(nodes or []):
            p = f"{base_path}[{idx}]"
            if not isinstance(n, dict):
                errors.append({"message":"Invalid node type","path":p}); continue
            t = n.get('type')
            if t == 'macro':
                errors.append({"message":"Unexpanded macro present; planner must expand macros server-side","path":p})
                continue
            if t == 'call':
                tool = n.get('tool')
                args = n.get('args', {}) or {}
                if isinstance(tool, str):
                    call_sequence.append((tool, p, args))
                if tool == 'detect':
                    q = args.get('query')
                    if not isinstance(q, str) or not q.strip():
                        errors.append({"message":"detect.query must be non-empty string","path":p+".args.query"})
                if tool == 'look_at':
                    # check x,y if they reference vars
                    check_expr(args.get('x'), defined, p+".args.x")
                    check_expr(args.get('y'), defined, p+".args.y")
                if tool == 'laser_measure':
                    check_expr(args.get('x'), defined, p+".args.x")
                    check_expr(args.get('y'), defined, p+".args.y")
                if tool == 'flight_takeoff':
                    alt = args.get('altitude_target_m')
                    if alt is not None and (not isinstance(alt, (int, float)) or alt <= 0 or alt > 120):
                        errors.append({"message":"flight_takeoff.altitude_target_m must be between 1 and 120 m","path":p+".args.altitude_target_m"})
                if tool == 'flight_land':
                    mode = args.get('mode')
                    if mode is not None and mode not in ('auto', 'force'):
                        errors.append({"message":"flight_land.mode must be 'auto' or 'force'","path":p+".args.mode"})
                if tool == 'flight_rth':
                    action = args.get('action')
                    if action not in ('start', 'stop'):
                        errors.append({"message":"flight_rth.action must be 'start' or 'stop'","path":p+".args.action"})
                if tool == 'mission_fly_to':
                    target = args.get('target')
                    if not isinstance(target, dict):
                        errors.append({"message":"mission_fly_to.target required","path":p+".args.target"})
                    else:
                        lat = target.get('latitude')
                        lon = target.get('longitude')
                        if lat is not None:
                            if not isinstance(lat, (int, float)) or lat < -90 or lat > 90:
                                errors.append({"message":"mission_fly_to.target.latitude must be within [-90,90]","path":p+".args.target.latitude"})
                        if lon is not None:
                            if not isinstance(lon, (int, float)) or lon < -180 or lon > 180:
                                errors.append({"message":"mission_fly_to.target.longitude must be within [-180,180]","path":p+".args.target.longitude"})
                        if (lat is None) != (lon is None):
                            errors.append({"message":"mission_fly_to target requires both latitude and longitude when specifying coordinates","path":p+".args.target"})
                        altitude_val = target.get('altitude')
                        if altitude_val is not None and not isinstance(altitude_val, (int, float)):
                            errors.append({"message":"mission_fly_to.target.altitude must be numeric or null","path":p+".args.target.altitude"})
                        if lat is None and lon is None and altitude_val is None:
                            errors.append({"message":"mission_fly_to.target must include coordinates or altitude","path":p+".args.target"})
                        ref = target.get('altitude_reference')
                        if ref is not None and str(ref).lower() not in ('relative_to_takeoff', ''):
                            errors.append({"message":"mission_fly_to.target.altitude_reference must be 'relative_to_takeoff'","path":p+".args.target.altitude_reference"})
                    mode_value = args.get('mode')
                    if mode_value is not None and str(mode_value).strip().lower() not in ('set_height', 'smart_height'):
                        errors.append({"message":"mission_fly_to.mode must be 'smart_height' or 'set_height'","path":p+".args.mode"})
                    if args.get('fly_to_height') is not None and (not isinstance(args.get('fly_to_height'), (int, float)) or args.get('fly_to_height') <= 0):
                        errors.append({"message":"mission_fly_to.fly_to_height must be positive","path":p+".args.fly_to_height"})
                if tool == 'mission_relative_move':
                    axis = args.get('axis')
                    if axis is not None:
                        if isinstance(axis, str):
                            axis_key = axis.strip().lower()
                            axis_base = axis_key.lstrip('+-')
                            if axis_base not in ALLOWED_REL_MOVE_AXES:
                                errors.append({"message":"mission_relative_move.axis invalid","path":p+".args.axis"})
                        else:
                            errors.append({"message":"mission_relative_move.axis must be string","path":p+".args.axis"})
                    distance = args.get('distance_m')
                    if not isinstance(distance, (int, float)) or distance == 0:
                        errors.append({"message":"mission_relative_move.distance_m must be non-zero","path":p+".args.distance_m"})
                    elif REL_MOVE_MIN_DISTANCE and abs(distance) < REL_MOVE_MIN_DISTANCE:
                        errors.append({"message":f"mission_relative_move.distance_m must be ≥ {REL_MOVE_MIN_DISTANCE} m in magnitude","path":p+".args.distance_m"})
                    delta = args.get('altitude_delta_m')
                    if delta is not None and not isinstance(delta, (int, float)):
                        errors.append({"message":"mission_relative_move.altitude_delta_m must be numeric","path":p+".args.altitude_delta_m"})
                if tool == 'mission_waypoint_plan':
                    plan = args.get('plan')
                    if not isinstance(plan, list) or not plan:
                        errors.append({"message":"mission_waypoint_plan.plan must be a non-empty array","path":p+".args.plan"})
                    else:
                        if len(plan) > WAYPOINT_LIMIT:
                            errors.append({"message":f"mission_waypoint_plan.plan exceeds limit ({len(plan)}>{WAYPOINT_LIMIT})","path":p+".args.plan"})
                        encoded = json.dumps(plan, separators=(',', ':')).encode('utf-8')
                        if len(encoded) > WAYPOINT_PAYLOAD_MAX_BYTES:
                            errors.append({"message":"mission_waypoint_plan payload exceeds 64 KiB budget","path":p+".args.plan"})
                        for w_idx, waypoint in enumerate(plan):
                            wp_path = f"{p}.args.plan[{w_idx}]"
                            if not isinstance(waypoint, dict):
                                errors.append({"message":"Waypoint must be object","path":wp_path}); continue
                            lat = waypoint.get('latitude')
                            lon = waypoint.get('longitude')
                            if not isinstance(lat, (int, float)) or lat < -90 or lat > 90:
                                errors.append({"message":"Waypoint latitude must be within [-90,90]","path":wp_path + '.latitude'})
                            if not isinstance(lon, (int, float)) or lon < -180 or lon > 180:
                                errors.append({"message":"Waypoint longitude must be within [-180,180]","path":wp_path + '.longitude'})
                            if waypoint.get('altitude') is not None and not isinstance(waypoint.get('altitude'), (int, float)):
                                errors.append({"message":"Waypoint altitude must be numeric or null","path":wp_path + '.altitude'})
                            ref = waypoint.get('altitude_reference')
                            if ref is not None and ref not in ('relative_to_takeoff', 'absolute_wgs84', 'egm96'):
                                errors.append({"message":"Waypoint altitude_reference invalid","path":wp_path + '.altitude_reference'})
                assign = n.get('assign')
                if isinstance(assign, str) and assign:
                    defined.add(assign)
            elif t == 'let':
                name = n.get('name')
                if not isinstance(name, str) or not name:
                    errors.append({"message":"let.name must be string","path":p+".name"})
                else:
                    defined.add(name)
                check_expr(n.get('value'), defined, p+".value")
            elif t == 'if':
                check_expr(n.get('cond'), defined, p+".cond")
                walk(n.get('then', []), set(defined), p+".then")
                walk(n.get('else', []), set(defined), p+".else")
            elif t == 'while':
                # Require max_iter and interval_ms for safety
                max_iter = n.get('max_iter')
                interval = n.get('interval_ms')
                if not isinstance(max_iter, int) or max_iter <= 0 or max_iter > 10000:
                    errors.append({"message":"while.max_iter must be a positive int ≤ 10000","path":p+".max_iter"})
                if not isinstance(interval, int) or interval < 0:
                    errors.append({"message":"while.interval_ms must be a non-negative int","path":p+".interval_ms"})
                check_expr(n.get('cond'), defined, p+".cond")
                walk(n.get('body', []), set(defined), p+".body")
            elif t == 'repeat':
                times = n.get('times')
                if not isinstance(times, int) or times <= 0 or times > 1000:
                    errors.append({"message":"repeat.times must be a positive int ≤ 1000","path":p+".times"})
                walk(n.get('body', []), set(defined), p+".body")
            elif t == 'wait':
                if not isinstance(n.get('ms'), int):
                    errors.append({"message":"wait.ms must be int","path":p+".ms"})
            elif t == 'respond':
                pass
            else:
                errors.append({"message":f"Unknown node type '{t}'","path":p+".type"})

    if not isinstance(program, dict) or program.get('type') != 'program':
        return [{"message":"Root must be a program"}]
    body = program.get('body')
    if not isinstance(body, list) or len(body) == 0:
        return [{"message":"Program body must be a non-empty array","path":"body"}]
    walk(body, set(), "body")

    for idx, (tool, path, args) in enumerate(call_sequence):
        if tool == 'flight_rth' and idx + 1 < len(call_sequence):
            if (args or {}).get('action') == 'start':
                next_tool, next_path, _ = call_sequence[idx + 1]
                if next_tool == 'flight_land':
                    errors.append({"message":"flight_land immediately after flight_rth start is redundant (RTH lands automatically)", "path": next_path})

    return errors


@app.post("/plan")
def plan(req: PlanRequest):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # Return explicit validation-style error so UI can surface it
        return {"errors": [{"message": "Planner unavailable: OPENAI_API_KEY not set"}]}

    # Ask LLM for a high-level program (may contain macros)
    high_level = openai_program(req.instruction)
    print("----high_level-----------")
    print(f"{high_level=}")
    print("-------------------------")
    # Expand macros server-side
    program = _expand_macros(json.loads(json.dumps(high_level)))  # deep copy
    program = _normalize_program(program)
    print("---expanded   -----------")
    print(f"{program=}")
    print("-------------------------")

    # Validate strictly; if errors exist, surface them to the UI
    errors = validate_program(program)
    print(f"{errors=}")
    if errors:
        return {"errors": errors, "program": program, "high_level_program": high_level}

    return {"program": program, "high_level_program": high_level}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PLANNER_PORT", "9002"))
    uvicorn.run(app, host="127.0.0.1", port=port)
