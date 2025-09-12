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


@app.post("/plan")
def plan(req: PlanRequest):
    api_key = os.environ.get("OPENAI_API_KEY")
    print(f"[planner] instruction: {req.instruction!r} | openai={'yes' if api_key else 'no'}")
    plan = openai_plan(req.instruction) if api_key else fallback_plan(req.instruction)
    print(f"[planner] → {len(plan.get('steps', []))} steps")
    return plan


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PLANNER_PORT", "9002"))
    uvicorn.run(app, host="127.0.0.1", port=port)
