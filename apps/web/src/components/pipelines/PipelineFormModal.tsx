// Fresh modal shell + form primitives for NEW Pipelines-surface dialogs,
// styled entirely through PipelineFormModal.module.css (see AGENTS.md "Web
// CSS ownership") instead of the legacy global `pl-modal` / `pl-btn` /
// `pl-input` selectors in styles/home/pipelines.css. Those globals still back
// the OLDER modals in PipelineModals.tsx (PlModal) — this file is the new
// family screens 1-3 (PipelineNavViews.module.css) expect their dialogs to
// match visually.
//
// Behaviourally this matches or exceeds PlModal: Escape + overlay-click close
// (both suppressed while `busy`, same as PlModal), PLUS a focus trap while
// open and focus restored to the trigger element on close — PlModal has
// neither.

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '../Icon';
import styles from './PipelineFormModal.module.css';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface PipelineFormModalProps {
  title: string;
  icon?: IconName;
  /** While true, Escape and backdrop clicks do not close (e.g. mid-submit). */
  busy?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

/** Overlay + dialog shell: `role="dialog"`, labelled by its title via
 *  `aria-labelledby`, Escape/overlay-click to close, a focus trap while open,
 *  and focus returned to whatever triggered it once closed. */
export function PipelineFormModal({
  title,
  icon,
  busy = false,
  onClose,
  footer,
  children,
}: PipelineFormModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  // Focus trap: remember the trigger, move focus into the dialog on mount,
  // and restore it on unmount — the part PlModal never did.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const first = dialog ? focusableIn(dialog)[0] : undefined;
    (first ?? dialog)?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement) trigger.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = focusableIn(dialog);
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const insideDialog = active instanceof Node && dialog.contains(active);
      if (e.shiftKey) {
        if (!insideDialog || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!insideDialog || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className={styles.head}>
          <span id={titleId} className={styles.title}>
            {icon ? <Icon name={icon} size={16} /> : null}
            {title}
          </span>
          <button type="button" className={styles.close} onClick={onClose} disabled={busy} aria-label="Đóng">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </div>
  );
}

interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
}

export interface FormFieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Render-prop so the control gets a real, `useId`-generated `id` (wired to
   *  the `<label htmlFor>`) plus `aria-describedby` covering the hint/error. */
  children: (props: FormFieldControlProps) => ReactNode;
}

/** Label + control slot + optional hint + optional error. */
export function FormField({ label, hint, error, children }: FormFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy })}
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.fieldError} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} type="text" className={className ? `${styles.input} ${className}` : styles.input} {...rest} />;
  },
);

export interface ComboOption {
  value: string;
  label?: string;
}

export interface ComboInputProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  options: ComboOption[];
}

/** Text input + `<datalist>` — editable-with-suggestions. */
export function ComboInput({ id, options, className, ...rest }: ComboInputProps) {
  const listId = useId();
  return (
    <>
      <input
        id={id}
        type="text"
        list={listId}
        className={className ? `${styles.input} ${className}` : styles.input}
        {...rest}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
    </>
  );
}

interface FormButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  busy?: boolean;
}

/** Accent-filled call to action. Does not reuse `pl-btn`. */
export function PrimaryButton({ icon, busy, className, children, disabled, ...rest }: FormButtonProps) {
  return (
    <button
      type="button"
      className={className ? `${styles.btn} ${styles.btnPrimary} ${className}` : `${styles.btn} ${styles.btnPrimary}`}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={busy ? 'spinner' : icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Nút cho hành động PHÁ HỦY (xóa App/Feature): đỏ đầy nền để nó không bị
 *  bấm nhầm như một nút xác nhận bình thường. */
export function DangerButton({ icon, busy, className, children, disabled, ...rest }: FormButtonProps) {
  return (
    <button
      type="button"
      className={className ? `${styles.btn} ${styles.btnDanger} ${className}` : `${styles.btn} ${styles.btnDanger}`}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={busy ? 'spinner' : icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Neutral, low-emphasis button (Cancel / secondary actions). */
export function QuietButton({ icon, busy, className, children, disabled, ...rest }: FormButtonProps) {
  return (
    <button
      type="button"
      className={className ? `${styles.btn} ${className}` : styles.btn}
      disabled={disabled || busy}
      {...rest}
    >
      {icon ? <Icon name={busy ? 'spinner' : icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Đoạn văn giải thích trong thân hộp thoại (hộp thoại xác nhận không có
 *  trường nhập nào, chỉ có chữ). */
export function FormText({ children }: { children: ReactNode }) {
  return <p className={styles.text}>{children}</p>;
}

/** Inline error banner, matching the old `.pl-modal-error` treatment. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div className={styles.error} role="alert">
      <Icon name="info" size={14} />
      <span>{children}</span>
    </div>
  );
}
