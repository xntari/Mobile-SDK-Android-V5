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
import copy
import json
import math
import os
from functools import lru_cache
from typing import cast

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore
from pathlib import Path
from typing import Any, Dict, List, Tuple

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
    context: Dict[str, Any] | None = None


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
    'horizontal', 'horiz',
    'x', '+x', '-x', 'y', '+y', '-y', 'z', '+z', '-z'
}


GRAMMAR_SPEC = """
DSL (JSON only)
- Program: {"type":"program","body":[Stmt,...]}
- Stmt:
  - Call: {"type":"call","tool":<str>,"args":{...},"assign"?:<var>}
  - Let:  {"type":"let","name":<var>,"value":Expr}
  - If:   {"type":"if","cond":Expr,"then":[Stmt,...],"else"?:[Stmt,...]}
  - While:{"type":"while","cond":Expr,"body":[Stmt,...],"max_iter"?:<int>,"interval_ms"?:<int>}
  - Wait: {"type":"wait","ms":<int>}
  - Respond:{"type":"respond","text"?:<str>}
  - Repeat:{"type":"repeat","times":<int>,"body":[Stmt,...]}  // exact N iterations, no condition
- Expr: literal | {"var":<name>} | {"get":<var>,"path":[...] } |
        {"op":"<|<=|>|>=|==|!=|and|or|not","left"?:Expr,"right"?:Expr}

Core tools (primitives)
- snapshot {}
- detect { query }
- look_at { x, y }
- laser_enable { enabled }
- laser_measure { x, y }
- respond { text }
- map_lookup tool is available via function-calling during planning; do not emit map_lookup statements in the final program.

Flight & mission primitives
- mission_self_check {}
- flight_takeoff { altitude_target_m? }
- flight_land { mode?: 'auto' | 'force' }
- flight_rth { action: 'start' | 'stop' }
- mission_fly_to { target:{latitude,longitude,altitude?,altitude_reference?}, mode?, fly_to_height?, max_speed?, security_takeoff_height?, reason? } // altitude_reference must be 'relative_to_takeoff'; enforce ≥1 m horizontal separation (add a small lat/lon delta ~ 0.0000001 degree)
- mission_relative_move { axis, distance_m, altitude_delta_m? }
- mission_waypoint_plan { plan:Waypoint[] (<=50 entries), finish_action?, orbit_mode?, poi?, execute?, anchor? }
  Waypoint fields: latitude/longitude (absolute) or offset:{north_m,east_m,forward_m,left_m,...} relative to anchor ('current' by default).
  altitude_offset_m adjusts relative altitude when altitude is omitted. Planner may set execute:false to stage for operator review, unless the operator explicitly asks to execute, then execute:true.
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

Output strictly: {"program": {...}} (JSON only)
"""

