import { analyzeDetect, Detection } from './visionClient';
import { bridgeManager } from '../bridgeManager';
import { missionPlannerStore } from '../state/missionPlanner';
import { agentTelemetryStore } from '../state/agentTelemetry';
import { addMetersToLatLon, bearingOffsetToMeters, normalizeHeadingDegrees, EARTH_RADIUS_METERS } from '../utils/geo';

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
  const targetForTakeoff = Math.max(
    TAKEOFF_LIFT_THRESHOLD_M,
    Math.min(minMeters, TAKEOFF_LIFT_THRESHOLD_M + 0.8),
  );
  const settleFloor = Math.max(0.5, targetForTakeoff - ALTITUDE_SETTLE_MARGIN_M);
  const reached = await waitForAltitude(settleFloor, 20000, opts, log);
  const updated = getTelemetrySnapshot();
  const finalTelemetry = updated ?? telemetry;
  const finalAlt = getAltitudeAboveTakeoff(finalTelemetry);
  if (!reached && finalAlt < TAKEOFF_LIFT_THRESHOLD_M - 0.15) {
    throw new Error(`Takeoff did not reach lift threshold (${finalAlt.toFixed(2)} m)`);
  }
  if (!reached) {
    log(`Takeoff short of target (~${finalAlt.toFixed(2)} m vs ${targetForTakeoff.toFixed(2)} m); continuing with fallback`);
  }
  return finalTelemetry;
}

