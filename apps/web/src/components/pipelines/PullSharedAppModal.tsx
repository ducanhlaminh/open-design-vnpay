// Bước 1 của "Lấy dự án về máy" khi App đó CHƯA từng tồn tại cục bộ — kể cả
// lúc trang Apps đang rỗng. `ProjectSyncPreviewModal` chỉ pull được vào một
// scope đã có sẵn (đã có mapping `_studio/project-sync-mapping.json` để
// daemon tự suy ra origin); một App hoàn toàn mới không có mapping đó.
//
// Nên modal này làm hai việc trước khi giao lại cho `ProjectSyncPreviewModal`:
// 1) liệt kê các App origin trong kho chung mà máy này CHƯA map (đối chiếu
//    với `mappedOriginIds` — caller tính từ `syncStatusByAppId` đã có sẵn),
// 2) chọn một origin → tạo App RỖNG cục bộ bằng đúng API `NewAppModal` dùng
//    (`POST /api/pipelines/apps`), rồi mở `ProjectSyncPreviewModal` cho App
//    đó với `origin` truyền tường minh (App vừa tạo chưa có mapping).
//
// Sau lượt pull đầu tiên đó, `apply()` tự ghi mapping — các lượt sau dùng lại
// đúng flow `onPullApp` bình thường, không cần đi qua modal này nữa.

import { useEffect, useMemo, useState } from 'react';
import type { ProjectSyncApplyResult, ProjectSyncOrigin } from '@open-design/contracts';

import { Icon } from '../Icon';
import { ProjectSyncPreviewModal } from '../project-sync';
import { listProjectSyncOrigins } from '../../providers/project-sync';
import { PlModal } from './PlModal';
import { toSlugId } from './newProjectForm';
import styles from './PullSharedAppModal.module.css';

export interface PullSharedAppModalProps {
  /** originId của các App đã có mapping cục bộ — bị loại khỏi danh sách chọn. */
  mappedOriginIds: ReadonlySet<string>;
  onClose: () => void;
  onApplied: (result: ProjectSyncApplyResult) => void;
}

export function PullSharedAppModal({ mappedOriginIds, onClose, onApplied }: PullSharedAppModalProps) {
  const [origins, setOrigins] = useState<ProjectSyncOrigin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingOriginId, setCreatingOriginId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
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

  const pick = async (origin: ProjectSyncOrigin) => {
    setCreatingOriginId(origin.originId);
    setCreateError(null);
    try {
      const appId = toSlugId(origin.name);
      const res = await fetch('/api/pipelines/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, name: origin.name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `Tạo dự án cục bộ thất bại: HTTP ${res.status}`);
      setPulling({ appId: (j?.id as string | undefined) ?? appId, origin });
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Tạo dự án cục bộ thất bại.');
    } finally {
      setCreatingOriginId(null);
    }
  };

  if (pulling) {
    return (
      <ProjectSyncPreviewModal
        scope={{ kind: 'app', projectId: pulling.appId }}
        origin={{ mode: 'existing', originId: pulling.origin.originId }}
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
        {createError ? (
          <div className={styles.error} role="alert">
            <Icon name="info" size={15} />
            <span>{createError}</span>
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
                  disabled={creatingOriginId !== null}
                  onClick={() => void pick(origin)}
                >
                  {creatingOriginId === origin.originId ? (
                    <Icon name="spinner" size={13} />
                  ) : (
                    <Icon name="download" size={13} />
                  )}
                  {creatingOriginId === origin.originId ? 'Đang tạo…' : 'Lấy về máy'}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </PlModal>
  );
}
