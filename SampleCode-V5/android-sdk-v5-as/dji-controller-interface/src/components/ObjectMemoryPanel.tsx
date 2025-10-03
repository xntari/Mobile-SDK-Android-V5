import React from 'react';
import { Panel } from './Panel';
import { CollapsibleSection } from './CollapsibleSection';
import {
  listClusters,
  getCluster,
  labelCluster,
  mergeClusters,
  moveSamples,
  deleteSample,
  deleteCluster,
  fetchSampleImage,
  updateClusterConfig,
  pruneCluster,
  type ObjectMemoryCluster,
  type ObjectMemorySample,
} from '../agent/objectMemoryClient';
import { objectMemoryTargetStore, type ObjectMemoryTargetSelection } from '../state/objectMemoryTargets';

interface ObjectMemoryPanelProps {
  defaultPosition?: { x: number; y: number };
  defaultSize?: { w: number; h: number };
}

type SampleThumb = { id: string; dataUrl: string };

export const ObjectMemoryPanel: React.FC<ObjectMemoryPanelProps> = ({ defaultPosition = { x: 40, y: 520 }, defaultSize = { w: 480, h: 360 } }) => {
  const [clusters, setClusters] = React.useState<ObjectMemoryCluster[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [message, setMessage] = React.useState<string>('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [clusterDetail, setClusterDetail] = React.useState<{ cluster: ObjectMemoryCluster; samples: ObjectMemorySample[] } | null>(null);
  const [labelInput, setLabelInput] = React.useState<string>('');
  const [maxSamplesInput, setMaxSamplesInput] = React.useState<number>(50);
  const [dedupeThresholdInput, setDedupeThresholdInput] = React.useState<number>(0.985);
  const [pruneSimilarity, setPruneSimilarity] = React.useState<number>(0.99);
  const [mergeSource, setMergeSource] = React.useState<string>('');
  const [selectedSamples, setSelectedSamples] = React.useState<string[]>([]);
  const [moveTargetId, setMoveTargetId] = React.useState<string>('');
  const [moveNewLabel, setMoveNewLabel] = React.useState<string>('');
  const thumbsRef = React.useRef<Map<string, SampleThumb>>(new Map());
  const [, forceTick] = React.useState<number>(0);
  const [activeTarget, setActiveTarget] = React.useState<ObjectMemoryTargetSelection | null>(() => objectMemoryTargetStore.getCurrent());
  const [sortMode, setSortMode] = React.useState<'updated'|'alpha'|'samples'|'cohesion'|'neighbor'|'detect'>(()=>{
    try {
      const raw = localStorage.getItem('objectMemory.sortMode');
      if (raw === 'alpha' || raw === 'samples' || raw === 'cohesion' || raw === 'updated' || raw === 'neighbor' || raw === 'detect') return raw;
    } catch {}
    return 'updated';
  });
  const [sortDirection, setSortDirection] = React.useState<'asc'|'desc'>(()=>{
    try {
      const raw = localStorage.getItem('objectMemory.sortDirection');
      if (raw === 'asc' || raw === 'desc') return raw;
    } catch {}
    return 'desc';
  });

  React.useEffect(()=>{ try { localStorage.setItem('objectMemory.sortMode', sortMode); } catch {} }, [sortMode]);
  React.useEffect(()=>{ try { localStorage.setItem('objectMemory.sortDirection', sortDirection); } catch {} }, [sortDirection]);

  React.useEffect(() => {
    return objectMemoryTargetStore.subscribe(setActiveTarget);
  }, []);

  const applySort = React.useCallback((items: ObjectMemoryCluster[]): ObjectMemoryCluster[] => {
    const list = [...items];
    const dir = sortDirection === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortMode) {
        case 'alpha': {
          const la = (a.label || '').toLowerCase();
          const lb = (b.label || '').toLowerCase();
          if (la && lb) return dir * la.localeCompare(lb);
          if (la && !lb) return dir * -1;
          if (!la && lb) return dir * 1;
          return dir * a.cluster_id.localeCompare(b.cluster_id);
        }
        case 'samples': {
          const diff = (a.sample_count ?? 0) - (b.sample_count ?? 0);
          if (diff !== 0) return dir * diff;
          return dir * a.cluster_id.localeCompare(b.cluster_id);
        }
        case 'cohesion': {
          const valA = a.mean_similarity ?? -1;
          const valB = b.mean_similarity ?? -1;
          if (valA !== valB) return dir * (valA > valB ? 1 : -1);
          return dir * a.cluster_id.localeCompare(b.cluster_id);
        }
        case 'neighbor': {
          const valA = a.nearest_neighbor_similarity ?? -1;
          const valB = b.nearest_neighbor_similarity ?? -1;
          if (valA !== valB) return dir * (valA > valB ? 1 : -1);
          return dir * a.cluster_id.localeCompare(b.cluster_id);
        }
        case 'detect': {
          const topA = a.detect_label_stats && a.detect_label_stats.length ? a.detect_label_stats[0] : undefined;
          const topB = b.detect_label_stats && b.detect_label_stats.length ? b.detect_label_stats[0] : undefined;
          const countDiff = (topA?.count ?? 0) - (topB?.count ?? 0);
          if (countDiff !== 0) return dir * countDiff;
          const labelA = topA?.label ?? '';
          const labelB = topB?.label ?? '';
          if (labelA && labelB && labelA !== labelB) return dir * labelA.localeCompare(labelB);
          return dir * a.cluster_id.localeCompare(b.cluster_id);
        }
        case 'updated':
        default: {
          const aTs = a.updated_ts ?? a.created_ts ?? 0;
          const bTs = b.updated_ts ?? b.created_ts ?? 0;
          if (aTs !== bTs) return dir * (aTs - bTs);
          return dir * a.cluster_id.localeCompare(b.cluster_id);
        }
      }
    });
    return list;
  }, [sortMode, sortDirection]);

  React.useEffect(() => {
    setClusters(prev => applySort(prev));
  }, [applySort]);

  const refreshClusters = React.useCallback(async (): Promise<ObjectMemoryCluster[]> => {
    setLoading(true);
    setMessage('');
    let sorted: ObjectMemoryCluster[] = [];
    try {
      const res = await listClusters({ limit: 200 });
      sorted = applySort(res.clusters);
      setClusters(sorted);
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
      sorted = [];
    } finally {
      setLoading(false);
    }
    return sorted;
  }, [applySort]);

  const toggleSampleSelection = React.useCallback((sampleId: string) => {
    setSelectedSamples(prev => (prev.includes(sampleId) ? prev.filter((id) => id !== sampleId) : [...prev, sampleId]));
  }, []);

  const clearSelection = React.useCallback(() => {
    setSelectedSamples([]);
  }, []);

  const loadCluster = React.useCallback(async (clusterId: string) => {
    setLoading(true);
    setMessage('');
    thumbsRef.current.clear();
    try {
      const detail = await getCluster(clusterId);
      setClusterDetail(detail);
      setSelectedId(clusterId);
      setLabelInput(detail.cluster.label || '');
      setSelectedSamples([]);
      setMoveTargetId('');
      setMoveNewLabel('');
      if (typeof detail.cluster.max_samples === 'number') {
        setMaxSamplesInput(detail.cluster.max_samples);
      }
      if (typeof detail.cluster.dedupe_threshold === 'number') {
        setDedupeThresholdInput(detail.cluster.dedupe_threshold);
        setPruneSimilarity(detail.cluster.dedupe_threshold);
      } else {
        setPruneSimilarity(0.99);
      }
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshClusters();
  }, [refreshClusters]);

  const trimmedMoveLabel = moveNewLabel.trim();
  const selectedCount = selectedSamples.length;
  const canMoveSelected = selectedCount > 0 && (moveTargetId || trimmedMoveLabel.length > 0);
  const activeAnchorSampleId = activeTarget?.anchor.sample_id;
  const summarizeDetectLabels = React.useCallback((stats?: { label: string; count: number }[], limit: number = 3): string => {
    if (!stats || !stats.length) return '';
    return stats.slice(0, limit).map((s) => `${s.label}(${s.count})`).join(', ');
  }, []);
  const formatCoord = React.useCallback((value?: number, digits: number = 6) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toFixed(digits);
  }, []);
  const formatAltitude = React.useCallback((value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return `${value.toFixed(1)} m`;
  }, []);
  const formatDistance = React.useCallback((value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    if (value >= 1000) return `${(value / 1000).toFixed(2)} km`;
    return `${value.toFixed(1)} m`;
  }, []);
  const formatOffset = React.useCallback((value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return `${value.toFixed(1)} m`;
  }, []);
  const formatTimestamp = React.useCallback((value?: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  }, []);
  const selectedClusterAnchor = clusterDetail?.cluster.object_map_anchor ?? null;
  const selectedAnchorIsActive = Boolean(
    selectedClusterAnchor &&
    activeTarget?.clusterId === clusterDetail?.cluster.cluster_id &&
    activeAnchorSampleId === selectedClusterAnchor.sample_id
  );

  const handleLabelSave = React.useCallback(async () => {
    if (!selectedId) return;
    try {
      await labelCluster(selectedId, labelInput);
      await loadCluster(selectedId);
      await refreshClusters();
      setMessage('Label updated');
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, labelInput, loadCluster, refreshClusters]);

  const handleMerge = React.useCallback(async () => {
    if (!selectedId || !mergeSource || mergeSource === selectedId) return;
    try {
      await mergeClusters(selectedId, [mergeSource]);
      setMergeSource('');
      await loadCluster(selectedId);
      await refreshClusters();
      setMessage('Merged clusters');
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, mergeSource, loadCluster, refreshClusters]);

  const handleMoveSelected = React.useCallback(async () => {
    const sampleIds = [...selectedSamples];
    if (!sampleIds.length) return;
    const targetId = moveTargetId;
    const newLabel = moveNewLabel.trim();
    if (!targetId && !newLabel) {
      setMessage('Choose a destination cluster or enter a new label');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const payload: { sampleIds: string[]; targetClusterId?: string; newLabel?: string } = { sampleIds };
      if (targetId) payload.targetClusterId = targetId;
      if (newLabel) payload.newLabel = newLabel;
      const res = await moveSamples(payload);
      const updated = await refreshClusters();
      const currentClusterId = selectedId;
      const currentStillExists = currentClusterId ? updated.some((c) => c.cluster_id === currentClusterId) : false;
      setSelectedSamples([]);
      setMoveTargetId('');
      setMoveNewLabel('');
      if (currentStillExists && currentClusterId) {
        await loadCluster(currentClusterId);
      } else if (res.created && res.target?.cluster_id) {
        await loadCluster(res.target.cluster_id);
      } else {
        thumbsRef.current.clear();
        setClusterDetail(null);
        setSelectedId(null);
        setLabelInput('');
        setMergeSource('');
      }
      const movedCount = res.moved?.length ?? sampleIds.length;
      setMessage(`Moved ${movedCount} sample${movedCount === 1 ? '' : 's'}`);
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [selectedSamples, moveTargetId, moveNewLabel, refreshClusters, selectedId, loadCluster]);

  const handleDeleteCluster = React.useCallback(async () => {
    if (!selectedId) return;
    const label = clusterDetail?.cluster.label || selectedId;
    const sampleCount = clusterDetail?.cluster.sample_count ?? 0;
    const confirmed = window.confirm(`Delete cluster "${label}" and its ${sampleCount} samples? This cannot be undone.`);
    if (!confirmed) return;
    setLoading(true);
    setMessage('');
    try {
      await deleteCluster(selectedId);
      thumbsRef.current.clear();
      setClusterDetail(null);
      setSelectedId(null);
      setLabelInput('');
      setMergeSource('');
      setSelectedSamples([]);
      setMoveTargetId('');
      setMoveNewLabel('');
      await refreshClusters();
      setMessage('Cluster deleted');
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [selectedId, clusterDetail, refreshClusters]);

  const handleDeleteSample = React.useCallback(async (sampleId: string) => {
    if (!selectedId) return;
    try {
      await deleteSample(sampleId);
      setSelectedSamples((prev) => prev.filter((id) => id !== sampleId));
      thumbsRef.current.delete(sampleId);
      await loadCluster(selectedId);
      await refreshClusters();
      setMessage('Deleted sample');
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, loadCluster, refreshClusters]);

  const handleConfigSave = React.useCallback(async () => {
    if (!selectedId) return;
    try {
      await updateClusterConfig(selectedId, { maxSamples: maxSamplesInput, dedupeThreshold: dedupeThresholdInput });
      await loadCluster(selectedId);
      await refreshClusters();
      setMessage('Cluster settings updated');
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, maxSamplesInput, dedupeThresholdInput, loadCluster, refreshClusters]);

  const handlePrune = React.useCallback(async () => {
    if (!selectedId) return;
    try {
      const res = await pruneCluster(selectedId, pruneSimilarity);
      await loadCluster(selectedId);
      await refreshClusters();
      setMessage(`Removed ${res.removed.length} duplicates`);
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
  }, [selectedId, pruneSimilarity, loadCluster, refreshClusters]);

  React.useEffect(() => {
    let cancelled = false;
    const loadAll = async () => {
      if (!clusterDetail?.samples) return;
      for (const sample of clusterDetail.samples) {
        if (cancelled) break;
        if (thumbsRef.current.has(sample.sample_id)) continue;
        try {
          const dataUrl = await fetchSampleImage(sample.sample_id);
          if (cancelled) break;
          thumbsRef.current.set(sample.sample_id, { id: sample.sample_id, dataUrl });
          forceTick((x) => x + 1);
        } catch (e) {
          if (!cancelled) {
            console.warn('[ObjectMemory] failed to load image', e);
          }
        }
      }
    };
    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [clusterDetail?.cluster.cluster_id, clusterDetail?.samples, fetchSampleImage]);

  return (
    <Panel
      title="Object Memory"
      defaultPosition={defaultPosition}
      defaultSize={defaultSize}
      storageKey="objectMemory.panel"
      visibilityEventType="objectMemoryPanelVisibilityChange"
    >
      <div className="space-y-3 text-xs text-gray-200 h-full overflow-y-auto pr-1">
        <CollapsibleSection
          title="Cluster Browser"
          storageKey="objectMemory.section.browser"
          summary={
            loading
              ? 'Loading…'
              : clusters.length
              ? `${clusters.length} clusters`
              : 'No clusters'
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
              onClick={refreshClusters}
              disabled={loading}
            >
              Refresh
            </button>
            <label className="flex items-center gap-1 text-[10px] text-gray-400">
              sort
              <select
                className="bg-gray-800 text-xs px-2 py-1 rounded"
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as any)}
              >
                <option value="updated">recent</option>
                <option value="alpha">name</option>
                <option value="samples">samples</option>
                <option value="cohesion">cohesion</option>
                <option value="neighbor">nearest</option>
                <option value="detect">det label</option>
              </select>
            </label>
            <button
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px]"
              onClick={() => setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'))}
              title={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
            >
              {sortDirection === 'asc' ? '↑' : '↓'}
            </button>
          </div>
          {(loading || message) && (
            <div className="text-[10px] text-gray-500 flex items-center gap-2">
              {loading && <span>loading…</span>}
              {message && <span className="truncate max-w-[240px]">{message}</span>}
            </div>
          )}
          <div className="mt-2 border border-gray-700 rounded bg-black/30 max-h-72 overflow-y-auto">
            {clusters.map((cluster) => (
              <button
                key={cluster.cluster_id}
                className={`block w-full text-left text-[11px] px-2 py-1 border-b border-gray-800 last:border-b-0 ${selectedId === cluster.cluster_id ? 'bg-gray-800/70' : 'hover:bg-gray-900/70'}`}
                onClick={() => void loadCluster(cluster.cluster_id)}
              >
                <div className="font-semibold text-gray-100 flex items-center gap-1">
                  <span>{cluster.label || '(unlabeled)'}</span>
                  {cluster.object_map_anchor ? (
                    <span
                      className={`${activeTarget?.clusterId === cluster.cluster_id ? 'text-amber-400' : 'text-emerald-400'} text-[11px]`}
                      title="Has laser telemetry anchor"
                    >
                      📍
                    </span>
                  ) : null}
                </div>
                <div className="text-gray-500">
                  {cluster.sample_count} samples · {cluster.status}
                  {typeof cluster.mean_similarity === 'number' ? ` · μ ${cluster.mean_similarity.toFixed(3)}` : ''}
                  {typeof cluster.nearest_neighbor_similarity === 'number' ? ` · ↔ ${cluster.nearest_neighbor_similarity.toFixed(3)}` : ''}
                </div>
                {cluster.detect_label_stats?.length ? (
                  <div className="text-gray-600 text-[10px]">
                    det: {summarizeDetectLabels(cluster.detect_label_stats, 3)}
                  </div>
                ) : null}
              </button>
            ))}
            {!clusters.length && !loading && (
              <div className="px-2 py-3 text-[11px] text-gray-500">No clusters yet</div>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Cluster Detail"
          storageKey="objectMemory.section.detail"
          summary={
            clusterDetail
              ? clusterDetail.cluster.label || clusterDetail.cluster.cluster_id
              : selectedId || 'Not selected'
          }
        >
          {selectedId && clusterDetail ? (
            <div className="space-y-3">
              <CollapsibleSection
                title="Overview"
                storageKey="objectMemory.detail.section.overview"
              >
                <div className="space-y-1 text-[11px] text-gray-300">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-gray-400 uppercase tracking-wide text-[10px]">Cluster</span>
                    <code className="text-[10px] bg-gray-800 px-2 py-0.5 rounded">{clusterDetail.cluster.cluster_id}</code>
                    <span className="text-[10px] text-gray-500">
                      {clusterDetail.cluster.sample_count} samples · max {clusterDetail.cluster.max_samples ?? maxSamplesInput}
                      {typeof clusterDetail.cluster.mean_similarity === 'number' ? ` · μ ${clusterDetail.cluster.mean_similarity.toFixed(3)}` : ''}
                      {typeof clusterDetail.cluster.nearest_neighbor_similarity === 'number' ? ` · ↔ ${clusterDetail.cluster.nearest_neighbor_similarity.toFixed(3)}` : ''}
                    </span>
                  </div>
                  {clusterDetail.cluster.nearest_neighbor_id && (
                    <div className="text-[10px] text-gray-500">
                      nearest cluster: <code className="bg-gray-800 px-1 py-0.5 rounded">{clusterDetail.cluster.nearest_neighbor_id}</code>
                      {typeof clusterDetail.cluster.nearest_neighbor_similarity === 'number' ? ` (${clusterDetail.cluster.nearest_neighbor_similarity.toFixed(3)})` : ''}
                    </div>
                  )}
                  {clusterDetail.cluster.detect_label_stats?.length ? (
                    <div className="text-[10px] text-gray-400">
                      YOLO labels: {summarizeDetectLabels(clusterDetail.cluster.detect_label_stats, 5)}
                    </div>
                  ) : null}
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                title="Anchor & Target"
                storageKey="objectMemory.detail.section.anchor"
                defaultOpen={Boolean(selectedClusterAnchor)}
                summary={selectedClusterAnchor ? 'Anchor set' : 'No anchor'}
              >
                {selectedClusterAnchor ? (
                  <div className="bg-gray-900/70 border border-emerald-600/70 rounded p-2 text-[10px] text-gray-200 flex flex-col gap-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-emerald-300 font-semibold uppercase tracking-wide">
                        <span>Laser Anchor</span>
                        {selectedAnchorIsActive && (
                          <span className="text-amber-300 text-[9px] font-normal uppercase">active</span>
                        )}
                      </div>
                      <div className="text-gray-500 font-mono">sample {selectedClusterAnchor.sample_id}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                      <div>
                        <div className="text-gray-500 uppercase tracking-wide">Target</div>
                        <div>Lat {formatCoord(selectedClusterAnchor.object_position.latitude)}</div>
                        <div>Lon {formatCoord(selectedClusterAnchor.object_position.longitude)}</div>
                        <div>Alt {formatAltitude(selectedClusterAnchor.object_position.altitude_m)}</div>
                        <div>Dist {formatDistance(selectedClusterAnchor.distance_m)}</div>
                      </div>
                      <div>
                        <div className="text-gray-500 uppercase tracking-wide">Aircraft</div>
                        <div>Lat {formatCoord(selectedClusterAnchor.drone_position.latitude)}</div>
                        <div>Lon {formatCoord(selectedClusterAnchor.drone_position.longitude)}</div>
                        <div>Alt {formatAltitude(selectedClusterAnchor.drone_position.altitude_m)}</div>
                        {selectedClusterAnchor.object_map?.enu_offset ? (
                          <div className="text-gray-500">
                            ΔE {formatOffset(selectedClusterAnchor.object_map.enu_offset.east)} · ΔN {formatOffset(selectedClusterAnchor.object_map.enu_offset.north)} · ΔU {formatOffset(selectedClusterAnchor.object_map.enu_offset.up)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <div className="text-gray-500">Captured {formatTimestamp(selectedClusterAnchor.timestamp ?? selectedClusterAnchor.sample_created_ts)}</div>
                      {selectedClusterAnchor.source_camera && (
                        <div className="text-gray-500">via {selectedClusterAnchor.source_camera}</div>
                      )}
                      <div className="flex-1" />
                      {!selectedAnchorIsActive ? (
                        <button
                          className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-gray-100"
                          onClick={() =>
                            objectMemoryTargetStore.set({
                              clusterId: clusterDetail.cluster.cluster_id,
                              clusterLabel: clusterDetail.cluster.label,
                              anchor: selectedClusterAnchor,
                            })
                          }
                        >
                          Send to nav overlays
                        </button>
                      ) : (
                        <button
                          className="px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded text-gray-100"
                          onClick={() => objectMemoryTargetStore.set(null)}
                        >
                          Clear target
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-[10px] text-gray-500">No anchor data for this cluster.</div>
                )}
              </CollapsibleSection>

              <CollapsibleSection
                title="Management"
                storageKey="objectMemory.detail.section.management"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="bg-gray-800 text-xs px-2 py-1 rounded w-40"
                    placeholder="label"
                    value={labelInput}
                    onChange={(event) => setLabelInput(event.target.value)}
                  />
                  <button className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded" onClick={handleLabelSave}>Save Label</button>
                  <select
                    className="bg-gray-800 text-xs px-2 py-1 rounded"
                    value={mergeSource}
                    onChange={(event) => setMergeSource(event.target.value)}
                  >
                    <option value="">merge source…</option>
                    {clusters
                      .filter((cluster) => cluster.cluster_id !== selectedId)
                      .map((cluster) => (
                        <option key={cluster.cluster_id} value={cluster.cluster_id}>
                          {cluster.label || cluster.cluster_id}
                        </option>
                      ))}
                  </select>
                  <button
                    className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
                    onClick={handleMerge}
                    disabled={!mergeSource}
                  >
                    Merge → current
                  </button>
                  <button className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded" onClick={handleDeleteCluster}>Delete Cluster</button>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-gray-400 mt-2">
                  <label className="flex items-center gap-1">
                    max samples
                    <input
                      type="range"
                      min={5}
                      max={200}
                      step={1}
                      value={maxSamplesInput}
                      onChange={(event) => setMaxSamplesInput(parseInt(event.target.value, 10))}
                      className="w-32"
                    />
                    <span className="text-gray-300">{maxSamplesInput}</span>
                  </label>
                  <label className="flex items-center gap-1">
                    dedupe
                    <input
                      type="range"
                      min={0.9}
                      max={0.999}
                      step={0.001}
                      value={dedupeThresholdInput}
                      onChange={(event) => setDedupeThresholdInput(parseFloat(event.target.value))}
                      className="w-32"
                    />
                    <span className="text-gray-300">{dedupeThresholdInput.toFixed(3)}</span>
                  </label>
                  <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handleConfigSave}>Apply</button>
                  <label className="flex items-center gap-1">
                    cleanup ≥
                    <input
                      type="range"
                      min={0.9}
                      max={0.999}
                      step={0.001}
                      value={pruneSimilarity}
                      onChange={(event) => setPruneSimilarity(parseFloat(event.target.value))}
                      className="w-32"
                    />
                    <span className="text-gray-300">{pruneSimilarity.toFixed(3)}</span>
                  </label>
                  <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handlePrune}>Prune</button>
                </div>
                {selectedCount > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-gray-300 bg-gray-800/60 px-2 py-1 rounded">
                    <span>{selectedCount} selected</span>
                    <select
                      className="bg-gray-900 text-xs px-2 py-1 rounded"
                      value={moveTargetId}
                      onChange={(event) => setMoveTargetId(event.target.value)}
                    >
                      <option value="">→ existing…</option>
                      {clusters
                        .filter((cluster) => cluster.cluster_id !== selectedId)
                        .map((cluster) => (
                          <option key={cluster.cluster_id} value={cluster.cluster_id}>
                            {cluster.label || cluster.cluster_id}
                          </option>
                        ))}
                    </select>
                    <span>or</span>
                    <input
                      className="bg-gray-900 text-xs px-2 py-1 rounded w-32"
                      placeholder="new cluster label…"
                      value={moveNewLabel}
                      onChange={(event) => setMoveNewLabel(event.target.value)}
                    />
                    <button
                      className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded disabled:opacity-40 disabled:hover:bg-indigo-700"
                      onClick={handleMoveSelected}
                      disabled={!canMoveSelected || loading}
                    >
                      Move
                    </button>
                    <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={clearSelection}>Clear</button>
                  </div>
                )}
              </CollapsibleSection>

              <CollapsibleSection
                title="Samples"
                storageKey="objectMemory.detail.section.samples"
                summary={`${clusterDetail.samples.length} samples`}
              >
                <div className="grid grid-cols-3 gap-2">
                  {clusterDetail.samples.map((sample) => {
                    const thumb = thumbsRef.current.get(sample.sample_id)?.dataUrl;
                    const isSelected = selectedSamples.includes(sample.sample_id);
                    const isAnchorSample = selectedClusterAnchor?.sample_id === sample.sample_id;
                    const stateClasses = isSelected
                      ? 'border-indigo-500 ring-2 ring-indigo-500'
                      : isAnchorSample
                        ? 'border-emerald-500 ring-1 ring-emerald-400/40'
                        : 'border-gray-700';
                    return (
                      <div
                        key={sample.sample_id}
                        className={`border rounded overflow-hidden relative transition-shadow ${stateClasses}`}
                      >
                        <div className="absolute top-1 left-1">
                          <input
                            type="checkbox"
                            className="h-3 w-3 accent-indigo-500"
                            checked={isSelected}
                            onChange={() => toggleSampleSelection(sample.sample_id)}
                          />
                        </div>
                        <div className="absolute top-1 right-1">
                          <button
                            className="bg-gray-900/70 hover:bg-gray-900 text-[9px] px-1 py-0.5 rounded"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteSample(sample.sample_id);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                        <div
                          className="w-full h-24 bg-gray-900 flex items-center justify-center cursor-pointer"
                          onClick={() => toggleSampleSelection(sample.sample_id)}
                        >
                          {thumb ? (
                            <img src={thumb} alt={sample.sample_id} className="max-h-full max-w-full object-contain" />
                          ) : (
                            <div className="text-[10px] text-gray-500">loading…</div>
                          )}
                        </div>
                        <div className="p-1 text-[9px] text-gray-500 break-all flex flex-col gap-0.5">
                          {isAnchorSample && <span className="text-emerald-400 uppercase text-[8px]">anchor</span>}
                          {sample.detect_label ? (
                            <span className="text-gray-400">det: {sample.detect_label}</span>
                          ) : null}
                          <span>{sample.sample_id}</span>
                        </div>
                      </div>
                    );
                  })}
                  {!clusterDetail.samples.length && (
                    <div className="text-gray-500 text-[11px]">No samples yet</div>
                  )}
                </div>
              </CollapsibleSection>
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">Select a cluster to inspect</div>
          )}
        </CollapsibleSection>
      </div>
    </Panel>
  );
};
