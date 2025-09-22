export type LiveViewPinPoint = {
  index: number;
  x: number;
  y: number;
};

export type LiveViewLocationMessage = {
  type: 'camera_live_view_location';
  component: string;
  request_id?: string;
  source?: string;
  valid?: boolean;
  result?: string | null;
  point_direction?: string | null;
  pin_points?: LiveViewPinPoint[];
  request?: {
    latitude: number;
    longitude: number;
    altitude: number;
  };
  projection_stats?: {
    mode: string;
    aircraft: {
      lat: number;
      lon: number;
      alt: number;
    };
    target: {
      lat: number;
      lon: number;
      alt: number;
      distance: number;
    };
    adjusted_alt: number;
    sample: string;
    capturedAt: string;
    camera: string;
  };
};

type Listener = (message: LiveViewLocationMessage) => void;

const listeners = new Set<Listener>();
let subscribed = false;

function ensureSubscription() {
  if (subscribed) return;
  if (typeof window === 'undefined') return;
  const api = (window as any).electronAPI;
  if (!api?.onBridgeData) return;

  api.onBridgeData((payload: any) => {
    if (!payload || payload.type !== 'camera_live_view_location') return;
    const message: LiveViewLocationMessage = payload;
    listeners.forEach((listener) => {
      try {
        listener(message);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[cameraProjectionClient] listener error', err);
      }
    });
  });
  subscribed = true;
}

export function registerLiveViewLocationListener(listener: Listener): () => void {
  ensureSubscription();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestLiveViewLocation(params: {
  latitude: number;
  longitude: number;
  altitude: number;
  component: string;
  requestId?: string;
  source?: string;
}): Promise<any> | undefined {
  ensureSubscription();
  if (typeof window === 'undefined') return undefined;
  const api = (window as any).electronAPI;
  if (!api?.sendBridgeCommand) return undefined;
  const command = {
    type: 'camera_live_view_location',
    data: {
      latitude: params.latitude,
      longitude: params.longitude,
      altitude: params.altitude,
      camera_index: params.component,
      request_id: params.requestId,
      source: params.source,
    },
  };
  return api.sendBridgeCommand(command);
}

export type LookAtMode = 'FREE' | 'FOLLOWING' | 'ZOOM_CIRCLE';

export type GimbalLookAtMessage = {
  type: 'gimbal_look_at';
  success: boolean;
  mode?: string;
  location?: {
    latitude: number;
    longitude: number;
    altitude: number;
  };
  error?: string;
};

export function gimbalLookAt(params: {
  latitude: number;
  longitude: number;
  altitude: number;
  mode: LookAtMode;
}): Promise<any> | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = (window as any).electronAPI;
  if (!api?.sendBridgeCommand) return undefined;

  const command = {
    type: 'gimbal_look_at',
    data: {
      latitude: params.latitude,
      longitude: params.longitude,
      altitude: params.altitude,
      mode: params.mode,
    },
  };

  return api.sendBridgeCommand(command);
}
