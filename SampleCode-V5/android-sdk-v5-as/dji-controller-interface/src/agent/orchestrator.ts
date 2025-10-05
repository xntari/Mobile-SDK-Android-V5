import { analyzeDetect, Detection } from './visionClient';
import { bridgeManager } from '../bridgeManager';
import { missionPlannerStore } from '../state/missionPlanner';
import { addMetersToLatLon, bearingOffsetToMeters, normalizeHeadingDegrees } from '../utils/geo';

const MIN_HORIZONTAL_SEPARATION_M = 1.0;
const MIN_VERTICAL_SEPARATION_M = 0.6;
const TAKEOFF_LIFT_THRESHOLD_M = 1.0;
const SAFE_MIN_COMMAND_AGL_M = 1.8;
const ALTITUDE_SETTLE_MARGIN_M = 0.4;

type RelativeMovePlan =
  | { kind: 'heading'; axis: 'forward' | 'backward' | 'left' | 'right'; distance: number }
  | { kind: 'vertical'; delta: number }
  | { kind: 'absolute'; north: number; east: number };

interface NavigationSnapshot {
  latitude: number;
  longitude: number;
  aboveTakeoff: number;
  takeoffAltitude: number | null;
  heading: number | null;
  altitude: number | null;
}

interface RelativeFlyToExtras {
  max_speed?: any;
  security_takeoff_height?: any;
  reason?: any;
}

function requireNavSnapshot(telemetryOverride?: any): NavigationSnapshot {
  const telemetry = telemetryOverride ?? getTelemetrySnapshot();
  if (!telemetry) {
    throw new Error('Navigation snapshot unavailable');
  }
  const latitude = Number(telemetry?.location?.latitude);
  const longitude = Number(telemetry?.location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('Navigation snapshot missing GPS position');
  }
  const heading = typeof telemetry?.heading === 'number'
    ? telemetry.heading
    : (typeof telemetry?.compass_heading === 'number' ? telemetry.compass_heading : null);
  const altitude = typeof telemetry?.altitude === 'number'
    ? telemetry.altitude
    : (typeof telemetry?.location?.altitude === 'number' ? telemetry.location.altitude : null);
  const aboveTakeoff = getAltitudeAboveTakeoff(telemetry);
  const takeoffAltitude = typeof telemetry?.takeoff_altitude === 'number'
    ? telemetry.takeoff_altitude
    : null;
  return {
    latitude,
    longitude,
    aboveTakeoff,
    takeoffAltitude,
    heading,
    altitude,
  };
}

function clampRelativeAltitude(height: number | null | undefined, fallback: number): number {
  if (height == null || Number.isNaN(Number(height))) {
    return Math.max(SAFE_MIN_COMMAND_AGL_M, fallback);
  }
  const value = Number(height);
  if (value <= 0) return 0;
  if (value < SAFE_MIN_COMMAND_AGL_M) return SAFE_MIN_COMMAND_AGL_M;
  return value;
}

function applyRelativeFlyToExtras(payload: Record<string, any>, extras?: RelativeFlyToExtras) {
  if (!extras) return;
  if (extras.max_speed !== undefined) {
    const maxSpeed = Number(extras.max_speed);
    if (Number.isFinite(maxSpeed)) {
      payload.max_speed = Math.max(1, Math.min(15, maxSpeed));
    }
  }
  if (extras.security_takeoff_height !== undefined) {
    const sec = Number(extras.security_takeoff_height);
    if (Number.isFinite(sec)) {
      payload.security_takeoff_height = Math.max(0, Math.min(120, sec));
    }
  }
  if (typeof extras.reason === 'string' && extras.reason.trim()) {
    payload.reason = extras.reason.trim();
  }
}

async function ensureAirborne(minMeters: number, opts: OrchestratorOptions, log: (l: string) => void) {
  const telemetry = getTelemetrySnapshot();
  const current = getAltitudeAboveTakeoff(telemetry);
  if (current >= minMeters) {
    return telemetry;
  }
  await sendFlightCommand('takeoff', undefined, opts);
  const reached = await waitForAltitude(minMeters, 20000, opts, log);
  const updated = getTelemetrySnapshot();
  if (!reached) {
    throw new Error(`Takeoff did not reach ${minMeters.toFixed(1)} m`);
  }
  return updated ?? telemetry;
}

