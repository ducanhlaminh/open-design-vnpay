// Chi tiết một bản xác nhận docs-review v2: `/feedback/docs-review/:projectId/:confirmationId`.
// Header App › Tính năng + chip nền tảng/người/ngày + dropdown "Lịch sử xác
// nhận"; tab theo `report.stages[]`; thân tab = ĐÚNG Quick result của bước
// (cùng rail + FileViewer của route Quick result) nhưng chỉ đọc: file và bình
// luận đi qua "dự án ảo" `drsnap.<confirmationId>.<projectId>` mà daemon phục
// vụ từ snapshot trên media (docs-review-snapshot-routes.ts) — không có route
// ghi, và các viewer tự ẩn UI ghi khi `isDocsReviewSnapshotProjectId`.
import { useEffect, useMemo, useState } from 'react';
import type {
  DocsReviewReportDetailResponse,
  DocsReviewStageMetrics,
  DocsReviewStageReport,
  PipelineView,
  PipelinesResponse,
} from '@open-design/contracts';
import { docsReviewSnapshotProjectId } from '@open-design/contracts';
import { PipelineResultBody, usePipelineResultFiles } from '../pipelines/PipelineModals';
import { navigate, navigateBack } from '../../router';
import { DOCS_REVIEW_REPORTS_API, formatDateTime, platformLabel, reportDetailRoute } from './DocsReviewReportHome';
import styles from './DocsReviewReport.module.css';

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const VARIANT_LABEL = { original: 'Nguyên bản', improved: 'Đề xuất' } as const;
const SOURCE_LABEL = { user: 'người chọn', 'run-all': 'run-all', default: 'mặc định' } as const;
const yesNo = (value: boolean) => (value ? 'Có' : 'Không');

/** Dòng metrics theo `metrics.kind` — tiếng Việt, gọn. Export để test thuần. */
export function metricRows(metrics: DocsReviewStageMetrics): Array<[string, string]> {
  switch (metrics.kind) {
    case 'dr-docs':
      return [['Trang tài liệu', String(metrics.pages)]];
    case 'dr-flow':
      return [
        ['Luồng', String(metrics.flows)],
        ['Màn hình', String(metrics.screens)],
        ['Nền tảng', platformLabel(metrics.platform)],
        ['Sơ đồ sửa tay', yesNo(metrics.drawioEdited)],
        ['Chỉnh màn (thêm / đổi tên / bỏ)', `${metrics.overrides.add} / ${metrics.overrides.rename} / ${metrics.overrides.remove}`],
      ];
    case 'dr-flow-improve':
      return [['Luồng đã đánh giá', String(metrics.flows.length)]];
    case 'dr-mockup':
      return [
        ['Màn hình', String(metrics.screens)],
        ['Biến thể', metrics.variant ?? '—'],
      ];
    case 'dr-review':
      return [
        ['Agent đề xuất', String(metrics.agent.total)],
        ['Giữ / Sửa / Bỏ', `${metrics.agent.accepted} / ${metrics.agent.editedByUser} / ${metrics.agent.dismissed}`],
        ['Người tự sửa', String(metrics.userChanges.total)],
        ['Ghi chú (bỏ / của người)', `${metrics.notes.total} (${metrics.notes.dismissed} / ${metrics.notes.user})`],
        ['Bình luận trên annotation', String(metrics.annotationComments)],
        ['Trang', String(metrics.pages.length)],
        ['Sơ đồ thay (giữ / bỏ)', `${metrics.enrich.diagrams.total} (${metrics.enrich.diagrams.accepted} / ${metrics.enrich.diagrams.dismissed})`],
      ];
    default:
      return [];
  }
}

