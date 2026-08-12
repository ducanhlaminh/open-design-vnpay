import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectSyncApplyResult,
  ProjectSyncPlan,
  ProjectSyncResolution,
  ProjectSyncScope,
} from '@open-design/contracts';

import {
  ProjectSyncPlanExpiredError,
  applyProjectSync,
  planProjectSync,
} from '../../providers/project-sync';
import { Icon } from '../Icon';
import { PlModal } from '../pipelines/PlModal';
import { SyncPreviewTree } from './SyncPreviewTree';
import { SyncSummary } from './SyncSummary';
import styles from './ProjectSyncPreview.module.css';

export interface ProjectSyncPreviewModalProps {
  scope: ProjectSyncScope;
  /** User-facing App/Feature name, used only in the dialog copy. */
  subjectName: string;
  onClose: () => void;
  /** Caller refreshes cards/navigation after an accepted APPLY. */
  onApplied?: (result: ProjectSyncApplyResult) => void;
}

/** Pull-only preview: sharing now uses the common `PushAllModal` everywhere. */
export function ProjectSyncPreviewModal({ scope, subjectName, onClose, onApplied }: ProjectSyncPreviewModalProps) {
  const [plan, setPlan] = useState<ProjectSyncPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ProjectSyncResolution>>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExpired(false);
    setPlan(null);
    setResolutions({});
    try {
      const nextPlan = await planProjectSync({ direction: 'pull', scope, includeDeleted: true });
      setPlan(nextPlan);
      setResolutions(Object.fromEntries(nextPlan.entries.map((entry) => [entry.path, entry.resolution])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể tải phần xem trước đồng bộ.');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (expired || error) reloadRef.current?.focus();
  }, [error, expired]);

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyProjectSync({ planId: plan.planId, resolutions });
      onApplied?.(result);
      if (result.stale.length > 0) {
        setError(`Có ${result.stale.length} mục đã thay đổi sau khi lập kế hoạch. Hãy tải lại để xem kế hoạch mới.`);
        return;
      }
      onClose();
    } catch (cause) {
      if (cause instanceof ProjectSyncPlanExpiredError) setExpired(true);
      else setError(cause instanceof Error ? cause.message : 'Không thể áp dụng đồng bộ.');
    } finally {
      setApplying(false);
    }
  };

  const title = `Lấy dự án về máy · ${subjectName}`;

  const footer = (
    <div className={styles.footer}>
      <span className={styles.footerNote} aria-live="polite">
        {plan ? `${plan.summary.changed + plan.summary.created + plan.summary.deleted} mục sẽ được cập nhật` : 'Xem trước nội dung trước khi cập nhật'}
      </span>
      <div className={styles.footerActions}>
        <button type="button" className="pl-btn" onClick={onClose} disabled={applying}>Hủy</button>
        <button type="button" className="pl-btn pl-btn--primary" onClick={() => void apply()} disabled={!plan || loading || applying || expired}>
          <Icon name={applying ? 'spinner' : 'download'} size={14} />
          {applying ? 'Đang lấy về…' : 'Lấy dự án về máy'}
        </button>
      </div>
    </div>
  );

  return (
    <PlModal title={title} icon="download" size="lg" busy={applying} onClose={onClose} footer={footer}>
      <div className={styles.modal}>
        {loading ? <div className={styles.loading} role="status">Đang tải trạng thái và bản trong kho chung…</div> : null}
        {plan ? <><SyncSummary summary={plan.summary} /><SyncPreviewTree plan={plan} resolutions={resolutions} onResolutionChange={(path, resolution) => setResolutions((current) => ({ ...current, [path]: resolution }))} /></> : null}
        {!loading && !error && !plan ? <p className={styles.empty}>Chưa có thay đổi nào để xem trước.</p> : null}
        {expired ? <div className={styles.error} role="alert"><Icon name="refresh" size={15} /><span>Kế hoạch đã hết hạn. Tải lại để nhận ảnh chụp mới trước khi áp dụng.</span><button ref={reloadRef} type="button" className="pl-btn pl-btn--xs" onClick={() => void load()}>Tải lại xem trước</button></div> : null}
        {error ? <div className={styles.error} role="alert"><Icon name="info" size={15} /><span>{error}</span><button ref={reloadRef} type="button" className="pl-btn pl-btn--xs" onClick={() => void load()}>Tải lại</button></div> : null}
      </div>
    </PlModal>
  );
}
