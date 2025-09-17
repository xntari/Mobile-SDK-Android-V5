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
  python tools/vision_realtime_server.py --ov-model yoloe-11s-seg.pt
"""
from __future__ import annotations

from typing import List, Dict, Any, Optional
import base64
import io
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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
_HAVE_YOLOE_PF: bool = False
_yoloe_pf_model = None


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
        from ultralytics import YOLO  # type: ignore
        model_spec = _canonicalize_model_spec(_CLI_OV_MODEL_SPEC or os.environ.get("YOLOE_MODEL"))
        if not model_spec:
            model_spec = 'yoloe.pt'
        _yoloe_model = YOLO(model_spec)
        try:
            if _DEVICE in ("mps", "cuda"):
                _yoloe_model.to(_DEVICE)
        except Exception:
            pass
        _HAVE_YOLOE = True
        print(f"[realtime] YOLO‑E loaded: {model_spec}")
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
def realtime_detect(req: RTDetectRequest):
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
            # set textual classes and predict; try prompt args if needed
            try:
                if hasattr(_yoloe_model, 'set_classes'):
                    _yoloe_model.set_classes(req.ov_labels)  # type: ignore
                elif hasattr(_yoloe_model, 'set_labels'):
                    getattr(_yoloe_model, 'set_labels')(req.ov_labels)  # type: ignore
            except Exception:
                pass
            res = _safe_predict(_yoloe_model, img2, size, thr)
            if (not res or len(res) == 0) and req.ov_labels:
                for kw in ({'prompts': req.ov_labels}, {'text': req.ov_labels}):
                    res = _safe_predict(_yoloe_model, img2, size, thr, extra=kw)
                    if res:
                        break
        if res:
            r = res[0]
            W, H = img2.size
            boxes = _parse_boxes(r, W, H, getattr(r, 'names', {}), req.ov_labels if not use_pf else None)
        # Fallback: if OV failed, try PF once
        if not boxes and not use_pf:
            if not _HAVE_YOLOE_PF:
                _lazy_load_yoloe_pf()
            if _HAVE_YOLOE_PF:
                res2 = _safe_predict(_yoloe_pf_model, img2, size, thr)
                if res2:
                    r2 = res2[0]
                    W, H = img2.size
                    boxes = _parse_boxes(r2, W, H, getattr(r2, 'names', {}), None)
    except Exception as e:
        print('[realtime] detect error:', e)
    try:
        lab_counts = {}
        for b in boxes:
            lbl = str(b.get('label') or '')
            if lbl:
                lab_counts[lbl] = lab_counts.get(lbl, 0) + 1
        top = sorted(lab_counts.items(), key=lambda kv: kv[1], reverse=True)[:5]
        print(f"[realtime][DETECT] thr={thr} size={size} mode={'PF' if use_pf else 'OV'} labels={(req.ov_labels or [])} -> {len(boxes)} boxes; top: {top}")
    except Exception:
        pass
    return {'boxes': boxes}


@app.post('/realtime/segment')
def realtime_segment(req: RTSegmentRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {'instances': []}
    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
    img2 = _scale_image(img, size)
    try:
        if not _HAVE_YOLOE_PF:
            _lazy_load_yoloe_pf()
        if not _HAVE_YOLOE_PF:
            return {'instances': []}
        res = _safe_predict(_yoloe_pf_model, img2, size, thr)
        if not res:
            return {'instances': []}
        r = res[0]
        W, H = img2.size
        instances = _parse_masks(r, W, H, getattr(r, 'names', {}))
        try:
            print(f"[realtime][SEG] thr={thr} size={size} -> {len(instances)} instances")
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
    thr = float(req.threshold) if req.threshold is not None else _DEFAULT_THRESH
    size = int(req.img_size) if req.img_size else _DEFAULT_IMGSZ
    img2 = _scale_image(img, size)
    W, H = img2.size
    boxes_px = []
    for b in (req.boxes or []):
        try:
            x1 = max(0, min(W, float(b['x1']) * W)); y1 = max(0, min(H, float(b['y1']) * H))
            x2 = max(0, min(W, float(b['x2']) * W)); y2 = max(0, min(H, float(b['y2']) * H))
            boxes_px.append([x1, y1, x2, y2])
        except Exception:
            continue
    try:
        # choose model (labels -> OV; none -> PF)
        use_pf = not (req.ov_labels and len(req.ov_labels) > 0)
        if use_pf:
            if not _HAVE_YOLOE_PF:
                _lazy_load_yoloe_pf()
            model = _yoloe_pf_model
        else:
            if not _HAVE_YOLOE:
                _lazy_load_yoloe()
            model = _yoloe_model
            try:
                if hasattr(model, 'set_classes') and req.ov_labels:
                    model.set_classes(req.ov_labels)  # type: ignore
            except Exception:
                pass
        # try native prompt keywords
        used_native = False
        res = None
        for kw in ({'prompts': {'boxes': boxes_px}}, {'boxes': boxes_px}, {'bboxes': boxes_px}):
            res = _safe_predict(model, img2, size, thr, extra=kw)
            if res:
                used_native = True
                break
        dets: List[Dict[str, Any]] = []
        if used_native and res:
            r = res[0]
            names = getattr(r, 'names', {})
            dets = _parse_boxes(r, W, H, names, (None if use_pf else req.ov_labels))
        else:
            # crop fallback per prompt
            for bb in boxes_px:
                try:
                    x1, y1, x2, y2 = [int(max(0, v)) for v in bb]
                except Exception:
                    continue
                x1, x2 = sorted((x1, x2)); y1, y2 = sorted((y1, y2))
                if x2 - x1 < 2 or y2 - y1 < 2:
                    continue
                crop = img2.crop((x1, y1, x2, y2))
                sub = _safe_predict(model, crop, min(size, max(crop.size)), thr)
                if not sub:
                    continue
                rr = sub[0]
                names = getattr(rr, 'names', {})
                boxes = _parse_boxes(rr, crop.size[0], crop.size[1], names, (None if use_pf else req.ov_labels))
                for d in boxes:
                    dets.append({
                        'x1': max(0.0, min(1.0, (d['x1'] * (x2 - x1) + x1) / W)),
                        'y1': max(0.0, min(1.0, (d['y1'] * (y2 - y1) + y1) / H)),
                        'x2': max(0.0, min(1.0, (d['x2'] * (x2 - x1) + x1) / W)),
                        'y2': max(0.0, min(1.0, (d['y2'] * (y2 - y1) + y1) / H)),
                        **({'score': d.get('score')} if d.get('score') is not None else {}),
                        **({'label': d.get('label')} if d.get('label') else {}),
                    })
        dets.sort(key=lambda d: d.get('score', 0) or 0, reverse=True)
        top = dets[:100]
        try:
            print(f"[realtime][PROMPT] mode={'PF' if use_pf else 'OV'} prompts={len(boxes_px)} -> {len(top)} boxes")
        except Exception:
            pass
        return {'boxes': top}
    except Exception as e:
        print('[realtime] prompt error:', e)
        return {'boxes': []}


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

