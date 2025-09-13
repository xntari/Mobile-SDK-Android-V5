#!/usr/bin/env python3
"""
Minimal /plan service for the Agent POC.

Two modes:
1) Cloud LLM (if OPENAI_API_KEY set): prompts a small model (default gpt-4o-mini)
   to output a strict JSON plan using our tool schema.
2) Fallback (no key): simple heuristic plan for "find X and measure".

Endpoint:
  POST /plan { instruction: str, status?: {...} }
Response:
  { steps: [{ tool: str, args: dict }] }

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


class PlanRequest(BaseModel):
    instruction: str
    status: Dict[str, Any] | None = None


TOOLS_SPEC = """
You can use only these tools in steps:
- snapshot {}
- detect { query }
- look_at { x, y }
- sleep { ms }
- laser_enable { enabled }
- laser_measure { x, y }
- respond { text? }

Rules:
- Output JSON ONLY: {"steps":[{"tool":"...","args":{...}}, ...]}
- Never include explanations or code fences.
- For measure_object intents: snapshot → detect → look_at → sleep(600) → laser_enable(true) → laser_measure → respond.
"""


def _extract_query(instruction: str) -> tuple[str, str]:
    import re
    s = instruction.strip()
    low = re.sub(r"\s+", " ", s.lower()).strip()
    # find <obj> distance / find <obj> coords
    m = re.match(r"^(find|look for)\s+(?:the\s+)?(.+?)\s+(distance|dist|coords?|coordinates)\b", low)
    if m: return (m.group(2), 'measure' if not m.group(3).startswith('coord') else 'coords')
    # find coords of <obj>
    m = re.match(r"^(find|look for)\s+(?:the\s+)?(coords?|coordinates)\s+(?:of|for|to)\s+(?:the\s+)?(.+)$", low)
    if m: return (m.group(3), 'coords')
    # find distance to/of <obj>
    m = re.match(r"^find\s+(?:the\s+)?distance\s+(?:to|of)\s+(?:the\s+)?(.+)$", low)
    if m: return (m.group(1), 'measure')
    # measure distance of/to <obj>
    m = re.match(r"^measure\s+(?:the\s+)?distance\s*(?:to|of)?\s*(?:the\s+)?(.+)$", low)
    if m: return (m.group(1), 'measure')
    # coords of <obj>
    m = re.match(r"^(coords?|coordinates)\s+(?:of|for)\s+(.+)$", low)
    if m: return (m.group(2), 'coords')
    # find <obj>
    m = re.match(r"^find\s+(.+)$", low)
    if m:
        q = re.sub(r"^(the|a|an)\s+", "", m.group(1))
        q = re.sub(r"\b(distance|dist|coords?|coordinates)$", "", q).strip()
        return (q, 'detect')
    return (low, 'detect')


def fallback_plan(instruction: str) -> Dict[str, Any]:
    query, intent = _extract_query(instruction)
    if not query:
        query = "object"
    # detect 'track' intent heuristically
    low = instruction.strip().lower()
    if any(k in low for k in ["track ", "tracking", "follow ", "keep center"]):
        program = {
            "type": "program",
            "body": [
                {"type":"while","cond":{"op":"<","left":{"var":"elapsed_ms"},"right":10000},"interval_ms":500,"max_iter":40,
                 "body":[
                    {"type":"call","tool":"snapshot","args":{},"assign":"snap"},
                    {"type":"call","tool":"detect","args":{"query":query},"assign":"det"},
                    {"type":"if","cond":{"op":">","left":{"get":"det","path":["detections","length"]},"right":0},
                      "then":[{"type":"let","name":"p","value":{"get":"det","path":["detections",0]}},
                               {"type":"call","tool":"look_at","args":{"x":{"get":"p","path":["cx"]},"y":{"get":"p","path":["cy"]}}}]}
                 ]}
            ]
        }
        # Provide steps fallback
        steps = [{"tool":"snapshot","args":{}},{"tool":"detect","args":{"query":query}},{"tool":"look_at","args":{"x":"$det.cx","y":"$det.cy"}}]
        return {"steps": steps, "program": program}
    else:
        steps = [
            {"tool": "snapshot", "args": {}},
            {"tool": "detect", "args": {"query": query}},
            {"tool": "look_at", "args": {"x": "$det.cx", "y": "$det.cy"}},
            {"tool": "sleep", "args": {"ms": 600}},
            {"tool": "laser_enable", "args": {"enabled": True}},
            {"tool": "laser_measure", "args": {"x": "$det.cx", "y": "$det.cy"}},
            {"tool": "respond", "args": {}},
        ]
        return {"steps": steps}


def openai_plan(instruction: str) -> Dict[str, Any]:
    try:
        from openai import OpenAI  # type: ignore
    except Exception:
        return fallback_plan(instruction)

    client = OpenAI()
    model = os.environ.get("PLANNER_MODEL", "gpt-4o-mini")
    system = (
        "You are a planner that emits strict JSON plans of tool calls. "
        "Never add prose. If intent is to measure an object's distance, use the measure_object recipe."
    )
    user = f"Instruction: {instruction}\n\n{TOOLS_SPEC}"

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        content = resp.choices[0].message.content or "{}"
        plan = json.loads(content)
        if not isinstance(plan, dict) or "steps" not in plan:
            raise ValueError("bad plan")
        return plan
    except Exception as e:
        print("[planner] openai error, using fallback:", e)
        return fallback_plan(instruction)


def _convert_steps_to_program(steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    import re
    def conv_arg(v):
        if isinstance(v, str):
            m = re.match(r"^\$(\w+)\.(\w+)$", v)
            if m:
                return {"get": m.group(1), "path": [m.group(2)]}
        return v
    body: List[Dict[str, Any]] = []
    need_p = False
    for s in steps:
        tool = s.get('tool')
        args = s.get('args', {})
        # Normalize args: $det.cx → {get:'det',path:['cx']}
        n_args = { k: conv_arg(v) for k,v in args.items() }
        assign = None
        if tool == 'detect':
            assign = 'det'
            # We will emit a let p = det.detections[0] after detect
        elif tool == 'laser_measure':
            assign = 'm'
        body.append({"type":"call","tool":tool,"args":n_args,"assign":assign})
        if tool == 'detect':
            body.append({"type":"let","name":"p","value":{"get":"det","path":["detections",0]}})
    return {"type":"program","body":body}


@app.post("/plan")
def plan(req: PlanRequest):
    api_key = os.environ.get("OPENAI_API_KEY")
    print(f"[planner] instruction: {req.instruction!r} | openai={'yes' if api_key else 'no'}")
    # Produce both a backward-compatible steps list and a DSL program
    basic = openai_plan(req.instruction) if api_key else fallback_plan(req.instruction)
    steps = basic.get('steps', [])
    # Convert steps to a simple but well-formed program (with assigns + exprs)
    program = basic.get('program') or _convert_steps_to_program(steps)
    out = {"steps": steps, "program": program}
    print(f"[planner] → {len(steps)} steps, program nodes: {len(program['body'])}")
    return out


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PLANNER_PORT", "9002"))
    uvicorn.run(app, host="127.0.0.1", port=port)
