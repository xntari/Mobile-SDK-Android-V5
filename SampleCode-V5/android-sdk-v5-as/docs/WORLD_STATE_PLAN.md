
# PLAN.md — Persistent Object Registry + Scene Memory for **dji-controller-interface** (Android, DJI MSDK V5)

> Goal: Maintain a durable 3D world-state on-device that fuses camera detections, MOT tracking, telemetry, and laser rangefinder (LRF)—so commands like “find/track/describe the X you found earlier” work **without rediscovery**, even across app restarts.

---

## 0) Platform Reality (what we can do today)

- **Frames for AI**: DJI **ICameraStreamManager** provides both preview surfaces and AI frame callbacks (`addFrameListener`) suitable for detection/vision.
- **Telemetry & Gimbal**: V5 Key/Manager APIs expose GPS, attitude, gimbal angles; enough to form camera extrinsics.
- **LRF** (H20/H20N): exposes **Target Location** (GPS) when available, which we can convert to local coordinates and persist.
- **On‑device ML**: Run YOLOv8/YOLO11 (nano/small) with **ONNX Runtime Mobile** or TFLite on Android.
- **Non‑ROS viz**: Tools like Foxglove Studio accept non‑ROS JSON/Protobuf via WebSocket; Open3D/CloudCompare visualize point clouds/meshes locally; Cesium/Potree can host/share maps on the web.

---

## 1) Repository Integration (your repo)

Target: `SampleCode-V5/android-sdk-v5-as`

Create a new Android library module `module-worldstate/`:

```
module-worldstate/
  src/main/java/com/yourapp/world/
    geo/LocalENU.kt                // WGS84 <-> ENU (GeographicLib-Java wrapper)
    ingest/FrameIngest.kt          // binds ICameraStreamManager frame listeners
    detect/DetectorOrt.kt          // ONNX Runtime Mobile (YOLOv8/11)
    track/ByteTrack.kt             // MOT association
    fuse/LrfFusion.kt              // GPS target -> ENU 3D point
    db/WorldDb.kt                  // Room database + DAOs
    db/Entities.kt                 // ObjectEntity, TrackEntity, etc.
    index/AnnIndex.kt              // small ANN (HNSW) for re-ID embeddings
    api/WorldState.kt              // “find/track/describe”, reacquire(), queries
```

Wire into your live-view page (already has FPV + map):
- In `onResume()`, set preview via `putCameraStreamSurface(cameraId, surface)` and subscribe `addFrameListener(cameraId, listener)`.
- Start a `StateBus` (Kotlin Flow) publishing aircraft pose (GPS/attitude), gimbal pose, and LRF updates with timestamps.
- Initialize `WorldState` and attach overlays (boxes/IDs on live view; pins on the 2D map via WGS84).

---

## 2) Coordinate Frames & Math (no ROS required)

- Global geodesy: keep GPS in **WGS‑84**, but compute in **local ENU (meters)** anchored at takeoff/home. Use GeographicLib’s **LocalCartesian**; pick origin once per mission.
- Camera extrinsics: combine aircraft attitude + gimbal yaw/pitch to get camera pose in ENU at each frame timestamp.
- Pixel → ray: use camera intrinsics (fx,fy,cx,cy). Intersect with LRF/stereo depth or an assumed ground plane when needed.

---

## 3) Object Registry (Room schema)

```kotlin
@Entity(tableName = "objects")
data class ObjectEntity(
  @PrimaryKey val objectId: String,                 // UUID
  val labelsJson: String,                           // [{"name":"balloon","prob":0.93}, ...]
  val conf: Float,
  val lastBoxX1: Float, val lastBoxY1: Float,
  val lastBoxX2: Float, val lastBoxY2: Float,       // image box (px)
  val enuX: Double?, val enuY: Double?, val enuZ: Double?,  // 3D centroid (m, ENU)
  val qw: Double?, val qx: Double?, val qy: Double?, val qz: Double?,  // optional ori
  val vx: Double?, val vy: Double?, val vz: Double?,         // optional vel
  val sizeW: Float?, val sizeH: Float?, val sizeD: Float?,   // optional 3D extents
  val embedding: ByteArray?,                          // CLIP/OWLv2 re-ID
  val firstSeen: Long, val lastSeen: Long,
  val cameraId: String?, val frameId: Long?
)
```

Indexes in-memory:
- KD‑tree for quick proximity queries on `(enuX,enuY,enuZ)`.
- ANN (HNSW) on `embedding` for re‑ID / “find by look or text”.

Persistence policy:
- Upsert per tracked object at ~5–10 Hz; snapshot per mission; export as JSON/CSV if needed.

---

## 4) Perception Loop

**A. Detection (every N frames, e.g., N=3–5)**  
- YOLOv8/YOLO11 nano/small via ONNX Runtime Mobile. Pre/post included in the official examples.

**B. Tracking (every frame)**  
- ByteTrack or BoT‑SORT to keep stable IDs; seed from detections; accept low‑score boxes to avoid ID breaks.

**C. Lift 2D → 3D**  
- If LRF gives Target Location (GPS), convert to ENU and set as object centroid.  
- Else keep a bearing ray + estimated range (stereo, depth, or ground-plane hit).

**D. Update Registry**  
- `last_box`, `conf`, `last_seen`, `3D pose (if known)`, `embedding (optional)` each cycle.

---

## 5) Reacquire API (survives restart)

