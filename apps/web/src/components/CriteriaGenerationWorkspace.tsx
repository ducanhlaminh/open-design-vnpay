import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  CriteriaGenerationDocumentResponse,
  CriteriaGenerationJobStatus,
  CriteriaGenerationKind,
} from '@open-design/contracts';
import {
  fetchCriteriaGenerationDocument,
  startCriteriaGeneration,
} from '../providers/design-system-criteria';
import { approveDesignSystemCriteriaDraft } from '../providers/design-system-figma-update';
import { listConversations, listMessages } from '../state/projects';
import { ChatPane } from './ChatPane';
import { DesignSpecView } from './DesignSpecView';
import { Icon } from './Icon';
import styles from './CriteriaGenerationWorkspace.module.css';

const KIND_COPY: Record<CriteriaGenerationKind, { title: string; short: string }> = {
  components: {
    title: 'Sinh lại danh mục thành phần',
    short: 'Danh mục thành phần',
  },
  rules: {
    title: 'Sinh lại nguyên tắc thiết kế',
    short: 'Nguyên tắc thiết kế',
  },
};

interface Props {
  designSystemId: string;
  kind: CriteriaGenerationKind;
  onBack: () => void;
  onOpenConversation: (projectId: string, conversationId: string) => void;
}

function isActive(status: CriteriaGenerationJobStatus | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export function CriteriaGenerationWorkspace({
  designSystemId,
  kind,
  onBack,
  onOpenConversation,
}: Props) {
  const copy = KIND_COPY[kind];
  const [document, setDocument] = useState<CriteriaGenerationDocumentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'idle' | 'starting' | 'approving' | 'stopping'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'current' | 'draft'>('draft');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<Awaited<ReturnType<typeof listConversations>>>([]);
  const [previewOpen, setPreviewOpen] = useState(true);
  const autoStartKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchCriteriaGenerationDocument(designSystemId, kind, signal);
    if (!result.ok) {
      if (!signal?.aborted) setError(result.error);
      setLoading(false);
      return null;
    }
    setDocument(result.value);
    setError(null);
    setLoading(false);
    if (!result.value.draft && result.value.current) setView('current');
    return result.value;
  }, [designSystemId, kind]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDocument(null);
    setMessages([]);
    setConversations([]);
    setView('draft');
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const jobActive = isActive(document?.job?.status);
  useEffect(() => {
    if (loading || document?.job || action !== 'idle') return;
    const key = `${designSystemId}:${kind}`;
    if (autoStartKeyRef.current === key) return;
    autoStartKeyRef.current = key;
    void runGeneration();
  }, [action, designSystemId, document?.job, kind, loading]);
  useEffect(() => {
    if (!jobActive) return undefined;
    const timer = window.setTimeout(() => { void refresh(); }, 2_000);
    return () => window.clearTimeout(timer);
  }, [document?.job?.updatedAt, jobActive, refresh]);

  const workspace = document?.job?.workspace;
  const refreshChat = useCallback(async () => {
    if (!workspace?.projectId || !workspace.conversationId) return;
    const [nextMessages, nextConversations] = await Promise.all([
      listMessages(workspace.projectId, workspace.conversationId),
      listConversations(workspace.projectId),
    ]);
    setMessages(nextMessages);
    setConversations(nextConversations);
  }, [workspace?.conversationId, workspace?.projectId]);

  useEffect(() => {
    void refreshChat();
    if (!jobActive) return undefined;
    const timer = window.setInterval(() => { void refreshChat(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [jobActive, refreshChat]);

  async function runGeneration() {
    if (action !== 'idle' || jobActive) return;
    setAction('starting');
    setError(null);
    const result = await startCriteriaGeneration(designSystemId, kind);
    if (!result.ok) {
      setError(result.error);
      setAction('idle');
      return;
    }
    setDocument((current) => current
      ? { ...current, job: result.value.job }
      : { kind, current: null, draft: null, job: result.value.job });
    setAction('idle');
  }

  async function approveDraft() {
    if (!document?.draft || action !== 'idle') return;
    setAction('approving');
    setError(null);
    const result = await approveDesignSystemCriteriaDraft(designSystemId, kind);
    if (!result.ok) {
      setError(result.error.message);
      setAction('idle');
      return;
    }
    await refresh();
    setAction('idle');
    onBack();
  }

  async function stopGeneration() {
    const runId = document?.job?.workspace.runId;
    if (!runId || !jobActive || action !== 'idle') return;
    setAction('stopping');
    setError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error('Không thể dừng tác vụ lúc này.');
      await refresh();
      await refreshChat();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Không thể dừng tác vụ lúc này.');
    } finally {
      setAction('idle');
    }
  }

  const selected = view === 'draft' ? document?.draft : document?.current;
  const job = document?.job;
  const canRetry = !job || job.status === 'failed' || job.status === 'succeeded';
  const visibleError = error ?? (job?.status === 'failed' ? job.error : null);

  return (
    <main className={styles.workspace} aria-label={`Workspace ${copy.short}`}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <button type="button" className={styles.iconButton} onClick={onBack} aria-label="Quay lại Danh mục review">
            <Icon name="arrow-left" size={17} />
          </button>
          <div>
            <span>Design System · Workspace riêng</span>
            <h1>{copy.title}</h1>
          </div>
          {job ? <JobStatus status={job.status} /> : null}
        </div>
        <div className={styles.actions}>
          {document?.draft ? (
            <button type="button" className={styles.secondaryButton} onClick={() => { setView('draft'); setPreviewOpen(true); }}>
              <Icon name="eye" />
              Xem bản nháp
            </button>
          ) : null}
          {jobActive ? (
            <button type="button" className={styles.stopButton} onClick={() => void stopGeneration()} disabled={action !== 'idle'}>
              <Icon name={action === 'stopping' ? 'spinner' : 'stop'} />
              {action === 'stopping' ? 'Đang dừng…' : 'Dừng tác vụ'}
            </button>
          ) : null}
          <button type="button" className={styles.secondaryButton} onClick={() => { void refresh(); void refreshChat(); }} disabled={loading}>
            <Icon name={loading ? 'spinner' : 'refresh'} />
            Tải lại
          </button>
          {document?.draft ? (
            <button type="button" className={styles.primaryButton} onClick={() => void approveDraft()} disabled={action !== 'idle'}>
              <Icon name={action === 'approving' ? 'spinner' : 'check'} />
              {action === 'approving' ? 'Đang duyệt…' : 'Duyệt dùng cho Design System'}
            </button>
          ) : null}
          {canRetry && !document?.draft ? (
            <button type="button" className={styles.primaryButton} onClick={() => void runGeneration()} disabled={action !== 'idle'}>
              <Icon name={action === 'starting' ? 'spinner' : 'sparkles'} />
              {job?.status === 'failed' ? 'Thử lại' : 'Sinh tài liệu'}
            </button>
          ) : null}
        </div>
      </header>

      {visibleError ? (
        <div className={styles.error} role="alert">
          <Icon name="help-circle" />
          <span>{visibleError}</span>
        </div>
      ) : null}

      <div className={styles.body}>
        <aside className={styles.progressPane}>
          <section className={styles.progressSection}>
            <div className={styles.sectionHeading}>
              <div>
                <span>Tiến độ</span>
                <strong>{job?.message || (loading ? 'Đang đọc trạng thái…' : 'Chưa bắt đầu')}</strong>
              </div>
              {job?.updatedAt ? <time>{new Date(job.updatedAt).toLocaleTimeString('vi-VN')}</time> : null}
            </div>
            <ol className={styles.steps}>
              {(job?.steps ?? []).map((step, index) => (
                <li key={step.id} data-status={step.status}>
                  <span>{step.status === 'succeeded' ? <Icon name="check" /> : step.status === 'running' ? <Icon name="spinner" /> : index + 1}</span>
                  <div><strong>{step.title}</strong>{step.message ? <small>{step.message}</small> : null}</div>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.conversationSection} aria-label="Hội thoại sinh tài liệu">
            <ChatPane
              messages={messages}
              streaming={jobActive}
              error={visibleError}
              projectId={workspace?.projectId ?? null}
              projectFiles={[]}
              composerPlaceholder="Tác vụ đang tự chạy; bạn có thể dừng khi cần."
              sendDisabled
              onEnsureProject={async () => workspace?.projectId ?? null}
              onSend={() => {}}
              onStop={() => void stopGeneration()}
              conversations={conversations}
              activeConversationId={workspace?.conversationId ?? null}
              onSelectConversation={(conversationId) => {
                if (workspace?.projectId) onOpenConversation(workspace.projectId, conversationId);
              }}
              onDeleteConversation={() => {}}
              onNewConversation={() => {}}
              newConversationDisabled
            />
          </section>
        </aside>

        <section className={styles.previewPane}>
          <div className={styles.previewHeader}>
            <div>
              <span>Nội dung tài liệu</span>
              <strong>{view === 'draft' ? 'Bản mới đang chờ bạn duyệt' : 'Bản Design System đang dùng'}</strong>
            </div>
            <div className={styles.versionSwitch} role="group" aria-label="Chọn phiên bản tài liệu">
              <button type="button" aria-pressed={view === 'current'} disabled={!document?.current} onClick={() => { setView('current'); setPreviewOpen(true); }}>Bản đang dùng</button>
              <button type="button" aria-pressed={view === 'draft'} disabled={!document?.draft} onClick={() => { setView('draft'); setPreviewOpen(true); }}>Bản nháp</button>
            </div>
          </div>
          {previewOpen ? (
            <div className={styles.documentPreview}>
              <DesignSpecView
                source={selected?.content ?? null}
                loading={loading}
                loadingLabel={loading ? 'Đang tải nội dung…' : 'Chưa có nội dung để xem.'}
              />
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function JobStatus({ status }: { status: NonNullable<CriteriaGenerationDocumentResponse['job']>['status'] }) {
  const label = status === 'running'
    ? 'Đang sinh'
    : status === 'queued'
      ? 'Đang chuẩn bị'
      : status === 'succeeded'
        ? 'Đã sinh xong'
        : 'Cần thử lại';
  return <span className={styles.status} data-status={status}>{label}</span>;
}
