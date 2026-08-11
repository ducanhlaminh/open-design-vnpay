import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  approveDesignSystemCriteriaDraft,
  approveDesignSystemFigmaUpdate,
  discardDesignSystemCriteriaDraft,
  fetchDesignSystemFigmaUpdateState,
  uploadDesignSystemFigmaUpdate,
  type DesignSystemContextUpdate,
  type DesignSystemCriteriaKind,
  type DesignSystemCriteriaUpdateState,
  type DesignSystemFigmaUpdateState,
} from '../providers/design-system-figma-update';
import { Icon } from './Icon';
import styles from './DesignSystemFigmaUpdate.module.css';

const KIND_LABELS: Record<DesignSystemCriteriaKind, string> = {
  components: 'Danh mục component',
  rules: 'Quy tắc thiết kế',
};

function activeCandidate(state: DesignSystemFigmaUpdateState | null): boolean {
  return Boolean(state?.candidateVersion && state.lifecycle !== 'approved');
}

function staleCriteria(state: DesignSystemFigmaUpdateState | null): DesignSystemCriteriaKind[] {
  if (!state) return [];
  return (Object.keys(state.criteria) as DesignSystemCriteriaKind[]).filter(
    (kind) => state.criteria[kind].status === 'stale' || state.criteria[kind].status === 'missing',
  );
}

function draftCriteria(state: DesignSystemFigmaUpdateState | null): DesignSystemCriteriaKind[] {
  if (!state) return [];
  return (Object.keys(state.criteria) as DesignSystemCriteriaKind[]).filter(
    (kind) => state.criteria[kind].status === 'draft',
  );
}

export function useDesignSystemFigmaUpdateState(systemId: string) {
  const [state, setState] = useState<DesignSystemFigmaUpdateState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await fetchDesignSystemFigmaUpdateState(systemId);
    if (result.ok) {
      setState(result.value);
      setError(null);
    } else {
      setError(result.error.message);
    }
    setLoading(false);
    return result;
  }, [systemId]);

  useEffect(() => {
    setLoading(true);
    setState(null);
    setError(null);
    void refresh();
  }, [refresh]);

  return { state, setState, loading, error, setError, refresh };
}

