export const spawnVideoRendererWorker = (): Worker | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  if (typeof Worker === 'undefined') {
    return null;
  }
  const workerSource = `
    let canvas = null;
    let ctx = null;
    let dpr = 1;
    let size = null;

    const ensureContext = (width, height) => {
      if (!canvas) {
        return;
      }
      const scaledWidth = Math.max(1, Math.floor(width * dpr));
      const scaledHeight = Math.max(1, Math.floor(height * dpr));
      if (!ctx) {
        ctx = canvas.getContext('2d');
      }
      if (!ctx) {
        return;
      }
      if (!size || size.width !== scaledWidth || size.height !== scaledHeight) {
        canvas.width = scaledWidth;
        canvas.height = scaledHeight;
        if (ctx.resetTransform) {
          ctx.resetTransform();
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        size = { width: scaledWidth, height: scaledHeight };
      }
    };

    self.onmessage = (event) => {
      const data = event.data;
      switch (data.type) {
        case 'init': {
          canvas = data.canvas;
          dpr = typeof data.devicePixelRatio === 'number' && isFinite(data.devicePixelRatio) ? data.devicePixelRatio : 1;
          size = null;
          ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          break;
        }
        case 'resize': {
          if (!canvas) {
            break;
          }
          ensureContext(data.width, data.height);
          break;
        }
        case 'frame': {
          const frame = data.frame;
          const width = data.width;
          const height = data.height;
          if (!canvas) {
            frame.close();
            break;
          }
          ensureContext(width, height);
          if (!ctx) {
            frame.close();
            break;
          }
          try {
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(frame, 0, 0, width, height);
          } catch (error) {
            console.error('[videoRendererWorker] drawImage error', error);
          } finally {
            frame.close();
          }
          break;
        }
        case 'clear': {
          if (canvas && ctx) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
          }
          break;
        }
        case 'dispose': {
          canvas = null;
          ctx = null;
          size = null;
          break;
        }
        default:
          break;
      }
    };
  `;

  const blob = new Blob([workerSource], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
};
