import React, { useState, useEffect } from 'react';
import { visionPanelControls } from './VisionPanel';
import { agentPanelControls } from './AgentPanel';
import { fpvCameraPanelControls, h20nCameraPanelControls } from './CameraPanel';

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
    id: 'vision',
    title: 'Vision Analysis',
    isVisible: visionPanelControls.isVisible,
    setVisible: visionPanelControls.setVisible
  },
  {
    id: 'agent',
    title: 'Agent Control',
    isVisible: agentPanelControls.isVisible,
    setVisible: agentPanelControls.setVisible
  }
];

export const ComponentsMenu: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelStates, setPanelStates] = useState<Record<string, boolean>>({});

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

  const handleResetLayout = () => {
    if (confirm('Reset all panels to their default positions? This cannot be undone.')) {
      // Clear localStorage for all panels
      panelControls.forEach(control => {
        try {
          localStorage.removeItem(`${control.id}.panel.pos`);
          localStorage.removeItem(`${control.id}.panel.size`);
          localStorage.removeItem(`${control.id}.panel.visible`);
        } catch {}
      });
      // Reload to apply defaults
      window.location.reload();
    }
    setMenuOpen(false);
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
          className="absolute right-0 mt-1 w-48 bg-gray-900 border border-gray-700 rounded shadow-lg text-xs z-50"
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

          {/* Separator */}
          {panelControls.length > 0 && <hr className="border-gray-700 my-1" />}

          {/* Reset layout */}
          <button
            className="block w-full text-left px-3 py-2 hover:bg-gray-800 text-gray-300"
            onClick={handleResetLayout}
          >
            Reset Layout
          </button>
        </div>
      )}
    </div>
  );
};