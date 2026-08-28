// Chi tiết một bản xác nhận docs-review v2: `/feedback/docs-review/:projectId/:confirmationId`.
// Header App › Tính năng + chip nền tảng/người/ngày + dropdown "Lịch sử xác
// nhận"; tab theo `report.stages[]`; mỗi tab: cột trái = output (md render
// markdown, html mockup = iframe sandbox qua route output, ảnh = <img>, khác =
// dòng file + Tải) + khối metrics của bước; cột phải = comment của bước.
import { useEffect, useMemo, useState } from 'react';
import type {
  DocsReviewOutputRef,
  DocsReviewReportDetailResponse,
  DocsReviewStageComment,
  DocsReviewStageMetrics,
  DocsReviewStageReport,
} from '@open-design/contracts';
import { renderMarkdownToSafeHtml } from '../../artifacts/markdown';
import { navigate, navigateBack } from '../../router';
import { DOCS_REVIEW_REPORTS_API, formatDateTime, outputUrl, platformLabel, reportDetailRoute } from './DocsReviewReportHome';
import styles from './DocsReviewReport.module.css';

type OutputKind = 'markdown' | 'html' | 'image' | 'other';

export function outputKindOf(outputPath: string): OutputKind {
  const lower = outputPath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (/\.(png|svg|jpe?g|gif|webp)$/.test(lower)) return 'image';
  return 'other';
}

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
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Số liệu bước</h3>
      </div>
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
    </section>
  );
}

function MarkdownOutput({ url }: { url: string }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; html: string }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setState({ status: 'ok', html: renderMarkdownToSafeHtml(text) });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (state.status === 'loading') return <p className={styles.note}>Đang tải…</p>;
  if (state.status === 'error') return <p className={styles.error}>Không tải được file: {state.message}</p>;
  return <article className="markdown-rendered" dangerouslySetInnerHTML={{ __html: state.html }} />;
}

function OutputViewer({ projectId, confirmationId, output }: { projectId: string; confirmationId: string; output: DocsReviewOutputRef }) {
  const url = outputUrl(projectId, confirmationId, output.path);
  const kind = outputKindOf(output.path);
  return (
    <section className={styles.panel}>
      <div className={styles.fileHead}>
        <span><code>{output.path}</code> · {formatBytes(output.size)}</span>
        <a className={styles.downloadLink} href={outputUrl(projectId, confirmationId, output.path, { download: true })} download>Tải</a>
      </div>
      <div className={styles.viewer} data-kind={kind}>
        {kind === 'markdown' ? <MarkdownOutput url={url} /> : null}
        {kind === 'html' ? <iframe className={styles.frame} sandbox="allow-scripts" src={url} title={output.path} /> : null}
        {kind === 'image' ? <img className={styles.image} src={url} alt={output.path} /> : null}
        {kind === 'other' ? (
          <div className={styles.plainFile}>
            <span>Không xem trước được định dạng này.</span>
            <a className={styles.downloadLink} href={outputUrl(projectId, confirmationId, output.path, { download: true })} download>Tải file</a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StageComments({ comments }: { comments: DocsReviewStageComment[] }) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Bình luận</h3>
        <span className={styles.panelHint}>{comments.length}</span>
      </div>
      {comments.length ? (
        <div className={styles.comments}>
          {[...comments].sort((a, b) => a.at - b.at).map((comment) => (
            <div key={comment.id} className={styles.comment}>
              <div className={styles.commentMeta}>
                <b>{comment.by || '—'}</b>
                <span>·</span>
                <span>{formatDateTime(comment.at)}</span>
              </div>
              <div className={styles.commentText}>{comment.text}</div>
              {comment.target ? (
                <span className={styles.commentTarget}>{comment.target.label ?? comment.target.key}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.note}>Chưa có bình luận ở bước này.</p>
      )}
    </section>
  );
}

function StagePanel({ projectId, confirmationId, stage }: { projectId: string; confirmationId: string; stage: DocsReviewStageReport }) {
  const [selected, setSelected] = useState(0);
  useEffect(() => { setSelected(0); }, [stage.stageId]);
  const output = stage.outputs[Math.min(selected, Math.max(0, stage.outputs.length - 1))];
  const skipped = stage.skipped?.length ?? 0;
  return (
    <div className={styles.stageBody}>
      <div className={styles.col}>
        {stage.outputs.length > 1 ? (
          <div className={styles.fileList} role="tablist" aria-label="File output">
            {stage.outputs.map((item, index) => (
              <button
                key={item.path}
                type="button"
                className={styles.fileBtn}
                data-active={index === selected ? 'yes' : 'no'}
                onClick={() => setSelected(index)}
              >
                {item.path}
              </button>
            ))}
          </div>
        ) : null}
        {output ? (
          <OutputViewer projectId={projectId} confirmationId={confirmationId} output={output} />
        ) : (
          <div className={styles.empty}>Bước này không đính kèm output.</div>
        )}
        {skipped ? (
          <p className={styles.skipped} title={stage.skipped!.map((s) => `${s.path} — ${s.reason}`).join('\n')}>
            {skipped} file không đính kèm (quá 5 MB)
          </p>
        ) : null}
        <StageMetrics metrics={stage.metrics} />
      </div>
      <div className={styles.col}>
        <StageComments comments={stage.comments} />
      </div>
    </div>
  );
}

export interface DocsReviewReportDetailViewProps {
  projectId: string;
  confirmationId: string;
  data: DocsReviewReportDetailResponse;
}

export function DocsReviewReportDetailView({ projectId, confirmationId, data }: DocsReviewReportDetailViewProps) {
  const { report, history } = data;
  const [activeStage, setActiveStage] = useState(0);
  const stage = report.stages[Math.min(activeStage, Math.max(0, report.stages.length - 1))];
  const historyOptions = useMemo(() => history.map((entry) => ({
    ...entry,
    label: `${formatDateTime(entry.confirmedAt)} · ${entry.user || '—'}${entry.legacy ? ' (bản cũ)' : ''}`,
  })), [history]);

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
            <span className={styles.stageBadge}>{item.outputs.length} file · {item.comments.length} bl</span>
          </button>
        ))}
      </div>

      {stage ? (
        <StagePanel key={stage.stageId} projectId={projectId} confirmationId={confirmationId} stage={stage} />
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
