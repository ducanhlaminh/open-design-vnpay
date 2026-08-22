// FeedbackHub — thẻ "Đánh giá chất lượng pipeline" cuối stepper: container ôm
// hai mặt tại-chỗ của tính năng feedback (điền form / soạn form) cùng toàn bộ
// fetch; thống kê là ROUTE riêng cấp cao (/feedback) nên nút chỉ điều hướng.
//
// Vì sao gom vào một file thay vì rải vào PipelinesView: view đó đã ~2900 dòng
// và là chỗ va chạm của mọi phiên làm việc song song — phần cắm vào nó phải
// mỏng nhất có thể (một import + một JSX). Hai component con
// (FeedbackFormFill / FeedbackFormBuilder) đều là controlled thuần props, nên
// chỗ DUY NHẤT biết endpoint là đây.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FeedbackAttachment,
  FeedbackFillContext,
  FeedbackFormDef,
  FeedbackFormsResponse,
  PipelineView,
} from '@open-design/contracts';
import { UI_TARGETS } from '@open-design/contracts';
import { fetchProjectFiles } from '../../providers/registry';
import { Icon } from '../Icon';
import { outputMatches } from '../pipelines/PipelineModals';
import { FeedbackFormFill, type FeedbackStageOutputOption } from './FeedbackFormFill';
import { FeedbackFormBuilder } from './FeedbackFormBuilder';
import styles from './FeedbackHub.module.css';

/** Gán một file của project về stage sinh ra nó, mirror cách Quick result làm:
 *  outputs của stage là đường dẫn TƯƠNG ĐỐI theo workflow, còn tên file mang
 *  tiền tố `<workflow>/` (và `<target>/` với bước chạy theo target) — phải bóc
 *  trước khi so, nếu không không pattern nào khớp. */
const WORKFLOW_PREFIX_RE = /^(docs-to-ui|docs-to-prd|docs-review|ds-lab|docs-to-html|docs-to-react)\//;
function stripPrefixes(name: string): string {
  let rel = name.replace(WORKFLOW_PREFIX_RE, '');
  const head = rel.split('/')[0] ?? '';
  if (head in UI_TARGETS) rel = rel.slice(head.length + 1);
  return rel;
}

/** File không đáng làm đính kèm: artifact build (to, sinh lại được) và chính
 *  dữ liệu feedback. Danh sách mỗi stage cắt ở 30 — picker là để chọn một vài
 *  file minh chứng, không phải trình duyệt cây thư mục. */
const EXCLUDED_RE = /(^|\/)(node_modules|dist|\.next|feedback)\//;
const PER_STAGE_CAP = 30;

