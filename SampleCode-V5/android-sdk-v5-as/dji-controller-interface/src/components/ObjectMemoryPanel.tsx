import React from 'react';
import { Panel } from './Panel';
import {
  listClusters,
  getCluster,
  labelCluster,
  mergeClusters,
  deleteSample,
  deleteCluster,
  fetchSampleImage,
  updateClusterConfig,
  pruneCluster,
  type ObjectMemoryCluster,
  type ObjectMemorySample,
} from '../agent/objectMemoryClient';

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
  const thumbsRef = React.useRef<Map<string, SampleThumb>>(new Map());
  const [, forceTick] = React.useState<number>(0);
  const [sortMode, setSortMode] = React.useState<'updated'|'alpha'|'samples'|'cohesion'|'neighbor'>(()=>{
    try {
      const raw = localStorage.getItem('objectMemory.sortMode');
      if (raw === 'alpha' || raw === 'samples' || raw === 'cohesion' || raw === 'updated' || raw === 'neighbor') return raw;
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

  const refreshClusters = React.useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const res = await listClusters({ limit: 200 });
      setClusters(applySort(res.clusters));
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [applySort]);

  const loadCluster = React.useCallback(async (clusterId: string) => {
    setLoading(true);
    setMessage('');
    thumbsRef.current.clear();
    try {
      const detail = await getCluster(clusterId);
      setClusterDetail(detail);
      setSelectedId(clusterId);
      setLabelInput(detail.cluster.label || '');
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
      <div className="flex flex-col gap-2 text-xs text-gray-200 h-full overflow-hidden">
        <div className="flex items-center gap-3">
          <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={refreshClusters} disabled={loading}>Refresh</button>
          <label className="flex items-center gap-1 text-[10px] text-gray-400">
            sort
            <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={sortMode} onChange={(e)=>setSortMode(e.target.value as any)}>
              <option value="updated">recent</option>
              <option value="alpha">name</option>
              <option value="samples">samples</option>
              <option value="cohesion">cohesion</option>
              <option value="neighbor">nearest</option>
            </select>
          </label>
          <button
            className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px]"
            onClick={() => setSortDirection(dir => (dir === 'asc' ? 'desc' : 'asc'))}
            title={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
          >
            {sortDirection === 'asc' ? '↑' : '↓'}
          </button>
          {loading && <span className="text-gray-500">loading…</span>}
          {message && <span className="text-gray-400 truncate max-w-[200px]">{message}</span>}
        </div>
        <div className="flex-1 flex gap-3 overflow-hidden">
          <div className="w-48 overflow-y-auto border border-gray-700 rounded p-2">
            {clusters.map((cluster) => (
              <button
                key={cluster.cluster_id}
                className={`block w-full text-left text-[11px] px-2 py-1 rounded mb-1 ${selectedId === cluster.cluster_id ? 'bg-gray-700' : 'hover:bg-gray-800'}`}
                onClick={() => void loadCluster(cluster.cluster_id)}
              >
                <div className="font-semibold text-gray-100">{cluster.label || '(unlabeled)'}</div>
                <div className="text-gray-500">
                  {cluster.sample_count} samples · {cluster.status}
                  {typeof cluster.mean_similarity === 'number' ? ` · μ ${cluster.mean_similarity.toFixed(3)}` : ''}
                  {typeof cluster.nearest_neighbor_similarity === 'number' ? ` · ↔ ${cluster.nearest_neighbor_similarity.toFixed(3)}` : ''}
                </div>
              </button>
            ))}
            {!clusters.length && !loading && <div className="text-gray-500 text-[11px]">No clusters yet</div>}
          </div>

          <div className="flex-1 overflow-y-auto border border-gray-700 rounded p-3">
            {selectedId && clusterDetail ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div className="text-[11px] text-gray-400">Cluster</div>
                  <code className="text-[10px] bg-gray-800 px-2 py-0.5 rounded">{clusterDetail.cluster.cluster_id}</code>
                  <div className="text-[10px] text-gray-500">
                    {clusterDetail.cluster.sample_count} samples · max {clusterDetail.cluster.max_samples ?? maxSamplesInput}
                    {typeof clusterDetail.cluster.mean_similarity === 'number' ? ` · μ ${clusterDetail.cluster.mean_similarity.toFixed(3)}` : ''}
                    {typeof clusterDetail.cluster.nearest_neighbor_similarity === 'number' ? ` · ↔ ${clusterDetail.cluster.nearest_neighbor_similarity.toFixed(3)}` : ''}
                  </div>
                </div>
                {clusterDetail.cluster.nearest_neighbor_id && (
                  <div className="text-[10px] text-gray-500">
                    nearest cluster: <code className="bg-gray-800 px-1 py-0.5 rounded">{clusterDetail.cluster.nearest_neighbor_id}</code>
                    {typeof clusterDetail.cluster.nearest_neighbor_similarity === 'number' ? ` (${clusterDetail.cluster.nearest_neighbor_similarity.toFixed(3)})` : ''}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    className="bg-gray-800 text-xs px-2 py-1 rounded w-40"
                    placeholder="label"
                    value={labelInput}
                    onChange={(e)=>setLabelInput(e.target.value)}
                  />
                  <button className="px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded" onClick={handleLabelSave}>Save Label</button>
                  <select className="bg-gray-800 text-xs px-2 py-1 rounded" value={mergeSource} onChange={(e)=>setMergeSource(e.target.value)}>
                    <option value="">merge source…</option>
                    {clusters.filter(c=>c.cluster_id!==selectedId).map(c=> (
                      <option key={c.cluster_id} value={c.cluster_id}>{c.label || c.cluster_id}</option>
                    ))}
                  </select>
                  <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handleMerge} disabled={!mergeSource}>Merge → current</button>
                  <button className="px-2 py-1 bg-red-700 hover:bg-red-600 rounded" onClick={handleDeleteCluster}>Delete Cluster</button>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-gray-400">
                  <label className="flex items-center gap-1">max samples
                    <input type="range" min={5} max={200} step={1} value={maxSamplesInput} onChange={(e)=>setMaxSamplesInput(parseInt(e.target.value))} className="w-32" />
                    <span className="text-gray-300">{maxSamplesInput}</span>
                  </label>
                  <label className="flex items-center gap-1">dedupe
                    <input type="range" min={0.90} max={0.999} step={0.001} value={dedupeThresholdInput} onChange={(e)=>setDedupeThresholdInput(parseFloat(e.target.value))} className="w-32" />
                    <span className="text-gray-300">{dedupeThresholdInput.toFixed(3)}</span>
                  </label>
                  <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handleConfigSave}>Apply</button>
                  <label className="flex items-center gap-1">cleanup ≥
                    <input type="range" min={0.90} max={0.999} step={0.001} value={pruneSimilarity} onChange={(e)=>setPruneSimilarity(parseFloat(e.target.value))} className="w-32" />
                    <span className="text-gray-300">{pruneSimilarity.toFixed(3)}</span>
                  </label>
                  <button className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded" onClick={handlePrune}>Prune</button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {clusterDetail.samples.map((sample) => {
                    const thumb = thumbsRef.current.get(sample.sample_id)?.dataUrl;
                    return (
                      <div key={sample.sample_id} className="border border-gray-700 rounded overflow-hidden relative">
                        <div className="absolute top-1 right-1">
                          <button className="bg-gray-900/70 hover:bg-gray-900 text-[9px] px-1 py-0.5 rounded" onClick={()=>handleDeleteSample(sample.sample_id)}>✕</button>
                        </div>
                        <div className="w-full h-24 bg-gray-900 flex items-center justify-center">
                          {thumb ? (
                            <img src={thumb} alt={sample.sample_id} className="max-h-full max-w-full object-contain" />
                          ) : (
                            <div className="text-[10px] text-gray-500">loading…</div>
                          )}
                        </div>
                        <div className="p-1 text-[9px] text-gray-500 break-all">
                          {sample.sample_id}
                        </div>
                      </div>
                    );
                  })}
                  {!clusterDetail.samples.length && <div className="text-gray-500 text-[11px]">No samples yet</div>}
                </div>
              </div>
            ) : (
              <div className="text-gray-500 text-[11px]">Select a cluster to inspect</div>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
};
