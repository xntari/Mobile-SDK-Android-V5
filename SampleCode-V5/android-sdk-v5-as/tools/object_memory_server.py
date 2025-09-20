#!/usr/bin/env python3
"""
Object memory microservice for LockTrack / YOLO integration.

Features
- ingest object crops to build an embedding-backed cluster memory.
- search for best matching cluster to recover prior labels.
- browse clusters, relabel, merge, or prune samples.

Persistence is handled via simple pickle serialization so the state can be
restored on restart without an external database. Embeddings and metadata live
in-memory for fast lookups; cosine similarity on MobileNetV3 descriptors keeps
search efficient for the scale of expected samples (< few tens of thousands).

Run
  python tools/object_memory_server.py

Environment variables
  OBJECT_MEMORY_PORT   (default: 9012)
  OBJECT_MEMORY_SAVE_INTERVAL (seconds, default 5)
  OBJECT_MEMORY_ATTACH_THRESHOLD (default 0.82)
  OBJECT_MEMORY_CREATE_THRESHOLD (default 0.70)

API (see README/LOCKTRACK doc for full spec)
  POST /memory/ingest
  POST /memory/search
  GET  /memory/clusters
  GET  /memory/clusters/{cluster_id}
  POST /memory/clusters/{cluster_id}/label
  POST /memory/clusters/merge
  DELETE /memory/samples/{sample_id}
  GET  /memory/samples/{sample_id}/image
"""
from __future__ import annotations

import base64
import io
import os
import pickle
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image

import torch
import torch.nn.functional as F

try:
    from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights  # type: ignore
except Exception as e:  # pragma: no cover
    raise RuntimeError("torchvision is required: pip install torchvision") from e


# ------------------------- Constants -------------------------
torch.set_default_dtype(torch.float32)
if torch.backends.mps.is_available():
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

DEVICE = torch.device("mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu"))

STATE_DIR = os.path.join("data", "object_memory")
STATE_PATH = os.path.join(STATE_DIR, "state.pkl")
SAMPLES_DIR = os.path.join(STATE_DIR, "samples")

ATTACH_THRESHOLD = float(os.environ.get("OBJECT_MEMORY_ATTACH_THRESHOLD", "0.82"))
CREATE_THRESHOLD = float(os.environ.get("OBJECT_MEMORY_CREATE_THRESHOLD", "0.70"))
SAVE_INTERVAL = float(os.environ.get("OBJECT_MEMORY_SAVE_INTERVAL", "5"))
DEFAULT_MAX_SAMPLES = int(os.environ.get("OBJECT_MEMORY_MAX_SAMPLES", "50"))
DEFAULT_DEDUPE_THRESHOLD = float(os.environ.get("OBJECT_MEMORY_DEDUPE_THRESHOLD", "0.985"))


# ------------------------- Embedding Backbone -------------------------
class FeatureBackbone(torch.nn.Module):
    def __init__(self):
        super().__init__()
        try:
            weights = getattr(MobileNet_V3_Small_Weights, 'DEFAULT', MobileNet_V3_Small_Weights.IMAGENET1K_V1)
            model = mobilenet_v3_small(weights=weights)
        except Exception:
            model = mobilenet_v3_small(pretrained=True)  # type: ignore[arg-type]
        model.eval()
        self.features = model.features
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
        return self.features(x)


BACKBONE = FeatureBackbone().to(DEVICE).float().eval()


def decode_image_to_pil(image_b64_or_dataurl: str) -> Image.Image:
    data = image_b64_or_dataurl
    if data.startswith("data:"):
        _, b64 = data.split(",", 1)
    else:
        b64 = data
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def pil_to_tensor_float(img: Image.Image) -> torch.Tensor:
    arr = np.array(img, dtype=np.uint8, copy=True)
    t = torch.from_numpy(arr).permute(2, 0, 1).contiguous()
    return t.float() / 255.0


@torch.inference_mode()
def compute_embedding(img: Image.Image) -> np.ndarray:
    x = pil_to_tensor_float(img.resize((192, 192), Image.BILINEAR)).unsqueeze(0)
    mean = BACKBONE.mean.to(x.dtype).to('cpu')
    std = BACKBONE.std.to(x.dtype).to('cpu')
    x = (x - mean) / std
    x = x.to(device=DEVICE, dtype=torch.float32, non_blocking=False)
    f = BACKBONE(x)
    d = f.mean(dim=(2, 3))
    d = F.normalize(d, p=2, dim=1)
    return d.squeeze(0).detach().to('cpu').numpy().astype(np.float32)


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 1e-6:
        return 0.0
    return float(np.dot(a, b) / denom)


