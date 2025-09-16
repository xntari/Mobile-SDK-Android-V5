#!/usr/bin/env python3
"""
General vision service (debug) that provides:
- Object inventory from a frame
- Scene caption (simple heuristic for now)
- Answers a simple question (heuristic)
- Boxes covering the detected objects

This is intentionally lightweight and swappable. For now it reuses OWL‑ViT
with a default label inventory to detect objects and derives a caption
and simple QA heuristically. You can replace internals later with a
different model without changing the HTTP contract.

Endpoints:
  POST /general/analyze { image, question?, threshold?, top_k? }
  → { objects:[{label,count,score?}], caption, answer? }

Run:
  pip install fastapi uvicorn pillow
  # optional for real detection: pip install transformers torch torchvision
  python tools/vision_general_server.py
  # http://0.0.0.0:9003/general/analyze
"""
from typing import List, Dict, Any
import base64
import io
import os
from collections import Counter, defaultdict

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


class AnalyzeRequest(BaseModel):
    image: str
    task: str
    question: str | None = None
    threshold: float | None = None
    top_k: int | None = None


def decode_image_to_pil(image_b64_or_dataurl: str) -> Image.Image:
    data = image_b64_or_dataurl
    if data.startswith("data:"):
        header, b64 = data.split(",", 1)
    else:
        b64 = data
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert("RGB")


_HAVE_QWEN = False
_qwen_model = None
_qwen_processor = None