function stageRelativeTarget(nav: NavigationSnapshot, latitude: number, longitude: number, targetAGL: number) {
  const absolute = nav.takeoffAltitude != null
    ? nav.takeoffAltitude + targetAGL
    : (nav.altitude != null ? nav.altitude - nav.aboveTakeoff + targetAGL : null);
  stageAgentTarget(latitude, longitude, absolute ?? null);
}

async function dispatchRelativeFlyTo(
  params: {
    nav?: NavigationSnapshot;
    latitude?: number;
    longitude?: number;
    targetAGL: number;
    extras?: RelativeFlyToExtras;
    opts: OrchestratorOptions;
    log: (l: string) => void;
    waitForAltitude?: boolean;
    timeoutMs?: number;
  }
) {
  const nav = params.nav ?? requireNavSnapshot();
  const latitude = params.latitude ?? nav.latitude;
  const longitude = params.longitude ?? nav.longitude;
  const targetAGL = clampRelativeAltitude(params.targetAGL, nav.aboveTakeoff);
  const payload: Record<string, any> = {
    mode: 'set_height',
    target_location: {
      latitude,
      longitude,
      altitude_reference: 'relative_to_takeoff',
      altitude: targetAGL,
    },
    fly_to_height: Math.max(1, Math.round(Math.max(targetAGL, 0))),
  };
  applyRelativeFlyToExtras(payload, params.extras);
  stageRelativeTarget(nav, latitude, longitude, targetAGL);
  await sendFlightCommand('fly_to_prepare', payload, params.opts);
  if (params.waitForAltitude) {
    const settleTarget = Math.max(0.5, targetAGL - ALTITUDE_SETTLE_MARGIN_M);
    await waitForAltitude(settleTarget, params.timeoutMs ?? 30000, params.opts, params.log);
  }
  return { targetAGL };
}
function normalizeRelativeMoveAxis(axisInput: any, distanceInput: any): RelativeMovePlan | null {
  const rawAxis = typeof axisInput === 'string' ? axisInput.trim().toLowerCase() : '';
  const baseDistance = Number(distanceInput);
  if (!rawAxis || !Number.isFinite(baseDistance)) return null;
  const absDistance = Math.abs(baseDistance);
  const signPrefix = rawAxis.startsWith('-') ? -1 : 1;
  const axis = rawAxis.replace(/^[+\-]/, '');

  const headingMap: Record<string, 'forward' | 'backward' | 'left' | 'right'> = {
    forward: 'forward', forwards: 'forward', fwd: 'forward', front: 'forward', ahead: 'forward', '+x': 'forward', 'x': 'forward',
    backward: 'backward', backwards: 'backward', back: 'backward', reverse: 'backward', '-x': 'backward',
    left: 'left', port: 'left', '-y': 'left',
    right: 'right', starboard: 'right', '+y': 'right', 'y': 'right',
  };

  if (headingMap[axis]) {
    const canonical = headingMap[axis];
    const signedDistance = canonical === 'forward' || canonical === 'right'
      ? absDistance * signPrefix
      : absDistance * (signPrefix === -1 ? 1 : (canonical === 'backward' ? 1 : 1));
    const distance = Math.abs(signedDistance);
    const finalAxis = (canonical === 'forward' && signPrefix === -1) ? 'backward'
      : (canonical === 'backward' && signPrefix === -1) ? 'forward'
      : (canonical === 'right' && signPrefix === -1) ? 'left'
      : (canonical === 'left' && signPrefix === -1) ? 'right'
      : canonical;
    return { kind: 'heading', axis: finalAxis, distance };
  }

  const verticalSet = new Set(['vertical', 'up', 'upward', 'upwards', 'ascend', 'z']);
  const verticalDownSet = new Set(['down', 'downward', 'descend', '-z']);
  if (verticalSet.has(axis) || verticalDownSet.has(axis)) {
    const direction = verticalDownSet.has(axis) || rawAxis.startsWith('-') ? -1 : 1;
    return { kind: 'vertical', delta: absDistance * direction };
  }

  const absoluteMap: Record<string, { north: number; east: number }> = {
    north: { north: absDistance, east: 0 }, n: { north: absDistance, east: 0 },
    south: { north: -absDistance, east: 0 }, s: { north: -absDistance, east: 0 },
    east: { north: 0, east: absDistance }, e: { north: 0, east: absDistance },
    west: { north: 0, east: -absDistance }, w: { north: 0, east: -absDistance },
  };
  if (absoluteMap[axis]) {
    const { north, east } = absoluteMap[axis];
    return { kind: 'absolute', north, east };
  }

  return null;
}

