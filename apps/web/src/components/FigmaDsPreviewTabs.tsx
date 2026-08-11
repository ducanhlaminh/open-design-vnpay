import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CriteriaGenerationKind } from '@open-design/contracts';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { Icon } from './Icon';
import './FigmaDsPreviewTabs.module.css';

export type FigmaDsPreviewTab = 'showcase' | 'components' | 'rules';
export type CriteriaDocumentKind = CriteriaGenerationKind;
export type CriteriaDocumentView = 'current' | 'draft';

export interface CriteriaDocumentVersion {
  content: string;
  updatedAt?: string;
  count?: number;
  status?: 'current' | 'stale' | 'draft';
}

export interface CriteriaDocumentSnapshot {
  kind: CriteriaDocumentKind;
  current: CriteriaDocumentVersion | null;
  draft: CriteriaDocumentVersion | null;
}

export type CriteriaDocumentLoader = (
  systemId: string,
  kind: CriteriaDocumentKind,
  options: { signal: AbortSignal; cache: 'no-store' },
) => Promise<CriteriaDocumentSnapshot>;

export interface FigmaDsPreviewViewState {
  tab: FigmaDsPreviewTab;
  documentView: Record<CriteriaDocumentKind, CriteriaDocumentView>;
}

interface DocSpec {
  id: CriteriaDocumentKind;
  label: string;
  missingTitle: string;
  missingHint: string;
  generationLabel: string;
}

const DOCS: DocSpec[] = [
  {
    id: 'components',
    label: 'Thành phần',
    missingTitle: 'Chưa có danh mục thành phần',
    missingHint: 'Tạo danh mục để agent nhận biết đúng các thành phần trong bộ Design System này.',
    generationLabel: 'Mở workspace để sinh danh mục',
  },
  {
    id: 'rules',
    label: 'Nguyên tắc',
    missingTitle: 'Chưa có nguyên tắc thiết kế',
    missingHint: 'Tạo tài liệu nguyên tắc để agent review thiết kế theo đúng tiêu chuẩn của bộ này.',
    generationLabel: 'Mở workspace để sinh nguyên tắc',
  },
];

type DocState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: CriteriaDocumentSnapshot };

export interface FigmaDsPreviewTabsProps {
  systemId: string;
  initialTab?: FigmaDsPreviewTab;
  initialDocumentView?: Partial<Record<CriteriaDocumentKind, CriteriaDocumentView>>;
  className?: string;
  loadCriteriaDocument?: CriteriaDocumentLoader;
  onGenerate?: (kind: CriteriaDocumentKind) => void | Promise<void>;
  onReload?: () => void | Promise<void>;
  onViewStateChange?: (state: FigmaDsPreviewViewState) => void;
}

/**
 * Read-only preview shared by the Design System review modal and the compact
 * editor preview. Generation and navigation are intentionally callbacks so
 * this surface never needs to know about application routes.
 */