def _lazy_load_qwen():
    global _HAVE_QWEN, _qwen_model, _qwen_processor
    if _HAVE_QWEN:
        return
    try:
        from transformers import AutoProcessor  # type: ignore
        from transformers import Qwen2VLForConditionalGeneration  # type: ignore
        model_id = os.environ.get("QWEN_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
        _qwen_processor = AutoProcessor.from_pretrained(model_id)
        _qwen_model = Qwen2VLForConditionalGeneration.from_pretrained(model_id, torch_dtype="auto", device_map="auto")
        _HAVE_QWEN = True
        print(f"[general] Loaded Qwen2-VL model: {model_id}")
    except Exception as e:
        print("[general] Qwen2-VL unavailable (pip install transformers>=4.43 and appropriate backend):", e)
        _HAVE_QWEN = False


def _scale_image(img: Image.Image, max_side: int = 1024) -> Image.Image:
    if max(img.size) <= max_side:
        return img
    scale = max_side / max(img.size)
    new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    return img.resize(new_size)


def _default_labels() -> List[str]:
    s = os.environ.get("DESCRIBE_LABELS")
    if s:
        return [p.strip() for p in s.split(',') if p.strip()]
    return [
        "person","car","truck","bus","bicycle","motorcycle","traffic light","stop sign",
        "chair","couch","bed","table","tv","laptop","cell phone","remote","keyboard",
        "book","bottle","cup","wine glass","fork","knife","spoon","bowl","backpack",
        "umbrella","handbag","suitcase","tie","dog","cat","bird","horse","sheep","cow"
    ]


def _qwen_json(img: Image.Image, question: str | None, task: str | None, thr: float, top_k: int) -> Dict[str, Any]:
    if not _HAVE_QWEN:
        return {"objects": [], "caption": "", "answer": None}
    # Build messages: use system to constrain format, user for image+task
    if task == 'objects':
        sys_msg = (
            "You are a precise multimodal assistant. Respond with JSON only. "
            "Return the list of visible objects. Keys: objects (unique list of up to 10 nouns, non-plural where possible"
        )
        user_text = "List the clearly visible objects ranked by importance/confidence. Keys: objects (Only unique, maximum of 10 nouns, non-plural where possible)."
    elif task == 'describe':
        sys_msg = (
            "You are a precise multimodal assistant. Respond with JSON only. "
            "Keys: caption (one paragraph, max 3 sentences, grounded; describe the main objects, spatial layout, location, don't add subjective comments about the vibe or style)"
        )
        user_text = "Describe the scene concisely in one paragraph. Grounded, describe the main objects, spatial layout, infer location, don't add subjective comments about the vibe."
    elif task == 'query':
        sys_msg = (
            "You are a precise multimodal assistant. Respond with JSON only. "
            "Keys: answer (one grounded paragraph)"
        )
        user_text = f"Question: {question}" if question else "Question: (none)"
    else:
        sys_msg = (
            "You are a precise multimodal assistant. Respond with JSON only. Keys: answer."
        )
        user_text = "Analyse the scene and respond to the query."
    scaled = _scale_image(img, max_side=320)
    messages = [
        {"role": "system", "content": [{"type":"text","text": sys_msg}]},
        {"role": "user", "content": [{"type":"image","image": scaled}, {"type":"text","text": user_text}]}
    ]
    templ = _qwen_processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = _qwen_processor(text=[templ], images=[scaled], return_tensors="pt").to(_qwen_model.device)
    gen = _qwen_model.generate(**inputs, max_new_tokens=256, temperature=0.2)
    # Decode only newly generated tokens
    new_tokens = gen[:, inputs.input_ids.shape[1]:]
    text = _qwen_processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
    print(f"{text=}")
    # Extract first JSON object from text
    import re, json as pyjson
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return pyjson.loads(m.group(0))
        except Exception:
            pass
    return {"objects": [], "caption": text.strip(), "answer": None}


def _caption_from_objects(objects: List[str]) -> str:
    if not objects:
        return "An empty or unrecognized scene."
    uniq = list(dict.fromkeys(objects))
    if len(uniq) == 1:
        return f"A scene containing a {uniq[0]}."
    if len(uniq) == 2:
        return f"A scene containing a {uniq[0]} and a {uniq[1]}."
    return "A scene containing " + ", ".join(uniq[:-1]) + f" and {uniq[-1]}."


@app.post("/general/analyze")
def analyze(req: AnalyzeRequest):
    try:
        img = decode_image_to_pil(req.image)
    except Exception:
        return {"objects": [], "caption": "", "boxes": []}

    if not _HAVE_QWEN:
        _lazy_load_qwen()
    thr = float(req.threshold) if req.threshold is not None else 0.10
    top_k = int(req.top_k) if req.top_k else 50

    # Use Qwen to get semantic summary + object list
    data = _qwen_json(img, req.question, req.task, thr, top_k) if _HAVE_QWEN else {"objects": [], "caption": "", "answer": None}
    objects = data.get("objects") or []
    # Normalize object entries to {label,count,score?}
    norm_objs = []
    for o in objects:
        if isinstance(o, dict) and o.get('label'):
            lbl = str(o['label'])
            cnt = int(o.get('count') or 0) if str(o.get('count') or '').isdigit() else o.get('count')
            sc = float(o.get('score')) if isinstance(o.get('score'), (int,float)) else None
            norm_objs.append({"label": lbl, **({"count":cnt} if cnt else {}), **({"score":sc} if sc is not None else {})})
        elif isinstance(o, str):
            norm_objs.append({"label": o})
    # Deduplicate/filter trivial labels
    block = {"assistant","system","image","json","multimodal","precise","user"}
    dedup: Dict[str, Dict[str, Any]] = {}
    for e in norm_objs:
        lbl = str(e.get("label"," ")).strip()
        low = lbl.lower()
        if not lbl or low in block:
            continue
        if low not in dedup:
            dedup[low] = {"label": lbl, **({"count": e.get("count")} if e.get("count") else {}), **({"score": e.get("score")} if e.get("score") is not None else {})}
        else:
            if isinstance(e.get("count"), int):
                prev = dedup[low].get("count")
                if not isinstance(prev, int) or e["count"] > prev:
                    dedup[low]["count"] = e["count"]
            if isinstance(e.get("score"), (int,float)):
                dedup[low]["score"] = max(float(dedup[low].get("score", 0)), float(e["score"]))
    norm_objs = list(dedup.values())[:top_k]
    caption = str(data.get("caption") or "")
    answer = data.get("answer")

    return {"objects": norm_objs, "caption": caption, "answer": answer}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("GENERAL_PORT", "9003"))
    uvicorn.run(app, host="0.0.0.0", port=port)
