import React, { useState, useEffect } from 'react';
import { Panel } from './Panel';
import { registerLiveViewLocationListener } from '../agent/cameraProjectionClient';
import { projectionModeStore, type ProjectionMode } from '../state/projectionMode';

interface ProjectionControlsProps {
  onModeChange?: (mode: ProjectionMode) => void;
}

export const ProjectionControls: React.FC<ProjectionControlsProps> = ({ onModeChange }) => {
  const [mode, setMode] = useState<ProjectionMode>(projectionModeStore.getMode());

  const [stats, setStats] = useState({
    aircraft: { lat: 0, lon: 0, alt: 0, rawAlt: null as number | null, baroAlt: null as number | null, takeoffAlt: null as number | null },
    target: { lat: 0, lon: 0, alt: 0, projectionAlt: 0, distance: 0 },
    referenceAlt: 0,
    altDelta: 0,
    mode: projectionModeStore.getMode(),
    sample: '',
    capturedAt: '',
    camera: ''
  });

  useEffect(() => {
    // Subscribe to store changes
    const unsubscribe = projectionModeStore.subscribe((newMode) => {
      setMode(newMode);
      onModeChange?.(newMode);
    });

    return unsubscribe;
  }, [onModeChange]);

  useEffect(() => {
    // Listen for projection stats from camera_live_view_location messages
    const unsubscribe = registerLiveViewLocationListener((message) => {
      if (message.projection_stats) {
        const statsMsg = message.projection_stats as any;

        const aircraftLat = typeof statsMsg?.aircraft?.lat === 'number' ? statsMsg.aircraft.lat : 0;
        const aircraftLon = typeof statsMsg?.aircraft?.lon === 'number' ? statsMsg.aircraft.lon : 0;
        const aircraftAlt = typeof statsMsg?.aircraft?.alt === 'number' ? statsMsg.aircraft.alt : 0;
        const aircraftRawAlt = typeof statsMsg?.aircraft?.raw_alt === 'number' ? statsMsg.aircraft.raw_alt : null;
        const aircraftBaroAlt = typeof statsMsg?.aircraft?.baro_alt === 'number' ? statsMsg.aircraft.baro_alt : null;
        const aircraftTakeoffAlt = typeof statsMsg?.aircraft?.takeoff_alt === 'number' ? statsMsg.aircraft.takeoff_alt : null;

        const targetLat = typeof statsMsg?.target?.lat === 'number' ? statsMsg.target.lat : 0;
        const targetLon = typeof statsMsg?.target?.lon === 'number' ? statsMsg.target.lon : 0;
        const targetAlt = typeof statsMsg?.target?.alt === 'number' ? statsMsg.target.alt : 0;
        const targetProjectionAlt = typeof statsMsg?.target?.projection_alt === 'number'
          ? statsMsg.target.projection_alt
          : targetAlt;

        // Calculate distance from aircraft to target
        const R = 6371000; // Earth radius in meters
        const lat1Rad = aircraftLat * Math.PI / 180;
        const lat2Rad = targetLat * Math.PI / 180;
        const deltaLat = (targetLat - aircraftLat) * Math.PI / 180;
        const deltaLon = (targetLon - aircraftLon) * Math.PI / 180;

        const a = Math.sin(deltaLat/2) * Math.sin(deltaLat/2) +
                Math.cos(lat1Rad) * Math.cos(lat2Rad) *
                Math.sin(deltaLon/2) * Math.sin(deltaLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = R * c;

        setStats({
          aircraft: {
            lat: aircraftLat,
            lon: aircraftLon,
            alt: aircraftAlt,
            rawAlt: aircraftRawAlt,
            baroAlt: aircraftBaroAlt,
            takeoffAlt: aircraftTakeoffAlt
          },
          target: {
            lat: targetLat,
            lon: targetLon,
            alt: targetAlt,
            projectionAlt: targetProjectionAlt,
            distance
          },
          referenceAlt: typeof statsMsg?.reference_alt === 'number' ? statsMsg.reference_alt : aircraftAlt,
          altDelta: typeof statsMsg?.alt_delta === 'number' ? statsMsg.alt_delta : (targetProjectionAlt - aircraftAlt),
          mode: typeof statsMsg?.mode === 'string' ? statsMsg.mode as ProjectionMode : mode,
          sample: statsMsg.sample || '',
          capturedAt: statsMsg.capturedAt || '',
          camera: statsMsg.camera || ''
        });

        // Also update the mode if it differs
        if (statsMsg.mode && statsMsg.mode !== mode) {
          console.log(`Projection mode mismatch: UI=${mode}, Android=${statsMsg.mode}`);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [mode]);

  const handleModeChange = (newMode: ProjectionMode) => {
    projectionModeStore.setMode(newMode);
  };

  const getModeDescription = (m: ProjectionMode) => {
    switch (m) {
      case 'real':
        return 'Uses actual GPS coordinates and altitudes for projection';
      case 'horizontal':
        return 'Projects at same altitude (y≈0.5 for level targets)';
      case 'fallback':
        return 'Auto-adjusts for altitude reference mismatches';
    }
  };

  return (
    <Panel
      title="Projection Controls"
      storageKey="projectionControls.panel"
      visibilityEventType="projectionControlsVisibilityChange"
      defaultPosition={{ x: 20, y: 300 }}
      defaultSize={{ w: 380, h: 420 }}
    >
      <div className="p-2 space-y-2">
        {/* Mode Selection */}
        <div>
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">
            Projection Mode
          </div>
          <div className="flex flex-col gap-1">
            {(['real', 'horizontal', 'fallback'] as ProjectionMode[]).map((m) => (
              <button
                key={m}
                onClick={() => handleModeChange(m)}
                className={`px-2 py-1.5 rounded text-xs text-left transition-all ${
                  mode === m
                    ? 'bg-dji-blue text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300'
                }`}
              >
                <div className="font-medium">
                  {m === 'real' ? 'Real Coordinates' : m === 'fallback' ? 'Auto-Adjust' : 'Horizontal'}
                </div>
                <div className="text-[10px] opacity-75 mt-0.5">{getModeDescription(m)}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Current Stats Display */}
        <div className="border-t border-gray-700 pt-2 mt-2">
          <div className="text-[10px] text-gray-500 mb-1">
            Mode (Android): <span className="font-mono text-gray-300">{stats.mode}</span>
          </div>
          <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">
            Current Projection Data
          </div>

          {/* Aircraft Info */}
          <div className="mb-2">
            <div className="text-[10px] text-gray-400 uppercase mb-0.5">Aircraft</div>
            <div className="text-[11px] text-gray-300">
              <div>Lat: <span className="font-mono text-gray-200">{stats.aircraft.lat.toFixed(6)}</span></div>
              <div>Lon: <span className="font-mono text-gray-200">{stats.aircraft.lon.toFixed(6)}</span></div>
              <div>Ref Alt: <span className="font-mono text-gray-200">{stats.aircraft.alt.toFixed(1)} m</span></div>
              {typeof stats.aircraft.rawAlt === 'number' && (
                <div>Raw Alt: <span className="font-mono text-gray-400">{stats.aircraft.rawAlt.toFixed(1)} m</span></div>
              )}
              {typeof stats.aircraft.baroAlt === 'number' && (
                <div>Baro Alt: <span className="font-mono text-gray-400">{stats.aircraft.baroAlt.toFixed(1)} m</span></div>
              )}
              {typeof stats.aircraft.takeoffAlt === 'number' && (
                <div>Takeoff Alt: <span className="font-mono text-gray-400">{stats.aircraft.takeoffAlt.toFixed(1)} m</span></div>
              )}
            </div>
          </div>

          {/* Target Info */}
          <div className="mb-2">
            <div className="text-[10px] text-gray-400 uppercase mb-0.5">Target</div>
            <div className="text-[11px] text-gray-300">
              <div>Lat: <span className="font-mono text-gray-200">{stats.target.lat.toFixed(6)}</span></div>
              <div>Lon: <span className="font-mono text-gray-200">{stats.target.lon.toFixed(6)}</span></div>
              <div>Alt (reported): <span className="font-mono text-gray-200">{stats.target.alt.toFixed(1)} m</span></div>
              <div>Alt (projection): <span className="font-mono text-gray-200">{stats.target.projectionAlt.toFixed(1)} m</span></div>
              <div>Dist: <span className="font-mono text-gray-200">{stats.target.distance.toFixed(1)} m</span></div>
            </div>
          </div>

          {/* Deltas */}
          {stats.aircraft.lat !== 0 && (
            <div className="mb-2">
              <div className="text-[10px] text-gray-400 uppercase mb-0.5">Deltas</div>
              <div className="text-[11px] text-gray-300">
                <div>ΔE: <span className="font-mono text-gray-200">
                  {((stats.target.lon - stats.aircraft.lon) * 111320 * Math.cos(stats.aircraft.lat * Math.PI / 180)).toFixed(1)} m
                </span></div>
                <div>ΔN: <span className="font-mono text-gray-200">
                  {((stats.target.lat - stats.aircraft.lat) * 111320).toFixed(1)} m
                </span></div>
                <div>ΔU: <span className="font-mono text-gray-200">
                  {(stats.target.projectionAlt - stats.referenceAlt).toFixed(1)} m
                </span></div>
              </div>
            </div>
          )}

          {/* Message Info */}
          {stats.sample && (
            <div className="text-[10px] text-gray-500 mt-1">
              <div>Sample: <span className="font-mono">{stats.sample.substring(0, 10)}...</span></div>
              {stats.capturedAt && (
                <div>Time: {stats.capturedAt} • {stats.camera}</div>
              )}
            </div>
          )}
        </div>

        {/* Clear Button */}
        <button
          onClick={() => {
            setStats({
              aircraft: { lat: 0, lon: 0, alt: 0, rawAlt: null, baroAlt: null, takeoffAlt: null },
              target: { lat: 0, lon: 0, alt: 0, projectionAlt: 0, distance: 0 },
              referenceAlt: 0,
              altDelta: 0,
              mode: projectionModeStore.getMode(),
              sample: '',
              capturedAt: '',
              camera: ''
            });
            if ((window as any).dji?.sendCommand) {
              (window as any).dji.sendCommand({
                type: 'clear_projection_stats'
              });
            }
          }}
          className="w-full px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[11px] text-gray-400"
        >
          Clear Stats
        </button>
      </div>
    </Panel>
  );
};
