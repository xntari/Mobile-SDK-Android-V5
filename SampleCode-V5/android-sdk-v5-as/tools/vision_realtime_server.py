#!/usr/bin/env python3
"""
Realtime vision server using Ultralytics YOLO‑E only.

Endpoints
- POST /realtime/detect  { image, ov_labels?, threshold?, img_size? }
  -> { boxes: [{x1,y1,x2,y2,score?,label?}] }
  - With ov_labels: open‑vocab mode (set textual classes)
  - Without ov_labels: prompt‑free model (‑pf) “detect everything”

- POST /realtime/segment { image, threshold?, img_size? }
  -> { instances: [{points:[{x,y}...], score?, label?}] }
  - Uses prompt‑free YOLO‑E; returns masks polygons if available, else box quads

- POST /realtime/prompt  { image, boxes:[{x1,y1,x2,y2}], ov_labels?, threshold?, img_size? }
  -> { boxes: [{x1,y1,x2,y2,score?,label?}] }
  - Visual prompt: tries native prompt API, else crops per box and refines

- POST /realtime/classify { image, top_k?, img_size? }
  -> { classes: [{label, score}] }
  - Derives classes from prompt‑free detections by aggregating scores per label

Run
  python -m venv .venv && source .venv/bin/activate
  pip install fastapi uvicorn pillow ultralytics
  python tools/vision_realtime_server.py --ov-model yoloe-11s-seg.pt (small)
  python tools/vision_realtime_server.py --ov-model yoloe-11m-seg.pt (medium)
  python tools/vision_realtime_server.py --ov-model yoloe-11l-seg.pt (large)
"""
from __future__ import annotations

from typing import List, Dict, Any, Optional
import base64
import io
import os

from fastapi import FastAPI, Request
import tempfile
import numpy as np  # type: ignore
from fastapi.middleware.cors import CORSMiddleware
import ultralytics as _ultra  # type: ignore
from pydantic import BaseModel
from PIL import Image

import argparse


# ------------------------- Server config -------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_DEFAULT_PORT: int = int(os.environ.get("REALTIME_PORT", "9004"))
_DEFAULT_IMGSZ: int = int(os.environ.get("Y_IMGSZ", "640"))
_DEFAULT_THRESH: float = float(os.environ.get("Y_THRESH", "0.25"))
_DEVICE: str = os.environ.get("Y_DEVICE", "auto")  # 'auto' | 'cpu' | 'mps' | 'cuda'

_CLI_OV_MODEL_SPEC: Optional[str] = None
_HAVE_YOLOE: bool = False
_yoloe_model = None
_YOLOE_API: str = 'unknown'  # 'YOLOE' or 'YOLO'
_ULTRA_VER: str = getattr(_ultra, '__version__', 'unknown')
_HAVE_YOLOE_PF: bool = False
_yoloe_pf_model = None

# Per-session display ID mapping: track_id -> per-class small id
_DISPLAY_MAP: Dict[str, Dict[str, Dict[str, Any]]] = {}

def _display_id_for(sid: str, cls_name: str, track_id: Optional[int]) -> Optional[int]:
    if track_id is None:
        return None
    sess = _DISPLAY_MAP.setdefault(sid, {})
    entry = sess.setdefault(cls_name, {'map': {}, 'next': 0})
    m = entry['map']
    if track_id in m:
        return int(m[track_id])
    did = int(entry['next'])
    entry['next'] = did + 1
    m[track_id] = did
    return did

# Simple per-session segmentation tracker using IoU over polygon bboxes
_SEG_TRACKERS: Dict[str, Dict[str, Any]] = {}

def _bbox_from_pts(pts: List[Dict[str, float]]):
    xs = [float(p['x']) for p in pts]; ys = [float(p['y']) for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))

def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a; bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1); iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1); ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0: return 0.0
    aw = max(0.0, ax2 - ax1); ah = max(0.0, ay2 - ay1)
    bw = max(0.0, bx2 - bx1); bh = max(0.0, by2 - by1)
    union = aw*ah + bw*bh - inter
    return inter/union if union > 0 else 0.0

