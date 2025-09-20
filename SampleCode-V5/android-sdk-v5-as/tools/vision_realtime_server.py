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

from typing import List, Dict, Any, Optional, Set
import base64
import io
import os
import json
import urllib.request
import time
import torch  # type: ignore

from fastapi import FastAPI, Request
import tempfile
import numpy as np  # type: ignore
from fastapi.middleware.cors import CORSMiddleware
import ultralytics as _ultra  # type: ignore
from pydantic import BaseModel
from PIL import Image

import argparse

# Set PyTorch defaults to float32 for MPS compatibility
torch.set_default_dtype(torch.float32)
# Allow CPU fallback for operations not implemented on MPS
if torch.backends.mps.is_available():
    torch.backends.mps.allow_tf32 = False  # Ensure float32 precision
    os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '1'

# Override numpy default float type to avoid float64
# Handle both NumPy 1.x and 2.x
try:
    # NumPy 1.x
    original_numpy_float = np.float_
    np.float_ = np.float32
except AttributeError:
    # NumPy 2.x - float_ was removed, use float64 instead
    original_numpy_float = np.float64
    # Can't override float64 directly in NumPy 2.x, but we can set default dtype
    pass

# Set numpy default dtype to float32
np.seterr(all='ignore')  # Suppress numpy warnings during dtype conversion


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
_USE_HALF: bool = False  # Use FP16 half precision
_OBJECT_MEMORY_URL: Optional[str] = os.environ.get("OBJECT_MEMORY_URL", "http://127.0.0.1:9012")
_OBJECT_MEMORY_LABEL_THRESHOLD: float = float(os.environ.get("OBJECT_MEMORY_LABEL_THRESHOLD", "0.82"))
_OBJECT_MEMORY_TRACK_TTL: float = float(os.environ.get("OBJECT_MEMORY_TRACK_TTL", "120"))

_CLI_OV_MODEL_SPEC: Optional[str] = None
_HAVE_YOLOE: bool = False
_yoloe_model = None
_yoloe_model_cpu = None  # CPU copy for generating embeddings
_YOLOE_API: str = 'unknown'  # 'YOLOE' or 'YOLO'
_ULTRA_VER: str = getattr(_ultra, '__version__', 'unknown')
_HAVE_YOLOE_PF: bool = False
_yoloe_pf_model = None
_yoloe_pf_model_cpu = None  # CPU copy for generating embeddings

# Cache for text embeddings to avoid recomputation
_EMBEDDINGS_CACHE: Dict[tuple, torch.Tensor] = {}

# Per-session display ID mapping: track_id -> per-class small id
_DISPLAY_MAP: Dict[str, Dict[str, Dict[str, Any]]] = {}

_TRACK_LAST_SAVED: Dict[str, float] = {}


def _should_store_track(track_key: Optional[str]) -> bool:
    if not track_key:
        return False
    now = time.time()
    cutoff = now - _OBJECT_MEMORY_TRACK_TTL
    for key, ts in list(_TRACK_LAST_SAVED.items()):
        if ts < cutoff:
            del _TRACK_LAST_SAVED[key]
    last = _TRACK_LAST_SAVED.get(track_key)
    return last is None or (now - last) >= _OBJECT_MEMORY_TRACK_TTL


def _mark_track_stored(track_key: Optional[str]) -> None:
    if not track_key:
        return
    _TRACK_LAST_SAVED[track_key] = time.time()

# Color assignment now handled by UI based on track_id

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


# Color assignment now handled by UI based on track_id


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
                det['ref']['track_id'] = tr['id']  # Add track_id field
            else:
                tid = cls_state['next']; cls_state['next'] = tid + 1
                tracks.append({'id': tid, 'bbox': det['bbox']})
                det['ref']['label'] = f"{lbl}_{tid}"
                det['ref']['track_id'] = tid  # Add track_id field
        cls_state['tracks'] = tracks[:50]
        state[lbl] = cls_state
    _SEG_TRACKERS[sid] = state
    return instances

# ------------------------- Utils -------------------------
def dtype_of(module):
    """Get the dtype of a module's parameters"""
    memory_hits = 0
    try:
        return next(module.parameters()).dtype
    except StopIteration:
        return torch.float32

def device_of(module):
    """Get the device of a module's parameters"""
    try:
        return next(module.parameters()).device
    except StopIteration:
        return torch.device('cpu')

