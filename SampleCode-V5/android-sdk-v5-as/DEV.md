# DEV — Front‑End Tasks (Free Look & Precise)

Scope: dji-controller-interface (React/Electron). No Android edits.

Deliverables
- Free Look mode: click‑and‑drag (or hold RMB) to pan/tilt H20N view continuously.
- Precise Free Look: single click recenters clicked point to crosshair with refined adjustment.
- Non‑intrusive: default behavior unchanged unless mode toggled on.

UI/HUD
- Add a Gimbal panel toggle with modes: Off | Free Look | Precise.
- Crosshair stays at screen center; show small status badge: FL/PR.
- Show tiny arrows while Free Look is active; show click indicators for Precise.

Bridge messages (JSON via `electronAPI.sendBridgeCommand`)
- Free Look start: `{ type: 'gimbal_free_look_start', data: { source:'h20n' } }`
- Free Look update (15Hz throttle): `{ type: 'gimbal_free_look_update', data: { vx, vy } }` where `vx,vy` ∈ [-1,1] from cursor offset to center with dead‑zone (e.g., 0.08).
- Free Look stop: `{ type: 'gimbal_free_look_stop' }` on mouseup/blur/unmount.
- Precise click: `{ type: 'gimbal_precise_look', data: { x, y } }` normalized 0..1.

Client logic
- Free Look: On pointerDown, capture pointer; compute normalized offset from center; map to velocity with ease curve, e.g., `v = sign(offset) * clamp((|offset|-dz)/(1-dz), 0, 1)^1.6`.
- Throttle updates to 15Hz; ensure final stop sent on release/escape.
- Precise: Reuse existing H20NDisplay tap code to send `gimbal_precise_look` (do not remove `gimbal_tap_target` fallback; keep a dev toggle to compare both).

Acceptance
- With mode Off, zero behavior change.
- Free Look moves gimbal smoothly with drag; stops instantly on release; no video stutter.
- Precise centers within ~2° on supported hardware; logs success/error toast.

Testing
- Build UI: `npm run dev:browser`.
- ENG runs bridge with new routing; DEV verifies request/response in console and HUD.
- Expect server to respond with `{ type:'gimbal_response', data:{ success:true, mode:'noop', ... } }` in Step 1.
