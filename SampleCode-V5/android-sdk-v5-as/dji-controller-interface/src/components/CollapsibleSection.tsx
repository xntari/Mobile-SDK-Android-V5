import React from 'react';

export type CollapsibleSectionProps = {
  title: React.ReactNode;
  storageKey: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  badge?: React.ReactNode;
  summary?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  headerActions?: React.ReactNode;
};

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  storageKey,
  defaultOpen = true,
  children,
  badge,
  summary,
  className,
  bodyClassName,
  headerActions,
}) => {
  const contentId = React.useId();
  const [open, setOpen] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultOpen;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw == null) return defaultOpen;
      return JSON.parse(raw) === true;
    } catch {
      return defaultOpen;
    }
  });

  const toggle = React.useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // ignore storage errors
        }
      }
      return next;
    });
  }, [storageKey]);

  return (
    <div className={`border border-gray-700/70 rounded-md overflow-hidden bg-black/45 ${className ?? ''}`}>
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={toggle}
          className="flex-1 flex items-center justify-between gap-3 px-3 py-2 text-xs tracking-wide uppercase text-gray-300 bg-gray-900/70 hover:bg-gray-800"
          aria-expanded={open}
          aria-controls={contentId}
        >
          <div className="flex items-center gap-2">
            <span>{title}</span>
            {badge ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-400/60 whitespace-nowrap">
                {badge}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-gray-500 whitespace-nowrap">
            {summary ? <span className="truncate max-w-[160px] text-right">{summary}</span> : null}
            <span className="text-gray-500">{open ? '▾' : '▸'}</span>
          </div>
        </button>
        {headerActions ? (
          <div
            className="flex items-center gap-2 px-2 py-2 bg-gray-900/70 border-l border-gray-800/60"
            onClick={(event) => event.stopPropagation()}
          >
            {headerActions}
          </div>
        ) : null}
      </div>
      {open && (
        <div id={contentId} className={`p-3 space-y-3 text-xs text-gray-200 ${bodyClassName ?? ''}`}>
          {children}
        </div>
      )}
    </div>
  );
};

export const SectionLabel: React.FC<{ label: string; hint?: React.ReactNode }> = ({ label, hint }) => (
  <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-gray-400">
    <span>{label}</span>
    {hint ? <span className="text-[10px] text-gray-500 normal-case">{hint}</span> : null}
  </div>
);
