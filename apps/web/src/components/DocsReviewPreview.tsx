// DocsReviewPreview — the `docs-to-prd` workflow's prd-review stage
// preview (`review/report.json`, output of the `docs-mockup-review` skill).
// Unlike ReviewPreview (read-only, judges a GENERATED wireframe) this renders
// the REAL mockup image from the source doc on the left and its findings on
// the right, per Nielsen/Norman "left = artifact under review, right =
// judgement" layout. It opens in a formatted READ mode; the "Chỉnh sửa"
// button switches the findings to an editable form whose edits persist back
// to `report.json` via the same upsert route FileViewer's Inspect panel uses.
// Clicking a mockup opens it full-screen (lightbox). Export bundles the
// (possibly edited) report + every image it references into one .zip so a
// reviewer always gets the full picture, never a report with missing images.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { projectRawUrl } from '../providers/registry';
import { triggerDownload } from '../runtime/exports';
import { renderMarkdown } from '../runtime/markdown';
import styles from './DocsReviewPreview.module.css';

export type FindingKind = 'mismatch' | 'heuristic';
export type Severity = 'blocker' | 'major' | 'minor';
export type Verdict = 'pass' | 'warn' | 'fail';

/** Bounding box normalized to the mockup image: x/y = top-left corner,
 *  w/h = size, all as 0–1 fractions of the image's width/height — so the
 *  same region renders correctly at any display size. */
export interface FindingRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MockupFinding {
  kind?: FindingKind;
  heuristic?: string;
  source?: 'nielsen' | 'norman';
  severity?: Severity;
  issue?: string;
  recommendation?: string;
  region?: FindingRegion;
}

export interface MockupReviewImage {
  id: string;
  path: string;
  page?: string;
  feature_text?: string;
  score?: number;
  verdict?: Verdict;
  findings?: MockupFinding[];
  passes?: string[];
}

export interface DocsMockupReviewReport {
  schema_version?: string;
  kind?: string;
  generated_from?: unknown;
  summary?: { images?: number; score?: number; verdict?: Verdict; blockers?: number; majors?: number; minors?: number };
  images?: MockupReviewImage[];
}

/** Shape sniff mirroring UxResearchPreview's `isUxResearchReport` — the
 *  explicit `kind` marker is authoritative; the `images[].findings` shape is
 *  a fallback for a report saved without it round-tripping cleanly. */
export function isDocsMockupReviewReport(v: unknown): v is DocsMockupReviewReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'docs-mockup-review') return true;
  return Array.isArray(r.images) && r.images.some((i) => i && typeof i === 'object' && 'path' in (i as object));
}

/** The per-page fan-out manifest (skill schema_version 1.1): review/index.json
 *  listing each page's own report.json. Distinct from a single report — the
 *  `pages[]` array + kind marker. */
export interface DocsMockupReviewIndex {
  kind?: string;
  schema_version?: string;
  summary?: { images?: number; score?: number; verdict?: Verdict; blockers?: number; majors?: number; minors?: number };
  pages?: Array<{
    slug?: string;
    page?: string;
    page_path?: string;
    report?: string;
    images?: number;
    score?: number;
    verdict?: Verdict;
    blockers?: number;
    majors?: number;
    minors?: number;
  }>;
}

export function isDocsMockupReviewIndex(v: unknown): v is DocsMockupReviewIndex {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'docs-mockup-review-index') return true;
  // Fallback: a pages[] array whose items carry a `report` path.
  return Array.isArray(r.pages) && r.pages.some((p) => p && typeof p === 'object' && 'report' in (p as object));
}

const T = {
  ink: 'var(--text, #1a1a1a)',
  soft: 'var(--text-soft, #4b5563)',
  muted: 'var(--text-muted, #6b7280)',
  faint: 'var(--text-muted, #9aa4b2)',
  border: 'var(--border, #e1e5eb)',
  paper: 'var(--bg-panel, #fff)',
  subtle: 'var(--bg-subtle, #f5f6f8)',
  accent: 'var(--accent, #0066b3)',
  red: 'var(--red, #dc2626)',
  amber: 'var(--amber, #b45309)',
  green: 'var(--green, #16a34a)',
  radius: 'var(--radius, 8px)',
};
/**
 * The `docs-mockup-review` skill runs with its shell cwd set to the
 * workflow-scoped folder (`<project>/docs-to-prd/`, see server.ts's
 * runPipeline) — it writes `report.json`'s `images[].path` relative to THAT
 * cwd (e.g. `docs/confluence/x/attachments/y.png`), with zero visibility
 * into the `docs-to-prd/` prefix the daemon namespaces it under. But
 * `/api/projects/:id/raw/*` resolves names relative to the PROJECT ROOT, so
 * a raw path needs that prefix reconstructed before it can load. `fileName`
 * (report.json's own path) is always correct — root-relative, from the
 * project's real file listing — so derive the prefix from IT: everything
 * BEFORE the `review/` segment. This is robust to the per-page fan-out layout
 * (`docs-to-prd/review/<slug>/report.json`, nested) as well as the flat legacy
 * one (`docs-to-prd/review/report.json`) — a naive "two segments up" slice
 * would yield `docs-to-prd/review` for the nested case and 404 every image.
 * Idempotent: a path that already carries the prefix (or a review-root report
 * with no prefix at all) passes through unchanged.
 */
export function resolveImagePath(reportFileName: string, imagePath: string): string {
  const norm = reportFileName.replace(/\\/g, '/');
  const at = norm.indexOf('/review/');
  const prefix = at > 0 ? norm.slice(0, at) : '';
  if (!prefix || imagePath.startsWith(`${prefix}/`)) return imagePath;
  return `${prefix}/${imagePath}`;
}

const asVerdict = (v: unknown): Verdict => (v === 'fail' || v === 'warn' ? v : 'pass');
const verdictColor = (v: Verdict) => (v === 'fail' ? T.red : v === 'warn' ? T.amber : T.green);
const verdictLabel = (v: Verdict) => (v === 'fail' ? 'Chưa đạt' : v === 'warn' ? 'Cảnh báo' : 'Đạt');
const sevColor = (s?: string) => (s === 'blocker' ? T.red : s === 'major' ? T.amber : T.muted);
const sevLabel = (s?: string) => (s === 'blocker' ? 'Nghiêm trọng' : s === 'major' ? 'Nặng' : 'Nhẹ');
const sevEmoji = (s?: string) => (s === 'blocker' ? '🔴' : s === 'major' ? '🟠' : '⚪');

/** Fetch an image and inline it as a base64 data URI so an exported .md is
 *  self-contained — one file the reader's editor renders with images, no
 *  sidecar folder to keep together. Returns null on any fetch/read error. */