def _assign_seg_ids(sid: str, instances: List[Dict[str, Any]], iou_thr: float = 0.5) -> List[Dict[str, Any]]:
    state = _SEG_TRACKERS.setdefault(sid, {})  # {class: {next:int, tracks:[{id,bbox}]}}
    # Prepare current
    curr = []
    for ins in instances:
        pts = ins.get('points') or []
        if not pts: continue
        lbl = str(ins.get('label') or 'obj')
        bb = _bbox_from_pts(pts)
        curr.append({'label': lbl, 'bbox': bb, 'ref': ins})
    # Match per class
    for lbl in {c['label'] for c in curr}:
        cls_state = state.setdefault(lbl, {'next': 0, 'tracks': []})
        tracks = cls_state['tracks']
        used = set()
        for det in [c for c in curr if c['label'] == lbl]:
            best, bi = 0.0, -1
            for i, tr in enumerate(tracks):
                if i in used: continue
                val = _iou(det['bbox'], tr['bbox'])
                if val > best: best, bi = val, i
            if bi >= 0 and best >= iou_thr:
                tr = tracks[bi]; used.add(bi)
                tr['bbox'] = det['bbox']
                det['ref']['label'] = f"{lbl}_{tr['id']}"
            else:
                tid = cls_state['next']; cls_state['next'] = tid + 1
                tracks.append({'id': tid, 'bbox': det['bbox']})
                det['ref']['label'] = f"{lbl}_{tid}"
        cls_state['tracks'] = tracks[:50]
        state[lbl] = cls_state
    _SEG_TRACKERS[sid] = state
    return instances

# ------------------------- Utils -------------------------
def decode_image_to_pil(image_b64_or_dataurl: str) -> Image.Image:
    data = image_b64_or_dataurl
    if data.startswith("data:"):
        _, b64 = data.split(",", 1)
    else:
        b64 = data
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _canonicalize_model_spec(spec: Optional[str]) -> Optional[str]:
    if not spec:
        return None
    s = spec.strip()
    if os.path.isfile(s):
        return s
    alias = {
        'yoloe': 'yoloe.pt',
        'yoloe-n': 'yoloe-n.pt', 'yoloe_s': 'yoloe_s.pt', 'yoloe-s': 'yoloe-s.pt',
        'yoloe-m': 'yoloe-m.pt', 'yoloe_l': 'yoloe_l.pt', 'yoloe-l': 'yoloe-l.pt',
        'yoloe-x': 'yoloe-x.pt',
        # 11-series examples
        'yoloe-11s-seg': 'yoloe-11s-seg.pt', 'yoloe-11s-det': 'yoloe-11s-det.pt',
    }
    if s.lower() in alias:
        return alias[s.lower()]
    if not s.lower().endswith('.pt'):
        return s + '.pt'
    return s


def _derive_pf_spec(spec: str) -> str:
    # Insert "-pf" before extension when missing
    try:
        base, ext = os.path.splitext(spec)
        if base.endswith('-pf'):
            return spec
        if base.endswith('-seg'):
            return f"{base}-pf{ext or '.pt'}"
        return f"{base}-pf{ext or '.pt'}"
    except Exception:
        return spec


def _scale_image(img: Image.Image, max_side: int) -> Image.Image:
    if max(img.size) <= max_side:
        return img
    scale = max_side / max(img.size)
    new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    return img.resize(new_size)


# ------------------------- YOLO‑E loaders -------------------------
def _lazy_load_yoloe():
    global _HAVE_YOLOE, _yoloe_model
    if _HAVE_YOLOE:
        return
    try:
        # Prefer the dedicated YOLOE class per docs; fallback to YOLO
        YOLOEClass = None
        try:
            from ultralytics import YOLOE as YOLOEClass  # type: ignore
        except Exception:
            YOLOEClass = None
        from ultralytics import YOLO  # type: ignore
        model_spec = _canonicalize_model_spec(_CLI_OV_MODEL_SPEC or os.environ.get("YOLOE_MODEL"))
        if not model_spec:
            model_spec = 'yoloe.pt'
        if YOLOEClass is not None:
            _yoloe_model = YOLOEClass(model_spec)
            api = 'YOLOE'
        else:
            _yoloe_model = YOLO(model_spec)
            api = 'YOLO'
        try:
            if _DEVICE in ("mps", "cuda"):
                _yoloe_model.to(_DEVICE)
        except Exception:
            pass
        _HAVE_YOLOE = True
        globals()['_YOLOE_API'] = api
        print(f"[realtime] YOLO‑E loaded: {model_spec} api={api} ultralytics={_ULTRA_VER}")
    except Exception as e:
        print('[realtime] yoloe load failed:', e)
        _HAVE_YOLOE = False


