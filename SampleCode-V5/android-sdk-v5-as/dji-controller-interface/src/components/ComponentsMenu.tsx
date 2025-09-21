import React, { useState, useEffect } from 'react';
import { visionPanelControls } from './VisionPanel';
import { visionRTPanelControls } from './VisionRealtimePanel';
import { agentPanelControls } from './AgentPanel';
import { fpvCameraPanelControls, h20nCameraPanelControls } from './CameraPanel';
import { mapPanelControls, hsiPanelControls, controllerPanelControls, orientationPanelControls } from './panelControls';
import {
  getSavedLayouts,
  saveLayout,
  loadLayout,
  deleteLayout,
  renameLayout,
  cloneLayout,
  getCurrentLayout,
  applyLayout
} from '../utils/layoutManager';
import { InputModal, ConfirmModal, Notification } from './Modal';

interface PanelControl {
  id: string;
  title: string;
  isVisible: () => boolean;
  setVisible: (visible: boolean) => void;
}

const panelControls: PanelControl[] = [
  {
    id: 'fpv',
    title: 'FPV Camera',
    isVisible: fpvCameraPanelControls.isVisible,
    setVisible: fpvCameraPanelControls.setVisible
  },
  {
    id: 'h20n',
    title: 'H20N Camera',
    isVisible: h20nCameraPanelControls.isVisible,
    setVisible: h20nCameraPanelControls.setVisible
  },
  {
    id: 'map',
    title: 'Map',
    isVisible: mapPanelControls.isVisible,
    setVisible: mapPanelControls.setVisible
  },
  {
    id: 'hsi',
    title: 'HSI Compass',
    isVisible: hsiPanelControls.isVisible,
    setVisible: hsiPanelControls.setVisible
  },
  {
    id: 'controller',
    title: 'Controller',
    isVisible: controllerPanelControls.isVisible,
    setVisible: controllerPanelControls.setVisible
  },
  {
    id: 'vision',
    title: 'Vision Analysis',
    isVisible: visionPanelControls.isVisible,
    setVisible: visionPanelControls.setVisible
  },
  {
    id: 'visionrt',
    title: 'Vision Realtime (YOLO)',
    isVisible: visionRTPanelControls.isVisible,
    setVisible: visionRTPanelControls.setVisible
  },
  {
    id: 'agent',
    title: 'Agent Control',
    isVisible: agentPanelControls.isVisible,
    setVisible: agentPanelControls.setVisible
  },
  {
    id: 'orientation',
    title: 'Orientation Debug',
    isVisible: orientationPanelControls.isVisible,
    setVisible: orientationPanelControls.setVisible
  }
];