export function DesignSystemFigmaUpdateWorkspace({
  systemId,
  title,
  children,
  initialUpdateOpen = false,
}: {
  systemId: string;
  title: string;
  children: ReactNode;
  initialUpdateOpen?: boolean;
}) {
  const update = useDesignSystemFigmaUpdateState(systemId);
  const [updateModalOpen, setUpdateModalOpen] = useState(initialUpdateOpen);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [contextUpdates, setContextUpdates] = useState<DesignSystemContextUpdate[]>([]);

  const candidate = activeCandidate(update.state);
  const candidateVersion = update.state?.candidateVersion;
  const stale = staleCriteria(update.state);
  const drafts = draftCriteria(update.state);

  return (
    <div className={styles.workspace}>
      <div className={styles.workspaceBar}>
        <div className={styles.workspaceStatus}>
          <strong>
            {candidate && candidateVersion
              ? `Bản ${candidateVersion} đang chờ duyệt`
              : `Bản đang dùng: ${update.state?.currentVersion ?? 1}`}
          </strong>
          <span>
            {candidate
              ? 'Bộ Figma mới chưa ảnh hưởng tới ứng dụng hoặc Feature đang làm.'
              : 'Cập nhật ZIP mới khi bộ Figma có thêm hoặc thay đổi component.'}
          </span>
        </div>
        <div className={styles.workspaceActions}>
          {candidate ? (
            <button type="button" className={styles.secondaryButton} onClick={() => setApprovalModalOpen(true)}>
              <Icon name="check" />
              {`Xác nhận duyệt bản ${candidateVersion}`}
            </button>
          ) : null}
          {!candidate ? (
            <button type="button" className={styles.primaryButton} onClick={() => setUpdateModalOpen(true)}>
              <Icon name="upload" />
              Cập nhật từ file Figma
            </button>
          ) : null}
        </div>
      </div>

      {candidate ? (
        <section className={styles.pendingNotice} aria-label="Design System đang chờ duyệt">
          <Icon name="info" />
          <div>
            <strong>Hai tài liệu cũ vẫn đang được sử dụng</strong>
            <p>
              Hãy tự sinh lại danh mục component và quy tắc thiết kế, xem bản nháp rồi duyệt từng tài liệu.
              Bạn vẫn có thể duyệt Design System với tài liệu cũ sau khi xác nhận cảnh báo.
            </p>
          </div>
          <div className={styles.noticeBadges}>
            {(Object.keys(update.state?.criteria ?? {}) as DesignSystemCriteriaKind[]).map((kind) => (
              <span key={kind} data-status={update.state?.criteria[kind].status}>
                {KIND_LABELS[kind]}: {criteriaStatusLabel(update.state!.criteria[kind].status)}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {contextUpdates.length > 0 ? <ContextUpdatesNotice updates={contextUpdates} /> : null}
      <div className={styles.previewHost}>{children}</div>

      {updateModalOpen ? (
        <FigmaUpdateModal
          title={title}
          currentVersion={update.state?.currentVersion ?? 1}
          onClose={() => setUpdateModalOpen(false)}
          onSubmit={async (files, deleteOldSource) => {
            const result = await uploadDesignSystemFigmaUpdate(systemId, files, deleteOldSource);
            if (result.ok) {
              update.setState(result.value);
              update.setError(null);
            }
            return result;
          }}
        />
      ) : null}

      {approvalModalOpen && update.state ? (
        <FinalApprovalModal
          version={update.state.candidateVersion ?? update.state.currentVersion}
          stale={stale}
          drafts={drafts}
          deleteOldSource={update.state.deleteOldSourceAfterApproval}
          onClose={() => setApprovalModalOpen(false)}
          onApprove={async (confirmStale) => {
            const result = await approveDesignSystemFigmaUpdate(systemId, confirmStale);
            if (result.ok) {
              update.setState(result.value.state);
              setContextUpdates(result.value.contextUpdates);
            }
            return result;
          }}
        />
      ) : null}
    </div>
  );
}

export function DesignSystemCriteriaUpdateReview({
  systemId,
  state,
  onStateChange,
}: {
  systemId: string;
  state: DesignSystemFigmaUpdateState | null;
  onStateChange: (state: DesignSystemFigmaUpdateState) => void;
}) {
  const [openDraft, setOpenDraft] = useState<DesignSystemCriteriaKind | null>(null);
  const [busyKind, setBusyKind] = useState<DesignSystemCriteriaKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [contextUpdates, setContextUpdates] = useState<DesignSystemContextUpdate[]>([]);

  if (!activeCandidate(state) || !state) return null;
  const stale = staleCriteria(state);
  const drafts = draftCriteria(state);

  async function approveDraft(kind: DesignSystemCriteriaKind) {
    setBusyKind(kind);
    const result = await approveDesignSystemCriteriaDraft(systemId, kind);
    setBusyKind(null);
    if (result.ok) {
      onStateChange(result.value);
      setOpenDraft(null);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }

  async function discardDraft(kind: DesignSystemCriteriaKind) {
    setBusyKind(kind);
    const result = await discardDesignSystemCriteriaDraft(systemId, kind);
    setBusyKind(null);
    if (result.ok) {
      onStateChange(result.value);
      setOpenDraft(null);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }

  return (
    <section className={styles.criteriaReview} aria-label="Tình trạng cập nhật Design System">
      <div className={styles.criteriaReviewHead}>
        <div>
          <strong>{`Bộ Figma bản ${state.candidateVersion} đang chờ hoàn thiện`}</strong>
          <p>File đang dùng được giữ nguyên cho tới khi bạn duyệt bản nháp mới.</p>
        </div>
        <button type="button" className={styles.primaryButton} onClick={() => setApprovalOpen(true)}>
          {`Xác nhận duyệt bản ${state.candidateVersion}`}
        </button>
      </div>

      <div className={styles.criteriaRows}>
        {(Object.keys(state.criteria) as DesignSystemCriteriaKind[]).map((kind) => {
          const item = state.criteria[kind];
          return (
            <div className={styles.criteriaRow} key={kind}>
              <div>
                <strong>{KIND_LABELS[kind]}</strong>
                <span>{criteriaVersionCopy(item, state.candidateVersion)}</span>
              </div>
              <span className={styles.statusBadge} data-status={item.status}>
                {criteriaStatusLabel(item.status)}
              </span>
              {item.status === 'draft' ? (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setOpenDraft(openDraft === kind ? null : kind)}
                >
                  <Icon name="eye" />
                  {openDraft === kind ? 'Đóng bản nháp' : 'Xem bản nháp'}
                </button>
              ) : null}
              {openDraft === kind && item.status === 'draft' ? (
                <div className={styles.draftReview}>
                  <DraftComparison item={item} />
                  <div className={styles.draftActions}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busyKind === kind}
                      onClick={() => void discardDraft(kind)}
                    >
                      Bỏ bản nháp
                    </button>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={busyKind === kind}
                      onClick={() => void approveDraft(kind)}
                    >
                      <Icon name="check" />
                      Duyệt bản mới
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {contextUpdates.length > 0 ? <ContextUpdatesNotice updates={contextUpdates} /> : null}

      {approvalOpen ? (
        <FinalApprovalModal
          version={state.candidateVersion ?? state.currentVersion}
          stale={stale}
          drafts={drafts}
          deleteOldSource={state.deleteOldSourceAfterApproval}
          onClose={() => setApprovalOpen(false)}
          onApprove={async (confirmStale) => {
            const result = await approveDesignSystemFigmaUpdate(systemId, confirmStale);
            if (result.ok) {
              onStateChange(result.value.state);
              setContextUpdates(result.value.contextUpdates);
            }
            return result;
          }}
        />
      ) : null}
    </section>
  );
}

export function CriteriaStaleBadge({
  state,
  candidateVersion,
}: {
  state?: DesignSystemCriteriaUpdateState;
  candidateVersion?: number | null;
}) {
  if (!state || state.status === 'current') return null;
  return (
    <span className={styles.statusBadge} data-status={state.status}>
      {state.status === 'draft'
        ? 'Bản mới chờ duyệt'
        : state.status === 'missing'
          ? `Chưa có tài liệu cho Figma bản ${candidateVersion ?? ''}`.trim()
          : `Cần cập nhật cho Figma bản ${candidateVersion ?? ''}`.trim()}
    </span>
  );
}

function FigmaUpdateModal({
  title,
  currentVersion,
  onClose,
  onSubmit,
}: {
  title: string;
  currentVersion: number;
  onClose: () => void;
  onSubmit: (
    files: File[],
    deleteOldSource: boolean,
  ) => ReturnType<typeof uploadDesignSystemFigmaUpdate>;
}) {
  const titleId = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [deleteOldSource, setDeleteOldSource] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (files.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(files, deleteOldSource);
    setSubmitting(false);
    if (result.ok) onClose();
    else setError(result.error.message);
  }

  return (
    <ModalShell titleId={titleId} onClose={onClose}>
      <header className={styles.modalHead}>
        <div>
          <h2 id={titleId}>Cập nhật từ file Figma</h2>
          <p>{`${title} đang dùng bản ${currentVersion}. ZIP mới sẽ tạo bản ${currentVersion + 1} để bạn kiểm tra trước khi duyệt.`}</p>
        </div>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Đóng">
          <Icon name="close" />
        </button>
      </header>
      <div className={styles.modalBody}>
        <label className={styles.fileDrop}>
          <Icon name="upload" size={22} />
          <strong>Chọn file ZIP Figma mới</strong>
          <span>Có thể chọn nhiều file. Thứ tự file được giữ khi cập nhật.</span>
          <input
            type="file"
            accept=".zip,application/zip"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </label>
        {files.length > 0 ? (
          <ul className={styles.fileList} aria-label="File ZIP đã chọn">
            {files.map((file) => <li key={`${file.name}:${file.size}`}>{file.name}</li>)}
          </ul>
        ) : null}

        <label className={styles.deleteOption}>
          <input
            type="checkbox"
            checked={deleteOldSource}
            onChange={(event) => setDeleteOldSource(event.target.checked)}
          />
          <span>
            <strong>Xóa source Figma cũ sau khi duyệt</strong>
            <small>Chỉ xóa dữ liệu nguồn cũ. Lịch sử ứng dụng, Feature và kết quả đã chạy vẫn được giữ.</small>
          </span>
        </label>

        <div className={styles.alertBox}>
          <Icon name="info" />
          <p>
            Danh mục component và quy tắc thiết kế cũ không bị xóa. Sau khi cập nhật, chúng được đánh dấu cần cập nhật để bạn tự sinh, xem và duyệt lại.
          </p>
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
      <footer className={styles.modalFoot}>
        <button type="button" className={styles.secondaryButton} onClick={onClose}>Hủy</button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={files.length === 0 || submitting}
          onClick={() => void submit()}
        >
          {submitting ? 'Đang kiểm tra file...' : 'Tạo bản cập nhật'}
        </button>
      </footer>
    </ModalShell>
  );
}

function FinalApprovalModal({
  version,
  stale,
  drafts,
  deleteOldSource,
  onClose,
  onApprove,
}: {
  version: number;
  stale: DesignSystemCriteriaKind[];
  drafts: DesignSystemCriteriaKind[];
  deleteOldSource: boolean;
  onClose: () => void;
  onApprove: (confirmStale: boolean) => ReturnType<typeof approveDesignSystemFigmaUpdate>;
}) {
  const titleId = useId();
  const hasStale = stale.length > 0;
  const hasDrafts = drafts.length > 0;
  const [confirmed, setConfirmed] = useState(!hasStale);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    if (submitting || hasDrafts || (hasStale && !confirmed)) return;
    setSubmitting(true);
    setError(null);
    const result = await onApprove(hasStale);
    setSubmitting(false);
    if (result.ok) onClose();
    else setError(result.error.message);
  }

  return (
    <ModalShell titleId={titleId} onClose={onClose}>
      <header className={styles.modalHead}>
        <div>
          <h2 id={titleId}>{`Xác nhận duyệt Design System bản ${version}`}</h2>
          <p>Chỉ sau bước này ứng dụng mới nhận được phiên bản ngữ cảnh mới.</p>
        </div>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Đóng">
          <Icon name="close" />
        </button>
      </header>
      <div className={styles.modalBody}>
        {hasDrafts ? (
          <div className={styles.staleWarning} role="alert">
            <Icon name="help-circle" />
            <div>
              <strong>Còn bản nháp chưa xử lý</strong>
              <p>{drafts.map((kind) => KIND_LABELS[kind]).join(', ')} cần được duyệt hoặc bỏ bản nháp trước.</p>
            </div>
          </div>
        ) : hasStale ? (
          <div className={styles.staleWarning} role="alert">
            <Icon name="help-circle" />
            <div>
              <strong>Vẫn còn tài liệu cũ</strong>
              <p>{stale.map((kind) => KIND_LABELS[kind]).join(', ')} chưa được duyệt lại theo bộ Figma mới.</p>
            </div>
          </div>
        ) : (
          <div className={styles.readyNotice}>
            <Icon name="check" />
            <p>Hai tài liệu đã được xem và duyệt cho bộ Figma mới.</p>
          </div>
        )}

        {hasStale && !hasDrafts ? (
          <label className={styles.confirmOption}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>Tôi hiểu các tài liệu trên vẫn là bản cũ và muốn tiếp tục duyệt.</span>
          </label>
        ) : null}
        {deleteOldSource ? (
          <p className={styles.deleteReminder}>Source Figma cũ sẽ được xóa sau khi bản mới được duyệt thành công.</p>
        ) : null}
        <p className={styles.featureReminder}>Các Feature đang làm vẫn giữ phiên bản hiện tại. Người dùng sẽ tự chọn nâng cấp sau khi xem thay đổi.</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
      <footer className={styles.modalFoot}>
        <button type="button" className={styles.secondaryButton} onClick={onClose}>Quay lại</button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={submitting || hasDrafts || (hasStale && !confirmed)}
          onClick={() => void approve()}
        >
          {submitting ? 'Đang duyệt...' : `Duyệt bản ${version}`}
        </button>
      </footer>
    </ModalShell>
  );
}

function ModalShell({ titleId, onClose, children }: { titleId: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {children}
      </div>
    </div>
  );
}

function DraftComparison({ item }: { item: DesignSystemCriteriaUpdateState }) {
  const approved = item.approvedContent?.trim() || 'Chưa có nội dung đang dùng.';
  const draft = item.draftContent?.trim() || 'Bản nháp chưa có nội dung để xem.';
  const changeSummary = useMemo(() => summarizeLineChanges(approved, draft), [approved, draft]);
  return (
    <div>
      <p className={styles.diffSummary}>{changeSummary}</p>
      <div className={styles.diffGrid}>
        <section>
          <strong>Bản đang dùng</strong>
          <pre>{approved}</pre>
        </section>
        <section>
          <strong>Bản mới</strong>
          <pre>{draft}</pre>
        </section>
      </div>
    </div>
  );
}

export function summarizeLineChanges(approved: string, draft: string): string {
  const previous = new Set(approved.split(/\r?\n/u));
  const next = new Set(draft.split(/\r?\n/u));
  const added = [...next].filter((line) => !previous.has(line)).length;
  const removed = [...previous].filter((line) => !next.has(line)).length;
  if (added === 0 && removed === 0) return 'Nội dung không thay đổi.';
  return `${added} dòng mới, ${removed} dòng không còn trong bản mới.`;
}

function ContextUpdatesNotice({ updates }: { updates: DesignSystemContextUpdate[] }) {
  return (
    <section className={styles.contextNotice} aria-label="Ứng dụng có phiên bản ngữ cảnh mới">
      <Icon name="check" />
      <div>
        <strong>{`${updates.length} ứng dụng có phiên bản ngữ cảnh mới`}</strong>
        <p>Feature không tự đổi phiên bản. Hãy xem thay đổi trước khi nâng từng Feature.</p>
        <ul>
          {updates.map((item) => (
            <li key={item.appId}>
              {item.appId}{item.contextVersion ? `: bản ${item.contextVersion}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function criteriaStatusLabel(status: DesignSystemCriteriaUpdateState['status']): string {
  if (status === 'missing') return 'Chưa có tài liệu';
  if (status === 'stale') return 'Cần cập nhật';
  if (status === 'draft') return 'Bản mới chờ duyệt';
  return 'Đã duyệt';
}

function criteriaVersionCopy(item: DesignSystemCriteriaUpdateState, candidateVersion?: number | null): string {
  if (item.status === 'draft') return `Bản sinh cho Figma bản ${candidateVersion ?? ''} đang chờ bạn duyệt.`;
  if (item.status === 'stale') {
    return `Đang dùng tài liệu từ Figma bản ${item.generatedFromVersion ?? 'trước'}. Cần sinh lại cho bản ${candidateVersion ?? ''}.`;
  }
  if (item.status === 'missing') return `Chưa có tài liệu. Cần sinh cho Figma bản ${candidateVersion ?? ''}.`;
  return `Đã duyệt theo Figma bản ${item.generatedFromVersion ?? candidateVersion ?? ''}.`;
}