async function ensureVirtualStickIdle(opts: OrchestratorOptions, log: (l: string) => void) {
  const telemetry = getTelemetrySnapshot();
  const vsState = readVirtualStickState(telemetry);
  if (vsState.enabled && !vsState.manualOverride) {
    log('Virtual stick still enabled from previous command; disabling');
    try {
      await sendFlightCommand('virtual_stick_override', { ...VIRTUAL_STICK_ZERO_AXES }, opts);
    } catch (error) {
      log(`virtual_stick_override (zero) before disable failed: ${String(error)}`);
    }
    try {
      await sendFlightCommand('virtual_stick_disable', undefined, opts);
    } catch (error) {
      log(`virtual_stick_disable failed during idle ensure: ${String(error)}`);
    }
  }
  const updatedTelemetry = getTelemetrySnapshot();
  const updatedState = readVirtualStickState(updatedTelemetry);
  updateAgentTelemetry({
    virtualStickEnabled: updatedState.enabled,
    virtualStickOwner: updatedState.owner,
  });
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

const VIRTUAL_STICK_ZERO_AXES = Object.freeze({ yaw: 0, throttle: 0, roll: 0, pitch: 0 });
const VIRTUAL_STICK_THROTTLE_GAIN = 0.35;
const VIRTUAL_STICK_MAX_THROTTLE = 0.65;
const MANUAL_ALTITUDE_TOLERANCE_M = 0.35;
const MANUAL_ALTITUDE_TIMEOUT_MS = 20000;
const ALTITUDE_PROGRESS_EPS_M = 0.25;
const HORIZONTAL_PROGRESS_EPS_M = 0.4;
const ALTITUDE_STALE_ITERATION_LIMIT = 8;
const HORIZONTAL_STALE_ITERATION_LIMIT = 20;
const HORIZONTAL_TOLERANCE_M = 0.6;
const VIRTUAL_STICK_HORIZONTAL_GAIN = 0.15;
const VIRTUAL_STICK_MAX_HORIZONTAL = 0.35;

interface VirtualStickSnapshot {
  enabled: boolean;
  manualOverride: boolean;
  owner: string | null;
}

function readVirtualStickState(telemetry: any | null): VirtualStickSnapshot {
  const vs = telemetry?.virtual_stick ?? {};
  const enabled = Boolean(
    (typeof vs.enabled === 'boolean' ? vs.enabled : undefined) ?? telemetry?.virtual_stick_enabled,
  );
  const manualOverride = Boolean(
    (typeof vs.manual_override === 'boolean' ? vs.manual_override : undefined) ??
    telemetry?.virtual_stick_manual_override,
  );
  const ownerRaw =
    vs?.owner ??
    telemetry?.virtual_stick_owner ??
    null;
  const owner = ownerRaw != null ? String(ownerRaw).toUpperCase() : null;
  return { enabled, manualOverride, owner };
}

function updateAgentTelemetry(partial: Partial<Omit<ReturnType<typeof agentTelemetryStore.getSnapshot>, 'lastUpdateMs'>>, note?: string | null) {
  agentTelemetryStore.update(partial, { appendNote: note ?? null });
}

function computeNorthEastDelta(fromLat: number, fromLon: number, toLat: number, toLon: number) {
  const degToRad = Math.PI / 180;
  const dLat = (toLat - fromLat) * degToRad;
  const dLon = (toLon - fromLon) * degToRad;
  const meanLat = ((fromLat + toLat) / 2) * degToRad;
  const north = dLat * EARTH_RADIUS_METERS;
  const east = dLon * EARTH_RADIUS_METERS * Math.cos(meanLat);
  return { north, east };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function ensureVirtualStickControl(opts: OrchestratorOptions, log: (l: string) => void) {
  const snapshot: any = getTelemetrySnapshot();
  const virtualStick = snapshot?.virtual_stick ?? {};
  const enabled = Boolean(
    (virtualStick && typeof virtualStick.enabled === 'boolean' ? virtualStick.enabled : undefined) ??
      snapshot?.virtual_stick_enabled,
  );
  const manualOverride = Boolean(
    (virtualStick && typeof virtualStick.manual_override === 'boolean' ? virtualStick.manual_override : undefined) ??
      snapshot?.virtual_stick_manual_override,
  );
  const ownerRaw = (virtualStick && virtualStick.owner !== undefined ? virtualStick.owner : undefined) ?? snapshot?.virtual_stick_owner ?? '';
  const owner = String(ownerRaw ?? '').toUpperCase();

  if (manualOverride && owner && owner !== 'APP' && owner !== 'UNKNOWN' && owner !== 'NONE') {
    throw new Error(`Virtual stick currently controlled by ${owner}`);
  }

  if (!enabled) {
    log('Virtual stick not enabled – requesting control');
    const response = await sendFlightCommand('virtual_stick_enable', undefined, opts);
    if (response && response.success === false) {
      const message = response.error || response.error_message || response.message || 'virtual_stick_enable rejected';
      throw new Error(message);
    }
  }

  try {
    await sendFlightCommand('virtual_stick_override', { ...VIRTUAL_STICK_ZERO_AXES }, opts);
  } catch (error) {
    log(`virtual_stick_override (zero) failed during enable handshake: ${String(error)}`);
  }

  updateAgentTelemetry({
    virtualStickEnabled: true,
    virtualStickOwner: 'APP',
  });

  return { wasEnabled: enabled };
}

async function releaseVirtualStickControl(opts: OrchestratorOptions, log: (l: string) => void, wasEnabled: boolean) {
  try {
    await sendFlightCommand('virtual_stick_override', { ...VIRTUAL_STICK_ZERO_AXES }, opts);
  } catch (error) {
    log(`virtual_stick_override (zero) cleanup failed: ${String(error)}`);
  }

  if (!wasEnabled) {
    try {
      await sendFlightCommand('virtual_stick_disable', undefined, opts);
    } catch (error) {
      log(`virtual_stick_disable failed: ${String(error)}`);
    }
  }

  const telemetry = getTelemetrySnapshot();
  const vsState = readVirtualStickState(telemetry);
  updateAgentTelemetry({
    virtualStickEnabled: vsState.enabled,
    virtualStickOwner: vsState.owner,
  });
}

async function manualVerticalAdjustment(targetAGL: number, opts: OrchestratorOptions, log: (l: string) => void) {
  const { wasEnabled } = await ensureVirtualStickControl(opts, log);
  updateAgentTelemetry({ missionState: 'fallback', fallbackActive: true });
  const start = Date.now();
  try {
    while (Date.now() - start < MANUAL_ALTITUDE_TIMEOUT_MS) {
      const telemetry = getTelemetrySnapshot();
      const current = getAltitudeAboveTakeoff(telemetry);
      const delta = targetAGL - current;
      if (Math.abs(delta) <= MANUAL_ALTITUDE_TOLERANCE_M) {
        log(`Manual altitude adjust reached ${current.toFixed(2)} m (target ${targetAGL.toFixed(2)} m)`);
        updateAgentTelemetry({ altitudeCurrent: current });
        return true;
      }
      const throttle = clamp(delta * VIRTUAL_STICK_THROTTLE_GAIN, -VIRTUAL_STICK_MAX_THROTTLE, VIRTUAL_STICK_MAX_THROTTLE);
      await sendFlightCommand('virtual_stick_override', { ...VIRTUAL_STICK_ZERO_AXES, throttle }, opts);
      if (opts.isCancelled?.()) {
        return false;
      }
      await sleep(220);
    }
    log(`Manual altitude adjust timeout at target ${targetAGL.toFixed(2)} m`);
    return false;
  } finally {
    try {
      await sendFlightCommand('virtual_stick_override', { ...VIRTUAL_STICK_ZERO_AXES }, opts);
    } catch (error) {
      log(`virtual_stick_override zero during cleanup failed: ${String(error)}`);
    }
    await releaseVirtualStickControl(opts, log, wasEnabled);
    updateAgentTelemetry({ fallbackActive: false });
  }
}

async function manualHorizontalAdjustment(
  navStart: NavigationSnapshot,
  targetLat: number,
  targetLon: number,
  opts: OrchestratorOptions,
  log: (l: string) => void,
) {
  const { wasEnabled } = await ensureVirtualStickControl(opts, log);
  updateAgentTelemetry({ missionState: 'fallback', fallbackActive: true });
  const start = Date.now();
  const timeoutMs = 20000;
  const headingRad = ((navStart.heading ?? 0) * Math.PI) / 180;
  try {
    while (Date.now() - start < timeoutMs) {
      const telemetry = getTelemetrySnapshot();
      if (!telemetry?.location) {
        await sleep(220);
        continue;
      }
      const currentLat = Number(telemetry.location.latitude);
      const currentLon = Number(telemetry.location.longitude);
      if (!Number.isFinite(currentLat) || !Number.isFinite(currentLon)) {
        await sleep(220);
        continue;
      }
      const { north, east } = computeNorthEastDelta(currentLat, currentLon, targetLat, targetLon);
      const remaining = Math.hypot(north, east);
      updateAgentTelemetry({ horizontalRemaining: remaining });
      if (remaining <= HORIZONTAL_TOLERANCE_M) {
        log(`Manual horizontal adjust reached target (remaining ${remaining.toFixed(2)} m)`);
        return true;
      }

      const forward = Math.cos(headingRad) * north + Math.sin(headingRad) * east;
      const right = -Math.sin(headingRad) * north + Math.cos(headingRad) * east;
      const pitch = clamp(forward * VIRTUAL_STICK_HORIZONTAL_GAIN, -VIRTUAL_STICK_MAX_HORIZONTAL, VIRTUAL_STICK_MAX_HORIZONTAL);
      const roll = clamp(right * VIRTUAL_STICK_HORIZONTAL_GAIN, -VIRTUAL_STICK_MAX_HORIZONTAL, VIRTUAL_STICK_MAX_HORIZONTAL);

      await sendFlightCommand('virtual_stick_override', {
        ...VIRTUAL_STICK_ZERO_AXES,
        pitch,
        roll,
      }, opts);

      if (opts.isCancelled?.()) {
        return false;
      }

      await sleep(200);
    }
    log('Manual horizontal adjust timeout');
    return false;
  } finally {
    try {
      await sendFlightCommand('virtual_stick_override', { ...VIRTUAL_STICK_ZERO_AXES }, opts);
    } catch (error) {
      log(`virtual_stick_override zero during horizontal cleanup failed: ${String(error)}`);
    }
    await releaseVirtualStickControl(opts, log, wasEnabled);
    updateAgentTelemetry({ fallbackActive: false });
  }
}

async function monitorFlyToGoal(params: {
  targetLat: number;
  targetLon: number;
  targetAGL: number | null;
  requireAltitude: boolean;
  requireHorizontal: boolean;
  timeoutMs: number;
  opts: OrchestratorOptions;
}): Promise<{ altitudeAchieved: boolean; horizontalAchieved: boolean; finalAltitude: number; finalDistance: number; stalled: boolean }> {
  const { targetLat, targetLon, targetAGL, requireAltitude, requireHorizontal, timeoutMs, opts } = params;
  let altitudeAchieved = !requireAltitude;
  let horizontalAchieved = !requireHorizontal;
  const start = Date.now();
  let finalAltitude = 0;
  let finalDistance = Infinity;
  let stalled = false;
  let altitudeStaleCount = 0;
  let horizontalStaleCount = 0;
  let lastAltitude: number | null = null;
  let lastDistance: number | null = null;
  let altitudeProgress = !requireAltitude;
  let horizontalProgress = !requireHorizontal;

  while (Date.now() - start < timeoutMs) {
    const telemetry = getTelemetrySnapshot();
    if (!telemetry) {
      await sleep(400);
      continue;
    }

    const currentAltitude = getAltitudeAboveTakeoff(telemetry);
    finalAltitude = currentAltitude;
    if (!altitudeAchieved && targetAGL != null) {
      if (currentAltitude >= targetAGL - ALTITUDE_SETTLE_MARGIN_M) {
        altitudeAchieved = true;
      } else {
        if (lastAltitude != null && Math.abs(currentAltitude - lastAltitude) < ALTITUDE_PROGRESS_EPS_M) {
          altitudeStaleCount += 1;
        } else {
          altitudeStaleCount = 0;
          if (lastAltitude != null) altitudeProgress = true;
        }
        lastAltitude = currentAltitude;
      }
    }

    const lat = typeof telemetry?.location?.latitude === 'number' ? telemetry.location.latitude : null;
    const lon = typeof telemetry?.location?.longitude === 'number' ? telemetry.location.longitude : null;
    if (lat != null && lon != null) {
      finalDistance = haversineMeters({ latitude: lat, longitude: lon }, { latitude: targetLat, longitude: targetLon });
      if (!horizontalAchieved && finalDistance <= Math.max(MIN_HORIZONTAL_SEPARATION_M, 1.2)) {
        horizontalAchieved = true;
      } else if (!horizontalAchieved) {
        if (lastDistance != null && Math.abs(finalDistance - lastDistance) < HORIZONTAL_PROGRESS_EPS_M) {
          horizontalStaleCount += 1;
        } else {
          horizontalStaleCount = 0;
          if (lastDistance != null && finalDistance < lastDistance - HORIZONTAL_PROGRESS_EPS_M) {
            horizontalProgress = true;
          }
        }
        lastDistance = finalDistance;
      }
    }

    if (altitudeAchieved && horizontalAchieved) {
      break;
    }

    const altitudeStalled = requireAltitude && altitudeStaleCount >= ALTITUDE_STALE_ITERATION_LIMIT && !altitudeProgress;
    const horizontalStalled = requireHorizontal && horizontalStaleCount >= HORIZONTAL_STALE_ITERATION_LIMIT && !horizontalProgress;
    if (altitudeStalled || horizontalStalled) {
      stalled = true;
      break;
    }

    if (opts.isCancelled?.()) {
      break;
    }

    await sleep(400);
  }

  return { altitudeAchieved, horizontalAchieved, finalAltitude, finalDistance, stalled };
}

function pickRelativeFlyToExtras(args: Record<string, any> | undefined): RelativeFlyToExtras | undefined {
  if (!args) return undefined;
  const extras: RelativeFlyToExtras = {};
  if (args.max_speed !== undefined) extras.max_speed = args.max_speed;
  if (args.security_takeoff_height !== undefined) extras.security_takeoff_height = args.security_takeoff_height;
  if (args.reason !== undefined) extras.reason = args.reason;
  return extras;
}

async function executeMissionFlyTo(args: Record<string, any> | undefined, opts: OrchestratorOptions, log: (l: string) => void) {
  await ensureVirtualStickIdle(opts, log);
  const navStart = requireNavSnapshot();
  const target = (args?.target ?? {}) as Record<string, any>;
  const latRaw = target?.latitude;
  const lonRaw = target?.longitude;
  const hasLat = typeof latRaw === 'number' && Number.isFinite(latRaw);
  const hasLon = typeof lonRaw === 'number' && Number.isFinite(lonRaw);
  const destLat = hasLat ? Number(latRaw) : navStart.latitude;
  const destLon = hasLon ? Number(lonRaw) : navStart.longitude;
  const usingCurrentPosition = !hasLat && !hasLon;

  const altitudeReferenceRaw = typeof target?.altitude_reference === 'string' ? target.altitude_reference.toLowerCase() : 'relative_to_takeoff';
  if (altitudeReferenceRaw && altitudeReferenceRaw !== 'relative_to_takeoff') {
    throw new Error(`mission_fly_to currently supports altitude_reference="relative_to_takeoff" (received "${altitudeReferenceRaw}")`);
  }

  const altitudeRaw = target?.altitude;
  const navAltitude = navStart.aboveTakeoff;
  const hasAltitudeValue = altitudeRaw != null && Number.isFinite(Number(altitudeRaw));
  const requestedAltitude = hasAltitudeValue ? Number(altitudeRaw) : 0;
  const targetAGL = clampRelativeAltitude(
    hasAltitudeValue ? requestedAltitude : navAltitude,
    navAltitude,
  );

  const extras = pickRelativeFlyToExtras(args);

  let nav = navStart;
  if (nav.aboveTakeoff < TAKEOFF_LIFT_THRESHOLD_M && targetAGL > TAKEOFF_LIFT_THRESHOLD_M + 0.2) {
    log(`Ensuring airborne before mission_fly_to (current ${nav.aboveTakeoff.toFixed(2)} m → target ${targetAGL.toFixed(2)} m)`);
    const airborneTarget = Math.min(targetAGL, TAKEOFF_LIFT_THRESHOLD_M + 0.8);
    await ensureAirborne(airborneTarget, opts, log);
    nav = requireNavSnapshot();
  }

  const currentAltitude = nav.aboveTakeoff;
  const horizontalDistance = haversineMeters(
    { latitude: nav.latitude, longitude: nav.longitude },
    { latitude: destLat, longitude: destLon },
  );
  const requiresHorizontalMove = !usingCurrentPosition && horizontalDistance >= MIN_HORIZONTAL_SEPARATION_M;
  const requiresAltitudeChange = Math.abs(targetAGL - currentAltitude) > ALTITUDE_SETTLE_MARGIN_M;

  if (usingCurrentPosition && hasAltitudeValue) {
    opts.onTrace?.(
      `mission_fly_to absolute target ${targetAGL.toFixed(2)} m (current ${currentAltitude.toFixed(2)} m)`,
      'info',
    );
  }

  updateAgentTelemetry({
    missionState: 'executing',
    lastCommand: usingCurrentPosition && hasAltitudeValue
      ? `mission_fly_to set_height ${targetAGL.toFixed(1)}m`
      : requiresHorizontalMove
        ? `mission_fly_to horizontal ${horizontalDistance.toFixed(1)}m`
        : 'mission_fly_to',
    altitudeTarget: requiresAltitudeChange ? targetAGL : null,
    altitudeCurrent: currentAltitude,
    horizontalRemaining: requiresHorizontalMove ? horizontalDistance : null,
    fallbackActive: false,
  });

  if (!requiresHorizontalMove && !requiresAltitudeChange) {
    log('mission_fly_to: target matches current position/altitude; skipping');
    opts.onTrace?.(`mission_fly_to skipped (no delta)`, 'info');
    updateAgentTelemetry({
      missionState: 'idle',
      altitudeCurrent: currentAltitude,
      horizontalRemaining: null,
      fallbackActive: false,
    }, 'No delta – command skipped');
    return {
      ok: true,
      commandAccepted: false,
      altitudeAchieved: true,
      horizontalAchieved: true,
      fallbackUsed: false,
      finalAltitude: currentAltitude,
      finalDistance: 0,
    };
  }

  let commandAccepted = false;
  try {
    await dispatchRelativeFlyTo({
      nav,
      latitude: destLat,
      longitude: destLon,
      targetAGL,
      extras,
      opts,
      log,
      waitForAltitude: false,
    });
    commandAccepted = true;
    nav = requireNavSnapshot();
  } catch (error) {
    log(`mission_fly_to → fly_to_prepare failed: ${String(error)}`);
  }

  let altitudeAchieved = false;
  let horizontalAchieved = false;
  let finalAltitude = currentAltitude;
  let finalDistance = horizontalDistance;
  let horizontalStalled = false;

  if (commandAccepted) {
    const monitor = await monitorFlyToGoal({
      targetLat: destLat,
      targetLon: destLon,
      targetAGL,
      requireAltitude: requiresAltitudeChange,
      requireHorizontal: requiresHorizontalMove,
      timeoutMs: Math.max(18000, Math.min(60000, 12000 + horizontalDistance * 4000)),
      opts,
    });
    altitudeAchieved = monitor.altitudeAchieved;
    horizontalAchieved = monitor.horizontalAchieved;
    finalAltitude = monitor.finalAltitude;
    finalDistance = monitor.finalDistance;
    horizontalStalled = monitor.stalled && !horizontalAchieved && requiresHorizontalMove;
    updateAgentTelemetry({
      altitudeCurrent: finalAltitude,
      horizontalRemaining: requiresHorizontalMove ? finalDistance : null,
    });
    if (monitor.stalled && requiresAltitudeChange && !altitudeAchieved) {
      log('mission_fly_to detected stalled altitude progress');
      updateAgentTelemetry({ missionState: 'stalled' }, 'Altitude progress stalled');
    }
    if (monitor.stalled && requiresHorizontalMove && !horizontalAchieved) {
      log('mission_fly_to detected stalled horizontal progress');
      updateAgentTelemetry({ missionState: 'stalled' }, 'Horizontal progress stalled');
    }
    if (monitor.stalled && requiresAltitudeChange && !altitudeAchieved) {
      opts.onTrace?.('mission_fly_to stalled: altitude not progressing', 'warn');
    }
    if (monitor.stalled && requiresHorizontalMove && !horizontalAchieved) {
      opts.onTrace?.('mission_fly_to stalled: horizontal move not progressing', 'warn');
    }
    if (!monitor.stalled && requiresAltitudeChange && !altitudeAchieved) {
      opts.onTrace?.('mission_fly_to altitude timeout reached', 'warn');
    }
    if (!monitor.stalled && requiresHorizontalMove && !horizontalAchieved) {
      opts.onTrace?.('mission_fly_to horizontal timeout reached', 'warn');
    }
  }

  let fallbackUsed = false;
  if (!commandAccepted && requiresAltitudeChange) {
    fallbackUsed = true;
    log(`mission_fly_to command rejected; engaging virtual-stick fallback for altitude change to ${targetAGL.toFixed(2)} m`);
    const manualOk = await manualVerticalAdjustment(targetAGL, opts, log);
    const telemetryAfter = getTelemetrySnapshot();
    finalAltitude = getAltitudeAboveTakeoff(telemetryAfter);
    altitudeAchieved = manualOk && Math.abs(finalAltitude - targetAGL) <= MANUAL_ALTITUDE_TOLERANCE_M + 0.2;
    opts.onTrace?.('mission_fly_to fallback engaged (command rejected)', 'warn');
    updateAgentTelemetry({
      missionState: altitudeAchieved ? 'idle' : 'fallback',
      altitudeCurrent: finalAltitude,
      fallbackActive: !altitudeAchieved,
    }, altitudeAchieved ? 'Fallback recovered (command rejected)' : 'Fallback executing (command rejected)');
  } else if (requiresAltitudeChange && !altitudeAchieved) {
    fallbackUsed = true;
    log(`mission_fly_to altitude not reached via waypoint (${finalAltitude.toFixed(2)} m vs target ${targetAGL.toFixed(2)} m) – engaging virtual-stick fallback`);
    const manualOk = await manualVerticalAdjustment(targetAGL, opts, log);
    const telemetryAfter = getTelemetrySnapshot();
    finalAltitude = getAltitudeAboveTakeoff(telemetryAfter);
    altitudeAchieved = manualOk && Math.abs(finalAltitude - targetAGL) <= MANUAL_ALTITUDE_TOLERANCE_M + 0.2;
    opts.onTrace?.('mission_fly_to fallback engaged (no altitude progress)', 'warn');
    updateAgentTelemetry({
      missionState: altitudeAchieved ? 'idle' : 'fallback',
      altitudeCurrent: finalAltitude,
      fallbackActive: !altitudeAchieved,
    }, altitudeAchieved ? 'Fallback recovered (no altitude progress)' : 'Fallback executing (no altitude progress)');
  }

  if (!horizontalAchieved && requiresHorizontalMove && (horizontalStalled || !commandAccepted)) {
    log(`mission_fly_to horizontal goal not met (remaining ≈${finalDistance.toFixed(1)} m)`);
    updateAgentTelemetry({ missionState: 'stalled', horizontalRemaining: finalDistance }, 'Horizontal goal not met');

    const navLatest = requireNavSnapshot();
    const manualOk = await manualHorizontalAdjustment(navLatest, destLat, destLon, opts, log);
    const telemetryAfter = getTelemetrySnapshot();
    if (telemetryAfter?.location) {
      const currentLatAfter = Number(telemetryAfter.location.latitude);
      const currentLonAfter = Number(telemetryAfter.location.longitude);
      if (Number.isFinite(currentLatAfter) && Number.isFinite(currentLonAfter)) {
        const { north, east } = computeNorthEastDelta(currentLatAfter, currentLonAfter, destLat, destLon);
        finalDistance = Math.hypot(north, east);
        updateAgentTelemetry({ horizontalRemaining: finalDistance });
      }
    }
    horizontalAchieved = manualOk || finalDistance <= HORIZONTAL_TOLERANCE_M;
    updateAgentTelemetry({
      missionState: horizontalAchieved ? 'idle' : 'fallback',
    }, horizontalAchieved ? 'Horizontal fallback reached target' : 'Horizontal fallback incomplete');
  }

  if (altitudeAchieved && horizontalAchieved) {
    updateAgentTelemetry({ missionState: 'idle', fallbackActive: false });
  } else if (!fallbackUsed) {
    updateAgentTelemetry({ missionState: 'executing', fallbackActive: false });
  }

  return {
    ok: altitudeAchieved || horizontalAchieved,
    commandAccepted,
    altitudeAchieved,
    horizontalAchieved,
    fallbackUsed,
    finalAltitude,
    finalDistance,
  };
}

async function executeMissionRelativeMove(args: Record<string, any> | undefined, opts: OrchestratorOptions, log: (l: string) => void) {
  const axis = args?.axis;
  const distance = args?.distance_m;
  const plan = normalizeRelativeMoveAxis(axis, distance);
  if (!plan) {
    throw new Error('mission_relative_move axis invalid');
  }

  const nav = requireNavSnapshot();
  const extras = pickRelativeFlyToExtras(args);
  const altitudeDeltaRaw = Number.isFinite(Number(args?.altitude_delta_m)) ? Number(args?.altitude_delta_m) : 0;

  if (plan.kind === 'vertical') {
    const targetAGL = clampRelativeAltitude(nav.aboveTakeoff + plan.delta, nav.aboveTakeoff);
    const { axis: _axis, distance_m: _distance, altitude_delta_m: _delta, ...rest } = args || {};
    return executeMissionFlyTo({
      ...rest,
      target: {
        latitude: null,
        longitude: null,
        altitude: targetAGL,
        altitude_reference: 'relative_to_takeoff',
      },
      reason: rest?.reason ?? 'relative_vertical',
    }, opts, log);
  }

  let offsetNorth = 0;
  let offsetEast = 0;
  if (plan.kind === 'heading') {
    const baseHeading = normalizeHeadingDegrees(nav.heading ?? 0);
    const bearing = (() => {
      switch (plan.axis) {
        case 'forward': return baseHeading;
        case 'backward': return normalizeHeadingDegrees(baseHeading + 180);
        case 'left': return normalizeHeadingDegrees(baseHeading - 90);
        case 'right': return normalizeHeadingDegrees(baseHeading + 90);
        default: return baseHeading;
      }
    })();
    const offset = bearingOffsetToMeters(plan.distance, bearing);
    offsetNorth = offset.north;
    offsetEast = offset.east;
  } else if (plan.kind === 'absolute') {
    offsetNorth = plan.north;
    offsetEast = plan.east;
  }

  const destination = addMetersToLatLon(nav.latitude, nav.longitude, offsetNorth, offsetEast);
  const targetAGL = clampRelativeAltitude(nav.aboveTakeoff + altitudeDeltaRaw, nav.aboveTakeoff);

  const { axis: _axis, distance_m: _distance, altitude_delta_m: _delta, ...rest } = args || {};
  const nextArgs: Record<string, any> = {
    ...rest,
    target: {
      latitude: destination.latitude,
      longitude: destination.longitude,
      altitude: targetAGL,
      altitude_reference: 'relative_to_takeoff',
    },
    reason: rest?.reason ?? 'relative_move',
  };
  if (extras?.max_speed !== undefined) nextArgs.max_speed = extras.max_speed;
  if (extras?.security_takeoff_height !== undefined) nextArgs.security_takeoff_height = extras.security_takeoff_height;
  return executeMissionFlyTo(nextArgs, opts, log);
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
    let finalAxis = canonical;
    if (baseDistance < 0) {
      finalAxis = canonical === 'forward' ? 'backward'
        : canonical === 'backward' ? 'forward'
        : canonical === 'left' ? 'right'
        : canonical === 'right' ? 'left'
        : canonical;
    } else if (signPrefix === -1) {
      finalAxis = canonical === 'forward' ? 'backward'
        : canonical === 'backward' ? 'forward'
        : canonical === 'left' ? 'right'
        : canonical === 'right' ? 'left'
        : canonical;
    }
    const distance = absDistance;
    return { kind: 'heading', axis: finalAxis, distance };
  }

  const verticalSet = new Set(['vertical', 'up', 'upward', 'upwards', 'ascend', 'rise', 'climb', 'z']);
  const verticalDownSet = new Set(['down', 'downward', 'descend', 'drop', 'sink', '-z']);
  if (verticalSet.has(axis) || verticalDownSet.has(axis)) {
    if (baseDistance === 0) {
      return { kind: 'vertical', delta: 0 };
    }
    if (verticalDownSet.has(axis) && baseDistance > 0) {
      return { kind: 'vertical', delta: -absDistance };
    }
    if (verticalSet.has(axis) && baseDistance < 0) {
      return { kind: 'vertical', delta: -absDistance };
    }
    const direction = verticalDownSet.has(axis) || rawAxis.startsWith('-') || baseDistance < 0 ? -1 : 1;
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
      return executeMissionFlyTo(args, opts, log);
    }
    case 'mission_relative_move': {
      return executeMissionRelativeMove(args, opts, log);
    }
    default:
      log(`unknown tool: ${tool}`);
      return null;
  }
}

function safeFmtArgs(a:any){ try{ return JSON.stringify(a)||'' }catch{ return ''}}
function safeFmtVal(v:any){ try{ const s=JSON.stringify(v); return s && s.length>120? s.slice(0,120)+'…': s }catch{ return String(v) }}