PROMPT_GUIDE = """
=== Mission-first planning ===
- Always stage an autopilot mission (`mission_waypoint_plan`) that satisfies the instruction so the operator can review, edit, and launch. A single waypoint mission is acceptable for simple legs.
- Use `mission_fly_to` only for quick one-off repositioning when a full mission would add no value. Keep `mission_relative_move` and other manual fallbacks for cases where context/status confirms a stalled leg.
- Set `execute:false` (or omit `execute`) so every plan loads into Mission Control for approval. Configure `finish_action` (`hover`, `return_to_launch`, `land`, etc.) and `orbit_mode` to describe post-mission behaviour.
- When the instruction is an explicit flight command (takeoff / land / return-to-home), call `flight_takeoff`, `flight_land`, or `flight_rth` directly instead of staging a mission plan. Reserve `mission_waypoint_plan` for path or perimeter work. Exception: when the operator specifies a takeoff altitude, prefer `mission_fly_to` so the aircraft climbs to the requested height.
- Reuse data instead of guessing: `context.telemetry` exposes the current pose, `context.mission.plan_preview` shows staged waypoints, `context.object_memory` and `context.map` provide named POIs, and `context.vs_state.enabled` reveals manual-stick ownership.
- When required information is missing (region size, target identity, preferred altitude, etc.), emit only `respond { text:"QUESTION: ..." }` to ask for clarification.
- After composing the program, add a final `respond` call summarising the plan and suggesting follow-up actions (launch, widen search, return home, etc.).
- Whenever `context.telemetry.latitude` and `context.telemetry.longitude` are present, treat them as the aircraft’s current position. Do **not** ask the operator for coordinates in that case—use those values automatically (default search radius ≈1000 m unless otherwise specified).

=== Tool reference (placeholders show structure) ===
- `mission_waypoint_plan` — stage waypoint arrays with absolute coordinates or offsets from `anchor:"current"`. Keep `altitude_reference:"relative_to_takeoff"` unless the operator explicitly requests another frame. Add `heading`, `gimbal_heading`, `poi`, or `gimbal_strategy` to manage orientation.
  Example:
  {"program":{"type":"program","body":[
    {"type":"call","tool":"mission_waypoint_plan","args":{
      "anchor":"current",
      "plan":[
        {"offset":{"north_m":"<DELTA_NORTH_M>","east_m":0},"altitude":"<TARGET_AGL_M>","altitude_reference":"relative_to_takeoff","heading":{"mode":"toward_poi","poi":{"latitude":"<CENTER_LAT>","longitude":"<CENTER_LON>"}}},
        {"offset":{"north_m":0,"east_m":"<DELTA_EAST_M>"},"altitude":"<TARGET_AGL_M>"}
      ],
      "finish_action":"return_to_launch",
      "execute":false
    }},
    {"type":"call","tool":"respond","args":{"text":"PLAN: staged perimeter sweep. SUGGESTION: start mission or extend radius?"}}
  ]}}

- `mission_fly_to` — absolute repositioning when a single leg suffices. Use it for takeoff-to-altitude commands, vertical climbs/descents expressed as target altitudes, or simple go-to-waypoint requests that do not warrant a multi-point mission.
  Example:
  {"program":{"type":"program","body":[
    {"type":"call","tool":"mission_fly_to","args":{
      "target":{"latitude":"<TARGET_LAT>","longitude":"<TARGET_LON>","altitude":"<TARGET_AGL_M>","altitude_reference":"relative_to_takeoff"},
      "mode":"set_height"
    }},
    {"type":"call","tool":"respond","args":{"text":"PLAN: direct reposition queued. NEXT: confirm launch or adjust altitude?"}}
  ]}}

- `flight_takeoff`, `flight_land`, `flight_rth` — reserve for explicit takeoff/landing/home requests. Let the orchestrator escalate to force-land if necessary.
  Example:
  {"program":{"type":"program","body":[
    {"type":"call","tool":"flight_takeoff","args":{}},
    {"type":"call","tool":"respond","args":{"text":"PLAN: takeoff to default hover. FOLLOW-UP: deploy mission or hold position?"}}
  ]}}

- `mission_relative_move` — only after a confirmed stall or when the operator explicitly asks for manual correction. Pair with context-aware messaging.
  Example:
  {"program":{"type":"program","body":[
    {"type":"call","tool":"respond","args":{"text":"NOTICE: last leg stalled. Applying 2 m upward corrective move."}},
    {"type":"call","tool":"mission_relative_move","args":{"axis":"vertical","distance_m":2}}
  ]}}

- `look_at`, `laser_enable`, `laser_measure` — camera/laser utilities to highlight POIs or collect measurements before/after missions.
  Example:
  {"program":{"type":"program","body":[
    {"type":"call","tool":"look_at","args":{"x":0.5,"y":0.45}},
    {"type":"call","tool":"respond","args":{"text":"CAMERA: aligned with target point. Ready to start mission?"}}
  ]}}

- `respond` — general communication. Use `QUESTION:` for clarifications, otherwise summarise plans and propose next steps or related ideas.
- `map_lookup` — resolve places through Google Maps Places Text Search. Provide `query` plus optional `near { latitude, longitude }`, `radius_m`, Google Places `types` (e.g., `school`, `hospital`, `park`, `route`), and `limit` (defaults to 5) to cap the number of closest results returned. Default to the aircraft telemetry as the anchor with a 1 km radius when the operator does not specify a center. Call the tool via function-calling during planning; once the lookup returns, save `{results, best, query, anchor, radius_m, types, limit}` in variables and continue without emitting `map_lookup` statements in the final program. Legacy helpers like `hosp_lookup`/`roads_lookup` are retired.

=== Additional guidance ===
- Aircraft pose: `context.telemetry.latitude` / `context.telemetry.longitude` represent the current aircraft position. Use that as the launch anchor unless the operator supplies an alternate takeoff point.
- Map context: only minimal markers (aircraft, home, mission targets) are supplied in `context.map.features`. Use tool responses to obtain road/perimeter geometry; if higher fidelity is required, ask the operator to supply coordinates. Unless the operator provides a different anchor, treat `context.telemetry` as the default `near` center with an initial radius of ~1 km and expand only when necessary.
- Google Maps metadata: `map_lookup` results now return trimmed metadata (`formatted_address`, `place_id`, `types`, `viewport`) plus `distance_m` when an anchor is supplied. Use the viewport to approximate feature size, and the distance to prioritise missions. Query with specific `types` (e.g., `['route']`, `['park']`, `['school']`) or scoped text (“trail near Los Gatos Creek”) to obtain geometry that matches the requested mission. When higher-fidelity polygons are required, ask the operator to supply coordinates or draw the shape.
- Bearing-aware missions: populate waypoint `heading` or `poi` (and `gimbal_heading`) so the aircraft/camera faces the area of interest throughout the leg.
- Pattern generation: compute offsets from requested width/length/spacing. Alternate east/west passes for lawnmower patterns; approximate circles with evenly spaced points.
- Repetition: set mission `finish_action` appropriately and suggest loops, or wrap planning inside a `repeat` block when repeated staging is desired.
- Safety: honour guardrails from the manifest (waypoint limits, payload size) and stay within altitude constraints derived from regulations and context data.
- Status feedback: if `status` or `context.agent_status` contains `last_error`, acknowledge it via `respond`, adjust the plan, or ask how to proceed.
"""