function StageMetrics({ metrics }: { metrics: DocsReviewStageMetrics }) {
  const rows = metricRows(metrics);
  return (
    <div className={styles.metrics}>
      {rows.map(([label, value]) => (
        <div key={label} className={styles.metricRow}>
          <span>{label}</span>
          <b>{value}</b>
        </div>
      ))}
      {metrics.kind === 'dr-flow-improve' && metrics.flows.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.metricTable}>
            <thead>
              <tr>
                <th>Luồng</th>
                <th>Chọn</th>
                <th>Nguồn</th>
                <th>Phát hiện</th>
                <th>Patch</th>
                <th>Màn +/−</th>
                <th>Sửa đề xuất</th>
              </tr>
            </thead>
            <tbody>
              {metrics.flows.map((flow) => (
                <tr key={flow.flowId}>
                  <td>{flow.flowId}</td>
                  <td>{VARIANT_LABEL[flow.variant] ?? flow.variant}</td>
                  <td>{SOURCE_LABEL[flow.source] ?? flow.source}</td>
                  <td>{flow.findings}</td>
                  <td>{flow.patchOps}</td>
                  <td>+{flow.proposedScreens} / −{flow.removedScreens}</td>
                  <td>{yesNo(flow.proposedEdited)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ── Quick result trên dự án ảo ────────────────────────────────────────────

const DOCS_REVIEW_WORKFLOW_ID = 'docs-review';

/** Outputs từng bước, chép từ registry daemon (apps/daemon/src/pipelines.ts,
 *  workflow docs-review). Dùng khi `GET /api/pipelines` không trả được — báo
 *  cáo đến từ media store nên dự án có thể không tồn tại trên máy này. */
const FALLBACK_OUTPUTS: Record<string, string[]> = {
  'dr-docs': ['docs/', 'docs-feature/'],
  'dr-flow': ['flows/', 'screens-discovered.json', 'screens-discovered.md', 'comp/_screens.json'],
  'dr-flow-improve': ['SCREEN-FLOW', 'SCREEN-FLOW--app', 'SCREEN-FLOW--web'].flatMap((id) =>
    ['patch.json', 'ux-review.json', 'proposed.drawio', 'proposed.edited.json', 'screens.improved.json'].map((f) => `flows/${id}/${f}`),
  ),
  'dr-mockup': ['mockups/'],
  'dr-review': ['review/'],
  'dr-confirm': ['confirmation/'],
};

/** Định nghĩa bước cho `usePipelineResultFiles`: chỉ `id` + `outputs` có ý
 *  nghĩa; lấy outputs từ registry khi có, không thì bảng fallback ở trên. */
export function stagePipelineView(stage: Pick<DocsReviewStageReport, 'stageId' | 'name'>, registry: PipelineView[] | null): PipelineView {
  const found = registry?.find((p) => p.id === stage.stageId);
  return {
    id: stage.stageId,
    name: stage.name,
    dependsOn: [],
    status: 'succeeded',
    active: true,
    outputs: found?.outputs?.length ? found.outputs : FALLBACK_OUTPUTS[stage.stageId] ?? [],
  };
}

/** Registry docs-review của dự án thật (outputs thật của từng bước). Lỗi/404
 *  → null: caller dùng fallback, không chặn hiển thị. */
async function fetchDocsReviewRegistry(projectId: string): Promise<PipelineView[] | null> {
  try {
    const res = await fetch(`/api/pipelines?projectId=${encodeURIComponent(projectId)}&workflowId=${DOCS_REVIEW_WORKFLOW_ID}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<PipelinesResponse>;
    return Array.isArray(data.pipelines) ? data.pipelines : null;
  } catch {
    return null;
  }
}

/** Thân tab = Quick result thật (rail + FileViewer) trên dự án ảo. Caller
 *  mount với `key={stageId}` vì hook giữ state theo project/pipeline. */
function StageQuickResult({ snapId, pipeline }: { snapId: string; pipeline: PipelineView }) {
  const state = usePipelineResultFiles(snapId, pipeline, DOCS_REVIEW_WORKFLOW_ID);
  return (
    // Cùng khung `.pl-result-page` của route Quick result (rail + stage cao cố
    // định, cuộn nội bộ); không kéo header/back của PipelineResultView vì trang
    // này đã có header riêng. `.quick` chỉ chỉnh chiều cao cho vừa trang.
    <section className={`pl-result-page ${styles.quick}`} aria-label={`Quick result · ${pipeline.name}`}>
      <div className="pl-result-page__body">
        {/* projectKind "other" = đúng giá trị PipelinesView truyền cho route Quick result. */}
        <PipelineResultBody projectId={snapId} projectKind="other" state={state} />
      </div>
    </section>
  );
}

/** Chữ nhỏ trên tab bước: số thứ có nghĩa (màn / trang / luồng) + số bình luận. */
export function stageBadgeText(stage: DocsReviewStageReport): string {
  const m = stage.metrics;
  const head = (() => {
    switch (m.kind) {
      case 'dr-docs': return `${m.pages} trang`;
      case 'dr-flow': return `${m.flows} luồng · ${m.screens} màn`;
      case 'dr-flow-improve': return `${m.flows.reduce((sum, f) => sum + f.findings, 0)} phát hiện`;
      case 'dr-mockup': return `${m.screens} màn`;
      case 'dr-review': return `${m.agent.total + m.userChanges.total} đề xuất`;
      default: return `${stage.outputs.length} file`;
    }
  })();
  return `${head} · ${stage.comments.length} bl`;
}

export interface DocsReviewReportDetailViewProps {
  projectId: string;
  confirmationId: string;
  data: DocsReviewReportDetailResponse;
}

export function DocsReviewReportDetailView({ projectId, confirmationId, data }: DocsReviewReportDetailViewProps) {
  const { report, history } = data;
  const [activeStage, setActiveStage] = useState(0);
  // undefined = đang tải registry; null = không có (dùng fallback outputs).
  const [registry, setRegistry] = useState<PipelineView[] | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setRegistry(undefined);
    void fetchDocsReviewRegistry(projectId).then((next) => {
      if (!cancelled) setRegistry(next);
    });
    return () => { cancelled = true; };
  }, [projectId]);
  const snapId = docsReviewSnapshotProjectId(projectId, confirmationId);
  const stage = report.stages[Math.min(activeStage, Math.max(0, report.stages.length - 1))];
  const historyOptions = useMemo(() => history.map((entry) => ({
    ...entry,
    label: `${formatDateTime(entry.confirmedAt)} · ${entry.user || '—'}${entry.legacy ? ' (bản cũ)' : ''}`,
  })), [history]);
  const skipped = stage?.skipped?.length ?? 0;

  return (
    <div className={styles.detailPage}>
      <div className={styles.detailHead}>
        <div>
          <button type="button" className={styles.backBtn} onClick={() => navigateBack({ kind: 'home', view: 'feedback' })}>
            ← Quay lại
          </button>
          <div className={styles.crumb} style={{ marginTop: 12 }}>
            <span>{report.app?.name ?? 'Chưa gắn App'}</span>
            <span>›</span>
            <b>{report.feature.name}</b>
          </div>
          <div className={styles.chips}>
            <span className={styles.chip} data-tone="accent">{platformLabel(report.screenPlatform)}</span>
            <span className={styles.chip}>{report.user || '—'}</span>
            <span className={styles.chip}>{formatDateTime(report.confirmedAt)}</span>
            <span className={styles.chip} title={`Mã xác nhận · ${report.installationId}`}>{report.confirmationId}</span>
          </div>
        </div>
        <label className={styles.history}>
          <span className={styles.historyLabel}>Lịch sử xác nhận</span>
          <select
            value={confirmationId}
            aria-label="Lịch sử xác nhận"
            onChange={(event) => {
              const next = event.target.value;
              if (next && next !== confirmationId) navigate(reportDetailRoute(projectId, next));
            }}
          >
            {historyOptions.map((entry) => (
              <option key={entry.confirmationId} value={entry.confirmationId} disabled={entry.legacy}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.stageTabs} role="tablist" aria-label="Các bước">
        {report.stages.map((item, index) => (
          <button
            key={item.stageId}
            type="button"
            role="tab"
            aria-selected={index === activeStage}
            className={styles.stageTab}
            data-active={index === activeStage ? 'yes' : 'no'}
            onClick={() => setActiveStage(index)}
          >
            <span className={styles.stageNum}>{index + 1}</span>
            {item.name}
            <span className={styles.stageBadge}>{stageBadgeText(item)}</span>
          </button>
        ))}
      </div>

      {stage ? (
        <>
          <details className={styles.metricsFold}>
            <summary>Số liệu bước</summary>
            <StageMetrics metrics={stage.metrics} />
            {skipped ? (
              <p className={styles.skipped} title={stage.skipped!.map((s) => `${s.path} — ${s.reason}`).join('\n')}>
                {skipped} file không đính kèm (quá 5 MB)
              </p>
            ) : null}
          </details>
          {registry === undefined ? (
            <p className={styles.note}>Đang tải kết quả bước…</p>
          ) : (
            // key theo bước: đổi tab là mount hook mới (state files/active theo pipeline).
            <StageQuickResult key={stage.stageId} snapId={snapId} pipeline={stagePipelineView(stage, registry)} />
          )}
        </>
      ) : (
        <div className={styles.empty}>Bản xác nhận không có bước nào.</div>
      )}
    </div>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: DocsReviewReportDetailResponse };

export function DocsReviewReportDetail({ projectId, confirmationId }: { projectId: string; confirmationId: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(`${DOCS_REVIEW_REPORTS_API}/${encodeURIComponent(projectId)}/${encodeURIComponent(confirmationId)}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as DocsReviewReportDetailResponse;
        if (!cancelled) setState({ status: 'ok', data });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, confirmationId]);

  if (state.status === 'ok') return <DocsReviewReportDetailView projectId={projectId} confirmationId={confirmationId} data={state.data} />;
  return (
    <div className={styles.detailPage}>
      <div>
        <button type="button" className={styles.backBtn} onClick={() => navigateBack({ kind: 'home', view: 'feedback' })}>
          ← Quay lại
        </button>
      </div>
      {state.status === 'loading' ? <p className={styles.note}>Đang tải bản xác nhận…</p> : null}
      {state.status === 'error' ? <p className={styles.error}>Không tải được chi tiết: {state.message}</p> : null}
    </div>
  );
}
