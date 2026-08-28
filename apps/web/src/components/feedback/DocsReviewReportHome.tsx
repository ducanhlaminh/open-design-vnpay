// Tab "Báo cáo docs-review" trong trang /feedback: gom mọi bản xác nhận
// docs-review (dr-confirm) trên media store — KPI, thanh Giữ/Sửa/Bỏ, bảng
// theo App và bảng WF đã hoàn thành (bản MỚI NHẤT mỗi tính năng). Nguồn:
// GET /api/pipelines/docs-review/reports (daemon cache 60 s; "Làm mới" gửi
// ?refresh=1). Không lib chart — thanh 3 đoạn là flex.
import { useCallback, useEffect, useState } from 'react';
import type { DocsReviewAiOutcome, DocsReviewReportsResponse, ScreenPlatformScope } from '@open-design/contracts';
import { buildPath, navigate, type Route } from '../../router';
import styles from './DocsReviewReport.module.css';

export const DOCS_REVIEW_REPORTS_API = '/api/pipelines/docs-review/reports';

export function platformLabel(platform: ScreenPlatformScope | null | undefined): string {
  if (platform === 'mobile') return 'Mobile';
  if (platform === 'web') return 'Web';
  if (platform === 'both') return 'Cả hai';
  return '—';
}

export function formatDateTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('vi-VN') : '—';
}

export function reportDetailRoute(projectId: string, confirmationId: string): Route {
  return { kind: 'docs-review-report', projectId, confirmationId };
}

export function outputUrl(projectId: string, confirmationId: string, outputPath: string, opts: { download?: boolean } = {}): string {
  const base = `${DOCS_REVIEW_REPORTS_API}/${encodeURIComponent(projectId)}/${encodeURIComponent(confirmationId)}/output?path=${encodeURIComponent(outputPath)}`;
  return opts.download ? `${base}&download=1` : base;
}

/** Tỉ lệ % của từng kết cục trên tổng đề xuất (mẫu = proposals, hoặc tổng 3 số nếu proposals = 0). */
export function outcomeShares(outcome: DocsReviewAiOutcome): { accepted: number; edited: number; dismissed: number; total: number } {
  const total = outcome.proposals || outcome.accepted + outcome.edited + outcome.dismissed;
  const pct = (value: number) => (total ? Math.round((value / total) * 100) : 0);
  return { accepted: pct(outcome.accepted), edited: pct(outcome.edited), dismissed: pct(outcome.dismissed), total };
}

const OUTCOME_KINDS: Array<{ key: 'accepted' | 'edited' | 'dismissed'; label: string }> = [
  { key: 'accepted', label: 'Giữ' },
  { key: 'edited', label: 'Sửa' },
  { key: 'dismissed', label: 'Bỏ' },
];

export function OutcomeMeter({ outcome }: { outcome: DocsReviewAiOutcome }) {
  const shares = outcomeShares(outcome);
  return (
    <div>
      <div className={styles.meter} role="img" aria-label={`Giữ ${outcome.accepted}, Sửa ${outcome.edited}, Bỏ ${outcome.dismissed} trên ${shares.total} đề xuất`}>
        {OUTCOME_KINDS.map(({ key }) => (
          <span key={key} className={styles.meterSeg} data-kind={key} style={{ width: `${shares[key]}%` }} />
        ))}
      </div>
      <div className={styles.legend}>
        {OUTCOME_KINDS.map(({ key, label }) => (
          <span key={key} className={styles.legendItem}>
            <span className={styles.legendDot} data-kind={key} />
            {label} <b>{outcome[key]}</b> ({shares[key]}%)
          </span>
        ))}
        <span className={styles.legendItem}>Tổng đề xuất <b>{shares.total}</b></span>
      </div>
    </div>
  );
}

function OutcomeCell({ outcome }: { outcome: DocsReviewAiOutcome }) {
  return (
    <span className={styles.outcome} title="Giữ / Sửa / Bỏ">
      <span data-kind="accepted">{outcome.accepted}</span>/<span data-kind="edited">{outcome.edited}</span>/<span data-kind="dismissed">{outcome.dismissed}</span>
    </span>
  );
}