def _build_user_prompt(
    instruction: str,
    context: Dict[str, Any] | None,
    status: Dict[str, Any] | None,
) -> str:
    """Compose the user prompt body shared by legacy and Responses engines."""

    telemetry_summary = "Telemetry unavailable"
    telemetry_block: Dict[str, Any] = {}
    if context and isinstance(context, dict):
        telemetry_block = context.get('telemetry') or {}
    if isinstance(telemetry_block, dict):
        lat = telemetry_block.get('latitude')
        lon = telemetry_block.get('longitude')
        alt = telemetry_block.get('altitude_msl_m')
        agl = telemetry_block.get('altitude_above_takeoff_m')
        heading = telemetry_block.get('heading_deg')
        telemetry_summary = (
            f"lat={lat!r}, lon={lon!r}, alt_msl={alt!r}, agl={agl!r}, heading={heading!r}"
        )

    context_json = "{}"
    if context:
        try:
            context_json = json.dumps(context, indent=2, sort_keys=True, ensure_ascii=False)
        except Exception:
            context_json = json.dumps({"error": "context_dump_failed"})
        if len(context_json) > 6000:
            context_json = context_json[:6000] + "\n...(truncated)"

    status_json = None
    if status:
        try:
            status_json = json.dumps(status, indent=2, sort_keys=True, ensure_ascii=False)
        except Exception:
            status_json = json.dumps({"error": "status_dump_failed"})

    user_parts = [
        f"Instruction: {instruction}\n\n",
        f"Aircraft telemetry snapshot: {telemetry_summary}\n\n",
        f"PlannerContext (JSON):\n{context_json}\n\n",
    ]
    if status_json:
        user_parts.append(f"Status snapshot (JSON):\n{status_json}\n\n")
    user_parts.extend([
        f"{GRAMMAR_SPEC}\n",
        "Mission-first principle: stage missions with mission_waypoint_plan. Use mission_fly_to only for single repositioning, and mission_relative_move solely when context/status indicates a stalled leg requiring manual assistance.\n",
        "Altitude semantics: interpret phrases like 'to 50 m' as absolute targets (mission waypoint altitude with altitude_reference 'relative_to_takeoff'). Treat deltas ('up by 5 m') as potential recovery moves and prefer to restage the mission rather than chaining relative offsets unless context demands immediate correction.\n",
        "Use provided context: reuse coordinates from context.telemetry, context.mission.plan_preview, context.object_memory, and context.map. Reference home coordinates for 'return home' instructions instead of invoking RTH unless explicitly requested.\n",
        "Telemetry is the aircraft location: treat context.telemetry.latitude/longitude as the drone's current position. Unless the operator supplies a different anchor, automatically use that coordinate (starting with ~1 km radius) when performing map lookups or locating nearby POIs.\n",
        "Use mission_defaults.altitude_agl_m (or 35 m if absent) when the instruction does not specify altitude. Always return numeric altitudes with altitude_reference 'relative_to_takeoff' unless explicitly told otherwise.\n",
        "Handle simple flight commands directly: use flight_takeoff, flight_land, and flight_rth { action:'start'|'stop' } without wrapping them in mission_waypoint_plan. When the user asks for takeoff followed by return-to-home, emit back-to-back flight_takeoff and flight_rth calls.\n",
        "Map lookup tool calls happen during planning only; when you return the final {\\\"program\\\":{...}} JSON, capture the lookup results in variables (e.g., let lookup={...}) and do not include map_lookup statements.\n",
        "Clarify when needed: if required parameters are missing, emit respond { text:\"QUESTION: ...\" } as the sole statement.\n",
        "Summarise & suggest: include at least one final respond call describing the staged plan and offering follow-up actions or suggestions.\n",
        "Keep output lean: no prose outside JSON, no comments, no macros left unexpanded. Respond with JSON only in the form {\"program\":{...}}.\n\n",
        f"{PROMPT_GUIDE}\n",
        "Now respond for the given Instruction above.",
    ])
    return ''.join(user_parts)


