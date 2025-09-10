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
- Add tuning sliders in the Gimbal panel (Free Look mode):
  - Sensitivity (0.5–3.0x) scales pointer offset → velocity mapping before send.
  - Smoothing (0.0–0.9) applies client‑side low‑pass to reduce jitter.
 - Add tuning sliders in Precise mode:
   - Time to target (200–2500 ms) controls ease-out duration.
   - Strength (0.5–3.0x) scales initial velocity in precise move.

Bridge messages (JSON via `electronAPI.sendBridgeCommand`)
- Free Look start: `{ type: 'gimbal_free_look_start', data: { source:'h20n' } }`
- Free Look update (15Hz throttle): `{ type: 'gimbal_free_look_update', data: { vx, vy } }` where `vx,vy` ∈ [-1,1] from cursor offset to center with dead‑zone (e.g., 0.08).
- Free Look stop: `{ type: 'gimbal_free_look_stop' }` on mouseup/blur/unmount.
- Precise click: `{ type: 'gimbal_precise_look', data: { x, y } }` normalized 0..1.
  - Include optional `{ duration_ms, strength }` from sliders.

Client logic
- Free Look (drag-origin): On pointerDown, set drag origin to current mouse position. On pointerMove, compute offset from origin (NOT screen center), normalize to [-1,1], apply ease curve, scale by Sensitivity, clamp, then apply client-side low-pass Smoothing.
- Send updates at 15Hz while active (even when vx,vy=0) to keep backend watchdog alive; ensure final stop sent on release/escape.
- Use refs (e.g., `freeLookVelocityRef`, `isFreeLookActiveRef`) so the interval reads the latest values (avoid stale closure).
- Precise: Reuse existing H20NDisplay tap code to send `gimbal_precise_look` (do not remove `gimbal_tap_target` fallback; keep a dev toggle to compare both).

Acceptance
- With mode Off, zero behavior change.
- Free Look moves gimbal smoothly with drag; stops instantly on release; no video stutter.
- Precise centers within ~2° on supported hardware; logs success/error toast.

Testing
- Build UI: `npm run dev:browser`.
- ENG runs bridge with new routing; DEV verifies request/response in console and HUD.
- Step 1: expect `gimbal_response` with `(no-op)` message on START/STOP/precise.
- Step 2: expect real motion and `GIMBAL_FREE_LOOK` logs; verify STOP and watchdog.

Performance notes
- Prefer Electron (`npm run build && npm start`) for Free Look testing; browser dev server may drop frames or reconnect, causing decode glitches.
- If you must use browser dev: consider disabling HMR/overlay to reduce churn (configure `webpack.browser.config.js` devServer hot=false, client.overlay=false).

Step 2 — DEV Tasks
- Keep Free Look update loop at 15Hz (done). Confirm STOP on mouseup/leave and on mode toggle (done).
- Add tiny HUD overlay near crosshair showing current `vx,vy` (rounded) and a small “FL” badge when active.
- Suppress clicks during Free Look (done), allow Precise clicks only in “Precise” mode.
