import { useEffect, useState } from 'react';

type VisibilityReader = () => boolean;

/**
 * Tracks panel visibility based on the shared Panel event bus so expensive
 * components can short-circuit subscriptions when the operator hides them.
 */
export const usePanelVisibility = (
  readInitial: VisibilityReader,
  eventType: string,
): boolean => {
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      return readInitial();
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<boolean>;
      if (typeof custom.detail === 'boolean') {
        setVisible(custom.detail);
      } else {
        try {
          setVisible(readInitial());
        } catch {
          setVisible(true);
        }
      }
    };

    window.addEventListener(eventType, handler as EventListener);
    return () => window.removeEventListener(eventType, handler as EventListener);
  }, [eventType, readInitial]);

  return visible;
};