def _expand_macros(program: Dict[str, Any]) -> Dict[str, Any]:
    """Expand macros recursively until no macros remain.
    Keeps structural nodes (if/while/repeat) but ensures no {type:'macro'} remain.
    """
    def expand_node(n: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not isinstance(n, dict):
            return [n]

        node = copy.deepcopy(n)

        if node.get('type') != 'macro':
            for k in ('then', 'else', 'body'):
                if isinstance(node.get(k), list):
                    node[k] = [m for child in node[k] for m in expand_node(child)]
            return [node]
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
            return [m for child in out for m in expand_node(child)]
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
            return [m for child in out for m in expand_node(child)]
        fallback = {"type":"call","tool":"respond","args":{"text":f"Unknown macro: {name}"}}
        return [fallback]
    body = program.get('body', [])
    program['body'] = [m for node in body for m in expand_node(node)]
    return program


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _resolve_anchor_coordinate(
    anchor_spec: Any,
    context: Dict[str, Any] | None,
) -> Tuple[float | None, float | None, float | None]:
    """Resolve anchor specification into latitude/longitude (degrees) and altitude (relative to takeoff)."""

    telemetry = (context or {}).get('telemetry') or {}
    map_summary = (context or {}).get('map') or {}
    mission_summary = (context or {}).get('mission') or {}

    def from_dict(candidate: Dict[str, Any] | None) -> Tuple[float | None, float | None, float | None]:
        if not isinstance(candidate, dict):
            return (None, None, None)
        lat = candidate.get('latitude')
        lon = candidate.get('longitude')
        alt = candidate.get('altitude')
        return (
            lat if isinstance(lat, (int, float)) else None,
            lon if isinstance(lon, (int, float)) else None,
            alt if isinstance(alt, (int, float)) else None,
        )

    if isinstance(anchor_spec, dict):
        lat, lon, alt = from_dict(anchor_spec)
        if lat is not None and lon is not None:
            return lat, lon, alt

    anchor_key = None
    if isinstance(anchor_spec, str) and anchor_spec.strip():
        anchor_key = anchor_spec.strip().lower()

    if anchor_key in (None, '', 'current', 'aircraft', 'drone'):
        lat = telemetry.get('latitude')
        lon = telemetry.get('longitude')
        alt = telemetry.get('altitude_above_takeoff_m')
        return (
            lat if isinstance(lat, (int, float)) else None,
            lon if isinstance(lon, (int, float)) else None,
            alt if isinstance(alt, (int, float)) else None,
        )

    if anchor_key in ('manual_target', 'staged_target'):
        lat, lon, alt = from_dict(map_summary.get('manual_target'))
        if lat is not None and lon is not None:
            return lat, lon, alt

    if anchor_key in ('poi', 'poi_target'):
        lat, lon, alt = from_dict(mission_summary.get('poi_target'))
        if lat is not None and lon is not None:
            return lat, lon, alt

    if anchor_key in ('home', 'home_point'):
        home = telemetry.get('home') or {}
        lat = home.get('latitude')
        lon = home.get('longitude')
        alt = home.get('altitude')
        return (
            lat if isinstance(lat, (int, float)) else None,
            lon if isinstance(lon, (int, float)) else None,
            alt if isinstance(alt, (int, float)) else None,
        )

    return (None, None, None)


def _get_google_maps_api_key() -> str:
    key = os.environ.get('GOOGLE_MAPS_API_KEY') or os.environ.get('MAP_LOOKUP_API_KEY')
    if not key:
        raise MapLookupError('GOOGLE_MAPS_API_KEY (or MAP_LOOKUP_API_KEY) environment variable missing')
    return key


def _normalize_near_arg(arg: Any, context: Dict[str, Any] | None) -> Dict[str, float] | None:
    if isinstance(arg, dict):
        lat = arg.get('latitude')
        lon = arg.get('longitude')
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            return {'latitude': float(lat), 'longitude': float(lon)}
    telemetry = (context or {}).get('telemetry') or {}
    lat = telemetry.get('latitude')
    lon = telemetry.get('longitude')
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        return {'latitude': float(lat), 'longitude': float(lon)}
    return None


def _normalize_radius(arg: Any) -> float:
    if arg is None:
        return 1000.0
    try:
        radius = float(arg)
    except Exception:
        return 1000.0
    if radius <= 0:
        return 1000.0
    return max(100.0, min(radius, 20000.0))


def _normalize_types(arg: Any) -> List[str] | None:
    if not isinstance(arg, list):
        return None
    values = [str(item).strip() for item in arg if isinstance(item, (str, bytes))]
    return values[:3] if values else None


def _normalize_limit(value: Any) -> int:
    if value is None:
        return 5
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return 5
    if limit <= 0:
        return 5
    return min(limit, 20)


def _haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return 6371000.0 * c


def _is_strict_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_numeric_expr(value: Any) -> bool:
    if _is_strict_number(value):
        return True
    if isinstance(value, dict):
        if 'var' in value or 'get' in value:
            return True
        if 'op' in value:
            return True
    return False


def _program_contains_map_lookup(node: Any) -> bool:
    if isinstance(node, dict):
        if node.get('type') == 'call' and node.get('tool') == 'map_lookup':
            return True
        for key in ('body', 'then', 'else'):  # common containers
            if key in node and _program_contains_map_lookup(node[key]):
                return True
        for value in node.values():
            if _program_contains_map_lookup(value):
                return True
    elif isinstance(node, list):
        return any(_program_contains_map_lookup(item) for item in node)
    return False


def _simplify_program(program: Dict[str, Any], context: Dict[str, Any] | None = None) -> Dict[str, Any]:
    telemetry_lat = None
    telemetry_lon = None
    if isinstance(context, dict):
        tele = context.get('telemetry')
        if isinstance(tele, dict):
            lat = tele.get('latitude')
            lon = tele.get('longitude')
            if isinstance(lat, (int, float)):
                telemetry_lat = float(lat)
            if isinstance(lon, (int, float)):
                telemetry_lon = float(lon)

    def simplify_node(node: Any) -> Any:
        if isinstance(node, dict):
            node_type = node.get('type')
            if node_type == 'call' and node.get('tool') == 'mission_waypoint_plan':
                args = node.get('args') or {}
                plan = args.get('plan')
                finish = (args.get('finish_action') or '').lower()
                if isinstance(plan, list) and len(plan) <= 1 and finish in ('return_to_launch', 'go_home', 'land'):
                    if finish in ('return_to_launch', 'go_home'):
                        return {'type': 'call', 'tool': 'flight_rth', 'args': {'action': 'start'}}
                    if finish == 'land':
                        return {'type': 'call', 'tool': 'flight_land', 'args': {'mode': 'auto'}}
                target = args.get('target') or {}
                lat = target.get('latitude')
                lon = target.get('longitude')
                altitude = target.get('altitude')
                mode = (args.get('mode') or '').lower()
                if isinstance(altitude, (int, float)) and mode in ('set_height', 'setheight', ''):
                    if telemetry_lat is not None and telemetry_lon is not None and isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                        if abs(lat - telemetry_lat) < 1e-4 and abs(lon - telemetry_lon) < 1e-4:
                            return {'type': 'call', 'tool': 'flight_takeoff', 'args': {'altitude_target_m': float(altitude)}}
            # Recurse into dict values
            simplified = {}
            for key, value in node.items():
                if key in ('body', 'then', 'else') and isinstance(value, list):
                    simplified[key] = [simplify_node(item) for item in value]
                else:
                    simplified[key] = simplify_node(value)
            return simplified
        if isinstance(node, list):
            simplified_list = []
            for item in node:
                simplified_item = simplify_node(item)
                if isinstance(simplified_item, dict) and simplified_list:
                    prev = simplified_list[-1]
                    # merge consecutive waits
                    if prev.get('type') == 'wait' and simplified_item.get('type') == 'wait':
                        prev_ms = prev.get('ms') or 0
                        curr_ms = simplified_item.get('ms') or 0
                        if isinstance(prev_ms, int) and isinstance(curr_ms, int):
                            prev['ms'] = prev_ms + curr_ms
                            continue
                simplified_list.append(simplified_item)
            return simplified_list
        if isinstance(node, list):
            return [simplify_node(item) for item in node]
        return node

    return simplify_node(program)


@lru_cache(maxsize=128)
def _google_places_text_search_cached(key: str, query: str, location: str | None, radius: int | None, place_type: str | None) -> Dict[str, Any]:
    params = {'key': key, 'query': query}
    if location:
        params['location'] = location
    if radius:
        params['radius'] = str(radius)
    if place_type:
        params['type'] = place_type
    response = requests.get('https://maps.googleapis.com/maps/api/place/textsearch/json', params=params, timeout=10)
    response.raise_for_status()
    return cast(Dict[str, Any], response.json())


def _google_places_text_search(
    query: str,
    near: Dict[str, float] | None,
    radius_m: float | None,
    types: List[str] | None,
    limit: int | None = None,
) -> List[Dict[str, Any]]:
    if not query.strip():
        raise MapLookupError('map lookup requires a non-empty query')
    key = _get_google_maps_api_key()
    if requests is None:
        raise MapLookupError('requests library is required for Google Maps lookups')
    location = None
    if near:
        location = f"{near['latitude']},{near['longitude']}"
    radius = int(radius_m) if radius_m else None
    place_type = types[0] if types else None
    payload = _google_places_text_search_cached(key, query.strip(), location, radius, place_type)
    status = payload.get('status', 'UNKNOWN')
    if status not in ('OK', 'ZERO_RESULTS'):
        message = payload.get('error_message') or status
        raise MapLookupError(f'Google Places error: {message}')
    results_payload = payload.get('results') or []
    effective_limit = _normalize_limit(limit)

    anchor_lat = None
    anchor_lon = None
    if near and isinstance(near.get('latitude'), (int, float)) and isinstance(near.get('longitude'), (int, float)):
        anchor_lat = float(near['latitude'])
        anchor_lon = float(near['longitude'])

    def prune_metadata(raw: Dict[str, Any]) -> Dict[str, Any]:
        pruned: Dict[str, Any] = {}
        if not isinstance(raw, dict):
            return pruned
        formatted = raw.get('formatted_address')
        if formatted:
            pruned['formatted_address'] = formatted
        if raw.get('place_id'):
            pruned['place_id'] = raw['place_id']
        if raw.get('types'):
            pruned['types'] = list(raw['types'])[:5]
        viewport = raw.get('geometry', {}).get('viewport')
        if viewport:
            pruned['viewport'] = viewport
        return pruned

    results: List[Dict[str, Any]] = []
    for item in results_payload:
        if not isinstance(item, dict):
            continue
        geometry = item.get('geometry') or {}
        location_info = geometry.get('location') or {}
        lat = location_info.get('lat')
        lng = location_info.get('lng')
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            continue
        name = item.get('name') or item.get('formatted_address') or query
        place_id = item.get('place_id') or item.get('id') or name
        types_list = item.get('types') or []
        category = types_list[0] if types_list else None
        geometry = item.get('geometry') or {}
        distance_m = None
        if anchor_lat is not None and anchor_lon is not None:
            distance_m = _haversine_distance_m(anchor_lat, anchor_lon, float(lat), float(lng))
        result_entry = {
            'id': place_id,
            'name': name,
            'latitude': float(lat),
            'longitude': float(lng),
            'category': category,
            'geometry': geometry,
            'metadata': prune_metadata(item),
        }
        if distance_m is not None:
            result_entry['distance_m'] = distance_m
        results.append(result_entry)
    if anchor_lat is not None and anchor_lon is not None:
        results.sort(key=lambda r: r.get('distance_m', float('inf')))
    return results[:effective_limit]
def _apply_mission_fly_to_defaults(
    args: Dict[str, Any],
    context: Dict[str, Any] | None,
) -> Dict[str, Any]:
    target = dict(args.get('target') or {})
    if not target:
        return args

    # Allow shorthand strings
    anchor_hint = target.pop('anchor', None)

    def resolve_coord(value: Any) -> Tuple[float | None, bool]:
        if isinstance(value, str):
            key = value.strip().lower()
            if key in ('current', 'here', 'aircraft', 'drone'):
                return (None, True)
            if key in ('manual_target', 'staged_target', 'poi', 'poi_target', 'home', 'home_point'):
                return (None, True)
        coerced = _coerce_float(value)
        return (coerced, False)

    lat_value, lat_requested_anchor = resolve_coord(target.get('latitude'))
    lon_value, lon_requested_anchor = resolve_coord(target.get('longitude'))

    anchor_spec = anchor_hint
    if lat_requested_anchor or lon_requested_anchor:
        anchor_spec = anchor_hint or target.get('latitude') or target.get('longitude')

    if anchor_spec is None and lat_value is None and lon_value is None:
        anchor_spec = 'current'

    anchor_lat = anchor_lon = anchor_alt = None
    if anchor_spec is not None:
        anchor_lat, anchor_lon, anchor_alt = _resolve_anchor_coordinate(anchor_spec, context)

    if lat_value is None and anchor_lat is not None:
        lat_value = float(anchor_lat)
    if lon_value is None and anchor_lon is not None:
        lon_value = float(anchor_lon)

    if lat_value is not None:
        target['latitude'] = round(lat_value, 8)
    if lon_value is not None:
        target['longitude'] = round(lon_value, 8)

    alt_value = target.get('altitude')
    if isinstance(alt_value, str):
        coerced_alt = _coerce_float(alt_value)
        if coerced_alt is not None:
            target['altitude'] = coerced_alt

    if 'altitude_reference' not in target and target.get('altitude') is not None:
        target['altitude_reference'] = 'relative_to_takeoff'

    args['target'] = target
    return args


def _extract_offsets(
    waypoint: Dict[str, Any],
    heading_deg: float | None,
) -> Tuple[float, float, Dict[str, Any]]:
    """Return (north_m, east_m, cleaned_waypoint)."""

    def pop_numeric(d: Dict[str, Any], key: str) -> float:
        value = d.pop(key, None)
        if isinstance(value, (int, float)):
            return float(value)
        return 0.0

    cleaned = dict(waypoint)
    offset = cleaned.pop('offset', None)
    temp: Dict[str, Any] = {}
    if isinstance(offset, dict):
        temp = dict(offset)

    north = 0.0
    east = 0.0

    # Absolute cardinal entries (top-level or inside offset)
    for source in (cleaned, temp):
        north += pop_numeric(source, 'north_m')
        north -= pop_numeric(source, 'south_m')
        east += pop_numeric(source, 'east_m')
        east -= pop_numeric(source, 'west_m')

    heading = math.radians(heading_deg or 0.0)

    def apply_body_axes(source: Dict[str, Any]) -> None:
        nonlocal north, east
        forward = pop_numeric(source, 'forward_m')
        backward = pop_numeric(source, 'backward_m')
        right = pop_numeric(source, 'right_m')
        left = pop_numeric(source, 'left_m')

        if forward or backward:
            delta = forward - backward
            north += delta * math.cos(heading)
            east += delta * math.sin(heading)
        if right or left:
            delta = right - left
            # Right vector is heading + 90 degrees
            north += delta * -math.sin(heading)
            east += delta * math.cos(heading)

    apply_body_axes(cleaned)
    apply_body_axes(temp)

    # Remove processed offset dict remnants
    for key in list(cleaned.keys()):
        if key.endswith('_m') and key not in ('altitude', 'altitude_reference'):  # ensure stray keys removed
            if key not in ('altitude_offset_m',):
                cleaned.pop(key, None)

    return north, east, cleaned


def _apply_offsets_to_plan(
    args: Dict[str, Any],
    context: Dict[str, Any] | None,
) -> None:
    plan = args.get('plan')
    if not isinstance(plan, list) or not plan:
        return

    anchor_spec = args.pop('anchor', None)
    anchor_lat, anchor_lon, anchor_alt = _resolve_anchor_coordinate(anchor_spec, context)
    telemetry = (context or {}).get('telemetry') or {}
    heading = telemetry.get('heading_deg')

    if not isinstance(anchor_lat, (int, float)) or not isinstance(anchor_lon, (int, float)):
        return  # validation will flag missing coordinates later

    lat_rad = math.radians(anchor_lat)
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = math.cos(lat_rad) * 111_320.0 if abs(math.cos(lat_rad)) > 1e-6 else 1e-6

    for idx, entry in enumerate(plan):
        if not isinstance(entry, dict):
            continue
        north_m, east_m, cleaned = _extract_offsets(entry, heading)
        lat = cleaned.get('latitude')
        lon = cleaned.get('longitude')

        lat_is_expr = isinstance(lat, dict)
        lon_is_expr = isinstance(lon, dict)

        if (lat is None or (not isinstance(lat, (int, float)) and not lat_is_expr)) or \
           (lon is None or (not isinstance(lon, (int, float)) and not lon_is_expr)):
            delta_lat_deg = north_m / meters_per_deg_lat if meters_per_deg_lat else 0.0
            delta_lon_deg = east_m / meters_per_deg_lon if meters_per_deg_lon else 0.0

            if not lat_is_expr:
                cleaned['latitude'] = round(anchor_lat + delta_lat_deg, 8)
            if not lon_is_expr:
                cleaned['longitude'] = round(anchor_lon + delta_lon_deg, 8)

        altitude = cleaned.get('altitude')
        if not isinstance(altitude, (int, float)):
            alt_offset = cleaned.pop('altitude_offset_m', None)
            if isinstance(alt_offset, (int, float)) and isinstance(anchor_alt, (int, float)):
                altitude = float(anchor_alt) + float(alt_offset)
                cleaned['altitude'] = altitude
        if cleaned.get('altitude') is not None and 'altitude_reference' not in cleaned:
            cleaned['altitude_reference'] = 'relative_to_takeoff'

        plan[idx] = cleaned

    args['plan'] = plan


def _normalize_program(program: Dict[str, Any], context: Dict[str, Any] | None = None) -> Dict[str, Any]:
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
            baseline = copy.deepcopy(node)
            baseline['args'] = args

            if tool == 'flight_takeoff':
                if isinstance(args, dict) and not isinstance(args.get('altitude_target_m'), (int, float)):
                    default_alt = _resolve_default_altitude(context)
                    args['altitude_target_m'] = default_alt
                baseline['args'] = args
                normalised.append(baseline)
                continue

            if tool == 'mission_fly_to':
                if isinstance(args, dict):
                    args = _apply_mission_fly_to_defaults(args, context)
                target = dict(args.get('target') or {})
                if target:
                    # Default altitude reference to relative if altitude supplied but ref omitted
                    if 'altitude_reference' not in target and target.get('altitude') is not None:
                        target['altitude_reference'] = 'relative_to_takeoff'
                    # Allow shorthand by letting planner omit lat/lon (executor fills from telemetry)
                    args['target'] = target
                mode_value = str(args.get('mode') or '').strip().lower()
                if mode_value not in ('set_height', 'smart_height'):
                    if target.get('altitude') is not None:
                        args['mode'] = 'set_height'
                    else:
                        args['mode'] = 'smart_height'
                else:
                    args['mode'] = mode_value
                baseline['args'] = args
                normalised.append(baseline)
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
                    'horizontal': 'forward',
                    'horiz': 'forward',
                }
                if axis in axis_aliases:
                    args['axis'] = axis_aliases[axis]
                if isinstance(args.get('distance_m'), (int, float)):
                    args['distance_m'] = float(args['distance_m'])
                baseline['args'] = args
                normalised.append(baseline)
                continue

            if tool == 'flight_takeoff':
                # Strip NaN altitude targets; executor decides follow-up handling
                alt = args.get('altitude_target_m')
                if alt is not None and not isinstance(alt, (int, float)):
                    args.pop('altitude_target_m', None)
                baseline['args'] = args
                normalised.append(baseline)
                continue

            if tool == 'mission_waypoint_plan':
                if isinstance(args, dict):
                    _apply_offsets_to_plan(args, context)
                    execute_flag = args.get('execute')
                    if execute_flag is None:
                        args['execute'] = False
                    default_alt = _resolve_default_altitude(context)
                    plan_entries = args.get('plan')
                    if isinstance(plan_entries, list):
                        for entry in plan_entries:
                            if not isinstance(entry, dict):
                                continue
                            altitude = entry.get('altitude')
                            if not _is_numeric_expr(altitude):
                                entry['altitude'] = default_alt
                            ref = entry.get('altitude_reference')
                            if ref not in ('relative_to_takeoff', 'absolute_wgs84', 'egm96'):
                                entry['altitude_reference'] = 'relative_to_takeoff'
                baseline['args'] = args
                normalised.append(baseline)
                continue

            baseline['args'] = args
            normalised.append(baseline)

        return normalised

    body = canonicalize_nodes(program.get('body', []))

    try:
        fly_idx = next((idx for idx, node in enumerate(body)
                        if isinstance(node, dict) and node.get('type') == 'call' and node.get('tool') == 'mission_fly_to'), None)
        plan_idx = next((idx for idx, node in enumerate(body)
                         if isinstance(node, dict) and node.get('type') == 'call' and node.get('tool') == 'mission_waypoint_plan'), None)
        if fly_idx is not None and plan_idx is not None and plan_idx > fly_idx:
            plan_node = body.pop(plan_idx)
            body.insert(fly_idx, plan_node)
    except Exception:
        pass

    program['body'] = body
    return program