function getTelemetrySnapshot() {
  try {
    return bridgeManager.getState().bridgeData.telemetry ?? null;
  } catch {
    return null;
  }
}

function getPreflightSnapshot() {
  try {
    return bridgeManager.getState().bridgeData.preflight ?? null;
  } catch {
    return null;
  }
}

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6378137;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sa = Math.sin(dLat / 2);
  const sb = Math.sin(dLon / 2);
  const c = 2 * Math.atan2(
    Math.sqrt(sa * sa + Math.cos(lat1) * Math.cos(lat2) * sb * sb),
    Math.sqrt(1 - (sa * sa + Math.cos(lat1) * Math.cos(lat2) * sb * sb)),
  );
  return R * c;
}

async function sendFlightCommand(action: string, params: Record<string, any> | undefined, opts: OrchestratorOptions) {
  const payload: any = { type: 'flight_command', data: { action } };
  if (params && Object.keys(params).length) {
    payload.data.params = params;
  }
  const response = await opts.sendBridge(payload);
  if (response && response.success === false) {
    throw new Error(response.error || response.error_message || `${action} rejected`);
  }
  return response ?? { success: true };
}

function getAltitudeAboveTakeoff(telemetry: any | null): number {
  if (!telemetry) return 0;
  if (typeof telemetry.altitude_above_takeoff === 'number') {
    return telemetry.altitude_above_takeoff;
  }
  if (typeof telemetry.altitude === 'number' && typeof telemetry.takeoff_altitude === 'number') {
    return telemetry.altitude - telemetry.takeoff_altitude;
  }
  return typeof telemetry.altitude === 'number' ? telemetry.altitude : 0;
}

async function waitForAltitude(minMeters: number, timeoutMs: number, opts: OrchestratorOptions, log: (l: string) => void) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const telemetry = getTelemetrySnapshot();
    const current = getAltitudeAboveTakeoff(telemetry);
    if (current >= minMeters) {
      return true;
    }
    if (opts.isCancelled?.()) return false;
    await sleep(400);
  }
  log(`waitForAltitude timeout (target ${minMeters} m)`);
  return false;
}

async function waitForLanded(timeoutMs: number, opts: OrchestratorOptions, log: (l: string) => void) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const telemetry = getTelemetrySnapshot();
    const alt = getAltitudeAboveTakeoff(telemetry);
    const motorsOff = telemetry?.motors_on === false;
    if (alt <= 0.6 || motorsOff) {
      return true;
    }
    if (opts.isCancelled?.()) return false;
    await sleep(500);
  }
  log('waitForLanded timeout');
  return false;
}

function stageAgentTarget(latitude: number, longitude: number, altitude: number | null) {
  try {
    missionPlannerStore.setManualTarget({ latitude, longitude, altitude, source: 'manual' });
  } catch {
    // ignored
  }
}

export interface OrchestratorOptions {
  getSnapshot: () => Promise<string>; // returns base64 (data URL ok)
  sendBridge: (msg: any) => Promise<{ success: boolean; [k: string]: any } | void>;
  log: (line: string) => void;
  showDetections?: (boxes: Detection[]) => void;
  onResult?: (result: { text: string }) => void;
  onStep?: (info: { id: string; state: 'running' | 'done' | 'error'; ms?: number; note?: string }) => void;
  // Optional previews: legacy steps preview or full program
  onPlan?: (steps: any[]) => void;
  onProgram?: (program: any) => void;
  onHighLevelProgram?: (program: any) => void;
  isCancelled?: () => boolean;
  onTrace?: (line: string, kind?: 'tool'|'var'|'info'|'warn'|'error') => void;
  onPlanErrors?: (errors: Array<{ message: string; path?: string }>) => void;
}

function pickBest(dets: Detection[]): Detection {
  // Simple score-first; if equal, prefer larger area
  return dets.slice().sort((a, b) => {
    const s = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(s) > 1e-6) return s;
    const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
    const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
    return areaB - areaA;
  })[0];
}