def ensure_dirs():
    os.makedirs(SAMPLES_DIR, exist_ok=True)


# ------------------------- Data structures -------------------------
@dataclass
class SampleEntry:
    sample_id: str
    cluster_id: str
    created_ts: float
    track_ids: List[str]
    embedding: np.ndarray
    image_path: str
    telemetry: Dict[str, Any]

    def to_dict(self) -> Dict[str, any]:
        return {
            'sample_id': self.sample_id,
            'cluster_id': self.cluster_id,
            'created_ts': self.created_ts,
            'track_ids': list(self.track_ids),
            'image_path': self.image_path,
            'telemetry': self.telemetry,
        }


@dataclass
class ClusterEntry:
    cluster_id: str
    created_ts: float
    updated_ts: float
    centroid: np.ndarray
    sample_ids: List[str]
    label: Optional[str]
    status: str  # 'unknown' | 'named'
    merged_from: List[str]
    max_samples: int
    dedupe_threshold: float

    def to_dict(self) -> Dict[str, any]:
        return {
            'cluster_id': self.cluster_id,
            'created_ts': self.created_ts,
            'updated_ts': self.updated_ts,
            'sample_count': len(self.sample_ids),
            'label': self.label,
            'status': self.status,
            'merged_from': list(self.merged_from),
            'max_samples': int(self.max_samples),
            'dedupe_threshold': float(self.dedupe_threshold),
        }


SAMPLES: Dict[str, SampleEntry] = {}
CLUSTERS: Dict[str, ClusterEntry] = {}
SAVE_PENDING = False
SAVE_LOCK = threading.Lock()


def serialize_state(path: str) -> None:
    ensure_dirs()
    state = {
        'clusters': {
            cid: {
                'cluster_id': c.cluster_id,
                'created_ts': c.created_ts,
                'updated_ts': c.updated_ts,
                'centroid': c.centroid,
                'sample_ids': list(c.sample_ids),
                'label': c.label,
                'status': c.status,
                'merged_from': list(c.merged_from),
                'max_samples': int(c.max_samples),
                'dedupe_threshold': float(c.dedupe_threshold),
            }
            for cid, c in CLUSTERS.items()
        },
        'samples': {
            sid: {
                'sample_id': s.sample_id,
                'cluster_id': s.cluster_id,
                'created_ts': s.created_ts,
                'track_ids': list(s.track_ids),
                'embedding': s.embedding,
                'image_path': s.image_path,
                'telemetry': s.telemetry,
            }
            for sid, s in SAMPLES.items()
        },
    }
    tmp_path = path + ".tmp"
    with open(tmp_path, 'wb') as f:
        pickle.dump(state, f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp_path, path)


def load_state(path: str) -> None:
    if not os.path.isfile(path):
        return
    try:
        with open(path, 'rb') as f:
            data = pickle.load(f)
        clusters = data.get('clusters', {})
        samples = data.get('samples', {})
        CLUSTERS.clear()
        for cid, c in clusters.items():
            centroid = np.array(c['centroid'], dtype=np.float32)
            CLUSTERS[cid] = ClusterEntry(
                cluster_id=c['cluster_id'],
                created_ts=float(c['created_ts']),
                updated_ts=float(c.get('updated_ts', c['created_ts'])),
                centroid=centroid,
                sample_ids=list(c['sample_ids']),
                label=c.get('label'),
                status=str(c.get('status', 'unknown')),
                merged_from=list(c.get('merged_from', [])),
                max_samples=int(c.get('max_samples', DEFAULT_MAX_SAMPLES)),
                dedupe_threshold=float(c.get('dedupe_threshold', DEFAULT_DEDUPE_THRESHOLD)),
            )
        SAMPLES.clear()
        for sid, s in samples.items():
            embedding = np.array(s['embedding'], dtype=np.float32)
            SAMPLES[sid] = SampleEntry(
                sample_id=s['sample_id'],
                cluster_id=s['cluster_id'],
                created_ts=float(s['created_ts']),
                track_ids=list(s.get('track_ids', [])),
                embedding=embedding,
                image_path=s['image_path'],
                telemetry=dict(s.get('telemetry') or {}),
            )
    except Exception as e:
        print(f"[object_memory] failed to load state: {e}")