def openai_program(
    instruction: str,
    context: Dict[str, Any] | None = None,
    status: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    try:
        from openai import OpenAI  # type: ignore
    except Exception as e:
        raise RuntimeError(f"OpenAI SDK import failed: {e!r}")
    client = OpenAI()
    model = os.environ.get("PLANNER_MODEL", "gpt-4o-mini")
    #model = os.environ.get("PLANNER_MODEL", "gpt-5-nano")
    #model = os.environ.get("PLANNER_MODEL", "gpt-5-mini")
    system = (
        "You are a planner that emits a single JSON object with a DSL program. "
        "Only output JSON. No prose. Always return {\"program\":{...}} with valid JSON."
    )

    tool_definitions = [
        {
            "type": "function",
            "function": {
                "name": "map_lookup",
                "description": "Resolve a place using Google Maps Places Text Search. Returns nearby results (trimmed metadata with address/place_id/viewport/distance).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search phrase or POI name."},
                        "near": {
                            "type": "object",
                            "properties": {
                                "latitude": {"type": "number"},
                                "longitude": {"type": "number"}
                            },
                            "required": ["latitude", "longitude"],
                            "description": "Center coordinate (degrees). Defaults to aircraft telemetry when omitted."
                        },
                        "radius_m": {"type": "number", "minimum": 10, "maximum": 20000, "description": "Search radius in meters."},
                        "types": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Optional list of Google Places types (e.g. library, school, route)."
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 20,
                            "description": "Maximum number of closest results to return (default 5).",
                        },
                    },
                    "required": ["query"],
                },
            },
        }
    ]

    

    print(f"{instruction=}")
    user = _build_user_prompt(instruction, context, status)

    try:
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        max_passes = 6
        passes_without_tool = 0
        while True:
            try:
                completion = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tool_definitions,
                )
            except Exception as exc:
                raise RuntimeError(f"LLM call failed: {exc}") from exc

            message = completion.choices[0].message

            assistant_entry: Dict[str, Any] = {
                "role": "assistant",
                "content": message.content or "",
            }
            if message.tool_calls:
                assistant_entry["tool_calls"] = [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.function.name,
                            "arguments": call.function.arguments,
                        },
                    }
                    for call in message.tool_calls
                ]
            messages.append(assistant_entry)

            if not message.tool_calls:
                content = message.content or "{}"
                try:
                    data = json.loads(content)
                except Exception as exc:
                    raise RuntimeError(f"Planner returned non-JSON. raw={content[:200]}... err={exc}")
                if not isinstance(data, dict) or "program" not in data:
                    raise RuntimeError(f"LLM did not return program key. raw={content[:200]}...")
                program = data.get("program")
                if not isinstance(program, dict):
                    raise RuntimeError("Planner response missing program")
                if _program_contains_map_lookup(program):
                    passes_without_tool += 1
                    if passes_without_tool >= max_passes:
                        raise RuntimeError("Planner returned map_lookup call in final program repeatedly")
                    messages.append({
                        "role": "system",
                        "content": "You have already executed map_lookup. Now return the final {\"program\":{...}} with the lookup results in variables (e.g., let lookup = {...}) and no map_lookup tool calls in the program body.",
                    })
                    continue
                return program

            passes_without_tool = 0
            for call in message.tool_calls or []:
                if call.function.name != 'map_lookup':
                    tool_response = {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.function.name,
                        "content": json.dumps({"error": f"Unsupported tool {call.function.name}"}),
                    }
                    messages.append(tool_response)
                    continue

                try:
                    arguments = json.loads(call.function.arguments or '{}')
                except json.JSONDecodeError:
                    arguments = {}

                query = str(arguments.get('query') or '').strip()
                near = _normalize_near_arg(arguments.get('near'), context)
                radius = _normalize_radius(arguments.get('radius_m'))
                type_list = _normalize_types(arguments.get('types'))

                limit_value = _normalize_limit(arguments.get('limit'))
                try:
                    results = _google_places_text_search(query, near, radius, type_list, limit_value)
                    payload = {
                        'results': results,
                        'best': results[0] if results else None,
                        'query': query,
                        'anchor': near,
                        'radius_m': radius,
                        'types': type_list,
                        'limit': limit_value,
                    }
                except Exception as exc:
                    payload = {
                        'error': str(exc),
                        'query': query,
                        'anchor': near,
                        'radius_m': radius,
                        'types': type_list,
                        'limit': limit_value,
                    }

                messages.append({
                    'role': 'tool',
                    'tool_call_id': call.id,
                    'name': 'map_lookup',
                    'content': json.dumps(payload),
                })

    except Exception as exc:
        raise RuntimeError(f"LLM call failed: {exc}") from exc


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
                        if lat is None or lon is None:
                            errors.append({"message":"mission_fly_to target requires latitude and longitude","path":p+".args.target"})
                        altitude_val = target.get('altitude')
                        if altitude_val is not None and not isinstance(altitude_val, (int, float)):
                            errors.append({"message":"mission_fly_to.target.altitude must be numeric or null","path":p+".args.target.altitude"})
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
                            if not _is_numeric_expr(lat) or (_is_strict_number(lat) and (lat < -90 or lat > 90)):
                                errors.append({"message":"Waypoint latitude must be within [-90,90]","path":wp_path + '.latitude'})
                            if not _is_numeric_expr(lon) or (_is_strict_number(lon) and (lon < -180 or lon > 180)):
                                errors.append({"message":"Waypoint longitude must be within [-180,180]","path":wp_path + '.longitude'})
                            altitude_value = waypoint.get('altitude')
                            if altitude_value is not None and not _is_numeric_expr(altitude_value):
                                errors.append({"message":"Waypoint altitude must be numeric or expression","path":wp_path + '.altitude'})
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
                    max_iter = None
                if not isinstance(interval, int) or interval < 0:
                    n['interval_ms'] = 1000
                    interval = 1000
                if max_iter is None:
                    n['max_iter'] = 10
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

