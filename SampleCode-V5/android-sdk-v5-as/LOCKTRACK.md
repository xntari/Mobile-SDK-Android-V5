# LOCKTRACK – Visual Lock-On Heatmap Tracker

Status: Phase M1 in progress (API + engine + UI wiring). This document tracks the plan, build/run instructions, and API details for the lock‑on visual tracker that replaces the broken “Image Prompt” path.

## Goals
- Lock onto a specific object instance using a reference image or a drawn box.
- Track/re‑acquire via cosine‑similarity heatmap, independent of YOLO tracking.
- Run 3–5 FPS on MacBook Air (MPS), float32‑only.
- Start with single‑view memory (K=1) and optional heatmap return for debugging.
- Persist the reference locally (in‑memory + small on‑disk cache). No OpenCV SOT.

## Architecture
- Backbone: MobileNetV3‑Small (torchvision) as a lightweight feature extractor.
- Per frame: compute a feature map (stride ~16–32); L2‑normalize per spatial location.
- Reference: compute one L2‑normalized descriptor from the lock‑on crop.
- Heatmap: 1×1 conv (cosine similarity) between the frame feature map and the reference descriptor; multi‑scale by evaluating the reference at 2–3 scales and taking the max.
- Box extraction: peak of heatmap → image coords; keep previous box size (scaled). EMA smoothing planned later.
- Device: MPS if available; otherwise CPU/CUDA. Enforce float32 everywhere.

## API (FastAPI)
- POST `/realtime/locktrack/lock`
  - Inputs: `{ image: base64, box?: {x,y,w,h}, ref_image?: base64, return_heatmap?: bool, threshold?: float, search_pad?: int, scales?: number[] }`
  - Returns: `{ track_id, init_box: {x,y,w,h}, score, status: "locked"|"searching", heatmap? }`
- POST `/realtime/locktrack/step`
  - Inputs: `{ track_id, image: base64, return_heatmap?: bool }`
  - Returns: `{ box: {x,y,w,h}, score, status: "tracking"|"searching"|"lost", heatmap? }`
- POST `/realtime/locktrack/add_view` (for now keeps only the latest; K=1)
  - Inputs: `{ track_id, image+box | ref_image }`
  - Returns: `{ num_views: 1 }`
- POST `/realtime/locktrack/unlock`
  - Inputs: `{ track_id }` → `{ ack: true }`

Notes
- Boxes use normalized coordinates in [0,1] relative to full image. If you omit `box` at lock time, a heuristic size is used; passing a box is recommended.
- `return_heatmap` returns a compact PNG base64 (grayscale) at feature resolution. Default is OFF; enable via request option/UI toggle.

## Build & Run
Env setup (first time)
```
python -m venv .venv && source .venv/bin/activate
pip install --upgrade pip
pip install fastapi uvicorn pillow torch torchvision numpy
```

Start the server
```
python tools/vision_locktrack_server.py
# Custom port
LOCKTRACK_PORT=9010 python tools/vision_locktrack_server.py
# Force device (auto|mps|cpu|cuda)
LOCKTRACK_DEVICE=mps python tools/vision_locktrack_server.py
```

Quick test
```
# Lock using a snapshot + box (normalized coords)
curl -s -X POST http://127.0.0.1:9010/realtime/locktrack/lock \
  -H 'Content-Type: application/json' \
  -d '{"image":"<base64>", "box": {"x":0.4,"y":0.3,"w":0.2,"h":0.2}, "return_heatmap":true}' | jq

# Step (new frame)
curl -s -X POST http://127.0.0.1:9010/realtime/locktrack/step \
  -H 'Content-Type: application/json' \
  -d '{"track_id":"<id>", "image":"<base64>", "return_heatmap":false}' | jq
```

## Implementation Notes
- No lazy loading: the backbone is fully initialized at process start.
- MPS dtype hygiene: `torch.set_default_dtype(torch.float32)` and explicit `.float()` casts at model boundaries.
- Mapping heatmap→image: feature map size (Hf×Wf) is linearly mapped back to image width/height.
- Search pad: optionally gates heatmap to a region around the last box; set to `0` for full‑frame search.

## Persistence & Defaults
- Persistence path: `data/locktrack/` (npz descriptors + optional `_ref.png`).
- Default heatmap: OFF (use `return_heatmap:true` to receive it).

## Performance Targets
- MobileNetV3‑Small features at 640px on MPS are light; combined with 1×1 conv per scale this fits the 3–5 FPS budget when running alongside YOLO‑E.

## Roadmap & TODO
- M1 (this PR):
  - [x] New server `tools/vision_locktrack_server.py` (FastAPI)
  - [x] Lock/Step/AddView/Unlock endpoints
  - [x] Single‑view descriptor, float32‑only, MPS‑first
  - [x] Optional heatmap return (PNG b64)
  - [x] Local persistence per `track_id`
  - [x] README and script usage
  - [x] This document
- M2:
  - [ ] Peak refinement and EMA smoothing
  - [ ] Adaptive thresholding and lost widening
  - [ ] Hotspot return (compact) + UI overlay improvements
  - [ ] Telemetry gates (gimbal yaw/pitch, rangefinder scale)
- M3:
  - [ ] Multi‑view memory (K>1) and persistence
  - [ ] Optional YOLO validation pass
  - [ ] Disk cache management and metrics

## Notes on Future Sensor Fusion
- Integrate gimbal angles to stabilize search window.
- Use rangefinder distance for expected scale gating.
- Cross‑camera re‑acquire using shared descriptors (wide↔zoom↔thermal) with per‑camera intrinsics.
- Accumulate landmark descriptors into a world model for re‑identification and re‑acquisition.