def _lazy_load_yoloe_pf():
    global _HAVE_YOLOE_PF, _yoloe_pf_model
    if _HAVE_YOLOE_PF:
        return
    try:
        from ultralytics import YOLO  # type: ignore
        base_spec = _canonicalize_model_spec(_CLI_OV_MODEL_SPEC or os.environ.get("YOLOE_MODEL")) or 'yoloe.pt'
        pf_spec = _derive_pf_spec(base_spec)
        _yoloe_pf_model = YOLO(pf_spec)
        try:
            if _DEVICE in ("mps", "cuda"):
                _yoloe_pf_model.to(_DEVICE)
        except Exception:
            pass
        _HAVE_YOLOE_PF = True
        print(f"[realtime] YOLO‑E PF loaded: {pf_spec}")
    except Exception as e:
        print('[realtime] yoloe‑pf load failed:', e)
        _HAVE_YOLOE_PF = False


# ------------------------- Inference helpers -------------------------
def _safe_predict(model, img: Image.Image, imgsz: int, conf: float, extra: Optional[Dict[str, Any]] = None):
    extra = extra or {}
    try:
        return model.predict(img, imgsz=imgsz, conf=conf, verbose=False, **extra)  # type: ignore
    except Exception as e:
        print('[realtime] predict failed:', e)
        # Try without imgsz as a fallback
        try:
            return model.predict(img, conf=conf, verbose=False, **extra)  # type: ignore
        except Exception as e2:
            print('[realtime] predict retry failed:', e2)
            return None