def sanitize_module_fp(module, target_dtype=None):
    """Force every param/buffer to target_dtype (fp32 by default)."""
    if target_dtype is None:
        target_dtype = torch.float32

    for name, p in module.named_parameters(recurse=True):
        if p.dtype != target_dtype:
            p.data = p.data.to(dtype=target_dtype)

    for name, buf in module.named_buffers(recurse=True):
        if buf.dtype != target_dtype:
            # Need to get parent module and attribute name to set buffer
            parent = module
            parts = name.split('.')
            for part in parts[:-1]:
                parent = getattr(parent, part)
            setattr(parent, parts[-1], buf.to(dtype=target_dtype))

    return module

def assert_no_fp64(module, where="(unknown)"):
    """Assert that no parameters or buffers are float64"""
    for name, p in module.named_parameters(recurse=True):
        assert p.dtype != torch.float64, f"found fp64 param {name} {where}"
    for name, b in module.named_buffers(recurse=True):
        assert b.dtype != torch.float64, f"found fp64 buffer {name} {where}"

def safe_set_classes_yoloe(model, classes):
    """
    Safe wrapper for YOLO-E set_classes that enforces fp32/fp16 throughout.
    Works around MPS float64 limitations by using a CPU copy for embeddings.
    """
    if not classes:
        return

    try:
        # Create cache key from sorted classes
        cache_key = tuple(sorted(classes))

        # Check if we have cached embeddings
        if cache_key in _EMBEDDINGS_CACHE:
            print(f'[realtime] Using cached embeddings for: {classes}')
            emb = _EMBEDDINGS_CACHE[cache_key]
            # Move to model device and dtype
            mdev = device_of(model.model)
            mdtype = dtype_of(model.model)
            emb = emb.to(device=mdev, dtype=mdtype)
            model.set_classes(classes, embeddings=emb)
            return

        # Get model device and dtype
        mdev = device_of(model.model)
        mdtype = dtype_of(model.model)

        # For MPS, use the CPU copy to generate embeddings
        if 'mps' in str(mdev):
            # Determine which CPU model to use
            global _yoloe_model_cpu, _yoloe_pf_model_cpu

            # Check if this is the prompt-free model
            is_pf = (model is _yoloe_pf_model) if _yoloe_pf_model else False
            cpu_model = _yoloe_pf_model_cpu if is_pf else _yoloe_model_cpu

            if cpu_model is None:
                print(f'[realtime] WARNING: No CPU model available for embeddings generation')
                # Fallback to moving model temporarily
                with torch.no_grad():
                    original_device = mdev
                    model.model = model.model.cpu()
                    emb = model.get_text_pe(classes)
                    if emb.dtype == torch.float64:
                        emb = emb.float()
                    model.set_classes(classes, embeddings=emb)
                    model.model = model.model.to(original_device)
                    sanitize_module_fp(model.model, target_dtype=mdtype)
                return

            print(f'[realtime] Using CPU model for embeddings generation: {classes}')

            with torch.no_grad():
                # Generate embeddings on CPU model
                emb = cpu_model.get_text_pe(classes)

                # Ensure float32
                if emb.dtype == torch.float64:
                    emb = emb.float()

                # Cache the embeddings on CPU
                if len(_EMBEDDINGS_CACHE) < 100:  # Limit cache size
                    _EMBEDDINGS_CACHE[cache_key] = emb.cpu()

                # Move to MPS device with correct dtype
                emb = emb.to(device=mdev, dtype=mdtype)

                # Set classes on both models to keep them in sync
                cpu_model.set_classes(classes, embeddings=emb.cpu())
                model.set_classes(classes, embeddings=emb)

                print(f'[realtime] YOLOE set_classes success using CPU model: {classes}')

        else:
            # Non-MPS devices can use normal flow
            with torch.no_grad():
                emb = model.get_text_pe(classes)

                if emb.dtype == torch.float64:
                    emb = emb.float()

                # Cache the embeddings
                if len(_EMBEDDINGS_CACHE) < 100:
                    _EMBEDDINGS_CACHE[cache_key] = emb.cpu()

                emb = emb.to(device=mdev, dtype=mdtype)
                model.set_classes(classes, embeddings=emb)

                print(f'[realtime] YOLOE set_classes success: {classes}')

        # Final sanitization
        sanitize_module_fp(model.model, target_dtype=mdtype)

    except Exception as e:
        print(f'[realtime] safe_set_classes_yoloe failed: {e}')
        import traceback
        traceback.print_exc()
        print(f'[realtime] WARNING: Custom classes disabled due to error')