async function imageToDataUri(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sevHtmlColor = (s?: string) => (s === 'blocker' ? '#dc2626' : s === 'major' ? '#b45309' : '#6b7280');

/** Self-contained styled HTML for ONE page's review — findings as prose per
 *  mockup with each image inlined as base64. Rendered to PDF server-side. `level`
 *  nests the page heading (h2 for standalone, h3 inside a combined doc). Shared
 *  by the per-page and index exporters. */
async function buildReviewHtmlForReport(
  projectId: string,
  reportFileName: string,
  images: MockupReviewImage[],
  level: 2 | 3 = 2,
): Promise<string> {
  let blockers = 0, majors = 0, minors = 0;
  const scores: number[] = [];
  let worst: Verdict = 'pass';
  for (const img of images) {
    const { score: s, verdict: v } = scoreImage(img.findings ?? []);
    scores.push(s);
    if (v === 'fail') worst = 'fail';
    else if (v === 'warn' && worst !== 'fail') worst = 'warn';
    for (const f of img.findings ?? []) {
      if (f.severity === 'blocker') blockers += 1;
      else if (f.severity === 'major') majors += 1;
      else if (f.severity === 'minor') minors += 1;
    }
  }
  const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
  const pageTitle = images.find((i) => i.page)?.page || reportFileName.split('/').filter(Boolean).slice(-2, -1)[0] || 'Review';
  const HT = level;
  const HM = level + 1;
  const HS = level + 2;
  const out: string[] = [];
  out.push(`<section class="pg">`);
  out.push(`<h${HT}>${esc(pageTitle)}</h${HT}>`);
  out.push(
    `<p class="meta">${typeof score === 'number' ? `<b>Điểm:</b> ${score}/100 · ` : ''}<b>Kết luận:</b> <span class="verdict v-${worst}">${verdictLabel(worst)}</span></p>`,
  );
  out.push(
    `<p class="counts"><span style="color:#dc2626">● ${blockers} nghiêm trọng</span> · <span style="color:#b45309">● ${majors} nặng</span> · <span style="color:#6b7280">● ${minors} nhẹ</span></p>`,
  );
  for (const img of images) {
    const { score: s, verdict: v } = scoreImage(img.findings ?? []);
    const title = img.page || img.id;
    out.push(`<div class="mk">`);
    out.push(`<h${HM}>${esc(title)} — <span class="verdict v-${v}">${verdictLabel(v)}</span>${typeof s === 'number' ? ` <span class="sc">${s}/100</span>` : ''}</h${HM}>`);
    const dataUri = await imageToDataUri(projectRawUrl(projectId, resolveImagePath(reportFileName, img.path)));
    out.push(dataUri ? `<img class="shot" src="${dataUri}" alt="${esc(title)}"/>` : `<p class="warn">(không tải được ảnh: ${esc(img.path)})</p>`);
    if (img.feature_text) out.push(`<div class="ft"><b>Nội dung màn hình theo tài liệu:</b>${renderMarkdown(formatFeatureText(img.feature_text))}</div>`);
    const findings = img.findings ?? [];
    if (findings.length) {
      out.push(`<h${HS}>Vấn đề phát hiện</h${HS}><ul class="find">`);
      for (const f of findings) {
        out.push(
          `<li><span class="sev" style="color:${sevHtmlColor(f.severity)}">[${sevLabel(f.severity)}]</span> ${esc(f.issue ?? '')}` +
            (f.recommendation ? `<div class="rec">💡 <b>Đề xuất:</b> ${esc(f.recommendation)}</div>` : '') +
            `</li>`,
        );
      }
      out.push(`</ul>`);
    }
    if (img.passes?.length) {
      out.push(`<h${HS}>Điểm đạt</h${HS}><ul class="pass">`);
      for (const p of img.passes) out.push(`<li>✅ ${esc(p)}</li>`);
      out.push(`</ul>`);
    }
    out.push(`</div>`);
  }
  out.push(`</section>`);
  return out.join('\n');
}

const REVIEW_PDF_CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; font-size: 12px; line-height: 1.5; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 2px solid #0066b3; }
  h3 { font-size: 14px; margin: 14px 0 4px; }
  h4, h5 { font-size: 12.5px; margin: 10px 0 4px; color: #374151; }
  .note { color: #6b7280; font-style: italic; margin: 0 0 10px; }
  .meta, .counts { margin: 3px 0; }
  .verdict { font-weight: 700; }
  .v-fail { color: #dc2626; } .v-warn { color: #b45309; } .v-pass { color: #16a34a; }
  .sc { color: #6b7280; font-weight: 600; }
  .pg { page-break-before: auto; }
  .mk { page-break-inside: avoid; margin: 10px 0 16px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; }
  img.shot { max-width: 100%; height: auto; border: 1px solid #e1e5eb; border-radius: 6px; margin: 6px 0; }
  ul { margin: 4px 0 8px; padding-left: 20px; }
  li { margin: 3px 0; }
  .sev { font-weight: 700; }
  .rec { color: #374151; margin: 2px 0 0 2px; }
  .ft { margin: 6px 0; }
  .warn { color: #dc2626; }
`;

/** Wrap review fragments into a print-ready HTML doc, then render it to a PDF
 *  through the daemon (headless Chromium) and download the file. */
async function exportReviewPdf(titleText: string, fragments: string[], filename: string): Promise<void> {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>${REVIEW_PDF_CSS}</style></head><body>` +
    `<h1>${esc(titleText)}</h1>` +
    `<p class="note">Rà soát mockup theo tài liệu. Dùng để đọc &amp; chỉnh sửa lại tài liệu nguồn.</p>` +
    fragments.join('\n') +
    `</body></html>`;
  const resp = await fetch('/api/render/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, filename }),
  });
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Xuất PDF thất bại (${resp.status})`);
  }
  triggerDownload(await resp.blob(), filename);
}

/** Same arithmetic as the docs-mockup-review skill's step 3 — recomputed
 *  client-side so an edit's score impact shows immediately, no re-run needed. */
function scoreImage(findings: MockupFinding[]): { score: number; verdict: Verdict } {
  let deduction = 0;
  for (const f of findings) {
    if (f.severity === 'blocker') deduction += 25;
    else if (f.severity === 'major') deduction += 10;
    else if (f.severity === 'minor') deduction += 3;
  }
  const score = Math.max(0, 100 - deduction);
  const hasBlocker = findings.some((f) => f.severity === 'blocker');
  const verdict: Verdict = hasBlocker || score < 60 ? 'fail' : score < 85 ? 'warn' : 'pass';
  return { score, verdict };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/* ── Chú thích mã heuristic ──
 * N.1–N.10 (Nielsen) + D1–D6 (Norman) là danh mục TĨNH — dịch gọn từ
 * craft/heuristic-eval.md (nguồn chấm điểm của skill docs-mockup-review).
 * UXR-xx là mã ĐỘNG: tiêu chí do bước ux-research của chính run này sinh ra,
 * nên GlossaryModal tải ux-research/report.json cạnh report review để tra.
 * Mirror của glossary bên pipeline-studio docs-review-panel — keep in sync. */
const NIELSEN_GLOSSARY: Array<{ code: string; title: string; desc: string }> = [
  { code: 'N.1', title: 'Hiển thị trạng thái hệ thống', desc: 'Người dùng luôn biết hệ thống đang làm gì: loading, tiến trình, kết quả của mỗi hành động chậm/bất đồng bộ.' },
  { code: 'N.2', title: 'Khớp với thế giới thực', desc: 'Nhãn và khái niệm dùng ngôn ngữ của người dùng, theo thứ tự tự nhiên — không dùng thuật ngữ hệ thống.' },
  { code: 'N.3', title: 'Người dùng kiểm soát & tự do', desc: 'Mọi màn hình sau điểm vào có đường thoát rõ ràng: hủy, quay lại, thoát trước khi chốt giao dịch.' },
  { code: 'N.4', title: 'Nhất quán & chuẩn mực', desc: 'Cùng một khái niệm dùng cùng nhãn, vị trí, hành vi ở mọi màn hình; theo chuẩn nền tảng.' },
  { code: 'N.5', title: 'Phòng ngừa lỗi', desc: 'Hành động phá hủy / không đảo ngược phải có xác nhận; thiết kế chặn lỗi trước khi nó xảy ra.' },
  { code: 'N.6', title: 'Nhận biết thay vì ghi nhớ', desc: 'Hiển thị lựa chọn sẵn (gần đây, danh bạ, gợi ý) thay vì bắt người dùng nhớ và gõ lại.' },
  { code: 'N.7', title: 'Linh hoạt & hiệu quả', desc: 'Đường tắt cho người dùng thành thạo (thao tác nhanh, mẫu lưu sẵn) mà không cản người mới.' },
  { code: 'N.8', title: 'Thẩm mỹ & tối giản', desc: 'Mỗi màn hình chỉ chứa thông tin nhiệm vụ cần; nội dung phụ không cạnh tranh với nội dung chính.' },
  { code: 'N.9', title: 'Nhận biết & phục hồi lỗi', desc: 'Thông báo lỗi nói rõ chuyện gì xảy ra, vì sao, và cách sửa — ngay tại chỗ xảy ra lỗi.' },
  { code: 'N.10', title: 'Trợ giúp & tài liệu', desc: 'Tác vụ không hiển nhiên có trợ giúp tại chỗ (tooltip, hướng dẫn nhập liệu, ví dụ).' },
];
const NORMAN_GLOSSARY: Array<{ code: string; title: string; desc: string }> = [
  { code: 'D1', title: 'Affordance', desc: 'Phần tử tương tác phải trông tương tác được — nút phải giống nút, không như text tĩnh.' },
  { code: 'D2', title: 'Signifier', desc: 'Tín hiệu chỉ rõ hành động nằm ở đâu: icon + nhãn, vùng chạm rõ, điểm vào nhìn thấy được.' },
  { code: 'D3', title: 'Mapping', desc: 'Quan hệ giữa control và kết quả phải tự nhiên: thứ tự, hướng, cách nhóm khớp với hệ quả.' },
  { code: 'D4', title: 'Feedback', desc: 'Mỗi hành động của người dùng có phản hồi tức thì, có nghĩa (đổi trạng thái, xác nhận).' },
  { code: 'D5', title: 'Constraint', desc: 'Thiết kế chặn hành động sai từ cấu trúc: picker thay vì gõ tự do, disable đến khi hợp lệ.' },
  { code: 'D6', title: 'Conceptual model', desc: 'Trình tự màn hình khớp cách người dùng nghĩ về tác vụ (chọn người nhận → số tiền → xem lại → xong).' },
];

interface UxrCriterion {
  id: string;
  title: string;
  statement?: string;
}

/** Modal tra cứu chú thích mã. `focus` = mã cần cuộn tới + làm nổi khi mở
 *  (bấm từ chip mã trên finding). Đóng bằng Esc/click nền — sự kiện được
 *  nuốt (capture + stopPropagation) để không đóng nhầm modal host bên ngoài. */
function GlossaryModal({
  uxr,
  focus,
  onClose,
}: {
  /** Tiêu chí UXR của run này — null khi report ux-research chưa có/tải lỗi. */
  uxr: UxrCriterion[] | null;
  focus: string | null;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  useEffect(() => {
    if (!focus) return;
    bodyRef.current?.querySelector(`[data-code="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [focus]);
  // Danh sách CARD: lưới 2 cột, mỗi rule một card — chip mã accent ở đầu,
  // tên đậm, mô tả nhạt bên dưới. Card focus (bấm từ chip mã trên finding)
  // viền + nền accent.
  const list = (rows: Array<{ code: string; title: string; desc: string }>) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
      {rows.map((r) => {
        const focused = focus === r.code;
        return (
          <div
            key={r.code}
            data-code={r.code}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '11px 13px',
              borderRadius: 10,
              border: `1px solid ${focused ? T.accent : T.border}`,
              background: focused ? 'color-mix(in srgb, var(--accent, #0066b3) 8%, transparent)' : T.subtle,
              boxShadow: focused ? `0 0 0 1px ${T.accent}` : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ padding: '1px 7px', borderRadius: 999, background: 'color-mix(in srgb, var(--accent, #0066b3) 12%, transparent)', fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700, color: T.accent, whiteSpace: 'nowrap' }}>
                {r.code}
              </span>
              <span style={{ minWidth: 0, fontSize: 13, fontWeight: 650, lineHeight: 1.4, color: T.ink }}>{r.title}</span>
            </div>
            {r.desc ? <span style={{ fontSize: 12.5, lineHeight: 1.6, color: T.soft }}>{r.desc}</span> : null}
          </div>
        );
      })}
    </div>
  );
  const section = (label: string) => (
    <div style={{ margin: '0 0 4px', padding: '0 10px', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: T.soft }}>
      {label}
    </div>
  );
  return (
    <div
      role="dialog"
      aria-label="Chú thích mã đánh giá"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(15,18,24,0.55)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // NỀN ĐẶC có chủ đích: --bg-panel của theme glass là rgba trong suốt,
        // để nó ở đây thì nội dung workspace phía sau xuyên qua chữ — glossary
        // là bề mặt đọc, dùng --bg (đặc) thay vì bề mặt kính.
        style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 720, maxHeight: '82vh', overflow: 'hidden', borderRadius: 12, border: `1px solid ${T.border}`, background: 'var(--bg, #faf9f7)', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: `1px solid ${T.border}` }}>
          <Icon name="help-circle" size={15} />
          <span style={{ fontSize: 14, fontWeight: 650, color: T.ink }}>Chú thích mã đánh giá</span>
          <button
            type="button"
            onClick={onClose}
            title="Đóng (Esc)"
            style={{ marginLeft: 'auto', display: 'flex', padding: 4, border: 0, borderRadius: 6, background: 'transparent', color: T.soft, cursor: 'pointer' }}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
        <div ref={bodyRef} style={{ display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', padding: '14px 12px' }}>
          <div>
            {section('Nielsen — 10 heuristic khả dụng (N.1–N.10)')}
            {list(NIELSEN_GLOSSARY)}
          </div>
          <div>
            {section('Norman — 6 nguyên tắc thiết kế (D1–D6)')}
            {list(NORMAN_GLOSSARY)}
          </div>
          <div>
            {section('UXR — tiêu chí UX Research của run này')}
            {uxr?.length ? (
              list(uxr.map((c) => ({ code: c.id, title: c.title, desc: c.statement ?? '' })))
            ) : (
              <p style={{ margin: 0, padding: '0 10px', fontSize: 12.5, color: T.soft }}>
                Chưa đọc được report UX Research của run này — mã UXR-xx xem trong preview bước ux-research sau khi bước đó chạy.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The displayed content box of an `object-fit: contain` image INSIDE its
 *  element box — normalized region overlays must anchor to the drawn pixels,
 *  not the letterboxed element. Recomputes on load + resize. */
function useImageContentRect(ref: React.RefObject<HTMLImageElement | null>) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const nw = el.naturalWidth;
      const nh = el.naturalHeight;
      if (!nw || !nh) {
        setRect(null);
        return;
      }
      const scale = Math.min(el.clientWidth / nw, el.clientHeight / nh);
      const w = nw * scale;
      const h = nh * scale;
      setRect({ left: (el.clientWidth - w) / 2, top: (el.clientHeight - h) / 2, width: w, height: h });
    };
    compute();
    el.addEventListener('load', compute);
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => {
      el.removeEventListener('load', compute);
      ro.disconnect();
    };
  }, [ref]);
  return rect;
}

/** One numbered severity-colored callout box over the mockup. */
function RegionBox({ n, region, color }: { n: number; region: FindingRegion; color: string }) {
  const x = clamp01(region.x);
  const y = clamp01(region.y);
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${clamp01(region.w) * 100}%`,
        height: `${clamp01(region.h) * 100}%`,
        border: `2px solid ${color}`,
        borderRadius: 4,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.65), inset 0 0 0 1px rgba(255,255,255,0.45)',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: -9,
          left: -9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 17,
          height: 17,
          padding: '0 4px',
          borderRadius: 999,
          background: color,
          color: '#fff',
          fontSize: 10.5,
          fontWeight: 800,
          boxShadow: '0 0 0 1.5px rgba(255,255,255,0.85)',
        }}
      >
        {n}
      </span>
    </div>
  );
}

/** Findings that carry a region, with their 1-based display number. */
const regionsOf = (findings: MockupFinding[]) =>
  findings.flatMap((f, i) => (f.region ? [{ n: i + 1, region: f.region, color: sevColor(f.severity) }] : []));

/** Drag-to-draw layer for edit mode: mousedown→drag→mouseup emits the drawn
 *  box normalized to this layer (which is sized to the image content rect).
 *  Esc or a sub-1% drag cancels. */
function DrawLayer({ onCommit, onCancel }: { onCommit: (r: FindingRegion) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  const norm = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const box =
    start && cur
      ? {
          x: Math.min(start.x, cur.x),
          y: Math.min(start.y, cur.y),
          w: Math.abs(cur.x - start.x),
          h: Math.abs(cur.y - start.y),
        }
      : null;
  return (
    <div
      ref={ref}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = norm(e);
        setStart(p);
        setCur(p);
      }}
      onMouseMove={(e) => {
        if (start) setCur(norm(e));
      }}
      onMouseUp={(e) => {
        e.stopPropagation();
        if (box && box.w > 0.01 && box.h > 0.01) onCommit(box);
        else onCancel();
      }}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair', background: 'rgba(15,18,24,0.12)' }}
    >
      {box ? (
        <div
          style={{
            position: 'absolute',
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.w * 100}%`,
            height: `${box.h * 100}%`,
            border: `2px dashed ${T.accent}`,
            borderRadius: 4,
            background: 'rgba(255,255,255,0.15)',
          }}
        />
      ) : null}
    </div>
  );
}

