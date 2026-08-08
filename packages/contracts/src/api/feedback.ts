// Cross-user feedback collection API. Each install publishes its genuine
// end-user prompts to the shared media-service store; `pull` merges every
// install's prompts for a project into one local file the summary-feedback
// skill reads. See apps/daemon/src/feedback.ts for the storage model.

/** Result of POST /api/projects/:id/feedback/pull. */
export interface FeedbackPullResponse {
  ok: boolean;
  /** KGS/media project id the feedback was gathered for. */
  projectId: string;
  /** How many per-install `feedback/*.jsonl` files were merged. */
  files: number;
  /** Total prompt records across all merged files. */
  records: number;
  /** Absolute path of the local merged file written into the project cwd. */
  path: string;
}

/* ── Form feedback cuối pipeline (form builder + đính kèm + thống kê) ────────
 * Hợp đồng dùng chung cho: form-store (daemon), form builder + form điền (web),
 * trang thống kê (web), và CLI. Lưu trữ nằm trên media store của project:
 *   - Định nghĩa form:   feedback/forms/v<version>.json     (BẤT BIẾN theo version)
 *   - Bài gửi:           feedback/submissions/<installationId>.json (mỗi máy một file)
 *   - Đính kèm:          feedback/attachments/<submissionId>/<file>
 * Version form bất biến là bản lề của cả tính năng: thống kê nhóm answers theo
 * `formVersion`, nên nhãn câu hỏi/option của một version không bao giờ đổi
 * nghĩa sau khi đã có người trả lời. */

export type FeedbackQuestionType = 'radio' | 'checkbox' | 'text' | 'scale';

/** Nhóm câu hỏi (PHẦN A/B/C… của form wizard). Form không khai sections thì
 * render một trang cuộn như cũ — mọi field mới đều opt-in để form v1 cũ và
 * submissions cũ không đổi nghĩa. */
export interface FeedbackFormSection {
  /** Slug duy nhất trong form. */
  id: string;
  title: string;
  /** Section LẶP: nhân bản bộ câu hỏi theo TỪNG lựa chọn user đã tick ở một
   * câu checkbox thuộc section trước đó (vd "Từng pipeline" lặp theo câu
   * "Bạn đã dùng những phần nào?"). Answers của câu trong section lặp key
   * theo `<questionId>@<option>`. */
  repeatForQuestionId?: string;
}

export interface FeedbackQuestion {
  /** Slug duy nhất trong form (vd 'rating', 'issues'). Answers key theo id này
   * (câu trong section lặp: `<id>@<option>`). */
  id: string;
  label: string;
  type: FeedbackQuestionType;
  /** Form có sections thì mọi câu phải trỏ về một section. */
  sectionId?: string;
  required?: boolean;
  /** radio | checkbox — bắt buộc ≥ 2 lựa chọn (trừ khi dùng optionsSource). */
  options?: string[];
  /** checkbox: options sinh LÚC ĐIỀN từ ngữ cảnh workflow (nhãn các bước
   * pipeline) thay vì danh sách tĩnh — dùng cho câu "đã dùng bước nào?". */
  optionsSource?: 'workflow-steps';
  /** radio | checkbox: thêm lựa chọn "Khác" kèm ô điền tay (otherTexts[id]). */
  allowOther?: boolean;
  /** scale: thang scaleMin..scaleMax (mặc định 1..scaleMax). 0 dành cho NPS. */
  scaleMin?: 0 | 1;
  scaleMax?: 5 | 10;
  /** text: render textarea nhiều dòng thay vì input một dòng. */
  multiline?: boolean;
  /** Giá trị mồi lúc mở form: 'project-id' (text ← id dự án) hoặc
   * 'completed-steps' (checkbox optionsSource ← các bước đã chạy xong). */
  prefill?: 'project-id' | 'completed-steps';
}

export interface FeedbackFormDef {
  /** 1-based, tăng dần, mỗi version một file bất biến trên store. */
  version: number;
  title: string;
  /** Có mặt (≥1) → form render dạng wizard nhiều PHẦN; vắng → một trang cuộn. */
  sections?: FeedbackFormSection[];
  questions: FeedbackQuestion[];
  createdAt: number;
  /** Email/username người lưu version này (không bắt buộc — form mặc định không có). */
  createdBy?: string;
}

/** Ngữ cảnh LÚC ĐIỀN do host (thẻ Phản hồi trong stepper) cung cấp — nuôi
 * optionsSource 'workflow-steps' và prefill. Trang/route không có ngữ cảnh
 * truyền steps rỗng: câu optionsSource khi đó không có lựa chọn nào. */
export interface FeedbackFillContext {
  projectId: string;
  /** Nhãn bước = option hiển thị (và là phần `@<option>` trong answer key). */
  steps: { id: string; label: string; completed: boolean }[];
}

/** radio → string · checkbox → string[] · text → string · scale → number. */
export type FeedbackAnswerValue = string | string[] | number;

/** Một file đầu ra của stage được chọn đính kèm LÚC ĐIỀN FORM. Daemon snapshot
 *  nội dung file này lên store lúc submit (không tham chiếu file sống — re-run
 *  stage sẽ đổi nội dung dưới chân người đọc feedback). */
export interface FeedbackStageFileRef {
  stageId: string;
  /** Đường dẫn nguồn tương đối trong cwd của project (vd 'docs-review/review/summary.md'). */
  sourcePath: string;
  name: string;
  runId?: string;
}

export interface FeedbackAttachment {
  kind: 'image' | 'stage-output';
  /** Đường dẫn trên media store, dưới feedback/attachments/. */
  path: string;
  name: string;
  /** stage-output: gốc gác để trang thống kê nói file này từ bước nào ra. */
  stageId?: string;
  sourcePath?: string;
  runId?: string;
}

export interface FeedbackSubmission {
  id: string;
  formVersion: number;
  /** Email Google đã xác thực khi SSO bật; fallback feedbackUsername/installationId. */
  user: string;
  /** Môi trường gửi — trang thống kê mặc định lọc bỏ 'dev'. */
  channel: 'dev' | 'packaged';
  workflowId: string;
  runId?: string;
  /** questionId → giá trị. Câu bỏ trống (không required) vắng mặt khỏi map. */
  answers: Record<string, FeedbackAnswerValue>;
  /** questionId → chữ điền tay của lựa chọn "Khác" (chỉ câu allowOther). */
  otherTexts?: Record<string, string>;
  attachments?: FeedbackAttachment[];
  createdAt: number;
}

/** GET form hiện hành (+ mọi version) — reads fail-soft: store chưa cấu hình
 *  thì storeReachable=false và forms rơi về form mặc định trong code. */
export interface FeedbackFormsResponse {
  storeReachable: boolean;
  /** Mọi version resolve được, tăng dần theo version. */
  forms: FeedbackFormDef[];
}

/** GET tổng hợp — records đã gộp mọi install. Phần đếm/aggregate do client
 *  tính (hàm thuần, test được); daemon chỉ gom dữ liệu. */
export interface FeedbackSummaryResponse {
  storeReachable: boolean;
  forms: FeedbackFormDef[];
  submissions: FeedbackSubmission[];
}