class ForceCPUTensors:
    """Context manager to force tensor creation on CPU with float32"""
    def __init__(self):
        self.originals = {}

    def __enter__(self):
        # Save all original tensor creation functions
        self.originals = {
            'empty': torch.empty,
            'zeros': torch.zeros,
            'ones': torch.ones,
            'tensor': torch.tensor,
            'as_tensor': torch.as_tensor,
            'from_numpy': torch.from_numpy,
            'randn': torch.randn,
            'rand': torch.rand,
            'arange': torch.arange,
            'linspace': torch.linspace,
            'full': torch.full,
            'eye': torch.eye,
        }

        # Create wrapper that forces CPU and float32
        def make_wrapper(orig_func):
            def wrapper(*args, **kwargs):
                # Remove or override device argument
                if 'device' in kwargs:
                    device = kwargs.get('device')
                    # Force CPU if MPS or CUDA is specified
                    if device is not None and ('mps' in str(device) or 'cuda' in str(device)):
                        kwargs['device'] = 'cpu'
                else:
                    kwargs['device'] = 'cpu'

                # Force float32 for float64
                if 'dtype' in kwargs:
                    if kwargs['dtype'] in (torch.float64, torch.double):
                        kwargs['dtype'] = torch.float32

                result = orig_func(*args, **kwargs)

                # Double-check result is on CPU with float32
                if hasattr(result, 'dtype') and result.dtype == torch.float64:
                    result = result.float()
                if hasattr(result, 'device') and result.device.type != 'cpu':
                    result = result.cpu()

                return result
            return wrapper

        # Apply patches to all functions
        for name, orig in self.originals.items():
            if name == 'from_numpy':
                # Special handling for from_numpy
                def from_numpy_wrapper(array):
                    tensor = self.originals['from_numpy'](array)
                    if tensor.dtype == torch.float64:
                        tensor = tensor.float()
                    if tensor.device.type != 'cpu':
                        tensor = tensor.cpu()
                    return tensor
                setattr(torch, name, from_numpy_wrapper)
            else:
                setattr(torch, name, make_wrapper(orig))

        return self

    def __exit__(self, *args):
        # Restore all original functions
        for name, orig in self.originals.items():
            setattr(torch, name, orig)




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


def _pil_to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=90)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def _object_memory_post(path: str, payload: Dict[str, Any], timeout: float = 0.5) -> Optional[Dict[str, Any]]:
    if not _OBJECT_MEMORY_URL:
        return None
    url = f"{_OBJECT_MEMORY_URL.rstrip('/')}{path}"
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode('utf-8'))
    except Exception as e:
        print(f"[realtime] object memory request failed: {e}")
        return None


# ------------------------- YOLO‑E loaders -------------------------
def _lazy_load_yoloe():
    global _HAVE_YOLOE, _yoloe_model, _yoloe_model_cpu
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

        # Load model for inference
        if YOLOEClass is not None:
            _yoloe_model = YOLOEClass(model_spec)
            api = 'YOLOE'
        else:
            _yoloe_model = YOLO(model_spec)
            api = 'YOLO'

        # For MPS, create a separate CPU copy for embeddings generation
        if _DEVICE == "mps":
            print(f"[realtime] Creating CPU copy of YOLO‑E for embeddings generation")
            if YOLOEClass is not None:
                _yoloe_model_cpu = YOLOEClass(model_spec)
            else:
                _yoloe_model_cpu = YOLO(model_spec)
            # Keep CPU model on CPU with float32
            if hasattr(_yoloe_model_cpu, 'model'):
                _yoloe_model_cpu.model = _yoloe_model_cpu.model.cpu().float()
                sanitize_module_fp(_yoloe_model_cpu.model, target_dtype=torch.float32)

        # Move inference model to device and apply half precision if requested
        try:
            if _DEVICE in ("mps", "cuda"):
                _yoloe_model.to(_DEVICE)

            # Apply half precision and sanitize dtype
            if _USE_HALF and hasattr(_yoloe_model, 'model'):
                _yoloe_model.model = _yoloe_model.model.half()
                sanitize_module_fp(_yoloe_model.model, target_dtype=torch.float16)
                print(f"[realtime] Applied FP16 half precision to YOLO‑E model")
            elif hasattr(_yoloe_model, 'model'):
                # Ensure FP32 and no FP64
                sanitize_module_fp(_yoloe_model.model, target_dtype=torch.float32)
                assert_no_fp64(_yoloe_model.model, where="after loading YOLO‑E")
        except Exception as e:
            print(f'[realtime] Model device/dtype setup warning: {e}')

        _HAVE_YOLOE = True
        globals()['_YOLOE_API'] = api
        print(f"[realtime] YOLO‑E loaded: {model_spec} api={api} ultralytics={_ULTRA_VER} dtype={dtype_of(_yoloe_model.model) if hasattr(_yoloe_model, 'model') else 'unknown'}")
    except Exception as e:
        print('[realtime] yoloe load failed:', e)
        _HAVE_YOLOE = False


