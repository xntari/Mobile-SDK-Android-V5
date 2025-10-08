"""Experimental Responses API-based planner engine.

This module is imported by ``planner_service.py``.  Run the planner service via

    cd tools
    source .venv/bin/activate      # optional but recommended
    export OPENAI_API_KEY=sk-...
    python planner_service.py

You can validate the Responses engine explicitly with:

    curl -sS -X POST \\
      -H 'Content-Type: application/json' \\
      -d '{"instruction":"inspect the nearest fire station","engine":"responses"}' \\
      http://127.0.0.1:9002/plan | jq

The goal is to share as much prompt/tool construction logic as possible with
the legacy engine while providing a clean surface for model selection,
reasoning effort, streaming, and other Responses-specific knobs.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

try:  # Optional dependency until the Responses engine is enabled.
    from openai import OpenAI  # type: ignore
except Exception:  # pragma: no cover - we defer import errors until runtime.
    OpenAI = None  # type: ignore

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

try:
    from . import planner_service_legacy as legacy  # type: ignore
except ImportError:
    import planner_service_legacy as legacy  # type: ignore


@dataclass(slots=True)
class ResponsesPlannerConfig:
    """Runtime configuration for the Responses planner engine."""

    model: str = os.environ.get("PLANNER_RESPONSES_MODEL", "gpt-4o-mini")
    reasoning_effort: Optional[str] = None  # "low" | "medium" | "high"
    temperature: Optional[float] = None
    max_output_tokens: Optional[int] = None
    parallel_tool_calls: Optional[bool] = None
    web_search: bool = False
    prompt_cache_key: Optional[str] = None
    previous_response_id: Optional[str] = None


class ResponsesPlannerEngine:
    """Experimental planner that targets the OpenAI Responses API."""

    def __init__(
        self,
        client: Optional["OpenAI"] = None,
        config: Optional[ResponsesPlannerConfig] = None,
    ) -> None:
        if client is None:
            if OpenAI is None:
                raise RuntimeError(
                    "OpenAI SDK is unavailable. Install `openai` and set OPENAI_API_KEY."
                )
            client = OpenAI()
        self._client = client
        self._config = config or ResponsesPlannerConfig()

    @staticmethod
    def _build_tool_definitions() -> List[Dict[str, Any]]:
        """Translate legacy function-call specs into Responses tool objects."""

        # For now we only expose map_lookup (matching legacy semantics).
        return [
            {
                "type": "function",
                "name": "map_lookup",
                "description": "Resolve a place using Google Maps Places Text Search.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "near": {
                            "type": "object",
                            "properties": {
                                "latitude": {"type": "number"},
                                "longitude": {"type": "number"},
                            },
                            "required": ["latitude", "longitude"],
                        },
                        "radius_m": {"type": "number", "minimum": 10, "maximum": 20000},
                        "types": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 20,
                            "description": "Maximum number of places to return (sorted by proximity). Defaults to 5.",
                        },
                    },
                    "required": ["query"],
                },
            }
        ]

    @staticmethod
    def _build_messages(
        instruction: str,
        context: Optional[Dict[str, Any]],
        status: Optional[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Reuse legacy prompt construction for system/user content."""

        system_prompt = (
            "You are a planner that emits a single JSON object with a DSL program. "
            "Only output JSON. No prose. Always return {\"program\":{...}} with valid JSON."
        )

        user_content = legacy._build_user_prompt(  # type: ignore[attr-defined]
            instruction=instruction,
            context=context or {},
            status=status or {},
        )

        return [
            {
                "role": "system",
                "content": [
                    {"type": "input_text", "text": system_prompt},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": user_content},
                ],
            },
        ]

    def build_request_payload(
        self,
        instruction: str,
        context: Optional[Dict[str, Any]],
        status: Optional[Dict[str, Any]],
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Construct the kwargs for `client.responses.create`."""

        if messages is None:
            messages = self._build_messages(instruction, context, status)

        payload: Dict[str, Any] = {
            "model": self._config.model,
            "input": messages,
            "tools": self._build_tool_definitions(),
        }

        if self._config.reasoning_effort:
            payload["reasoning"] = {"effort": self._config.reasoning_effort}
        if self._config.temperature is not None:
            payload["temperature"] = self._config.temperature
        if self._config.max_output_tokens is not None:
            payload["max_output_tokens"] = self._config.max_output_tokens
        if self._config.parallel_tool_calls is not None:
            payload["parallel_tool_calls"] = self._config.parallel_tool_calls
        if self._config.web_search:
            payload.setdefault("tools", []).append({"type": "web_search"})
        if self._config.prompt_cache_key:
            payload["metadata"] = {"cache_key": self._config.prompt_cache_key}
        if self._config.previous_response_id:
            payload["previous_response_id"] = self._config.previous_response_id

        return payload

    @staticmethod
    def _emit_event(callback: Optional[Callable[[Dict[str, Any]], None]], payload: Dict[str, Any]) -> None:
        if not callback:
            return
        try:
            callback(payload)
        except Exception:
            # Event emission should never break planning flow.
            pass

    def _ingest_response(
        self,
        raw_dict: Dict[str, Any],
        messages: List[Dict[str, Any]],
        conversation_log: List[Dict[str, Any]],
        execute_map_lookup: Callable[[Dict[str, Any]], Dict[str, Any]],
        event_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """Shared response parsing for streaming and non-streaming flows."""

        output_items = raw_dict.get("output") or []
        pending_tool_results: List[Dict[str, Any]] = []
        assistant_entries: List[Dict[str, Any]] = []

        def record(entry: Dict[str, Any]) -> None:
            messages.append(entry)
            conversation_log.append(json.loads(json.dumps(entry)))
            assistant_entries.append(entry)
            self._emit_event(event_callback, {
                "type": "message",
                "role": entry.get("role", "assistant"),
            })

        def emit_tool_event(event_type: str, **kwargs: Any) -> None:
            self._emit_event(event_callback, {"type": event_type, **kwargs})

        for item in output_items:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")

            if item_type == "function_call":
                call_id = item.get("id") or item.get("call_id") or ""
                func_name = item.get("name") or ""
                arguments_raw = item.get("arguments") or ""
                emit_tool_event(
                    "tool_use",
                    tool=func_name,
                    call_id=call_id,
                    arguments=arguments_raw,
                )
                try:
                    parsed_args = json.loads(arguments_raw) if isinstance(arguments_raw, str) and arguments_raw else {}
                except Exception:
                    parsed_args = {}
                result_payload = execute_map_lookup(parsed_args if isinstance(parsed_args, dict) else {}) if func_name == "map_lookup" else {"error": f"Unsupported tool {func_name}"}
                emit_tool_event("tool_result", tool=func_name, call_id=call_id, result=result_payload)
                pending_tool_results.append({
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": json.dumps({
                            "tool": {
                                "id": call_id,
                                "output": result_payload,
                            }
                        }, ensure_ascii=False),
                    }],
                })
                continue

            if item_type == "message":
                record({
                    "role": item.get("role", "assistant"),
                    "content": list(item.get("content") or []),
                })
                continue

            if item_type == "output_text":
                record({
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": item.get("text", "")}],
                })
                continue

            if item_type == "tool_use":
                record({
                    "role": item.get("role", "assistant"),
                    "content": [{
                        "type": "tool_use",
                        "name": item.get("name"),
                        "input": item.get("input"),
                        "id": item.get("id") or item.get("call_id"),
                    }],
                })
                continue

        # Some SDK variants embed tool_use blocks inside assistant messages; handle them.
        for entry in list(assistant_entries):
            for block in entry.get("content", []):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                tool_id = block.get("id") or ""
                tool_name = block.get("name") or ""
                emit_tool_event(
                    "tool_use",
                    tool=tool_name,
                    call_id=tool_id,
                    arguments=block.get("input"),
                )
                arguments = block.get("input") or {}
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except Exception:
                        arguments = {}
                result_payload = execute_map_lookup(arguments if isinstance(arguments, dict) else {}) if tool_name == "map_lookup" else {"error": f"Unsupported tool {tool_name}"}
                emit_tool_event("tool_result", tool=tool_name, call_id=tool_id, result=result_payload)
                pending_tool_results.append({
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": json.dumps({
                            "tool": {
                                "id": tool_id,
                                "output": result_payload,
                            }
                        }, ensure_ascii=False),
                    }],
                })

        if pending_tool_results:
            return {
                "pending_tool_results": pending_tool_results,
                "assistant_entries": assistant_entries,
                "text_fragments": [],
                "aggregated_text": "",
            }

        text_fragments: List[str] = []
        for entry in assistant_entries:
            for block in entry.get("content", []):
                if not isinstance(block, dict):
                    continue
                if block.get("type") in {"output_text", "text", "summary_text"}:
                    txt = block.get("text")
                    if isinstance(txt, str):
                        text_fragments.append(txt)

        aggregated = raw_dict.get("output_text")
        if isinstance(aggregated, str) and aggregated:
            text_fragments.append(aggregated)
        elif isinstance(aggregated, list):
            text_fragments.extend([frag for frag in aggregated if isinstance(frag, str) and frag])

        return {
            "pending_tool_results": [],
            "assistant_entries": assistant_entries,
            "text_fragments": text_fragments,
            "aggregated_text": "".join(text_fragments),
        }

    def stream_plan(
        self,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
        status: Optional[Dict[str, Any]] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Generator that yields streaming events and returns final plan payload."""

        context = context or {}
        status = status or {}

        messages = self._build_messages(instruction, context, status)
        conversation_log = [json.loads(json.dumps(m)) for m in messages]
        max_passes = 6
        final_raw_response: Dict[str, Any] | None = None
        final_high_level: Dict[str, Any] | None = None
        final_program: Dict[str, Any] | None = None

        for _ in range(max_passes):
            payload = self.build_request_payload(instruction, context, status, messages)
            call_arguments: Dict[str, str] = {}

            with self._client.responses.stream(**payload) as stream:
                for event in stream:
                    event_type = getattr(event, "type", None)

                    if event_type == "response.created":
                        resp_obj = getattr(event, "response", None)
                        yield {
                            "type": "status",
                            "stage": "created",
                            "response_id": getattr(resp_obj, "id", None),
                        }
                        continue

                    if event_type == "response.output_text.delta":
                        yield {
                            "type": "token",
                            "role": "assistant",
                            "text": getattr(event, "delta", ""),
                            "sequence": getattr(event, "sequence_number", None),
                        }
                        continue

                    if event_type == "response.output_text.done":
                        yield {
                            "type": "message_chunk",
                            "role": "assistant",
                            "text": getattr(event, "text", ""),
                            "sequence": getattr(event, "sequence_number", None),
                        }
                        continue

                    if event_type == "response.function_call_arguments.delta":
                        item_id = getattr(event, "item_id", "")
                        delta = getattr(event, "delta", "")
                        call_arguments[item_id] = call_arguments.get(item_id, "") + (delta or "")
                        yield {
                            "type": "tool_arguments_delta",
                            "call_id": item_id,
                            "delta": delta,
                            "sequence": getattr(event, "sequence_number", None),
                        }
                        continue

                    if event_type == "response.function_call_arguments.done":
                        item_id = getattr(event, "item_id", "")
                        arguments = call_arguments.get(item_id, "")
                        yield {
                            "type": "tool_arguments_complete",
                            "call_id": item_id,
                            "arguments": arguments,
                        }
                        continue

                    if event_type == "response.in_progress":
                        yield {"type": "status", "stage": "in_progress"}
                        continue

                    if event_type == "response.completed":
                        yield {"type": "status", "stage": "completed"}
                        continue

                    if event_type == "response.failed":
                        yield {"type": "status", "stage": "failed", "error": getattr(event, "error", None)}
                        continue

                final_response = stream.get_final_response()

            raw_dict = final_response.to_dict() if hasattr(final_response, "to_dict") else json.loads(json.dumps(final_response))
            final_raw_response = raw_dict

            emitted_events: List[Dict[str, Any]] = []

            def event_callback(payload: Dict[str, Any]) -> None:
                emitted_events.append(payload)

            def execute_map_lookup(args_obj: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    query = str(args_obj.get("query") or "").strip()
                    near = legacy._normalize_near_arg(args_obj.get("near"), context)
                    radius = legacy._normalize_radius(args_obj.get("radius_m"))
                    type_list = legacy._normalize_types(args_obj.get("types"))
                    limit_value = legacy._normalize_limit(args_obj.get("limit"))
                    results = legacy._google_places_text_search(query, near, radius, type_list, limit_value)
                    return {
                        "results": results,
                        "best": results[0] if results else None,
                        "query": query,
                        "anchor": near,
                        "radius_m": radius,
                        "types": type_list,
                        "limit": limit_value,
                    }
                except Exception as exc:  # pragma: no cover
                    return {
                        "error": str(exc),
                        "query": args_obj.get("query"),
                        "anchor": args_obj.get("near"),
                        "radius_m": args_obj.get("radius_m"),
                        "types": args_obj.get("types"),
                        "limit": legacy._normalize_limit(args_obj.get("limit")),
                    }

            ingest = self._ingest_response(
                raw_dict,
                messages,
                conversation_log,
                execute_map_lookup,
                event_callback=event_callback,
            )

            for payload in emitted_events:
                yield payload

            if ingest["pending_tool_results"]:
                for entry in ingest["pending_tool_results"]:
                    messages.append(entry)
                    conversation_log.append(json.loads(json.dumps(entry)))
                yield {"type": "status", "stage": "tool_result_appended"}
                continue

            text_fragments = ingest.get("text_fragments", [])
            aggregated_text = ingest.get("aggregated_text") or ""
            text_blob = (aggregated_text if aggregated_text else "".join(text_fragments)).strip()

            if not text_blob:
                raise RuntimeError(f"Responses assistant returned no text output: {json.dumps(raw_dict, ensure_ascii=False)}")

            parsed: Dict[str, Any] | None = None
            try:
                decoder = json.JSONDecoder()
                parsed, idx = decoder.raw_decode(text_blob)
                remainder = text_blob[idx:].strip()
                if remainder:
                    try:
                        extra, _ = decoder.raw_decode(remainder)
                        conversation_log.append({"extra": extra})
                    except Exception:
                        pass
            except Exception as exc:
                raise RuntimeError(f"Planner returned non-JSON. raw={text_blob[:200]}... err={exc}")

            if parsed is None:
                raise RuntimeError("Responses planner returned empty payload")

            if not isinstance(parsed, dict) or not isinstance(parsed.get("program"), dict):
                raise RuntimeError("Responses planner output missing program")

            final_program = parsed["program"]
            final_high_level = parsed
            break

        if final_program is None or final_high_level is None or final_raw_response is None:
            raise RuntimeError(f"Responses planner exceeded maximum tool passes: {json.dumps(conversation_log, ensure_ascii=False)}")

        yield {"type": "status", "stage": "program_ready"}

        return {
            "raw_response": final_raw_response,
            "messages": conversation_log,
            "program": final_program,
            "high_level_program": final_high_level,
        }

    def plan(
        self,
        instruction: str,
        context: Optional[Dict[str, Any]] = None,
        status: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a Responses call with iterative tool handling."""

        context = context or {}
        status = status or {}

        messages = self._build_messages(instruction, context, status)
        conversation_log = [json.loads(json.dumps(m)) for m in messages]
        max_passes = 6

        for _ in range(max_passes):
            payload = self.build_request_payload(instruction, context, status, messages)
            response = self._client.responses.create(**payload)
            raw_dict = response.to_dict() if hasattr(response, "to_dict") else dict(response)  # type: ignore[arg-type]

            def execute_map_lookup(args_obj: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    query = str(args_obj.get("query") or "").strip()
                    near = legacy._normalize_near_arg(args_obj.get("near"), context)
                    radius = legacy._normalize_radius(args_obj.get("radius_m"))
                    type_list = legacy._normalize_types(args_obj.get("types"))
                    limit_value = legacy._normalize_limit(args_obj.get("limit"))
                    results = legacy._google_places_text_search(query, near, radius, type_list, limit_value)
                    return {
                        "results": results,
                        "best": results[0] if results else None,
                        "query": query,
                        "anchor": near,
                        "radius_m": radius,
                        "types": type_list,
                        "limit": limit_value,
                    }
                except Exception as exc:  # pragma: no cover - safeguard
                    return {
                        "error": str(exc),
                        "query": args_obj.get("query"),
                        "anchor": args_obj.get("near"),
                        "radius_m": args_obj.get("radius_m"),
                        "types": args_obj.get("types"),
                        "limit": legacy._normalize_limit(args_obj.get("limit")),
                    }

            ingest = self._ingest_response(raw_dict, messages, conversation_log, execute_map_lookup)

            if ingest["pending_tool_results"]:
                for entry in ingest["pending_tool_results"]:
                    messages.append(entry)
                    conversation_log.append(json.loads(json.dumps(entry)))
                continue

            text_fragments = ingest.get("text_fragments", [])
            aggregated_text = ingest.get("aggregated_text") or ""
            text_blob = (aggregated_text if aggregated_text else "".join(text_fragments)).strip()

            if not text_blob:
                raise RuntimeError(f"Responses assistant returned no text output: {json.dumps(raw_dict, ensure_ascii=False)}")

            try:
                decoder = json.JSONDecoder()
                parsed, idx = decoder.raw_decode(text_blob)
                remainder = text_blob[idx:].strip()
                if remainder:
                    try:
                        extra, _ = decoder.raw_decode(remainder)
                        conversation_log.append({"extra": extra})
                    except Exception:
                        pass
            except Exception as exc:
                raise RuntimeError(f"Planner returned non-JSON. raw={text_blob[:200]}... err={exc}")
            if not isinstance(parsed, dict) or not isinstance(parsed.get("program"), dict):
                raise RuntimeError("Responses planner output missing program")

            return {
                "raw_response": raw_dict,
                "messages": conversation_log,
                "program": parsed["program"],
                "high_level_program": parsed,
            }

        raise RuntimeError(f"Responses planner exceeded maximum tool passes: {json.dumps(conversation_log, ensure_ascii=False)}")


__all__ = [
    "ResponsesPlannerConfig",
    "ResponsesPlannerEngine",
]
