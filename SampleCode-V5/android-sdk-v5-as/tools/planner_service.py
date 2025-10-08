#!/usr/bin/env python3
"""Planner service entry point with multi-engine support.

Quickstart (from repo root):
  1. cd tools
  2. python3 -m venv .venv && source .venv/bin/activate
  3. pip install fastapi uvicorn pydantic openai googlemaps
  4. export OPENAI_API_KEY=sk-...
     export GOOGLE_MAPS_API_KEY=...      # required for map_lookup
     export PLANNER_ENGINE=legacy        # or 'responses' to experiment
  5. python planner_service.py

Sanity checks:
  curl -sS -X POST \
    -H 'Content-Type: application/json' \
    -d '{"instruction": "take off and hover at 20 meters"}' \
    http://127.0.0.1:9002/plan | jq

  curl -sS -X POST \
    -H 'Content-Type: application/json' \
    -d '{"instruction": "find the nearest hospital","engine":"responses",
         "responses":{"model":"gpt-4o-mini","reasoning_effort":"medium"}}' \
    http://127.0.0.1:9002/plan | jq

This FastAPI app fronts both the legacy Chat Completions planner and the new
Responses-based experimental engine. The legacy engine remains the default
until the Responses path reaches feature parity.
"""
from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

try:  # When running as package (python -m tools.planner_service)
    from . import planner_service_legacy as legacy  # type: ignore
    from .planner_service_responses import ResponsesPlannerConfig, ResponsesPlannerEngine  # type: ignore
except ImportError:  # Direct script invocation (python planner_service.py)
    import planner_service_legacy as legacy  # type: ignore
    from planner_service_responses import ResponsesPlannerConfig, ResponsesPlannerEngine  # type: ignore

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
    return {"status": "ok"}


class ResponsesOptions(BaseModel):
    model: Optional[str] = None
    reasoning_effort: Optional[str] = None
    temperature: Optional[float] = None
    max_output_tokens: Optional[int] = None
    parallel_tool_calls: Optional[bool] = None
    web_search: Optional[bool] = None
    prompt_cache_key: Optional[str] = None
    previous_response_id: Optional[str] = None


class PlanRequest(BaseModel):
    instruction: str
    status: Dict[str, Any] | None = None
    context: Dict[str, Any] | None = None
    engine: Optional[str] = None  # "legacy" | "responses"
    responses: Optional[ResponsesOptions] = None


def _select_engine(req: PlanRequest) -> str:
    env_choice = os.environ.get("PLANNER_ENGINE", "legacy")
    engine = (req.engine or env_choice).strip().lower()
    if engine not in {"legacy", "responses"}:
        return "legacy"
    return engine


def _build_responses_config(options: ResponsesOptions | None) -> ResponsesPlannerConfig:
    base = ResponsesPlannerConfig()
    if not options:
        return base

    try:
        data = options.model_dump(exclude_unset=True)  # pydantic v2
    except AttributeError:  # pragma: no cover - pydantic v1 fallback
        data = options.dict(exclude_unset=True)
    for field, value in data.items():
        if value is None:
            continue
        setattr(base, field, value)
    return base


@lru_cache(maxsize=1)
def _responses_engine_default() -> ResponsesPlannerEngine:
    return ResponsesPlannerEngine()


def _compute_plan(req: PlanRequest) -> Dict[str, Any]:
    if not os.environ.get("OPENAI_API_KEY"):
        return {"errors": [{"message": "Planner unavailable: OPENAI_API_KEY not set"}]}

    pruned_context = legacy._prune_planner_context(req.context)
    engine_choice = _select_engine(req)

    if pruned_context:
        try:
            context_dump = json.dumps(pruned_context, indent=2)
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

    if engine_choice == "responses":
        try:
            options_config = _build_responses_config(req.responses)
            engine = _responses_engine_default()
            if req.responses:
                engine = ResponsesPlannerEngine(config=options_config)
        except Exception as exc:
            return {
                "engine": "responses",
                "errors": [{"message": f"Responses engine unavailable: {exc}"}],
            }

        try:
            plan_result = engine.plan(req.instruction, pruned_context, req.status)
        except Exception as exc:
            return {
                "engine": "responses",
                "errors": [{"message": f"Responses planner call failed: {exc}"}],
            }

        response: Dict[str, Any] = {
            "engine": "responses",
            "raw_response": plan_result.get("raw_response"),
            "messages": plan_result.get("messages"),
        }
        program = plan_result.get("program")
        if program is not None:
            context_for_norm = pruned_context if pruned_context is not None else req.context
            canonical = legacy._expand_macros(json.loads(json.dumps(program)))
            canonical = legacy._normalize_program(canonical, context_for_norm)
            canonical = legacy._simplify_program(canonical)
            errors = legacy.validate_program(canonical)
            response["high_level_program"] = plan_result.get("high_level_program", {"program": program})
            response["program"] = canonical
            if errors:
                response.setdefault("errors", []).extend(errors)
        else:
            response.setdefault("errors", []).append({"message": "Responses planner did not return a program"})
        if req.context:
            response["context_echo"] = req.context
        return response

    legacy_request = legacy.PlanRequest(
        instruction=req.instruction,
        status=req.status,
        context=req.context,
    )
    result = legacy.run_legacy_plan(legacy_request)
    result["engine"] = "legacy"
    if req.context:
        result["context_echo"] = req.context
    return result


