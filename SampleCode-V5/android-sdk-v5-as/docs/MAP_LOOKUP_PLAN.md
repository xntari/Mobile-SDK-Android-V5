# Map Lookup Refactor Plan

## Goal
Provide a reliable, low-latency way for the planner/orchestrator to resolve geography (POIs, roads, perimeters) without depending exclusively on bulk OSM bundles. The new path should:
- Allow emitting a `map_lookup` tool from the planner DSL
- Call a pluggable backend (starting with Google Maps Places API)
- Cache results locally (object memory + on-disk) for repeat usage and offline fallback
- Feed resolved features back into `context.map.features` for follow-up planning commands
- Prevent Electron/webpack from bundling large static JSON files that blow the Node heap

## Architecture Overview
1. **Planner tool** – `map_lookup { query, near?, radius_m?, types? }`
   - The planner uses OpenAI function calling to invoke `map_lookup` during program synthesis.
   - When the model calls the tool, the planner service hits Google Places, returns `{ results: [...], best: {...}, query, anchor, radius_m, types }`, and the conversation continues. No server-side rewriting of the DSL output.

2. **Backend handler** – Node/Electron main process or a helper module
   - Call Google Places Text Search (later extend with Details, Roads API, Mapbox tilequery, etc.)
   - Accept environment-configured API key (`GOOGLE_MAPS_API_KEY`)
   - Respect quotas (rate limit, exponential backoff)
   - Normalize responses to `{ id, name, category, latitude, longitude, metadata }`

3. **Caching**
   - In-memory cache keyed by `(query, near, radius, types)` to avoid redundant external calls
   - Optionally persist to `tools/data/object_memory/osm_catalog.json` (or a new SQLite/MBTiles DB) for offline replay
   - Surface cached hits to the planner via the tool response (same schema as the live call)

4. **Context integration**
   - Planner context now stays minimal: telemetry, mission preview, manual/POI targets, aircraft/home markers. Static catalog features are no longer injected by default.
   - The planner relies on tool responses (not context) for ad-hoc geometry.

5. **Fallback**
   - Continue shipping a small static seed (existing hand-curated polygons, map-libre icons) but disable large OSM JSON imports for now

## Google Maps API capabilities for planner use
- **Places Text Search** (implemented) — resolves free-form queries to points of interest with `place_id`, `geometry.location`, `geometry.viewport`, `types`, `formatted_address`, and `plus_code`. We surface the raw payload so the planner can infer radii or bounding boxes from the viewport corners.
- **Places Details** (planned) — given a `place_id`, returns richer metadata (contact info, opening hours, photos, authoritative name). It reuses the same `geometry` block; we can add a follow-up call when the planner requests extra context or photos.
- **Geocoding API** — translates human-readable addresses or place names into coordinates, also exposing bounds. Useful for street addresses or intersections that may not rank well in Places Text Search.
- **Directions API** — supplies polylines for routes between points (driving, walking, cycling). Handy for corridor flights following roads/trails; consider caching decoded polyline points for waypoint generation.
- **Roads API / Snap To Roads** — refines noisy polylines onto the actual road geometry; useful when the planner sketches rough paths that need alignment.
- **Distance Matrix & Elevation APIs** — provide travel distance/time and terrain altitude samples. Distance lookups help size patrol loops; elevation sampling could augment EGM96/WGS84 conversions for terrain-aware flights.
- **Place Photos** — exposes representative imagery (where available) that can help the operator confirm the target visually.

> **Note:** Google Places does not return building footprints. When precise perimeters are required, the planner should approximate from `geometry.viewport`, ask the operator for a drawn polygon, or fall back to cached OSM/mission data.

- Encourage planners to call `map_lookup` with explicit `types` (e.g., `['school']`, `['hospital']`, `['route']`) and a `near` anchor derived from `context.telemetry` when available.
- Tool responses arrive via the function-calling channel: `{results:[...], best:{...}, query, anchor, radius_m, types}`. Capture that data in a `let` binding and reference it directly when building missions.
- Context passed to the LLM contains only the essentials (telemetry, mission preview, manual/POI targets, aircraft/home markers); static catalog entries are removed to avoid prompt pollution.
- Default behaviour when an operator does not provide a reference location: planners should assume the aircraft’s telemetry latitude/longitude as the center and start with ≈1 km search radius, expanding only when necessary.

