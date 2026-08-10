import { useCallback, useEffect, useMemo, useState } from 'react';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { Icon } from './Icon';

// Preview 3 phần của một Design System nạp từ Figma (DS có react bundle):
//
//   Showcase    — trang compiled từ react/ source, serve tại
//                 /api/design-systems/:id/showcase
//   Thành phần  — criteria/components.md (danh mục component hợp lệ)
//   Nguyên tắc  — criteria/rules.md (quy tắc review, anchor `R-XXX`)
//
// Dùng CHUNG ở hai chỗ nên tab bar + nút tải lại nằm luôn trong component:
//   1. modal toàn màn hình mở từ hàng DS (FigmaDesignSystemDetailModal)
//   2. khung preview của màn Edit (DesignSystemFlow) — nơi agent sửa file qua
//      chat, nên nút "Tải lại" là bắt buộc: nó nạp lại CẢ ba tab, kể cả
//      iframe showcase (đổi cache-buster ⇒ iframe remount).
//
// Hai file .md do job bên daemon sinh ra (criteria/rules generate), có thể
// CHƯA tồn tại — route trả 404 và tab hiển thị empty state thay vì lỗi.

type TabId = 'showcase' | 'components' | 'rules';

interface DocSpec {
  id: Exclude<TabId, 'showcase'>;
  label: string;
  path: string;
  /** Hướng dẫn khi file chưa được sinh. */
  emptyTitle: string;
  emptyHint: string;
}

const DOCS: DocSpec[] = [
  {
    id: 'components',
    label: 'Thành phần',
    path: 'criteria/components.md',
    emptyTitle: 'Chưa có danh mục component',
    emptyHint:
      'File criteria/components.md chưa được sinh. Mở "Danh mục review" của design system này rồi bấm Sinh để tạo.',
  },
  {
    id: 'rules',
    label: 'Nguyên tắc',
    path: 'criteria/rules.md',
    emptyTitle: 'Chưa có quy tắc review',
    emptyHint:
      'File criteria/rules.md chưa được sinh. Mở "Danh mục review" của design system này rồi bấm Sinh để tạo.',
  },
];

type DocState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | { status: 'ready'; html: string; updatedAt?: string };

interface Props {
  systemId: string;
  /** Tab mở sẵn khi mount. */
  initialTab?: TabId;
  className?: string;
}

