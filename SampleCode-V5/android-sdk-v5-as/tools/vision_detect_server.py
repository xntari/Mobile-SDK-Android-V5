#!/usr/bin/env python3
"""
Minimal /detect service for the Agent POC.

- If transformers + torch are available, uses OWL-ViT base for open-vocabulary detection.
- Otherwise, gracefully falls back to a dummy center box so the UI loop still works.

Endpoint:
  POST /detect { image: <dataURL or base64>, query: "car" }
Response:
  { boxes: [{ x1,y1,x2,y2,score,label? }] }  # normalized 0..1

Run:
  pip install fastapi uvicorn pillow
  # optional for real detection: pip install transformers torch torchvision
  python tools/vision_detect_server.py
  # Server on http://127.0.0.1:9001
"""
from typing import List, Dict, Any
import base64
import io
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DetectRequest(BaseModel):
    image: str
    query: str
    threshold: float | None = None

class DescribeRequest(BaseModel):
    image: str
    labels: list[str] | None = None  # optional label set; if None, server default is used
    threshold: float | None = None
    top_k: int | None = None


def decode_image_to_pil(image_b64_or_dataurl: str) -> Image.Image:
    data = image_b64_or_dataurl
    if data.startswith("data:"):
        # data URL: data:image/jpeg;base64,....
        header, b64 = data.split(",", 1)
    else:
        b64 = data
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


_HAVE_OWL = False
_owl_processor = None
_owl_model = None

def _lazy_load_owlvit():
    global _HAVE_OWL, _owl_processor, _owl_model
    if _HAVE_OWL:
        return
    try:
        from transformers import OwlViTProcessor, OwlViTForObjectDetection  # type: ignore
        import torch  # type: ignore
        model_id = os.environ.get("OWL_MODEL", "google/owlvit-base-patch32")
        _owl_processor = OwlViTProcessor.from_pretrained(model_id)
        _owl_model = OwlViTForObjectDetection.from_pretrained(model_id)
        _HAVE_OWL = True
        print(f"[detect_server] Loaded OWL-ViT model: {model_id}")
    except Exception as e:
        print("[detect_server] OWL-ViT unavailable, using fallback:", e)
        _HAVE_OWL = False


def _detect_with_owlvit(img: Image.Image, query: str, threshold: float = 0.15) -> List[Dict[str, Any]]:
    from transformers import OwlViTProcessor  # type: ignore
    import torch  # type: ignore
    assert _owl_processor is not None and _owl_model is not None
    # Downscale very large images for speed
    max_side = 1280
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        new_size = (int(img.width * scale), int(img.height * scale))
        img = img.resize(new_size)

    inputs = _owl_processor(text=[[query]], images=img, return_tensors="pt")
    with torch.no_grad():
        outputs = _owl_model(**inputs)
    target_sizes = torch.tensor([img.size[::-1]])  # (h,w)
    results = _owl_processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=threshold)[0]
    boxes_px = results.get("boxes", [])
    scores = results.get("scores", [])
    # Normalize
    W, H = img.size
    boxes = []
    for i in range(len(boxes_px)):
        x1, y1, x2, y2 = boxes_px[i].tolist()
        boxes.append({
            "x1": max(0.0, min(1.0, x1 / W)),
            "y1": max(0.0, min(1.0, y1 / H)),
            "x2": max(0.0, min(1.0, x2 / W)),
            "y2": max(0.0, min(1.0, y2 / H)),
            "score": float(scores[i].item()),
            "label": query,
        })
    # Sort by score desc
    boxes.sort(key=lambda b: b.get("score", 0), reverse=True)
    return boxes


def _describe_with_owlvit(img: Image.Image, labels: List[str], threshold: float = 0.25, top_k: int = 50) -> List[Dict[str, Any]]:
    from transformers import OwlViTProcessor  # type: ignore
    import torch  # type: ignore
    assert _owl_processor is not None and _owl_model is not None

    # Downscale for speed if needed
    max_side = 1280
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        new_size = (int(img.width * scale), int(img.height * scale))
        img = img.resize(new_size)

    # OWL-ViT supports multiple labels via a list within a batch
    text = [labels]  # shape: [batch=1, num_labels]
    inputs = _owl_processor(text=text, images=img, return_tensors="pt")
    with torch.no_grad():
        outputs = _owl_model(**inputs)
    target_sizes = torch.tensor([img.size[::-1]])
    results = _owl_processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=threshold)[0]
    boxes_px = results.get("boxes", [])
    scores = results.get("scores", [])
    lab_idx = results.get("labels", [])
    W, H = img.size
    boxes: List[Dict[str, Any]] = []
    for i in range(len(boxes_px)):
        x1, y1, x2, y2 = boxes_px[i].tolist()
        li = int(lab_idx[i].item()) if len(lab_idx) > i else -1
        lbl = labels[li] if 0 <= li < len(labels) else None
        boxes.append({
            "x1": max(0.0, min(1.0, x1 / W)),
            "y1": max(0.0, min(1.0, y1 / H)),
            "x2": max(0.0, min(1.0, x2 / W)),
            "y2": max(0.0, min(1.0, y2 / H)),
            "score": float(scores[i].item()),
            "label": lbl,
        })
    boxes.sort(key=lambda b: b.get("score", 0), reverse=True)
    if isinstance(top_k, int) and top_k > 0:
        boxes = boxes[:top_k]
    return boxes


