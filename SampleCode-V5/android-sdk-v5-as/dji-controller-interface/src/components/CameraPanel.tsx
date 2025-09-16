import React from 'react';
import { Panel, createPanelControls } from './Panel';

// Create camera panel controls using the factory
export const fpvCameraPanelControls = createPanelControls('fpv.panel', 'fpvCameraPanelVisibilityChange');
export const h20nCameraPanelControls = createPanelControls('h20n.panel', 'h20nCameraPanelVisibilityChange');

interface CameraPanelProps {
  title: string;
  defaultPosition: { x: number; y: number };
  defaultSize: { w: number; h: number };
  storageKey: string;
  visibilityEventType: string;
  children: React.ReactNode;
}

export const CameraPanel: React.FC<CameraPanelProps> = (props) => {
  // Camera panels use larger minimum sizes for video content
  return (
    <Panel
      {...props}
      className="camera-panel"
      defaultSize={{
        w: Math.max(props.defaultSize.w, 320),
        h: Math.max(props.defaultSize.h, 240)
      }}
    />
  );
};