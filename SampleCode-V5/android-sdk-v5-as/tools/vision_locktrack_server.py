#!/usr/bin/env python3
"""
LockTrack – Visual lock‑on heatmap tracker (FastAPI)

Purpose
- Replace the broken "Image Prompt" path with a heatmap‑first lock‑on tracker.
- Independent from YOLO tracking. No OpenCV SOT. Single‑view memory initially.

Environment Setup
  python -m venv .venv && source .venv/bin/activate
  pip install --upgrade pip
  pip install fastapi uvicorn pillow torch torchvision numpy

Run
  # Default port 9010, auto device selection (MPS preferred when available)
  python tools/vision_locktrack_server.py

  # Customizations
  LOCKTRACK_PORT=9010 LOCKTRACK_DEVICE=mps python tools/vision_locktrack_server.py

API
  POST /realtime/locktrack/lock
    { image, box?:{x,y,w,h} (normalized 0..1), ref_image?, return_heatmap?, threshold?, search_pad?, scales? }
    -> { track_id, init_box:{x,y,w,h}, score, status:"locked"|"searching", heatmap? }

  POST /realtime/locktrack/step
    { track_id, image, return_heatmap? }
    -> { box:{x,y,w,h}, score, status:"tracking"|"searching"|"lost", heatmap? }

  POST /realtime/locktrack/add_view  (keeps only the latest; max views = 1)
    { track_id, image+box | ref_image }
    -> { num_views:1 }

  POST /realtime/locktrack/unlock
    { track_id } -> { ack:true }

Notes
- Float32 everywhere (MPS does not support float64). No lazy loading.
- Heatmap can be returned as a compact grayscale PNG (base64), downsampled to feature resolution.
"""
from __future__ import annotations

import os
import io
import base64
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional, List, Tuple

import numpy as np  # type: ignore
from PIL import Image, ImageDraw
import torch  # type: ignore
import torch.nn.functional as F  # type: ignore
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights  # type: ignore
    import torchvision.transforms as T  # type: ignore
except Exception as e:  # pragma: no cover
    raise RuntimeError("torchvision is required: pip install torchvision") from e


# ------------------------- Device & dtype -------------------------
torch.set_default_dtype(torch.float32)
if torch.backends.mps.is_available():
    # Ensure MPS fallback for unsupported ops
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

_DEVICE_ENV = os.environ.get("LOCKTRACK_DEVICE", "auto").lower()
if _DEVICE_ENV == "auto":
    if torch.backends.mps.is_available():
        DEVICE = torch.device("mps")
    elif torch.cuda.is_available():
        DEVICE = torch.device("cuda")
    else:
        DEVICE = torch.device("cpu")
elif _DEVICE_ENV in ("mps", "cuda", "cpu"):
    DEVICE = torch.device(_DEVICE_ENV)
else:
    DEVICE = torch.device("cpu")


# ------------------------- Utils -------------------------
def decode_image_to_pil(image_b64_or_dataurl: str) -> Image.Image:
    data = image_b64_or_dataurl
    if data.startswith("data:"):
        _, b64 = data.split(",", 1)
    else:
        b64 = data
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def to_png_base64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


def norm_box(box: Dict[str, float]) -> Dict[str, float]:
    return {
        'x': clamp01(box.get('x', 0.0)),
        'y': clamp01(box.get('y', 0.0)),
        'w': clamp01(box.get('w', 1.0)),
        'h': clamp01(box.get('h', 1.0)),
    }


def abs_from_rel(box: Dict[str, float], size: Tuple[int, int]) -> Tuple[int, int, int, int]:
    W, H = int(size[0]), int(size[1])
    x = int(round(box['x'] * W))
    y = int(round(box['y'] * H))
    w = int(round(box['w'] * W))
    h = int(round(box['h'] * H))
    # Clip and ensure at least 1 pixel
    x = max(0, min(W - 1, x))
    y = max(0, min(H - 1, y))
    w = max(1, min(W - x, w))
    h = max(1, min(H - y, h))
    return x, y, w, h


def rel_from_abs(x: int, y: int, w: int, h: int, size: Tuple[int, int]) -> Dict[str, float]:
    W, H = float(size[0]), float(size[1])
    return {
        'x': clamp01(x / W),
        'y': clamp01(y / H),
        'w': clamp01(w / W),
        'h': clamp01(h / H),
    }


def crop_pil(img: Image.Image, xywh: Tuple[int, int, int, int]) -> Image.Image:
    x, y, w, h = xywh
    return img.crop((x, y, x + w, y + h))


def _cmap_jet(v: np.ndarray) -> np.ndarray:
    """Apply JET colormap to normalized [0,1] array. Returns HxWx3 uint8."""
    v = np.clip(v, 0.0, 1.0)
    r = np.zeros_like(v)
    g = np.zeros_like(v)
    b = np.zeros_like(v)

    # Piecewise linear segments
    # Blue -> Cyan
    m = (v < 0.125)
    b[m] = 0.5 + 4.0 * v[m]
    # Cyan -> Green
    m = (v >= 0.125) & (v < 0.375)
    b[m] = 1.0
    g[m] = 4.0 * (v[m] - 0.125)
    # Green -> Yellow -> Red
    m = (v >= 0.375) & (v < 0.625)
    g[m] = 1.0
    r[m] = 4.0 * (v[m] - 0.375)
    b[m] = 1.0 - 4.0 * (v[m] - 0.375)
    m = (v >= 0.625) & (v < 0.875)
    r[m] = 1.0
    g[m] = 1.0 - 4.0 * (v[m] - 0.625)
    # Red -> Dark Red
    m = (v >= 0.875)
    r[m] = 1.0 - 4.0 * (v[m] - 0.875)
    img = np.stack([r, g, b], axis=-1)
    img = (np.clip(img, 0.0, 1.0) * 255.0).astype(np.uint8)
    return img