def schedule_save():
    global SAVE_PENDING
    with SAVE_LOCK:
        if SAVE_PENDING:
            return
        SAVE_PENDING = True

    def _save_worker():
        time.sleep(SAVE_INTERVAL)
        try:
            serialize_state(STATE_PATH)
        finally:
            global SAVE_PENDING
            with SAVE_LOCK:
                SAVE_PENDING = False

    threading.Thread(target=_save_worker, daemon=True).start()


def get_or_create_cluster(embedding: np.ndarray, track_id: Optional[str]) -> Tuple[ClusterEntry, bool, float]:
    best_id = None
    best_sim = -1.0
    for cid, cluster in CLUSTERS.items():
        sim = cosine_sim(cluster.centroid, embedding)
        if sim > best_sim:
            best_sim = sim
            best_id = cid

    if best_id is not None and best_sim >= ATTACH_THRESHOLD:
        return CLUSTERS[best_id], False, best_sim

    if best_id is not None and best_sim >= CREATE_THRESHOLD:
        # attach to best cluster anyway but mark low confidence (status unchanged)
        return CLUSTERS[best_id], False, best_sim

    cluster_id = uuid.uuid4().hex[:10]
    cluster = ClusterEntry(
        cluster_id=cluster_id,
        created_ts=time.time(),
        updated_ts=time.time(),
        centroid=embedding.copy(),
        sample_ids=[],
        label=None,
        status='unknown',
        merged_from=[],
        max_samples=DEFAULT_MAX_SAMPLES,
        dedupe_threshold=DEFAULT_DEDUPE_THRESHOLD,
    )
    CLUSTERS[cluster_id] = cluster
    return cluster, True, best_sim


def add_sample(embedding: np.ndarray, image: Image.Image, track_id: Optional[str], telemetry: Optional[Dict[str, Any]] = None) -> Tuple[Optional[SampleEntry], ClusterEntry, float, bool, float]:
    cluster, is_new, similarity = get_or_create_cluster(embedding, track_id)
    # Dedupe: compare against existing embeddings in cluster
    max_existing_sim = -1.0
    if cluster.sample_ids:
        sims = []
        for sid in cluster.sample_ids:
            entry = SAMPLES.get(sid)
            if not entry:
                continue
            sim = cosine_sim(entry.embedding, embedding)
            sims.append(sim)
        if sims:
            max_existing_sim = max(sims)

    sample_id = uuid.uuid4().hex
    ensure_dirs()
    cluster_sample_dir = os.path.join(SAMPLES_DIR, cluster.cluster_id)
    os.makedirs(cluster_sample_dir, exist_ok=True)
    img_path = os.path.join(cluster_sample_dir, f"{sample_id}.jpg")
    image.save(img_path, format='JPEG', quality=92)

    entry = SampleEntry(
        sample_id=sample_id,
        cluster_id=cluster.cluster_id,
        created_ts=time.time(),
        track_ids=[str(track_id)] if track_id else [],
        embedding=embedding,
        image_path=img_path,
        telemetry=telemetry or {},
    )
    SAMPLES[sample_id] = entry

    cluster.sample_ids.append(sample_id)
    if len(cluster.sample_ids) > cluster.max_samples:
        trim_cluster_to_limit(cluster)
    else:
        # Update centroid incrementally only when no trimming occurred
        emb_tensor = embedding
        if cluster.centroid is None or cluster.centroid.shape != emb_tensor.shape:
            cluster.centroid = emb_tensor.copy()
        else:
            n = len(cluster.sample_ids)
            old = cluster.centroid
            cluster.centroid = old + (emb_tensor - old) / max(1, n)
            norm = np.linalg.norm(cluster.centroid)
            if norm > 1e-6:
                cluster.centroid = cluster.centroid / norm

    cluster.updated_ts = time.time()

    schedule_save()
    return entry, cluster, similarity, True, max_existing_sim


def remove_sample_internal(sample_id: str) -> None:
    entry = SAMPLES.pop(sample_id, None)
    if not entry:
        return
    try:
        if os.path.isfile(entry.image_path):
            os.remove(entry.image_path)
    except Exception:
        pass
    cluster = CLUSTERS.get(entry.cluster_id)
    if cluster:
        cluster.sample_ids = [sid for sid in cluster.sample_ids if sid != sample_id]
        if not cluster.sample_ids:
            CLUSTERS.pop(cluster.cluster_id, None)
        else:
            recompute_cluster_centroid(cluster)
            cluster.updated_ts = time.time()


