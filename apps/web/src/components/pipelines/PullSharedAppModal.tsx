// Bước 1 của "Lấy dự án về máy" khi App chưa tồn tại cục bộ.
// Chọn origin chỉ chuẩn bị destination id cho PLAN; không tạo App rỗng.
// Daemon chỉ materialize App + mapping sau khi APPLY hoàn tất sạch, nên
// Hủy/PLAN lỗi không để lại App mồ côi trong sidebar.

import { useEffect, useMemo, useState } from 'react';
import type {
  ProjectSyncApplyResult,
  ProjectSyncOrigin,
  ProjectSyncOriginSelection,
  ProjectSyncScope,
} from '@open-design/contracts';

import { Icon } from '../Icon';
import { ProjectSyncPreviewModal } from '../project-sync';
import { listProjectSyncOrigins } from '../../providers/project-sync';
import { PlModal } from './PlModal';
import { toSlugId } from './newProjectForm';
import styles from './PullSharedAppModal.module.css';

export interface PullSharedAppModalProps {
  /** originId của các App đã có mapping cục bộ — bị loại khỏi danh sách chọn. */
  mappedOriginIds: ReadonlySet<string>;
  /** App ids đang tồn tại trên máy, dùng để không ghi đè destination. */
  localAppIds: ReadonlySet<string>;
  onClose: () => void;
  onApplied: (result: ProjectSyncApplyResult) => void;
}

export function PullSharedAppModal({ mappedOriginIds, localAppIds, onClose, onApplied }: PullSharedAppModalProps) {
  const [origins, setOrigins] = useState<ProjectSyncOrigin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pulling, setPulling] = useState<{ appId: string; origin: ProjectSyncOrigin } | null>(null);

  useEffect(() => {
    let alive = true;
    void listProjectSyncOrigins()
      .then((list) => { if (alive) setOrigins(list); })
      .catch((cause) => {
        if (alive) setLoadError(cause instanceof Error ? cause.message : 'Không thể tải danh sách dự án đã chia sẻ.');
      });
    return () => { alive = false; };
  }, []);

  const available = useMemo(
    () => (origins ?? []).filter((origin) => origin.kind === 'app' && !mappedOriginIds.has(origin.originId)),
    [origins, mappedOriginIds],
  );
  const pullScope = useMemo<ProjectSyncScope | null>(() => (
    pulling ? { kind: 'app', projectId: pulling.appId } : null
  ), [pulling?.appId]);
  const pullOrigin = useMemo<ProjectSyncOriginSelection | undefined>(() => (
    pulling ? { mode: 'existing', originId: pulling.origin.originId } : undefined
  ), [pulling?.origin.originId]);

  const pick = (origin: ProjectSyncOrigin) => {
    const base = toSlugId(origin.name);
    let appId = base;
    let suffix = 2;
    while (localAppIds.has(appId)) {
      const tail = `-${suffix++}`;
      appId = `${base.slice(0, 64 - tail.length)}${tail}`;
    }
    setPulling({ appId, origin });
  };

  if (pulling && pullScope) {
    return (
      <ProjectSyncPreviewModal
        scope={pullScope}
        origin={pullOrigin}
        subjectName={pulling.origin.name}
        onClose={onClose}
        onApplied={onApplied}
      />
    );
  }

  return (
    <PlModal title="Lấy dự án về máy" icon="download" size="md" onClose={onClose}>
      <div className={styles.modal}>
        {loadError ? (
          <div className={styles.error} role="alert">
            <Icon name="info" size={15} />
            <span>{loadError}</span>
          </div>
        ) : null}
        {!loadError && origins === null ? (
          <p className={styles.loading} role="status">Đang tải danh sách dự án đã chia sẻ…</p>
        ) : null}
        {!loadError && origins !== null && available.length === 0 ? (
          <p className={styles.empty}>Chưa có dự án nào khác đã chia sẻ mà máy này chưa có.</p>
        ) : null}
        {available.length > 0 ? (
          <ul className={styles.list}>
            {available.map((origin) => (
              <li key={origin.originId} className={styles.row}>
                <span className={styles.rowName}>{origin.name}</span>
                <button
                  type="button"
                  className="pl-btn pl-btn--primary pl-btn--xs"
                  onClick={() => pick(origin)}
                >
                  <Icon name="download" size={13} />
                  Lấy về máy
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </PlModal>
  );
}
