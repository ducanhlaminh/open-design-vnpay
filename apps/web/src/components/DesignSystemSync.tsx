import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  DesignSystemFileChange,
  DesignSystemSyncStatus,
  DesignSystemSyncVersion,
  PullDesignSystemPlan,
  RemoteDesignSystemSummary,
} from '@open-design/contracts';
import type { DesignSystemSummary } from '../types';
import {
  fetchDesignSystemSyncStatus,
  listRemoteDesignSystems,
  planPullDesignSystem,
  publishDesignSystem,
  pullDesignSystem,
} from '../providers/design-system-sync';
import { Icon } from './Icon';
import styles from './DesignSystemSync.module.css';

type ModalKind = 'share' | 'pull';
type SyncableSystem = Pick<DesignSystemSummary, 'id' | 'title' | 'hasReactBundle' | 'source' | 'isEditable'>;

const BLOCK_COPY: Record<NonNullable<DesignSystemSyncStatus['blockReason']>, string> = {
  update_in_progress: 'Bộ Figma đang có một bản cập nhật chưa duyệt xong.',
  criteria_draft: 'Danh mục component hoặc quy tắc thiết kế vẫn đang là bản nháp.',
  criteria_stale: 'Danh mục component hoặc quy tắc thiết kế cần được cập nhật cho bản Figma hiện tại.',
  not_approved: 'Bộ Design System chưa được duyệt để sử dụng.',
};

const OPERATION_COPY: Record<DesignSystemFileChange['operation'], string> = {
  add: 'Thêm',
  edit: 'Cập nhật',
  delete: 'Xóa',
};

function localFigmaSystems(systems: DesignSystemSummary[]): DesignSystemSummary[] {
  return systems.filter((system) => system.hasReactBundle && (system.source === 'user' || system.isEditable));
}

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

function ownerLabel(remote: RemoteDesignSystemSummary): string {
  return remote.owner.name?.trim() || remote.owner.email?.trim() || 'Thành viên trong nhóm';
}

function changeCounts(changes: DesignSystemFileChange[]) {
  return changes.reduce(
    (counts, item) => ({ ...counts, [item.operation]: counts[item.operation] + 1 }),
    { add: 0, edit: 0, delete: 0 },
  );
}

export function DesignSystemSyncActions({
  systems,
  onSystemsRefresh,
}: {
  systems: DesignSystemSummary[];
  onSystemsRefresh?: () => Promise<void> | void;
}) {
  const [modal, setModal] = useState<ModalKind | null>(null);
  const figmaSystems = useMemo(() => localFigmaSystems(systems), [systems]);

  return (
    <>
      <section className={styles.launcher} aria-label="Kho Design System chung">
        <div className={styles.launcherCopy}>
          <span className={styles.eyebrow}>Kho dùng chung</span>
          <strong>Chia sẻ Design System với nhóm</strong>
          <p>Đưa bộ Figma đã duyệt lên kho chung hoặc lấy một bộ đã chia sẻ về máy.</p>
        </div>
        <div className={styles.launcherActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => setModal('pull')}>
            <Icon name="download" />
            Lấy bộ Design System về máy
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => setModal('share')}
            disabled={figmaSystems.length === 0}
            title={figmaSystems.length === 0 ? 'Chưa có bộ Design System Figma nào trên máy.' : undefined}
          >
            <Icon name="share" />
            Chia sẻ bộ Design System
          </button>
        </div>
      </section>

      {modal === 'share' ? (
        <ShareDesignSystemModal systems={figmaSystems} onClose={() => setModal(null)} />
      ) : null}
      {modal === 'pull' ? (
        <PullDesignSystemModal
          onClose={() => setModal(null)}
          onInstalled={onSystemsRefresh}
        />
      ) : null}
    </>
  );
}