/** Full-screen zoom for a mockup image. Backdrop click / ✕ / Esc close it;
 *  clicking the image itself does not, so a mis-aimed pan doesn't dismiss.
 *  The lightbox usually opens INSIDE another modal (the Quick-result PlModal
 *  hangs its own Escape closer on window and a click-outside closer on its
 *  backdrop) — so every dismiss event here must be swallowed (capture-phase
 *  Esc + stopPropagation on clicks), otherwise one Esc/click closes both
 *  layers at once. */
function Lightbox({
  src,
  alt,
  regions,
  onClose,
}: {
  src: string;
  alt: string;
  regions?: Array<{ n: number; region: FindingRegion; color: string }>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={alt}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, padding: 28, background: 'rgba(15, 18, 24, 0.85)', cursor: 'zoom-out' }}
    >
      <button
        type="button"
        onClick={onClose}
        title="Đóng (Esc)"
        style={{ position: 'absolute', top: 14, right: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, border: 0, borderRadius: 999, background: 'rgba(255,255,255,0.14)', color: '#fff', cursor: 'pointer' }}
      >
        <Icon name="close" size={16} />
      </button>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', cursor: 'default' }}>
        <img
          src={src}
          alt={alt}
          style={{ display: 'block', maxWidth: '94vw', maxHeight: '88vh', borderRadius: 10, background: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
        />
        {regions?.map((r) => (
          <RegionBox key={r.n} n={r.n} region={r.region} color={r.color} />
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)' }}>{alt}</div>
    </div>
  );
}

/** report.json's `feature_text` usually arrives as ONE flattened line —
 *  `<screen title> **Ý nghĩa màn hình:** … | <validation note> | BR-005: …` —
 *  the review agent joins the doc's segments with " | " when excerpting.
 *  Rebuild lightweight structure for display: the pre-bold screen title
 *  becomes a heading, each |-separated segment its own bullet. An excerpt
 *  that already spans multiple lines is real markdown — pass it through. */
export function formatFeatureText(text: string): string {
  const t = text.trim();
  if (t.includes('\n')) return t;
  const boldIdx = t.indexOf('**');
  let title = '';
  let body = t;
  // Only treat the pre-bold prefix as a title when it is short enough to BE
  // one — a bold phrase deep inside a long sentence is not a heading split.
  if (boldIdx > 0 && boldIdx <= 120) {
    title = t.slice(0, boldIdx).trim();
    body = t.slice(boldIdx).trim();
  }
  const segments = body.split(/\s+\|\s+/).map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  if (title) lines.push(`### ${title}`);
  if (segments.length > 1) lines.push(...segments.map((s) => `- ${s}`));
  else if (segments.length === 1) lines.push(segments[0]!);
  return lines.length ? lines.join('\n') : t;
}

/** "Text trong tài liệu" — the VERBATIM excerpt the docs stage extracted next
 *  to the mockup. The docs stage converts Confluence/BAS pages to Markdown, so
 *  the excerpt renders through the app's markdown walker (headings, bullets,
 *  tables) after `formatFeatureText` restores its structure. Long excerpts
 *  collapse to a fixed height with a "Xem thêm" toggle so the mockup column
 *  stays scannable. */
const FEATURE_TEXT_COLLAPSED_MAX = 200;
function FeatureTextBox({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const formatted = useMemo(() => formatFeatureText(text), [text]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) setOverflows(el.scrollHeight > FEATURE_TEXT_COLLAPSED_MAX + 16);
  }, [formatted]);
  const collapsed = overflows && !expanded;
  return (
    <div style={{ borderRadius: 9, border: `1px solid ${T.border}`, padding: '11px 13px', background: T.paper }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.soft, marginBottom: 7 }}>
        <Icon name="file" size={12} />
        Text trong tài liệu
      </div>
      <div style={{ position: 'relative' }}>
        <div
          ref={bodyRef}
          className={styles.prose}
          style={{ maxHeight: collapsed ? FEATURE_TEXT_COLLAPSED_MAX : undefined, overflow: 'hidden' }}
        >
          {renderMarkdown(formatted)}
        </div>
        {collapsed ? (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44, background: `linear-gradient(to bottom, transparent, ${T.paper})`, pointerEvents: 'none' }} />
        ) : null}
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, border: 0, padding: 0, background: 'transparent', fontSize: 12, fontWeight: 600, color: T.accent, cursor: 'pointer' }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          {expanded ? 'Thu gọn' : 'Xem thêm'}
        </button>
      ) : null}
    </div>
  );
}

