import React from 'react';
import { PanelConfig } from './types';

// Import existing components (we'll create wrappers for them)
const VisionPanel = React.lazy(() => import('../components/VisionPanel').then(m => ({ default: m.VisionPanel })));
const AgentPanel = React.lazy(() => import('../components/AgentPanel').then(m => ({ default: m.AgentPanel })));

// Panel configurations with default positions and sizes
export const defaultPanelConfigs: PanelConfig[] = [
  {
    id: 'vision',
    title: 'Vision Analysis',
    defaultBounds: { x: 24, y: 24, w: 360, h: 300 },
    minSize: { w: 280, h: 200 },
    component: VisionPanel,
    resizable: true,
    closeable: true
  },
  {
    id: 'agent',
    title: 'Agent Control',
    defaultBounds: {
      x: 800, // Will be adjusted by clampToViewport
      y: 400,
      w: 460,
      h: 420
    },
    minSize: { w: 400, h: 300 },
    component: AgentPanel,
    resizable: true,
    closeable: true
  }
];

// Helper to get panel config by id
export const getPanelConfig = (id: string): PanelConfig | undefined => {
  return defaultPanelConfigs.find(config => config.id === id);
};

// Helper to get all panel ids
export const getAllPanelIds = (): string[] => {
  return defaultPanelConfigs.map(config => config.id);
};