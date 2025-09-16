import React, { useRef, useCallback } from 'react';
import { usePanelDispatch } from './PanelRegistry';
import { PanelState } from './types';

interface WindowChromeProps {
  panelId: string;
  panelState: PanelState;
  children: React.ReactNode;
  resizable?: boolean;
  closeable?: boolean;
}

export const WindowChrome: React.FC<WindowChromeProps> = ({
  panelId,
  panelState,
  children,
  resizable = true,
  closeable = true
}) => {
  const dispatch = usePanelDispatch();
  const windowRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const handleHeaderClick = useCallback(() => {
    dispatch({ type: 'BRING_TO_FRONT', id: panelId });
  }, [dispatch, panelId]);

  const handleMinimize = useCallback(() => {
    dispatch({ type: 'SET_MINIMIZED', id: panelId, minimized: !panelState.minimized });
  }, [dispatch, panelId, panelState.minimized]);

  const handleClose = useCallback(() => {
    if (closeable) {
      dispatch({ type: 'SET_CLOSED', id: panelId, closed: true });
    }
  }, [dispatch, panelId, closeable]);

  const handleHeaderDoubleClick = useCallback(() => {
    handleMinimize();
  }, [handleMinimize]);

  // Don't render if closed
  if (panelState.closed) {
    return null;
  }

  const windowStyle: React.CSSProperties = {
    position: 'absolute',
    left: panelState.x,
    top: panelState.y,
    width: panelState.w,
    height: panelState.minimized ? 'auto' : panelState.h,
    zIndex: panelState.z,
    backgroundColor: 'var(--dji-dark, #1a1a1a)',
    border: `1px solid ${panelState.focused ? 'var(--dji-blue, #007bff)' : 'var(--gray-600, #4b5563)'}`,
    borderRadius: '6px',
    boxShadow: panelState.focused
      ? '0 8px 32px rgba(0, 123, 255, 0.3), 0 4px 16px rgba(0, 0, 0, 0.5)'
      : '0 4px 16px rgba(0, 0, 0, 0.3)',
    overflow: 'hidden',
    minWidth: '200px',
    minHeight: panelState.minimized ? 'auto' : '100px'
  };

  const headerStyle: React.CSSProperties = {
    height: '32px',
    backgroundColor: panelState.focused ? 'var(--dji-blue, #007bff)' : 'var(--gray-700, #374151)',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px',
    cursor: 'move',
    userSelect: 'none',
    fontSize: '12px',
    fontWeight: '500'
  };

  const titleStyle: React.CSSProperties = {
    flex: 1,
    textAlign: 'left',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  };

  const buttonGroupStyle: React.CSSProperties = {
    display: 'flex',
    gap: '4px'
  };

  const buttonStyle: React.CSSProperties = {
    width: '16px',
    height: '16px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '2px',
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '10px',
    lineHeight: '1'
  };

  const minimizeButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: 'rgba(255, 193, 7, 0.8)'
  };

  const closeButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: 'rgba(220, 53, 69, 0.8)'
  };

  const contentStyle: React.CSSProperties = {
    display: panelState.minimized ? 'none' : 'block',
    height: panelState.minimized ? 0 : `${panelState.h - 32}px`,
    overflow: 'hidden'
  };

  return (
    <div ref={windowRef} style={windowStyle}>
      {/* Window Header */}
      <div
        ref={headerRef}
        style={headerStyle}
        onClick={handleHeaderClick}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div style={titleStyle}>
          {panelState.title}
        </div>
        <div style={buttonGroupStyle}>
          <button
            style={minimizeButtonStyle}
            onClick={(e) => {
              e.stopPropagation();
              handleMinimize();
            }}
            title={panelState.minimized ? 'Restore' : 'Minimize'}
          >
            {panelState.minimized ? '⬜' : '—'}
          </button>
          {closeable && (
            <button
              style={closeButtonStyle}
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              title="Close"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Window Content */}
      <div style={contentStyle}>
        {children}
      </div>
    </div>
  );
};