def _prune_planner_context(context: Dict[str, Any] | None) -> Dict[str, Any] | None:
    if not context or not isinstance(context, dict):
        return None

    pruned: Dict[str, Any] = {}

    pruned['mission_defaults'] = {
        'altitude_agl_m': 35.0,
    }

    telemetry = context.get('telemetry')
    if isinstance(telemetry, dict):
        pruned['telemetry'] = {
            'latitude': telemetry.get('latitude'),
            'longitude': telemetry.get('longitude'),
            'altitude_msl_m': telemetry.get('altitude_msl_m'),
            'altitude_above_takeoff_m': telemetry.get('altitude_above_takeoff_m'),
            'heading_deg': telemetry.get('heading_deg'),
            'flight_mode': telemetry.get('flight_mode'),
            'motors_on': telemetry.get('motors_on'),
            'gps_signal_level': telemetry.get('gps_signal_level'),
            'satellite_count': telemetry.get('satellite_count'),
        }

    battery = context.get('battery')
    if isinstance(battery, dict) and battery.get('percentage') is not None:
        pruned['battery'] = {'percentage': battery.get('percentage')}

    mission = context.get('mission')
    if isinstance(mission, dict):
        simplified: Dict[str, Any] = {
            'plan_count': mission.get('plan_count'),
        }
        if isinstance(mission.get('manual_target'), dict):
            mt = mission['manual_target']
            simplified['manual_target'] = {
                'latitude': mt.get('latitude'),
                'longitude': mt.get('longitude'),
                'altitude': mt.get('altitude'),
                'source': mt.get('source'),
            }
        if isinstance(mission.get('poi_target'), dict):
            pt = mission['poi_target']
            simplified['poi_target'] = {
                'latitude': pt.get('latitude'),
                'longitude': pt.get('longitude'),
                'altitude': pt.get('altitude'),
            }
        if isinstance(mission.get('active_waypoint'), dict):
            aw = mission['active_waypoint']
            simplified['active_waypoint'] = {
                'latitude': aw.get('latitude'),
                'longitude': aw.get('longitude'),
                'altitude': aw.get('altitude'),
                'index': aw.get('index'),
            }
        pruned['mission'] = simplified

    map_block = context.get('map')
    if isinstance(map_block, dict):
        features = map_block.get('features')
        if isinstance(features, list) and features:
            trimmed_features: List[Dict[str, Any]] = []
            for feature in features[:4]:
                if not isinstance(feature, dict):
                    continue
                trimmed_features.append({
                    'id': feature.get('id'),
                    'type': feature.get('type'),
                    'name': feature.get('name'),
                    'category': feature.get('category'),
                    'latitude': feature.get('latitude'),
                    'longitude': feature.get('longitude'),
                    'altitude': feature.get('altitude'),
                })
            if trimmed_features:
                pruned['map'] = {'features': trimmed_features}

    return pruned or None