def remove_cluster(cluster_id: str) -> None:
    cluster = CLUSTERS.pop(cluster_id, None)
    if not cluster:
        return
    for sid in list(cluster.sample_ids):
        entry = SAMPLES.pop(sid, None)
        if entry:
            try:
                if os.path.isfile(entry.image_path):
                    os.remove(entry.image_path)
            except Exception:
                pass
    cluster_dir = os.path.join(SAMPLES_DIR, cluster_id)
    try:
        if os.path.isdir(cluster_dir):
            shutil.rmtree(cluster_dir, ignore_errors=True)
    except Exception:
        pass


def recompute_cluster_centroid(cluster: ClusterEntry) -> None:
    vecs = [SAMPLES[sid].embedding for sid in cluster.sample_ids if sid in SAMPLES]
    if not vecs:
        cluster.centroid = np.zeros_like(cluster.centroid)
        return
    centroid = np.mean(vecs, axis=0)
    norm = np.linalg.norm(centroid)
    if norm > 1e-6:
        centroid = centroid / norm
    cluster.centroid = centroid.astype(np.float32)


def trim_cluster_to_limit(cluster: ClusterEntry) -> None:
    changed = False
    while len(cluster.sample_ids) > cluster.max_samples:
        embeddings = []
        ids: List[str] = []
        for sid in cluster.sample_ids:
            entry = SAMPLES.get(sid)
            if not entry:
                continue
            embeddings.append(entry.embedding)
            ids.append(sid)
        if len(ids) <= cluster.max_samples:
            break
        mat = np.stack(embeddings, axis=0)
        sims = mat @ mat.T
        np.fill_diagonal(sims, -np.inf)
        max_sim = sims.max(axis=1)
        idx = int(np.argmax(max_sim))
        sid_remove = ids[idx]
        remove_sample_internal(sid_remove)
        changed = True
    if changed:
        recompute_cluster_centroid(cluster)
        cluster.updated_ts = time.time()


def cluster_mean_similarity(cluster: ClusterEntry) -> float:
    if cluster.centroid is None or not cluster.sample_ids:
        return 0.0
    centroid = cluster.centroid
    norm = np.linalg.norm(centroid)
    if norm <= 1e-6:
        return 0.0
    sims = []
    for sid in cluster.sample_ids:
        entry = SAMPLES.get(sid)
        if not entry:
            continue
        sims.append(float(np.dot(entry.embedding, centroid)))
    return float(np.mean(sims)) if sims else 0.0


def cluster_neighbor_summary() -> Dict[str, Dict[str, Optional[Any]]]:
    ids: List[str] = []
    vecs: List[np.ndarray] = []
    for cid, cluster in CLUSTERS.items():
        centroid = cluster.centroid
        if centroid is None:
            continue
        norm = np.linalg.norm(centroid)
        if norm <= 1e-6:
            continue
        ids.append(cid)
        vecs.append(centroid.astype(np.float32))
    summary: Dict[str, Dict[str, Optional[Any]]] = {}
    if len(ids) >= 2:
        mat = np.stack(vecs, axis=0)
        sims = mat @ mat.T
        np.fill_diagonal(sims, -np.inf)
        for idx, cid in enumerate(ids):
            row = sims[idx]
            max_idx = int(np.argmax(row)) if row.size > 0 else -1
            max_val = float(row[max_idx]) if row.size > 0 else float('-inf')
            if not np.isfinite(max_val) or max_val <= -np.inf:
                summary[cid] = {
                    'nearest_neighbor_id': None,
                    'nearest_neighbor_similarity': None,
                }
            else:
                summary[cid] = {
                    'nearest_neighbor_id': ids[max_idx],
                    'nearest_neighbor_similarity': float(np.clip(max_val, -1.0, 1.0)),
                }
    # Ensure entries exist for clusters with insufficient data
    for cid in CLUSTERS.keys():
        summary.setdefault(cid, {
            'nearest_neighbor_id': None,
            'nearest_neighbor_similarity': None,
        })
    return summary


# ------------------------- FastAPI models -------------------------
class OrientationPayload(BaseModel):
    yaw: Optional[float] = None
    pitch: Optional[float] = None
    roll: Optional[float] = None


class PositionPayload(BaseModel):
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    altitude_m: Optional[float] = None


class ObjectPositionPayload(PositionPayload):
    distance_m: Optional[float] = None