function clamp01(n: number) { return Math.max(0.02, Math.min(0.98, n)); }
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
async function flushUI() {
  try {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  } catch {
    await sleep(0);
  }
}

// Optional: plan executor. Tries to fetch a JSON plan and execute a subset of tools.
export async function runInstruction(
  instruction: string,
  opts: OrchestratorOptions,
  plannerUrl: string = (globalThis as any).__PLANNER_URL__ || 'http://127.0.0.1:9002/plan'
) {
  const { log } = opts;
  try {
    const resp = await fetch(plannerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const plan = await resp.json();
    if (plan?.high_level_program) { try { opts.onHighLevelProgram?.(plan.high_level_program); } catch {} }
    // Validation errors from planner
    if (Array.isArray((plan as any)?.errors) && (plan as any).errors.length) {
      if (plan?.program) { try { opts.onProgram?.(plan.program); } catch {} }
      opts.onPlanErrors?.((plan as any).errors);
      return;
    }
    // Prefer DSL program if provided
    if (plan?.program && plan.program?.body) {
      // Surface full JSON program to UI for pretty rendering
      try { opts.onProgram?.(plan.program); } catch {}
      const body = Array.isArray(plan.program.body) ? plan.program.body : [];
      const countOps = (nodes:any[]):number => nodes.reduce((acc,n)=>{
        if (!n) return acc; if (n.type==='while' || n.type==='if' || n.type==='repeat') {
          const t = n.then||[]; const e = n.else||[]; const b = n.body||[]; return acc + 1 + countOps(t)+countOps(e)+countOps(b);
        } else return acc+1;
      },0);
      log(`Planner: program with ${countOps(body)} operations`);
      // Keep log concise; detailed pretty view handled by UI using onProgram
      try { log(`Plan tools: ${body.map((b:any)=>b?.tool||b?.type).filter(Boolean).join(', ')}`); } catch {}
      await runProgram(plan.program, instruction, opts, log);
      return;
    } else {
      log('Planner error: no "program" in response');
      opts.onResult?.({ text: 'Planner returned no program. Please update the planner to emit DSL program only.' });
      return;
    }
  } catch (e) {
    log(`Planner unavailable, using built-in flow (${String(e)})`);
    opts.onResult?.({ text: 'Planner unavailable' });
    return;
  }
}

async function execStep(step: any, opts: OrchestratorOptions, log: (l: string) => void) {
  const { getSnapshot, sendBridge, showDetections, onResult, onStep } = opts;
  const tool = String(step?.tool || '');
  const args = step?.args || {};
  const t0 = performance.now();
  onStep?.({ id: tool, state: 'running' });
  switch (tool) {
    case 'snapshot': {
      await getSnapshot();
      log('snapshot ✓');
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    case 'detect': {
      const q = String(args.query || 'object');
      const img = await getSnapshot();
      const { detections, meta } = await analyzeDetect({ imageBase64: img, query: q });
      showDetections?.(detections);
      log(`detect("${q}") → ${detections.length} [${meta?.backend || 'n/a'}]`);
      (execStep as any)._lastDetections = detections;
      if (detections[0]) {
        const cx = clamp01((detections[0].x1 + detections[0].x2)/2);
        const cy = clamp01((detections[0].y1 + detections[0].y2)/2);
        opts.onTrace?.(`det_best: cx=${cx.toFixed(3)}, cy=${cy.toFixed(3)}, score=${Math.round((detections[0].score||0)*100)}%`, 'var');
      }
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    case 'look_at': {
      const dets: Detection[] = (execStep as any)._lastDetections || [];
      let x = Number(args.x), y = Number(args.y);
      if (isNaN(x) || isNaN(y)) {
        const best = dets.length ? pickBest(dets) : null;
        if (best) {
          const cx = clamp01((best.x1 + best.x2) / 2);
          const cy = clamp01((best.y1 + best.y2) / 2);
          x = cx; y = cy;
        } else { x = 0.5; y = 0.5; }
      }
      // Allow pre-slew overlay to be visible once, then clear
      await flushUI();
      try { showDetections?.([]); } catch {}
      await flushUI();
      await sendBridge({ type: 'gimbal_tap_target', data: { x, y } });
      log(`look_at (${x.toFixed(3)}, ${y.toFixed(3)}) ✓`);
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    case 'sleep': {
      const ms = Number(args.ms || 0);
      await new Promise(r => setTimeout(r, ms));
      log(`sleep ${ms}ms ✓`);
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    case 'laser_enable': {
      await sendBridge({ type: 'camera_laser_enable', data: { enabled: !!args.enabled } });
      log(`laser_enable ${!!args.enabled} ✓`);
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    case 'laser_measure': {
      const dets: Detection[] = (execStep as any)._lastDetections || [];
      let x = Number(args.x), y = Number(args.y);
      if (isNaN(x) || isNaN(y)) {
        const best = dets.length ? pickBest(dets) : null;
        if (best) { x = clamp01((best.x1 + best.x2)/2); y = clamp01((best.y1 + best.y2)/2); } else { x=0.5;y=0.5; }
      }
      // Measure at center after Look At for consistency
      await sendBridge({ type: 'camera_laser_measure', data: { x: 0.5, y: 0.5 } });
      log(`laser_measure (0.500, 0.500) → awaiting result`);
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    case 'respond': {
      const text = String(args?.text || 'Done');
      onResult?.({ text });
      log(`respond: ${text}`);
      onStep?.({ id: tool, state: 'done', ms: performance.now() - t0 });
      return;
    }
    default:
      log(`skip unknown tool: ${tool}`);
      onStep?.({ id: tool, state: 'error', ms: performance.now() - t0 });
  }
}

// Legacy NL parsing & sanitization removed — planner is authoritative.

// --------- DSL interpreter (v0) ---------
type DSLExpr = any;
type DSLNode = any;

async function runProgram(program: { type?: string; body: DSLNode[] }, instruction: string, opts: OrchestratorOptions, log: (l:string)=>void) {
  const ctx: any = { vars: {}, started: performance.now(), instruction };
  for (const node of program.body || []) {
    if (opts.isCancelled?.()) break;
    await execNode(node, ctx, opts, log);
  }
}

async function execNode(node: DSLNode, ctx: any, opts: OrchestratorOptions, log: (l:string)=>void) {
  if (!node || typeof node !== 'object') return;
  const t = String(node.type||'');
  switch (t) {
    case 'call': {
      const tool = String(node.tool||'');
      opts.onStep?.({ id: tool, state: 'running' });
      opts.onTrace?.(`${tool}(${safeFmtArgs(node.args||{})});`, 'tool');
      const t0 = performance.now();
      const res = await callTool(tool, node.args||{}, ctx, opts, log);
      opts.onStep?.({ id: tool, state: 'done', ms: performance.now()-t0 });
      if (node.assign) { ctx.vars[node.assign] = res; opts.onTrace?.(`${String(node.assign)} = ${safeFmtVal(res)}`, 'var'); }
      return;
    }
    case 'let': {
      ctx.vars[String(node.name)] = evalExpr(node.value, ctx);
      opts.onTrace?.(`${String(node.name)} = ${safeFmtVal(ctx.vars[String(node.name)])}`, 'var');
      return;
    }
    case 'if': {
      const cond = !!evalExpr(node.cond, ctx);
      const run = async (arr:any[])=>{ for (const n of arr||[]) { if (opts.isCancelled?.()) break; await execNode(n, ctx, opts, log);} };
      if (cond) { await run(node.then||[]); } else { await run(node.else||[]); }
      return;
    }
    case 'repeat': {
      const times = Math.max(0, Number(node.times||0));
      for (let i=0;i<times;i++) {
        for (const n of (node.body||[])) { if (opts.isCancelled?.()) break; await execNode(n, ctx, opts, log); }
        if (opts.isCancelled?.()) break;
      }
      return;
    }
    case 'while': {
      const maxIter = Number(node.max_iter ?? 50);
      const interval = Number(node.interval_ms ?? 500);
      const loopStart = performance.now();
      const mkLoopCtx = () => ({ ...ctx, vars: { ...ctx.vars, elapsed_ms: performance.now() - loopStart } });
      let i = 0;
      while (!opts.isCancelled?.() && i < maxIter && !!evalExpr(node.cond, mkLoopCtx())) {
        for (const n of (node.body || [])) { if (opts.isCancelled?.()) break; await execNode(n, ctx, opts, log); }
        i++;
        if (interval > 0) await sleep(interval);
      }
      return;
    }
    case 'wait': {
      if (node.ms) { await sleep(Number(node.ms)); opts.onTrace?.(`sleep(${Number(node.ms)});`, 'tool'); }
      return;
    }
    case 'respond': {
      if (node.text) opts.onResult?.({ text: String(node.text) });
      return;
    }
    default: return;
  }
}

function evalExpr(expr: DSLExpr, ctx: any): any {
  if (expr==null) return null;
  if (typeof expr !== 'object') return expr;
  if (typeof expr.var === 'string') return ctx.vars[expr.var];
  if (typeof expr.get === 'string') {
    let v = ctx.vars[expr.get];
    for (const k of (expr.path||[])) v = v?.[k];
    return v;
  }
  const op = expr.op;
  if (op) {
    const l = evalExpr(expr.left, ctx); const r = evalExpr(expr.right, ctx);
    switch (op) {
      case '>': return l>r; case '>=': return l>=r; case '<': return l<r; case '<=': return l<=r; case '==': return l==r; case '!=': return l!=r;
      case 'and': return (!!l)&& (!!evalExpr(expr.right, ctx));
      case 'or': return (!!l)|| (!!evalExpr(expr.right, ctx));
      case 'not': return !evalExpr(expr.left, ctx);
    }
  }
  return null;
}

async function callTool(tool: string, args: any, ctx: any, opts: OrchestratorOptions, log: (l:string)=>void) {
  switch (tool) {
    case 'snapshot': {
      const img = await opts.getSnapshot();
      return { image: img };
    }
    case 'detect': {
      const query = String(args?.query||'object');
      const maxTries = Math.max(1, Math.min(3, Number(args?.retries ?? 2)));
      let lastMeta: any = null; let out: Detection[] = [];
      for (let i=0;i<maxTries;i++) {
        const img = await opts.getSnapshot();
        const { detections, meta } = await analyzeDetect({ imageBase64: img, query });
        lastMeta = meta; out = detections;
        if (detections.length > 0) break;
        if (i < maxTries-1) await sleep(200);
      }
      const aug = out.map(d=>({ ...d, cx: clamp01((d.x1+d.x2)/2), cy: clamp01((d.y1+d.y2)/2) }));
      opts.showDetections?.(aug);
      log(`detect("${query}") → ${aug.length} [${lastMeta?.backend||'n/a'}]`);
      ctx.vars.det = { detections: aug };
      if (aug[0]) ctx.vars.p = aug[0];
      if (aug[0]) opts.onTrace?.(`det_best: cx=${aug[0].cx.toFixed(3)}, cy=${aug[0].cy.toFixed(3)}, score=${Math.round((aug[0].score||0)*100)}%`, 'var');
      return { detections: aug };
    }
    case 'look_at': {
      let x = Number(args?.x); let y = Number(args?.y);
      if (!isFinite(x) || !isFinite(y)) {
        // try var p
        const p = ctx.vars.p || ctx.vars.det?.detections?.[0];
        x = clamp01(p?.cx ?? 0.5); y = clamp01(p?.cy ?? 0.5);
      }
      // Enforce SDK cooldown (~500ms) between look_at commands
      const now = performance.now();
      const last = (ctx.__lastLookAtTs ?? 0) as number;
      const minCooldown = 500;
      const waitMs = Math.max(0, minCooldown - (now - last));
      if (waitMs > 0) await sleep(waitMs);
      await flushUI(); opts.showDetections?.([]); await flushUI();
      await opts.sendBridge({ type: 'gimbal_tap_target', data: { x, y } });
      ctx.__lastLookAtTs = performance.now();
      opts.onTrace?.(`→ look_at(${x.toFixed(3)}, ${y.toFixed(3)});`, 'tool');
      return { ok: true };
    }
    case 'laser_enable': {
      await opts.sendBridge({ type: 'camera_laser_enable', data: { enabled: !!args?.enabled } });
      return { ok: true };
    }
    case 'laser_measure': {
      const x = isFinite(Number(args?.x)) ? Number(args.x) : 0.5;
      const y = isFinite(Number(args?.y)) ? Number(args.y) : 0.5;
      await opts.sendBridge({ type: 'camera_laser_measure', data: { x, y } });
      return { ok: true };
    }
    case 'sleep': {
      const ms = Number(args?.ms || 0);
      if (ms > 0) await sleep(ms);
      return { ok: true };
    }
    case 'respond': {
      opts.onResult?.({ text: String(args?.text||'') });
      return { ok: true };
    }
    case 'mission_self_check': {
      const preflight = getPreflightSnapshot();
      if (!preflight) {
        const fallback = { status: 'blocked', issues: [{ id: 'preflight_unavailable', severity: 'warn', message: 'No preflight snapshot available.' }] };
        opts.onTrace?.('self_check: no preflight snapshot', 'warn');
        return fallback;
      }
      const diagnostics = Array.isArray(preflight.diagnostics) ? preflight.diagnostics : [];
      const issues = diagnostics.map((diag, index) => ({
        id: diag.code ?? diag.title ?? `diag_${index}`,
        severity: (diag.level ?? 'warn').toLowerCase().includes('error') ? 'error' : (diag.level ?? 'info'),
        message: diag.description ?? diag.title ?? 'Unknown diagnostic',
      }));
      const hasError = issues.some((entry) => (entry.severity ?? '').toLowerCase().includes('error'));
      opts.onTrace?.(`self_check: ${hasError ? 'blocked' : 'ready'} (${issues.length} issue${issues.length === 1 ? '' : 's'})`, hasError ? 'warn' : 'info');
      return { status: hasError ? 'blocked' : 'ready', issues };
    }
    case 'flight_takeoff': {
      const telemetryBefore = getTelemetrySnapshot();
      const altitudeAboveTakeoff = getAltitudeAboveTakeoff(telemetryBefore);
      if (altitudeAboveTakeoff > TAKEOFF_LIFT_THRESHOLD_M) {
        log(`Skipping takeoff: already airborne (~${altitudeAboveTakeoff.toFixed(1)} m AGL)`);
      }

      const telemetryAfterTakeoff = await ensureAirborne(TAKEOFF_LIFT_THRESHOLD_M, opts, log);
      const nav = requireNavSnapshot(telemetryAfterTakeoff ?? getTelemetrySnapshot());

      const requestedHeightRaw = args?.altitude_target_m;
      const requestedHeight = Number.isFinite(Number(requestedHeightRaw)) ? Number(requestedHeightRaw) : null;
      if (requestedHeight != null) {
        const targetAGL = Math.max(0, requestedHeight);
        if (targetAGL > nav.aboveTakeoff + ALTITUDE_SETTLE_MARGIN_M) {
          await dispatchRelativeFlyTo({
            nav,
            targetAGL,
            extras: { reason: 'agent_takeoff_climb' },
            opts,
            log,
            waitForAltitude: true,
            timeoutMs: 25000,
          });
        }
      }

      return { ok: true, altitude_target: requestedHeight ?? undefined };
    }
    case 'flight_land': {
      const mode = String(args?.mode || 'auto').toLowerCase();
      if (mode === 'force') {
        await sendFlightCommand('force_land_start', undefined, opts);
        await waitForLanded(15000, opts, log);
        return { ok: true, mode: 'force' };
      }
      await sendFlightCommand('land', undefined, opts);
      const landed = await waitForLanded(20000, opts, log);
      if (!landed) {
        log('Landing incomplete, escalating to force_land');
        await sendFlightCommand('force_land_start', undefined, opts);
        await waitForLanded(15000, opts, log);
        return { ok: true, mode: 'force' };
      }
      return { ok: true, mode: 'auto' };
    }
    case 'flight_rth': {
      const action = String(args?.action || '').toLowerCase();
      if (action !== 'start' && action !== 'stop') {
        throw new Error('flight_rth.action must be "start" or "stop"');
      }
      await sendFlightCommand(action === 'start' ? 'return_home_start' : 'return_home_stop', undefined, opts);
      return { ok: true };
    }
    case 'mission_fly_to': {
      throw new Error('mission_fly_to disabled during flight rework');
    }
    case 'mission_relative_move': {
      throw new Error('mission_relative_move disabled during flight rework');
    }
    default:
      log(`unknown tool: ${tool}`);
      return null;
  }
}

function safeFmtArgs(a:any){ try{ return JSON.stringify(a)||'' }catch{ return ''}}
function safeFmtVal(v:any){ try{ const s=JSON.stringify(v); return s && s.length>120? s.slice(0,120)+'…': s }catch{ return String(v) }}
