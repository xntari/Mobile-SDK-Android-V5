export async function analyzeRealtimePromptImage(imageBase64: string, promptImageBase64: string, img_size?: number, signal?: AbortSignal): Promise<{ boxes: any[]; meta?: any }> {
  try {
    const base = ((): string => {
      try { const raw = localStorage.getItem('settings.endpoints'); if (raw) { const ep = JSON.parse(raw); if (ep?.visionRealtime) return ep.visionRealtime; } } catch {}
      return (globalThis as any).__REALTIME_URL__ || 'http://127.0.0.1:9004/realtime/detect';
    })().replace('/realtime/detect', '/realtime/prompt_image');
    const sid = (globalThis as any).__VISION_SESSION_ID__ || ((globalThis as any).__VISION_SESSION_ID__ = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
    const res = await fetch(base, { method:'POST', headers:{'Content-Type':'application/json','X-Client-Session': String(sid)}, signal, body: JSON.stringify({ image: imageBase64, prompt_image: promptImageBase64, img_size: img_size ?? 640 }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const boxes: any[] = Array.isArray(data?.boxes) ? data.boxes : [];
    return { boxes, meta: { backend: 'http', url: base } };
  } catch (e) {
    console.warn('[visionPromptClient] realtime prompt-image call failed:', e);
    return { boxes: [], meta: { backend: 'http' } };
  }
}

