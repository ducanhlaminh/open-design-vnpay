// The workspace toolbar's Preview affordance.
//
// Reaching a generated preview used to take 5-7 clicks (Design Files tab →
// drill docs-to-ui/<target>/prototype/… → single-click shows only a dead
// thumbnail → "Open"). Auto-opening after the agent writes a file stays OFF on
// purpose (a user preference), so the answer is an explicit control: one
// dropdown listing every pipeline step, the finished ones clickable straight to
// their preview, plus a reload button that cache-busts the preview iframe.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../i18n';
import { Icon } from './Icon';
import { resolvePreviewTargets, type PreviewTarget } from './preview-targets';

interface Props {
  files: readonly { name: string }[];
  activeTab: string | null;
  onOpenFile: (path: string) => void;
  onReloadPreview: () => void;
  reloading?: boolean;
}

function itemTestId(item: PreviewTarget): string {
  return item.target
    ? `workspace-preview-item-${item.stageId}-${item.target}`
    : `workspace-preview-item-${item.stageId}`;
}

export function WorkspacePreviewMenu({
  files,
  activeTab,
  onOpenFile,
  onReloadPreview,
  reloading = false,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape dismissal, same shape as ConversationsMenu. The
  // keydown listener is scoped to the open popover only — no global shortcut.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = resolvePreviewTargets(files);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ws-preview-trigger${open ? ' is-open' : ''}`}
        data-testid="workspace-preview-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('workspace.previewMenu')}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="eye" size={14} />
        <span className="ws-preview-trigger__label">{t('workspace.previewMenu')}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <button
        type="button"
        className="icon-only ws-preview-reload"
        data-testid="workspace-preview-reload"
        title={t('workspace.reloadPreview')}
        aria-label={t('workspace.reloadPreview')}
        disabled={reloading}
        onClick={() => onReloadPreview()}
      >
        <Icon name={reloading ? 'spinner' : 'reload'} size={14} />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <PreviewMenuPopover
              menuRef={menuRef}
              anchor={triggerRef.current}
              items={items}
              activeTab={activeTab}
              onPick={(path) => {
                setOpen(false);
                onOpenFile(path);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function PreviewMenuPopover({
  menuRef,
  anchor,
  items,
  activeTab,
  onPick,
}: {
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  anchor: HTMLElement | null;
  items: PreviewTarget[];
  activeTab: string | null;
  onPick: (path: string) => void;
}) {
  const t = useT();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left });
  }, [anchor]);

  return (
    <div
      ref={menuRef}
      className="ws-preview-menu"
      role="menu"
      data-testid="workspace-preview-menu"
      aria-label={t('workspace.previewMenu')}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      {items.map((item) => {
        const ready = item.path !== null;
        return (
          <button
            key={itemTestId(item)}
            type="button"
            role="menuitem"
            className={`ws-preview-menu__item${ready ? '' : ' is-pending'}`}
            data-testid={itemTestId(item)}
            disabled={!ready}
            aria-disabled={ready ? undefined : 'true'}
            aria-current={ready && item.path === activeTab ? 'true' : undefined}
            title={ready ? item.path! : t('workspace.previewNotReady')}
            onClick={() => {
              if (item.path) onPick(item.path);
            }}
          >
            <span className="ws-preview-menu__label">{t(item.labelKey)}</span>
            {item.target ? (
              <span className="ws-preview-menu__chip">{item.target}</span>
            ) : null}
            {ready ? null : (
              <span className="ws-preview-menu__hint">{t('workspace.previewNotReady')}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
