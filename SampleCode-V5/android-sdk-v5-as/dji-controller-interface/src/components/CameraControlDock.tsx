import React, { useMemo, useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Panel } from './Panel';
import { CollapsibleSection, SectionLabel } from './CollapsibleSection';
import { cameraControlStore, type CameraControlSnapshot } from '../state/cameraControls';
import { ManualTrackControls } from './ManualTrackControls';
import type { ManualTrackSettings, ManualTrackPresetId } from '../camera/manualTrack';
import type { LookAtCommandMode, CameraLensSelection, ThermalZoomLevel } from '../camera/types';
import { missionPlannerStore } from '../state/missionPlanner';
import type { ManualTargetState, PoiTarget } from '../types/missionPlanner';

const useMissionPoi = (): PoiTarget | null => {
  const [poi, setPoi] = useState<PoiTarget | null>(() => missionPlannerStore.getSnapshot().poiTarget ?? null);
  useEffect(() => missionPlannerStore.subscribePoiTarget(setPoi), []);
  return poi;
};

const useMissionManualTarget = (): ManualTargetState | null => {
  const [target, setTarget] = useState<ManualTargetState | null>(() => missionPlannerStore.getSnapshot().manualTarget ?? null);
  useEffect(() => missionPlannerStore.subscribeManualTarget(setTarget), []);
  return target;
};

const formatLatLon = (lat?: number | null, lon?: number | null) => {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return '—';
  }
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
};

const formatAltitude = (alt?: number | null) => {
  if (typeof alt !== 'number' || !Number.isFinite(alt)) return '—';
  return `${alt.toFixed(1)} m`;
};