def _detect_fallback(img: Image.Image, query: str) -> List[Dict[str, Any]]:
    # Return a small center box
    cx, cy, w, h = 0.5, 0.5, 0.2, 0.2
    return [{"x1": cx - w/2, "y1": cy - h/2, "x2": cx + w/2, "y2": cy + h/2, "score": 0.1, "label": query}]


def _synonyms(q: str) -> List[str]:
    t = q.strip().lower()
    if t in ("person", "people", "human"):  # simple expansions
        return ["person", "people", "human", "man", "woman"]
    return [q]


@app.post("/detect")
def detect(req: DetectRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception as e:
        print("[detect_server] bad image payload")
        return {"boxes": []}

    if not req.query:
        return {"boxes": []}

    if not _HAVE_OWL:
        _lazy_load_owlvit()

    try:
        if _HAVE_OWL:
            th = float(req.threshold) if req.threshold is not None else float(os.environ.get("OWL_THRESH", "0.25"))
            print(f"[detect_server] OWL-ViT detect: '{req.query}' size={img.width}x{img.height} thr={th}")
            boxes = []
            # Try synonyms if applicable
            for q in _synonyms(req.query):
                r = _detect_with_owlvit(img, q, threshold=th)
                boxes.extend(r)
            # If still empty, relax threshold and try once more
            if not boxes and th > 0.15:
                th2 = 0.05
                print(f"[detect_server] relaxing threshold to {th2}")
                for q in _synonyms(req.query):
                    r = _detect_with_owlvit(img, q, threshold=th2)
                    boxes.extend(r)
            # Sort and keep top 5
            boxes.sort(key=lambda b: b.get("score", 0), reverse=True)
            boxes = boxes[:5]
        else:
            print(f"[detect_server] Fallback detect: '{req.query}' (no OWL-ViT)")
            boxes = _detect_fallback(img, req.query)
    except Exception as e:
        print("[detect_server] detection error:", e)
        boxes = _detect_fallback(img, req.query)

    print(f"[detect_server] → {len(boxes)} boxes")
    return {"boxes": boxes}


def _default_describe_labels() -> List[str]:
    # Allow override via env var (comma-separated). Otherwise, a compact set of common objects.
    s = os.environ.get("DESCRIBE_LABELS")
    if s:
        return [p.strip() for p in s.split(',') if p.strip()]
    return [
        "person","car","truck","bus","bicycle","motorcycle","traffic light","stop sign",
        "chair","couch","bed","table","tv","laptop","cell phone","remote","keyboard",
        "book","bottle","cup","wine glass","fork","knife","spoon","bowl","backpack",
        "umbrella","handbag","suitcase","tie","dog","cat","bird","horse","sheep","cow",
        "towel", "brush", "toothpaste", "toothbrush"
    ]


@app.post("/describe")
def describe(req: DescribeRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        print("[detect_server] bad image payload for describe")
        return {"boxes": []}

    if not _HAVE_OWL:
        _lazy_load_owlvit()

    labels = req.labels or _default_describe_labels()
    th = float(req.threshold) if req.threshold is not None else float(os.environ.get("OWL_THRESH", "0.25"))
    top_k = int(req.top_k) if req.top_k else 50
    try:
        if _HAVE_OWL:
            print(f"[detect_server] describe: {len(labels)} labels size={img.width}x{img.height} thr={th}")
            boxes = _describe_with_owlvit(img, labels, threshold=th, top_k=top_k)
        else:
            print("[detect_server] describe fallback (no model)")
            boxes = []
    except Exception as e:
        print("[detect_server] describe error:", e)
        boxes = []
    print(f"[detect_server] describe → {len(boxes)} boxes")
    return {"boxes": boxes}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("VISION_PORT", "9001"))
    uvicorn.run(app, host="127.0.0.1", port=port)