export function FigmaDsPreviewTabs({
  systemId,
  initialTab = 'showcase',
  initialDocumentView,
  className,
  loadCriteriaDocument = loadCriteriaDocumentFromApi,
  onGenerate,
  onReload,
  onViewStateChange,
}: FigmaDsPreviewTabsProps) {
  const [tab, setTab] = useState<FigmaDsPreviewTab>(initialTab);
  const [documentView, setDocumentView] = useState<Record<CriteriaDocumentKind, CriteriaDocumentView>>({
    components: initialDocumentView?.components ?? 'current',
    rules: initialDocumentView?.rules ?? 'current',
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [reloadPending, setReloadPending] = useState(false);
  const [docs, setDocs] = useState<Record<CriteriaDocumentKind, DocState>>({
    components: { status: 'loading' },
    rules: { status: 'loading' },
  });

  const loadDoc = useCallback(
    async (spec: DocSpec, signal: AbortSignal) => {
      setDocs((previous) => ({ ...previous, [spec.id]: { status: 'loading' } }));
      try {
        const snapshot = await loadCriteriaDocument(systemId, spec.id, { signal, cache: 'no-store' });
        if (signal.aborted) return;
        setDocs((previous) => ({ ...previous, [spec.id]: { status: 'ready', snapshot } }));
      } catch (error) {
        if (signal.aborted) return;
        setDocs((previous) => ({
          ...previous,
          [spec.id]: {
            status: 'error',
            message: error instanceof Error ? error.message : 'Không thể đọc nội dung lúc này.',
          },
        }));
      }
    },
    [loadCriteriaDocument, systemId],
  );

  useEffect(() => {
    const controller = new AbortController();
    for (const spec of DOCS) void loadDoc(spec, controller.signal);
    return () => controller.abort();
  }, [loadDoc, reloadToken]);

  useEffect(() => {
    onViewStateChange?.({ tab, documentView });
  }, [documentView, onViewStateChange, tab]);

  const reloading = reloadPending || DOCS.some((spec) => docs[spec.id].status === 'loading');
  const showcaseSrc = useMemo(
    () => `/api/design-systems/${encodeURIComponent(systemId)}/showcase?r=${reloadToken}`,
    [reloadToken, systemId],
  );

  const reloadAll = async () => {
    if (reloadPending) return;
    setReloadPending(true);
    try {
      await onReload?.();
    } catch {
      // The no-cache document reload below remains the source of truth and
      // will surface its own readable error state if the service is down.
    } finally {
      setReloadToken((value) => value + 1);
      setReloadPending(false);
    }
  };

  return (
    <div className={`figma-ds-preview ${className ?? ''}`.trim()}>
      <div className="figma-ds-preview__bar">
        <div className="figma-ds-preview__tabs" role="tablist" aria-label="Nội dung Design System">
          <button type="button" role="tab" aria-selected={tab === 'showcase'} className={`figma-ds-preview__tab ${tab === 'showcase' ? 'active' : ''}`} onClick={() => setTab('showcase')}>
            Showcase
          </button>
          {DOCS.map((spec) => (
            <button key={spec.id} type="button" role="tab" aria-selected={tab === spec.id} className={`figma-ds-preview__tab ${tab === spec.id ? 'active' : ''}`} onClick={() => setTab(spec.id)}>
              {spec.label}
            </button>
          ))}
        </div>
        <button type="button" className="figma-ds-preview__reload" onClick={() => void reloadAll()} disabled={reloading} title="Nạp nội dung mới nhất">
          <Icon name={reloading ? 'spinner' : 'refresh'} size={14} />
          {reloading ? 'Đang tải…' : 'Tải lại'}
        </button>
      </div>

      <div className="figma-ds-preview__stage">
        {tab === 'showcase' ? (
          <iframe key={showcaseSrc} className="figma-ds-showcase-frame" title="Showcase Design System" src={showcaseSrc} />
        ) : null}
        {DOCS.map((spec) => tab === spec.id ? (
          <DocPane
            key={spec.id}
            spec={spec}
            state={docs[spec.id]}
            view={documentView[spec.id]}
            onViewChange={(view) => setDocumentView((previous) => ({ ...previous, [spec.id]: view }))}
            onGenerate={onGenerate ? () => onGenerate(spec.id) : undefined}
          />
        ) : null)}
      </div>
    </div>
  );
}

function DocPane({
  spec,
  state,
  view,
  onViewChange,
  onGenerate,
}: {
  spec: DocSpec;
  state: DocState;
  view: CriteriaDocumentView;
  onViewChange: (view: CriteriaDocumentView) => void;
  onGenerate?: () => void | Promise<void>;
}) {
  if (state.status === 'loading') {
    return <div className="figma-ds-preview__empty">Đang tải {spec.label.toLowerCase()}…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="figma-ds-preview__empty is-error">
        <strong>Chưa tải được {spec.label.toLowerCase()}</strong>
        <p>{state.message}</p>
      </div>
    );
  }

  const { current, draft } = state.snapshot;
  const selectedView: CriteriaDocumentView = view === 'draft' && draft ? 'draft' : view;
  const selected = selectedView === 'draft' ? draft : current;

  return (
    <section className="figma-ds-preview__document-stage" aria-label={spec.label}>
      <div className="figma-ds-preview__document-toolbar">
        <div>
          <strong>{spec.label}</strong>
          <span>{selectedView === 'draft' ? 'Bản mới đang chờ bạn duyệt' : 'Bản Design System đang dùng'}</span>
        </div>
        {draft ? (
          <div className="figma-ds-preview__version-switch" role="group" aria-label={`Chọn bản ${spec.label.toLowerCase()}`}>
            <button type="button" aria-pressed={selectedView === 'current'} className={selectedView === 'current' ? 'active' : ''} onClick={() => onViewChange('current')}>Bản đang dùng</button>
            <button type="button" aria-pressed={selectedView === 'draft'} className={selectedView === 'draft' ? 'active' : ''} onClick={() => onViewChange('draft')}>Bản nháp</button>
          </div>
        ) : null}
      </div>

      {selected ? (
        <div className="figma-ds-preview__doc">
          <div className="figma-ds-preview__doc-meta">
            {selected.status === 'stale' ? 'Cần cập nhật cho bản Figma hiện tại' : selectedView === 'draft' ? 'Chưa được áp dụng cho Design System' : 'Đang được dùng cho Design System'}
            {selected.updatedAt ? ` · cập nhật ${new Date(selected.updatedAt).toLocaleString('vi-VN')}` : ''}
          </div>
          <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(selected.content) }} />
        </div>
      ) : (
        <div className="figma-ds-preview__empty">
          <span className="figma-ds-preview__empty-icon" aria-hidden><Icon name="file" size={22} /></span>
          <strong>{selectedView === 'draft' ? 'Chưa có bản nháp' : spec.missingTitle}</strong>
          <p>{selectedView === 'draft' ? 'Hãy sinh một bản mới trước khi duyệt và áp dụng.' : spec.missingHint}</p>
          {onGenerate ? <button type="button" className="figma-ds-preview__generate" onClick={() => void onGenerate()}><Icon name="sparkles" size={15} />{spec.generationLabel}</button> : null}
        </div>
      )}
    </section>
  );
}