def _resolve_default_altitude(context: Dict[str, Any] | None) -> float:
    if isinstance(context, dict):
        defaults = context.get('mission_defaults')
        if isinstance(defaults, dict):
            value = defaults.get('altitude_agl_m')
            if isinstance(value, (int, float)) and value > 0:
                return float(value)
    return 35.0


def run_legacy_plan(req: PlanRequest) -> Dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # Return explicit validation-style error so UI can surface it
        return {"errors": [{"message": "Planner unavailable: OPENAI_API_KEY not set"}]}

    # Ask LLM for a high-level program (may contain macros)
    llm_context = _prune_planner_context(req.context)

    if llm_context:
        try:
            context_dump = json.dumps(llm_context, indent=2)
            print("----context-----------")
            print(context_dump[:4000])
            if len(context_dump) > 4000:
                print("... (context truncated)")
            print("-------------------------")
        except Exception as exc:
            print(f"context print failed: {exc}")
    if req.status:
        try:
            status_dump = json.dumps(req.status, indent=2)
            print("----status------------")
            print(status_dump[:4000])
            if len(status_dump) > 4000:
                print("... (status truncated)")
            print("-------------------------")
        except Exception as exc:
            print(f"status print failed: {exc}")

    try:
        high_level = openai_program(req.instruction, llm_context, req.status)
    except Exception as exc:
        print(f"planner OpenAI call failed: {exc}")
        return {"errors": [{"message": f"planner error: {exc}"}]}
    print("----high_level-----------")
    print(f"{high_level=}")
    print("-------------------------")
    # Expand macros server-side
    program = _expand_macros(json.loads(json.dumps(high_level)))  # deep copy
    context_for_normalisation = llm_context if llm_context is not None else req.context
    program = _normalize_program(program, context_for_normalisation)
    program = _simplify_program(program)
    print("---expanded   -----------")
    print(f"{program=}")
    print("-------------------------")

    # Validate strictly; if errors exist, surface them to the UI
    errors = validate_program(program)
    print(f"{errors=}")
    response: Dict[str, Any] = {
        "high_level_program": high_level,
    }
    if req.context:
        response["context_echo"] = req.context

    if errors:
        response["errors"] = errors
        response["program"] = program
        return response

    response["program"] = program
    return response


@app.post("/plan")
def plan(req: PlanRequest):
    return run_legacy_plan(req)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PLANNER_PORT", "9002"))
    uvicorn.run(app, host="127.0.0.1", port=port)

class MapLookupError(RuntimeError):
    pass