```
reacquire(query):
  if query is object_id -> fetch ObjectEntity
  else -> q_embed = embed(text=query); candidates = ANN.search(q_embed) ∩ near(current ENU)
  if candidate has 3D pose:
     project ENU->camera, form ROI, run detection on ROI first, seed tracker on match
  else:
     full-frame open-vocab detect; on match, write pose if LRF hits
```

Optional: use LRF Target Location + gimbal “look-at” (supported payloads) to center candidate before ROI detect.

---

## 6) 3D Visualization & Debugging (without ROS)

### Option A — **Foxglove Studio** (Desktop/Web)
- Pros: live & recorded inspection, 3D panel, timelines, multiple topics; works with **non‑ROS** data via JSON/Protobuf over WebSocket.
- How: run a tiny local WebSocket server from your Android bridge/computer that publishes topics:
  - `/objects` (array of poses + labels + confidences),
  - `/points` (point cloud from LRF/stereo or downsampled TSDF surface),
  - `/trajectory` (drone pose),
  - `/frustum` (camera pose & FOV).
- Use Foxglove **schemas** for non‑ROS messages; load in the 3D panel, configure scene, and save layouts.

### Option B — **Open3D** (Desktop)
- Pros: quick local viewers in Python/C++; `draw_geometries` renders point clouds, meshes, images; scripting for debug dumps.
- How: export `.ply`/`.pcd` snapshots of map/object meshes and open with Open3D; script camera paths for reviews.

### Option C — **CloudCompare** (Desktop)
- Pros: rich point‑cloud tooling (segmentation, ICP, measurements), cross‑platform GUI.
- How: export `.las/.laz/.ply` point clouds from your runs; open and inspect; use plugins for distances/fit planes.

### Option D — **Web Sharing (Cesium / Potree)**
- **Cesium ion**: upload point clouds, tile to **3D Tiles**, stream in **CesiumJS** (global map context).
- **Potree**: self‑host a WebGL point cloud viewer (multi‑resolution via PotreeConverter).

**What to export:**
- **Per‑frame JSON** (for Foxglove):
  ```json
  {
    "timestamp": 1737062345.123,
    "drone_enu": [x,y,z],
    "camera_pose": {"t":[x,y,z], "q":[qw,qx,qy,qz]},
    "objects": [{"id":"...", "label":"balloon", "conf":0.93,
                 "enu":[x,y,z], "box":[x1,y1,x2,y2]}],
    "points": [[x,y,z], ...]
  }
  ```
- **Point clouds / meshes**: `.ply`, `.pcd`, `.las/.laz`, or **3D Tiles** (Cesium).

---

## 7) Step‑by‑Step Tasks

**Phase A — Foundations**
1. Add `FrameIngest` with `ICameraStreamManager.putCameraStreamSurface()` + `addFrameListener()`; dispatch `Frame{bytes,w,h,format,timestamp}` to a worker.
2. Implement `LocalENU.kt` (GeographicLib‑Java wrapper); pin origin at takeoff and provide WGS84↔ENU utilities + tests.
3. Create Room DB `WorldDb` with `ObjectEntity` + DAO; write migrations & unit tests.

**Phase B — Perception**
4. Integrate **ONNX Runtime Mobile**; run YOLOv8/11 (nano/small). Measure FPS at 640p.
5. Implement **ByteTrack** in Kotlin (or JNI). Verify stable IDs on moving targets.

**Phase C — 3D Fusion**
6. Consume **LRF Target Location** (if payload supports). Convert GPS → ENU and attach to current track.
7. Compute camera pose from aircraft attitude + gimbal yaw/pitch; implement pixel↔ray; store bearing/range.

**Phase D — Reacquire + UX**
8. Add optional embeddings + small **ANN** index.
9. Implement `reacquire(query)` flow; add UI actions in the live‑view/map.
10. Overlays: boxes/IDs on preview; pins (ENU→WGS84) on the 2D map with age/freshness.

**Phase E — Debug & Viz**
11. Implement a tiny WS server (on laptop or inside the bridge) to stream JSON topics to **Foxglove**.
12. Add periodic exports of `.ply/.pcd` and/or Cesium/Potree pipelines for sharing runs.

**Phase F — Hardening**
13. Back‑pressure (drop frames when detector busy), pre‑allocated buffers, detector cadence tuning (N=3–5).
14. Telemetry/gimbal timestamp sync; log latency budget per stage.

---

## 8) Exact SDK Touchpoints (you’ll call these)

- `ICameraStreamManager.addFrameListener(...)` — AI frame buffers for detection/tracking.
- `ICameraStreamManager.putCameraStreamSurface(...)` — preview surface.
- Key/Manager retrieval of aircraft attitude & gimbal angles for camera extrinsics.
- LRF: `LaserMeasureInformation.getTargetLocation()` (GPS target, when available).

---

## 9) References (links in the chat message)

- DJI V5 **ICameraStreamManager** (frame listener & surfaces).
- Foxglove **3D panel** and **schemas** for non‑ROS data.
- **Open3D** visualization (`draw_geometries`).
- **CloudCompare** downloads / features.
- **Cesium ion** (point‑cloud tiling / 3D Tiles) + **CesiumJS**.
- **Potree** / **PotreeConverter** (self‑hosted WebGL point clouds).
- **ONNX Runtime Mobile** (YOLOv8 on Android).
- **GeographicLib** `LocalCartesian` (WGS84↔ENU).