/** Default adapter for the versioned criteria endpoint, with a legacy read
 * fallback while older daemons are still in use. */
export const loadCriteriaDocumentFromApi: CriteriaDocumentLoader = async (systemId, kind, options) => {
  const endpoint = `/api/design-systems/${encodeURIComponent(systemId)}/criteria/${kind}`;
  const response = await fetch(endpoint, options);
  if (response.ok) {
    const payload = (await response.json()) as Partial<CriteriaDocumentSnapshot>;
    return {
      kind,
      current: normalizeVersion(payload.current),
      draft: normalizeVersion(payload.draft),
    };
  }
  if (response.status !== 404) throw new Error('Không thể đọc nội dung mới nhất. Hãy thử tải lại.');

  const path = kind === 'components' ? 'criteria/components.md' : 'criteria/rules.md';
  const legacy = await fetch(`/api/design-systems/${encodeURIComponent(systemId)}/file?path=${encodeURIComponent(path)}`, options);
  if (legacy.status === 404) return { kind, current: null, draft: null };
  if (!legacy.ok) throw new Error('Không thể đọc nội dung mới nhất. Hãy thử tải lại.');
  const json = (await legacy.json()) as { file?: { content?: unknown; updatedAt?: unknown } };
  const content = typeof json.file?.content === 'string' ? json.file.content : '';
  return {
    kind,
    current: content.trim() ? { content, status: 'current', ...(typeof json.file?.updatedAt === 'string' ? { updatedAt: json.file.updatedAt } : {}) } : null,
    draft: null,
  };
};

function normalizeVersion(value: unknown): CriteriaDocumentVersion | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.content !== 'string' || !candidate.content.trim()) return null;
  const status = candidate.status === 'current' || candidate.status === 'stale' || candidate.status === 'draft' ? candidate.status : undefined;
  return {
    content: candidate.content,
    ...(typeof candidate.updatedAt === 'string' ? { updatedAt: candidate.updatedAt } : {}),
    ...(typeof candidate.count === 'number' ? { count: candidate.count } : {}),
    ...(status ? { status } : {}),
  };
}
