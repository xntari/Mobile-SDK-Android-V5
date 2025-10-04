interface TerrainTile {
  data: Uint8ClampedArray;
}

export interface TerrainCacheStats {
  tileCount: number;
  hits: number;
  misses: number;
  requests: number;
  pending: number;
}

const TILE_SIZE = 256;
const MAX_TILES = 128;
const DEFAULT_ZOOM = 13;

const cache = new Map<string, TerrainTile>();
const pending = new Map<string, Promise<TerrainTile>>();
let hits = 0;
let misses = 0;
let requests = 0;

const listeners = new Set<(stats: TerrainCacheStats) => void>();

const notify = () => {
  const stats: TerrainCacheStats = {
    tileCount: cache.size,
    hits,
    misses,
    requests,
    pending: pending.size,
  };
  listeners.forEach((listener) => {
    try {
      listener(stats);
    } catch (error) {
      console.warn('[TerrainCache] listener error', error);
    }
  });
};

const toTileKey = (x: number, y: number, z: number) => `${z}:${x}:${y}`;

const clampLatitude = (value: number) => Math.max(-85.0511287798, Math.min(85.0511287798, value));

const latLonToTile = (lat: number, lon: number, zoom: number) => {
  const latRad = clampLatitude(lat) * Math.PI / 180;
  const n = 2 ** zoom;
  const xtile = Math.floor((lon + 180) / 360 * n);
  const ytile = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const x = (lon + 180) / 360 * n;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const pixelX = Math.floor((x - xtile) * TILE_SIZE);
  const pixelY = Math.floor((y - ytile) * TILE_SIZE);
  return { x: xtile, y: ytile, pixelX, pixelY };
};

const decodeTerrariumHeight = (r: number, g: number, b: number) => (r * 256 + g + b / 256) - 32768;

const fetchTile = async (x: number, y: number, z: number): Promise<TerrainTile> => {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) {
    throw new Error(`Terrain tile ${z}/${x}/${y} failed: ${response.status}`);
  }
  const blob = await response.blob();
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Failed to create 2D context for terrain tile');
  }

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    context.drawImage(bitmap, 0, 0);
  } else {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        try {
          context.drawImage(image, 0, 0);
        } catch (error) {
          URL.revokeObjectURL(objectUrl);
          reject(error);
          return;
        }
        URL.revokeObjectURL(objectUrl);
        resolve();
      };
      image.onerror = (event) => {
        URL.revokeObjectURL(objectUrl);
        reject(event);
      };
      const objectUrl = URL.createObjectURL(blob);
      image.src = objectUrl;
    });
  }
  const imageData = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const tile: TerrainTile = {
    data: imageData.data,
  };
  return tile;
};

const touchTile = (key: string) => {
  const existing = cache.get(key);
  if (!existing) return;
  cache.delete(key);
  cache.set(key, existing);
};

const insertTile = (key: string, tile: TerrainTile) => {
  if (cache.has(key)) {
    cache.set(key, tile);
    return;
  }
  cache.set(key, tile);
  while (cache.size > MAX_TILES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
};

const getTile = async (x: number, y: number, z: number): Promise<TerrainTile> => {
  const key = toTileKey(x, y, z);
  if (cache.has(key)) {
    hits += 1;
    touchTile(key);
    notify();
    return cache.get(key)!;
  }

  if (pending.has(key)) {
    hits += 1;
    notify();
    return pending.get(key)!;
  }

  misses += 1;
  const promise = fetchTile(x, y, z)
    .then((tile) => {
      insertTile(key, tile);
      pending.delete(key);
      notify();
      return tile;
    })
    .catch((error) => {
      pending.delete(key);
      notify();
      throw error;
    });

  pending.set(key, promise);
  notify();
  return promise;
};

const sampleTile = (tile: TerrainTile, pixelX: number, pixelY: number) => {
  const clampedX = Math.max(0, Math.min(TILE_SIZE - 1, pixelX));
  const clampedY = Math.max(0, Math.min(TILE_SIZE - 1, pixelY));
  const index = (clampedY * TILE_SIZE + clampedX) * 4;
  const r = tile.data[index];
  const g = tile.data[index + 1];
  const b = tile.data[index + 2];
  return decodeTerrariumHeight(r, g, b);
};

export const terrainCache = {
  async getElevation(latitude: number, longitude: number, options?: { zoom?: number }): Promise<number | null> {
    requests += 1;
    const zoom = options?.zoom ?? DEFAULT_ZOOM;
    const { x, y, pixelX, pixelY } = latLonToTile(latitude, longitude, zoom);
    try {
      const tile = await getTile(x, y, zoom);
      const altitude = sampleTile(tile, pixelX, pixelY);
      notify();
      return altitude;
    } catch (error) {
      console.warn('[TerrainCache] elevation lookup failed', error);
      notify();
      return null;
    }
  },

  getSnapshot(): TerrainCacheStats {
    return {
      tileCount: cache.size,
      hits,
      misses,
      requests,
      pending: pending.size,
    };
  },

  subscribe(listener: (stats: TerrainCacheStats) => void): () => void {
    listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      listeners.delete(listener);
    };
  },

  clear(): void {
    cache.clear();
    pending.clear();
    notify();
  },
};
