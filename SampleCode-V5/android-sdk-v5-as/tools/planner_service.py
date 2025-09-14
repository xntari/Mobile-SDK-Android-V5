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
- sleep { ms }
- laser_enable { enabled }
- laser_measure { x, y }
- respond { text }

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
"""

    print(f"{instruction=}")
    user = (
        f"Instruction: {instruction}\n\n"
        f"{GRAMMAR_SPEC}\n"
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
    return data["program"]


def validate_program(program: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Strict validation: undefined variables and unbounded loops.
    Returns a list of {message, path} errors. Empty list means valid.
    """
    errors: List[Dict[str, Any]] = []

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
