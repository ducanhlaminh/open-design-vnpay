// FeedbackHomeView — trang "Phản hồi" CẤP CAO NHẤT (`/feedback`), một mục nav
// đứng ngang Pipelines chứ không lồng trong dự án nào.
//
// Hai TẦNG xem: tab "Tổng quan" (mặc định — dashboard trung bình của mọi
// report: KPI, TB theo phần, TB theo bước, sẵn sàng dùng thật) và tab
// "Chi tiết" (breakdown từng câu như trước). Bộ lọc (workflow + ẩn dev) là
// MỘT state dùng chung — đổi filter thì cả chart lẫn chi tiết cùng đổi.
// Click một thanh phần bên Tổng quan drill sang Chi tiết và cuộn tới đúng
// phần đó (sectionAnchorId).
//
// Vì đứng ngoài dự án, trang tự có picker chọn dự án (GET
// /api/pipelines/projects — cùng nguồn màn Pipelines dùng). Dự án đang chọn
// đồng bộ vào `?project=<id>` bằng replaceState: URL dán được cho đồng nghiệp
// và F5 giữ nguyên chỗ. Router chỉ biết `/feedback`; query là việc riêng của
// trang.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedbackSubmission, FeedbackSummaryResponse } from '@open-design/contracts';
import { FeedbackOverview } from './FeedbackOverview';
import { FeedbackSummaryView, sectionAnchorId } from './FeedbackSummaryView';
import { DocsReviewReportHome } from './DocsReviewReportHome';
import styles from './FeedbackSummaryRoute.module.css';

// Tab MẶC ĐỊNH là báo cáo docs-review (dr-confirm v2, gom từ media store);
// hai tab khảo sát form (Tổng quan / Chi tiết) gom vào nhóm "Khảo sát".
export type FeedbackHomeTab = 'docs-review' | 'overview' | 'detail';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: FeedbackSummaryResponse };

interface ProjectRow {
  id: string;
  name: string;
}

function projectFromQuery(): string {
  return new URLSearchParams(window.location.search).get('project') ?? '';
}

/** Bộ lọc dùng chung cho cả hai tab — hàm thuần để test được độc lập. */
export function filterFeedbackSubmissions(
  submissions: FeedbackSubmission[],
  opts: { workflow: string; hideDev: boolean },
): FeedbackSubmission[] {
  return submissions.filter(
    (submission) =>
      (!opts.hideDev || submission.channel !== 'dev') &&
      (!opts.workflow || submission.workflowId === opts.workflow),
  );
}