def _colorize_heatmap(hmap: np.ndarray, cmap: str = 'jet') -> Image.Image:
    """Map [-1,1] float heatmap to RGB PIL image using a colormap."""
    v = (np.clip(hmap, -1.0, 1.0) + 1.0) * 0.5  # [0,1]
    if cmap == 'jet':
        arr = _cmap_jet(v)
        return Image.fromarray(arr, mode='RGB')
    else:
        # Fallback grayscale
        v8 = (v * 255.0).astype(np.uint8)
        return Image.fromarray(v8, mode='L').convert('RGB')


def make_heatmap_png(hmap: np.ndarray, size: Tuple[int, int], cmap: str = 'jet', cross_xy: Optional[Tuple[int,int]] = None) -> str:
    """Convert float heatmap (Hf,Wf) to colorized PNG base64 resized to size, optionally draw crosshair at cross_xy (pixels in resized space)."""
    pil = _colorize_heatmap(hmap, cmap=cmap).resize(size, resample=Image.BILINEAR)
    if cross_xy is not None:
        try:
            draw = ImageDraw.Draw(pil)
            cx, cy = cross_xy
            # Crosshair size proportional to image
            s = max(6, int(0.02 * max(size)))
            color = (255, 255, 255)
            draw.line([(cx - s, cy), (cx + s, cy)], fill=color, width=2)
            draw.line([(cx, cy - s), (cx, cy + s)], fill=color, width=2)
            # small center dot
            draw.ellipse([(cx - 2, cy - 2), (cx + 2, cy + 2)], outline=(0,0,0), width=2)
        except Exception:
            pass
    
    return to_png_base64(pil)


# Peak refinement configuration
PEAK_WINDOW_MIN_RADIUS = 2
PEAK_WINDOW_MAX_RADIUS = 14
PEAK_WINDOW_RADIUS_FRACTION = 0.5
PEAK_REFINE_SHARPEN_POWER = 2.5
MAX_VIEWS = 5


@dataclass
class DescriptorEntry:
    tensor: torch.Tensor
    scale: float
    base_wh: Tuple[int, int]
    view_id: int


def _smooth_patch(patch: torch.Tensor) -> torch.Tensor:
    """Approximate lower-resolution averaging without shrinking support."""
    if patch.ndim != 2 or patch.numel() < 2:
        return patch
    pooled = F.avg_pool2d(patch.unsqueeze(0).unsqueeze(0), kernel_size=3, stride=1, padding=1)
    return pooled.squeeze(0).squeeze(0)


def _compute_window_radii(box_wh: Tuple[int, int], fmap_hw: Tuple[int, int], img_hw: Tuple[int, int]) -> Tuple[int, int]:
    """Derive anisotropic window radii in feature coordinates from box pixels."""
    w_px, h_px = max(1, box_wh[0]), max(1, box_wh[1])
    fmap_h, fmap_w = max(1, fmap_hw[0]), max(1, fmap_hw[1])
    img_w, img_h = max(1, img_hw[0]), max(1, img_hw[1])
    stride_x = float(img_w) / float(fmap_w)
    stride_y = float(img_h) / float(fmap_h)
    w_feat = float(w_px) / max(1e-6, stride_x)
    h_feat = float(h_px) / max(1e-6, stride_y)
    rx = int(round(max(1.0, w_feat * PEAK_WINDOW_RADIUS_FRACTION)))
    ry = int(round(max(1.0, h_feat * PEAK_WINDOW_RADIUS_FRACTION)))
    rx = max(PEAK_WINDOW_MIN_RADIUS, min(PEAK_WINDOW_MAX_RADIUS, rx))
    ry = max(PEAK_WINDOW_MIN_RADIUS, min(PEAK_WINDOW_MAX_RADIUS, ry))
    return rx, ry


def refine_peak_center(out: torch.Tensor, ix: int, iy: int, window_rx: int, window_ry: int) -> Tuple[float, float]:
    """Refine peak location using a smoothed, sharpened center-of-mass window."""
    Hf, Wf = int(out.shape[-2]), int(out.shape[-1])
    if Hf == 0 or Wf == 0:
        return float(iy), float(ix)
    rx = max(1, int(window_rx))
    ry = max(1, int(window_ry))
    y0 = max(0, iy - ry)
    y1 = min(Hf, iy + ry + 1)
    x0 = max(0, ix - rx)
    x1 = min(Wf, ix + rx + 1)
    if y1 <= y0 or x1 <= x0:
        return float(iy), float(ix)
    patch = out[0, 0, y0:y1, x0:x1]
    patch = patch - patch.min()
    patch = torch.clamp(patch, min=0.0)
    if patch.numel() == 0:
        return float(iy), float(ix)
    patch = _smooth_patch(patch)
    max_val = float(patch.max().item()) if patch.numel() else 0.0
    if max_val > 0.0 and PEAK_REFINE_SHARPEN_POWER > 1.0:
        patch = (patch / max_val).pow(PEAK_REFINE_SHARPEN_POWER)
    denom = patch.sum()
    denom_val = float(denom.item()) if isinstance(denom, torch.Tensor) else float(denom)
    if denom_val <= 0.0:
        return float(iy), float(ix)
    ys = torch.linspace(float(y0), float(y1 - 1), steps=patch.shape[0], device=patch.device, dtype=torch.float32)
    xs = torch.linspace(float(x0), float(x1 - 1), steps=patch.shape[1], device=patch.device, dtype=torch.float32)
    wy = patch.sum(dim=1)
    wx = patch.sum(dim=0)
    iyf = (wy * ys).sum() / denom
    ixf = (wx * xs).sum() / denom
    return float(iyf.item()), float(ixf.item())