## Verifying Google Maps connectivity
1. Ensure `GOOGLE_MAPS_API_KEY` (or `MAP_LOOKUP_API_KEY`) is exported in the shell before launching the Electron app: `export GOOGLE_MAPS_API_KEY=...`.
2. From `dji-controller-interface/`, run a quick lookup with Node to confirm the key and network path are valid:
   ```bash
   node -e "(async () => { const { mapLookup } = require('./dist/mapLookupTest'); const res = await mapLookup({ query: 'library', near: { latitude: 37.2269, longitude: -121.9688 }, radiusMeters: 12000 }); console.log(res.slice(0,3)); })();"
   ```
   (Alternatively, call the `mapLookup` helper directly via the renderer devtools console.)
3. Check the Electron main-process logs for `map_lookup → N results` lines to verify the orchestrator received data and cached it in `externalMapFeatureStore`.
4. Issue a planner request (e.g., “Fly to the nearest library”) and confirm the returned program includes a `map_lookup` call anchored near the telemetry coordinates. If the planner still asks for a location, inspect the prompt logs or planner trace for errors.

## Implementation Tasks
1. **Backend service**
   - [ ] Extend `mapLookup` helper to accept provider selection (`google` default, `mapbox` future) and optional fields (polygon from place details, road polylines via Roads API)
   - [ ] Move HTTP request from renderer bundle to the Electron main process (avoid exposing API key to UI)
   - [ ] Add structured logging & error translation (quota exceeded, zero results, etc.)
   - [ ] Implement request throttling to stay within API quotas (e.g., token bucket per minute)

2. **Caching/Persistence**
   - [ ] Store results in a lightweight on-disk DB (`tools/data/map_cache.db` via SQLite) keyed by `(query, near, provider)`
   - [ ] Expose CLI to purge/refresh cache, inspect entries, and bootstrap “golden” POIs for demos
   - [ ] Mirror cached POIs into `object_memory` snapshots so the operator can reuse them offline

3. **Planner Integration**
   - [x] Add `map_lookup` tool in DSL manifest (`tools/planner_service.py`, `agent_capability_manifest.json`) and orchestrator switch (done this iteration)
   - [ ] Update regression prompts to include `map_lookup` usage and ensure planner asks clarifying questions appropriately
   - [ ] Document new tool semantics in `docs/AGENT_DSL.md`

4. **UI / Dev Experience**
   - [ ] Add diagnostics panel showing the last `map_lookup` queries, API usage, cache hits/misses
   - [ ] Provide settings UI for API key management, provider selection, and cache clearing
   - [ ] Disable heavy OSM bundle imports permanently (replace with optional lazy loaders or command-line scripts)

5. **Testing**
   - [ ] Unit tests for `mapLookup` helper (mocked HTTP replies, caching behavior)
   - [ ] Integration test: full planner run using mock Google API, verifying features land in `context.map.features`
   - [ ] Field test script to compare planner outputs using cached vs live lookups

## Open Questions
- Do we need road polylines (e.g., follow Los Gatos Blvd) or is point geometry enough for initial demos?  If yes, prototype Google Roads API vs Mapbox Map Matching.
- Should we migrate to MBTiles/SQLite as the long-term store for both static OSM and cached results? (Recommended once basic flow works)
- Authentication strategy: use environment variables only, or expose a secure settings modal for runtime key entry?

## Next Steps
1. Move HTTP calls out of renderer (avoid bundling `node-fetch`, protect API keys)
2. Implement SQLite-based cache with TTL and expose new `map_lookup` path end-to-end
3. Reintroduce curated OSM data gradually via the new store, only loading tiles around the AOI
4. Update planner prompts/regressions to leverage `map_lookup` before falling back to clarifying questions; ensure regression cases assert that the final program contains `let` bindings instead of raw tool calls.
