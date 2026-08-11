// ── Kebab "…" cho một card App / một row Feature ─────────────────────────────
// Popover tối giản, tự viết thay vì thêm dependency (giống OverflowMenu trong
// PipelinesView.tsx, nhưng dùng CSS module của drill-down thay cho các selector
// global `pl-menu`).
//
// Điểm phải cẩn thận: card App và row Feature CHÍNH NÓ là một <button> điều
// hướng. Nút này không được lồng bên trong nút đó (HTML cấm button-in-button),
// nên nó được render như một phần tử ANH EM và đặt tuyệt đối lên góc — xem
// `.cardShell` / `.rowShell` trong PipelineNavViews.module.css.

import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from '../Icon';
import styles from './PipelineNavViews.module.css';

export interface RowAction {
  key: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  /** Hành động phá hủy — tô đỏ để phân biệt với "Đổi tên". */
  danger?: boolean;
}

export function RowActionsMenu({
  actions,
  label = 'Thao tác',
}: {
  actions: RowAction[];
  label?: string;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Click ra ngoài → đóng (không đòi focus lại, người dùng đã chủ động bấm chỗ
  // khác). Escape → đóng VÀ trả focus về nút "…" để bàn phím không mất chỗ.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (rootRef.current?.contains(ev.target as Node)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className={styles.actionsMenu} ref={rootRef} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.actionsTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more-horizontal" size={15} />
      </button>
      {open ? (
        <ul role="menu" className={styles.actionsList} aria-label={label}>
          {actions.map((a) => (
            <li key={a.key} role="none">
              <button
                type="button"
                role="menuitem"
                className={`${styles.actionsItem}${a.danger ? ` ${styles.actionsItemDanger}` : ''}`}
                onClick={() => {
                  setOpen(false);
                  a.onSelect();
                }}
              >
                <Icon name={a.icon} size={13} />
                <span>{a.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
