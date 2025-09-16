import React from 'react';
import { getNextZIndex, getBaseZIndex } from '../utils/zIndex';

// Generic panel controls factory
export const createPanelControls = (storageKey: string, eventType: string) => ({
  isVisible: (): boolean => {
    try {
      const raw = localStorage.getItem(`${storageKey}.visible`);
      return raw ? JSON.parse(raw) : true;
    } catch {
      return true;
    }
  },
  setVisible: (visible: boolean): void => {
    try {
      localStorage.setItem(`${storageKey}.visible`, JSON.stringify(visible));
      window.dispatchEvent(new CustomEvent(eventType, { detail: visible }));
    } catch {}
  }
});

interface PanelProps {
  title: string;
  defaultPosition: { x: number; y: number };
  defaultSize: { w: number; h: number };
  storageKey: string;
  visibilityEventType: string;
  children: React.ReactNode;
  className?: string;
}

export const Panel: React.FC<PanelProps> = ({
  title,
  defaultPosition,
  defaultSize,
  storageKey,
  visibilityEventType,
  children,
  className = ''
}) => {
  const [visible, setVisible] = React.useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(`${storageKey}.visible`);
      return raw ? JSON.parse(raw) : true;
    } catch {
      return true;
    }
  });

  const [pos, setPos] = React.useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem(`${storageKey}.pos`);
      return raw ? JSON.parse(raw) : defaultPosition;
    } catch {
      return defaultPosition;
    }
  });

  const [size, setSize] = React.useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(`${storageKey}.size`);
      return raw ? JSON.parse(raw) : defaultSize;
    } catch {
      return defaultSize;
    }
  });

  const [zIndex, setZIndex] = React.useState<number>(() => {
    try {
      const stored = localStorage.getItem(`${storageKey}.zIndex`);
      return stored ? parseInt(stored) : getBaseZIndex();
    } catch {
      return getBaseZIndex();
    }
  });
  const dragRef = React.useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  // Persist state changes
  React.useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}.pos`, JSON.stringify(pos));
    } catch {}
  }, [pos, storageKey]);

  React.useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}.visible`, JSON.stringify(visible));
    } catch {}
  }, [visible, storageKey]);

  React.useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}.size`, JSON.stringify(size));
    } catch {}
  }, [size, storageKey]);

  React.useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}.zIndex`, zIndex.toString());
    } catch {}
  }, [zIndex, storageKey]);

  // Listen for external visibility changes
  React.useEffect(() => {
    const handleVisibilityChange = (e: CustomEvent) => {
      setVisible(e.detail);
    };
    window.addEventListener(visibilityEventType, handleVisibilityChange as EventListener);
    return () => window.removeEventListener(visibilityEventType, handleVisibilityChange as EventListener);
  }, [visibilityEventType]);

  // Listen for layout refresh events
  React.useEffect(() => {
    const handleLayoutRefresh = () => {
      // Reload position, size, and zIndex from localStorage
      try {
        const storedPos = localStorage.getItem(`${storageKey}.pos`);
        const storedSize = localStorage.getItem(`${storageKey}.size`);
        const storedZIndex = localStorage.getItem(`${storageKey}.zIndex`);
        const storedVisible = localStorage.getItem(`${storageKey}.visible`);

        if (storedPos) {
          const newPos = JSON.parse(storedPos);
          setPos(newPos);
        }
        if (storedSize) {
          const newSize = JSON.parse(storedSize);
          setSize(newSize);
        }
        if (storedZIndex) {
          setZIndex(parseInt(storedZIndex));
        }
        if (storedVisible) {
          setVisible(JSON.parse(storedVisible));
        }
      } catch (error) {
        console.error(`Failed to refresh layout for ${storageKey}:`, error);
      }
    };

    window.addEventListener('layoutRefresh', handleLayoutRefresh);
    return () => window.removeEventListener('layoutRefresh', handleLayoutRefresh);
  }, [storageKey]);

  // ResizeObserver to track size changes from CSS resize
  React.useEffect(() => {
    if (!panelRef.current) return;
    const el = panelRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const s = { w: Math.round(r.width), h: Math.round(r.height) };
      if (visible && s.w > 0 && s.h > 0) {
        setSize(s);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Bring to front when starting drag - simple and fast
    setZIndex(getNextZIndex());

    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: ev.clientX - dragRef.current.dx, y: ev.clientY - dragRef.current.dy });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const header = (
    <div
      className="flex items-center justify-between mb-2 cursor-move select-text"
      onMouseDown={handleMouseDown}
    >
      <div className="text-xs text-gray-400 font-semibold">{title.toUpperCase()}</div>
      <div className="flex items-center gap-2">
        <button
          className="text-[10px] text-gray-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            setVisible(false);
          }}
          title="Hide panel"
        >
          ✕
        </button>
      </div>
    </div>
  );

  if (!visible) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className={`glass-panel p-2 ${className}`}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        minWidth: 200,
        minHeight: 150,
        resize: 'both' as any,
        overflow: 'hidden',
        zIndex: zIndex,
      }}
    >
      {header}
      <div className="flex-1 w-full h-full overflow-hidden" style={{ height: 'calc(100% - 32px)' }}>
        {children}
      </div>
    </div>
  );
};