export function FeedbackHub({
  projectId,
  workflowId,
  pipelines,
}: {
  projectId: string;
  workflowId: string;
  pipelines: PipelineView[];
}) {
  const [mode, setMode] = useState<null | 'fill' | 'builder'>(null);
  const [forms, setForms] = useState<FeedbackFormsResponse | null>(null);
  const [stageOutputs, setStageOutputs] = useState<FeedbackStageOutputOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mỗi lần mở form là một draft mới — đính kèm upload trước khi submit cần
  // một id ổn định để rơi chung một thư mục trên store.
  const draftIdRef = useRef<string>('');

  // Form của workflow hiện tại: ƯU TIÊN version mới nhất có workflowId khớp;
  // workflow chưa có form riêng rơi về version chung (không workflowId) mới
  // nhất. Form của workflow KHÁC không bao giờ được chọn.
  const latestForm: FeedbackFormDef | null = useMemo(() => {
    const list = forms?.forms ?? [];
    const specific = list.filter((f) => f.workflowId === workflowId);
    const pool = specific.length ? specific : list.filter((f) => !f.workflowId);
    return pool.length ? pool[pool.length - 1]! : null;
  }, [forms, workflowId]);

  // Ngữ cảnh lúc điền: nuôi câu optionsSource 'workflow-steps' (nhãn bước =
  // option) và prefill 'completed-steps'. failed cũng tính là "đã dùng" —
  // người chạy một bước bị lỗi chính là người có phản hồi đáng giá nhất.
  const fillContext: FeedbackFillContext = useMemo(
    () => ({
      projectId,
      steps: pipelines.map((p) => ({
        id: p.id,
        label: p.name,
        completed: p.status === 'succeeded' || p.status === 'failed',
      })),
    }),
    [projectId, pipelines],
  );

  const loadForms = useCallback(async () => {
    const res = await fetch(`/api/pipelines/feedback/forms?projectId=${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
    setForms((await res.json()) as FeedbackFormsResponse);
  }, [projectId]);

  // Nạp form ngay khi mount cho chip "n nhóm câu hỏi" trên thẻ; lỗi nuốt êm —
  // mở modal sẽ nạp lại và hiện lỗi ở đó.
  useEffect(() => {
    void loadForms().catch(() => undefined);
  }, [loadForms]);

  const openFill = async () => {
    setError(null);
    setMode('fill');
    draftIdRef.current = crypto.randomUUID();
    try {
      await loadForms();
      // Picker output: mọi file thuộc stage đã succeeded của workflow đang mở.
      const files = await fetchProjectFiles(projectId);
      const options: FeedbackStageOutputOption[] = [];
      for (const p of pipelines) {
        if (p.status !== 'succeeded' || !p.outputs?.length) continue;
        const mine = files
          .filter((f) => !EXCLUDED_RE.test(f.name))
          .filter((f) => p.outputs!.some((pattern) => outputMatches(stripPrefixes(f.name), pattern)))
          .slice(0, PER_STAGE_CAP)
          .map((f) => ({ sourcePath: f.name, name: f.name.split('/').pop() ?? f.name }));
        if (mine.length) options.push({ stageId: p.id, stageName: p.name, files: mine });
      }
      setStageOutputs(options);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openBuilder = async () => {
    setError(null);
    setMode('builder');
    try {
      await loadForms();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Escape đóng modal — cùng lý do như cửa sổ tham chiếu của DocRedlinePreview:
  // tiêu điểm có thể đang ở bất kỳ đâu trong khung.
  useEffect(() => {
    if (!mode) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMode(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  const uploadImage = async (file: File): Promise<FeedbackAttachment> => {
    const qs = new URLSearchParams({ projectId, draftId: draftIdRef.current, filename: file.name });
    const res = await fetch(`/api/pipelines/feedback/attachments?${qs}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    const json = (await res.json().catch(() => ({}))) as { attachment?: FeedbackAttachment; error?: string };
    if (!res.ok || !json.attachment) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.attachment;
  };

  const title = mode === 'fill' ? 'Bắt đầu đánh giá' : 'Soạn form phản hồi';
  const groupCount = latestForm ? (latestForm.sections?.length ?? latestForm.questions.length) : null;

  return (
    <li className={styles.step}>
      <div className={styles.spine}>
        <span className={styles.node}><Icon name="star" size={15} /></span>
      </div>
      <div className={styles.card}>
        <div className={styles.art}>
          <span>{String(pipelines.length + 1).padStart(2, '0')}</span>
          <Icon name="comment" size={30} />
        </div>
        <div className={styles.summary}>
          <div className={styles.eyebrow}>BƯỚC CUỐI WORKFLOW</div>
          <h3>{latestForm?.title ?? 'Đánh giá chất lượng pipeline'}</h3>
          <p>Chấm độ ổn định, chất lượng đầu ra, tốc độ và mức hữu ích của workflow — kèm được ảnh và output của từng bước.</p>
          <div className={styles.meta}>
            <span>{groupCount ?? '…'} nhóm câu hỏi</span>
            <span>8–12 phút</span>
            <span>Tự gắn metadata run</span>
          </div>
        </div>
        <div className={styles.side}>
          <button type="button" className={styles.start} onClick={() => void openFill()}>
            Bắt đầu đánh giá <Icon name="chevron-right" size={15} />
          </button>
          <div className={styles.secondary}>
            {/* Thống kê là ROUTE cấp cao /feedback (mục nav riêng, ngang
                Pipelines) — navigate() không mang được query nên đẩy URL đầy đủ
                theo đúng cách navigate() làm bên trong (pushState + popstate). */}
            <button
              type="button"
              onClick={() => {
                window.history.pushState(null, '', `/feedback?project=${encodeURIComponent(projectId)}`);
                window.dispatchEvent(new PopStateEvent('popstate'));
              }}
            >
              Thống kê
            </button>
            <button type="button" onClick={() => void openBuilder()}>
              Soạn form
            </button>
          </div>
        </div>
      </div>

      {mode ? (
        <div
          className={styles.backdrop}
          role="presentation"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setMode(null);
          }}
        >
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
            <div className={styles.modalHead}>
              <span className={styles.modalTitle}>{title}</span>
              <button type="button" className={styles.modalClose} onClick={() => setMode(null)}>
                Đóng
              </button>
            </div>
            <div className={styles.modalBody}>
              {error ? <p className={styles.error}>{error}</p> : null}
              {mode === 'fill' && latestForm ? (
                <FeedbackFormFill
                  form={latestForm}
                  context={fillContext}
                  stageOutputs={stageOutputs}
                  onUploadImage={uploadImage}
                  busy={busy}
                  onSubmit={async (submission) => {
                    setBusy(true);
                    try {
                      const res = await fetch('/api/pipelines/feedback/submissions', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          projectId,
                          workflowId,
                          formVersion: latestForm.version,
                          answers: submission.answers,
                          otherTexts: submission.otherTexts,
                          images: submission.images,
                          stageFiles: submission.stageFiles,
                        }),
                      });
                      if (!res.ok) {
                        const j = (await res.json().catch(() => ({}))) as { error?: string };
                        throw new Error(j.error ?? `HTTP ${res.status}`);
                      }
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              ) : null}
              {mode === 'builder' && latestForm ? (
                <FeedbackFormBuilder
                  form={latestForm}
                  busy={busy}
                  onSave={async (draft) => {
                    setBusy(true);
                    try {
                      // Form lưu từ thẻ của một workflow là form RIÊNG của
                      // workflow đó — workflowId gắn tự động.
                      const res = await fetch('/api/pipelines/feedback/forms', {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ projectId, workflowId, ...draft }),
                      });
                      if (!res.ok) {
                        const j = (await res.json().catch(() => ({}))) as { error?: string };
                        throw new Error(j.error ?? `HTTP ${res.status}`);
                      }
                      await loadForms();
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              ) : null}
              {!error && !latestForm ? <p className={styles.loading}>Đang tải…</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}
