// Shared modal shell for the Pipelines surface — backdrop + centered dialog
// with Escape / click-outside close (both suppressed while `busy`), a titled
// header with optional icon, a scrollable body, and an optional footer row.
// Mirrors the NewProjectModal backdrop pattern but stays generic so the
// new-project / run-input / status / result modals all reuse one shell.

import { useEffect, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  icon?: IconName;
  /** While true, Escape and backdrop clicks do not close (e.g. mid-submit). */
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Extra class on the scrollable body — e.g. to drop padding for a
   *  full-bleed preview surface (the Quick-result two-pane layout). */
  bodyClassName?: string;
}

export function PlModal({
  title,
  onClose,
  children,
  footer,
  icon,
  busy = false,
  size = 'sm',
  bodyClassName,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      className="pl-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`pl-modal pl-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="pl-modal__head">
          <span className="pl-modal__title">
            {icon ? <Icon name={icon} size={16} /> : null}
            {title}
          </span>
          <button
            type="button"
            className="pl-modal__close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className={bodyClassName ? `pl-modal__body ${bodyClassName}` : 'pl-modal__body'}>
          {children}
        </div>
        {footer ? <footer className="pl-modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