const ButtonGroup: React.FC<{
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  value: string;
  onSelect: (value: string) => void;
}> = ({ options, value, onSelect }) => (
  <div className="flex gap-1 flex-wrap">
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        disabled={option.disabled}
        onClick={() => onSelect(option.value)}
        className={`px-2.5 py-1 text-[11px] rounded border transition ${
          option.disabled
            ? 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'
            : value === option.value
              ? 'border-sky-400 bg-sky-500/20 text-sky-100'
              : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-sky-400'
        }`}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const useCameraControlSnapshot = (): CameraControlSnapshot =>
  useSyncExternalStore(
    cameraControlStore.subscribe.bind(cameraControlStore),
    cameraControlStore.getSnapshot.bind(cameraControlStore),
  );

const handleWithFallback = async <T,>(
  handler: ((value: T) => Promise<void> | void) | undefined,
  value: T,
  fallback?: (value: T) => void,
) => {
  if (handler) {
    try {
      await handler(value);
      return;
    } catch (error) {
      console.error('Camera control handler failed', error);
    }
  }
  fallback?.(value);
};

const CameraControlDock: React.FC = () => {
  const cameraState = useCameraControlSnapshot();
  const poiTarget = useMissionPoi();
  const manualTarget = useMissionManualTarget();

  const handlers = cameraControlStore.getHandlers();

  const opticalZoomCandidates = useMemo(() => {
    const candidates = [1, 2, 4, 8, 16, 32, 64, 128];
    const min = cameraState.zoomRange?.min ?? 1;
    const max = cameraState.zoomRange?.max ?? 128;
    const filtered = candidates.filter((value) => value >= min - 1e-3 && value <= max + 1e-3);
    if (filtered.length) {
      return filtered;
    }
    const fallback = Math.max(min, 1);
    return [fallback];
  }, [cameraState.zoomRange]);

  const thermalZoomCandidates = useMemo(() => {
    const candidates = [2, 4, 8];
    const min = cameraState.thermalZoomRange?.min ?? 2;
    const max = cameraState.thermalZoomRange?.max ?? 8;
    const filtered = candidates.filter((value) => value >= min - 1e-3 && value <= max + 1e-3);
    if (filtered.length) {
      return filtered;
    }
    const fallback = Math.max(min, 2);
    return [fallback];
  }, [cameraState.thermalZoomRange]);

  const lookAtModeOptions = useMemo(
    () => [
      { value: 'GIMBAL_FOLLOWING', label: 'Gimbal + Aircraft' },
      { value: 'GIMBAL_FREE', label: 'Gimbal Only' },
      { value: 'ZOOM_CIRCLE', label: 'Zoom Circle' },
      { value: 'MANUAL_TRACK', label: 'Manual Track' },
    ],
    [],
  );

  const lensOptions: Array<{ value: CameraLensSelection; label: string }> = useMemo(
    () => [
      { value: 'wide', label: 'Wide' },
      { value: 'zoom', label: 'Zoom' },
      { value: 'infrared', label: 'Thermal' },
    ],
    [],
  );

  const gimbalModeOptions = useMemo(
    () => [
      { value: 'look_at', label: 'Look At' },
      { value: 'free_look', label: 'Free Look' },
    ],
    [],
  );

  const gimbalAttitudeOptions = useMemo(
    () => [
      { value: 'FREE', label: 'Free' },
      { value: 'YAW_FOLLOW', label: 'Yaw Follow' },
      { value: 'FPV', label: 'FPV' },
    ],
    [],
  );

  const handleManualTrackChange = useCallback(
    (updates: Partial<ManualTrackSettings>) => {
      if (handlers.updateManualTrackSettings) {
        handlers.updateManualTrackSettings(updates);
        return;
      }
      cameraControlStore.setManualTrackSettings(updates);
    },
    [handlers],
  );

  const handleManualTrackPreset = useCallback(
    (preset: ManualTrackPresetId) => {
      if (handlers.applyManualTrackPreset) {
        handlers.applyManualTrackPreset(preset);
        return;
      }
      cameraControlStore.applyManualTrackPreset(preset);
    },
    [handlers],
  );

  const formatCapabilityValue = useCallback((value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value.toString() : String(value);
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === 'number' ? item.toString() : String(item))).join(', ');
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }, []);

  const handleOpticalZoomSelect = useCallback(
    (value: number) => {
      cameraControlStore.setZoomRatio(value);
      handleWithFallback(handlers.setOpticalZoom, value, (ratio) => cameraControlStore.setZoomRatio(ratio));
    },
    [handlers],
  );

  const handleThermalZoomSelect = useCallback(
    (value: number) => {
      const level = value as ThermalZoomLevel;
      cameraControlStore.setThermalZoom(level);
      handleWithFallback(handlers.setThermalZoom, level, (ratio) => cameraControlStore.setThermalZoom(ratio as ThermalZoomLevel));
    },
    [handlers],
  );

  const toggleThermalSuperResolution = useCallback(() => {
    const next = !cameraState.thermalSuperResolution;
    cameraControlStore.setThermalSuperResolution(next);
    handleWithFallback(handlers.setThermalSuperResolution, next, (enabled) => cameraControlStore.setThermalSuperResolution(enabled));
  }, [cameraState.thermalSuperResolution, handlers]);

  const refreshCapabilities = useCallback(async () => {
    cameraControlStore.setCameraCapabilitiesLoading(true);
    cameraControlStore.setCameraCapabilitiesError(null);
    if (handlers.refreshCapabilities) {
      try {
        await handlers.refreshCapabilities();
        return;
      } catch (error) {
        cameraControlStore.setCameraCapabilitiesLoading(false);
        cameraControlStore.setCameraCapabilitiesError(
          error instanceof Error ? error.message : 'Failed to refresh',
        );
        return;
      }
    }
    try {
      await window.electronAPI?.sendBridgeCommand({ type: 'camera_capabilities' });
    } catch (error: any) {
      cameraControlStore.setCameraCapabilitiesLoading(false);
      cameraControlStore.setCameraCapabilitiesError(error?.message ?? 'Failed to refresh');
    }
  }, [handlers]);

  return (
    <Panel
      title="Camera Controls"
      defaultPosition={{ x: 1220, y: 20 }}
      defaultSize={{ w: 360, h: 520 }}
      storageKey="cameraControls.panel"
      visibilityEventType="cameraControlsPanelVisibilityChange"
      className="bg-black/60 text-gray-200"
    >
      <div className="space-y-3 text-xs h-full overflow-y-auto pr-1">
        <CollapsibleSection title="Snapshot & HUD" storageKey="cameraControls.section.snapshot">
          <SectionLabel label="Snapshot camera" />
          <ButtonGroup
            value={cameraState.snapshotCamera}
            onSelect={(value) => cameraControlStore.setSnapshotCamera(value as 'fpv' | 'h20n')}
            options={[
              { value: 'fpv', label: 'FPV' },
              { value: 'h20n', label: 'H20N' },
            ]}
          />
          <SectionLabel label="FPV HUD" />
          <div className="space-y-2">
            <ButtonGroup
              value={cameraState.fpvHud.enabled ? 'on' : 'off'}
              onSelect={(value) => cameraControlStore.setFpvHudSettings({ enabled: value === 'on' })}
              options={[
                { value: 'on', label: 'Enabled' },
                { value: 'off', label: 'Disabled' },
              ]}
            />
            <ButtonGroup
              value={cameraState.fpvHud.theme}
              onSelect={(value) => cameraControlStore.setFpvHudSettings({ theme: value as 'classic' | 'contrast' })}
              options={[
                { value: 'contrast', label: 'High Contrast' },
                { value: 'classic', label: 'Classic' },
              ]}
            />
            <ButtonGroup
              value={cameraState.fpvHud.overlayMode}
              onSelect={(value) => cameraControlStore.setFpvHudSettings({ overlayMode: value as 'none' | 'inline' | 'panel' })}
              options={[
                { value: 'panel', label: 'Panel' },
                { value: 'inline', label: 'Inline' },
                { value: 'none', label: 'None' },
              ]}
            />
            <label className="flex items-center gap-2 text-[11px] text-gray-300">
              <span>Overlay opacity</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(cameraState.fpvHud.overlayOpacity * 100)}
                onChange={(event) =>
                  cameraControlStore.setFpvHudSettings({ overlayOpacity: Number(event.target.value) / 100 })
                }
                className="flex-1"
              />
              <span className="w-10 text-right">{Math.round(cameraState.fpvHud.overlayOpacity * 100)}%</span>
            </label>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Gimbal & Lens" storageKey="cameraControls.section.gimbal">
          <SectionLabel label="Gimbal mode" />
          <ButtonGroup
            value={cameraState.gimbalMode}
            onSelect={(value) => handleWithFallback(handlers.setGimbalMode, value as any, (mode) => cameraControlStore.setGimbalMode(mode as any))}
            options={gimbalModeOptions}
          />
          <SectionLabel label="Gimbal attitude" />
          <ButtonGroup
            value={cameraState.gimbalAttitudeMode}
            onSelect={(value) => handleWithFallback(handlers.setGimbalAttitudeMode, value as any)}
            options={gimbalAttitudeOptions}
          />
          <SectionLabel label="Camera" />
          <ButtonGroup
            value={cameraState.selectedLens}
            onSelect={(value) => handleWithFallback(handlers.setLens, value as CameraLensSelection, cameraControlStore.setSelectedLens)}
            options={lensOptions}
          />
          {cameraState.selectedLens === 'zoom' && (
            <div className="space-y-2">
              <SectionLabel label="Zoom" />
              <ButtonGroup
                value={String(cameraState.zoomRatio ?? opticalZoomCandidates[0] ?? 1)}
                onSelect={(value) => handleOpticalZoomSelect(Number(value))}
                options={opticalZoomCandidates.map((candidate) => ({
                  value: String(candidate),
                  label: `${candidate}×`,
                  disabled: !handlers.setOpticalZoom,
                }))}
              />
              <div className="text-[11px] text-gray-500">
                Range {cameraState.zoomRange?.min?.toFixed(1) ?? '—'}× – {cameraState.zoomRange?.max?.toFixed(1) ?? '—'}×
              </div>
            </div>
          )}

          {cameraState.selectedLens === 'infrared' && (
            <div className="space-y-2">
              <SectionLabel label="Thermal zoom" />
              <ButtonGroup
                value={String(cameraState.thermalZoom ?? 1)}
                onSelect={(value) => handleThermalZoomSelect(Number(value))}
                options={thermalZoomCandidates.map((candidate) => ({
                  value: String(candidate),
                  label: `${candidate}×`,
                  disabled: !handlers.setThermalZoom,
                }))}
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-400">Super resolution</span>
                <button
                  type="button"
                  onClick={toggleThermalSuperResolution}
                  disabled={!handlers.setThermalSuperResolution}
                  className={`px-2 py-1 text-[11px] rounded border ${
                    cameraState.thermalSuperResolution
                      ? 'border-emerald-400 bg-emerald-500/20 text-emerald-100'
                      : 'border-gray-700 bg-gray-800 text-gray-300'
                  } ${handlers.setThermalSuperResolution ? '' : 'cursor-not-allowed opacity-60'}`}
                >
                  {cameraState.thermalSuperResolution ? 'On' : 'Off'}
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <SectionLabel label="Laser" />
            <button
              type="button"
              onClick={() => handleWithFallback(handlers.setLaserEnabled, !cameraState.laserEnabled, (v) => cameraControlStore.setLaserEnabled(v))}
              className={`px-2 py-1 text-[11px] rounded border ${
                cameraState.laserEnabled ? 'border-emerald-400 bg-emerald-500/20 text-emerald-100' : 'border-gray-700 bg-gray-800 text-gray-300'
              }`}
            >
              {cameraState.laserEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="POI & LookAt" storageKey="cameraControls.section.lookat">
          <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-300">
            <div>
              <SectionLabel label="Current POI" />
              <div>{formatLatLon(poiTarget?.latitude, poiTarget?.longitude)}</div>
              <div className="text-gray-500">Alt {formatAltitude(poiTarget?.altitude)}</div>
            </div>
            <div>
              <SectionLabel label="Staged target" />
              <div>{formatLatLon(manualTarget?.latitude, manualTarget?.longitude)}</div>
              <div className="text-gray-500">Alt {formatAltitude(manualTarget?.altitude)}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!handlers.setPoiFromManualTarget}
              onClick={() => handlers.setPoiFromManualTarget?.()}
              className={`px-2 py-1 text-[11px] rounded border ${
                handlers.setPoiFromManualTarget
                  ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Use staged target
            </button>
            <button
              type="button"
              disabled={!handlers.setPoiFromLaser || !cameraState.lastLaserResult}
              onClick={() => handlers.setPoiFromLaser?.()}
              className={`px-2 py-1 text-[11px] rounded border ${
                handlers.setPoiFromLaser && cameraState.lastLaserResult
                  ? 'border-emerald-400 bg-emerald-500/15 text-emerald-100'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Use last LRF
            </button>
            <button
              type="button"
              disabled={!handlers.clearPoi}
              onClick={() => handlers.clearPoi?.()}
              className={`px-2 py-1 text-[11px] rounded border ${
                handlers.clearPoi
                  ? 'border-gray-600 bg-gray-800 text-gray-300'
                  : 'border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Clear POI
            </button>
          </div>

          <div className="space-y-2">
            <div>
              <SectionLabel label="LookAt mode" />
              <select
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200"
                value={cameraState.lookAtMode}
                onChange={(event) => handleWithFallback(handlers.setLookAtMode, event.target.value as LookAtCommandMode, (mode) => cameraControlStore.setLookAtMode(mode))}
              >
                {lookAtModeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handlers.startLookAt?.(cameraState.lookAtMode)}
                className="flex-1 px-2 py-1 text-[11px] rounded border border-purple-400 bg-purple-500/20 text-purple-100 disabled:opacity-40"
                disabled={cameraState.lookAtBusy || !handlers.startLookAt}
              >
                Start
              </button>
              <button
                type="button"
                onClick={() => handlers.stopLookAt?.()}
                className="flex-1 px-2 py-1 text-[11px] rounded border border-gray-600 bg-gray-800 text-gray-200 disabled:opacity-40"
                disabled={!handlers.stopLookAt}
              >
                Stop
              </button>
            </div>
            <div className={`text-[11px] ${cameraState.lookAtBusy ? 'text-emerald-300' : 'text-gray-400'}`}>
              {cameraState.lookAtStatus || 'Idle'}
            </div>
          </div>

          <ManualTrackControls
            settings={cameraState.manualTrackSettings}
            activePreset={cameraState.manualTrackPreset}
            onChange={handleManualTrackChange}
            onSelectPreset={handleManualTrackPreset}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Capabilities" storageKey="cameraControls.section.capabilities" defaultOpen={false}>
          <div className="flex items-center justify-between">
            <SectionLabel label="Probe" />
            <button
              type="button"
              onClick={refreshCapabilities}
              className="px-2 py-1 text-[11px] rounded border border-gray-600 bg-gray-800 text-gray-200 hover:border-sky-400"
            >
              Refresh
            </button>
          </div>
          {cameraState.cameraCapabilitiesLoading && (
            <div className="text-[11px] text-gray-400">Loading…</div>
          )}
          {cameraState.cameraCapabilitiesError && (
            <div className="text-[11px] text-red-300">{cameraState.cameraCapabilitiesError}</div>
          )}
          <div className="space-y-1 max-h-40 overflow-auto">
            {cameraState.cameraCapabilities.length === 0 && !cameraState.cameraCapabilitiesLoading ? (
              <div className="text-[11px] text-gray-500">No data yet.</div>
            ) : (
              cameraState.cameraCapabilities.map((entry) => (
                <div key={entry.key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-gray-400">{entry.label ?? entry.key}</span>
                  <span className="text-gray-200 text-right font-mono">{formatCapabilityValue(entry.value)}</span>
                </div>
              ))
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Diagnostics" storageKey="cameraControls.section.diagnostics" defaultOpen={false}>
          <div className="space-y-2 text-[11px] text-gray-300">
            <div>
              <SectionLabel label="Last gimbal command" />
              {cameraState.lastGimbalCommand ? (
                <div className="font-mono text-[11px] space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        cameraState.lastGimbalCommand.status === 'SUCCESS'
                          ? 'bg-emerald-400'
                          : cameraState.lastGimbalCommand.status === 'ERROR'
                            ? 'bg-red-400'
                            : 'bg-gray-500'
                      }`}
                    />
                    <span className="text-gray-400">
                      {new Date(cameraState.lastGimbalCommand.timestamp ?? Date.now()).toLocaleTimeString()}
                    </span>
                    <span
                      className={
                        cameraState.lastGimbalCommand.status === 'SUCCESS'
                          ? 'text-emerald-300'
                          : cameraState.lastGimbalCommand.status === 'ERROR'
                            ? 'text-red-300'
                            : 'text-gray-200'
                      }
                    >
                      {cameraState.lastGimbalCommand.status ?? 'UNKNOWN'}
                    </span>
                  </div>
                  {cameraState.lastGimbalCommand.message && (
                    <div className="text-gray-200">
                      {cameraState.lastGimbalCommand.message}
                    </div>
                  )}
                  {cameraState.lastGimbalCommand.coordinates && (
                    <div className="text-gray-400">
                      ({cameraState.lastGimbalCommand.coordinates.x?.toFixed(3) ?? '—'},
                      {" "}
                      {cameraState.lastGimbalCommand.coordinates.y?.toFixed(3) ?? '—'})
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-gray-500">None</div>
              )}
            </div>
            <div>
              <SectionLabel label="Last laser reading" />
              {cameraState.lastLaserResult ? (
                <pre className="bg-black/30 border border-gray-800 rounded px-2 py-1 text-[10px] text-gray-300 max-h-32 overflow-auto">
                  {JSON.stringify(cameraState.lastLaserResult, null, 2)}
                </pre>
              ) : (
                <div className="text-gray-500">No measurements</div>
              )}
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </Panel>
  );
};

export default CameraControlDock;
