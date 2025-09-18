# TODO (Short List)

See ROADMAP.md for the authoritative plan and acceptance criteria. This file stays short and points to the roadmap.
You must use specialized agents for tasks.
You might think as hard as possible to ensure the plan is viable and coordinate with the user if in doubt.

Immediate (validate with user after each):
- Implement PanelRegistry + WindowChrome (floating/movable/resizable; minimize/close; Components menu; persisted layout)
- Dual‑camera PiP + side‑by‑side with persisted PiP position/size; overlay routing
- Live Map robustness (drone/home even if home unknown); add Set Home action (bridge)
- Frame Bus + Core ML detector/tracker spike (YOLOv11n/s + Vision tracker) for one camera; live lock‑on boxes
- LockTrack: add /realtime/locktrack server (heatmap‑first, single view)
- LockTrack UI: replace broken "Image Prompt" with Lock‑On flow; heatmap toggle
- LockTrack perf: enforce float32 on MPS; tune threshold/pad/scales for 3–5 FPS

Always keep this in sync with `docs/ROADMAP.md` during PRs.