@app.post("/plan")
def plan(req: PlanRequest):
    return _compute_plan(req)


@app.post("/plan_stream")
def plan_stream(req: PlanRequest):
    if not os.environ.get("OPENAI_API_KEY"):
        payload = {"errors": [{"message": "Planner unavailable: OPENAI_API_KEY not set"}]}

        def single_event():
            yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

        return StreamingResponse(single_event(), media_type="application/jsonl")

    pruned_context = legacy._prune_planner_context(req.context)
    engine_choice = _select_engine(req)

    if engine_choice == "responses":
        try:
            options_config = _build_responses_config(req.responses)
            engine = _responses_engine_default()
            if req.responses:
                engine = ResponsesPlannerEngine(config=options_config)
        except Exception as exc:
            payload = {
                "engine": "responses",
                "errors": [{"message": f"Responses engine unavailable: {exc}"}],
            }

            def failure_event():
                yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

            return StreamingResponse(failure_event(), media_type="application/jsonl")

        def iter_events():
            try:
                generator = engine.stream_plan(req.instruction, pruned_context, req.status)
                while True:
                    try:
                        event = next(generator)
                        yield json.dumps(event, ensure_ascii=False) + "\n"
                    except StopIteration as stop:
                        stream_result = stop.value or {}
                        program = stream_result.get("program")
                        context_for_norm = pruned_context if pruned_context is not None else req.context
                        canonical = None
                        errors: List[Dict[str, Any]] = []
                        if isinstance(program, dict):
                            canonical = legacy._expand_macros(json.loads(json.dumps(program)))
                            canonical = legacy._normalize_program(canonical, context_for_norm)
                            canonical = legacy._simplify_program(canonical)
                            errors = legacy.validate_program(canonical)
                        response: Dict[str, Any] = {
                            "engine": "responses",
                            "raw_response": stream_result.get("raw_response"),
                            "messages": stream_result.get("messages"),
                            "high_level_program": stream_result.get("high_level_program"),
                        }
                        if canonical is not None:
                            response["program"] = canonical
                        else:
                            response.setdefault("errors", []).append({"message": "Responses planner did not return a program"})

                        if errors:
                            response.setdefault("errors", []).extend(errors)

                        if req.context:
                            response["context_echo"] = req.context

                        yield json.dumps({"type": "final", "payload": response}, ensure_ascii=False) + "\n"
                        break
            except Exception as exc:  # pragma: no cover
                payload = {
                    "engine": "responses",
                    "errors": [{"message": f"Responses planner call failed: {exc}"}],
                }
                yield json.dumps({"type": "final", "payload": payload}, ensure_ascii=False) + "\n"

        return StreamingResponse(iter_events(), media_type="application/jsonl")

    # Fallback to legacy engine streaming (degraded behaviour)
    result = _compute_plan(req)

    def legacy_iter():
        yield json.dumps({
            "type": "message",
            "role": "system",
            "text": "Legacy planner executed (streaming trace unavailable).",
        }, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "final", "payload": result}, ensure_ascii=False) + "\n"

    return StreamingResponse(legacy_iter(), media_type="application/jsonl")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PLANNER_PORT", "9002"))
    uvicorn.run(app=app, host="0.0.0.0", port=port, reload=False)


#if __name__ == "__main__":
#    import uvicorn
#
#    port = int(os.environ.get("PLANNER_PORT", "9002"))
#    uvicorn.run("tools.planner_service:app", host="0.0.0.0", port=port, reload=False)
