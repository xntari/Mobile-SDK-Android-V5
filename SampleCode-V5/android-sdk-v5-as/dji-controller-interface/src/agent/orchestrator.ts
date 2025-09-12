import { analyzeDetect, Detection } from './visionClient';

export interface OrchestratorOptions {
  getSnapshot: () => Promise<string>; // returns base64 (data URL ok)
  sendBridge: (msg: any) => Promise<{ success: boolean; [k: string]: any } | void>;
  log: (line: string) => void;
  showDetections?: (boxes: Detection[]) => void;
  onResult?: (result: { text: string }) => void;
  onStep?: (info: { id: string; state: 'running' | 'done' | 'error'; ms?: number; note?: string }) => void;
  onPlan?: (steps: any[]) => void;
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

  // Detect
  onStep?.({ id: 'detect', state: 'running' });
  const tDet = performance.now();
  const { detections, meta } = await analyzeDetect({ imageBase64: img, query: phrase });
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

  // Center camera on target
  onStep?.({ id: 'look_at', state: 'running' });
  const tLook = performance.now();
  // Clear overlay prior to slewing for easier visual debug
  try { showDetections?.([]); } catch {}
  await sendBridge({ type: 'gimbal_tap_target', data: { x: cx, y: cy } });
  await sleep(600);
  onStep?.({ id: 'look_at', state: 'done', ms: performance.now() - tLook });

  // Optional: re-detect after settle to update overlay (helps visual alignment)
  try {
    onStep?.({ id: 'post_detect', state: 'running' });
    const tPost = performance.now();
    const post = await analyzeDetect({ imageBase64: await getSnapshot(), query: phrase });
    if (post?.detections?.length) {
      showDetections?.(post.detections);
      log(`post-detect → ${post.detections.length}`);
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
    let steps: any[] = plan?.steps || [];
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('no steps');
    log(`Planner: ${steps.length} steps`);
    try { log(`Plan: ${JSON.stringify(steps).slice(0, 300)}${steps.length>0? ' …' : ''}`); } catch {}
    // Sanitize detect query using local parser so free-form phrases still work
    steps = sanitizePlan(steps, instruction, log);
    opts.onPlan?.(steps);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await execStep(s, opts, log);
    }
    return;
  } catch (e) {
    log(`Planner unavailable, using built-in flow (${String(e)})`);
    const { query } = extractQueryFromInstruction(instruction);
    await runFindMeasure(query, opts);
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
      try { showDetections?.([]); } catch {}
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