# ------------------------- Model -------------------------
class FeatureBackbone(torch.nn.Module):
    """MobileNetV3‑Small feature extractor that outputs a spatial feature map.

    We use the .features submodule, which is convolutional and handles variable
    sizes. The output stride is architecture‑dependent (~16–32). We keep it as‑is
    and map heatmap coordinates back to image space linearly.
    """
    def __init__(self):
        super().__init__()
        # Prefer new weights API; fall back to defaults if meta keys differ
        try:
            weights = getattr(MobileNet_V3_Small_Weights, 'DEFAULT', MobileNet_V3_Small_Weights.IMAGENET1K_V1)
            model = mobilenet_v3_small(weights=weights)
        except Exception:
            # Older torchvision: use pretrained flag
            model = mobilenet_v3_small(pretrained=True)  # type: ignore[arg-type]
        model.eval()
        # Keep only the convolutional trunk
        self.features = model.features
        # Resolve mean/std robustly across torchvision versions
        DEFAULT_MEAN = [0.485, 0.456, 0.406]
        DEFAULT_STD = [0.229, 0.224, 0.225]
        m, s = DEFAULT_MEAN, DEFAULT_STD
        try:
            meta = getattr(weights, 'meta', {}) if 'weights' in locals() else {}
            if isinstance(meta, dict):
                m = meta.get('mean', m)
                s = meta.get('std', s)
        except Exception:
            pass
        self.mean = torch.tensor(list(m), dtype=torch.float32).view(3, 1, 1)
        self.std = torch.tensor(list(s), dtype=torch.float32).view(3, 1, 1)

    @torch.inference_mode()
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: float32 tensor Bx3xHxW in [0,1] normalized with mean/std prior to call."""
        return self.features(x)


def pil_to_tensor_float(img: Image.Image) -> torch.Tensor:
    # Ensure writable contiguous array to avoid PyTorch warnings
    arr = np.array(img, dtype=np.uint8, copy=True)
    t = torch.from_numpy(arr).permute(2, 0, 1).contiguous()  # 3xHxW
    return t.float() / 255.0


def normalize_inplace(x: torch.Tensor, mean: torch.Tensor, std: torch.Tensor) -> torch.Tensor:
    # x: Bx3xHxW, mean/std: 3x1x1
    return (x - mean) / std


def l2_normalize_channels(feat: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    """Normalize per spatial location across channel dimension.
    feat: BxCxHxW -> same shape with unit L2 across C for each (h,w).
    """
    return F.normalize(feat, p=2, dim=1, eps=eps)


def l2_normalize_channels_fast(feat: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    # Equivalent but avoids extra permutes
    # Compute norm along C: sqrt(sum(f^2)) with keepdim
    norm = torch.clamp(feat.pow(2).sum(dim=1, keepdim=True), min=eps).sqrt()
    return feat / norm


@torch.inference_mode()
def compute_feature_map(backbone: FeatureBackbone, img: Image.Image, device: torch.device) -> torch.Tensor:
    # Convert PIL -> tensor float32 [0,1]
    x = pil_to_tensor_float(img).unsqueeze(0)  # 1x3xHxW
    # Normalize with weights mean/std
    mean = backbone.mean.to(x.dtype).to('cpu')
    std = backbone.std.to(x.dtype).to('cpu')
    x = normalize_inplace(x, mean, std)
    x = x.to(device=device, dtype=torch.float32, non_blocking=False)
    # Forward through convolutional trunk
    f = backbone(x)
    # Normalize per spatial location (cosine sim compatibility)
    f = l2_normalize_channels_fast(f)
    return f  # 1xCxHf xWf


@torch.inference_mode()
def compute_descriptor(backbone: FeatureBackbone, crop: Image.Image, device: torch.device) -> torch.Tensor:
    # As above but global average pool to C vector
    x = pil_to_tensor_float(crop).unsqueeze(0)
    mean = backbone.mean.to(x.dtype).to('cpu')
    std = backbone.std.to(x.dtype).to('cpu')
    x = normalize_inplace(x, mean, std)
    x = x.to(device=device, dtype=torch.float32, non_blocking=False)
    f = backbone(x)  # 1xCxHf xWf
    # Global average pooling
    d = f.mean(dim=(2, 3))  # 1xC
    d = F.normalize(d, p=2, dim=1)
    return d.squeeze(0).contiguous()  # C


@torch.inference_mode()
def cosine_heatmap(fmap: torch.Tensor, descs: List[torch.Tensor], search_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
    """Compute cosine similarity heatmap given a normalized feature map and desc(s).
    fmap: 1xCxHf xWf (already L2‑norm per spatial location) on device.
    descs: list of C vectors (each L2‑normed) on same device.
    search_mask: optional 1x1xHf xWf tensor with 0/1 to gate the search region.
    Returns: 1x1xHf xWf heatmap in [−1,1].
    """
    if not descs:
        # Should not happen, but return zeros
        return torch.zeros((1, 1, fmap.shape[2], fmap.shape[3]), device=fmap.device)
    # Stack and max over scales
    maps: List[torch.Tensor] = []
    for d in descs:
        w = d.view(1, -1, 1, 1)  # 1xCx1x1
        m = (fmap * w).sum(dim=1, keepdim=True)  # 1x1xHfxWf
        maps.append(m)
    out = torch.maximum(maps[0], maps[1]) if len(maps) > 1 else maps[0]
    for i in range(2, len(maps)):
        out = torch.maximum(out, maps[i])
    if search_mask is not None:
        out = out * search_mask
    return out


def make_search_mask(Hf: int, Wf: int, last_box_abs: Tuple[int, int, int, int], img_size: Tuple[int, int], pad_px: int) -> torch.Tensor:
    """Create a binary mask (1 inside, 0 outside) around last_box with pad_px in pixels.
    Converts to feature space by linear scaling.
    """
    if pad_px <= 0:
        return torch.ones((1, 1, Hf, Wf), dtype=torch.float32, device=DEVICE)
    W, H = img_size
    x, y, w, h = last_box_abs
    x1 = max(0, x - pad_px); y1 = max(0, y - pad_px)
    x2 = min(W, x + w + pad_px); y2 = min(H, y + h + pad_px)
    fx1 = int(x1 * Wf / max(1, W)); fy1 = int(y1 * Hf / max(1, H))
    fx2 = int(x2 * Wf / max(1, W)); fy2 = int(y2 * Hf / max(1, H))
    fx1, fy1 = max(0, fx1), max(0, fy1)
    fx2, fy2 = min(Wf, fx2), min(Hf, fy2)
    m = torch.zeros((1, 1, Hf, Wf), dtype=torch.float32, device=DEVICE)
    m[:, :, fy1:fy2, fx1:fx2] = 1.0
    return m


# ------------------------- Server state -------------------------
class LockReq(BaseModel):
    image: str
    # Be permissive: accept any dict and coerce later to {x,y,w,h} floats
    box: Optional[Dict[str, Any]] = None  # normalized [0,1]
    ref_image: Optional[str] = None
    return_heatmap: bool = False
    threshold: Optional[float] = 0.65
    search_pad: Optional[int] = 0  # pixels
    # Accept list of numbers or omit entirely
    scales: Optional[List[float]] = Field(default_factory=lambda: [0.85, 1.0, 1.2])


class StepReq(BaseModel):
    track_id: str
    image: str
    return_heatmap: Optional[bool] = False


class AddViewReq(BaseModel):
    track_id: str
    image: Optional[str] = None
    box: Optional[Dict[str, float]] = None
    ref_image: Optional[str] = None


class UnlockReq(BaseModel):
    track_id: str


class TrackState:
    def __init__(self, track_id: str, img_size: Tuple[int, int], init_box_abs: Tuple[int, int, int, int],
                 threshold: float, search_pad: int, scale_options: List[float], descriptors: List[DescriptorEntry],
                 max_views: int = MAX_VIEWS, next_view_id: int = 1, view_order: Optional[List[int]] = None):
        self.track_id = track_id
        self.img_size = img_size  # (W,H)
        self.box_abs = init_box_abs  # (x,y,w,h) integers
        self.threshold = float(threshold)
        self.search_pad = int(search_pad)
        self.scale_options = list(scale_options or [1.0])
        self.descriptors: List[DescriptorEntry] = list(descriptors)
        self.max_views = int(max(1, max_views))
        self.view_order: List[int] = list(view_order or [])
        if not self.view_order:
            for entry in self.descriptors:
                if entry.view_id not in self.view_order:
                    self.view_order.append(entry.view_id)
        else:
            # ensure view_order contains existing descriptor views
            existing_views = {entry.view_id for entry in self.descriptors}
            for v in list(self.view_order):
                if v not in existing_views:
                    self.view_order.remove(v)
            for entry in self.descriptors:
                if entry.view_id not in self.view_order:
                    self.view_order.append(entry.view_id)
        self.next_view_id = max(next_view_id, (max(self.view_order) + 1 if self.view_order else 1))
        self.last_score: float = 0.0
        # persistence
        self.cache_path = os.path.join("data", "locktrack", f"{track_id}.npz")

    def to_rel_box(self) -> Dict[str, float]:
        return rel_from_abs(*self.box_abs, self.img_size)

    def num_views(self) -> int:
        return len(self.view_order)

    def add_descriptors(self, entries: List[DescriptorEntry]) -> List[int]:
        if not entries:
            return []
        removed: List[int] = []
        self.descriptors.extend(entries)
        for entry in entries:
            if entry.view_id not in self.view_order:
                self.view_order.append(entry.view_id)
        # Enforce max views by removing oldest
        while len(self.view_order) > self.max_views and self.view_order:
            oldest = self.view_order.pop(0)
            removed.append(oldest)
            self.descriptors = [d for d in self.descriptors if d.view_id != oldest]
        existing = [d.view_id for d in self.descriptors]
        if existing:
            self.next_view_id = max(self.next_view_id, max(existing) + 1)
        else:
            self.next_view_id = max(self.next_view_id, 1)
        return removed

    def remove_view(self, view_id: int) -> bool:
        if view_id not in self.view_order:
            return False
        if len(self.view_order) <= 1:
            return False
        self.view_order = [v for v in self.view_order if v != view_id]
        self.descriptors = [d for d in self.descriptors if d.view_id != view_id]
        return True


# Global state
TRACKS: Dict[str, TrackState] = {}


# ------------------------- App init (no lazy load) -------------------------
PORT = int(os.environ.get("LOCKTRACK_PORT", "9010"))

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize backbone at import time (no lazy loading)
BACKBONE = FeatureBackbone().to(DEVICE).float().eval()


def _ensure_dirs():
    os.makedirs(os.path.join("data", "locktrack"), exist_ok=True)


def _save_state(ts: TrackState, ref_crop: Optional[Image.Image] = None, view_id: Optional[int] = None):
    try:
        _ensure_dirs()
        if ts.descriptors:
            desc_stack = torch.stack([entry.tensor.detach().to('cpu') for entry in ts.descriptors], dim=0).numpy()
            ref_scales = np.array([entry.scale for entry in ts.descriptors], dtype=np.float32)
            ref_base_w = np.array([entry.base_wh[0] for entry in ts.descriptors], dtype=np.int32)
            ref_base_h = np.array([entry.base_wh[1] for entry in ts.descriptors], dtype=np.int32)
            ref_view_ids = np.array([entry.view_id for entry in ts.descriptors], dtype=np.int32)
        else:
            desc_stack = np.zeros((0, 1), dtype=np.float32)
            ref_scales = np.zeros((0,), dtype=np.float32)
            ref_base_w = np.zeros((0,), dtype=np.int32)
            ref_base_h = np.zeros((0,), dtype=np.int32)
            ref_view_ids = np.zeros((0,), dtype=np.int32)

        np.savez_compressed(
            ts.cache_path,
            ref_descs=desc_stack,
            ref_scales=ref_scales,
            ref_base_w=ref_base_w,
            ref_base_h=ref_base_h,
            ref_view_ids=ref_view_ids,
            img_w=int(ts.img_size[0]),
            img_h=int(ts.img_size[1]),
            x=int(ts.box_abs[0]),
            y=int(ts.box_abs[1]),
            w=int(ts.box_abs[2]),
            h=int(ts.box_abs[3]),
            threshold=float(ts.threshold),
            search_pad=int(ts.search_pad),
            scale_options=np.array(ts.scale_options, dtype=np.float32),
            max_views=int(ts.max_views),
            next_view_id=int(ts.next_view_id),
            view_order=np.array(ts.view_order, dtype=np.int32),
        )
        if ref_crop is not None:
            suffix = f"_view{view_id}" if view_id is not None else "_ref"
            ref_path = ts.cache_path.replace(".npz", f"{suffix}.png")
            ref_crop.save(ref_path)
    except Exception as e:
        print(f"[locktrack] persist warning: {e}")


def _load_state(track_id: str) -> Optional[TrackState]:
    path = os.path.join("data", "locktrack", f"{track_id}.npz")
    if not os.path.isfile(path):
        return None
    try:
        data = np.load(path, allow_pickle=False)
        W = int(data['img_w']); H = int(data['img_h'])
        x = int(data['x']); y = int(data['y']); w = int(data['w']); h = int(data['h'])
        threshold = float(data['threshold']); search_pad = int(data['search_pad'])
        if 'ref_scales' in data and 'ref_base_w' in data and 'ref_base_h' in data and 'ref_view_ids' in data:
            ref_descs_np = data['ref_descs']
            ref_scales = data['ref_scales']
            ref_base_w = data['ref_base_w']
            ref_base_h = data['ref_base_h']
            ref_view_ids = data['ref_view_ids']
            descriptors: List[DescriptorEntry] = []
            for i in range(ref_descs_np.shape[0]):
                tensor = torch.from_numpy(ref_descs_np[i]).to(device=DEVICE, dtype=torch.float32)
                descriptors.append(DescriptorEntry(tensor, float(ref_scales[i]), (int(ref_base_w[i]), int(ref_base_h[i])), int(ref_view_ids[i])))
            scale_options = data['scale_options'].tolist() if 'scale_options' in data else [float(v) for v in ref_scales.tolist()] if ref_scales.size else [1.0]
            max_views = int(data['max_views']) if 'max_views' in data else MAX_VIEWS
            view_order = data['view_order'].tolist() if 'view_order' in data else []
            next_view_id = int(data['next_view_id']) if 'next_view_id' in data else ((max(ref_view_ids) + 1) if len(ref_view_ids) else 1)
        else:
            # Legacy format
            ref_descs_np = data['ref_descs']
            legacy_scales = data['scales'].tolist() if 'scales' in data else [1.0] * len(ref_descs_np)
            descriptors = []
            for i in range(ref_descs_np.shape[0]):
                tensor = torch.from_numpy(ref_descs_np[i]).to(device=DEVICE, dtype=torch.float32)
                scale = float(legacy_scales[i]) if i < len(legacy_scales) else 1.0
                descriptors.append(DescriptorEntry(tensor, scale, (w, h), 0))
            scale_options = list(legacy_scales) if legacy_scales else [1.0]
            max_views = MAX_VIEWS
            view_order = [0] if descriptors else []
            next_view_id = 1
        ts = TrackState(track_id, (W, H), (x, y, w, h), threshold, search_pad, scale_options, descriptors, max_views=max_views, next_view_id=next_view_id, view_order=view_order)
        TRACKS[track_id] = ts
        return ts
    except Exception as e:
        print(f"[locktrack] load state failed: {e}")
        return None


def _delete_view_image(ts: TrackState, view_id: int):
    suffixes = [f"_view{view_id}.png"]
    if view_id == 0:
        suffixes.append("_ref.png")
    for suffix in suffixes:
        path = ts.cache_path.replace(".npz", suffix)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except Exception:
            pass


# ------------------------- Endpoints -------------------------
@app.get('/health')
def health():
    return {
        'status': 'ok',
        'device': str(DEVICE),
        'dtype': str(torch.get_default_dtype()),
    }


@app.post('/realtime/locktrack/echo')
async def echo_endpoint(request: Request):
    raw = await request.body()
    try:
        j = await request.json()
    except Exception as e:
        j = {'error': f'json parse failed: {e}'}
    return {
        'content_type': request.headers.get('content-type'),
        'length': len(raw),
        'json': j,
    }


@app.post('/realtime/locktrack/lock')
async def lock_endpoint(request: Request):
    # Debug headers/body size
    try:
        ct = request.headers.get('content-type')
        blen = int(request.headers.get('content-length') or '0')
        print(f"[locktrack] /lock content-type={ct} content-length={blen}")
    except Exception:
        pass
    try:
        payload = await request.json()
    except Exception as e:
        return {'error': f'bad json: {e}'}
    # Coerce fields with defaults
    image_s = payload.get('image')
    if not isinstance(image_s, str):
        return {'error': 'missing image'}
    box_in = payload.get('box') if isinstance(payload.get('box'), dict) else None
    ref_image_s = payload.get('ref_image') if isinstance(payload.get('ref_image'), str) else None
    return_heatmap = bool(payload.get('return_heatmap', False))
    threshold = float(payload.get('threshold', 0.65))
    search_pad = int(payload.get('search_pad', 0))
    scales = payload.get('scales', [0.85, 1.0, 1.2])
    image_max_side = int(payload.get('image_max_side', os.environ.get('LOCKTRACK_MAX_SIDE', '0')))
    try:
        scales = [float(x) for x in (scales or [1.0])]
    except Exception:
        scales = [1.0]
    try:
        img = decode_image_to_pil(image_s)
    except Exception as e:
        return {'error': f'bad image: {e}'}

    W, H = img.size
    # Optional downscale for processing
    img_proc = img
    Wp, Hp = W, H
    sx = sy = 1.0
    if isinstance(image_max_side, int) and image_max_side > 0 and max(W, H) > image_max_side:
        s = image_max_side / float(max(W, H))
        Wp = max(1, int(round(W * s)))
        Hp = max(1, int(round(H * s)))
        img_proc = img.resize((Wp, Hp), Image.BILINEAR)
        sx = Wp / float(W)
        sy = Hp / float(H)
    box_rel: Dict[str, float]
    if box_in is not None and isinstance(box_in, dict):
        try:
            # Coerce values and alias possible keys
            x = float(box_in.get('x', box_in.get('left', 0.0)))
            y = float(box_in.get('y', box_in.get('top', 0.0)))
            # Support x1,x2,y1,y2 form
            if 'w' in box_in and 'h' in box_in:
                w = float(box_in.get('w'))
                h = float(box_in.get('h'))
            else:
                x1 = float(box_in.get('x1', x))
                y1 = float(box_in.get('y1', y))
                x2 = float(box_in.get('x2', x1))
                y2 = float(box_in.get('y2', y1))
                x, y, w, h = x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)
            box_rel = norm_box({'x': x, 'y': y, 'w': w, 'h': h})
        except Exception:
            # Fallback to heuristic box on any parse error
            s = 0.2
            box_rel = {'x': (1 - s)/2, 'y': (1 - s)/2, 'w': s, 'h': s}
    else:
        # Heuristic: 20% of min dimension centered if no box provided
        s = 0.2
        box_rel = {'x': (1 - s)/2, 'y': (1 - s)/2, 'w': s, 'h': s}

    box_abs = abs_from_rel(box_rel, (W, H))

    # Build reference crop
    ref_crop: Image.Image
    if ref_image_s:
        try:
            ref_crop = decode_image_to_pil(ref_image_s)
        except Exception as e:
            return {'error': f'bad ref_image: {e}'}
    else:
        ref_crop = crop_pil(img, box_abs)
    ref_w0, ref_h0 = ref_crop.size

    scale_list = [float(x) for x in (scales or [1.0])]
    entries: List[DescriptorEntry] = []
    for s in scale_list:
        if s != 1.0:
            w_s = max(1, int(round(ref_crop.width * s)))
            h_s = max(1, int(round(ref_crop.height * s)))
            crop_s = ref_crop.resize((w_s, h_s), Image.BILINEAR)
        else:
            crop_s = ref_crop
        d = compute_descriptor(BACKBONE, crop_s, DEVICE)
        entries.append(DescriptorEntry(d, float(s), (ref_w0, ref_h0), view_id=0))

    tid = uuid.uuid4().hex[:12]
    ts = TrackState(tid, (W, H), box_abs, threshold, search_pad, scale_list, entries, max_views=MAX_VIEWS, next_view_id=1, view_order=[0])
    TRACKS[tid] = ts
    _save_state(ts, ref_crop=ref_crop, view_id=0)

    # Optionally compute heatmap on the initial frame
    resp: Dict[str, Any] = {
        'track_id': tid,
        'init_box': ts.to_rel_box(),
        'score': None,
        'status': 'locked',
        'num_views': ts.num_views(),
    }

    try:
        with torch.inference_mode():
            fmap = compute_feature_map(BACKBONE, img_proc, DEVICE)
            Hf, Wf = int(fmap.shape[2]), int(fmap.shape[3])
            # Scale last box to processed resolution for mask
            xb, yb, wb, hb = ts.box_abs
            xb_p = int(round(xb * sx)); yb_p = int(round(yb * sy))
            wb_p = max(1, int(round(wb * sx))); hb_p = max(1, int(round(hb * sy)))
            pad_p = int(round(ts.search_pad * 0.5 * (sx + sy)))
            search_mask = make_search_mask(Hf, Wf, (xb_p, yb_p, wb_p, hb_p), (Wp, Hp), pad_p)
            # Per-scale maps to recover best scale at peak
            if not ts.descriptors:
                raise RuntimeError('descriptor pool empty after lock')
            maps: List[torch.Tensor] = []
            for entry in ts.descriptors:
                w = entry.tensor.view(1, -1, 1, 1)
                m = (fmap * w).sum(dim=1, keepdim=True)
                maps.append(m if search_mask is None else m * search_mask)
            out = maps[0]
            for i in range(1, len(maps)):
                out = torch.maximum(out, maps[i])
            val, idx = torch.max(out.view(-1), dim=0)
            score = float(val.item())
            ts.last_score = score
            resp['score'] = score
            # Snap initial box to heatmap peak with adaptive refinement
            cx = float(ts.box_abs[0] + ts.box_abs[2] * 0.5)
            cy = float(ts.box_abs[1] + ts.box_abs[3] * 0.5)
            if Hf > 0 and Wf > 0:
                iy = int(idx.item()) // Wf
                ix = int(idx.item()) - iy * Wf
                best_si = 0
                best_v = maps[0].view(-1)[idx].item()
                for si in range(1, len(maps)):
                    v = maps[si].view(-1)[idx].item()
                    if v > best_v:
                        best_v = v
                        best_si = si
                best_entry = ts.descriptors[best_si]
                scale_at_peak = best_entry.scale
                base_w, base_h = best_entry.base_wh
                w_det = max(1, int(round(base_w * scale_at_peak)))
                h_det = max(1, int(round(base_h * scale_at_peak)))
                rx, ry = _compute_window_radii((w_det, h_det), (Hf, Wf), (W, H))
                iy_c, ix_c = refine_peak_center(out, ix, iy, rx, ry)
                cx_p = (ix_c + 0.5) * (Wp / max(1, Wf))
                cy_p = (iy_c + 0.5) * (Hp / max(1, Hf))
                cx = cx_p / max(1e-6, sx)
                cy = cy_p / max(1e-6, sy)
                x_new = int(round(cx - w_det / 2))
                y_new = int(round(cy - h_det / 2))
                x_new = max(0, min(W - w_det, x_new))
                y_new = max(0, min(H - h_det, y_new))
                ts.box_abs = (x_new, y_new, w_det, h_det)
                ts.img_size = (W, H)
                resp['init_box'] = ts.to_rel_box()

            if return_heatmap:
                hm_np = out.squeeze(0).squeeze(0).detach().to('cpu').numpy()
                cmap = str(payload.get('heatmap_cmap', 'jet'))
                # Draw crosshair at peak
                cross = (int(max(0, min(W - 1, round(cx)))), int(max(0, min(H - 1, round(cy)))))
                resp['heatmap'] = make_heatmap_png(hm_np, (W, H), cmap=cmap, cross_xy=cross)
    except Exception as e:
        print(f"[locktrack] heatmap on lock failed: {e}")

    return resp


@app.post('/realtime/locktrack/step')
async def step_endpoint(request: Request):
    try:
        ct = request.headers.get('content-type')
        blen = int(request.headers.get('content-length') or '0')
        print(f"[locktrack] /step content-type={ct} content-length={blen}")
    except Exception:
        pass
    try:
        payload = await request.json()
    except Exception as e:
        return {'error': f'bad json: {e}'}
    track_id = payload.get('track_id')
    image_s = payload.get('image')
    return_heatmap = bool(payload.get('return_heatmap', False))
    ts = TRACKS.get(track_id) or _load_state(track_id or '')
    if ts is None:
        return {'error': 'unknown track_id'}
    try:
        img = decode_image_to_pil(image_s)
    except Exception as e:
        return {'error': f'bad image: {e}'}

    W, H = img.size
    # Optional downscale for processing
    image_max_side = int(payload.get('image_max_side', os.environ.get('LOCKTRACK_MAX_SIDE', '0')))
    img_proc = img
    Wp, Hp = W, H
    sx = sy = 1.0
    if isinstance(image_max_side, int) and image_max_side > 0 and max(W, H) > image_max_side:
        s = image_max_side / float(max(W, H))
        Wp = max(1, int(round(W * s)))
        Hp = max(1, int(round(H * s)))
        img_proc = img.resize((Wp, Hp), Image.BILINEAR)
        sx = Wp / float(W)
        sy = Hp / float(H)

    with torch.inference_mode():
        fmap = compute_feature_map(BACKBONE, img_proc, DEVICE)
        Hf, Wf = int(fmap.shape[2]), int(fmap.shape[3])

        # Optional search region gating
        xb, yb, wb, hb = ts.box_abs
        xb_p = int(round(xb * sx)); yb_p = int(round(yb * sy))
        wb_p = max(1, int(round(wb * sx))); hb_p = max(1, int(round(hb * sy)))
        pad_p = int(round(ts.search_pad * 0.5 * (sx + sy)))
        search_mask = make_search_mask(Hf, Wf, (xb_p, yb_p, wb_p, hb_p), (Wp, Hp), pad_p)
        # Per-scale maps to recover best scale at peak
        if not ts.descriptors:
            return {'error': 'descriptor pool empty'}
        maps: List[torch.Tensor] = []
        for entry in ts.descriptors:
            w = entry.tensor.view(1, -1, 1, 1)
            m = (fmap * w).sum(dim=1, keepdim=True)
            maps.append(m if search_mask is None else m * search_mask)
        out = maps[0]
        for i in range(1, len(maps)):
            out = torch.maximum(out, maps[i])
        val, idx = torch.max(out.view(-1), dim=0)
        score = float(val.item())
        iy = int(idx.item()) // Wf
        ix = int(idx.item()) - iy * Wf
        # Snap peak to image coords with adaptive refinement
        cx = float(ts.box_abs[0] + ts.box_abs[2] * 0.5)
        cy = float(ts.box_abs[1] + ts.box_abs[3] * 0.5)
        best_si = 0
        best_v = maps[0].view(-1)[idx].item()
        for si in range(1, len(maps)):
            v = maps[si].view(-1)[idx].item()
            if v > best_v:
                best_v = v
                best_si = si
        best_entry = ts.descriptors[best_si]
        scale_at_peak = best_entry.scale
        base_w, base_h = best_entry.base_wh
        w_det = max(1, int(round(base_w * scale_at_peak)))
        h_det = max(1, int(round(base_h * scale_at_peak)))
        if Hf > 0 and Wf > 0:
            rx, ry = _compute_window_radii((w_det, h_det), (Hf, Wf), (W, H))
            iy_c, ix_c = refine_peak_center(out, ix, iy, rx, ry)
            cx_p = (ix_c + 0.5) * (Wp / max(1, Wf))
            cy_p = (iy_c + 0.5) * (Hp / max(1, Hf))
            cx = cx_p / max(1e-6, sx)
            cy = cy_p / max(1e-6, sy)
        x_new = int(round(cx - w_det / 2))
        y_new = int(round(cy - h_det / 2))
        # Clamp
        x_new = max(0, min(W - w_det, x_new))
        y_new = max(0, min(H - h_det, y_new))
        box_new = (x_new, y_new, w_det, h_det)

    status = 'tracking' if score >= ts.threshold else 'searching'
    if status == 'tracking':
        ts.box_abs = box_new
        ts.img_size = (W, H)  # update size in case input changed
        ts.last_score = score
        _save_state(ts)
    else:
        # Do not update box; if repeatedly below threshold, caller may treat as lost
        ts.last_score = score

    # Return the candidate box even when searching so UI can visualize motion
    resp: Dict[str, Any] = {
        'box': rel_from_abs(*box_new, (W, H)),
        'score': score,
        'status': status,
        'num_views': ts.num_views(),
    }

    if return_heatmap:
        hm_np = out.squeeze(0).squeeze(0).detach().to('cpu').numpy()
        cmap = str(payload.get('heatmap_cmap', 'jet'))
        cross = (int(max(0, min(W - 1, round(cx)))), int(max(0, min(H - 1, round(cy)))))
        resp['heatmap'] = make_heatmap_png(hm_np, (W, H), cmap=cmap, cross_xy=cross)

    return resp


@app.post('/realtime/locktrack/add_view')
async def add_view_endpoint(request: Request):
    try:
        payload = await request.json()
    except Exception as e:
        return {'error': f'bad json: {e}'}
    track_id = payload.get('track_id')
    ts = TRACKS.get(track_id) or _load_state(track_id or '')
    if ts is None:
        return {'error': 'unknown track_id'}

    # For now keep only one view: replace the descriptor with the new one
    crop: Optional[Image.Image] = None
    if isinstance(payload.get('ref_image'), str):
        try:
            crop = decode_image_to_pil(payload['ref_image'])
        except Exception as e:
            return {'error': f'bad ref_image: {e}'}
    elif isinstance(payload.get('image'), str) and isinstance(payload.get('box'), dict):
        try:
            img = decode_image_to_pil(payload['image'])
        except Exception as e:
            return {'error': f'bad image: {e}'}
        box_rel = norm_box(payload['box'])
        crop = crop_pil(img, abs_from_rel(box_rel, img.size))
    else:
        return {'error': 'provide ref_image or image+box'}

    view_id = ts.next_view_id
    with torch.inference_mode():
        scale_opts = ts.scale_options or [1.0]
        entries: List[DescriptorEntry] = []
        base_w, base_h = crop.size
        for s in scale_opts:
            if s != 1.0:
                w_s = max(1, int(round(base_w * s)))
                h_s = max(1, int(round(base_h * s)))
                crop_s = crop.resize((w_s, h_s), Image.BILINEAR)
            else:
                crop_s = crop
            d = compute_descriptor(BACKBONE, crop_s, DEVICE)
            entries.append(DescriptorEntry(d, float(s), (base_w, base_h), view_id=view_id))
    removed_ids = ts.add_descriptors(entries)
    _save_state(ts, ref_crop=crop, view_id=view_id)
    for rid in removed_ids:
        _delete_view_image(ts, rid)
    resp: Dict[str, Any] = {
        'num_views': ts.num_views(),
        'view_id': view_id,
    }
    if removed_ids:
        resp['removed_view_ids'] = removed_ids
    return resp


@app.post('/realtime/locktrack/remove_view')
async def remove_view_endpoint(request: Request):
    try:
        payload = await request.json()
    except Exception as e:
        return {'error': f'bad json: {e}'}
    track_id = payload.get('track_id')
    view_id = payload.get('view_id')
    ts = TRACKS.get(track_id) or _load_state(track_id or '')
    if ts is None:
        return {'error': 'unknown track_id'}
    try:
        view_id_int = int(view_id)
    except Exception:
        return {'error': 'invalid view_id'}
    if ts.num_views() <= 1:
        return {'error': 'cannot remove last view'}
    if not ts.remove_view(view_id_int):
        return {'error': 'view_id not found or cannot remove'}
    _delete_view_image(ts, view_id_int)
    _save_state(ts)
    return {'num_views': ts.num_views()}


@app.post('/realtime/locktrack/unlock')
async def unlock_endpoint(request: Request):
    try:
        payload = await request.json()
    except Exception as e:
        return {'error': f'bad json: {e}'}
    track_id = payload.get('track_id')
    ts = TRACKS.pop(track_id, None)
    # Keep .npz on disk for potential re‑acquire later; no deletion here
    return {'ack': True}


if __name__ == '__main__':
    import uvicorn  # type: ignore
    print(f"[locktrack] Starting on port {PORT} device={DEVICE} dtype={torch.get_default_dtype()}")
    uvicorn.run(app, host='0.0.0.0', port=PORT)
