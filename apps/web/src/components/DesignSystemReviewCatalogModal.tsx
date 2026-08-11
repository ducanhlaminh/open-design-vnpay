import { useEffect, useState } from 'react';
import {
  FigmaDsPreviewTabs,
  type CriteriaDocumentKind,
  type CriteriaDocumentLoader,
  type CriteriaDocumentView,
  type FigmaDsPreviewTab,
  type FigmaDsPreviewViewState,
} from './FigmaDsPreviewTabs';
import { Icon } from './Icon';
import styles from './DesignSystemReviewCatalogModal.module.css';

export interface DesignSystemReviewCatalogModalProps {
  open: boolean;
  systemId: string;
  title: string;
  initialTab?: FigmaDsPreviewTab;
  initialDocumentView?: Partial<Record<CriteriaDocumentKind, CriteriaDocumentView>>;
  loadCriteriaDocument?: CriteriaDocumentLoader;
  onGenerate?: (kind: CriteriaDocumentKind) => void | Promise<void>;
  /** Opens the Figma ZIP update flow. Kept outside the viewer so it stays read-only. */
  onUpdateFigma?: () => void;
  onReload?: () => void | Promise<void>;
  onViewStateChange?: (state: FigmaDsPreviewViewState) => void;
  onClose: () => void;
}

/** Full-window, read-only catalog for the approved showcase and criteria docs. */
export function DesignSystemReviewCatalogModal({
  open,
  systemId,
  title,
  initialTab,
  initialDocumentView,
  loadCriteriaDocument,
  onGenerate,
  onUpdateFigma,
  onReload,
  onViewStateChange,
  onClose,
}: DesignSystemReviewCatalogModalProps) {
  const [updateMenuOpen, setUpdateMenuOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className={styles.overlay} role="presentation">
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="design-system-review-title"
        data-testid="design-system-review-catalog-modal"
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <span className={styles.eyebrow}>Design System</span>
            <h1 id="design-system-review-title">Danh mục review</h1>
            <p>
              Xem showcase, danh mục thành phần và nguyên tắc đang dùng cho <strong>{title}</strong>.
            </p>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.updateMenuWrap}>
              <button
                type="button"
                className={styles.updateButton}
                aria-expanded={updateMenuOpen}
                aria-haspopup="menu"
                onClick={() => setUpdateMenuOpen((openMenu) => !openMenu)}
              >
                <Icon name="refresh" size={16} />
                Cập nhật
                <Icon name="chevron-down" size={15} />
              </button>
              {updateMenuOpen ? (
                <div className={styles.updateMenu} role="menu" aria-label="Cập nhật Design System Figma">
                  <button type="button" role="menuitem" onClick={() => { setUpdateMenuOpen(false); onUpdateFigma?.(); }} disabled={!onUpdateFigma}>
                    <Icon name="upload" size={16} />
                    <span><strong>Cập nhật file ZIP Figma</strong><small>Nạp bản export Figma mới cho bộ này</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setUpdateMenuOpen(false); void onGenerate?.('components'); }} disabled={!onGenerate}>
                    <Icon name="file" size={16} />
                    <span><strong>Cập nhật file mô tả thành phần</strong><small>Sinh lại danh mục component</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setUpdateMenuOpen(false); void onGenerate?.('rules'); }} disabled={!onGenerate}>
                    <Icon name="file" size={16} />
                    <span><strong>Cập nhật file nguyên tắc</strong><small>Sinh lại quy tắc thiết kế</small></span>
                  </button>
                </div>
              ) : null}
            </div>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Đóng Danh mục review">
              <Icon name="close" size={19} />
            </button>
          </div>
        </header>

        <main className={styles.content}>
          <FigmaDsPreviewTabs
            key={systemId}
            systemId={systemId}
            initialTab={initialTab}
            initialDocumentView={initialDocumentView}
            loadCriteriaDocument={loadCriteriaDocument}
            onGenerate={onGenerate}
            onReload={onReload}
            onViewStateChange={onViewStateChange}
            className={styles.preview}
          />
        </main>
      </section>
    </div>
  );
}
