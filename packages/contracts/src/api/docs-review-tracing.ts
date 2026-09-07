// wp-docs-review-tracing — "Câu hỏi / Trả lời / Dẫn chứng" của docs-review.
// Gói A (daemon tự ghi câu hỏi + dẫn chứng qua `/api/docs/search`) ghép với
// Gói C (agent tự khai "trả lời" vào `tracing/<stageId>.answers.json`).
// `GET /api/projects/:id/docs-review/tracing?wfDir=<...>` trả cả hai đã ghép.

export interface DocsTracingResultRef {
  path: string;
  line: number;
  crumb: string;
  score: number;
  scope: 'feature' | 'app';
}

/** Một câu hỏi agent đã hỏi qua `tools docs search`, ghép với phần trả lời
 *  agent tự khai (nếu có). `answer: null` = daemon có nhật ký câu hỏi nhưng
 *  agent chưa ghi `tracing/<stageId>.answers.json` cho câu đó — UI hiện
 *  "agent chưa ghi trả lời". `orphan: true` = answer có trong file agent
 *  khai nhưng KHÔNG khớp câu hỏi nào trong nhật ký (agent diễn đạt lại/ghi
 *  nhầm) — vẫn trả về để không mất thông tin, đánh dấu cho người đọc biết. */
export interface DocsTracingItem {
  question: string;
  answer: string | null;
  usedFor?: string;
  citations: string[];
  results: DocsTracingResultRef[];
  orphan?: boolean;
}

export interface DocsTracingStagePayload {
  stageId: string;
  startedAt: string;
  /** true khi stage đã chạm mốc 200 truy vấn — nhật ký chỉ giữ 200 đầu. */
  truncated?: boolean;
  items: DocsTracingItem[];
}

/** `GET /api/projects/:id/docs-review/tracing?wfDir=<...>` — mảng rỗng khi
 *  chưa stage nào từng gọi `tools docs search` (Ollama tắt / stage chưa
 *  chạy); UI ẩn hẳn mục "Câu hỏi / Trả lời / Dẫn chứng" trong ca đó. */
export interface DocsReviewTracingResponse {
  stages: DocsTracingStagePayload[];
}
