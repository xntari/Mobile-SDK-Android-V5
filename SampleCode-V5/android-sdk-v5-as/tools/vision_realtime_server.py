#!/usr/bin/env python3
"""
Experimental realtime vision server using YOLOv8/YOLO11 (CPU-friendly variants) for
MacBook Air-class hardware. This keeps the API minimal and independent from the
existing Vision endpoints.

Endpoints:
  POST /realtime/detect { image, threshold?, classes?, img_size? }
    → { boxes: [{ x1,y1,x2,y2,score,label }] } (normalized 0..1)
  POST /realtime/segment { image, threshold?, img_size? }
    → { instances: [{ points:[{x,y}...], score?, label? }] }
  POST /realtime/pose { image, img_size? }
    → { poses: [{ keypoints:[{x,y,conf?}] }] }
  POST /realtime/classify { image, top_k?, img_size? }
    → { classes: [{ label, score }] }

Notes:
- If `ultralytics` is installed and the model loads, uses actual YOLO inference.
- Otherwise, gracefully falls back to a dummy center box so the UI path can be wired.

Run:
  python -m venv .venv && source .venv/bin/activate
  pip install fastapi uvicorn pillow ultralytics
  # Start with aliases (auto-download via Ultralytics if not local):
  python tools/vision_realtime_server.py --model v8n
  python tools/vision_realtime_server.py --model v11n
  # Add segmentation/pose/cls/obb support (optional):
  python tools/vision_realtime_server.py --model v11n --seg-model v11n-seg --pose-model v11n-pose --cls-model v11n-cls --obb-model v11n-obb
  # Or use local files:
  python tools/vision_realtime_server.py --model ./yolov8n.pt --seg-model ./yolov8n-seg.pt
  # http://0.0.0.0:9004
"""
from typing import List, Dict, Any, Optional
import base64
import io
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

import argparse

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RTDetectRequest(BaseModel):
    image: str                    # base64 or data URL
    threshold: float | None = None
    classes: list[str] | None = None  # optional allowlist of labels
    img_size: int | None = None       # optional max side for downscale (server-side)
    ov_labels: list[str] | None = None   # optional open-vocab labels to supplement


def decode_image_to_pil(image_b64_or_dataurl: str) -> Image.Image:
    data = image_b64_or_dataurl
    if data.startswith("data:"):
        header, b64 = data.split(",", 1)
    else:
        b64 = data
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


_HAVE_YOLO_DET = False
_yolo_model_det = None
_HAVE_YOLO_SEG = False
_yolo_model_seg = None
_HAVE_YOLO_OBB = False
_yolo_model_obb = None
_HAVE_YOLO_POSE = False
_yolo_model_pose = None
_HAVE_YOLO_CLS = False
_yolo_model_cls = None

_CLI_MODEL_SPEC: Optional[str] = None
_CLI_SEG_MODEL_SPEC: Optional[str] = None
_CLI_OBB_MODEL_SPEC: Optional[str] = None
_CLI_POSE_MODEL_SPEC: Optional[str] = None
_CLI_CLS_MODEL_SPEC: Optional[str] = None
_DEFAULT_PORT: int = int(os.environ.get("REALTIME_PORT", "9004"))
_DEFAULT_IMGSZ: int = int(os.environ.get("Y8_IMGSZ", "640"))
_DEFAULT_THRESH: float = float(os.environ.get("Y8_THRESH", "0.25"))
_DEVICE: str = os.environ.get("Y_DEVICE", "auto")  # 'auto' | 'cpu' | 'mps' | 'cuda'

# Hybrid open-vocab supplement
_DETECT_BACKEND: str = os.environ.get("DETECT_BACKEND", "yolov")  # 'yolov' | 'hybrid' | 'ovonly'
_HYBRID_LABELS: List[str] = [s.strip() for s in os.environ.get("HYBRID_LABELS", "").split(',') if s.strip()]