class SampleTelemetryPayload(BaseModel):
    drone_position: Optional[PositionPayload] = None
    drone_orientation: Optional[OrientationPayload] = None
    gimbal_orientation: Optional[OrientationPayload] = None
    object_position: Optional[ObjectPositionPayload] = None
    object_orientation: Optional[OrientationPayload] = None
    source_camera: Optional[str] = None
    timestamp: Optional[float] = None
    extra: Optional[Dict[str, Any]] = None


class IngestRequest(BaseModel):
    image: str
    track_id: Optional[str] = None
    label: Optional[str] = None
    telemetry: Optional[SampleTelemetryPayload] = None


class SearchRequest(BaseModel):
    image: str


class MergeRequest(BaseModel):
    source_ids: List[str] = Field(default_factory=list)
    target_id: str


class LabelRequest(BaseModel):
    label: str


class ClusterConfigRequest(BaseModel):
    max_samples: Optional[int] = Field(default=None, ge=1, le=500)
    dedupe_threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class PruneRequest(BaseModel):
    similarity: float = Field(0.98, ge=0.0, le=1.0)


# ------------------------- FastAPI app -------------------------
PORT = int(os.environ.get("OBJECT_MEMORY_PORT", "9012"))

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event():
    ensure_dirs()
    load_state(STATE_PATH)
    print(f"[object_memory] loaded {len(CLUSTERS)} clusters, {len(SAMPLES)} samples")


@app.get('/health')
def health():
    return {
        'status': 'ok',
        'device': str(DEVICE),
        'clusters': len(CLUSTERS),
        'samples': len(SAMPLES),
    }


@app.post('/memory/ingest')
def ingest(req: IngestRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f'bad image: {e}')
    emb = compute_embedding(img)
    telemetry_payload: Dict[str, Any] = req.telemetry.dict(exclude_none=True) if req.telemetry else {}
    sample, cluster, similarity, stored, max_existing = add_sample(emb, img, req.track_id, telemetry=telemetry_payload)
    response: Dict[str, Any] = {
        'cluster': cluster.to_dict(),
        'similarity': similarity,
        'stored': stored,
        'max_existing_similarity': max_existing,
    }
    if sample is not None:
        if req.label:
            label = req.label.strip()
            if label:
                cluster.label = label
                cluster.status = 'named'
        response['sample'] = sample.to_dict()
    else:
        response['sample'] = None
    return response


@app.post('/memory/search')
def search(req: SearchRequest):
    if not CLUSTERS:
        return {'match': None}
    try:
        img = decode_image_to_pil(req.image)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f'bad image: {e}')
    emb = compute_embedding(img)
    best_id = None
    best_sim = -1.0
    for cid, cluster in CLUSTERS.items():
        sim = cosine_sim(cluster.centroid, emb)
        if sim > best_sim:
            best_sim = sim
            best_id = cid
    if best_id is None:
        return {'match': None}
    cluster = CLUSTERS[best_id]
    return {
        'match': {
            'cluster': cluster.to_dict(),
            'similarity': best_sim,
        }
    }


@app.get('/memory/clusters')
def list_clusters(status: Optional[str] = None, limit: int = 100, offset: int = 0):
    entries = list(CLUSTERS.values())
    if status:
        entries = [c for c in entries if c.status == status]
    neighbor_info = cluster_neighbor_summary()
    entries.sort(key=lambda c: c.created_ts, reverse=True)
    paged = entries[offset: offset + limit]
    result = []
    for cluster in paged:
        preview_sample = cluster.sample_ids[-1] if cluster.sample_ids else None
        neighbor = neighbor_info.get(cluster.cluster_id, {})
        result.append(
            {
                **cluster.to_dict(),
                'preview_sample_id': preview_sample,
                'mean_similarity': cluster_mean_similarity(cluster),
                'nearest_neighbor_id': neighbor.get('nearest_neighbor_id'),
                'nearest_neighbor_similarity': neighbor.get('nearest_neighbor_similarity'),
            }
        )
    return {
        'total': len(entries),
        'clusters': result,
    }


@app.get('/memory/clusters/{cluster_id}')
def get_cluster(cluster_id: str):
    cluster = CLUSTERS.get(cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail='cluster not found')
    samples = [SAMPLES[sid].to_dict() for sid in cluster.sample_ids if sid in SAMPLES]
    neighbor = cluster_neighbor_summary().get(cluster_id, {})
    return {
        'cluster': {
            **cluster.to_dict(),
            'mean_similarity': cluster_mean_similarity(cluster),
            'nearest_neighbor_id': neighbor.get('nearest_neighbor_id'),
            'nearest_neighbor_similarity': neighbor.get('nearest_neighbor_similarity'),
        },
        'samples': samples,
    }


