import React, { useState, useEffect, useCallback } from 'react';
import {
  requestLiveViewLocation,
  gimbalLookAt,
  registerLiveViewLocationListener,
  LookAtMode,
  type LiveViewLocationMessage
} from '../agent/cameraProjectionClient';

interface GPSTarget {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  altitude: number;
  pinPoint?: { x: number; y: number };
  isVisible?: boolean;
  direction?: string;
}

interface GPSTargetPanelProps {
  telemetryData: any;
  onTargetSelect?: (target: GPSTarget | null) => void;
}

export const GPSTargetPanel: React.FC<GPSTargetPanelProps> = ({ telemetryData, onTargetSelect }) => {
  const [targets, setTargets] = useState<GPSTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<GPSTarget | null>(null);
  const [lookAtMode, setLookAtMode] = useState<LookAtMode>('FREE');
  const [isTracking, setIsTracking] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newTargetInput, setNewTargetInput] = useState({
    name: '',
    latitude: '',
    longitude: '',
    altitude: ''
  });

  // Get aircraft location from telemetry
  const aircraftLocation = telemetryData?.aircraft_location;

  // Subscribe to live view location updates
  useEffect(() => {
    const unsubscribe = registerLiveViewLocationListener((message: LiveViewLocationMessage) => {
      if (message.request && message.pin_points?.[0]) {
        // Update the target with the projection result
        setTargets(prev => prev.map(target => {
          if (target.latitude === message.request.latitude &&
              target.longitude === message.request.longitude) {
            return {
              ...target,
              pinPoint: message.pin_points![0],
              isVisible: message.valid,
              direction: message.point_direction || undefined
            };
          }
          return target;
        }));
      }
    });

    return unsubscribe;
  }, []);

  // Update projections for all targets periodically
  useEffect(() => {
    const interval = setInterval(() => {
      targets.forEach(target => {
        requestLiveViewLocation({
          latitude: target.latitude,
          longitude: target.longitude,
          altitude: target.altitude,
          component: 'LEFT_OR_MAIN',
          requestId: target.id,
          source: 'gps_target_panel'
        });
      });
    }, 500); // Update 2 times per second

    return () => clearInterval(interval);
  }, [targets]);

  const handleAddTarget = useCallback(() => {
    const lat = parseFloat(newTargetInput.latitude);
    const lon = parseFloat(newTargetInput.longitude);
    const alt = parseFloat(newTargetInput.altitude);

    if (!isNaN(lat) && !isNaN(lon) && !isNaN(alt) && newTargetInput.name) {
      const newTarget: GPSTarget = {
        id: `target_${Date.now()}`,
        name: newTargetInput.name,
        latitude: lat,
        longitude: lon,
        altitude: alt
      };

      setTargets(prev => [...prev, newTarget]);
      setNewTargetInput({ name: '', latitude: '', longitude: '', altitude: '' });
      setShowAddDialog(false);
    }
  }, [newTargetInput]);

  const handleAddCurrentLocation = useCallback(() => {
    if (aircraftLocation) {
      setNewTargetInput({
        name: `Point ${targets.length + 1}`,
        latitude: aircraftLocation.latitude.toFixed(7),
        longitude: aircraftLocation.longitude.toFixed(7),
        altitude: aircraftLocation.altitude.toFixed(1)
      });
      setShowAddDialog(true);
    }
  }, [aircraftLocation, targets.length]);

  const handleSelectTarget = useCallback((target: GPSTarget) => {
    setSelectedTarget(target);
    onTargetSelect?.(target);
  }, [onTargetSelect]);

  const handleLookAt = useCallback(async () => {
    if (!selectedTarget) return;

    try {
      setIsTracking(true);
      await gimbalLookAt({
        latitude: selectedTarget.latitude,
        longitude: selectedTarget.longitude,
        altitude: selectedTarget.altitude,
        mode: lookAtMode
      });
    } catch (err) {
      console.error('Failed to look at target:', err);
      setIsTracking(false);
    }
  }, [selectedTarget, lookAtMode]);

  const handleStopTracking = useCallback(() => {
    setIsTracking(false);
    // Could send a stop command here if needed
  }, []);

  const handleDeleteTarget = useCallback((targetId: string) => {
    setTargets(prev => prev.filter(t => t.id !== targetId));
    if (selectedTarget?.id === targetId) {
      setSelectedTarget(null);
      onTargetSelect?.(null);
    }
  }, [selectedTarget, onTargetSelect]);

  return (
    <div className="gps-target-panel bg-gray-900 text-white p-4 rounded-lg">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">GPS Targets</h3>
        <div className="flex gap-2">
          <button
            onClick={handleAddCurrentLocation}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm"
            disabled={!aircraftLocation}
          >
            Add Current
          </button>
          <button
            onClick={() => setShowAddDialog(true)}
            className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-sm"
          >
            Add Custom
          </button>
        </div>
      </div>

      {/* Target List */}
      <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
        {targets.map(target => (
          <div
            key={target.id}
            className={`p-2 rounded cursor-pointer transition-colors ${
              selectedTarget?.id === target.id
                ? 'bg-blue-800 border border-blue-500'
                : 'bg-gray-800 hover:bg-gray-700'
            }`}
            onClick={() => handleSelectTarget(target)}
          >
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <div className="font-medium">{target.name}</div>
                <div className="text-xs text-gray-400">
                  {target.latitude.toFixed(6)}°, {target.longitude.toFixed(6)}°
                </div>
                <div className="text-xs text-gray-400">
                  Alt: {target.altitude.toFixed(1)}m
                </div>
                {target.isVisible !== undefined && (
                  <div className={`text-xs ${target.isVisible ? 'text-green-400' : 'text-red-400'}`}>
                    {target.isVisible ? '✓ In view' : '✗ Out of view'}
                    {target.direction && ` (${target.direction}°)`}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteTarget(target.id);
                }}
                className="text-red-500 hover:text-red-400 text-sm"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        {targets.length === 0 && (
          <div className="text-center text-gray-500 py-4">
            No targets added
          </div>
        )}
      </div>

      {/* Look At Controls */}
      {selectedTarget && (
        <div className="border-t border-gray-700 pt-4">
          <div className="mb-3">
            <label className="text-sm text-gray-400 block mb-1">Look At Mode</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setLookAtMode('FREE')}
                className={`px-2 py-1 rounded text-sm ${
                  lookAtMode === 'FREE'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300'
                }`}
              >
                Free
              </button>
              <button
                onClick={() => setLookAtMode('FOLLOWING')}
                className={`px-2 py-1 rounded text-sm ${
                  lookAtMode === 'FOLLOWING'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300'
                }`}
              >
                Follow
              </button>
              <button
                onClick={() => setLookAtMode('ZOOM_CIRCLE')}
                className={`px-2 py-1 rounded text-sm ${
                  lookAtMode === 'ZOOM_CIRCLE'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300'
                }`}
              >
                Circle
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            {!isTracking ? (
              <button
                onClick={handleLookAt}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 rounded font-medium"
              >
                Look At Target
              </button>
            ) : (
              <button
                onClick={handleStopTracking}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 rounded font-medium"
              >
                Stop Tracking
              </button>
            )}
          </div>
        </div>
      )}

      {/* Add Target Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-6 rounded-lg w-96">
            <h4 className="text-lg font-semibold mb-4">Add GPS Target</h4>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-400">Name</label>
                <input
                  type="text"
                  value={newTargetInput.name}
                  onChange={(e) => setNewTargetInput(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-1 bg-gray-700 rounded"
                  placeholder="Target name"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400">Latitude</label>
                <input
                  type="text"
                  value={newTargetInput.latitude}
                  onChange={(e) => setNewTargetInput(prev => ({ ...prev, latitude: e.target.value }))}
                  className="w-full px-3 py-1 bg-gray-700 rounded"
                  placeholder="37.12345"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400">Longitude</label>
                <input
                  type="text"
                  value={newTargetInput.longitude}
                  onChange={(e) => setNewTargetInput(prev => ({ ...prev, longitude: e.target.value }))}
                  className="w-full px-3 py-1 bg-gray-700 rounded"
                  placeholder="-122.12345"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400">Altitude (m)</label>
                <input
                  type="text"
                  value={newTargetInput.altitude}
                  onChange={(e) => setNewTargetInput(prev => ({ ...prev, altitude: e.target.value }))}
                  className="w-full px-3 py-1 bg-gray-700 rounded"
                  placeholder="100"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleAddTarget}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
              >
                Add
              </button>
              <button
                onClick={() => {
                  setShowAddDialog(false);
                  setNewTargetInput({ name: '', latitude: '', longitude: '', altitude: '' });
                }}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};