def _canonicalize_model_spec(spec: Optional[str], task: str) -> Optional[str]:
    """Map friendly aliases to canonical YOLO model names or paths.
    Accepted aliases:
      v8n, v8s, v8m, v8l, v8x -> yolov8*.pt
      v11n, v11s, v11m, v11l, v11x -> yolo11*.pt
    If spec is a local path, return as-is; if None, return None.
    """
    if not spec:
        return None
    s = spec.strip()
    # If it's an existing local file path, use it
    if os.path.isfile(s):
        return s
    # If it looks like a URL or a .pt name, let Ultralytics resolve it
    # Map short aliases
    alias_map = {
        'v8n': 'yolov8n.pt', 'v8s': 'yolov8s.pt', 'v8m': 'yolov8m.pt', 'v8l': 'yolov8l.pt', 'v8x': 'yolov8x.pt',
        'v11n': 'yolo11n.pt', 'v11s': 'yolo11s.pt', 'v11m': 'yolo11m.pt', 'v11l': 'yolo11l.pt', 'v11x': 'yolo11x.pt',
    }
    # Segmentation variants
    if task == 'seg':
        alias_map.update({
            'v8n-seg': 'yolov8n-seg.pt', 'v8s-seg': 'yolov8s-seg.pt', 'v8m-seg': 'yolov8m-seg.pt', 'v8l-seg': 'yolov8l-seg.pt', 'v8x-seg': 'yolov8x-seg.pt',
            'v11n-seg': 'yolo11n-seg.pt', 'v11s-seg': 'yolo11s-seg.pt', 'v11m-seg': 'yolo11m-seg.pt', 'v11l-seg': 'yolo11l-seg.pt', 'v11x-seg': 'yolo11x-seg.pt',
        })
    if task == 'pose':
        alias_map.update({
            'v8n-pose': 'yolov8n-pose.pt', 'v8s-pose': 'yolov8s-pose.pt',
            'v11n-pose': 'yolo11n-pose.pt', 'v11s-pose': 'yolo11s-pose.pt',
        })
    if task == 'cls':
        alias_map.update({
            'v8n-cls': 'yolov8n-cls.pt', 'v8s-cls': 'yolov8s-cls.pt',
            'v11n-cls': 'yolo11n-cls.pt', 'v11s-cls': 'yolo11s-cls.pt',
        })
    if task == 'obb':
        alias_map.update({
            'v8n-obb': 'yolov8n-obb.pt', 'v8s-obb': 'yolov8s-obb.pt',
            'v11n-obb': 'yolo11n-obb.pt', 'v11s-obb': 'yolo11s-obb.pt',
        })
    return alias_map.get(s.lower(), s)


def _lazy_load_yolo_det():
    global _HAVE_YOLO_DET, _yolo_model_det
    if _HAVE_YOLO_DET:
        return
    try:
        from ultralytics import YOLO  # type: ignore
        # Prefer CLI spec, then env, then known local files
        model_path_env = _canonicalize_model_spec(_CLI_MODEL_SPEC, 'det') or os.environ.get("YOLO_MODEL") or os.environ.get("Y8_MODEL")
        fallback_order = [
            model_path_env,
            os.path.join(os.getcwd(), "yolov8n.pt"),
            os.path.join(os.getcwd(), "yolo11n.pt"),
        ]
        model_path = None
        for p in fallback_order:
            if p and os.path.isfile(p):
                model_path = p
                break
        if model_path is None:
            # Let ultralytics try resolving a hub name as a last resort (may hit network)
            model_path = model_path_env or "yolov8n.pt"
        _yolo_model_det = YOLO(model_path)
        # Move to device if requested
        try:
            if _DEVICE in ("mps","cuda"):
                _yolo_model_det.to(_DEVICE)
        except Exception:
            pass
        _HAVE_YOLO_DET = True
        print(f"[realtime] Loaded YOLO model: {model_path}")
    except Exception as e:
        print("[realtime] YOLO DET unavailable or failed to load, using fallback:", e)
        _HAVE_YOLO_DET = False


def _lazy_load_yolo_seg():
    global _HAVE_YOLO_SEG, _yolo_model_seg
    if _HAVE_YOLO_SEG:
        return
    try:
        from ultralytics import YOLO  # type: ignore
        # Use CLI spec first, then envs, then local seg files
        model_path_env = _canonicalize_model_spec(_CLI_SEG_MODEL_SPEC, 'seg') or os.environ.get("YOLO_SEG_MODEL") or os.environ.get("Y8_SEG_MODEL")
        fallback_order = [
            model_path_env,
            os.path.join(os.getcwd(), "yolov8n-seg.pt"),
            os.path.join(os.getcwd(), "yolo11n-seg.pt"),
        ]
        model_path = None
        for p in fallback_order:
            if p and os.path.isfile(p):
                model_path = p
                break
        if model_path is None:
            model_path = model_path_env or "yolov8n-seg.pt"
        _yolo_model_seg = YOLO(model_path)
        try:
            if _DEVICE in ("mps","cuda"):
                _yolo_model_seg.to(_DEVICE)
        except Exception:
            pass
        _HAVE_YOLO_SEG = True
        print(f"[realtime] Loaded YOLO SEG model: {model_path}")
    except Exception as e:
        print("[realtime] YOLO SEG unavailable or failed to load:", e)
        _HAVE_YOLO_SEG = False


def _scale_image(img: Image.Image, max_side: int = 640) -> Image.Image:
    if max(img.size) <= max_side:
        return img
    scale = max_side / max(img.size)
    new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    return img.resize(new_size)