def _lazy_load_yoloe_pf():
    global _HAVE_YOLOE_PF, _yoloe_pf_model, _yoloe_pf_model_cpu
    if _HAVE_YOLOE_PF:
        return
    try:
        from ultralytics import YOLO  # type: ignore
        base_spec = _canonicalize_model_spec(_CLI_OV_MODEL_SPEC or os.environ.get("YOLOE_MODEL")) or 'yoloe.pt'
        pf_spec = _derive_pf_spec(base_spec)
        _yoloe_pf_model = YOLO(pf_spec)

        # For MPS, create a separate CPU copy for embeddings generation
        if _DEVICE == "mps":
            print(f"[realtime] Creating CPU copy of YOLO‑E PF for embeddings generation")
            _yoloe_pf_model_cpu = YOLO(pf_spec)
            # Keep CPU model on CPU with float32
            if hasattr(_yoloe_pf_model_cpu, 'model'):
                _yoloe_pf_model_cpu.model = _yoloe_pf_model_cpu.model.cpu().float()
                sanitize_module_fp(_yoloe_pf_model_cpu.model, target_dtype=torch.float32)

        # Move inference model to device and apply half precision if requested
        try:
            if _DEVICE in ("mps", "cuda"):
                _yoloe_pf_model.to(_DEVICE)

            # Apply half precision and sanitize dtype
            if _USE_HALF and hasattr(_yoloe_pf_model, 'model'):
                _yoloe_pf_model.model = _yoloe_pf_model.model.half()
                sanitize_module_fp(_yoloe_pf_model.model, target_dtype=torch.float16)
                print(f"[realtime] Applied FP16 half precision to YOLO‑E PF model")
            elif hasattr(_yoloe_pf_model, 'model'):
                # Ensure FP32 and no FP64
                sanitize_module_fp(_yoloe_pf_model.model, target_dtype=torch.float32)
                assert_no_fp64(_yoloe_pf_model.model, where="after loading YOLO‑E PF")
        except Exception as e:
            print(f'[realtime] PF model device/dtype setup warning: {e}')

        _HAVE_YOLOE_PF = True
        print(f"[realtime] YOLO‑E PF loaded: {pf_spec} dtype={dtype_of(_yoloe_pf_model.model) if hasattr(_yoloe_pf_model, 'model') else 'unknown'}")
    except Exception as e:
        print('[realtime] yoloe‑pf load failed:', e)
        _HAVE_YOLOE_PF = False


# ------------------------- Inference helpers -------------------------
def _safe_predict(model, img: Image.Image, imgsz: int, conf: float, extra: Optional[Dict[str, Any]] = None):
    extra = extra or {}
    # Add half precision flag if enabled
    if _USE_HALF:
        extra['half'] = True
    try:
        return model.predict(img, imgsz=imgsz, conf=conf, verbose=True, **extra)  # type: ignore
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
    search_db: bool | None = None


class RTSegmentRequest(BaseModel):
    image: str
    threshold: float | None = None
    img_size: int | None = None
    ov_labels: list[str] | None = None


