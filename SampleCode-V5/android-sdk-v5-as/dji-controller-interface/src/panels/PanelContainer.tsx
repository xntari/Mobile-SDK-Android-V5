import React, { useEffect } from 'react';
import { usePanelRegistry } from './PanelRegistry';
import { WindowChrome } from './WindowChrome';
import { defaultPanelConfigs } from './index';

export const PanelContainer: React.FC = () => {
  const { registerPanel, getVisiblePanels } = usePanelRegistry();

  // Register all default panels on mount
  useEffect(() => {
    defaultPanelConfigs.forEach(config => {
      registerPanel(config);
    });
  }, [registerPanel]);

  const visiblePanels = getVisiblePanels();

  return (
    <div
      id="ui-panels-root"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none', // Allow clicks through to underlying content
        zIndex: 1000 // Above camera overlays (which should be <= 10)
      }}
    >
      {visiblePanels.map(([id, config, state]) => {
        const PanelComponent = config.component;

        return (
          <div
            key={id}
            style={{
              pointerEvents: 'auto' // Re-enable pointer events for individual panels
            }}
          >
            <WindowChrome
              panelId={id}
              panelState={state}
              resizable={config.resizable}
              closeable={config.closeable}
            >
              <React.Suspense fallback={<div style={{ padding: '16px', color: 'white' }}>Loading...</div>}>
                <PanelComponent />
              </React.Suspense>
            </WindowChrome>
          </div>
        );
      })}
    </div>
  );
};