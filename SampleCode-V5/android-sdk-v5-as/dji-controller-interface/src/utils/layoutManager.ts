// Layout management system for saving/restoring panel configurations

export interface PanelLayout {
  position: { x: number; y: number };
  size: { w: number; h: number };
  visible: boolean;
  zIndex: number;
}

export interface SavedLayout {
  name: string;
  created: number;
  updated: number;
  panels: Record<string, PanelLayout>;
}

const LAYOUT_STORAGE_KEY = 'ui.savedLayouts.v1';
const CURRENT_LAYOUT_KEY = 'ui.currentLayout.v1';

// Get all saved layouts
export const getSavedLayouts = (): Record<string, SavedLayout> => {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

// Save a layout with a given name
export const saveLayout = (name: string, panels: Record<string, PanelLayout>): void => {
  try {
    const savedLayouts = getSavedLayouts();
    const now = Date.now();

    savedLayouts[name] = {
      name,
      created: savedLayouts[name]?.created || now,
      updated: now,
      panels
    };

    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
  } catch (error) {
    console.error('Failed to save layout:', error);
  }
};

// Load a layout by name
export const loadLayout = (name: string): SavedLayout | null => {
  try {
    const savedLayouts = getSavedLayouts();
    return savedLayouts[name] || null;
  } catch {
    return null;
  }
};

// Delete a layout
export const deleteLayout = (name: string): void => {
  try {
    const savedLayouts = getSavedLayouts();
    delete savedLayouts[name];
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
  } catch (error) {
    console.error('Failed to delete layout:', error);
  }
};

// Rename a layout
export const renameLayout = (oldName: string, newName: string): boolean => {
  try {
    const savedLayouts = getSavedLayouts();
    if (!savedLayouts[oldName] || savedLayouts[newName]) {
      return false; // Source doesn't exist or target already exists
    }

    savedLayouts[newName] = {
      ...savedLayouts[oldName],
      name: newName,
      updated: Date.now()
    };
    delete savedLayouts[oldName];

    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
    return true;
  } catch (error) {
    console.error('Failed to rename layout:', error);
    return false;
  }
};

// Clone a layout
export const cloneLayout = (sourceName: string, newName: string): boolean => {
  try {
    const savedLayouts = getSavedLayouts();
    if (!savedLayouts[sourceName] || savedLayouts[newName]) {
      return false; // Source doesn't exist or target already exists
    }

    const now = Date.now();
    savedLayouts[newName] = {
      ...savedLayouts[sourceName],
      name: newName,
      created: now,
      updated: now
    };

    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(savedLayouts));
    return true;
  } catch (error) {
    console.error('Failed to clone layout:', error);
    return false;
  }
};

// Get current layout from all panels
export const getCurrentLayout = (): Record<string, PanelLayout> => {
  const panelKeys = [
    'fpv.panel',
    'h20n.panel',
    'map.panel',
    'hsi.panel',
    'controller.panel',
    'vision.panel',
    'agent.panel'
  ];

  const layout: Record<string, PanelLayout> = {};

  panelKeys.forEach(key => {
    try {
      const position = JSON.parse(localStorage.getItem(`${key}.pos`) || '{}');
      const size = JSON.parse(localStorage.getItem(`${key}.size`) || '{}');
      const visible = JSON.parse(localStorage.getItem(`${key}.visible`) || 'true');
      const zIndex = parseInt(localStorage.getItem(`${key}.zIndex`) || '50');

      if (position.x !== undefined && size.w !== undefined) {
        layout[key] = { position, size, visible, zIndex };
      }
    } catch {
      // Skip invalid entries
    }
  });

  return layout;
};

// Apply a layout to all panels
export const applyLayout = (layout: Record<string, PanelLayout>): void => {
  Object.entries(layout).forEach(([panelKey, panelLayout]) => {
    try {
      localStorage.setItem(`${panelKey}.pos`, JSON.stringify(panelLayout.position));
      localStorage.setItem(`${panelKey}.size`, JSON.stringify(panelLayout.size));
      localStorage.setItem(`${panelKey}.visible`, JSON.stringify(panelLayout.visible));
      localStorage.setItem(`${panelKey}.zIndex`, panelLayout.zIndex.toString());
    } catch (error) {
      console.error(`Failed to apply layout for ${panelKey}:`, error);
    }
  });

  // Dispatch events to notify all panels to refresh from localStorage
  // This avoids the need for window.location.reload() which can cause issues in Electron
  const panelKeys = Object.keys(layout);
  panelKeys.forEach(panelKey => {
    // Trigger visibility change event
    const visibilityEventType = getPanelVisibilityEventType(panelKey);
    const visible = layout[panelKey].visible;
    window.dispatchEvent(new CustomEvent(visibilityEventType, { detail: visible }));
  });

  // Dispatch a global layout refresh event that components can listen to
  window.dispatchEvent(new CustomEvent('layoutRefresh', { detail: layout }));
};

// Helper function to get the correct visibility event type for each panel
const getPanelVisibilityEventType = (panelKey: string): string => {
  const eventMap: Record<string, string> = {
    'fpv.panel': 'fpvCameraPanelVisibilityChange',
    'h20n.panel': 'h20nCameraPanelVisibilityChange',
    'map.panel': 'mapPanelVisibilityChange',
    'hsi.panel': 'hsiPanelVisibilityChange',
    'controller.panel': 'controllerPanelVisibilityChange',
    'vision.panel': 'visionPanelVisibilityChange',
    'agent.panel': 'agentPanelVisibilityChange'
  };
  return eventMap[panelKey] || `${panelKey}VisibilityChange`;
};