@app.post('/memory/clusters/{cluster_id}/label')
def label_cluster(cluster_id: str, req: LabelRequest):
    cluster = CLUSTERS.get(cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail='cluster not found')
    cluster.label = req.label.strip() or None
    cluster.status = 'named' if cluster.label else 'unknown'
    cluster.updated_ts = time.time()
    schedule_save()
    return {'cluster': cluster.to_dict()}


@app.post('/memory/clusters/{cluster_id}/config')
def configure_cluster(cluster_id: str, req: ClusterConfigRequest):
    cluster = CLUSTERS.get(cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail='cluster not found')
    if req.max_samples is not None:
        cluster.max_samples = max(1, int(req.max_samples))
    if req.dedupe_threshold is not None:
        cluster.dedupe_threshold = float(max(0.0, min(1.0, req.dedupe_threshold)))
    trim_cluster_to_limit(cluster)
    cluster.updated_ts = time.time()
    schedule_save()
    return {'cluster': cluster.to_dict()}


@app.post('/memory/clusters/{cluster_id}/prune')
def prune_cluster(cluster_id: str, req: PruneRequest):
    cluster = CLUSTERS.get(cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail='cluster not found')
    threshold = float(max(0.0, min(1.0, req.similarity)))
    kept: List[str] = []
    removed: List[str] = []
    for sid in list(cluster.sample_ids):
        entry = SAMPLES.get(sid)
        if not entry:
            continue
        if not kept:
            kept.append(sid)
            continue
        sims = [cosine_sim(SAMPLES[k].embedding, entry.embedding) for k in kept if k in SAMPLES]
        if sims and max(sims) >= threshold:
            removed.append(sid)
            remove_sample_internal(sid)
        else:
            kept.append(sid)
    trim_cluster_to_limit(cluster)
    cluster.updated_ts = time.time()
    schedule_save()
    return {
        'removed': removed,
        'cluster': cluster.to_dict(),
    }


@app.post('/memory/clusters/merge')
def merge_clusters(req: MergeRequest):
    target = CLUSTERS.get(req.target_id)
    if not target:
        raise HTTPException(status_code=404, detail='target not found')
    moved = []
    for sid in req.source_ids:
        if sid == target.cluster_id:
            continue
        cluster = CLUSTERS.pop(sid, None)
        if not cluster:
            continue
        if cluster.label and not target.label:
            target.label = cluster.label
            target.status = 'named'
        moved.append(sid)
        for sample_id in cluster.sample_ids:
            entry = SAMPLES.get(sample_id)
            if not entry:
                continue
            entry.cluster_id = target.cluster_id
            target.sample_ids.append(sample_id)
        target.merged_from.append(sid)
    # Recompute centroid
    if target.sample_ids:
        vecs = [SAMPLES[sid].embedding for sid in target.sample_ids if sid in SAMPLES]
        if vecs:
            centroid = np.mean(vecs, axis=0)
            norm = np.linalg.norm(centroid)
            if norm > 1e-6:
                centroid = centroid / norm
            target.centroid = centroid.astype(np.float32)
    trim_cluster_to_limit(target)
    target.updated_ts = time.time()
    schedule_save()
    return {'target': target.to_dict(), 'merged': moved}


@app.delete('/memory/clusters/{cluster_id}')
def delete_cluster_endpoint(cluster_id: str):
    if cluster_id not in CLUSTERS:
        raise HTTPException(status_code=404, detail='cluster not found')
    remove_cluster(cluster_id)
    schedule_save()
    return {'deleted': cluster_id}


@app.delete('/memory/samples/{sample_id}')
def delete_sample(sample_id: str):
    if sample_id not in SAMPLES:
        raise HTTPException(status_code=404, detail='sample not found')
    remove_sample_internal(sample_id)
    schedule_save()
    return {'deleted': sample_id}


@app.get('/memory/samples/{sample_id}/image')
def get_sample_image(sample_id: str):
    sample = SAMPLES.get(sample_id)
    if not sample or not os.path.isfile(sample.image_path):
        raise HTTPException(status_code=404, detail='sample not found')
    with open(sample.image_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    return {'image': f'data:image/jpeg;base64,{b64}'}


if __name__ == '__main__':
    import uvicorn  # type: ignore
    ensure_dirs()
    load_state(STATE_PATH)
    print(f"[object_memory] starting on port {PORT} device={DEVICE}")
    uvicorn.run(app, host='0.0.0.0', port=PORT)