export function FeedbackHomeView() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectId, setProjectId] = useState<string>(projectFromQuery);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [tab, setTab] = useState<FeedbackHomeTab>('docs-review');
  const surveyTab = tab !== 'docs-review';
  const [workflow, setWorkflow] = useState('');
  const [hideDev, setHideDev] = useState(true);

  // Danh sách dự án nạp một lần; chưa có ?project= thì mặc định dự án đầu.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/pipelines/projects');
        const json = (await res.json().catch(() => ({}))) as { projects?: ProjectRow[] };
        if (cancelled) return;
        const list = json.projects ?? [];
        setProjects(list);
        setProjectId((current) => current || list[0]?.id || '');
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    setState({ status: 'loading' });
    try {
      const res = await fetch(`/api/pipelines/feedback/summary?projectId=${encodeURIComponent(pid)}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setState({ status: 'ok', data: (await res.json()) as FeedbackSummaryResponse });
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // Đổi dự án → nạp lại + ghi query (replaceState — không chất đầy Back).
  useEffect(() => {
    if (!projectId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('project', projectId);
    window.history.replaceState(null, '', url);
    void load(projectId);
  }, [projectId, load]);

  const data = state.status === 'ok' ? state.data : null;
  const workflows = useMemo(
    () => [...new Set((data?.submissions ?? []).map((submission) => submission.workflowId))].sort(),
    [data],
  );
  const visible = useMemo(
    () => filterFeedbackSubmissions(data?.submissions ?? [], { workflow, hideDev }),
    [data, workflow, hideDev],
  );
  const users = new Set(visible.map((submission) => submission.user));
  const latest = visible.length ? Math.max(...visible.map((submission) => submission.createdAt)) : 0;

  const attachmentUrl = (path: string) =>
    `/api/pipelines/feedback/attachment?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`;

  const drill = (sectionTitle: string) => {
    setTab('detail');
    // Đợi tab Chi tiết mount xong rồi mới cuộn; jsdom không có scrollIntoView.
    setTimeout(() => document.getElementById(sectionAnchorId(sectionTitle))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 60);
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>Feedback</span>
          <h1 className={styles.heading}>Tổng hợp phản hồi</h1>
          <p className={styles.lede}>
            Báo cáo docs-review đã xác nhận hoàn tất (5 bước, đề xuất AI giữ/sửa/bỏ, bình luận) và kết quả khảo sát chất lượng pipeline từ mọi người dùng.
          </p>
        </div>
        <div className={styles.toolbar} hidden={!surveyTab}>
          <label className={styles.picker}>
            <span className={styles.pickerLabel}>Dự án</span>
            <select value={projectId} onChange={(ev) => setProjectId(ev.target.value)}>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="pl-btn"
            onClick={() => void load(projectId)}
            disabled={state.status === 'loading' || !projectId}
          >
            Tải lại
          </button>
        </div>
      </header>

      {surveyTab && data && !data.storeReachable ? (
        <div className={styles.warning}>Chưa kết nối media store — dữ liệu có thể thiếu</div>
      ) : null}

      {/* Thanh điều khiển chung: tab segmented + filter + stat dồn phải. */}
      <div className={styles.controls}>
        <div className={styles.tabs} role="tablist" aria-label="Chế độ xem">
          <button type="button" role="tab" aria-selected={tab === 'docs-review'} className={styles.tabButton} data-active={tab === 'docs-review' ? 'yes' : 'no'} onClick={() => setTab('docs-review')}>
            Báo cáo docs-review
          </button>
        </div>
        <div className={styles.tabs} role="tablist" aria-label="Khảo sát">
          <span className={styles.tabGroupLabel}>Khảo sát</span>
          <button type="button" role="tab" aria-selected={tab === 'overview'} className={styles.tabButton} data-active={tab === 'overview' ? 'yes' : 'no'} onClick={() => setTab('overview')}>
            Tổng quan
          </button>
          <button type="button" role="tab" aria-selected={tab === 'detail'} className={styles.tabButton} data-active={tab === 'detail' ? 'yes' : 'no'} onClick={() => setTab('detail')}>
            Chi tiết
          </button>
        </div>
        {surveyTab ? (<>
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Workflow</span>
          <select className={styles.select} value={workflow} onChange={(event) => setWorkflow(event.target.value)}>
            <option value="">Tất cả workflow</option>
            {workflows.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.toggle} data-on={hideDev ? 'yes' : 'no'} title="Mặc định bật — dữ liệu thử (dev) không làm bẩn số liệu thật">
          <input type="checkbox" checked={hideDev} onChange={(event) => setHideDev(event.target.checked)} />
          <span>Ẩn bản ghi dev</span>
        </label>
        <div className={styles.stats}>
          <span className={styles.stat}><b>{visible.length}</b> bài gửi</span>
          <span className={styles.stat}><b>{users.size}</b> người gửi</span>
          <span className={styles.stat}><b>{latest ? new Date(latest).toLocaleString('vi-VN') : '—'}</b> gần nhất</span>
        </div>
        </>) : null}
      </div>

      {tab === 'docs-review' ? <DocsReviewReportHome /> : null}
      {surveyTab && projects !== null && projects.length === 0 ? (
        <p className={styles.note}>Chưa có dự án pipeline nào — tạo hoặc pull một dự án trước.</p>
      ) : null}
      {surveyTab && state.status === 'loading' ? <p className={styles.note}>Đang tải…</p> : null}
      {surveyTab && state.status === 'error' ? <p className={styles.error}>Không tải được thống kê: {state.message}</p> : null}
      {surveyTab && data ? (
        tab === 'overview' ? (
          <FeedbackOverview forms={data.forms} submissions={visible} onDrill={drill} />
        ) : (
          <FeedbackSummaryView forms={data.forms} submissions={visible} attachmentUrl={attachmentUrl} />
        )
      ) : null}
    </div>
  );
}
