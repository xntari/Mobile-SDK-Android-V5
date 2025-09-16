Agent POC: Vision + Tool-Using Autonomy
--------------------------------------

Purpose
- Track the goal, current phase, status, models, setup, and next steps for a tool-using vision agent that operates the gimbal/camera and (later) high‑level missions.

Final Goal (Phase 3+)
- Fully autonomous, tool‑using agent that plans and executes missions from natural language, adapts to conditions (target not found, obstacles, HW issues), and keeps a human‑override controller in the loop.
- High‑level only: plan/mission APIs (no direct stick micromanagement), with confirmations and safety checks.

Current Phase (Program + Camera Tools)
- Scope: Execute a formal program (DSL) from a planner via existing bridge tools (H20N/FPV).
- Capabilities: find/center/measure/track; repeatable blocks; debug “describe” shows all objects with labels and confidences.
- Planner: program‑only service returns both the high‑level macro program and the fully expanded program; server expands macros recursively and validates strictly.

Status Summary
- UI (Agent): free‑floating, movable, resizable; Run/Stop; detector threshold toggle; ribbon timings; Plan errors panel; Program viewer (toggle: High‑level/Final); execution trace with auto‑scroll. Pane sizes persist in localStorage.
- Executor: deterministic interpreter (no NL parsing). Handles execution‑time realities only: detect retries; look_at cooldown. While loop timing is measured per loop.
- Vision: HTTP `/detect` (open‑vocabulary) and `/describe` (multi‑label) services. Threshold adjustable in UI. Overlays render pre‑slew and post‑slew.
- Bridge: `gimbal_tap_target`, `camera_laser_enable`, `camera_laser_measure`.
- Planner: program‑only; returns `{ program, high_level_program }` or `{ errors }`. Server expands macros until only primitive/structural nodes remain and validates strictly.

Planner + DSL (program‑only)
- The planner generates a formal program (DSL). See `docs/AGENT_DSL.md`.
- Macros (high‑level): `measure_object` and `track_object` (expands to `repeat`). Macros expanded recursively server‑side; planner returns both high‑level and final programs.
- Strict validation: undefined variables; while requires `max_iter` and `interval_ms`; repeat requires positive `times`; unexpanded macros rejected.

Key Files
- UI components
  - `dji-controller-interface/src/components/AgentPanel.tsx`
  - `dji-controller-interface/src/components/H20NDisplay.tsx` (mounts Agent panel, snapshot, overlays)
  - `dji-controller-interface/src/components/FPVDisplay.tsx` (FPV canvas + describe debug)
- Orchestrator and Vision
  - `dji-controller-interface/src/agent/orchestrator.ts`
  - `dji-controller-interface/src/agent/visionClient.ts` (HTTP `/detect` + `/describe` facades)
- Optional servers (local)
  - `tools/vision_detect_server.py` (FastAPI; OWL‑ViT if available; `/detect` and `/describe`)
  - `tools/planner_service.py` (FastAPI; OpenAI via `OPENAI_API_KEY`)

User‑Visible Behavior
- H20N/FPV: click “Describe” → boxes with labels/confidences overlay the video (debug only).
- Agent on H20N: “find person” → Run. Program (High‑level/Final) is shown; the view recenters, laser rangefinder measures; execution trace shows resolved values.

Tool / API Contracts
- Bridge (already implemented)
  - `gimbal_tap_target { x, y }` normalized [0..1]
  - `camera_laser_enable { enabled }`
  - `camera_laser_measure { x, y }` → async `camera_laser_result { distance_m, lat, lon, alt_m, ... }`
- Vision facade
  - Detect: `POST http://127.0.0.1:9001/detect { image, query, threshold? }` → `{ boxes: [{x1,y1,x2,y2,score,label?}] }`
  - Describe: `POST http://127.0.0.1:9001/describe { image, labels?, threshold?, top_k? }` → `{ boxes: [{x1,y1,x2,y2,score,label?}] }`
  - Coordinates normalized to [0,1].

Setup: Mac (MacBook Air)
1) UI + Bridge
   - Build UI: `cd dji-controller-interface && npm install && npm run build`
   - Launch Android bridge and UI as you do now (scripts already in repo).
2) Minimal detector (three options)
   - A) No install: use built‑in fallback. The agent will still run by sending a center tap; useful to validate the loop.
   - B) Lightweight local OWL‑ViT (CPU or MPS)
     - Install Python 3.10+ and create a venv.
     - `python -m venv .venv && source .venv/bin/activate`
     - `pip install fastapi uvicorn pillow transformers torch torchvision`
       - Apple Silicon: `pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu` (or use nightly MPS if desired).
     - Run: `python tools/vision_detect_server.py`
     - Endpoint: `http://127.0.0.1:9001/detect`
   - C) Cloud VLM (optional quick path)
     - Replace the detector server with a tiny proxy that forwards to a cloud VLM; keep the same `/detect` output schema.