def _parse_boxes(result, W: int, H: int, names: Any, ov_labels: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    boxes = []
    b = getattr(result, 'boxes', None)
    if b is None or getattr(b, 'xyxy', None) is None:
        return boxes
    xyxy = b.xyxy.cpu().numpy().tolist()
    conf = b.conf.cpu().numpy().tolist() if getattr(b, 'conf', None) is not None else []
    cls = b.cls.cpu().numpy().tolist() if getattr(b, 'cls', None) is not None else []

    def name_for(idx: Optional[int]) -> Optional[str]:
        if idx is None:
            return None
        try:
            if isinstance(names, dict) and idx in names:
                return str(names[idx])
            if isinstance(names, (list, tuple)) and 0 <= idx < len(names):
                return str(names[idx])
        except Exception:
            pass
        if ov_labels and 0 <= idx < len(ov_labels):
            return str(ov_labels[idx])
        return None

    for i, p in enumerate(xyxy):
        try:
            x1, y1, x2, y2 = p
        except Exception:
            continue
        sc = float(conf[i]) if i < len(conf) else None
        cid = None
        if i < len(cls):
            try:
                raw = cls[i]
                cid = int(raw[0] if isinstance(raw, (list, tuple)) else raw)
            except Exception:
                cid = None
        lbl = name_for(cid)
        boxes.append({
            'x1': max(0.0, min(1.0, float(x1) / W)),
            'y1': max(0.0, min(1.0, float(y1) / H)),
            'x2': max(0.0, min(1.0, float(x2) / W)),
            'y2': max(0.0, min(1.0, float(y2) / H)),
            **({'score': sc} if sc is not None else {}),
            **({'label': lbl} if lbl else {}),
        })
    boxes.sort(key=lambda d: d.get('score', 0) or 0, reverse=True)
    return boxes[:100]


def _parse_masks(result, W: int, H: int, names: Any) -> List[Dict[str, Any]]:
    out = []
    m = getattr(result, 'masks', None)
    b = getattr(result, 'boxes', None)
    polys = getattr(m, 'xy', None) if m is not None else None
    conf = b.conf.cpu().numpy().tolist() if b is not None and getattr(b, 'conf', None) is not None else []
    cls = b.cls.cpu().numpy().tolist() if b is not None and getattr(b, 'cls', None) is not None else []
    if polys is None:
        # build quads from boxes
        if b is None or getattr(b, 'xyxy', None) is None:
            return out
        xyxy = b.xyxy.cpu().numpy().tolist()
        for i, bb in enumerate(xyxy):
            try:
                x1, y1, x2, y2 = bb
            except Exception:
                continue
            pts = [
                {'x': max(0.0, min(1.0, x1 / W)), 'y': max(0.0, min(1.0, y1 / H))},
                {'x': max(0.0, min(1.0, x2 / W)), 'y': max(0.0, min(1.0, y1 / H))},
                {'x': max(0.0, min(1.0, x2 / W)), 'y': max(0.0, min(1.0, y2 / H))},
                {'x': max(0.0, min(1.0, x1 / W)), 'y': max(0.0, min(1.0, y2 / H))},
            ]
            sc = float(conf[i]) if i < len(conf) else None
            lbl = None
            if i < len(cls):
                try:
                    cid = int(cls[i])
                    if isinstance(names, dict) and cid in names:
                        lbl = str(names[cid])
                    elif isinstance(names, (list, tuple)) and 0 <= cid < len(names):
                        lbl = str(names[cid])
                except Exception:
                    lbl = None
            out.append({'points': pts, **({'score': sc} if sc is not None else {}), **({'label': lbl} if lbl else {})})
        return out[:100]

    # masks polygons
    for i, poly in enumerate(polys):
        pts = []
        try:
            for x, y in poly:
                pts.append({'x': max(0.0, min(1.0, float(x) / W)), 'y': max(0.0, min(1.0, float(y) / H))})
        except Exception:
            continue
        sc = float(conf[i]) if i < len(conf) else None
        lbl = None
        if i < len(cls):
            try:
                cid = int(cls[i])
                if isinstance(names, dict) and cid in names:
                    lbl = str(names[cid])
                elif isinstance(names, (list, tuple)) and 0 <= cid < len(names):
                    lbl = str(names[cid])
            except Exception:
                lbl = None
        out.append({'points': pts, **({'score': sc} if sc is not None else {}), **({'label': lbl} if lbl else {})})
    out.sort(key=lambda d: d.get('score', 0) or 0, reverse=True)
    return out[:100]


# (Removed custom tracker) — we will use Ultralytics built‑in tracking (model.track) for IDs


# ------------------------- Schemas -------------------------
class RTDetectRequest(BaseModel):
    image: str
    threshold: float | None = None
    img_size: int | None = None
    ov_labels: list[str] | None = None


class RTSegmentRequest(BaseModel):
    image: str
    threshold: float | None = None
    img_size: int | None = None
    ov_labels: list[str] | None = None


class RTPromptDetectRequest(BaseModel):
    image: str
    boxes: List[Dict[str, float]]  # [{x1,y1,x2,y2}] normalized
    threshold: float | None = None
    img_size: int | None = None
    ov_labels: list[str] | None = None


class RTClassifyRequest(BaseModel):
    image: str
    top_k: int | None = None
    img_size: int | None = None


# ------------------------- Routes -------------------------
@app.post('/realtime/detect')
def realtime_detect(req: RTDetectRequest, request: Request):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {'boxes': []}
    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
    img2 = _scale_image(img, size)

    use_pf = not (req.ov_labels and len(req.ov_labels) > 0)
    boxes: List[Dict[str, Any]] = []
    try:
        if use_pf:
            if not _HAVE_YOLOE_PF:
                _lazy_load_yoloe_pf()
            if not _HAVE_YOLOE_PF:
                return {'boxes': []}
            res = _safe_predict(_yoloe_pf_model, img2, size, thr)
        else:
            if not _HAVE_YOLOE:
                _lazy_load_yoloe()
            if not _HAVE_YOLOE:
                return {'boxes': []}
            # set textual classes and single predict per docs
            try:
                if hasattr(_yoloe_model, 'set_classes') and req.ov_labels:
                    _yoloe_model.set_classes(req.ov_labels)  # type: ignore
            except Exception as e:
                print('[realtime] yolo-e set_classes failed:', e)
            res = _safe_predict(_yoloe_model, img2, size, thr)
        if res:
            # Use Ultralytics built‑in tracker to get IDs
            try:
                # Track with ByteTrack; persist=True keeps internal tracker state
                from ultralytics import YOLO  # type: ignore
                model = _yoloe_pf_model if use_pf else _yoloe_model
                if not model:
                    raise RuntimeError('model not loaded')
                # For OV, ensure classes are set before tracking as well
                if (not use_pf) and req.ov_labels:
                    try:
                        if hasattr(model, 'set_classes'):
                            model.set_classes(req.ov_labels)  # type: ignore
                    except Exception:
                        pass
                track_res = model.track(img2, imgsz=size, conf=thr, verbose=False, persist=True, tracker='botsort-reid.yaml')  # type: ignore
                if track_res:
                    r = track_res[0]
                else:
                    r = res[0]
            except Exception:
                # Fallback to predict result if track not available
                r = res[0]
            W, H = img2.size
            names = getattr(r, 'names', {})
            b = getattr(r, 'boxes', None)
            boxes = []
            if b is not None and getattr(b, 'xyxy', None) is not None:
                xyxy = b.xyxy.cpu().numpy().tolist()
                conf = b.conf.cpu().numpy().tolist() if getattr(b, 'conf', None) is not None else []
                cls = b.cls.cpu().numpy().tolist() if getattr(b, 'cls', None) is not None else []
                ids_raw = getattr(b, 'id', None)
                ids = []
                if ids_raw is not None:
                    try:
                        ids = ids_raw.int().cpu().numpy().tolist()
                        # flatten Nx1
                        ids = [int(v[0] if isinstance(v, (list, tuple)) else v) for v in ids]
                    except Exception:
                        ids = []
                for i, p in enumerate(xyxy):
                    try:
                        x1,y1,x2,y2 = p
                    except Exception:
                        continue
                    sc = float(conf[i]) if i < len(conf) else None
                    cid = None
                    if i < len(cls):
                        try:
                            raw = cls[i]
                            cid = int(raw[0] if isinstance(raw,(list,tuple)) else raw)
                        except Exception:
                            cid = None
                    # Resolve label name
                    lbl = None
                    try:
                        if isinstance(names, dict) and isinstance(cid, int) and cid in names:
                            lbl = str(names[cid])
                        elif isinstance(names, (list, tuple)) and isinstance(cid, int) and 0 <= cid < len(names):
                            lbl = str(names[cid])
                    except Exception:
                        lbl = None
                    if (not use_pf) and req.ov_labels and isinstance(cid, int) and 0 <= cid < len(req.ov_labels):
                        lbl = str(req.ov_labels[cid])
                    # Append per-class display id based on tracker id
                    tid = ids[i] if i < len(ids) else None
                    if tid is not None and lbl:
                        sid = request.headers.get('x-client-session') or 'no-sid'
                        disp = _display_id_for(sid, lbl, tid)
                        if disp is not None:
                            lbl = f"{lbl}_{disp}"
                    boxes.append({
                        'x1': max(0.0, min(1.0, float(x1)/W)),
                        'y1': max(0.0, min(1.0, float(y1)/H)),
                        'x2': max(0.0, min(1.0, float(x2)/W)),
                        'y2': max(0.0, min(1.0, float(y2)/H)),
                        **({'score': sc} if sc is not None else {}),
                        **({'label': lbl} if lbl else {}),
                        **({'track_id': tid} if tid is not None else {}),
                    })
        # No fallbacks in detect path
    except Exception as e:
        print('[realtime] detect error:', e)
    try:
        lab_counts = {}
        for b in boxes:
            lbl = str(b.get('label') or '')
            if lbl:
                lab_counts[lbl] = lab_counts.get(lbl, 0) + 1
        top = sorted(lab_counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
        sid = request.headers.get('x-client-session') or 'no-sid'
        print(f"[realtime][DETECT][sid={sid}] thr={thr} size={size} mode={'PF' if use_pf else 'OV'} labels={(req.ov_labels or [])} -> {len(boxes)} boxes; top: {top}")
    except Exception:
        pass
    return {'boxes': boxes}


@app.post('/realtime/segment')
def realtime_segment(req: RTSegmentRequest, request: Request):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {'instances': []}
    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
    img2 = _scale_image(img, size)
    try:
        use_pf = not (req.ov_labels and len(req.ov_labels) > 0)
        model = None
        if use_pf:
            if not _HAVE_YOLOE_PF:
                _lazy_load_yoloe_pf()
            if not _HAVE_YOLOE_PF:
                return {'instances': []}
            model = _yoloe_pf_model
        else:
            if not _HAVE_YOLOE:
                _lazy_load_yoloe()
            if not _HAVE_YOLOE:
                return {'instances': []}
            model = _yoloe_model
            try:
                if hasattr(model, 'set_classes') and req.ov_labels:
                    model.set_classes(req.ov_labels)  # type: ignore
            except Exception as e:
                print('[realtime] yolo-e set_classes failed:', e)

        # Use track() instead of predict() to get consistent tracking IDs
        try:
            # Track with ByteTrack + ReID for consistent IDs across detect/segment
            track_res = model.track(img2, imgsz=size, conf=thr, verbose=False, persist=True, tracker='botsort-reid.yaml')  # type: ignore
            if track_res:
                r = track_res[0]
            else:
                # Fallback to predict if track fails
                res = _safe_predict(model, img2, size, thr)
                if not res:
                    return {'instances': []}
                r = res[0]
        except Exception as e_track:
            print(f'[realtime] segment track failed ({e_track}), falling back to predict')
            # Fallback to predict without tracking
            res = _safe_predict(model, img2, size, thr)
            if not res:
                return {'instances': []}
            r = res[0]

        W, H = img2.size
        sid2 = request.headers.get('x-client-session') or 'no-sid'

        # Parse masks with tracking IDs if available
        instances = []
        m = getattr(r, 'masks', None)
        b = getattr(r, 'boxes', None)
        polys = getattr(m, 'xy', None) if m is not None else None
        conf = b.conf.cpu().numpy().tolist() if b is not None and getattr(b, 'conf', None) is not None else []
        cls = b.cls.cpu().numpy().tolist() if b is not None and getattr(b, 'cls', None) is not None else []
        names = getattr(r, 'names', {})

        # Get tracking IDs if available
        ids_raw = getattr(b, 'id', None) if b is not None else None
        ids = []
        if ids_raw is not None:
            try:
                ids = ids_raw.int().cpu().numpy().tolist()
                # flatten Nx1
                ids = [int(v[0] if isinstance(v, (list, tuple)) else v) for v in ids]
            except Exception:
                ids = []

        if polys is None:
            # Build quads from boxes
            if b is None or getattr(b, 'xyxy', None) is None:
                return {'instances': []}
            xyxy = b.xyxy.cpu().numpy().tolist()
            for i, bb in enumerate(xyxy):
                try:
                    x1, y1, x2, y2 = bb
                except Exception:
                    continue
                pts = [
                    {'x': max(0.0, min(1.0, x1 / W)), 'y': max(0.0, min(1.0, y1 / H))},
                    {'x': max(0.0, min(1.0, x2 / W)), 'y': max(0.0, min(1.0, y1 / H))},
                    {'x': max(0.0, min(1.0, x2 / W)), 'y': max(0.0, min(1.0, y2 / H))},
                    {'x': max(0.0, min(1.0, x1 / W)), 'y': max(0.0, min(1.0, y2 / H))},
                ]
                sc = float(conf[i]) if i < len(conf) else None
                lbl = None
                if i < len(cls):
                    try:
                        cid = int(cls[i])
                        if isinstance(names, dict) and cid in names:
                            lbl = str(names[cid])
                        elif isinstance(names, (list, tuple)) and 0 <= cid < len(names):
                            lbl = str(names[cid])
                    except Exception:
                        lbl = None
                # Use tracker ID for consistent labeling
                tid = ids[i] if i < len(ids) else None
                if tid is not None and lbl:
                    disp = _display_id_for(sid2, lbl, tid)
                    if disp is not None:
                        lbl = f"{lbl}_{disp}"
                instances.append({
                    'points': pts,
                    **({'score': sc} if sc is not None else {}),
                    **({'label': lbl} if lbl else {}),
                    **({'track_id': tid} if tid is not None else {})
                })
        else:
            # Masks polygons
            for i, poly in enumerate(polys):
                pts = []
                try:
                    for x, y in poly:
                        pts.append({'x': max(0.0, min(1.0, float(x) / W)), 'y': max(0.0, min(1.0, float(y) / H))})
                except Exception:
                    continue
                sc = float(conf[i]) if i < len(conf) else None
                lbl = None
                if i < len(cls):
                    try:
                        cid = int(cls[i])
                        if isinstance(names, dict) and cid in names:
                            lbl = str(names[cid])
                        elif isinstance(names, (list, tuple)) and 0 <= cid < len(names):
                            lbl = str(names[cid])
                    except Exception:
                        lbl = None
                # Use tracker ID for consistent labeling
                tid = ids[i] if i < len(ids) else None
                if tid is not None and lbl:
                    disp = _display_id_for(sid2, lbl, tid)
                    if disp is not None:
                        lbl = f"{lbl}_{disp}"
                instances.append({
                    'points': pts,
                    **({'score': sc} if sc is not None else {}),
                    **({'label': lbl} if lbl else {}),
                    **({'track_id': tid} if tid is not None else {})
                })

        instances.sort(key=lambda d: d.get('score', 0) or 0, reverse=True)
        instances = instances[:100]

        # No fallbacks in segmentation path
        try:
            print(f"[realtime][SEG][sid={sid2}] mode={'PF' if use_pf else 'OV'} thr={thr} size={size} labels={(req.ov_labels or [])} -> {len(instances)} instances")
        except Exception:
            pass
        return {'instances': instances}
    except Exception as e:
        print('[realtime] segment error:', e)
        return {'instances': []}


@app.post('/realtime/prompt')
def realtime_prompt(req: RTPromptDetectRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {'boxes': []}


class RTPromptImageRequest(BaseModel):
    image: str
    prompt_image: str
    threshold: float | None = None
    img_size: int | None = None


@app.post('/realtime/prompt_image')
def realtime_prompt_image(req: RTPromptImageRequest, request: Request):
    sid = request.headers.get('x-client-session') or 'no-sid'
    used_kw = 'none'
    pw = ph = 0
    out: List[Dict[str, Any]] = []
    try:
        try:
            img = decode_image_to_pil(req.image)
            prompt_img = decode_image_to_pil(req.prompt_image)
            pw, ph = prompt_img.size
        except Exception as e0:
            print(f"[realtime][PROMPT_IMG][sid={sid}] decode error: {e0}")
            return {'boxes': []}
        thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
        size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
        if not _HAVE_YOLOE:
            _lazy_load_yoloe()
        if not _HAVE_YOLOE:
            print(f"[realtime][PROMPT_IMG][sid={sid}] yolo-e not available")
            return {'boxes': []}
        # Write both target and prompt to temp files; predictor expects file paths
        target_tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg'); target_tmp.close()
        refer_tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg'); refer_tmp.close()
        # Do NOT downscale the target for prompt matching; keep original snapshot pixels
        img_to_save = img
        img_to_save.save(target_tmp.name, format='JPEG', quality=95)
        prompt_img.save(refer_tmp.name, format='JPEG', quality=95)
        res = None
        try:
            try:
                from ultralytics.models.yolo.yoloe.predict_vp import YOLOEVPSegPredictor  # type: ignore
                predictor_src = 'ultralytics.models.yolo.yoloe.predict_vp.YOLOEVPSegPredictor'
            except Exception:
                from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor  # type: ignore
                predictor_src = 'ultralytics.models.yolo.yoloe.YOLOEVPSegPredictor'
            vp = {
                'bboxes': np.array([[0.0, 0.0, float(pw), float(ph)]], dtype=np.float32),
                'cls': np.array([0], dtype=np.int64),
            }
            thr_vp = max(0.01, min(0.10, thr))
            try:
                tsz = os.path.getsize(target_tmp.name); rsz = os.path.getsize(refer_tmp.name)
                print(f"[realtime][PROMPT_IMG][sid={sid}] files target={target_tmp.name}({tsz}B) refer={refer_tmp.name}({rsz}B)")
            except Exception:
                pass
            print(f"[realtime][PROMPT_IMG][sid={sid}] predictor={predictor_src} ultralytics={_ULTRA_VER} api={_YOLOE_API} vp_cls={vp['cls'].tolist()} vp_box={vp['bboxes'].tolist()[0]}")
            res = _yoloe_model.predict(target_tmp.name, imgsz=size, conf=thr_vp, verbose=False, refer_image=refer_tmp.name, visual_prompts=vp, predictor=YOLOEVPSegPredictor)  # type: ignore
            used_kw = 'refer_image(file)+visual_prompts+YOLOEVPSegPredictor'
        except Exception as e_vp:
            try:
                # Fallback older APIs (less ideal)
                res = _yoloe_model.predict(target_tmp.name, imgsz=size, conf=thr, verbose=False, prompts={'images': [refer_tmp.name]})  # type: ignore
                used_kw = 'prompts.images(file)'
            except Exception as e1:
                try:
                    res = _yoloe_model.predict(target_tmp.name, imgsz=size, conf=thr, verbose=False, image_prompts=[refer_tmp.name])  # type: ignore
                    used_kw = 'image_prompts(file)'
                except Exception as e2:
                    used_kw = 'none'
                    res = _yoloe_model.predict(target_tmp.name, imgsz=size, conf=thr, verbose=False)
        # Parse result
        r = res[0] if res else None
        if not r:
            print(f"[realtime][PROMPT_IMG][sid={sid}] no result r (kw={used_kw})")
            return {'boxes': []}
        W, H = img_to_save.size
        names = getattr(r, 'names', {})
        b = getattr(r, 'boxes', None)
        if b is not None and getattr(b, 'xyxy', None) is not None:
            xyxy = b.xyxy.cpu().numpy().tolist()
            conf = b.conf.cpu().numpy().tolist() if getattr(b, 'conf', None) is not None else []
            cls = b.cls.cpu().numpy().tolist() if getattr(b, 'cls', None) is not None else []
            ids_raw = getattr(b, 'id', None)
            ids = []
            if ids_raw is not None:
                try:
                    ids = ids_raw.int().cpu().numpy().tolist()
                    ids = [int(v[0] if isinstance(v, (list, tuple)) else v) for v in ids]
                except Exception:
                    ids = []
            for i, p in enumerate(xyxy):
                try:
                    x1,y1,x2,y2 = p
                except Exception:
                    continue
                sc = float(conf[i]) if i < len(conf) else None
                cid = None
                if i < len(cls):
                    try:
                        raw = cls[i]
                        cid = int(raw[0] if isinstance(raw,(list,tuple)) else raw)
                    except Exception:
                        cid = None
                lbl = None
                try:
                    if isinstance(names, dict) and isinstance(cid, int) and cid in names:
                        lbl = str(names[cid])
                    elif isinstance(names, (list, tuple)) and isinstance(cid, int) and 0 <= cid < len(names):
                        lbl = str(names[cid])
                except Exception:
                    lbl = None
                tid = ids[i] if i < len(ids) else None
                if tid is not None and lbl:
                    disp = _display_id_for(sid, lbl, tid)
                    if disp is not None:
                        lbl = f"{lbl}_{disp}"
                out.append({
                    'x1': max(0.0, min(1.0, float(x1)/W)),
                    'y1': max(0.0, min(1.0, float(y1)/H)),
                    'x2': max(0.0, min(1.0, float(x2)/W)),
                    'y2': max(0.0, min(1.0, float(y2)/H)),
                    **({'score': sc} if sc is not None else {}),
                    **({'label': lbl} if lbl else {}),
                    **({'track_id': tid} if tid is not None else {}),
                })
        return {'boxes': out}
    except Exception as e:
        print('[realtime] prompt_image error:', e)
        return {'boxes': []}
    finally:
        try:
            print(f"[realtime][PROMPT_IMG][sid={sid}] size={req.img_size or _DEFAULT_IMGSZ} prompt=({pw}x{ph}) kw={used_kw} -> {len(out)} boxes")
            # cleanup
            for p in (locals().get('target_tmp'), locals().get('refer_tmp')):
                try:
                    if p and os.path.isfile(p.name):
                        os.unlink(p.name)
                except Exception:
                    pass
        except Exception:
            pass


@app.post('/realtime/classify')
def realtime_classify(req: RTClassifyRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {'classes': []}
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
    thr = _DEFAULT_THRESH
    img2 = _scale_image(img, size)
    try:
        if not _HAVE_YOLOE_PF:
            _lazy_load_yoloe_pf()
        if not _HAVE_YOLOE_PF:
            return {'classes': []}
        res = _safe_predict(_yoloe_pf_model, img2, size, thr)
        if not res:
            return {'classes': []}
        r = res[0]
        W, H = img2.size
        boxes = _parse_boxes(r, W, H, getattr(r, 'names', {}), None)
        # Aggregate by label score sum
        agg: Dict[str, float] = {}
        for b in boxes:
            lbl = str(b.get('label') or '')
            if not lbl:
                continue
            agg[lbl] = agg.get(lbl, 0.0) + float(b.get('score') or 0.0)
        topk = int(req.top_k) if req.top_k else 5
        top = sorted(agg.items(), key=lambda kv: kv[1], reverse=True)[:topk]
        classes = [{'label': k, 'score': v} for k, v in top]
        return {'classes': classes}
    except Exception as e:
        print('[realtime] classify error:', e)
        return {'classes': []}


# ------------------------- Main -------------------------
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='YOLO‑E realtime vision server')
    parser.add_argument('--ov-model', type=str, default=None, help='YOLO‑E model path or alias (e.g., yoloe-11s-seg.pt). Auto‑loads -pf for prompt‑free')
    parser.add_argument('--port', type=int, default=_DEFAULT_PORT)
    parser.add_argument('--imgsz', type=int, default=_DEFAULT_IMGSZ)
    parser.add_argument('--threshold', type=float, default=_DEFAULT_THRESH)
    parser.add_argument('--device', type=str, default=_DEVICE, choices=['auto', 'cpu', 'mps', 'cuda'])
    args = parser.parse_args()

    _CLI_OV_MODEL_SPEC = args.ov_model
    _DEFAULT_PORT = int(args.port)
    _DEFAULT_IMGSZ = int(args.imgsz)
    _DEFAULT_THRESH = float(args.threshold)
    _DEVICE = args.device

    # Preload both models so the first call is responsive
    _lazy_load_yoloe()
    _lazy_load_yoloe_pf()

    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=_DEFAULT_PORT)