const SEV_CARD_CLASS: Record<Severity, string> = {
  blocker: styles.findingBlocker!,
  major: styles.findingMajor!,
  minor: styles.findingMinor!,
};
const SEV_BADGE_CLASS: Record<Severity, string> = {
  blocker: styles.sevBlocker!,
  major: styles.sevMajor!,
  minor: styles.sevMinor!,
};

/** Read-mode rendering of one finding — formatted text, no form controls.
 *  Severity colors the card's left border + badge; the recommendation sits
 *  in its own accent callout so the actionable part stands out from the
 *  issue analysis. */
function FindingView({
  finding,
  index,
  onShowCode,
}: {
  finding: MockupFinding;
  index: number;
  /** Mở modal chú thích, cuộn tới mã này. */
  onShowCode: (code: string) => void;
}) {
  const sev: Severity = finding.severity ?? 'minor';
  return (
    <div className={`${styles.finding} ${SEV_CARD_CLASS[sev]}`}>
      <div className={styles.findingHead}>
        <span
          title={finding.region ? 'Số khung khoanh trên ảnh' : undefined}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 17, height: 17, padding: '0 4px', borderRadius: 999, background: sevColor(sev), color: '#fff', fontSize: 10.5, fontWeight: 800 }}
        >
          {index}
        </span>
        <span className={`${styles.sevBadge} ${SEV_BADGE_CLASS[sev]}`}>{sevLabel(sev)}</span>
        {finding.heuristic ? (
          <button
            type="button"
            onClick={() => onShowCode(finding.heuristic!)}
            title="Xem chú thích mã này"
            className={styles.heuristicChip}
            style={{ cursor: 'pointer' }}
          >
            {finding.heuristic}
          </button>
        ) : null}
        <span className={styles.findingKind}>
          {finding.kind === 'heuristic' ? 'Heuristic UX' : 'Lệch mockup ↔ text'}
        </span>
      </div>
      {finding.issue ? <p className={styles.findingIssue}>{finding.issue}</p> : null}
      {finding.recommendation ? (
        <div className={styles.reco}>
          <span className={styles.recoIcon}>
            <Icon name="sparkles" size={13} />
          </span>
          <span>
            <span className={styles.recoLabel}>Đề xuất: </span>
            {finding.recommendation}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function FindingRow({
  finding,
  index,
  drawing,
  onChange,
  onRemove,
  onDrawRegion,
  onClearRegion,
}: {
  finding: MockupFinding;
  index: number;
  /** True while the user is drag-drawing THIS finding's region on the image. */
  drawing: boolean;
  onChange: (next: MockupFinding) => void;
  onRemove: () => void;
  onDrawRegion: () => void;
  onClearRegion: () => void;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12.5,
    color: T.ink,
    background: T.paper,
    fontFamily: 'inherit',
  };
  return (
    <div style={{ border: `1px solid ${drawing ? T.accent : T.border}`, borderRadius: 9, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 17, height: 17, padding: '0 4px', borderRadius: 999, background: sevColor(finding.severity), color: '#fff', fontSize: 10.5, fontWeight: 800 }}>
          {index}
        </span>
        <select
          value={finding.severity ?? 'minor'}
          onChange={(e) => onChange({ ...finding, severity: e.target.value as Severity })}
          style={{ ...inputStyle, width: 'auto', fontWeight: 700, color: sevColor(finding.severity) }}
        >
          <option value="blocker">Nghiêm trọng</option>
          <option value="major">Nặng</option>
          <option value="minor">Nhẹ</option>
        </select>
        <select
          value={finding.kind ?? 'mismatch'}
          onChange={(e) => onChange({ ...finding, kind: e.target.value as FindingKind })}
          style={{ ...inputStyle, width: 'auto' }}
        >
          <option value="mismatch">Lệch mockup ↔ text</option>
          <option value="heuristic">Heuristic UX</option>
        </select>
        {finding.kind === 'heuristic' ? (
          <input
            value={finding.heuristic ?? ''}
            onChange={(e) => onChange({ ...finding, heuristic: e.target.value })}
            placeholder="N.5"
            style={{ ...inputStyle, width: 64, fontFamily: 'ui-monospace, monospace' }}
          />
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          title="Xoá nhận xét"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', border: 0, background: 'transparent', color: T.faint, cursor: 'pointer', padding: 4 }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <textarea
        value={finding.issue ?? ''}
        onChange={(e) => onChange({ ...finding, issue: e.target.value })}
        placeholder="Vấn đề…"
        rows={2}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      <textarea
        value={finding.recommendation ?? ''}
        onChange={(e) => onChange({ ...finding, recommendation: e.target.value })}
        placeholder="Khuyến nghị…"
        rows={2}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onDrawRegion}
          disabled={drawing}
          style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px ${drawing ? 'solid' : 'dashed'} ${T.accent}`, borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: T.accent, background: 'transparent', cursor: drawing ? 'default' : 'pointer' }}
        >
          <Icon name="draw" size={13} />
          {drawing
            ? 'Đang khoanh — kéo chuột trên ảnh (Esc để hủy)'
            : finding.region
              ? 'Vẽ lại vùng khoanh'
              : 'Khoanh vùng trên ảnh'}
        </button>
        {finding.region && !drawing ? (
          <button
            type="button"
            onClick={onClearRegion}
            style={{ display: 'flex', alignItems: 'center', gap: 5, border: 0, borderRadius: 7, padding: '5px 8px', fontSize: 12, fontWeight: 600, color: T.soft, background: 'transparent', cursor: 'pointer' }}
          >
            <Icon name="close" size={12} />
            Xóa vùng
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ImageCard({
  image,
  projectId,
  reportFileName,
  editing,
  onChange,
  onShowCode,
}: {
  image: MockupReviewImage;
  projectId: string;
  reportFileName: string;
  editing: boolean;
  onChange: (next: MockupReviewImage) => void;
  onShowCode: (code: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [zoom, setZoom] = useState(false);
  /** Index of the finding whose region is being drag-drawn, or null. */
  const [drawFor, setDrawFor] = useState<number | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const contentRect = useImageContentRect(imgRef);
  useEffect(() => {
    if (!editing) setDrawFor(null);
  }, [editing]);
  const findings = image.findings ?? [];
  const { score, verdict } = useMemo(() => scoreImage(findings), [findings]);
  const counts = useMemo(() => {
    let blockers = 0, majors = 0, minors = 0;
    for (const f of findings) {
      if (f.severity === 'blocker') blockers += 1;
      else if (f.severity === 'major') majors += 1;
      else if (f.severity === 'minor') minors += 1;
    }
    return { blockers, majors, minors };
  }, [findings]);

  const setFindings = (next: MockupFinding[]) => onChange({ ...image, findings: next });
  const addFinding = () =>
    setFindings([...findings, { kind: 'mismatch', severity: 'minor', issue: '', recommendation: '' }]);
  const updateFinding = (i: number, next: MockupFinding) =>
    setFindings(findings.map((f, idx) => (idx === i ? next : f)));
  const removeFinding = (i: number) => {
    setDrawFor(null);
    setFindings(findings.filter((_, idx) => idx !== i));
  };

  const imageUrl = projectRawUrl(projectId, resolveImagePath(reportFileName, image.path));
  const imageAlt = image.page ?? image.path;

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 11, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '11px 14px', background: T.paper, border: 0, cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>{image.page ?? image.path}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {findings.length ? <span style={{ fontSize: 11.5, color: T.soft }}>{findings.length} vấn đề</span> : null}
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: T.ink }}>{score}</span>
          <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: verdictColor(verdict) }}>
            {verdictLabel(verdict)}
          </span>
        </span>
      </button>
      {open ? (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* top — the REAL mockup image from the source doc, full card width
           *  so a desktop-wide mockup is actually readable; tall mobile shots
           *  letterbox inside the height cap. Click = zoom. */}
          <div style={{ position: 'relative', width: '100%' }}>
            <img
              ref={imgRef}
              src={imageUrl}
              alt={imageAlt}
              onClick={() => {
                if (drawFor == null) setZoom(true);
              }}
              title={drawFor == null ? 'Phóng to ảnh' : undefined}
              style={{ width: '100%', maxHeight: 560, objectFit: 'contain', borderRadius: 9, border: `1px solid ${T.border}`, background: T.subtle, display: 'block', cursor: drawFor == null ? 'zoom-in' : 'crosshair' }}
            />
            {/* region callouts, anchored to the drawn image content (not the letterbox) */}
            {contentRect ? (
              <div style={{ position: 'absolute', left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height, pointerEvents: 'none' }}>
                {regionsOf(findings).map((r) => (
                  <RegionBox key={r.n} n={r.n} region={r.region} color={r.color} />
                ))}
              </div>
            ) : null}
            {contentRect && drawFor != null ? (
              <div style={{ position: 'absolute', left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height }}>
                <DrawLayer
                  onCommit={(region) => {
                    const f = findings[drawFor];
                    if (f) updateFinding(drawFor, { ...f, region });
                    setDrawFor(null);
                  }}
                  onCancel={() => setDrawFor(null)}
                />
              </div>
            ) : null}
            {drawFor == null ? (
              <button
                type="button"
                onClick={() => setZoom(true)}
                title="Phóng to ảnh"
                style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: 0, background: 'rgba(15,18,24,0.55)', color: '#fff', cursor: 'zoom-in' }}
              >
                <Icon name="zoom-in" size={14} />
              </button>
            ) : (
              <div style={{ position: 'absolute', left: '50%', bottom: 10, transform: 'translateX(-50%)', padding: '5px 12px', borderRadius: 999, background: 'rgba(15,18,24,0.75)', color: '#fff', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                Kéo chuột trên ảnh để khoanh vùng #{drawFor + 1} — Esc để hủy
              </div>
            )}
          </div>
          {zoom ? <Lightbox src={imageUrl} alt={imageAlt} regions={regionsOf(findings)} onClose={() => setZoom(false)} /> : null}
          {/* bottom — doc excerpt & findings side by side */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: image.feature_text ? 'minmax(0, 5fr) minmax(0, 7fr)' : 'minmax(0, 1fr)',
              gap: 16,
              alignItems: 'start',
            }}
          >
            {image.feature_text ? <FeatureTextBox text={image.feature_text} /> : null}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11.5 }}>
              <span style={{ fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: T.soft }}>Đánh giá</span>
              <span style={{ color: T.red }}>● {counts.blockers} nghiêm trọng</span>
              <span style={{ color: T.amber }}>● {counts.majors} nặng</span>
              <span style={{ color: T.soft }}>● {counts.minors} nhẹ</span>
            </div>
            {findings.length === 0 && !editing ? (
              <div style={{ border: `1px dashed ${T.border}`, borderRadius: 9, padding: '18px 12px', textAlign: 'center', fontSize: 12.5, color: T.soft }}>
                Không có vi phạm — mockup này đạt.
              </div>
            ) : null}
            {findings.map((f, i) =>
              editing ? (
                <FindingRow
                  key={i}
                  finding={f}
                  index={i + 1}
                  drawing={drawFor === i}
                  onChange={(next) => updateFinding(i, next)}
                  onRemove={() => removeFinding(i)}
                  onDrawRegion={() => setDrawFor(i)}
                  onClearRegion={() => updateFinding(i, { ...f, region: undefined })}
                />
              ) : (
                <FindingView key={i} finding={f} index={i + 1} onShowCode={onShowCode} />
              ),
            )}
            {editing ? (
              <button
                type="button"
                onClick={addFinding}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: `1px dashed ${T.border}`, borderRadius: 9, padding: '9px 12px', fontSize: 12.5, fontWeight: 600, color: T.accent, background: 'transparent', cursor: 'pointer' }}
              >
                <Icon name="plus" size={13} />
                Thêm nhận xét
              </button>
            ) : null}
            {!editing && image.passes?.length ? (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: '9px 13px', background: T.subtle, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {image.passes.map((p, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, lineHeight: 1.55, color: T.ink }}>
                    <span style={{ color: T.green, flexShrink: 0, display: 'flex', marginTop: 2 }}>
                      <Icon name="check" size={12} />
                    </span>
                    {p}
                  </div>
                ))}
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DocsReviewPreview({
  projectId,
  fileName,
  report,
  onSaved,
}: {
  projectId: string;
  /** The report.json's project-relative path — the Save target and the
   *  first file bundled into Export. */
  fileName: string;
  report: DocsMockupReviewReport;
  /** Called after a successful Save so the caller can bump its reload key
   *  and re-derive the on-disk state from the freshly written file. */
  onSaved?: () => void;
}) {
  const [images, setImages] = useState<MockupReviewImage[]>(report.images ?? []);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** null = modal chú thích đóng; '' = mở không focus; khác rỗng = focus mã đó. */
  const [glossary, setGlossary] = useState<string | null>(null);
  const [uxr, setUxr] = useState<UxrCriterion[] | null>(null);
  const uxrFetched = useRef(false);

  // Mã UXR-xx là động theo run — đọc từ report ux-research nằm cạnh report
  // review trong cùng thư mục workflow. Tải MỘT lần, khi modal mở lần đầu;
  // thiếu file / lỗi mạng thì fail-soft (modal vẫn mở, phần UXR hiện hint).
  useEffect(() => {
    if (glossary === null || uxrFetched.current) return;
    uxrFetched.current = true;
    void (async () => {
      try {
        const url = projectRawUrl(projectId, resolveImagePath(fileName, 'ux-research/report.json'));
        const resp = await fetch(url);
        if (!resp.ok) return;
        const json = (await resp.json()) as { criteria?: Array<Record<string, unknown>> };
        const items: UxrCriterion[] = (json.criteria ?? [])
          .filter((c) => typeof c?.id === 'string' && typeof c?.title === 'string')
          .map((c) => ({
            id: c.id as string,
            title: c.title as string,
            statement: typeof c.statement === 'string' ? c.statement : undefined,
          }));
        if (items.length) setUxr(items);
      } catch {
        /* fail-soft — modal hiện hint thay vì crash */
      }
    })();
  }, [glossary, projectId, fileName]);

  // A fresh report from disk (re-run, or a reload after Save) replaces local
  // edits — but not while an in-flight edit session is dirty, so a Save that
  // races a background poll never clobbers what the user just typed.
  useEffect(() => {
    if (!dirty) setImages(report.images ?? []);
  }, [report, dirty]);

  const { verdict, score, counts } = useMemo(() => {
    let blockers = 0, majors = 0, minors = 0;
    const scores: number[] = [];
    let worst: Verdict = 'pass';
    for (const img of images) {
      const { score: s, verdict: v } = scoreImage(img.findings ?? []);
      scores.push(s);
      if (v === 'fail') worst = 'fail';
      else if (v === 'warn' && worst !== 'fail') worst = 'warn';
      for (const f of img.findings ?? []) {
        if (f.severity === 'blocker') blockers += 1;
        else if (f.severity === 'major') majors += 1;
        else if (f.severity === 'minor') minors += 1;
      }
    }
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
    return { verdict: worst, score: avg, counts: { blockers, majors, minors } };
  }, [images]);

  const updateImage = (id: string, next: MockupReviewImage) => {
    setDirty(true);
    setImages((prev) => prev.map((img) => (img.id === id ? next : img)));
  };

  async function save(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const nextReport: DocsMockupReviewReport = {
        ...report,
        kind: 'docs-mockup-review',
        summary: { images: images.length, score, verdict, ...counts },
        images,
      };
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fileName, content: JSON.stringify(nextReport, null, 2) }),
      });
      if (!resp.ok) {
        const payload = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Lưu thất bại (${resp.status})`);
      }
      setDirty(false);
      onSaved?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lưu thất bại');
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Save (if dirty) then drop back to read mode — stays in edit on failure
   *  so nothing typed is lost behind an error. */
  async function saveAndClose() {
    if (dirty && !(await save())) return;
    setEditing(false);
  }

  /** Discard local edits: restore the on-disk report and leave edit mode. */
  function cancelEditing() {
    setImages(report.images ?? []);
    setDirty(false);
    setError(null);
    setEditing(false);
  }

  async function exportPdf() {
    setExporting(true);
    setError(null);
    try {
      // Export what's on screen — save unsaved edits first so the PDF never
      // ships a stale review.
      if (dirty) await save();
      const slug = fileName.split('/').filter(Boolean).slice(-2, -1)[0] || 'review';
      const title = images.find((i) => i.page)?.page || slug;
      const fragment = await buildReviewHtmlForReport(projectId, fileName, images, 2);
      await exportReviewPdf(`Review mockup — ${title}`, [fragment], `review-${slug}.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Xuất file thất bại');
    } finally {
      setExporting(false);
    }
  }

  if (!images.length) {
    return <div style={{ padding: 16, color: T.muted }}>Report review chưa có mockup nào để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
      {/* summary strip + actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: 14 }}>
        {typeof score === 'number' ? (
          <div style={{ display: 'grid', width: 48, height: 48, flexShrink: 0, placeItems: 'center', borderRadius: 12, background: verdictColor(verdict), color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 17, fontWeight: 700 }}>{score}</div>
        ) : null}
        <div>
          <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: verdictColor(verdict) }}>{verdictLabel(verdict)}</span>
          <div style={{ marginTop: 6, display: 'flex', gap: 14, fontSize: 12 }}>
            <span style={{ color: T.red }}>● {counts.blockers} nghiêm trọng</span>
            <span style={{ color: T.amber }}>● {counts.majors} nặng</span>
            <span style={{ color: T.soft }}>● {counts.minors} nhẹ</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {error ? <span style={{ fontSize: 12, color: T.red }}>{error}</span> : null}
          {dirty ? <span style={{ fontSize: 11.5, fontWeight: 600, color: T.amber }}>Chưa lưu</span> : null}
          <button
            type="button"
            onClick={() => setGlossary('')}
            title="Chú thích các mã N.x / D.x / UXR-xx"
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: T.soft, background: T.paper, cursor: 'pointer' }}
          >
            <Icon name="help-circle" size={13} />
            Chú thích
          </button>
          {editing ? (
            <>
              <button
                type="button"
                onClick={cancelEditing}
                disabled={saving}
                style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: T.soft, background: T.paper, cursor: 'pointer' }}
              >
                <Icon name="close" size={13} />
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void saveAndClose()}
                disabled={saving}
                style={{ display: 'flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: '#fff', background: T.accent, cursor: 'pointer' }}
              >
                <Icon name={saving ? 'spinner' : 'check'} size={13} />
                {saving ? 'Đang lưu…' : 'Lưu'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: T.accent, background: T.paper, cursor: 'pointer' }}
              >
                <Icon name="edit" size={13} />
                Chỉnh sửa
              </button>
              <button
                type="button"
                onClick={() => void exportPdf()}
                disabled={exporting}
                title="Xuất báo cáo review dạng PDF, ảnh nhúng sẵn — đưa phòng ban khác đọc & sửa docs"
                style={{ display: 'flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: '#fff', background: T.accent, cursor: 'pointer' }}
              >
                <Icon name={exporting ? 'spinner' : 'download'} size={13} />
                {exporting ? 'Đang xuất…' : 'Xuất review (PDF)'}
              </button>
            </>
          )}
        </div>
      </div>

      {images.map((img) => (
        <ImageCard
          key={img.id}
          image={img}
          projectId={projectId}
          reportFileName={fileName}
          editing={editing}
          onChange={(next) => updateImage(img.id, next)}
          onShowCode={(code) => setGlossary(code)}
        />
      ))}
      {glossary !== null ? <GlossaryModal uxr={uxr} focus={glossary || null} onClose={() => setGlossary(null)} /> : null}
    </div>
  );
}

/** Resolve a page report path (from index.json's `pages[].report`, relative to
 *  the index's own dir) to a project-relative path. */
function resolvePageReportPath(indexFileName: string, report: string): string {
  const dir = indexFileName.split('/').slice(0, -1).join('/');
  return dir ? `${dir}/${report}` : report;
}

const IDX_VERDICT_TONE: Record<Verdict, string> = {
  pass: 'var(--green, #16a34a)',
  warn: 'var(--amber, #b45309)',
  fail: 'var(--red, #dc2626)',
};

/** Per-page fan-out preview: reads review/index.json, loads each page's own
 *  report.json, and renders one collapsible section per page — each section is
 *  the full single-report editor (DocsReviewPreview) scoped to that page's
 *  report file, so edit/save/region-draw/glossary all work per page. */
export function DocsReviewIndexPreview({
  projectId,
  fileName,
  index,
}: {
  projectId: string;
  /** review/index.json's project-relative path. */
  fileName: string;
  index: DocsMockupReviewIndex;
}) {
  const pages = useMemo(
    () => (index.pages ?? []).filter((p) => p.report),
    [index],
  );
  const [reports, setReports] = useState<Record<string, DocsMockupReviewReport | null>>({});
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => {
    const worst = pages.findIndex((p) => p.verdict !== 'pass');
    const first = pages[worst === -1 ? 0 : worst];
    return new Set(first?.slug ? [first.slug] : []);
  });

  /** Combined PDF of EVERY page's review (one section per page, images inlined)
   *  — the whole review as a single file to hand off. */
  async function exportAllPdf() {
    setExporting(true);
    setExportErr(null);
    try {
      const fragments: string[] = [];
      for (const p of pages) {
        if (!p.report) continue;
        const reportFileName = resolvePageReportPath(fileName, p.report);
        const url = projectRawUrl(projectId, reportFileName);
        const report = (await fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as
          | DocsMockupReviewReport
          | null;
        if (!report?.images?.length) continue;
        fragments.push(await buildReviewHtmlForReport(projectId, reportFileName, report.images, 2));
      }
      if (!fragments.length) throw new Error('Không có trang nào để xuất');
      await exportReviewPdf('Báo cáo review mockup (toàn bộ)', fragments, 'review-tong-hop.pdf');
    } catch (err) {
      setExportErr(err instanceof Error ? err.message : 'Xuất file thất bại');
    } finally {
      setExporting(false);
    }
  }

  const loadReport = (slug: string, reportPath: string) => {
    if (reports[slug] !== undefined) return;
    const url = projectRawUrl(projectId, resolvePageReportPath(fileName, reportPath));
    void fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setReports((prev) => ({ ...prev, [slug]: (json as DocsMockupReviewReport) ?? null })))
      .catch(() => setReports((prev) => ({ ...prev, [slug]: null })));
  };

  const toggle = (slug: string, reportPath: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else {
        next.add(slug);
        loadReport(slug, reportPath);
      }
      return next;
    });
  };

  // Auto-load the initially-open page.
  useEffect(() => {
    for (const p of pages) if (p.slug && open.has(p.slug) && p.report) loadReport(p.slug, p.report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  const s = index.summary ?? {};
  const verdict: Verdict = asVerdict(s.verdict);

  if (!pages.length) {
    return <div style={{ padding: 16, color: T.muted }}>Report review chưa có trang nào để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      {/* project roll-up */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: 14 }}>
        {typeof s.score === 'number' ? (
          <div style={{ display: 'grid', width: 48, height: 48, flexShrink: 0, placeItems: 'center', borderRadius: 12, background: verdictColor(verdict), color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 17, fontWeight: 700 }}>{s.score}</div>
        ) : null}
        <div>
          <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: verdictColor(verdict) }}>{verdictLabel(verdict)}</span>
          <div style={{ marginTop: 6, display: 'flex', gap: 14, fontSize: 12 }}>
            <span style={{ color: T.red }}>● {s.blockers ?? 0} nghiêm trọng</span>
            <span style={{ color: T.amber }}>● {s.majors ?? 0} nặng</span>
            <span style={{ color: T.soft }}>● {s.minors ?? 0} nhẹ</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: T.soft }}>{pages.length} trang · {s.images ?? 0} mockup</span>
          {exportErr ? <span style={{ fontSize: 12, color: T.red }}>{exportErr}</span> : null}
          <button
            type="button"
            onClick={() => void exportAllPdf()}
            disabled={exporting}
            title="Xuất toàn bộ review thành 1 file PDF (ảnh nhúng sẵn) — đưa phòng ban khác đọc & sửa docs"
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: 0, borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: '#fff', background: T.accent, cursor: 'pointer' }}
          >
            <Icon name={exporting ? 'spinner' : 'download'} size={13} />
            {exporting ? 'Đang xuất…' : 'Xuất toàn bộ (PDF)'}
          </button>
        </div>
      </div>

      {/* one collapsible section per page */}
      {pages.map((p) => {
        const slug = p.slug ?? p.report ?? '';
        const isOpen = open.has(slug);
        const pv: Verdict = asVerdict(p.verdict);
        const rep = reports[slug];
        return (
          <div key={slug} style={{ border: `1px solid ${T.border}`, borderRadius: 11, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle(slug, p.report!)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '11px 14px', background: T.paper, border: 0, cursor: 'pointer', textAlign: 'left' }}
            >
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={15} />
              <span style={{ minWidth: 0, fontSize: 13.5, fontWeight: 650, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.page ?? slug}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                {p.images ? <span style={{ fontSize: 11.5, color: T.faint }}>{p.images} mockup</span> : null}
                <span style={{ display: 'flex', gap: 7, fontSize: 11.5 }}>
                  {p.blockers ? <span style={{ color: T.red }}>{p.blockers}NT</span> : null}
                  {p.majors ? <span style={{ color: T.amber }}>{p.majors}N</span> : null}
                </span>
                {typeof p.score === 'number' ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: T.ink }}>{p.score}</span> : null}
                <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: IDX_VERDICT_TONE[pv] }}>{verdictLabel(pv)}</span>
              </span>
            </button>
            {isOpen ? (
              rep === undefined ? (
                <div style={{ padding: 16, color: T.muted, fontSize: 12.5 }}>Đang tải báo cáo trang…</div>
              ) : rep === null ? (
                <div style={{ padding: 16, color: T.red, fontSize: 12.5 }}>Không đọc được report của trang này.</div>
              ) : (
                <div style={{ borderTop: `1px solid ${T.border}` }}>
                  <DocsReviewPreview
                    projectId={projectId}
                    fileName={resolvePageReportPath(fileName, p.report!)}
                    report={rep}
                    onSaved={() => setReports((prev) => ({ ...prev, [slug]: undefined as unknown as DocsMockupReviewReport }))}
                  />
                </div>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
