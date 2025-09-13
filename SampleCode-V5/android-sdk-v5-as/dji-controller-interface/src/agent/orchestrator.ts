import { analyzeDetect, Detection } from './visionClient';

export interface OrchestratorOptions {
  getSnapshot: () => Promise<string>; // returns base64 (data URL ok)
  sendBridge: (msg: any) => Promise<{ success: boolean; [k: string]: any } | void>;
  log: (line: string) => void;
  showDetections?: (boxes: Detection[]) => void;
  onResult?: (result: { text: string }) => void;
  onStep?: (info: { id: string; state: 'running' | 'done' | 'error'; ms?: number; note?: string }) => void;
  onPlan?: (steps: any[]) => void;
  isCancelled?: () => boolean;
  onTrace?: (line: string, kind?: 'tool'|'var'|'info'|'warn'|'error') => void;
  onPlanErrors?: (errors: Array<{ message: string; path?: string }>) => void;
}

function extractQueryFromInstruction(text: string): { query: string; intent: 'measure'|'coords'|'describe'|'detect' } {
  const s = String(text || '').trim();
  const low = s.toLowerCase();
  // Normalize whitespace
  const norm = low.replace(/\s+/g, ' ').trim();

  // Common patterns
  const m1 = norm.match(/^(find|look\s+for)\s+(?:the\s+)?(.+?)\s+(distance|dist|coords?|coordinates)\b/);
  if (m1) return { query: m1[2], intent: (m1[3].startsWith('coord')? 'coords':'measure') };

  const m2 = norm.match(/^(find|look\s+for)\s+(?:the\s+)?(coords?|coordinates)\s+(?:of|for|to)\s+(?:the\s+)?(.+)$/);
  if (m2) return { query: m2[3], intent: 'coords' };

  const m3 = norm.match(/^find\s+(?:the\s+)?distance\s+(?:to|of)\s+(?:the\s+)?(.+)$/);
  if (m3) return { query: m3[1], intent: 'measure' };

  const m4 = norm.match(/^measure\s+(?:the\s+)?distance\s*(?:to|of)?\s*(?:the\s+)?(.+)$/);
  if (m4) return { query: m4[1], intent: 'measure' };

  const m5 = norm.match(/^(coords?|coordinates)\s+(?:of|for)\s+(.+)$/);
  if (m5) return { query: m5[2], intent: 'coords' };

  // Track/follow/locate/center/focus patterns
  const m7 = norm.match(/^track\s+(?:the\s+)?(.+)$/);
  if (m7) return { query: m7[1], intent: 'detect' };
  const m8 = norm.match(/^(?:please\s+)?follow\s+(?:the\s+)?(.+)$/);
  if (m8) return { query: m8[1], intent: 'detect' };
  const m9 = norm.match(/^locate\s+(?:the\s+)?(.+)$/);
  if (m9) return { query: m9[1], intent: 'detect' };
  const m10 = norm.match(/^keep\s+(?:the\s+)?(.+)\s+(?:center|centered)\b/);
  if (m10) return { query: m10[1], intent: 'detect' };
  const m11 = norm.match(/^center\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (m11) return { query: m11[1], intent: 'detect' };
  const m12 = norm.match(/^focus\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (m12) return { query: m12[1], intent: 'detect' };

  const m6 = norm.match(/^find\s+(.+)$/);
  if (m6) {
    // Remove leading determiners and trailing intent words
    let q = m6[1].replace(/^(the|a|an)\s+/,'');
    q = q.replace(/\b(distance|dist|coords?|coordinates)\b$/,'').trim();
    return { query: q, intent: 'detect' };
  }

  // Fallback: treat full text as query
  return { query: norm, intent: 'detect' };
}

export async function runFindMeasure(
  phrase: string,
  opts: OrchestratorOptions
) {
  const { getSnapshot, sendBridge, log, showDetections, onResult, onStep } = opts;
  const start = Date.now();
  log(`Instruction: find "${phrase}" and measure distance`);

  // Snapshot
  onStep?.({ id: 'snapshot', state: 'running' });
  const tSnap = performance.now();
  const img = await getSnapshot();
  onStep?.({ id: 'snapshot', state: 'done', ms: performance.now() - tSnap });
  log('Snapshot captured');
  opts.onTrace?.('snapshot();', 'tool');

  // Detect
  onStep?.({ id: 'detect', state: 'running' });
  const tDet = performance.now();
  const { detections, meta } = await analyzeDetect({ imageBase64: img, query: phrase });
  opts.onTrace?.(`det = detect("${phrase}"); // ${detections.length} boxes`, 'tool');
  onStep?.({ id: 'detect', state: 'done', ms: performance.now() - tDet, note: `${(meta?.backend)||''}` });
  const httpInfo = meta?.httpBoxes !== undefined ? ` (http boxes=${meta?.httpBoxes})` : '';
  if (meta?.backend === 'fallback' && (meta?.httpBoxes ?? 0) === 0) {
    log(`Detector: http @ ${meta?.url || ''} returned 0 boxes; using fallback`);
  } else {
    log(`Detector: ${(meta?.backend || 'unknown')}${meta?.url ? ` @ ${meta.url}` : ''}${httpInfo}`);
  }
  if (!detections || detections.length === 0) {
    const text = `I couldn’t find "${phrase}".`;
    log(text);
    onResult?.({ text });
    return;
  }
  // If fallback used, annotate labels to make it visible on overlay
  const boxes = (meta?.backend === 'fallback') ? detections.map(d => ({ ...d, label: (d.label || phrase) })) : detections;
  showDetections?.(boxes);
  log(`Detections: ${boxes.length}`);
  const best = pickBest(boxes);
  const cx = clamp01((best.x1 + best.x2) / 2);
  const cy = clamp01((best.y1 + best.y2) / 2);
  const scorePct = best.score ? `${Math.round((best.score || 0) * 100)}%` : 'n/a';
  log(`Chosen box score=${scorePct} center=(${cx.toFixed(3)}, ${cy.toFixed(3)})`);
  opts.onTrace?.(`p = det[0]; p.cx=${cx.toFixed(3)}, p.cy=${cy.toFixed(3)}, p.score=${scorePct}`, 'var');

  // Center camera on target
  onStep?.({ id: 'look_at', state: 'running' });
  const tLook = performance.now();
  // Let the pre-slew box render at least one frame, then clear
  await flushUI();
  try { showDetections?.([]); } catch {}
  await flushUI();
  await sendBridge({ type: 'gimbal_tap_target', data: { x: cx, y: cy } });
  await sleep(600);
  onStep?.({ id: 'look_at', state: 'done', ms: performance.now() - tLook });
  opts.onTrace?.('look_at(p.cx, p.cy);', 'tool');

  // Optional: re-detect after settle to update overlay (helps visual alignment)
  try {
    onStep?.({ id: 'post_detect', state: 'running' });
    const tPost = performance.now();
    const post = await analyzeDetect({ imageBase64: await getSnapshot(), query: phrase });
    if (post?.detections?.length) {
      showDetections?.(post.detections);
      log(`post-detect → ${post.detections.length}`);
      const b = pickBest(post.detections);
      opts.onTrace?.(`post = detect("${phrase}"); // ${post.detections.length} boxes`, 'tool');
      if (b) {
        const pcx = clamp01((b.x1 + b.x2)/2); const pcy = clamp01((b.y1 + b.y2)/2);
        opts.onTrace?.(`post_best: cx=${pcx.toFixed(3)}, cy=${pcy.toFixed(3)}`, 'var');
      }
    }
    onStep?.({ id: 'post_detect', state: 'done', ms: performance.now() - tPost });
  } catch {}

  // Measure with LRF at center (more reliable after Look At)
  onStep?.({ id: 'laser_enable', state: 'running' });
  const tEn = performance.now();
  await sendBridge({ type: 'camera_laser_enable', data: { enabled: true } });
  onStep?.({ id: 'laser_enable', state: 'done', ms: performance.now() - tEn });
  await sleep(150);

  const mx = 0.5, my = 0.5;
  onStep?.({ id: 'laser_measure', state: 'running' });
  const tMeas = performance.now();
  const res: any = await sendBridge({ type: 'camera_laser_measure', data: { x: mx, y: my } });
  // Result will arrive asynchronously via bridge; we still compose a textual ack here
  log(`measure @ center (0.500, 0.500) → sent`);
  onStep?.({ id: 'laser_measure', state: 'done', ms: performance.now() - tMeas });
  opts.onTrace?.('sleep(150); laser_enable(true); laser_measure(0.5,0.5);', 'tool');

  const took = Date.now() - start;
  onResult?.({ text: `Locked target and measuring. (${took} ms)` });
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
    // Validation errors from planner
    if (Array.isArray((plan as any)?.errors) && (plan as any).errors.length) {
      opts.onPlanErrors?.((plan as any).errors);
      return;
    }
    // Prefer DSL program if provided
    if (plan?.program && plan.program?.body) {
      const body = Array.isArray(plan.program.body) ? plan.program.body : [];
      const countOps = (nodes:any[]):number => nodes.reduce((acc,n)=>{
        if (!n) return acc; if (n.type==='while' || n.type==='if') {
          const t = n.then||[]; const e = n.else||[]; const b = n.body||[]; return acc + 1 + countOps(t)+countOps(e)+countOps(b);
        } else return acc+1;
      },0);
      log(`Planner: program with ${countOps(body)} operations`);
      try { log(`Plan: ${JSON.stringify(plan.program.body).slice(0, 300)}${body.length>0? ' …' : ''}`); } catch {}
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

function sanitizePlan(steps: any[], instruction: string, log: (l: string)=>void): any[] {
  try {
    const out = steps.map(s => ({ ...s, args: { ...(s.args || {}) } }));
    // If there is a detect step, clean its query using the instruction and its own query
    const idx = out.findIndex(s => String(s.tool) === 'detect');
    if (idx >= 0) {
      const given = String(out[idx].args?.query || instruction || '').trim();
      const eq = extractQueryFromInstruction(given);
      const ei = extractQueryFromInstruction(instruction);
      const chosen = (ei.query && ei.query.length <= given.length) ? ei.query : eq.query;
      out[idx].args.query = chosen;
      log(`sanitized query → "${chosen}"`);
    }
    return out;
  } catch {
    return steps;
  }
}

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
    case 'while': {
      const maxIter = Number(node.max_iter ?? 50);
      const interval = Number(node.interval_ms ?? 500);
      let i=0;
      while (!opts.isCancelled?.() && i<maxIter && !!evalExpr(node.cond, {...ctx, vars:{...ctx.vars, elapsed_ms: performance.now()-ctx.started}})) {
        for (const n of (node.body||[])) { if (opts.isCancelled?.()) break; await execNode(n, ctx, opts, log); }
        i++;
        if (interval>0) await sleep(interval);
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
      const img = await opts.getSnapshot();
      const { detections, meta } = await analyzeDetect({ imageBase64: img, query });
      // augment with centers for convenience
      const aug = detections.map(d=>({ ...d, cx: clamp01((d.x1+d.x2)/2), cy: clamp01((d.y1+d.y2)/2) }));
      opts.showDetections?.(aug);
      log(`detect("${query}") → ${aug.length} [${meta?.backend||'n/a'}]`);
      // expose latest detection for subsequent calls even without assignment
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
      await flushUI(); opts.showDetections?.([]); await flushUI();
      await opts.sendBridge({ type: 'gimbal_tap_target', data: { x, y } });
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
    default:
      log(`unknown tool: ${tool}`);
      return null;
  }
}

function safeFmtArgs(a:any){ try{ return JSON.stringify(a)||'' }catch{ return ''}}
function safeFmtVal(v:any){ try{ const s=JSON.stringify(v); return s && s.length>120? s.slice(0,120)+'…': s }catch{ return String(v) }}