Usage
- Start the bridge and UI.
- Ensure H20N is active; optionally set lens (Wide/Zoom/IR) and toggle Laser On.
- In the Agent panel: enter a prompt like “find person” → Run.
- Watch the green detection box; camera centers and the LRF overlay shows distance.

Models (Phase 1)
- Detector: OWL‑ViT (open vocabulary) recommended for local. It’s small, works on CPU, and supports free‑text queries.
- Captioning/OCR: not needed yet. Add BLIP2 or PaddleOCR later if “describe”/text is required.

Planner Service (program‑only)
- Endpoint: `POST /plan { instruction }` → `{ program, high_level_program }` or `{ errors, program?, high_level_program? }`
- Server responsibilities: prompt LLM → receive high‑level macro program → recursively expand macros → validate strictly (undefined vars, bounded while/interval_ms, positive repeat.times) → reject unexpanded macros.
- Prompt examples are semantic (OBJECT_A/OBJECT_B) rather than specific nouns; track maps to a repeat loop.

Planner service quickstart (this repo)
- `pip install fastapi uvicorn pydantic openai`
- `OPENAI_API_KEY=sk-... python tools/planner_service.py`
- Endpoint: `http://127.0.0.1:9002/plan` with body `{ "instruction": "find OBJECT_A and track it" }`

Performance Notes
- MacBook Air (CPU): OWL‑ViT base runs in ~0.6–2.0 s per image depending on size; acceptable for POC. Keep queries short and run at 1280×720 or similar.
- Reduce latency by:
  - Downscaling snapshot before sending to detector.
  - Using a single top‑1 detection; threshold ~0.35.
  - Starting with Wide lens; switch to Zoom only if bbox area < 5%.

Roadmap / Next Steps
1) Detector: keep OWL‑ViT service; add optional caption/ocr services as separate tools.
2) “Describe scene”: planner emits detect + respond; or add `caption` tool later.
3) Lens policy: planner may choose camera_select before detect.
4) Safety gates: preflight checks and confirmations for navigation tools when added.
5) Missions: add mission tools + macro; plan interpreter remains deterministic.
6) Adaptation: on runtime events, re‑plan by calling planner with summarized context.

Configuration
- Vision endpoints: set `window.__VISION_URL__` for `/detect` and `window.__DESCRIBE_URL__` for `/describe` (optional). Adjust threshold in UI.
- Planner endpoint: `window.__PLANNER_URL__` (optional; defaults to `http://127.0.0.1:9002/plan`).
- Planner env: `OPENAI_API_KEY` (required), `PLANNER_MODEL` (defaults to `gpt-4o-mini`).

Troubleshooting
- Agent runs but no boxes: check the detector server logs or rely on fallback (center tap) to validate the tool loop.
- LRF returns 0 m: too close or no return; try one retry after a longer settle; UI already reports “LRF min 3 m”.
- Performance slow: reduce snapshot resolution; ensure you run OWL‑ViT base; avoid patch14 large.
- Vision panel (prototype)
  - A separate floating “Vision” window (FPV + H20N) powered by a general purpose vision model (local prototype: Qwen2‑VL‑2B).
  - Tools:
    - Find objects: generates a conservative list of objects and fills an editable list.
    - Boxes: toggles OWL‑ViT boxes for labels in the editable list. Boxes disappear on camera movement and sit below UI panels.
    - Describe: one short paragraph describing the scene (main objects, layout, unusual elements).
    - Query: one‑paragraph answer to a custom question grounded in the image.
  - This panel does not affect AGENT execution; it’s for debugging and perception prototyping only.

### General Vision Model (prototype)

- Endpoint: `POST http://127.0.0.1:9003/general/analyze`
- Request: `{ image, task: 'objects'|'describe'|'query', question?, threshold?, top_k? }`
- Response: `{ objects:[{label,count?,score?}], caption, answer }`
- Local run (example):
  ```bash
  python -m venv .venv && source .venv/bin/activate
  pip install fastapi uvicorn pillow transformers accelerate
  # Install torch/torchvision wheels for your platform (CPU or MPS)
  QWEN_MODEL=Qwen/Qwen2-VL-2B-Instruct python tools/vision_general_server.py
  ```
- Notes:
  - The model receives a downscaled frame (≤1024 px) for stability/latency. OWL‑ViT input size remains unchanged.
  - The server never returns boxes; OWL‑ViT remains the source of bounding boxes.