export interface DocsReviewReportHomeViewProps {
  data: DocsReviewReportsResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function DocsReviewReportHomeView({ data, loading, error, onRefresh }: DocsReviewReportHomeViewProps) {
  const summary = data?.summary;
  const kpis: Array<{ label: string; value: number | string }> = [
    { label: 'App', value: summary?.apps ?? '—' },
    { label: 'Tính năng', value: summary?.features ?? '—' },
    { label: 'Lượt xác nhận', value: summary?.confirmations ?? '—' },
    { label: 'Agent đề xuất', value: summary?.agentProposals ?? '—' },
    { label: 'Người sửa', value: summary?.humanEdits ?? '—' },
    { label: 'Bình luận', value: summary?.comments ?? '—' },
  ];
  return (
    <div className={styles.page}>
      <div className={styles.toolbarRow}>
        <span className={styles.note}>
          Mỗi dòng "WF đã hoàn thành" là bản xác nhận mới nhất của tính năng; các bản trước xem trong Chi tiết › Lịch sử.
        </span>
        <button type="button" className="pl-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Đang tải…' : 'Làm mới'}
        </button>
      </div>
      {error ? <p className={styles.error}>Không tải được báo cáo: {error}</p> : null}
      {data && !data.storeReachable ? (
        <div className={styles.warning}>Chưa kết nối media store — chưa đọc được bản xác nhận nào.</div>
      ) : null}
      {data && data.skippedFiles.length ? (
        <p className={styles.note} title={data.skippedFiles.map((f) => `${f.projectId}: ${f.path} — ${f.reason}`).join('\n')}>
          {data.skippedFiles.length} file bỏ qua (không đọc được).
        </p>
      ) : null}

      <div className={styles.kpis}>
        {kpis.map((kpi) => (
          <div key={kpi.label} className={styles.kpi}>
            <span className={styles.kpiLabel}>{kpi.label}</span>
            <span className={styles.kpiValue} data-kpi={kpi.label}>{kpi.value}</span>
          </div>
        ))}
      </div>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>Kết cục đề xuất của AI</h3>
          <span className={styles.panelHint}>Giữ nguyên · người sửa lại · người bỏ</span>
        </div>
        <OutcomeMeter outcome={summary?.aiOutcome ?? { proposals: 0, accepted: 0, edited: 0, dismissed: 0 }} />
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>Theo App</h3>
        </div>
        {data && data.byApp.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-table="by-app">
              <thead>
                <tr>
                  <th>App</th>
                  <th className="num">Tính năng</th>
                  <th className="num">Lượt xác nhận</th>
                  <th className="num">Đề xuất</th>
                  <th className="num">Giữ / Sửa / Bỏ</th>
                </tr>
              </thead>
              <tbody>
                {data.byApp.map((row) => (
                  <tr key={row.appId ?? '__none'}>
                    <td className={row.appId ? styles.cellStrong : styles.cellMuted}>{row.appName}</td>
                    <td className="num">{row.features}</td>
                    <td className="num">{row.confirmations}</td>
                    <td className="num">{row.aiOutcome.proposals}</td>
                    <td className="num"><OutcomeCell outcome={row.aiOutcome} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.empty}>Chưa có bản xác nhận docs-review nào.</div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>WF đã hoàn thành</h3>
          <span className={styles.panelHint}>{data ? `${data.completed.length} tính năng` : ''}</span>
        </div>
        {data && data.completed.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-table="completed">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Tính năng</th>
                  <th>Nền tảng</th>
                  <th>Xác nhận lúc</th>
                  <th>Người</th>
                  <th className="num">Giữ / Sửa / Bỏ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.completed.map((row) => {
                  const route = reportDetailRoute(row.projectId, row.confirmationId);
                  return (
                    <tr
                      key={`${row.projectId}:${row.confirmationId}`}
                      data-legacy={row.legacy ? 'yes' : 'no'}
                      title={row.legacy ? 'Bản cũ (v1), không có chi tiết' : undefined}
                    >
                      <td className={row.app ? undefined : styles.cellMuted}>{row.app?.name ?? 'Chưa gắn App'}</td>
                      <td className={styles.cellStrong}>{row.feature.name}</td>
                      <td>{platformLabel(row.screenPlatform)}</td>
                      <td>{formatDateTime(row.confirmedAt)}</td>
                      <td>{row.user || '—'}</td>
                      <td className="num"><OutcomeCell outcome={row.summary.aiOutcome} /></td>
                      <td>
                        {row.legacy ? (
                          <span className={styles.legacyNote} title="Bản cũ (v1), không có chi tiết">bản cũ</span>
                        ) : (
                          <a
                            className={styles.detailLink}
                            href={buildPath(route)}
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(route);
                            }}
                          >
                            Chi tiết
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.empty}>Chưa có workflow docs-review nào được xác nhận hoàn tất.</div>
        )}
      </section>
    </div>
  );
}

/** Container: tự nạp dữ liệu; "Làm mới" bỏ cache daemon (?refresh=1). */
export function DocsReviewReportHome() {
  const [data, setData] = useState<DocsReviewReportsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(refresh ? `${DOCS_REVIEW_REPORTS_API}?refresh=1` : DOCS_REVIEW_REPORTS_API);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData((await res.json()) as DocsReviewReportsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  return <DocsReviewReportHomeView data={data} loading={loading} error={error} onRefresh={() => void load(true)} />;
}
