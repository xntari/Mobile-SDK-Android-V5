Agent POC: Vision + Tool-Using Autonomy
--------------------------------------

Purpose
- Track the goal, current phase, status, models, setup, and next steps for a tool-using vision agent that operates the gimbal/camera and (later) high‑level missions.

Final Goal (Phase 3+)
- Fully autonomous, tool‑using agent that plans and executes missions from natural language, adapts to conditions (target not found, obstacles, HW issues), and keeps a human‑override controller in the loop.
- High‑level only: plan/mission APIs (no direct stick micromanagement), with confirmations and safety checks.

Current Phase (Phase 1: Perception + Camera Tools)
- Scope: Single‑step tasks on the H20N camera via existing bridge tools.
- Capabilities: “find X, center camera, measure distance/GPS, respond”. Optional “describe scene”.
- Planner: not yet; simple orchestrator executes a fixed flow.

Status Summary
- UI: Agent panel added to H20N view (prompt + Run/Stop + logs + detection overlay).
- Orchestrator: snapshot → detect → look_at → LRF measure → respond.
- Vision: swappable `vision.analyze` facade; default tries HTTP `/detect` then falls back to a dummy center box.
- Bridge: uses existing commands (`gimbal_tap_target`, `camera_laser_enable`, `camera_laser_measure`).
- Build: UI compiles; no changes to existing features.

Planner + DSL (next evolution)
- The planner should generate a formal plan (DSL) rather than ad-hoc steps. See `docs/AGENT_DSL.md`.
- The DSL supports variables, if/while, and templates like `measure_object` and `track_object`.
- The current executor already interprets a flat step list; we will extend it to a small subset of the DSL (while/if with bounds).

Key Files
- UI components
  - `dji-controller-interface/src/components/AgentPanel.tsx`
  - `dji-controller-interface/src/components/H20NDisplay.tsx` (mounts Agent panel, snapshot, overlays)
- Orchestrator and Vision
  - `dji-controller-interface/src/agent/orchestrator.ts`
  - `dji-controller-interface/src/agent/visionClient.ts` (HTTP `/detect` facade + fallback)
- Optional servers (local)
  - `tools/vision_detect_server.py` (FastAPI, OWL‑ViT if available, otherwise dummy center box)
  - `tools/planner_service.py` (FastAPI, uses OpenAI if `OPENAI_API_KEY` is set, otherwise returns a heuristic plan)

User‑Visible Behavior (Phase 1)
- Open the Agent panel on the H20N view, type “find car”, click Run.
- The agent snapshots the frame, calls `/detect`, centers the best box, waits ~0.6s, enables laser, measures at the target, and returns a short confirmation. The standard LRF overlay displays distance.

Tool / API Contracts
- Bridge (already implemented)
  - `gimbal_tap_target { x, y }` normalized [0..1]
  - `camera_laser_enable { enabled }`
  - `camera_laser_measure { x, y }` → async `camera_laser_result { distance_m, lat, lon, alt_m, ... }`
- Vision facade
  - HTTP: `POST http://127.0.0.1:9001/detect { image, query }` → `{ boxes: [{x1,y1,x2,y2,score,label?}] }`
  - Coordinates normalized to [0,1]; server can return 0 boxes.

Setup: Mac (MacBook Air)
1) UI + Bridge
   - Build UI: `cd dji-controller-interface && npm install && npm run build`
   - Launch Android bridge and UI as you do now (scripts already in repo).
2) Minimal detector (three options)
   - A) No install: use built‑in fallback. The agent will still run by sending a center tap; useful to validate the loop.
   - B) Lightweight local OWL‑ViT (CPU or MPS)
     - Install Python 3.10+ and create a venv.
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

Planner Service (Phase 2)
- Goal: Convert instructions into a short JSON plan of tool calls with guardrails (confirm flight, preflight checks, retries).
- Cloud path (fastest/reliable):
  - Create a tiny Node/TS or Python service that exposes `POST /plan { instruction, status }` and calls your LLM (e.g., GPT‑4o‑mini / function‑calling) to return JSON steps using your tool schema.
  - Env: `OPENAI_API_KEY`.
  - Output example:
    ```json
    {"steps":[
      {"tool":"snapshot","args":{}},
      {"tool":"detect","args":{"query":"truck"}},
      {"tool":"look_at","args":{"x":"$det.cx","y":"$det.cy"}},
      {"tool":"sleep","args":{"ms":600}},
      {"tool":"laser_enable","args":{"enabled":true}},
      {"tool":"laser_measure","args":{"x":"$det.cx","y":"$det.cy"}},
      {"tool":"respond","args":{}}
    ]}
    ```
- Local path (later):
  - Swap the cloud LLM with a local instruct model (e.g., Llama‑3.1/3.2‑8B‑Instruct) and a small LoRA on “instruction → plan JSON”.
  - Keep the same `/plan` schema so the UI doesn’t change.

Planner service quickstart (this repo)
- `pip install fastapi uvicorn pydantic openai`
- `OPENAI_API_KEY=sk-... python tools/planner_service.py`
- Endpoint: `http://127.0.0.1:9002/plan` with body `{ "instruction": "find car and measure" }`

Performance Notes
- MacBook Air (CPU): OWL‑ViT base runs in ~0.6–2.0 s per image depending on size; acceptable for POC. Keep queries short and run at 1280×720 or similar.
- Reduce latency by:
  - Downscaling snapshot before sending to detector.
  - Using a single top‑1 detection; threshold ~0.35.
  - Starting with Wide lens; switch to Zoom only if bbox area < 5%.

Roadmap / Next Steps
1) Add real detector backend (OWL‑ViT) and a config toggle to enable/disable the naive fallback.
2) Add “Describe scene” using top‑K detections → summary.
3) Lens policy: start Wide, re‑detect on Zoom if small bbox.
4) Planner service (cloud) producing a DSL plan with:
   - confirm_flight gate; preflight checks (battery, GPS fix, mode).
   - retries/fallbacks (target_not_found → re-detect or alternate phrase).
   - measure_object and track_object templates.
5) Mission tools integration (Phase 3): create waypoints from LRF GPS; start/monitor mission; RTL/hover/abort.
6) Adaptation loop: on runtime events (battery low, obstacle flag, hw error) request a plan patch instead of full replan.

Configuration
- Vision endpoint override: set `window.__VISION_URL__` in the renderer preload or a config file to point to a different `/detect` server.
- Planner endpoint (future): `window.__PLANNER_URL__` with `/plan` schema.

Troubleshooting
- Agent runs but no boxes: check the detector server logs or rely on fallback (center tap) to validate the tool loop.
- LRF returns 0 m: too close or no return; try one retry after a longer settle; UI already reports “LRF min 3 m”.
- Performance slow: reduce snapshot resolution; ensure you run OWL‑ViT base; avoid patch14 large.