export function FigmaDsPreviewTabs({ systemId, initialTab = 'showcase', className }: Props) {
  const [tab, setTab] = useState<TabId>(initialTab);
  // Tăng mỗi lần bấm "Tải lại". Vừa là dependency của effect nạp .md, vừa là
  // cache-buster + key của iframe showcase.
  const [reloadToken, setReloadToken] = useState(0);
  const [docs, setDocs] = useState<Record<DocSpec['id'], DocState>>({
    components: { status: 'loading' },
    rules: { status: 'loading' },
  });

  const loadDoc = useCallback(
    async (spec: DocSpec, signal: AbortSignal) => {
      setDocs((prev) => ({ ...prev, [spec.id]: { status: 'loading' } }));
      try {
        const resp = await fetch(
          `/api/design-systems/${encodeURIComponent(systemId)}/file?path=${encodeURIComponent(spec.path)}`,
          { cache: 'no-store', signal },
        );
        if (signal.aborted) return;
        // 404 = file chưa sinh. Đây là trạng thái BÌNH THƯỜNG của một DS mới
        // nạp, không phải lỗi — hiển thị hướng dẫn thay vì báo đỏ.
        if (resp.status === 404) {
          setDocs((prev) => ({ ...prev, [spec.id]: { status: 'empty' } }));
          return;
        }
        if (!resp.ok) {
          setDocs((prev) => ({
            ...prev,
            [spec.id]: { status: 'error', message: `Không đọc được ${spec.path} (HTTP ${resp.status}).` },
          }));
          return;
        }
        const json = (await resp.json()) as {
          file?: { content?: string; updatedAt?: string };
          error?: string;
        };
        if (signal.aborted) return;
        const content = json.file?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          setDocs((prev) => ({ ...prev, [spec.id]: { status: 'empty' } }));
          return;
        }
        setDocs((prev) => ({
          ...prev,
          [spec.id]: {
            status: 'ready',
            html: renderMarkdownToSafeHtml(content),
            ...(json.file?.updatedAt ? { updatedAt: json.file.updatedAt } : {}),
          },
        }));
      } catch (err) {
        if (signal.aborted) return;
        setDocs((prev) => ({
          ...prev,
          [spec.id]: {
            status: 'error',
            message: err instanceof Error ? err.message : `Không đọc được ${spec.path}.`,
          },
        }));
      }
    },
    [systemId],
  );

  // Nạp cả hai file ngay từ đầu (không lazy theo tab): chúng chỉ vài chục KB,
  // và nạp sẵn giúp chuyển tab không chớp trạng thái loading.
  useEffect(() => {
    const controller = new AbortController();
    for (const spec of DOCS) void loadDoc(spec, controller.signal);
    return () => controller.abort();
  }, [loadDoc, reloadToken]);

  const reloading = DOCS.some((spec) => docs[spec.id].status === 'loading');

  const showcaseSrc = useMemo(
    () =>
      `/api/design-systems/${encodeURIComponent(systemId)}/showcase${
        reloadToken > 0 ? `?r=${reloadToken}` : ''
      }`,
    [systemId, reloadToken],
  );

  return (
    <div className={`figma-ds-preview ${className ?? ''}`.trim()}>
      <div className="figma-ds-preview__bar">
        <div className="figma-ds-preview__tabs" role="tablist" aria-label="Preview design system">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'showcase'}
            className={`figma-ds-preview__tab ${tab === 'showcase' ? 'active' : ''}`}
            onClick={() => setTab('showcase')}
          >
            Showcase
          </button>
          {DOCS.map((spec) => (
            <button
              key={spec.id}
              type="button"
              role="tab"
              aria-selected={tab === spec.id}
              className={`figma-ds-preview__tab ${tab === spec.id ? 'active' : ''}`}
              onClick={() => setTab(spec.id)}
            >
              {spec.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="figma-ds-preview__reload"
          onClick={() => setReloadToken((value) => value + 1)}
          disabled={reloading}
          title="Nạp lại nội dung mới nhất từ đĩa (sau khi agent sửa file qua chat)"
        >
          <Icon name={reloading ? 'spinner' : 'refresh'} size={14} />
          {reloading ? 'Đang tải…' : 'Tải lại'}
        </button>
      </div>

      <div className="figma-ds-preview__stage">
        {tab === 'showcase' ? (
          // URL-load thay vì srcDoc: showcase compiled lazy-fetch icon SVG từ
          // route react-assets, chỉ iframe same-origin mới mang được auth của app.
          <iframe
            key={showcaseSrc}
            className="figma-ds-showcase-frame"
            title="Design system showcase"
            src={showcaseSrc}
          />
        ) : null}
        {DOCS.map((spec) =>
          tab === spec.id ? <DocPane key={spec.id} spec={spec} state={docs[spec.id]} /> : null,
        )}
      </div>
    </div>
  );
}

function DocPane({ spec, state }: { spec: DocSpec; state: DocState }) {
  if (state.status === 'loading') {
    return <div className="figma-ds-preview__empty">Đang đọc {spec.path}…</div>;
  }
  if (state.status === 'empty') {
    return (
      <div className="figma-ds-preview__empty">
        <strong>{spec.emptyTitle}</strong>
        <p>{spec.emptyHint}</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="figma-ds-preview__empty is-error">
        <strong>Không đọc được {spec.label.toLowerCase()}</strong>
        <p>{state.message}</p>
      </div>
    );
  }
  return (
    <div className="figma-ds-preview__doc">
      {state.updatedAt ? (
        <div className="figma-ds-preview__doc-meta">
          {spec.path} · cập nhật {new Date(state.updatedAt).toLocaleString('vi-VN')}
        </div>
      ) : null}
      {/* Safe by contract: renderMarkdownToSafeHtml escape HTML thô và chặn
          link protocol lạ — cùng đường render với DocRedlinePreview. */}
      <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: state.html }} />
    </div>
  );
}