## (Removed) Image Prompt request schemas and endpoints were deprecated in favor of LockTrack


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
    memory_hits = 0
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
            # Set textual classes using safe helper for MPS compatibility
            if req.ov_labels:
                safe_set_classes_yoloe(_yoloe_model, req.ov_labels)
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
                # For OV, ensure classes are set before tracking
                if (not use_pf) and req.ov_labels:
                    safe_set_classes_yoloe(model, req.ov_labels)
                track_res = model.track(img2, imgsz=size, conf=thr, verbose=False, persist=True, tracker='botsort-reid.yaml', half=_USE_HALF)  # type: ignore
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
        # Optional object memory search to reuse labels
        seen_tracks: Set[str] = set()

        def ingest_track(track_key: Optional[str], data_url: str, label: Optional[str] = None) -> None:
            if not track_key:
                return
            if track_key in seen_tracks:
                return
            if not _should_store_track(track_key):
                return
            payload = {'image': data_url, 'track_id': track_key}
            if label:
                payload['label'] = label
            try:
                _object_memory_post('/memory/ingest', payload, timeout=0.3)
            except Exception:
                # Allow retry on next frame when ingest fails
                raise
            else:
                _mark_track_stored(track_key)
                seen_tracks.add(track_key)

        if _OBJECT_MEMORY_URL and boxes:
            for b in boxes:
                try:
                    x1_px = int(max(0.0, min(1.0, b['x1'])) * W)
                    y1_px = int(max(0.0, min(1.0, b['y1'])) * H)
                    x2_px = int(max(0.0, min(1.0, b['x2'])) * W)
                    y2_px = int(max(0.0, min(1.0, b['y2'])) * H)
                    if x2_px <= x1_px or y2_px <= y1_px:
                        continue
                    crop = img2.crop((x1_px, y1_px, x2_px, y2_px))
                    data_url = _pil_to_data_url(crop)
                    track_key = None
                    if b.get('track_id') is not None:
                        track_key = str(b['track_id'])

                    resp = _object_memory_post('/memory/search', {'image': data_url}) if req.search_db else None
                    if not resp or 'match' not in resp:
                        ingest_track(track_key, data_url)
                        continue
                    match = resp['match']
                    if not match:
                        ingest_track(track_key, data_url)
                        continue
                    similarity = float(match.get('similarity', 0.0) or 0.0)
                    if similarity < _OBJECT_MEMORY_LABEL_THRESHOLD:
                        ingest_track(track_key, data_url)
                        continue
                    cluster = match.get('cluster') or {}
                    label = cluster.get('label')
                    if not label:
                        ingest_track(track_key, data_url)
                        continue
                    original_label = b.get('label')
                    if original_label and str(original_label) != label:
                        b['yolo_label'] = original_label
                    b['memory_label'] = label
                    b['memory_similarity'] = similarity
                    if 'cluster_id' in cluster:
                        b['memory_cluster_id'] = cluster['cluster_id']
                    b['label'] = label
                    memory_hits += 1
                    ingest_track(track_key, data_url, label if original_label and str(original_label).lower() == label.lower() else None)
                except Exception as e_mem:
                    print(f"[realtime] memory lookup failed: {e_mem}")
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
        print(f"[realtime][DETECT][sid={sid}] thr={thr} size={size} mode={'PF' if use_pf else 'OV'} labels={(req.ov_labels or [])} -> {len(boxes)} boxes; memory_hits={memory_hits}; top: {top}")
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
            # Set textual classes using safe helper for MPS compatibility
            if req.ov_labels:
                safe_set_classes_yoloe(model, req.ov_labels)

        # Use track() instead of predict() to get consistent tracking IDs
        try:
            # Track with ByteTrack + ReID for consistent IDs across detect/segment
            track_res = model.track(img2, imgsz=size, conf=thr, verbose=False, persist=True, tracker='botsort-reid.yaml', half=_USE_HALF)  # type: ignore
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

        # If no tracking IDs from BOT-SORT, use simple IoU tracker
        if instances and not any(inst.get('track_id') is not None for inst in instances):
            instances = _assign_seg_ids(sid2, instances)

        # No fallbacks in segmentation path
        try:
            print(f"[realtime][SEG][sid={sid2}] mode={'PF' if use_pf else 'OV'} thr={thr} size={size} labels={(req.ov_labels or [])} -> {len(instances)} instances")
        except Exception:
            pass
        return {'instances': instances}
    except Exception as e:
        print('[realtime] segment error:', e)
        return {'instances': []}


## (Removed) /realtime/prompt endpoint deprecated — use /realtime/locktrack on LockTrack server


## (Removed) /realtime/prompt_image endpoint deprecated — use /realtime/locktrack on LockTrack server


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
    parser.add_argument('--half', action='store_true', help='Use FP16 half precision (can help with MPS/CUDA)')
    args = parser.parse_args()

    _CLI_OV_MODEL_SPEC = args.ov_model
    _DEFAULT_PORT = int(args.port)
    _DEFAULT_IMGSZ = int(args.imgsz)
    _DEFAULT_THRESH = float(args.threshold)
    _DEVICE = args.device
    _USE_HALF = args.half

    # Verify MPS setup if using MPS
    if _DEVICE == 'mps' or (_DEVICE == 'auto' and torch.backends.mps.is_available()):
        print(f"[realtime] PyTorch version: {torch.__version__}")
        print(f"[realtime] MPS available: {torch.backends.mps.is_available()}")
        print(f"[realtime] MPS built: {torch.backends.mps.is_built()}")
        print(f"[realtime] Default dtype: {torch.get_default_dtype()}")
        print(f"[realtime] Half precision (FP16): {_USE_HALF}")
        if _DEVICE == 'auto':
            _DEVICE = 'mps'
            print("[realtime] Auto-detected MPS device")

    # Preload both models so the first call is responsive
    _lazy_load_yoloe()
    _lazy_load_yoloe_pf()

    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=_DEFAULT_PORT)