export const ComponentsMenu: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelStates, setPanelStates] = useState<Record<string, boolean>>({});
  const [savedLayouts, setSavedLayouts] = useState(getSavedLayouts());
  const [editingLayout, setEditingLayout] = useState<string | null>(null);

  // Modal states
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [showLoadConfirm, setShowLoadConfirm] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showCloneModal, setShowCloneModal] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'success' | 'error' | 'info';
  }>({ isOpen: false, title: '', message: '', type: 'info' });

  // Update panel states when menu opens
  useEffect(() => {
    if (menuOpen) {
      const states: Record<string, boolean> = {};
      panelControls.forEach(control => {
        states[control.id] = control.isVisible();
      });
      setPanelStates(states);
    }
  }, [menuOpen]);

  const handlePanelToggle = (panelId: string) => {
    const control = panelControls.find(c => c.id === panelId);
    if (control) {
      const newVisible = !control.isVisible();
      control.setVisible(newVisible);
      setPanelStates(prev => ({ ...prev, [panelId]: newVisible }));
    }
    setMenuOpen(false);
  };

  const showNotification = (title: string, message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ isOpen: true, title, message, type });
  };

  const handleResetLayout = () => {
    // Clear localStorage for all panels
    panelControls.forEach(control => {
      try {
        localStorage.removeItem(`${control.id}.panel.pos`);
        localStorage.removeItem(`${control.id}.panel.size`);
        localStorage.removeItem(`${control.id}.panel.visible`);
        localStorage.removeItem(`${control.id}.panel.zIndex`);
      } catch {}
    });
    // Reload to apply defaults
    window.location.reload();
  };

  const handleSaveLayout = (name: string) => {
    const currentLayout = getCurrentLayout();
    saveLayout(name, currentLayout);
    setSavedLayouts(getSavedLayouts());
    showNotification('Layout Saved', `Layout "${name}" saved successfully!`, 'success');
    setMenuOpen(false);
  };

  const handleLoadLayout = (layoutName: string) => {
    const layout = loadLayout(layoutName);
    if (layout) {
      applyLayout(layout.panels);
    }
    setMenuOpen(false);
  };

  const handleDeleteLayout = (layoutName: string) => {
    deleteLayout(layoutName);
    setSavedLayouts(getSavedLayouts());
    showNotification('Layout Deleted', `Layout "${layoutName}" has been deleted.`, 'info');
  };

  const handleRenameLayout = (oldName: string, newName: string) => {
    if (newName && newName.trim() && newName !== oldName) {
      if (renameLayout(oldName, newName.trim())) {
        setSavedLayouts(getSavedLayouts());
        setEditingLayout(null);
        showNotification('Layout Renamed', `Layout renamed to "${newName.trim()}".`, 'success');
      } else {
        showNotification('Rename Failed', 'Failed to rename layout. Name may already exist.', 'error');
      }
    } else {
      setEditingLayout(null);
    }
  };

  const handleCloneLayout = (sourceName: string, newName: string) => {
    if (cloneLayout(sourceName, newName)) {
      setSavedLayouts(getSavedLayouts());
      showNotification('Layout Cloned', `Layout cloned as "${newName}" successfully!`, 'success');
    } else {
      showNotification('Clone Failed', 'Failed to clone layout. Name may already exist.', 'error');
    }
  };

  return (
    <div className="relative">
      <button
        className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-200 hover:bg-gray-600"
        onClick={() => setMenuOpen(v => !v)}
      >
        Components ▾
      </button>

      {menuOpen && (
        <div
          className="absolute right-0 mt-1 w-64 bg-gray-900 border border-gray-700 rounded shadow-lg text-xs z-[100]"
          onMouseLeave={() => setMenuOpen(false)}
        >
          {/* Panel toggles */}
          {panelControls.map(control => {
            const isVisible = panelStates[control.id] ?? control.isVisible();

            return (
              <label
                key={control.id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-gray-800 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={() => handlePanelToggle(control.id)}
                  className="w-3 h-3 rounded"
                />
                <span className="flex-1">{control.title}</span>
              </label>
            );
          })}

          {/* Layout Management */}
          <hr className="border-gray-700 my-1" />

          {/* Save current layout */}
          <button
            className="block w-full text-left px-3 py-2 hover:bg-gray-800 text-blue-300"
            onClick={() => setShowSaveModal(true)}
          >
            💾 Save Layout...
          </button>

          {/* Saved layouts */}
          {Object.keys(savedLayouts).length > 0 && (
            <>
              <div className="px-3 py-1 text-gray-500 text-[10px] uppercase tracking-wide">
                Saved Layouts
              </div>
              {Object.entries(savedLayouts).map(([name, layout]) => (
                <div key={name} className="group">
                  {editingLayout === name ? (
                    <div className="px-3 py-2 bg-gray-800">
                      <input
                        type="text"
                        defaultValue={name}
                        className="w-full bg-gray-700 text-white px-2 py-1 text-xs rounded"
                        onBlur={(e) => handleRenameLayout(name, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameLayout(name, e.currentTarget.value);
                          if (e.key === 'Escape') setEditingLayout(null);
                        }}
                        autoFocus
                      />
                    </div>
                  ) : (
                    <div className="flex items-center px-3 py-2 hover:bg-gray-800">
                      <button
                        className="flex-1 text-left text-green-300"
                        onClick={() => setShowLoadConfirm(name)}
                        title={`Created: ${new Date(layout.created).toLocaleDateString()}`}
                      >
                        📋 {name}
                      </button>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                        <button
                          className="text-gray-400 hover:text-blue-300"
                          onClick={() => setEditingLayout(name)}
                          title="Rename"
                        >
                          ✏️
                        </button>
                        <button
                          className="text-gray-400 hover:text-yellow-300"
                          onClick={() => setShowCloneModal(name)}
                          title="Clone"
                        >
                          📄
                        </button>
                        <button
                          className="text-gray-400 hover:text-red-300"
                          onClick={() => setShowDeleteConfirm(name)}
                          title="Delete"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {/* Reset layout */}
          <hr className="border-gray-700 my-1" />
          <button
            className="block w-full text-left px-3 py-2 hover:bg-gray-800 text-red-300"
            onClick={() => setShowResetConfirm(true)}
          >
            🔄 Reset Layout
          </button>
        </div>
      )}

      {/* Modals */}
      <InputModal
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSubmit={handleSaveLayout}
        title="Save Layout"
        label="Layout Name"
        placeholder="Enter a name for this layout..."
        submitText="Save"
      />

      <ConfirmModal
        isOpen={showLoadConfirm !== null}
        onClose={() => setShowLoadConfirm(null)}
        onConfirm={() => {
          if (showLoadConfirm) {
            handleLoadLayout(showLoadConfirm);
            setShowLoadConfirm(null);
          }
        }}
        title="Load Layout"
        message={showLoadConfirm ? `Load layout "${showLoadConfirm}"? This will restore all panel positions and settings.` : ''}
        confirmText="Load"
      />

      <ConfirmModal
        isOpen={showDeleteConfirm !== null}
        onClose={() => setShowDeleteConfirm(null)}
        onConfirm={() => {
          if (showDeleteConfirm) {
            handleDeleteLayout(showDeleteConfirm);
            setShowDeleteConfirm(null);
          }
        }}
        title="Delete Layout"
        message={showDeleteConfirm ? `Delete layout "${showDeleteConfirm}"? This cannot be undone.` : ''}
        confirmText="Delete"
        danger={true}
      />

      <ConfirmModal
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={() => {
          handleResetLayout();
          setShowResetConfirm(false);
        }}
        title="Reset Layout"
        message="Reset all panels to their default positions? This cannot be undone."
        confirmText="Reset"
        danger={true}
      />

      <InputModal
        isOpen={showCloneModal !== null}
        onClose={() => setShowCloneModal(null)}
        onSubmit={(newName) => {
          if (showCloneModal) {
            handleCloneLayout(showCloneModal, newName);
            setShowCloneModal(null);
          }
        }}
        title="Clone Layout"
        label="New Layout Name"
        placeholder={showCloneModal ? `Copy of ${showCloneModal}` : ''}
        submitText="Clone"
      />

      <Notification
        isOpen={notification.isOpen}
        onClose={() => setNotification(prev => ({ ...prev, isOpen: false }))}
        title={notification.title}
        message={notification.message}
        type={notification.type}
      />
    </div>
  );
};