def _detect_fallback(img: Image.Image, classes: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    # Dummy center box; pick label from classes[0] if specified
    label = (classes[0] if classes else "object") if classes else "object"
    cx, cy, w, h = 0.5, 0.5, 0.25, 0.25
    return [{"x1": cx - w/2, "y1": cy - h/2, "x2": cx + w/2, "y2": cy + h/2, "score": 0.2, "label": label}]


def _detect_with_yolo(img: Image.Image, threshold: float, classes: Optional[List[str]], img_size: int) -> List[Dict[str, Any]]:
    from ultralytics import YOLO  # type: ignore
    assert _yolo_model_det is not None
    # Ultralytics can accept PIL directly; control size via imgsz
    kw = {"imgsz": img_size, "conf": threshold, "verbose": False}
    if _DEVICE in ("mps","cuda"):
        kw["device"] = _DEVICE
    results = _yolo_model_det.predict(img, **kw)
    boxes: List[Dict[str, Any]] = []
    W, H = img.size
    # results is a list; take first
    if not results:
        return boxes
    r = results[0]
    names = r.names if hasattr(r, 'names') else {}
    # r.boxes.xyxy, r.boxes.conf, r.boxes.cls
    try:
        xyxy = r.boxes.xyxy.cpu().numpy().tolist()
        conf = r.boxes.conf.cpu().numpy().tolist()
        cls = r.boxes.cls.cpu().numpy().tolist()
    except Exception:
        return boxes

    for i in range(len(xyxy)):
        x1, y1, x2, y2 = xyxy[i]
        score = float(conf[i])
        cls_id = int(cls[i])
        label = str(names.get(cls_id, str(cls_id)))
        # filter by classes if provided
        if classes and label not in classes:
            continue
        boxes.append({
            "x1": max(0.0, min(1.0, x1 / W)),
            "y1": max(0.0, min(1.0, y1 / H)),
            "x2": max(0.0, min(1.0, x2 / W)),
            "y2": max(0.0, min(1.0, y2 / H)),
            "score": score,
            "label": label,
        })
    # Sort by score desc and keep top 50
    boxes.sort(key=lambda b: b.get("score", 0), reverse=True)
    return boxes[:50]


# Open-vocabulary supplement (OWL-ViT fallback)
_OVL_LOADED = False
_ov_processor = None
_ov_model = None

def _lazy_load_ov():
    global _OVL_LOADED, _ov_processor, _ov_model
    if _OVL_LOADED:
        return
    try:
        from transformers import OwlViTProcessor, OwlViTForObjectDetection  # type: ignore
        model_id = os.environ.get("OV_MODEL", "google/owlvit-base-patch32")
        _ov_processor = OwlViTProcessor.from_pretrained(model_id)
        _ov_model = OwlViTForObjectDetection.from_pretrained(model_id)
        _OVL_LOADED = True
        print(f"[realtime] Loaded OWL-ViT for open-vocab supplement: {model_id}")
    except Exception as e:
        print("[realtime] OWL-ViT unavailable for hybrid detect:", e)
        _OVL_LOADED = False


def _ov_detect(img: Image.Image, labels: List[str], threshold: float = 0.15) -> List[Dict[str, Any]]:
    if not labels:
        return []
    if not _OVL_LOADED:
        _lazy_load_ov()
    if not _OVL_LOADED:
        return []
    try:
        from transformers import OwlViTProcessor  # type: ignore
        import torch  # type: ignore
        max_side = 1280
        if max(img.size) > max_side:
            scale = max_side / max(img.size)
            img = img.resize((int(img.width*scale), int(img.height*scale)))
        inputs = _ov_processor(text=[labels], images=img, return_tensors="pt")
        with torch.no_grad():
            outputs = _ov_model(**inputs)
        target_sizes = torch.tensor([img.size[::-1]])
        res = _ov_processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=threshold)[0]
        boxes_px = res.get("boxes", [])
        scores = res.get("scores", [])
        lab_idx = res.get("labels", [])
        W, H = img.size
        out = []
        for i in range(len(boxes_px)):
            x1,y1,x2,y2 = boxes_px[i].tolist()
            li = int(lab_idx[i].item()) if len(lab_idx)>i else -1
            lbl = labels[li] if 0 <= li < len(labels) else None
            out.append({
                "x1": max(0.0, min(1.0, x1/W)),
                "y1": max(0.0, min(1.0, y1/H)),
                "x2": max(0.0, min(1.0, x2/W)),
                "y2": max(0.0, min(1.0, y2/H)),
                "score": float(scores[i].item()),
                "label": lbl,
            })
        out.sort(key=lambda b: b.get("score", 0), reverse=True)
        return out[:50]
    except Exception as e:
        print("[realtime] ov detect error:", e)
        return []


