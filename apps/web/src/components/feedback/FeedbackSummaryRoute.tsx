// FeedbackHomeView — trang "Phản hồi" CẤP CAO NHẤT (`/feedback`), một mục nav
// đứng ngang Pipelines chứ không lồng trong dự án nào.
//
// Vì đứng ngoài dự án, trang tự có picker chọn dự án (GET
// /api/pipelines/projects — cùng nguồn màn Pipelines dùng). Dự án đang chọn
// đồng bộ vào `?project=<id>` bằng replaceState: URL dán được cho đồng nghiệp
// ("xem thống kê dự án X ở đây") và F5 giữ nguyên chỗ — hai lý do khiến đây là
// một TRANG chứ không phải modal. Router chỉ biết `/feedback`; query là việc
// riêng của trang, không phình Route type vì một tham số lọc.
//
// Phần dựng thống kê là FeedbackSummaryView (controlled thuần props, đã test
// riêng) — file này chỉ lo vỏ: chọn dự án, nạp dữ liệu, tải lại.
import { useCallback, useEffect, useState } from 'react';
import type { FeedbackSummaryResponse } from '@open-design/contracts';
import { FeedbackSummaryView } from './FeedbackSummaryView';
import styles from './FeedbackSummaryRoute.module.css';

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

export function FeedbackHomeView() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectId, setProjectId] = useState<string>(projectFromQuery);
  const [state, setState] = useState<LoadState>({ status: 'idle' });

  // Danh sách dự án nạp một lần; chưa có ?project= thì mặc định dự án đầu —
  // trang thống kê mở ra trống trơn bắt người dùng tự đoán bước tiếp là hỏng
  // ấn tượng đầu tiên.
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

  // Đổi dự án → nạp lại + ghi query. replaceState (không push): đổi picker
  // qua lại không nên chất đầy lịch sử Back của trình duyệt.
  useEffect(() => {
    if (!projectId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('project', projectId);
    window.history.replaceState(null, '', url);
    void load(projectId);
  }, [projectId, load]);

  return (
    <div className={styles.page}>
      {/* Hero theo đúng concept trang Pipelines: eyebrow pill + title lớn +
          lede muted bên trái, cụm điều khiển bên phải. Header/stat trong
          FeedbackSummaryView không lặp lại title nữa. */}
      <header className={styles.hero}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>Feedback</span>
          <h1 className={styles.heading}>Tổng hợp phản hồi</h1>
          <p className={styles.lede}>
            Kết quả đánh giá chất lượng pipeline từ mọi người dùng — nhóm theo version form, kèm ảnh và output từng bước.
          </p>
        </div>
        <div className={styles.toolbar}>
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
      {projects !== null && projects.length === 0 ? (
        <p className={styles.note}>Chưa có dự án pipeline nào — tạo hoặc pull một dự án trước.</p>
      ) : null}
      {state.status === 'loading' ? <p className={styles.note}>Đang tải…</p> : null}
      {state.status === 'error' ? <p className={styles.error}>Không tải được thống kê: {state.message}</p> : null}
      {state.status === 'ok' ? (
        <FeedbackSummaryView
          data={state.data}
          attachmentUrl={(path) =>
            `/api/pipelines/feedback/attachment?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
          }
        />
      ) : null}
    </div>
  );
}
