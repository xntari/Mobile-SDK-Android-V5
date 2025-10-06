#!/usr/bin/env python3
"""Planner regression harness.

Reads test cases from tools/tests/planner_cases.json and verifies that the
planner service (running locally) produces the expected DSL skeleton.

Usage:
  python tools/tests/run_planner_regressions.py \
      --endpoint http://127.0.0.1:9002/plan
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

DEFAULT_ENDPOINT = "http://127.0.0.1:9002/plan"
CASE_PATH = Path(__file__).resolve().with_name("planner_cases.json")

DEFAULT_CONTEXT = {
    "timestamp_ms": 0,
    "connection": {"status": "simulator"},
    "telemetry": {
        "timestamp_ms": 0,
        "latitude": 37.0,
        "longitude": -122.0,
        "altitude_msl_m": 10.0,
        "altitude_above_takeoff_m": 1.2,
        "distance_to_home_m": 0.0,
        "ground_speed_mps": 0.0,
        "heading_deg": 0.0,
        "motors_on": False,
        "gps_signal_level": "good",
        "satellite_count": 18,
        "telemetry_age_ms": 50,
    },
    "battery": {"percentage": 85, "voltage": 22.3, "temperature": 28.0},
    "vs_state": {"enabled": False, "manual_override": False, "owner": None},
    "agent_status": {
        "mission_state": "idle",
        "last_command": None,
        "altitude_target": None,
        "altitude_current": 1.2,
        "horizontal_remaining": None,
        "fallback_active": False,
        "notes": [],
        "last_update_ms": 0,
    },
    "mission": {"plan_count": 0, "plan_preview": []},
    "map": {"plan_preview": [], "manual_target": None, "poi_target": None},
    "queue": {"paused": False, "active": None, "pending": [], "completed": [], "last_error": None},
    "camera": {
        "lens": "wide",
        "zoom_ratio": 1.0,
        "zoom_range": {"min": 1, "max": 32},
        "thermal_super_resolution": False,
        "look_at_mode": "GIMBAL_FOLLOWING",
        "look_at_busy": False,
        "laser_enabled": False,
        "last_laser": None,
    },
    "object_memory": {"selected_cluster": None},
    "obstacles": {"enabled": False, "sectors": []},
    "diagnostics": [],
    "simulator": {"mode": "simulator"},
}


class RegressionFailure(Exception):
    pass


def load_cases() -> List[Dict[str, Any]]:
    try:
        data = json.loads(CASE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as err:
        raise RegressionFailure(f"Missing regression file: {CASE_PATH}") from err
    if not isinstance(data, list):
        raise RegressionFailure("planner_cases.json must contain a list of cases")
    return data


def post_plan(endpoint: str, instruction: str, context: Dict[str, Any]) -> Dict[str, Any]:
    payload = json.dumps({"instruction": instruction, "context": context}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        raise RegressionFailure(f"HTTP {err.code} for instruction '{instruction}': {err.read().decode('utf-8', errors='replace')}")
    except urllib.error.URLError as err:
        raise RegressionFailure(f"Planner endpoint unreachable ({err})")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as err:
        raise RegressionFailure(f"Planner returned invalid JSON: {content[:200]} ... ({err})")
    return parsed


def assert_partial(actual: Any, expected: Any, path: str = "program") -> None:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            raise RegressionFailure(f"Expected object at {path}, got {type(actual).__name__}")
        for key, value in expected.items():
            if key not in actual:
                raise RegressionFailure(f"Missing key '{key}' at {path}")
            assert_partial(actual[key], value, f"{path}.{key}")
    elif isinstance(expected, list):
        if not isinstance(actual, list):
            raise RegressionFailure(f"Expected array at {path}, got {type(actual).__name__}")
        if len(actual) < len(expected):
            raise RegressionFailure(f"Array at {path} shorter than expected ({len(actual)} < {len(expected)})")
        for idx, value in enumerate(expected):
            assert_partial(actual[idx], value, f"{path}[{idx}]")
    else:
        if actual != expected:
            raise RegressionFailure(f"Value mismatch at {path}: expected {expected!r}, got {actual!r}")


def run(endpoint: str) -> int:
    cases = load_cases()
    failures: List[str] = []
    start = time.time()
    for case in cases:
        name = case.get("name") or case.get("instruction")
        instruction = case.get("instruction")
        if not instruction:
            failures.append(f"Case {name!r} missing instruction")
            continue
        context = case.get("context") or DEFAULT_CONTEXT
        try:
            context_payload = json.loads(json.dumps(context))
        except Exception as err:
            failures.append(f"{name}: invalid context ({err})")
            continue
        try:
            response = post_plan(endpoint, instruction, context_payload)
            if response.get("errors"):
                failures.append(f"{name}: planner returned errors {response['errors']}")
                continue
            program = response.get("program")
            if not isinstance(program, dict):
                failures.append(f"{name}: missing program in response {response}")
                continue
            match = case.get("match")
            if match:
                assert_partial(program, match)
        except RegressionFailure as err:
            failures.append(f"{name}: {err}")
            continue
    elapsed = time.time() - start
    if failures:
        print("Planner regression FAILED:\n- " + "\n- ".join(failures))
        return 1
    print(f"Planner regression passed ({len(cases)} cases in {elapsed:.2f}s) against {endpoint}")
    return 0


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Planner regression harness")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="Planner endpoint (default: %(default)s)")
    args = parser.parse_args(argv)
    try:
        return run(args.endpoint)
    except RegressionFailure as err:
        print(f"Planner regression FAILED: {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