export function DesignSystemShareButton({
  system,
}: {
  system: SyncableSystem;
}) {
  const [open, setOpen] = useState(false);
  const available = Boolean(system.hasReactBundle && (system.source === 'user' || system.isEditable));
  if (!available) return null;
  return (
    <>
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        <Icon name="share" />
        Chia sẻ bộ Design System
      </button>
      {open ? (
        <ShareDesignSystemModal systems={[system]} initialId={system.id} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

export function ShareDesignSystemModal({
  systems,
  initialId,
  onClose,
}: {
  systems: SyncableSystem[];
  initialId?: string;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(initialId ?? systems[0]?.id ?? '');
  const [status, setStatus] = useState<DesignSystemSyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const selected = systems.find((system) => system.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoading(true);
    setStatus(null);
    setError(null);
    setSuccess(null);
    void fetchDesignSystemSyncStatus(selectedId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setStatus(result.value);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function submit() {
    if (!status?.canPush || busy) return;
    setBusy(true);
    setError(null);
    const result = await publishDesignSystem(selectedId, {
      expectedRemoteDigest: status.remote?.currentDigest ?? null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.value.status === 'published') {
      setSuccess(`Đã chia sẻ ${result.value.summary.name} ${result.value.summary.currentVersion} lên kho chung.`);
      return;
    }
    if (result.value.status === 'unchanged') {
      setSuccess('Bản trên kho chung đã giống bản trên máy. Không có tệp nào cần gửi thêm.');
      return;
    }
    if (result.value.status === 'blocked' || result.value.status === 'auth_required' || result.value.status === 'error') {
      setError(result.value.message);
      return;
    }
    setError('Bản trên kho chung vừa được người khác cập nhật. Hãy đóng cửa sổ và mở lại để xem thay đổi mới nhất.');
  }

  return (
    <ModalShell
      title="Chia sẻ bộ Design System"
      description="Gửi bản Figma đã duyệt và các bản cũ vẫn đang được App hoặc Feature sử dụng lên kho chung."
      onClose={onClose}
    >
      <div className={styles.modalBody}>
        {systems.length > 1 ? (
          <label className={styles.field}>
            <span>Chọn bộ Design System</span>
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {systems.map((system) => <option key={system.id} value={system.id}>{system.title}</option>)}
            </select>
          </label>
        ) : null}

        {loading ? <SyncSkeleton label="Đang so sánh với bản trên kho chung…" /> : null}
        {error ? <InlineNotice tone="error" title="Chưa thể chia sẻ" body={error} /> : null}
        {success ? (
          <InlineNotice
            tone="success"
            title="Đã hoàn tất"
            body={`${success} App và Feature trên máy vẫn giữ nguyên phiên bản đang dùng.`}
          />
        ) : null}

        {!loading && status && selected ? (
          <>
            <section className={styles.summaryPanel}>
              <div className={styles.summaryIcon}><Icon name="blocks" size={20} /></div>
              <div>
                <strong>{selected.title}</strong>
                <span>
                  Phiên bản trên máy: v{status.localVersion}
                  {status.remote ? ` · Bản trên kho ${status.remote.currentVersion}` : ' · Chưa từng chia sẻ'}
                </span>
              </div>
              <span className={styles.destination}>Kho chung</span>
            </section>

            {status.canPush ? (
              <>
                <VersionSummary status={status} />
                <FileChanges changes={status.changes} empty="Bản trên kho chung đã giống bản trên máy." />
              </>
            ) : (
              <InlineNotice
                tone="warning"
                title="Bộ Design System chưa sẵn sàng để chia sẻ"
                body={status.blockReason ? BLOCK_COPY[status.blockReason] : 'Hãy hoàn tất và duyệt bộ Design System trước.'}
              />
            )}
          </>
        ) : null}
      </div>
      <footer className={styles.modalFoot}>
        <button type="button" className={styles.secondaryButton} onClick={onClose}>Đóng</button>
        {!success ? (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!status?.canPush || busy || loading}
            onClick={() => void submit()}
          >
            {busy ? <Icon name="spinner" /> : <Icon name="share" />}
            {busy ? 'Đang chia sẻ…' : 'Chia sẻ lên kho chung'}
          </button>
        ) : null}
      </footer>
    </ModalShell>
  );
}

export function PullDesignSystemModal({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled?: () => Promise<void> | void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<RemoteDesignSystemSummary[]>([]);
  const [selected, setSelected] = useState<RemoteDesignSystemSummary | null>(null);
  const [version, setVersion] = useState<DesignSystemSyncVersion | null>(null);
  const [plan, setPlan] = useState<PullDesignSystemPlan | null>(null);
  const [resolution, setResolution] = useState<'use_remote' | 'keep_local' | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoadingList(true);
      setError(null);
      void listRemoteDesignSystems(query).then((result) => {
        if (cancelled) return;
        setLoadingList(false);
        if (result.ok) setItems(result.value.items);
        else setError(result.error.message);
      });
    }, query ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    if (!selected || !version) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setLoadingPlan(true);
    setPlan(null);
    setResolution(null);
    setError(null);
    void planPullDesignSystem({ remoteDesignSystemId: selected.remoteDesignSystemId, version }).then((result) => {
      if (cancelled) return;
      setLoadingPlan(false);
      if (result.ok) setPlan(result.value);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, version]);

  function choose(remote: RemoteDesignSystemSummary) {
    setSelected(remote);
    setVersion(remote.currentVersion);
    setSuccess(null);
  }

  async function submit() {
    if (!selected || !version || !plan || busy || (plan.conflict && !resolution)) return;
    setBusy(true);
    setError(null);
    const result = await pullDesignSystem({
      remoteDesignSystemId: selected.remoteDesignSystemId,
      version,
      localDesignSystemId: plan.localDesignSystemId,
      expectedLocalDigest: plan.localDigest,
      ...(resolution ? { resolution } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.value.status === 'conflict') {
      setPlan(result.value.plan);
      setResolution(null);
      setError('Bản trên máy vừa thay đổi. Hãy chọn lại cách xử lý trước khi tiếp tục.');
      return;
    }
    if (result.value.status === 'auth_required' || result.value.status === 'error') {
      setError(result.value.message);
      return;
    }
    if (result.value.status === 'not_found') {
      setError('Bộ Design System này không còn trên kho chung.');
      return;
    }
    if (result.value.status === 'kept_local') {
      setSuccess('Đã giữ nguyên bộ Design System trên máy. Không có tệp nào bị thay đổi.');
      return;
    }
    setSuccess(
      result.value.status === 'unchanged'
        ? 'Bộ Design System trên máy đã là bản mới nhất.'
        : `Đã lấy ${selected.name} ${result.value.manifest.version} về máy.`,
    );
    await onInstalled?.();
  }

  return (
    <ModalShell
      title="Lấy bộ Design System về máy"
      description="Tìm bộ đã được nhóm chia sẻ, xem thay đổi rồi mới quyết định cập nhật trên máy."
      onClose={onClose}
      wide
    >
      <div className={styles.pullLayout}>
        <aside className={styles.remotePane}>
          <label className={styles.searchField}>
            <Icon name="search" size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm theo tên Design System…"
              autoFocus
            />
          </label>
          <div className={styles.remoteList} aria-label="Design System trên kho chung">
            {loadingList ? <SyncSkeleton label="Đang đọc kho chung…" /> : null}
            {!loadingList && error && !selected ? (
              <InlineNotice tone="error" title="Chưa mở được kho chung" body={error} />
            ) : null}
            {!loadingList && !error && items.length === 0 ? (
              <div className={styles.emptyState}>
                <Icon name="search" size={22} />
                <strong>Không tìm thấy bộ Design System</strong>
                <span>Thử tên khác hoặc kiểm tra lại kết nối kho chung.</span>
              </div>
            ) : null}
            {items.map((remote) => (
              <button
                type="button"
                key={remote.remoteDesignSystemId}
                className={`${styles.remoteRow}${selected?.remoteDesignSystemId === remote.remoteDesignSystemId ? ` ${styles.selected}` : ''}`}
                onClick={() => choose(remote)}
              >
                <span className={styles.remoteIcon}><Icon name="blocks" /></span>
                <span className={styles.remoteCopy}>
                  <strong>{remote.name}</strong>
                  <small>{ownerLabel(remote)} · cập nhật {formatDate(remote.updatedAt)}</small>
                </span>
                <span className={styles.versionBadge}>{remote.currentVersion}</span>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        </aside>

        <main className={styles.planPane}>
          {!selected ? (
            <div className={styles.emptyState}>
              <Icon name="blocks" size={26} />
              <strong>Chọn một bộ Design System</strong>
              <span>Thông tin phiên bản và các tệp thay đổi sẽ hiện ở đây.</span>
            </div>
          ) : (
            <>
              <div className={styles.planHead}>
                <div>
                  <span className={styles.eyebrow}>Bản muốn lấy</span>
                  <strong>{selected.name}</strong>
                  <small>{ownerLabel(selected)}</small>
                </div>
                <label className={styles.versionSelect}>
                  <span>Phiên bản</span>
                  <select value={version ?? ''} onChange={(event) => setVersion(event.target.value as DesignSystemSyncVersion)}>
                    {[...selected.versions].reverse().map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              </div>

              {loadingPlan ? <SyncSkeleton label="Đang so sánh với bản trên máy…" /> : null}
              {error ? <InlineNotice tone="error" title="Chưa thể tiếp tục" body={error} /> : null}
              {success ? (
                <InlineNotice
                  tone="success"
                  title="Đã hoàn tất"
                  body={`${success} Bộ này chưa được áp dụng tự động cho App hoặc Feature. Hãy chọn “Áp dụng cho App” khi bạn sẵn sàng.`}
                />
              ) : null}
              {!loadingPlan && plan && !success ? (
                <>
                  <InlineNotice
                    tone={plan.localExists ? 'info' : 'neutral'}
                    title={plan.localExists ? 'Máy đã có bộ Design System này' : 'Đây là bộ Design System mới trên máy'}
                    body={plan.localExists
                      ? 'Hãy xem các tệp khác nhau trước khi cập nhật.'
                      : 'Open Design sẽ tạo một bản local mới nhưng chưa gắn vào App hay Feature nào.'}
                  />
                  <FileChanges changes={plan.changes} empty="Phiên bản này đã giống bản trên máy." />
                  {plan.conflict ? (
                    <fieldset className={styles.conflictBox}>
                      <legend>Chọn cách xử lý bản đang có trên máy</legend>
                      <label>
                        <input
                          type="radio"
                          name="ds-pull-resolution"
                          checked={resolution === 'keep_local'}
                          onChange={() => setResolution('keep_local')}
                        />
                        <span><strong>Giữ bản trên máy</strong><small>Không thay đổi bất kỳ tệp nào.</small></span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="ds-pull-resolution"
                          checked={resolution === 'use_remote'}
                          onChange={() => setResolution('use_remote')}
                        />
                        <span><strong>Dùng bản từ kho chung</strong><small>Thay các tệp local bằng đúng phiên bản đã chọn.</small></span>
                      </label>
                    </fieldset>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </main>
      </div>
      <footer className={styles.modalFoot}>
        <button type="button" className={styles.secondaryButton} onClick={onClose}>Đóng</button>
        {selected && plan && !success ? (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || loadingPlan || (plan.conflict && !resolution)}
            onClick={() => void submit()}
          >
            {busy ? <Icon name="spinner" /> : <Icon name="download" />}
            {busy ? 'Đang lấy về máy…' : resolution === 'keep_local' ? 'Giữ bản trên máy' : plan.localExists ? 'Cập nhật trên máy' : 'Lấy về máy'}
          </button>
        ) : null}
      </footer>
    </ModalShell>
  );
}

function VersionSummary({ status }: { status: DesignSystemSyncStatus }) {
  return (
    <section className={styles.versionSummary}>
      <div>
        <span className={styles.eyebrow}>Bản sẽ chia sẻ</span>
        <strong>Phiên bản {status.localVersion}</strong>
        <p>Gồm tệp Figma, token và tài liệu đã được duyệt.</p>
      </div>
      <div>
        <span className={styles.eyebrow}>Bản cũ đang được dùng</span>
        <strong>{status.historicalVersions.length === 0 ? 'Không có' : status.historicalVersions.join(', ')}</strong>
        <p>{status.historicalVersions.length > 0 ? 'Các bản này được giữ để App và Feature cũ tiếp tục hoạt động.' : 'Không cần gửi thêm bản lịch sử.'}</p>
      </div>
    </section>
  );
}

function FileChanges({ changes, empty }: { changes: DesignSystemFileChange[]; empty: string }) {
  const counts = changeCounts(changes);
  const [expanded, setExpanded] = useState(false);
  const preview = changes.slice(0, 4);
  return (
    <section className={styles.changeSection}>
      <div className={styles.changeHead}>
        <div>
          <span className={styles.eyebrow}>Tóm tắt thay đổi</span>
          <strong>{changes.length > 0 ? `${changes.length} tệp sẽ được đồng bộ` : 'Không có thay đổi'}</strong>
        </div>
        <div className={styles.changeCounts}>
          {counts.add > 0 ? <span data-operation="add">{counts.add} thêm</span> : null}
          {counts.edit > 0 ? <span data-operation="edit">{counts.edit} cập nhật</span> : null}
          {counts.delete > 0 ? <span data-operation="delete">{counts.delete} xóa</span> : null}
        </div>
      </div>
      {changes.length === 0 ? <p className={styles.changeEmpty}>{empty}</p> : (
        <>
          <div className={styles.fileList} data-expanded={expanded}>
          {(expanded ? changes : preview).map((change) => (
            <div key={`${change.operation}:${change.path}`} className={styles.fileRow}>
              <span data-operation={change.operation}>{OPERATION_COPY[change.operation]}</span>
              <code>{change.path}</code>
            </div>
          ))}
          </div>
          {changes.length > preview.length ? (
            <button type="button" className={styles.expandChanges} data-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Thu gọn danh sách' : `Xem danh sách ${changes.length} tệp`}
              <Icon name="chevron-down" size={15} />
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function InlineNotice({
  tone,
  title,
  body,
}: {
  tone: 'neutral' | 'info' | 'warning' | 'error' | 'success';
  title: string;
  body: string;
}) {
  return (
    <div className={styles.notice} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'success' ? 'check' : tone === 'error' || tone === 'warning' ? 'info' : 'blocks'} />
      <div><strong>{title}</strong><p>{body}</p></div>
    </div>
  );
}

function SyncSkeleton({ label }: { label: string }) {
  return (
    <div className={styles.loading} role="status">
      <span aria-hidden />
      <div><i /><i /></div>
      <strong>{label}</strong>
    </div>
  );
}

function ModalShell({
  title,
  description,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const content = (
    <div className={styles.backdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`${styles.modal}${wide ? ` ${styles.wide}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className={styles.modalHead}>
          <div><span className={styles.eyebrow}>Design System Figma</span><h2>{title}</h2><p>{description}</p></div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Đóng">
            <Icon name="close" size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
  // The Design System list lives in a rounded, clipping card. Mounting the
  // dialog at document level keeps its backdrop and footer viewport-bound.
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