def _merge_nms(a: List[Dict[str,Any]], b: List[Dict[str,Any]], iou_thr: float = 0.5) -> List[Dict[str,Any]]:
    # Merge two detection lists with IoU-based suppression
    out = a[:]
    def iou(b1,b2):
        import math
        xA=max(b1['x1'],b2['x1']); yA=max(b1['y1'],b2['y1']); xB=min(b1['x2'],b2['x2']); yB=min(b1['y2'],b2['y2'])
        inter=max(0,xB-xA)*max(0,yB-yA)
        a1=(b1['x2']-b1['x1'])*(b1['y2']-b1['y1']); a2=(b2['x2']-b2['x1'])*(b2['y2']-b2['y1'])
        union=a1+a2-inter
        return inter/union if union>0 else 0
    for bb in b:
        keep=True
        for aa in out:
            if (aa.get('label')==bb.get('label')) and iou(aa,bb)>iou_thr:
                keep=False; break
        if keep:
            out.append(bb)
    out.sort(key=lambda x:x.get('score',0), reverse=True)
    return out[:50]


@app.post("/realtime/detect")
def realtime_detect(req: RTDetectRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {"boxes": []}

    if not _HAVE_YOLO_DET:
        _lazy_load_yolo_det()

    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ

    try:
        # Base YOLO
        if _HAVE_YOLO_DET:
            img2 = _scale_image(img, max_side=size)
            boxes = _detect_with_yolo(img2, threshold=thr, classes=req.classes, img_size=size)
        else:
            boxes = _detect_fallback(img, req.classes)
        # Hybrid supplement
        use_hybrid = (_DETECT_BACKEND in ("hybrid","ovonly")) or (req.ov_labels and len(req.ov_labels)>0)
        if use_hybrid:
            labels = req.ov_labels or _HYBRID_LABELS
            if _DETECT_BACKEND == 'ovonly':
                boxes = []
            if labels:
                ovb = _ov_detect(img2 if 'img2' in locals() else img, labels, threshold=max(0.10, thr-0.05))
                if boxes:
                    boxes = _merge_nms(boxes, ovb, iou_thr=0.5)
                else:
                    boxes = ovb
    except Exception as e:
        print("[realtime] detection error:", e)
        boxes = _detect_fallback(img, req.classes)
    # Debug summary
    try:
        lab_counts = {}
        for b in boxes:
            lbl = str(b.get('label') or '')
            if lbl:
                lab_counts[lbl] = lab_counts.get(lbl, 0) + 1
        top = sorted(lab_counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
        print(f"[realtime][DETECT] thr={thr} size={size} classes={req.classes or 'ALL'} backend={_DETECT_BACKEND} ov={bool(req.ov_labels)} -> {len(boxes)} boxes; top: {top}")
    except Exception:
        pass
    return {"boxes": boxes}


class RTSegmentRequest(BaseModel):
    image: str
    threshold: float | None = None
    img_size: int | None = None


@app.post("/realtime/segment")
def realtime_segment(req: RTSegmentRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {"instances": []}

    # Ensure models are considered
    if not _HAVE_YOLO_SEG:
        _lazy_load_yolo_seg()

    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ

    # If seg model missing, approximate via DET boxes
    if not _HAVE_YOLO_SEG:
        try:
            if not _HAVE_YOLO_DET:
                _lazy_load_yolo_det()
            if not _HAVE_YOLO_DET:
                return {"instances": []}
            img2 = _scale_image(img, max_side=size)
            rlist = _yolo_model_det.predict(img2, imgsz=size, conf=thr, verbose=False)
            if not rlist:
                return {"instances": []}
            r = rlist[0]
            names = getattr(r, 'names', {})
            W, H = img2.size
            xyxy = r.boxes.xyxy.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            conf = r.boxes.conf.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            cls = r.boxes.cls.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            instances = []
            for i, b in enumerate(xyxy):
                x1,y1,x2,y2 = b
                pts = [
                    {"x": max(0.0, min(1.0, x1/W)), "y": max(0.0, min(1.0, y1/H))},
                    {"x": max(0.0, min(1.0, x2/W)), "y": max(0.0, min(1.0, y1/H))},
                    {"x": max(0.0, min(1.0, x2/W)), "y": max(0.0, min(1.0, y2/H))},
                    {"x": max(0.0, min(1.0, x1/W)), "y": max(0.0, min(1.0, y2/H))},
                ]
                label = None
                if i < len(cls):
                    cid = int(cls[i])
                    label = str(names.get(cid, str(cid)))
                score = float(conf[i]) if i < len(conf) else None
                instances.append({"points": pts, **({"label": label} if label else {}), **({"score": score} if score is not None else {})})
            print(f"[realtime][SEG] fallback via DET: thr={thr} size={size} -> {len(instances)} polys")
            return {"instances": instances}
        except Exception as e:
            print("[realtime] segment fallback via detect error:", e)
            return {"instances": []}

    # Use segmentation model
    try:
        img2 = _scale_image(img, max_side=size)
        from ultralytics import YOLO  # type: ignore
        assert _yolo_model_seg is not None
        results = _yolo_model_seg.predict(img2, imgsz=size, conf=thr, verbose=False)
        if not results:
            return {"instances": []}
        r = results[0]
        names = r.names if hasattr(r, 'names') else {}
        W, H = img2.size
        instances: List[Dict[str, Any]] = []
        if getattr(r, 'masks', None) is not None and getattr(r.masks, 'xy', None) is not None:
            polys = r.masks.xy
            conf = r.boxes.conf.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            cls = r.boxes.cls.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            for i, poly in enumerate(polys):
                pts = []
                try:
                    for x, y in poly:
                        pts.append({"x": max(0.0, min(1.0, float(x) / W)),
                                    "y": max(0.0, min(1.0, float(y) / H))})
                except Exception:
                    continue
                label = None
                if i < len(cls):
                    cls_id = int(cls[i])
                    label = str(names.get(cls_id, str(cls_id)))
                score = float(conf[i]) if i < len(conf) else None
                instances.append({"points": pts, **({"label": label} if label else {}), **({"score": score} if score is not None else {})})
        else:
            # Build polygons from boxes if masks missing
            xyxy = r.boxes.xyxy.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            conf = r.boxes.conf.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            cls = r.boxes.cls.cpu().numpy().tolist() if getattr(r, 'boxes', None) is not None else []
            for i, b in enumerate(xyxy):
                x1,y1,x2,y2 = b
                pts = [
                    {"x": max(0.0, min(1.0, x1/W)), "y": max(0.0, min(1.0, y1/H))},
                    {"x": max(0.0, min(1.0, x2/W)), "y": max(0.0, min(1.0, y1/H))},
                    {"x": max(0.0, min(1.0, x2/W)), "y": max(0.0, min(1.0, y2/H))},
                    {"x": max(0.0, min(1.0, x1/W)), "y": max(0.0, min(1.0, y2/H))},
                ]
                label = None
                if i < len(cls):
                    cls_id = int(cls[i])
                    label = str(names.get(cls_id, str(cls_id)))
                score = float(conf[i]) if i < len(conf) else None
                instances.append({"points": pts, **({"label": label} if label else {}), **({"score": score} if score is not None else {})})
        print(f"[realtime][SEG] model=yes thr={thr} size={size} -> {len(instances)} instances")
        return {"instances": instances}
    except Exception as e:
        print("[realtime] segmentation error:", e)
        return {"instances": []}


class RTOBBRequest(BaseModel):
    image: str
    threshold: float | None = None
    img_size: int | None = None
    classes: list[str] | None = None


@app.post("/realtime/obb")
def realtime_obb(req: RTOBBRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {"obb": []}

    global _HAVE_YOLO_OBB, _yolo_model_obb
    if not _HAVE_YOLO_OBB:
        try:
            from ultralytics import YOLO  # type: ignore
            model_path = _canonicalize_model_spec(_CLI_OBB_MODEL_SPEC, 'obb')
            if not model_path:
                for p in (os.path.join(os.getcwd(), "yolov8n-obb.pt"), os.path.join(os.getcwd(), "yolo11n-obb.pt")):
                    if os.path.isfile(p):
                        model_path = p
                        break
            if not model_path:
                model_path = 'yolov8n-obb.pt'
            _yolo_model_obb = YOLO(model_path)
            _HAVE_YOLO_OBB = True
            print(f"[realtime] Loaded YOLO OBB model: {model_path}")
        except Exception as e:
            print("[realtime] OBB model unavailable:", e)
            _HAVE_YOLO_OBB = False

    if not _HAVE_YOLO_OBB:
        return {"obb": []}

    import math
    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
    try:
        img2 = _scale_image(img, max_side=size)
        rlist = _yolo_model_obb.predict(img2, imgsz=size, conf=thr, verbose=False)
        if not rlist:
            rlist = []
        out = []
        names = {}
        W, H = img2.size
        if rlist:
            r = rlist[0]
            names = getattr(r, 'names', {})
            obb_attr = getattr(r, 'obb', None)
        else:
            obb_attr = None
        # Prefer polygon form if present
        if obb_attr is not None:
            polys = getattr(obb_attr, 'xyxyxyxy', None)
            conf = getattr(r, 'boxes', None)
            conf = getattr(conf, 'conf', None) if conf is not None else None
            cls = getattr(r, 'boxes', None)
            cls = getattr(cls, 'cls', None) if cls is not None else None
        else:
            polys = None
            conf = None
            cls = None
        if polys is not None:
            xyxyxyxy = polys.cpu().numpy().tolist()
            confarr = conf.cpu().numpy().tolist() if conf is not None else []
            clsarr = cls.cpu().numpy().tolist() if cls is not None else []
            for i, pts8 in enumerate(xyxyxyxy):
                # pts8 might be [x1,y1,x2,y2,x3,y3,x4,y4] or [[x1,y1],...]
                flat = []
                if all(isinstance(v, (int, float)) for v in pts8):
                    flat = pts8
                else:
                    for pair in pts8:
                        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                            flat.extend([pair[0], pair[1]])
                pts = []
                for j in range(0, len(flat), 2):
                    try:
                        x = float(flat[j]) / W
                        y = float(flat[j+1]) / H
                    except Exception:
                        continue
                    pts.append({"x": max(0.0, min(1.0, x)), "y": max(0.0, min(1.0, y))})
                label = None
                if i < len(clsarr):
                    cid_raw = clsarr[i]
                    cid = int(cid_raw[0] if isinstance(cid_raw, (list, tuple)) else cid_raw)
                    label = str(names.get(cid, str(cid)))
                sc = None
                if i < len(confarr):
                    c_raw = confarr[i]
                    try:
                        sc = float(c_raw[0] if isinstance(c_raw, (list, tuple)) else c_raw)
                    except Exception:
                        sc = None
                item = {"points": pts, **({"label": label} if label else {}), **({"score": sc} if sc is not None else {})}
                out.append(item)
        # Else convert from xywhr (center x,y width,height, rotation radians)
        xywhr = getattr(obb_attr, 'xywhr', None) if obb_attr is not None else None
        confarr = conf.cpu().numpy().tolist() if conf is not None else []
        clsarr = cls.cpu().numpy().tolist() if cls is not None else []
        if xywhr is not None:
            arr = xywhr.cpu().numpy().tolist()
            for i, vals in enumerate(arr):
                if not isinstance(vals, (list, tuple)) or len(vals) < 5:
                    continue
                cx, cy, w, h, rad = vals[:5]
                cx_n, cy_n = cx / W, cy / H
                hw, hh = (w / W)/2.0, (h / H)/2.0
                c, s = math.cos(rad), math.sin(rad)
                corners = [(-hw,-hh), (hw,-hh), (hw,hh), (-hw,hh)]
                pts = []
                for (dx, dy) in corners:
                    x = cx_n + dx * c - dy * s
                    y = cy_n + dx * s + dy * c
                    pts.append({"x": max(0.0, min(1.0, x)), "y": max(0.0, min(1.0, y))})
                label = None
                if i < len(clsarr):
                    cid_raw = clsarr[i]
                    cid = int(cid_raw[0] if isinstance(cid_raw, (list, tuple)) else cid_raw)
                    label = str(names.get(cid, str(cid)))
                sc = None
                if i < len(confarr):
                    c_raw = confarr[i]
                    try:
                        sc = float(c_raw[0] if isinstance(c_raw, (list, tuple)) else c_raw)
                    except Exception:
                        sc = None
                item = {"points": pts, **({"label": label} if label else {}), **({"score": sc} if sc is not None else {})}
                out.append(item)
        # If empty or too few, optionally backfill with DET boxes as polygons to resemble detect behavior
        if not out or len(out) < 2:
            try:
                if not _HAVE_YOLO_DET:
                    _lazy_load_yolo_det()
                if _HAVE_YOLO_DET:
                    dr = _yolo_model_det.predict(img2, imgsz=size, conf=thr, verbose=False)
                    if dr:
                        r2 = dr[0]
                        names2 = getattr(r2, 'names', {})
                        xyxy2 = r2.boxes.xyxy.cpu().numpy().tolist() if getattr(r2, 'boxes', None) is not None else []
                        conf2 = r2.boxes.conf.cpu().numpy().tolist() if getattr(r2, 'boxes', None) is not None else []
                        cls2 = r2.boxes.cls.cpu().numpy().tolist() if getattr(r2, 'boxes', None) is not None else []
                        for i, b in enumerate(xyxy2):
                            x1,y1,x2,y2 = b
                            pts = [
                                {"x": max(0.0, min(1.0, x1/W)), "y": max(0.0, min(1.0, y1/H))},
                                {"x": max(0.0, min(1.0, x2/W)), "y": max(0.0, min(1.0, y1/H))},
                                {"x": max(0.0, min(1.0, x2/W)), "y": max(0.0, min(1.0, y2/H))},
                                {"x": max(0.0, min(1.0, x1/W)), "y": max(0.0, min(1.0, y2/H))},
                            ]
                            label = None
                            if i < len(cls2):
                                cid = int(cls2[i])
                                label = str(names2.get(cid, str(cid)))
                            score = float(conf2[i]) if i < len(conf2) else None
                            out.append({"points": pts, **({"label": label} if label else {}), **({"score": score} if score is not None else {})})
            except Exception as e:
                print("[realtime] OBB backfill via detect error:", e)

        # Optional filtering by classes
        if req.classes:
            allow = {str(x).strip().lower() for x in req.classes}
            out = [o for o in out if o.get('label') and str(o['label']).strip().lower() in allow]
        try:
            print(f"[realtime][OBB] model={'yes' if _HAVE_YOLO_OBB else 'no'} thr={thr} size={size} cls={req.classes or 'ALL'} -> {len(out)} polys")
        except Exception:
            pass
        return {"obb": out}
    except Exception as e:
        print("[realtime] obb error:", e)
        return {"obb": []}


class RTPoseRequest(BaseModel):
    image: str
    img_size: int | None = None


@app.post("/realtime/pose")
def realtime_pose(req: RTPoseRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {"poses": []}

    global _HAVE_YOLO_POSE, _yolo_model_pose
    if not _HAVE_YOLO_POSE:
        try:
            from ultralytics import YOLO  # type: ignore
            model_path = _canonicalize_model_spec(_CLI_POSE_MODEL_SPEC, 'pose')
            if not model_path:
                # try local defaults
                for p in (os.path.join(os.getcwd(), "yolov8n-pose.pt"), os.path.join(os.getcwd(), "yolo11n-pose.pt")):
                    if os.path.isfile(p):
                        model_path = p
                        break
            if not model_path:
                model_path = 'yolov8n-pose.pt'
            _yolo_model_pose = YOLO(model_path)
            _HAVE_YOLO_POSE = True
            print(f"[realtime] Loaded YOLO POSE model: {model_path}")
        except Exception as e:
            print("[realtime] pose model unavailable:", e)
            _HAVE_YOLO_POSE = False

    if not _HAVE_YOLO_POSE:
        return {"poses": []}

    try:
        size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
        img2 = _scale_image(img, max_side=size)
        rlist = _yolo_model_pose.predict(img2, imgsz=size, verbose=False)
        if not rlist:
            return {"poses": []}
        r = rlist[0]
        W, H = img2.size
        poses = []
        kp = getattr(r, 'keypoints', None)
        if kp is None:
            return {"poses": []}
        # Prefer normalized if available
        xyn = getattr(kp, 'xyn', None)
        xy = getattr(kp, 'xy', None)
        conf = getattr(kp, 'conf', None)
        if xyn is not None:
            kparr = xyn.cpu().numpy().tolist()
            confarr = conf.cpu().numpy().tolist() if conf is not None else None
            for i, one in enumerate(kparr):
                pts = []
                for j, (x, y) in enumerate(one):
                    c = confarr[i][j] if confarr is not None else None
                    pts.append({"x": float(x), "y": float(y), **({"conf": float(c)} if c is not None else {})})
                poses.append({"keypoints": pts})
        elif xy is not None:
            kparr = xy.cpu().numpy().tolist()
            confarr = conf.cpu().numpy().tolist() if conf is not None else None
            for i, one in enumerate(kparr):
                pts = []
                for j, (x, y) in enumerate(one):
                    c = confarr[i][j] if confarr is not None else None
                    pts.append({"x": float(x)/W, "y": float(y)/H, **({"conf": float(c)} if c is not None else {})})
                poses.append({"keypoints": pts})
        try:
            avg_kp = sum(len(p.get('keypoints', [])) for p in poses) / max(1, len(poses))
            print(f"[realtime][POSE] size={size} -> poses={len(poses)} avg_kp={avg_kp:.1f}")
        except Exception:
            pass
        return {"poses": poses}
    except Exception as e:
        print("[realtime] pose error:", e)
        return {"poses": []}


class RTClassifyRequest(BaseModel):
    image: str
    top_k: int | None = None
    img_size: int | None = None


@app.post("/realtime/classify")
def realtime_classify(req: RTClassifyRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {"classes": []}

    global _HAVE_YOLO_CLS, _yolo_model_cls
    if not _HAVE_YOLO_CLS:
        try:
            from ultralytics import YOLO  # type: ignore
            model_path = _canonicalize_model_spec(_CLI_CLS_MODEL_SPEC, 'cls')
            if not model_path:
                for p in (os.path.join(os.getcwd(), "yolov8n-cls.pt"), os.path.join(os.getcwd(), "yolo11n-cls.pt")):
                    if os.path.isfile(p):
                        model_path = p
                        break
            if not model_path:
                model_path = 'yolov8n-cls.pt'
            _yolo_model_cls = YOLO(model_path)
            _HAVE_YOLO_CLS = True
            print(f"[realtime] Loaded YOLO CLS model: {model_path}")
        except Exception as e:
            print("[realtime] cls model unavailable:", e)
            _HAVE_YOLO_CLS = False

    if not _HAVE_YOLO_CLS:
        return {"classes": []}

    try:
        size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
        img2 = _scale_image(img, max_side=size)
        rlist = _yolo_model_cls.predict(img2, imgsz=size, verbose=False)
        if not rlist:
            return {"classes": []}
        r = rlist[0]
        # Ultralytics classification returns probabilities via r.probs
        probs = getattr(r, 'probs', None)
        names = getattr(r, 'names', None)
        if probs is None or names is None:
            return {"classes": []}
        try:
            topk = int(req.top_k) if req.top_k else 5
        except Exception:
            topk = 5
        # Prefer built-in top5 indices and confidences if present
        idxs = getattr(probs, 'top5', None)
        confs = getattr(probs, 'top5conf', None)
        if idxs is None or confs is None:
            # Fallback: sort full probability vector
            data = getattr(probs, 'data', None)
            if data is None:
                return {"classes": []}
            import numpy as np
            npv = data.cpu().numpy().astype(float)
            order = np.argsort(npv)[::-1][:topk]
            classes = [{"label": str(names.get(int(i), str(i))), "score": float(npv[i])} for i in order]
            return {"classes": classes}
        # Use provided top5 and top5conf
        idxs_list = [int(i) for i in (idxs if isinstance(idxs, (list, tuple)) else idxs.tolist())]
        confs_list = [float(c) for c in (confs if isinstance(confs, (list, tuple)) else confs.cpu().numpy().tolist())]
        pairs = list(zip(idxs_list, confs_list))[:topk]
        classes = [{"label": str(names.get(i, str(i))), "score": s} for i, s in pairs]
        try:
            print(f"[realtime][CLS] size={size} top={classes[:5]}")
        except Exception:
            pass
        return {"classes": classes}
    except Exception as e:
        print("[realtime] classify error:", e)
        return {"classes": []}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="YOLO realtime vision server (detect/segment)")
    parser.add_argument("--model", type=str, default=None, help="Detection model path or alias (v8n, v8s, v11n, v11s, yolov8n.pt, yolo11n.pt, or path to .pt)")
    parser.add_argument("--seg-model", type=str, default=None, help="Segmentation model path or alias (v8n-seg, v11n-seg, yolov8n-seg.pt, yolo11n-seg.pt, or path)")
    parser.add_argument("--obb-model", type=str, default=None, help="Oriented bounding box model alias/path (v8n-obb, v11n-obb, yolov8n-obb.pt, yolo11n-obb.pt, or path)")
    parser.add_argument("--port", type=int, default=_DEFAULT_PORT, help=f"HTTP port (default {_DEFAULT_PORT})")
    parser.add_argument("--imgsz", type=int, default=_DEFAULT_IMGSZ, help=f"Default imgsz for server-side downscale (default {_DEFAULT_IMGSZ})")
    parser.add_argument("--threshold", type=float, default=_DEFAULT_THRESH, help=f"Default confidence threshold (default {_DEFAULT_THRESH})")
    parser.add_argument("--pose-model", type=str, default=None, help="Pose model alias/path (v8n-pose, v11n-pose, yolov8n-pose.pt, yolo11n-pose.pt, or path)")
    parser.add_argument("--cls-model", type=str, default=None, help="Classification model alias/path (v8n-cls, v11n-cls, yolov8n-cls.pt, yolo11n-cls.pt, or path)")
    parser.add_argument("--device", type=str, default=_DEVICE, choices=['auto','cpu','mps','cuda'], help="Inference device")
    parser.add_argument("--detect-backend", type=str, default=_DETECT_BACKEND, choices=['yolov','hybrid','ovonly'], help="Detection backend")
    parser.add_argument("--hybrid-labels", type=str, default=','.join(_HYBRID_LABELS), help="Comma-separated open-vocab labels used in hybrid detect")
    args = parser.parse_args()

    # Apply CLI defaults/globals
    _CLI_MODEL_SPEC = args.model
    _CLI_SEG_MODEL_SPEC = args.seg_model
    _CLI_OBB_MODEL_SPEC = args.obb_model
    _CLI_POSE_MODEL_SPEC = args.pose_model
    _CLI_CLS_MODEL_SPEC = args.cls_model
    _DEFAULT_PORT = int(args.port)
    _DEFAULT_IMGSZ = int(args.imgsz)
    _DEFAULT_THRESH = float(args.threshold)
    _DEVICE = args.device
    _DETECT_BACKEND = args.detect_backend
    _HYBRID_LABELS = [s.strip() for s in (args.hybrid_labels or '').split(',') if s.strip()]

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=_DEFAULT_PORT)
