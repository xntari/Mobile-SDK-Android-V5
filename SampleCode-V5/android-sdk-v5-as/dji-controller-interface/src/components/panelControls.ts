import { createPanelControls } from './Panel';

// Create panel controls for UI elements
export const mapPanelControls = createPanelControls('map.panel', 'mapPanelVisibilityChange');
export const hsiPanelControls = createPanelControls('hsi.panel', 'hsiPanelVisibilityChange');
export const controllerPanelControls = createPanelControls('controller.panel', 'controllerPanelVisibilityChange');
export const orientationPanelControls = createPanelControls('orientation.panel', 'orientationPanelVisibilityChange');
export const projectionPanelControls = createPanelControls('projectionControls.panel', 'projectionControlsVisibilityChange');
