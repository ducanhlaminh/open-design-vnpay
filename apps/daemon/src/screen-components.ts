// Màn hình → Component (dr-comp v2, workflow `docs-review`) — pure helpers +
// the deterministic pre-step.
//
// v1 fanned out per DOCUMENT PAGE and could only see a screen when the page
// declared it as a `Màn hình N: SCR-… — …` heading followed by a table with a
// "Kiểu hiển thị" column. Most PRDs describe screens in prose, so the stage
// came back empty. v2 takes the screen list from the FLOW stage (dr-flow —
// `flows/index.json[].screens`, the flowchart nodes that happen on each
// screen, and the UX findings that touch it), treats any structure table in
// the document as a REFERENCE only, and asks the agent for ONE thing per
// screen: which Design System components the screen should be built from,
// drawn as an ux-spec-style HTML wireframe (`wireframes/<SCREEN-KEY>.html`)
// plus a machine-checkable `comp/<SCREEN-KEY>.screen.json`.
//
// Consistency across screens comes from a role-map pass (one agent per
// feature, `comp/_role-map.json`: role → DS component) that every per-screen
// run must follow. Everything the agent may cite is checked here against the
// closed catalogue (`criteria/components.md`) and the flow's screen list;
// nothing is checked against the literal document text any more.
//
// Pure (no DB, no agent). The stage runner in server.ts owns the run
// lifecycle and calls into this module before / after each agent run.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { FlowchartDoc } from './flow-ux/to-flowchart.js';
import type { FlowIndexEntry, UxReview } from './flow-ux/index.js';

export const SCREEN_COMPONENTS_SCHEMA_VERSION = '2.1' as const;
export const SCREEN_INPUTS_FILE = 'comp/_inputs.json';
export const ROLE_MAP_FILE = 'comp/_role-map.json';

/** `comp/<SCREEN-KEY>.screen.json` */
export const screenDocRel = (key: string): string => `comp/${key}.screen.json`;
/** `wireframes/<SCREEN-KEY>.html` */
export const wireframeRel = (key: string): string => `wireframes/${key}.html`;

// ── Inputs (daemon → agent) ────────────────────────────────────────────────

export interface ScreenStep {
  id: string;
  type: 'start' | 'end' | 'action' | 'decision';
  label: string;
}

export interface ScreenNav {
  /** SCREEN-KEY of the destination screen. */
  to: string;
  /** Label of the step / edge that leaves this screen (what the user does). */
  via: string;
  /** Edge label(s) along the way (decision outcomes), if any. */
  condition?: string;
}

/** WP32: nguồn canonical của một màn ở tầng flow/recovery. Field optional ở
 * mọi reader để artifact cũ tiếp tục chạy như trước. */
export type ScreenOriginProvenance = 'document' | 'flow' | 'inferred-flow';
export interface ScreenOriginEvidence {
  source: string;
  anchorText?: string;
  diagramEvidence?: Array<{ cellId: string; label: string }>;
}

export interface ScreenInput {
  key: string;
  name: string;
  /** Position in the flow (BFS from start) — the rail order. */
  order: number;
  flowId: string;
  flowTitle: string;
  /** Markdown page (relative to cwd) the screen belongs to (from the key prefix). */
  source: string | null;
  /** Section of `source` that describes this screen, when one was found. */
  section?: { heading: string; startLine: number; endLine: number; excerpt: string };
  /** A screen-structure table found inside that section — REFERENCE only. */
  referenceTable?: string;
  /** WP24a: ảnh mockup thật (tồn tại trên đĩa) tìm thấy trong khoảng dòng
   *  section của trang nguồn — đường dẫn tương đối từ cwd dự án, giữ thứ tự
   *  xuất hiện, khử trùng lặp, tối đa 6. Đây là NGUỒN SỰ THẬT về bố cục +
   *  nội dung khi kickoff màn liệt kê (server.ts); mảng rỗng/vắng = màn
   *  không có ảnh, agent tự dựng bố cục + nội dung mẫu. KHÔNG dùng để chọn
   *  component/anchor — việc đó vẫn chỉ dựa vào chữ tài liệu + DS. */
  mockups?: string[];
  /** Flowchart steps that happen on this screen. */
  steps: ScreenStep[];
  /** Ways out of this screen into other screens (→ `data-nav`). */
  navOut: ScreenNav[];
  /** Screens that lead here. */
  navIn: string[];
  /** UX findings (dr-flow) that touch this screen. */
  findings: { id: string; severity: string; title: string; recommendation?: string }[];
  /** 'mobile' | 'web' guess from the document wording — the agent decides. */
  platformHint: 'mobile' | 'web';
  /** screen-variants (docs/screen-variants-spec.md §3.1): nền tảng CỦA MÀN
   *  NÀY, suy từ chuỗi heading cha của section (WP-V1). Khi có, luôn thắng
   *  `platformHint`; vắng = tài liệu một-nền-tảng, dùng hint như cũ. */
  platform?: 'mobile' | 'web';
  /** Khóa nhóm màn nghiệp vụ (WP-V2) — biến thể MB/IB của cùng màn chung
   *  groupKey. Vắng = màn đứng một mình (nhóm 1 phần tử ngầm định). */
  groupKey?: string;
  /** Where this screen came from — 'flow' (mặc định) khi dr-flow gắn được;
   *  'doc' khi dr-flow gắn KHÔNG màn nào và daemon phải quét heading tài
   *  liệu thay (sự cố #5d13309f); 'agent' khi lớp 2 (screen-extract.ts) trích
   *  màn bằng agent lúc lớp 1 (quét tất định) yếu; 'user' khi lớp 3
   *  (screen-overrides.ts) ghi đè theo yêu cầu người dùng. Union CHÍNH THỨC
   *  hợp nhất tại WP14 — trước đó 'agent'/'user' chỉ tồn tại qua cast cục bộ
   *  ở hai module song song (WP12/WP13a) vì file này đang bị WP11 sửa cùng
   *  lúc. Cho agent/người đọc biết vì sao `steps`/`navOut`/`navIn` rỗng. */
  origin?: 'flow' | 'doc' | 'agent' | 'user';
  /** WP32: provenance/evidence canonical từ flows/index.json[].screens[]. */
  provenance?: ScreenOriginProvenance;
  confidence?: number;
  evidence?: ScreenOriginEvidence;
  /** WP nested-blocks-A (2026-08-25): "khối bổ sung" của màn này mà BA đặt
   *  RỜI ở chỗ khác trong tài liệu (vd "Voucher" trong màn "Mua SIM") —
   *  `resolveDocScreens` (nhánh `discovered`) gắn vào đây bằng `anchorText`
   *  khớp DUY NHẤT, KHÔNG cần nằm trong `section` của màn cha (non-contiguous
   *  OK). Rỗng/không có block hợp lệ → field vắng (undefined), không `[]`.
   *  Block không bao giờ tự thành `ScreenInput` riêng. dr-comp (SCREEN mode,
   *  server.ts — WP-B) đọc thêm các khoảng dòng `section` này như một phần
   *  của màn. */
  blocks?: { name: string; section: NonNullable<ScreenInput['section']> }[];
}

export interface ScreenComponentsInputs {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  generatedAt: string;
  ds: { components: boolean; catalog: boolean; rules: boolean; examples: boolean; figmaCatalog: boolean };
  screens: ScreenInput[];
  /** Why the list is empty / partial. */
  note?: string;
}

// ── Outputs (agent → daemon) ───────────────────────────────────────────────

export interface RoleMapEntry {
  role: string;
  /** DS component name as written in criteria/components.md (null = DS has nothing for it). */
  component: string | null;
  anchor?: string;
  variant?: string;
  when?: string;
  /** What to use instead when `component` is null. */
  fallback?: string;
}
export interface RoleMapDoc {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  platform: 'mobile' | 'web';
  roles: RoleMapEntry[];
  notes?: string[];
  /** Daemon-side normalisations (see ScreenComponentsDoc.warnings). */
  warnings?: string[];
}

export type Provenance = 'text' | 'flow' | 'table' | 'ds';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScreenElement {
  /** Stable id inside the screen — the wireframe block carries `data-el` = this. */
  id: string;
  label: string;
  role: string;
  ds: { component: string; anchor: string; variant?: string } | null;
  confidence: Confidence;
  provenance: Provenance;
  /** What the document's own table declared for it (reference only). */
  docType?: string;
  why?: string;
  /** WP24a: nội dung thật của element — chép từ ảnh mockup (khi có) hay từ
   *  chữ tài liệu/bảng field, hoặc do agent tự đặt (nội dung mẫu thực tế) khi
   *  màn không có ảnh. Chỉ 5 khoá này được nhận; khoá lạ / kiểu sai bị
   *  parseScreenComponentsDoc bỏ kèm warning (không hard-fail). */
  content?: { text?: string; secondary?: string; value?: string; badge?: string; items?: string[] };
}

export interface ScreenComponentsDoc {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  key: string;
  name: string;
  flowId: string;
  platform: 'mobile' | 'web';
  source: string | null;
  elements: ScreenElement[];
  nav: { el: string; to: string }[];
  notes?: string[];
  /** Daemon-side normalisations applied to the agent's output (component
   *  name resolved to the catalogue's canonical name, unknown component
   *  dropped to `ds: null`, stray wireframe attributes stripped…). Shown in
   *  the viewer so a reader knows what was corrected. */
  warnings?: string[];
  /** WP24a: 'doc-image' khi màn có ảnh mockup thật (ScreenInput.mockups
   *  không rỗng), 'agent' khi không. Daemon ghi ĐÈ giá trị này SAU normalize
   *  (server.ts, chỗ ghi đè key/name/flowId/source) — nó tự biết đã đưa ảnh
   *  vào kickoff hay chưa, không hỏi agent để tránh ảo giác. */
  layoutSource?: 'doc-image' | 'agent';
  /** WP32: daemon truyền nguyên metadata của ScreenInput vào manifest. */
  provenance?: ScreenOriginProvenance;
  confidence?: number;
  evidence?: ScreenOriginEvidence;
}

// ── Prepare ────────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}
async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function normalizeVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split `<prefix>__<code>` — the SCREEN-KEY convention shared with dr-flow. */
export function splitScreenKey(key: string): { prefix: string; code: string } | null {
  const i = key.lastIndexOf('__');
  if (i <= 0 || i + 2 >= key.length) return null;
  return { prefix: key.slice(0, i), code: key.slice(i + 2) };
}

/** Find the section of a page that describes a screen: a heading containing
 *  the screen code (`SCR-001`, `4.2.1`) or, failing that, the screen name.
 *  Returns 1-based inclusive line range up to the next heading of the same
 *  or a higher level.
 *
 *  WP11 (sweep WP10, nguyên nhân 3 — DÒNG BOLD, xem docblock trên
 *  matchBoldScreenLine): khi KHÔNG heading nào khớp, thử tiếp trong các dòng
 *  bold-khai-màn đứng riêng — Group-Chia-se-nhom.md thật không có heading MH
 *  nào nên trước WP11 hàm này luôn trả `null` cho mọi màn dù tài liệu khai
 *  đủ. Section của một màn bold không có "cấp heading" để so — chạy tới
 *  heading kế tiếp (MỌI cấp) HOẶC dòng bold-khai-màn kế tiếp, tuỳ cái nào
 *  đứng trước; không có cái nào phía sau thì chạy tới cuối tài liệu.
 *
 *  WP11b (review độc lập wave 1, lỗi chặn): `boldLines` (biên section, dùng
 *  ở `matchIn`/`nextBoldLine` bên dưới) PHẢI chỉ gồm dòng bold-KHAI-MÀN qua
 *  `matchBoldScreenLine` — nhất quán với `scanDocScreens` (dùng đúng hàm này
 *  để dựng `boldDecls`). Trước WP11b, dòng dùng nhầm `matchBoldLineText`
 *  (khớp MỌI dòng bold đứng riêng, kể cả `**Ghi chú:**`/`**Lưu ý:**` không
 *  khai màn nào) — một dòng ghi-chú/lưu-ý chen giữa nội dung màn bold làm
 *  `nextBoldLine` cắt section cụt sớm, excerpt/endLine hụt phần sau. */
export function findScreenSection(
  md: string,
  code: string,
  name: string,
): { heading: string; startLine: number; endLine: number; excerpt: string; referenceTable?: string } | null {
  const lines = md.split(/\r?\n/);
  const headings: { line: number; level: number; text: string }[] = [];
  const boldLines: { line: number; text: string }[] = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence == null) fence = f[1]!;
      else if (raw.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = HEADING_RE.exec(raw);
    if (m) {
      headings.push({ line: i, level: m[1]!.length, text: m[2]!.trim() });
      return;
    }
    // WP11b: chỉ dòng bold-KHAI-MÀN (matchBoldScreenLine) mới được tính là
    // biên section — xem docblock trên findScreenSection.
    const boldScreen = matchBoldScreenLine(raw);
    if (boldScreen != null) boldLines.push({ line: i, text: matchBoldLineText(raw)! });
  });
  const codeNorm = normalizeVi(code);
  const nameNorm = normalizeVi(name);
  const codeRe = new RegExp(`(^|[^\\w.])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i');
  const matchIn = <T extends { text: string }>(entries: T[]): T | undefined =>
    entries.find((e) => codeRe.test(e.text)) ??
    entries.find((e) => normalizeVi(e.text).includes(codeNorm) && codeNorm.length >= 3) ??
    (nameNorm.length >= 4 ? entries.find((e) => normalizeVi(e.text).includes(nameNorm)) : undefined);

  let startLine: number;
  let end: number;
  const headingHit = matchIn(headings);
  if (headingHit) {
    const idx = headings.indexOf(headingHit);
    startLine = headingHit.line;
    end = lines.length - 1;
    for (let j = idx + 1; j < headings.length; j += 1) {
      if (headings[j]!.level <= headingHit.level) {
        end = headings[j]!.line - 1;
        break;
      }
    }
  } else {
    const boldHit = matchIn(boldLines);
    if (!boldHit) return null;
    startLine = boldHit.line;
    const nextHeadingLine = headings.find((h) => h.line > boldHit.line)?.line;
    const nextBoldLine = boldLines.find((b) => b.line > boldHit.line)?.line;
    const bounds = [nextHeadingLine, nextBoldLine].filter((x): x is number => x != null);
    end = bounds.length ? Math.min(...bounds) - 1 : lines.length - 1;
  }
  const body = lines.slice(startLine + 1, end + 1);
  // Reference table: a markdown table whose header row mentions "Kiểu hiển thị"
  // (or "Component"/"Loại") — the v1 contract, now advisory.
  let referenceTable: string | undefined;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (!l.trim().startsWith('|')) continue;
    const head = normalizeVi(l);
    if (!(head.includes('kieu hien thi') || head.includes('component') || head.includes('loai dieu khien'))) continue;
    let j = i;
    while (j < body.length && body[j]!.trim().startsWith('|')) j += 1;
    referenceTable = body.slice(i, j).join('\n');
    break;
  }
  const excerptSrc = body
    .filter((l) => !l.trim().startsWith('|') && l.trim() !== '')
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .trim();
  const excerpt = excerptSrc.length > 900 ? `${excerptSrc.slice(0, 900)}…` : excerptSrc;
  return {
    heading: lines[startLine]!,
    startLine: startLine + 1,
    endLine: end + 1,
    excerpt,
    ...(referenceTable ? { referenceTable } : {}),
  };
}

const IMAGE_REF_CAPTURE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const MOCKUP_CAP = 6;

/** WP24a: quét ảnh mockup THẬT (tồn tại trên đĩa) trong khoảng dòng section
 *  của một trang — dùng lại đúng khoảng dòng `findScreenSection` trả về
 *  (`section.startLine`/`endLine`, 1-based), KHÔNG đổi việc excerpt strip ảnh
 *  ở trên (mục đích khác: excerpt là văn bản đưa thẳng vào prompt, mockups là
 *  đường dẫn file daemon tự kiểm chứng). Ref markdown resolve tương đối từ
 *  thư mục chứa trang .md rồi kiểm tra tồn tại từ `cwd` dự án; giữ thứ tự
 *  xuất hiện trong section (ảnh ngay sau heading đứng trước), khử trùng lặp
 *  theo đường dẫn đã resolve, cap 6 (hằng số `MOCKUP_CAP`). */
export async function extractSectionMockups(
  cwd: string,
  pageMdPath: string,
  md: string,
  section: { startLine: number; endLine: number },
): Promise<string[]> {
  const lines = md.split(/\r?\n/);
  const body = lines.slice(section.startLine, section.endLine);
  const pageDir = path.posix.dirname(pageMdPath.split(path.sep).join('/'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of body) {
    if (out.length >= MOCKUP_CAP) break;
    IMAGE_REF_CAPTURE_RE.lastIndex = 0;
    for (let m = IMAGE_REF_CAPTURE_RE.exec(line); m; m = IMAGE_REF_CAPTURE_RE.exec(line)) {
      if (out.length >= MOCKUP_CAP) break;
      const raw = m[1]!.trim();
      if (!raw) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        decoded = raw;
      }
      const rel = path.posix.normalize(path.posix.join(pageDir, decoded));
      // Ref `../` trèo ra ngoài cwd dự án → bỏ: kickoff không được bảo agent
      // Read file ngoài dự án.
      if (rel === '..' || rel.startsWith('../')) continue;
      if (seen.has(rel)) continue;
      if (!(await exists(path.join(cwd, rel)))) continue;
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

// Mã màn ở ĐẦU heading, theo các khuôn tài liệu nghiệp vụ có thật: `MH1`/
// `MH-01`/`MH 2` (khoảng trắng giữa MH và số bị chuẩn hoá bỏ khi lấy code,
// dấu `-` thì giữ nguyên), `SCR-001`/`SCR-002.1`, hệ mã `S01`/`S02` (WP11 —
// xem docblock trên S_CODE_RE), hoặc mã mục nhiều cấp (≥ 2 đoạn số, `6.1.1`)
// — một số đơn lẻ như `2/` là số mục thường, không phải mã màn, nên yêu cầu
// có dấu chấm mới tính. WP9c: `MH` còn nhận hậu tố `-<số>` (`MH05-1` …
// `MH05-7`, tài liệu Chinh-sua-anh-gui.md thật — các màn CON, trước đây bị
// gộp hết về `MH05` vì phần `-1`/`-2` rơi ra ngoài mã). WP11 (sweep WP10,
// nguyên nhân 2 — HẬU TỐ CHẤM): MH_CODE_RE mở rộng nhận CẢ hậu tố chấm
// (`MH6.1`, `MH10.4` — Trang-chu.md thật, mục "3.1/ Danh sách màn hình -
// APP") — trước WP11 regex chỉ nhận `-<số>` nên các màn con `MH6.1`/`MH6.2`/
// `MH6.3` bị gộp âm thầm về `MH6` (không lỗi, không cảnh báo — mất luôn 2
// màn). Hậu tố (chấm HOẶC gạch, không trộn) giữ nguyên trong code chuẩn hoá.
const MH_CODE_RE = /^MH([\s-]?)(\d+(?:[.-]\d+)*)\b/i;
const SCR_CODE_RE = /^SCR-\d+(?:\.\d+)*\b/i;
// WP11 (sweep WP10, nguyên nhân 1 — HỆ MÃ S): hệ mã `S01`…`S05` có thật trên
// nhiều URD (Webhooks-Incoming-Webhook-…md, URD-Dang-ky-cham-cong-…md,
// URD-Hoi-dap-du-lieu-SalesGo-…md) nhưng trước WP11 không nhánh nào của
// matchLeadingCode nhận `S` làm tiền tố màn — heading `### S01 — Panel Danh
// sách Webhook` rơi thẳng vào nhánh mã mục (SECTION_CODE_RE, đòi dấu chấm)
// nên bị bỏ trắng, kéo theo lượt 2 (fallback mã mục) sinh màn ma "2.1 Danh
// sách màn hình". Bắt buộc `S` HOA + số dính liền ngay sau — cố tình KHÔNG
// dùng cờ `i` — để "Sóc"/"AF-01"/"MF-01"/"BR-08"/"EX-02" (chữ thường hoặc mã
// hệ khác bắt đầu bằng ký tự khác) không khớp nhầm; trong matchLeadingCode,
// SCR luôn được thử trước S nên "SCR-001" không bao giờ lọt vào nhánh này.
const S_CODE_RE = /^S\d{1,3}(?:[.-]\d+)*\b/;
const SECTION_CODE_RE = /^\d+(?:\.\d+)+\b/;
// Sau mã phải là một trong các dấu phân cách rồi tới tên (KHÔNG rỗng) — heading
// mục lục thuần như `3.1/ Danh sách màn hình` dùng "/" (không nằm trong tập
// này) nên tự động bị loại, không cần luật riêng.
const CODE_SEPARATOR_RE = /^[\s:.\-—–]+/;
// Khuôn v1 URD: `Màn hình 1: SCR-001 — Tên` — mã màn thật là SCR-xxx, không
// phải số thứ tự "1" đứng trước.
const URD_HEADING_RE = /^m[aà]n\s*h[ìi]nh\s*\d+\s*[:.\-—–]?\s*(SCR-\d+(?:\.\d+)*)\s*[:.\-—–]?\s*(.*)$/i;

// Mã mục nhiều cấp (`SECTION_CODE_RE`, `6.1.1`) chỉ được nhận là MÀN khi cả
// hai điều kiện dưới đây đúng — số đo thật trên tài liệu PRD SIM du lịch
// (2.1.-PRD-Detail-Mua-SIM-du-lich.md, WP9b): quét cũ (chỉ theo `SECTION_CODE_RE`
// + có tên) trả 17 "màn", gồm cả `3.1 Luồng sơ đồ`/`3.2 Mô tả` (nằm dưới
// "3. Luồng nghiệp vụ tính năng", không phải chương giao diện), `8.1 Trong
// Phạm Vi`/`8.2 Ngoài Phạm Vi` (không có chương "8." nào còn là heading thật —
// export Confluence làm hỏng `## **8. …**` thành `##` rỗng), và 4 mục NHÓM
// `6.1`/`6.2`/`6.3`/`6.4` (mỗi mục có mục con sâu hơn, không phải bản thân là
// màn). Sau khi siết hai điều kiện dưới, quét đúng 9 màn: 6.1.1, 6.2.1,
// 6.2.2, 6.3.1, 6.3.2, 6.4.1, 6.4.2, 6.4.3, 6.4.4 (tài liệu SSO — mã `MH1`/
// `MH2`/`MH3`, rule (a) — không đổi, vẫn ra đúng 3).
//   (vùng) một trong các heading TỔ TIÊN THEO MÃ (cắt dần đoạn cuối: `6.2.2`
//   → thử `6.2` rồi `6`) có chữ khớp /giao diện|màn hình|screen|wireframe/i.
//   Cố tình đối chiếu theo MÃ SỐ chứ KHÔNG theo cấp heading `#`/`##`/`###` —
//   tài liệu PRD SIM du lịch có `## 6.2.2. Màn hình…` ở cấp `##` xen giữa
//   các heading `###` khác của cùng chương (lỗi paste từ Confluence); lấy
//   quan hệ cha-con theo cấp `#` sẽ đứt gãy đúng chỗ heading hỏng cấp này.
//   (lá) không có heading nào SAU nó (trước heading không phải hậu duệ) có
//   mã bắt đầu bằng `<mã>.` — nếu có, heading đó là MỤC NHÓM (`6.1 Màn trang
//   chủ` có mục con `6.1.1`), không phải bản thân nó là một màn.
const ANCESTOR_HINT_RE = /giao diện|màn hình|screen|wireframe/i;
const LEADING_CODE_RE = /^\*{0,3}\s*(\d+(?:\.\d+)*)\b/;

/** Mã số ở đầu heading (bỏ qua `**` in đậm) — dựng quan hệ cha-con THEO MÃ
 *  cho `isDocScreenSection`, không phải theo cấp `#`/`##`/`###` (xem docblock
 *  trên `SECTION_CODE_RE`). `null` khi heading không mở đầu bằng một số. */
function leadingSectionCode(text: string): string | null {
  const m = LEADING_CODE_RE.exec(text);
  return m ? m[1]! : null;
}

/** Có phải mã mục nhiều cấp `code` (tại `headings[idx]`) là MỘT MÀN — xem
 *  docblock trên `SECTION_CODE_RE` cho quy tắc và số đo thật. */
function isDocScreenSection(headings: { text: string }[], codes: (string | null)[], idx: number, code: string): boolean {
  const parts = code.split('.');
  let hasAncestorHint = false;
  for (let p = parts.length - 1; p >= 1 && !hasAncestorHint; p -= 1) {
    const prefix = parts.slice(0, p).join('.');
    for (let j = idx - 1; j >= 0; j -= 1) {
      if (codes[j] === prefix) {
        if (ANCESTOR_HINT_RE.test(headings[j]!.text)) hasAncestorHint = true;
        break;
      }
    }
  }
  if (!hasAncestorHint) return false;
  for (let j = idx + 1; j < headings.length; j += 1) {
    const later = codes[j];
    if (later == null || later === code) continue;
    return !later.startsWith(`${code}.`);
  }
  return true;
}

/** Cố khớp một mã màn Ở ĐẦU `text` — mã tường minh (`MH`/`SCR`/`S`, WP11) hoặc
 *  mã mục nhiều cấp (`SECTION_CODE_RE`) — trả `{code, name, isSection}` hoặc
 *  `null` khi không có mã, hoặc phần sau mã rỗng (không có tên).
 *
 *  WP9c (BLOCKING 1, review độc lập vòng 2): heading GỘP số mục + mã màn
 *  thật, khuôn có thật `### 4.1 SCR-001 Chọn quốc gia` — trước đây mã màn
 *  chỉ nhận MH/SCR khi đứng ĐẦU heading nên "4.1" (mã mục) bị đọc thành mã
 *  màn, sinh khoá `…__4.1` song song với `…__SCR-001` mà flow đã khai —
 *  CÙNG một màn vật lý nhân đôi vì dedupe theo khoá nguyên văn không thấy
 *  trùng. Khi mã đầu là mã mục, thử khớp LẠI phần còn lại bằng chính hàm
 *  này; nếu phần còn lại LẠI mở đầu bằng MH/SCR/S thì dùng mã ĐÓ
 *  (`isSection: false`) — "4.1" hay "2.1.1" chỉ là số mục bao ngoài, không
 *  phải mã màn (WP11: "2.1.1. S01 Tên" → S01, cùng cơ chế). */
function matchLeadingCode(text: string): { code: string; name: string; isSection: boolean } | null {
  const mh = MH_CODE_RE.exec(text);
  const scr = mh ? null : SCR_CODE_RE.exec(text);
  const s = mh || scr ? null : S_CODE_RE.exec(text);
  const sec = mh || scr || s ? null : SECTION_CODE_RE.exec(text);
  const hit = mh ?? scr ?? s ?? sec;
  if (!hit) return null;
  const rawCode = hit[0];
  const rest = text.slice(rawCode.length);
  const sep = CODE_SEPARATOR_RE.exec(rest);
  const restName = sep ? rest.slice(sep[0].length).trim() : '';
  if (!restName) return null;
  if (sec) {
    const inner = matchLeadingCode(restName);
    if (inner && !inner.isSection) return inner;
  }
  const code = mh ? `MH${mh[1] === ' ' ? '' : mh[1]}${mh[2]}` : rawCode;
  return { code, name: restName, isSection: sec != null };
}

// WP11 (sweep WP10, nguyên nhân 5 — blocklist tên mục): fallback mã mục
// (SECTION_CODE_RE) và cả heading/bold/bảng tường minh đôi khi khai một MỤC
// LIỆT KÊ chứ không phải một MÀN — "2.1 Danh sách màn hình" (URD-Dang-ky-
// cham-cong-…md, sau khi rút gọn mã S vẫn còn "2.1.1 Danh sách màn hình và
// trạng thái"), "6.1 Danh sách màn hình" (B.-PRD-Feature-Detail-…md, trang
// mẫu/template) đều là chính cái MỤC liệt kê màn, không phải một màn riêng.
// Tên như "Danh sách danh bạ"/"Danh sách reaction" (WP10 sweep gắn cờ
// "suspicious-ghost-code" nhưng orchestrator soát tay xác nhận là màn thật,
// xem non_goals wp11.yaml) KHÔNG khớp — chỉ chặn khi tên mở đầu ĐÚNG
// "danh sách"/"mô tả" + (các) + "màn hình", hoặc "luồng màn hình".
const BLOCKLIST_NAME_RE = /^(danh sách|mô tả)\s+(các\s+)?màn hình\b/i;
const BLOCKLIST_FLOW_RE = /^luồng màn hình\b/i;
// WP14: export MỘT bản cho screen-extract.ts (lớp 2, validateDocScreenExtract)
// dùng chung — trước đó module đó giữ một bản chép cục bộ (chạy song song
// WP11 nên không import được file này lúc đang sửa).
export function isBlockedScreenName(name: string): boolean {
  const n = name.trim();
  return BLOCKLIST_NAME_RE.test(n) || BLOCKLIST_FLOW_RE.test(n);
}

// WP11 (sweep WP10, nguyên nhân 3 — DÒNG BOLD): một số URD khai màn bằng một
// dòng đứng riêng in đậm (`**MH1: Tên**`), KHÔNG phải heading `#` —
// Group-Chia-se-nhom.md / Web-Group-Chia-se-nhom-…md thật khai TOÀN BỘ 16
// màn (MH1, MH2, MH3.1–3.4, MH4.1, MH4.2, MH5, MH6.1–6.2, MH7.1–7.4, MH8)
// kiểu này — trước WP11 scanDocScreens chỉ đọc heading `#{1,6}` nên trang
// trắng màn dù có đủ mục "Danh sách/Mô tả màn hình" (cờ đỏ sweep
// zero-screens-despite-heading). Chỉ nhận dòng mà TOÀN BỘ nội dung (sau khi
// trim) là MỘT cặp `**…**` duy nhất, ruột không còn `*` nào khác — để loại
// dòng gộp nhiều mã tham chiếu chéo (`**MH3.1: … +** **MH3.2: …**`, có thật
// ở Web-Group-Chia-se-nhom-…md) và dòng bảng (loại trước bằng cách tự kiểm
// `|`, vì `**` trong ô bảng không đứng riêng một dòng).
const BOLD_LINE_RE = /^\*\*([^*]+)\*\*$/;

/** Nội dung bên trong một dòng in đậm ĐƠN, đứng riêng, ngoài bảng — `null`
 *  khi dòng không khớp khuôn này. Dùng chung cho `scanDocScreens` (nhận diện
 *  khai màn) và `findScreenSection` (tìm section của màn bold, WP11). */
function matchBoldLineText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('|')) return null;
  const m = BOLD_LINE_RE.exec(trimmed);
  if (!m) return null;
  const inner = m[1]!.trim();
  return inner.length ? inner : null;
}

/** Dòng bold-khai-màn: mã khớp MH/SCR/S — KHÔNG nhận mã mục (bold-prefix số
 *  mục kiểu `**6.2.2.** SCR-001` để lại cho backlog riêng, xem non_goals
 *  wp11.yaml). */
function matchBoldScreenLine(raw: string): { code: string; name: string } | null {
  const inner = matchBoldLineText(raw);
  if (inner == null) return null;
  const result = matchLeadingCode(inner);
  if (!result || result.isSection) return null;
  return { code: result.code, name: result.name };
}

// WP11 (sweep WP10, nguyên nhân 4 — BẢNG DANH SÁCH MÀN HÌNH): một số URD chỉ
// khai màn trong bảng `| Mã MH | Tên màn hình | … |` dưới heading khớp
// /danh sách màn hình/i, không có heading/bold riêng cho từng mã —
// URD-Bao-cao-dinh-ky-SalesGo-…md (S01–S03 chỉ trong bảng, hàng rác
// "*(ngoài SocChat)*") và hàng MH05-7 của Chinh-sua-anh-gui.md thật (MH05-1…
// MH05-6 CÓ heading riêng, MH05-7 thì không, chỉ có trong bảng). Bảng là
// nguồn BỔ SUNG — trộn vào lượt 1 nhưng thua heading/bold cùng mã (xem
// scanDocScreens); màn chỉ-trong-bảng không có section vì findScreenSection
// không quét hàng bảng (ScreenInput.section vốn optional, không đổi shape).
const TABLE_TRIGGER_HEADING_RE = /danh sách màn hình/i;
const TABLE_CODE_HEADER_RE = /mã/i;
const TABLE_NAME_HEADER_RE = /tên màn hình/i;

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}
function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}
/** Mã ở một Ô bảng (đã bỏ `**` in đậm + khoảng trắng) — phải khớp TRỌN Ô
 *  (khác `matchLeadingCode`, cho phép có tên theo sau) vì một ô mã chỉ nên
 *  chứa đúng mã; khớp một phần thì coi là rác (`*(ngoài SocChat)*`, hàng ghi
 *  chú thật của URD-Bao-cao-dinh-ky-…md) và bị bỏ. */
function matchTableCode(cell: string): string | null {
  const stripped = cell.replace(/\*\*/g, '').trim();
  if (!stripped) return null;
  const mh = MH_CODE_RE.exec(stripped);
  const hit = mh ?? SCR_CODE_RE.exec(stripped) ?? S_CODE_RE.exec(stripped);
  if (!hit || hit[0] !== stripped) return null;
  return mh ? `MH${mh[1] === ' ' ? '' : mh[1]}${mh[2]}` : stripped;
}

/** Quét mọi bảng "Danh sách màn hình" trong tài liệu — xem docblock trên
 *  TABLE_TRIGGER_HEADING_RE. `headings` cần có `level` (cấp `#`); một bảng có
 *  thể bị quét lặp khi ≥2 heading tổ tiên cùng khớp trigger (vô hại — dedupe
 *  ở scanDocScreens theo mã, giữ lần đầu). */
function scanScreenTables(
  lines: string[],
  headings: Array<{ text: string; line: number; level: number }>,
): Array<{ code: string; name: string; heading: string; line: number }> {
  const out: Array<{ code: string; name: string; heading: string; line: number }> = [];
  headings.forEach((h, idx) => {
    if (!TABLE_TRIGGER_HEADING_RE.test(h.text)) return;
    let end = lines.length - 1;
    for (let j = idx + 1; j < headings.length; j += 1) {
      if (headings[j]!.level <= h.level) {
        end = headings[j]!.line - 2; // headings[j].line là 1-based; dừng trước dòng heading đó
        break;
      }
    }
    for (let i = h.line; i <= end; i += 1) {
      const raw = lines[i];
      if (raw == null || !raw.trim().startsWith('|')) continue;
      const header = splitTableRow(raw);
      const codeIdx = header.findIndex((c) => TABLE_CODE_HEADER_RE.test(c));
      const nameIdx = header.findIndex((c) => TABLE_NAME_HEADER_RE.test(c));
      if (codeIdx === -1 || nameIdx === -1) continue;
      let j = i + 1;
      if (j <= end && lines[j] != null && isTableSeparatorRow(lines[j]!)) j += 1;
      const rows: Array<{ code: string; name: string; raw: string; line: number }> = [];
      while (j <= end && lines[j] != null && lines[j]!.trim().startsWith('|')) {
        const cells = splitTableRow(lines[j]!);
        const code = matchTableCode(cells[codeIdx] ?? '');
        const name = (cells[nameIdx] ?? '').trim();
        if (code && name) rows.push({ code, name, raw: lines[j]!, line: j + 1 });
        j += 1;
      }
      // Hàng NHÓM (`**MH05**` — Chinh-sua-anh-gui.md thật): có mã cha C khi
      // tồn tại hàng khác mã bắt đầu "C-" hoặc "C." — bản thân C không phải
      // một màn, chỉ là mục cha của các màn con.
      for (const r of rows) {
        const isGroup = rows.some((other) => other.code !== r.code && (other.code.startsWith(`${r.code}-`) || other.code.startsWith(`${r.code}.`)));
        if (isGroup) continue;
        out.push({ code: r.code, name: r.name, heading: r.raw, line: r.line });
      }
      i = j - 1;
    }
  });
  return out;
}

/** Quét heading/bold/bảng khai MỘT màn hình trong tài liệu, theo thứ tự xuất
 *  hiện, loại trùng theo mã (giữ lần đầu). Dùng khi dr-flow không gắn được
 *  màn nào (sự cố #5d13309f: 13 sơ đồ sequence, agent gắn màn đúng ý nhưng
 *  daemon loại sạch không cảnh báo → dr-comp chết vì gate cứng "chưa gắn màn
 *  nào") — đọc thẳng danh sách màn từ chính tài liệu thay vì bó tay. Từ
 *  WP9b cũng là nguồn BỔ SUNG khi dr-flow gắn được MỘT PHẦN màn (xem
 *  `prepareScreenComponentInputs`).
 *
 *  WP9c (BLOCKING 2, review độc lập vòng 2): quét theo HAI LƯỢT, ưu tiên hệ
 *  mã ở mức TÀI LIỆU (không phải từng heading riêng lẻ) — lượt 1 gom mọi
 *  màn có mã TƯỜNG MINH; lượt 2 — CHỈ KHI lượt 1 TRẮNG TAY — mới nhận mã
 *  mục nhiều cấp qua `isDocScreenSection` (siết chặt theo docblock trên
 *  `SECTION_CODE_RE`, để không bơm mục tài liệu — luồng sơ đồ, phạm vi, mục
 *  nhóm — vào làm màn ma). Lý do ưu tiên tuyệt đối: một khi tài liệu đã TỰ
 *  đánh mã màn riêng, mọi heading số mục còn lại chỉ là mục lục tài liệu,
 *  không phải màn — kể cả khi ancestor hint khớp "màn hình" (bug review độc
 *  lập vòng 2: `### 3.1 Danh sách màn hình` dưới `## 3. Danh sách màn hình`,
 *  tài liệu Chinh-sua-anh-gui.md thật). Mã mục nhiều cấp chỉ còn là fallback
 *  cho tài liệu kiểu PRD SIM không có hệ mã màn riêng.
 *
 *  WP11 (sweep WP10 — 24/70 URD cờ đỏ, soát tay quy về 4 nguyên nhân thật):
 *  "mã TƯỜNG MINH" của lượt 1 nay gồm CẢ BA nguồn — heading (như cũ, cộng
 *  thêm hệ mã `S`, xem S_CODE_RE), dòng bold-khai-màn đứng riêng
 *  (`matchBoldScreenLine`, nguyên nhân 3 — Group-Chia-se-nhom.md không có
 *  heading MH nào), và hàng bảng "Danh sách màn hình" (`scanScreenTables`,
 *  nguyên nhân 4 — URD-Bao-cao-dinh-ky-…md chỉ khai màn trong bảng). Heading
 *  và bold trộn theo đúng THỨ TỰ DÒNG trước khi loại trùng (giữ lần đầu);
 *  bảng chỉ BỔ SUNG mã nào CHƯA thấy — heading/bold luôn thắng cùng mã vì
 *  được xét trước. Cả hai lượt đều lọc qua `isBlockedScreenName` (nguyên
 *  nhân 5) để giết "2.1 Danh sách màn hình" kiểu mục lục, dù đứng ở nguồn
 *  nào hay ancestor hint có khớp hay không — xem BLOCKLIST_NAME_RE. Heading
 *  rác kiểu `#### ![](…)` (ảnh làm heading, Trang-chu.md dòng 112 thật)
 *  không cần luật riêng: matchLeadingCode không khớp gì với "![...]" nên tự
 *  rơi khỏi mọi nhánh, không crash. */
export function scanDocScreens(md: string): Array<{ code: string; name: string; heading: string; line: number }> {
  const lines = md.split(/\r?\n/);
  const headings: Array<{ text: string; raw: string; line: number; level: number }> = [];
  const boldDecls: Array<{ code: string; name: string; raw: string; line: number }> = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence == null) fence = f[1]!;
      else if (raw.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const m = HEADING_RE.exec(raw);
    if (m) {
      headings.push({ text: m[2]!.trim(), raw, line: i + 1, level: m[1]!.length });
      return;
    }
    const bold = matchBoldScreenLine(raw);
    if (bold) boldDecls.push({ ...bold, raw, line: i + 1 });
  });
  const codes = headings.map((h) => leadingSectionCode(h.text));

  // LƯỢT 1 — mã tường minh (URD / MH / SCR / S) từ heading, bold, bảng —
  // thắng tuyệt đối nếu có ở bất kỳ đâu trong tài liệu (xem docblock trên).
  type Cand = { code: string; name: string; heading: string; line: number };
  const fromHeadingBold: Cand[] = [];
  headings.forEach((h) => {
    const urd = URD_HEADING_RE.exec(h.text);
    const urdName = urd ? (urd[2] ?? '').trim() : '';
    const result = urd ? (urdName ? { code: urd[1]!.toUpperCase(), name: urdName, isSection: false } : null) : matchLeadingCode(h.text);
    if (!result || result.isSection) return;
    fromHeadingBold.push({ code: result.code, name: result.name, heading: h.raw, line: h.line });
  });
  boldDecls.forEach((b) => fromHeadingBold.push({ code: b.code, name: b.name, heading: b.raw, line: b.line }));
  fromHeadingBold.sort((a, b) => a.line - b.line);

  const explicit: Cand[] = [];
  const seenExplicit = new Set<string>();
  for (const c of fromHeadingBold) {
    if (isBlockedScreenName(c.name)) continue;
    if (seenExplicit.has(c.code)) continue;
    seenExplicit.add(c.code);
    explicit.push(c);
  }
  for (const c of scanScreenTables(lines, headings)) {
    if (isBlockedScreenName(c.name)) continue;
    if (seenExplicit.has(c.code)) continue;
    seenExplicit.add(c.code);
    explicit.push(c);
  }
  if (explicit.length > 0) return explicit;

  // LƯỢT 2 — fallback: mã mục nhiều cấp, CHỈ khi lượt 1 trắng tay.
  const out: Cand[] = [];
  const seen = new Set<string>();
  headings.forEach((h, idx) => {
    const m = matchLeadingCode(h.text);
    if (!m || !m.isSection) return;
    if (isBlockedScreenName(m.name)) return;
    if (!isDocScreenSection(headings, codes, idx, m.code)) return;
    if (seen.has(m.code)) return;
    seen.add(m.code);
    out.push({ code: m.code, name: m.name, heading: h.raw, line: h.line });
  });
  return out;
}

// WP14: export MỘT bản cho screen-extract.ts (lớp 2) dùng chung — trước đó
// module đó giữ một bản chép cục bộ vì chạy song song WP11.
export const MOBILE_HINT_RE = /\b(sdk|mobile|ios|android|app di động|ứng dụng di động|màn hình điện thoại|smartphone|super ?app|mini ?app|bottom sheet)\b/i;

// WP14: nguồn đối chiếu tất định DUY NHẤT cho "anchorText" của lớp 2
// (screen-extract.ts, agent trích) và lớp 3 (screen-overrides.ts, override
// 'add' có anchor) — một dòng NGUYÊN VĂN (sau trim), NGOÀI code fence. Trước
// đó cả hai module giữ một bản chép cục bộ của đúng cùng một thuật toán
// (review độc lập wave 1 xác nhận semantic khớp) vì chạy song song, không
// import được lẫn nhau. Trả về MỌI dòng khớp theo thứ tự xuất hiện (1-based)
// để caller tự quyết định 0/1/nhiều lần là hợp lệ hay không (validate của
// lớp 2 cần phân biệt "không thấy" vs "không duy nhất"; lớp 3 chỉ cần biết
// đúng-một-lần).
export function findAnchorTextLines(md: string, anchorText: string): number[] {
  const needle = anchorText.trim();
  const lines = md.split(/\r?\n/);
  let fence: string | null = null;
  const hits: number[] = [];
  lines.forEach((raw, i) => {
    const f = /^\s*(```+|~~~+)/.exec(raw);
    if (f) {
      if (fence == null) fence = f[1]!;
      else if (raw.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    if (raw.trim() === needle) hits.push(i + 1);
  });
  return hits;
}

/** Ways out of `key`: follow edges from a node on this screen through
 *  non-screen nodes (decisions, system steps) until another screen is
 *  reached (depth ≤ 4). */
function navOutOf(doc: FlowchartDoc, key: string): ScreenNav[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: ScreenNav[] = [];
  const seenTo = new Set<string>();
  const outEdges = (id: string) => doc.edges.filter((e) => e.from === id);
  for (const n of doc.nodes.filter((x) => x.screen === key)) {
    const walk = (id: string, via: string, cond: string[], depth: number, visited: Set<string>) => {
      if (depth > 4) return;
      for (const e of outEdges(id)) {
        const t = byId.get(e.to);
        if (!t || visited.has(t.id)) continue;
        const nextCond = e.label ? [...cond, e.label] : cond;
        if (t.screen && t.screen !== key) {
          const sig = `${t.screen}|${via}`;
          if (!seenTo.has(sig)) {
            seenTo.add(sig);
            out.push({ to: t.screen, via, ...(nextCond.length ? { condition: nextCond.join(' → ') } : {}) });
          }
          continue;
        }
        if (t.screen === key) continue;
        walk(t.id, via, nextCond, depth + 1, new Set([...visited, t.id]));
      }
    };
    walk(n.id, n.label, [], 0, new Set([n.id]));
  }
  return out;
}

// ── Phát hiện màn hình (WP1, 2026-08-25) ───────────────────────────────────
//
// Stage MỚI `dr-screens` chạy TRƯỚC dr-comp (server.ts, WP2 — không thuộc
// module này): agent đọc TOÀN BỘ tài liệu + flows/ rồi tự lập danh sách màn
// THẬT, ghi `docs-review/screens-discovered.json` (contract dưới đây) — thay
// cho việc dr-comp phải tự quét bằng `scanDocScreens` (lớp 1), vốn đôi khi
// nâng một heading CON chỉ mô tả MỘT PHẦN của màn ("Voucher" trong màn "Mua
// SIM") thành một màn RIÊNG với PRD tự do (heading không theo khuôn MH/SCR).
//
// CONTRACT (chốt cứng, xem cùng nội dung ở `pipelines.ts`'s dr-screens def +
// `skills/docs-screen-discovery/SKILL.md`): file nằm ở GỐC workflow-dir
// (`docs-review/screens-discovered.json`, NGOÀI `comp/` — sống sót qua mọi
// lần re-run/clear của dr-comp).
//   { schema_version: 1, generatedAt: string,
//     pages: [{ source: '<.md>', screens: [{ code: string|null, name: string,
//       anchorText: string, why?: string,
//       blocks?: [{ name: string, anchorText: string, why?: string }] }] }],
//     excluded: [{ name: string, source: string, reason: string, partOf?: string }] }
// `anchorText` = nguyên văn MỘT DÒNG DUY NHẤT của trang (đối chiếu tất định
// bằng `findAnchorTextLines`, cùng kỷ luật với lớp 2 — screen-extract.ts).
// `code: null` → daemon tự đánh X1, X2… theo thứ tự DÒNG anchor trong trang.
// Khoá màn = `<file-stem>__<code>` — giống mọi lớp khác.
// `blocks[]` (WP nested-blocks-A, 2026-08-25): "khối bổ sung" của một màn
// khác mà BA đặt sai chỗ (vd "Voucher" là chi tiết của màn "Mua SIM" nhưng bị
// khai thành mục/heading riêng) — LỒNG dưới đúng màn cha thay vì thành màn
// riêng hay bị `excluded`. `resolveDocScreens` gắn từng block vào
// `ScreenInput.blocks[]` của màn cha (xem dưới); block KHÔNG BAO GIỜ tự thành
// `ScreenInput`, KHÔNG chiếm mã X tự đánh, KHÔNG vào `existingKeys`.
export interface DiscoveredScreenEntry {
  code: string | null;
  name: string;
  anchorText: string;
  why?: string;
  blocks?: { name: string; anchorText: string; why?: string }[];
}
export interface DiscoveredPageEntry {
  source: string;
  screens: DiscoveredScreenEntry[];
}
export interface DiscoveredExcludedEntry {
  name: string;
  source: string;
  reason: string;
  partOf?: string;
}
export interface DiscoveredDoc {
  schema_version: 1;
  generatedAt: string;
  pages: DiscoveredPageEntry[];
  excluded: DiscoveredExcludedEntry[];
}

/** Parse `docs-review/screens-discovered.json` — KHOAN DUNG: JSON hỏng, shape
 *  lạ, hay thiếu field bắt buộc (`schema_version`/`pages`) → `null` (caller
 *  lùi về hành vi cũ, xem `resolveDocScreens`). Từng phần tử lạ bên trong
 *  `pages[].screens[]` / `excluded[]` bị bỏ qua âm thầm thay vì làm hỏng cả
 *  tài liệu — cùng triết lý khoan dung với `validateDocScreenExtract`
 *  (screen-extract.ts), chỉ khác là không có kênh "rejected" ra ngoài vì đây
 *  không phải bước validate cho agent sửa, mà là bước ĐỌC lại một artifact đã
 *  (kỳ vọng) qua kiểm ở lượt ghi. */
export function parseScreensDiscovered(raw: string): DiscoveredDoc | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (o.schema_version !== 1) return null;
  if (!Array.isArray(o.pages)) return null;

  const pages: DiscoveredPageEntry[] = [];
  for (const rawPage of o.pages) {
    if (!rawPage || typeof rawPage !== 'object') continue;
    const p = rawPage as Record<string, unknown>;
    const source = str(p.source);
    if (!source) continue;
    const rawScreens = Array.isArray(p.screens) ? p.screens : [];
    const screens: DiscoveredScreenEntry[] = [];
    for (const rs of rawScreens) {
      if (!rs || typeof rs !== 'object') continue;
      const e = rs as Record<string, unknown>;
      const anchorText = str(e.anchorText);
      const name = str(e.name);
      if (!anchorText || !name) continue;
      const codeRaw = e.code;
      const code = codeRaw == null ? null : typeof codeRaw === 'string' ? str(codeRaw) || null : null;
      const why = typeof e.why === 'string' && e.why.trim() ? e.why.trim() : undefined;
      // `blocks[]` — khoan dung y như screens: bỏ phần tử không phải object
      // hoặc thiếu anchorText/name; giữ `why` khi có; rỗng → bỏ hẳn field.
      const rawBlocks = Array.isArray(e.blocks) ? e.blocks : [];
      const blocks: { name: string; anchorText: string; why?: string }[] = [];
      for (const rb of rawBlocks) {
        if (!rb || typeof rb !== 'object') continue;
        const be = rb as Record<string, unknown>;
        const blockAnchorText = str(be.anchorText);
        const blockName = str(be.name);
        if (!blockAnchorText || !blockName) continue;
        const blockWhy = typeof be.why === 'string' && be.why.trim() ? be.why.trim() : undefined;
        blocks.push({ name: blockName, anchorText: blockAnchorText, ...(blockWhy ? { why: blockWhy } : {}) });
      }
      screens.push({ code, name, anchorText, ...(why ? { why } : {}), ...(blocks.length ? { blocks } : {}) });
    }
    pages.push({ source, screens });
  }

  const excluded: DiscoveredExcludedEntry[] = [];
  const rawExcluded = Array.isArray(o.excluded) ? o.excluded : [];
  for (const rx of rawExcluded) {
    if (!rx || typeof rx !== 'object') continue;
    const e = rx as Record<string, unknown>;
    const name = str(e.name);
    const source = str(e.source);
    const reason = str(e.reason);
    if (!name || !source || !reason) continue;
    const partOf = typeof e.partOf === 'string' && e.partOf.trim() ? e.partOf.trim() : undefined;
    excluded.push({ name, source, reason, ...(partOf ? { partOf } : {}) });
  }

  return {
    schema_version: 1,
    generatedAt: typeof o.generatedAt === 'string' ? o.generatedAt : '',
    pages,
    excluded,
  };
}

/** Dựng section `{heading,startLine,endLine,excerpt}` cho một màn discovery
 *  KHÔNG khớp được `findScreenSection` (thường vì `code` là mã tự đánh
 *  X1/X2…, không tương ứng heading nào) — anchor tới anchor HỢP LỆ kế tiếp
 *  trừ 1, màn cuối chạy tới hết trang. Cùng luật cắt 900 ký tự với
 *  `buildAgentSection` (screen-extract.ts, lớp 2) để hiển thị section HINT
 *  nhất quán giữa hai lớp — không import được lẫn nhau (screen-extract.ts
 *  import module NÀY, import ngược lại sẽ vòng). */
function buildAnchorSection(md: string, startLine: number, endLine: number): NonNullable<ScreenInput['section']> {
  const lines = md.split(/\r?\n/);
  const heading = lines[startLine - 1] ?? '';
  const excerptSrc = lines.slice(startLine - 1, endLine).join('\n').trim();
  return {
    heading,
    startLine,
    endLine,
    excerpt: excerptSrc.length > 900 ? `${excerptSrc.slice(0, 900)}…` : excerptSrc,
  };
}

export interface ResolveDocScreensInput {
  /** Doc pages of the run (`listDocPages`): mdPath relative to cwd + title. */
  pages: { mdPath: string; page: string }[];
  /** Markdown content per page, keyed by `mdPath` (already read — pure, no fs here). */
  mdBySource: Map<string, string>;
  /** Parsed `screens-discovered.json`, or `null` when absent/invalid. */
  discovered: DiscoveredDoc | null;
  /** Keys already claimed by flow-origin screens (or a prior call) — never duplicated. */
  existingKeys: ReadonlySet<string>;
}

/** Chọn nguồn màn-TÀI-LIỆU cho `prepareScreenComponentInputs`: khi `discovered`
 *  hợp lệ, danh sách màn lấy THẲNG từ đó (thẩm quyền, KHÔNG chạy
 *  `scanDocScreens`); khi không có / hỏng, lùi về đúng hành vi cũ (quét
 *  regex `scanDocScreens`) — tương thích ngược tuyệt đối. Thuần: không fs,
 *  không mockups (đó là bước fs riêng, caller làm sau khi merge — xem
 *  `extractSectionMockups`). `order` trong kết quả chỉ là placeholder (0) —
 *  caller gán lại thứ tự cuối cùng khi merge vào danh sách chính. */
export function resolveDocScreens(input: ResolveDocScreensInput): ScreenInput[] {
  const { pages, mdBySource, discovered, existingKeys } = input;
  const seen = new Set(existingKeys);
  const out: ScreenInput[] = [];

  if (discovered) {
    const excludedNames = new Set(discovered.excluded.map((e) => `${e.source}::${normalizeVi(e.name)}`));
    for (const dp of discovered.pages) {
      const md = mdBySource.get(dp.source);
      if (md == null) continue;
      const stem = path.posix.basename(dp.source, '.md');
      const pageLines = md.split(/\r?\n/);
      const pageLineCount = pageLines.length;

      type Candidate = {
        rawCode: string | null;
        name: string;
        anchorText: string;
        line: number;
        rawBlocks?: DiscoveredScreenEntry['blocks'];
      };
      const candidates: Candidate[] = [];
      for (const s of dp.screens) {
        if (excludedNames.has(`${dp.source}::${normalizeVi(s.name)}`)) continue;
        const hits = findAnchorTextLines(md, s.anchorText);
        // Anchor phải KHỚP DUY NHẤT — không khớp/khớp nhiều lần thì bỏ qua
        // (khoan dung: dr-comp không phải nơi validate lỗi khai báo của
        // dr-screens, xem docblock trên).
        if (hits.length !== 1) continue;
        candidates.push({ rawCode: s.code, name: s.name, anchorText: s.anchorText, line: hits[0]!, rawBlocks: s.blocks });
      }

      // code null → X1, X2… theo thứ tự DÒNG anchor trong trang (contract).
      const nullOrderedByLine = candidates.filter((c) => c.rawCode == null).sort((a, b) => a.line - b.line);
      const autoCode = new Map<Candidate, string>();
      nullOrderedByLine.forEach((c, i) => autoCode.set(c, `X${i + 1}`));

      const withFinalCode = candidates.map((c) => ({ ...c, finalCode: c.rawCode ?? autoCode.get(c)! }));
      const usedCodes = new Set<string>();
      const accepted: Array<Candidate & { finalCode: string }> = [];
      for (const c of withFinalCode) {
        if (usedCodes.has(c.finalCode)) continue; // mã trùng trong cùng trang — cái sau bị bỏ.
        usedCodes.add(c.finalCode);
        accepted.push(c);
      }
      const bySortedLine = [...accepted].sort((a, b) => a.line - b.line);

      // Gắn block vào màn cha: mỗi block của một màn ACCEPTED phải tự khớp
      // anchorText DUY NHẤT (cùng kỷ luật khoan dung với màn) — không cần
      // nằm trong section của màn cha (non-contiguous OK). Ranh giới của
      // TỪNG block là "anchor kế tiếp TRONG TẬP-ANCHOR-GỘP TOÀN TRANG" (màn
      // accepted + mọi block đã định vị được của chúng), nên phải resolve
      // MỌI block trước rồi mới gộp+sắp xếp một lần cho cả trang.
      type ResolvedBlock = { name: string; line: number };
      const blocksByCandidate = new Map<Candidate & { finalCode: string }, ResolvedBlock[]>();
      for (const c of accepted) {
        const rawBlocks = c.rawBlocks ?? [];
        if (!rawBlocks.length) continue;
        const resolved: ResolvedBlock[] = [];
        for (const b of rawBlocks) {
          const hits = findAnchorTextLines(md, b.anchorText);
          if (hits.length !== 1) continue; // khớp 0 hoặc ≥2 lần → bỏ qua.
          resolved.push({ name: b.name, line: hits[0]! });
        }
        if (resolved.length) blocksByCandidate.set(c, resolved);
      }
      const mergedAnchorLines = [...new Set([...bySortedLine.map((c) => c.line), ...[...blocksByCandidate.values()].flat().map((b) => b.line)])].sort(
        (a, b) => a - b,
      );
      const nextAnchorEndLine = (line: number): number => {
        const next = mergedAnchorLines.find((l) => l > line);
        return next != null ? next - 1 : pageLineCount;
      };

      for (const c of accepted) {
        const key = `${stem}__${c.finalCode}`;
        if (seen.has(key)) continue; // màn có sẵn (flow-origin) thắng — không nhân đôi.
        seen.add(key);

        // Ưu tiên `findScreenSection` khi màn có mã THẬT (không phải X1/X2 tự
        // đánh) — nó cắt section theo CẤP HEADING (tới heading cùng/cao hơn
        // cấp kế tiếp), đúng ranh giới thật của màn kể cả khi màn có heading
        // CON bên trong (chính lý do dr-screens tồn tại — xem docblock đầu
        // block). Chỉ khi không khớp (hoặc mã là X1/X2 tự đánh, không tương
        // ứng heading nào) mới lùi về ranh giới theo dòng anchor kế tiếp.
        const byHeading = c.rawCode != null ? findScreenSection(md, c.finalCode, c.name) : null;
        let section: NonNullable<ScreenInput['section']>;
        let referenceTable: string | undefined;
        if (byHeading) {
          section = { heading: byHeading.heading, startLine: byHeading.startLine, endLine: byHeading.endLine, excerpt: byHeading.excerpt };
          referenceTable = byHeading.referenceTable;
        } else {
          const idx = bySortedLine.indexOf(c);
          const nextLine = idx + 1 < bySortedLine.length ? bySortedLine[idx + 1]!.line : null;
          const endLine = nextLine != null ? nextLine - 1 : pageLineCount;
          section = buildAnchorSection(md, c.line, endLine);
        }

        const resolvedBlocks = blocksByCandidate.get(c);
        const blocks: ScreenInput['blocks'] = resolvedBlocks?.length
          ? resolvedBlocks.map((b) => ({ name: b.name, section: buildAnchorSection(md, b.line, nextAnchorEndLine(b.line)) }))
          : undefined;

        out.push({
          key,
          name: c.name,
          order: 0,
          flowId: '',
          flowTitle: '',
          source: dp.source,
          section,
          ...(referenceTable ? { referenceTable } : {}),
          steps: [],
          navOut: [],
          navIn: [],
          findings: [],
          platformHint: MOBILE_HINT_RE.test(md) ? 'mobile' : 'web',
          origin: 'agent',
          ...(blocks ? { blocks } : {}),
        });
      }
    }
    return out;
  }

  // Không có discovery hợp lệ — hành vi cũ Y HỆT (Lượt-2 fallback: quét regex).
  for (const page of pages) {
    const md = mdBySource.get(page.mdPath);
    if (!md) continue;
    const stem = path.posix.basename(page.mdPath, '.md');
    for (const h of scanDocScreens(md)) {
      const key = `${stem}__${h.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const section = findScreenSection(md, h.code, h.name);
      const scanned: ScreenInput = {
        key,
        name: h.name,
        order: 0,
        flowId: '',
        flowTitle: '',
        source: page.mdPath,
        steps: [],
        navOut: [],
        navIn: [],
        findings: [],
        platformHint: MOBILE_HINT_RE.test(md) ? 'mobile' : 'web',
        origin: 'doc',
      };
      if (section) {
        scanned.section = { heading: section.heading, startLine: section.startLine, endLine: section.endLine, excerpt: section.excerpt };
        if (section.referenceTable) scanned.referenceTable = section.referenceTable;
      }
      out.push(scanned);
    }
  }
  return out;
}

export interface PrepareScreenInputsOptions {
  /** Doc pages of the run (`listDocPages`): mdPath relative to cwd + title. */
  pages: { mdPath: string; page: string }[];
}

/** Build `comp/_inputs.json` from the flow stage's outputs + the documents.
 *  Returns the inputs (also written to disk). `screens` is empty (with a
 *  `note`) when dr-flow has not produced any screen. */
export async function prepareScreenComponentInputs(
  cwd: string,
  opts: PrepareScreenInputsOptions,
): Promise<ScreenComponentsInputs> {
  const flowsDir = path.join(cwd, 'flows');
  const index = (await readJson<FlowIndexEntry[]>(path.join(flowsDir, 'index.json'))) ?? [];
  const pagesByStem = new Map<string, { mdPath: string; page: string }>();
  for (const p of opts.pages) pagesByStem.set(path.posix.basename(p.mdPath, '.md'), p);
  const mdCache = new Map<string, string | null>();
  const readMd = async (rel: string) => {
    if (!mdCache.has(rel)) mdCache.set(rel, await readText(path.join(cwd, rel)));
    return mdCache.get(rel) ?? null;
  };

  const screens: ScreenInput[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const entry of Array.isArray(index) ? index : []) {
    if (!entry || !Array.isArray(entry.screens) || entry.screens.length === 0) continue;
    const flowchart = entry.files?.flowchart ? await readJson<FlowchartDoc>(path.join(cwd, entry.files.flowchart)) : null;
    const review = await readJson<UxReview>(path.join(flowsDir, entry.id, 'ux-review.json'));
    const cellScreen = new Map<string, string>();
    for (const n of flowchart?.nodes ?? []) if (n.screen) cellScreen.set(n.id, n.screen);
    for (const s of entry.screens) {
      if (!s?.key || seen.has(s.key)) continue;
      seen.add(s.key);
      const parts = splitScreenKey(s.key);
      const page = parts ? pagesByStem.get(parts.prefix) ?? null : null;
      const md = page ? await readMd(page.mdPath) : null;
      const section = md && parts ? findScreenSection(md, parts.code, s.name) : null;
      const steps: ScreenStep[] = (flowchart?.nodes ?? [])
        .filter((n) => n.screen === s.key)
        .map((n) => ({ id: n.id, type: n.type, label: n.label }));
      const navOut = flowchart ? navOutOf(flowchart, s.key) : [];
      const findings = (review?.findings ?? [])
        .filter((f) => (f.cells?.asIs ?? []).some((c) => cellScreen.get(c) === s.key))
        .map((f) => ({ id: f.id, severity: f.severity, title: f.title, ...(f.recommendation ? { recommendation: f.recommendation } : {}) }));
      const platformHint: 'mobile' | 'web' = md && MOBILE_HINT_RE.test(md) ? 'mobile' : 'web';
      const originMetadata = parseScreenOriginMetadata(s as unknown as Record<string, unknown>);
      const input: ScreenInput = {
        key: s.key,
        name: s.name,
        order: order++,
        flowId: entry.id,
        flowTitle: entry.title,
        source: page?.mdPath ?? null,
        steps,
        navOut,
        navIn: [],
        findings,
        platformHint,
        origin: 'flow',
        ...originMetadata,
      };
      if (section) {
        input.section = { heading: section.heading, startLine: section.startLine, endLine: section.endLine, excerpt: section.excerpt };
        if (section.referenceTable) input.referenceTable = section.referenceTable;
        if (md && page) {
          const mockups = await extractSectionMockups(cwd, page.mdPath, md, section);
          if (mockups.length) input.mockups = mockups;
        }
      }
      screens.push(input);
    }
  }
  const flowScreenCount = screens.length;

  // HỢP NHẤT (WP9b, sự cố dự án "Đăng nhập SSO" — #5d13309f phần 2): dr-flow
  // chỉ gắn được màn khi agent trỏ đúng node CÒN TỒN TẠI ở bản hiện trạng —
  // 2/3 màn tài liệu khai (MH2/MH3) trỏ vào node chỉ có ở bản ĐỀ XUẤT
  // (flowchart dựng từ hiện trạng, đúng thiết kế) nên KHÔNG BAO GIỜ gắn
  // được, dù tài liệu khai rõ ràng. Trước WP9b, nhánh quét tài liệu CHỈ chạy
  // khi flows trắng tay (`screens.length === 0`) nên MH2/MH3 mất hẳn khỏi
  // dr-comp dù flow đã gắn được MH1. Từ đây LUÔN quét tài liệu và BỔ SUNG
  // những màn CHƯA có trong danh sách từ flow (so trùng theo key
  // `<file-stem>__<code>`) — không còn thay thế "hoặc-là" như trước.
  // WP1 (2026-08-25, "Phát hiện màn hình"): khi bước dr-screens đã ghi
  // `screens-discovered.json` HỢP LỆ ở gốc workflow-dir, nó là nguồn màn-
  // TÀI-LIỆU có thẩm quyền — THAY cho `scanDocScreens` (không còn chạy).
  // Không có / hỏng file → `resolveDocScreens` tự lùi về đúng hành vi cũ
  // (tương thích ngược tuyệt đối, xem docblock của nó).
  const discoveredRaw = await readText(path.join(cwd, 'screens-discovered.json'));
  const discovered = discoveredRaw != null ? parseScreensDiscovered(discoveredRaw) : null;
  const mdBySource = new Map<string, string>();
  for (const page of opts.pages) {
    const md = await readMd(page.mdPath);
    if (md != null) mdBySource.set(page.mdPath, md);
  }
  const docScreens = resolveDocScreens({ pages: opts.pages, mdBySource, discovered, existingKeys: seen });

  const addedDocKeys: string[] = [];
  let docOrder = flowScreenCount;
  for (const input of docScreens) {
    seen.add(input.key);
    input.order = docOrder++;
    if (input.section && input.source) {
      const md = mdBySource.get(input.source);
      if (md != null) {
        const mockups = await extractSectionMockups(cwd, input.source, md, input.section);
        if (mockups.length) input.mockups = mockups;
      }
    }
    screens.push(input);
    addedDocKeys.push(input.key);
  }

  // navIn from navOut — tính SAU khi hợp nhất để một cạnh từ màn-flow trỏ
  // tới một màn vừa bổ sung từ tài liệu cũng được ghi nhận.
  const byKey = new Map(screens.map((s) => [s.key, s]));
  for (const s of screens) for (const n of s.navOut) byKey.get(n.to)?.navIn.push(s.key);
  for (const s of screens) s.navIn = [...new Set(s.navIn)];

  const criteria = path.join(cwd, 'criteria');
  const inputs: ScreenComponentsInputs = {
    schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ds: {
      components: await exists(path.join(criteria, 'components.md')),
      catalog: await exists(path.join(criteria, 'catalog.md')),
      rules: await exists(path.join(criteria, 'rules.md')),
      examples: await exists(path.join(criteria, 'examples.md')),
      figmaCatalog: await exists(path.join(cwd, '.figma-catalog', 'components.json')),
    },
    screens,
  };
  if (screens.length === 0) {
    // Cả hai nguồn đều rỗng — giữ nguyên 2 note cũ của WP9.
    inputs.note =
      index.length === 0
        ? 'Chưa có flows/index.json — chạy bước "Đánh giá luồng UX" (dr-flow) trước.'
        : 'Bước Đánh giá luồng UX chưa gắn màn hình nào (screens.json rỗng) — chạy lại dr-flow với gắn màn.';
  } else if (addedDocKeys.length > 0) {
    inputs.note =
      flowScreenCount === 0
        ? // flows trắng tay, danh sách hoàn toàn từ tài liệu — giữ nguyên note của WP9.
          'dr-flow chưa gắn được màn nào — danh sách màn lấy TỪ TÀI LIỆU (heading khai màn); không có bước luồng/điều hướng cho từng màn.'
        : `Bổ sung ${addedDocKeys.length} màn lấy từ tài liệu (dr-flow không gắn được): ${addedDocKeys.join(', ')} — các màn này không có bước luồng/điều hướng.`;
  }
  await fs.mkdir(path.join(cwd, 'comp'), { recursive: true });
  await fs.writeFile(path.join(cwd, SCREEN_INPUTS_FILE), JSON.stringify(inputs, null, 2), 'utf8');
  return inputs;
}

// ── Parse + validate ───────────────────────────────────────────────────────

const PLATFORMS = new Set(['mobile', 'web']);
const CONFIDENCES = new Set<Confidence>(['high', 'medium', 'low']);
const PROVENANCES = new Set<Provenance>(['text', 'flow', 'table', 'ds']);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const CONTENT_KEYS = new Set(['text', 'secondary', 'value', 'badge', 'items']);
const CONTENT_STR_MAX = 160;
const CONTENT_ITEMS_MAX = 12;
const LAYOUT_SOURCES = new Set(['doc-image', 'agent']);
const SCREEN_ORIGIN_PROVENANCES = new Set<ScreenOriginProvenance>(['document', 'flow', 'inferred-flow']);

function parseScreenOriginMetadata(raw: Record<string, unknown>): {
  provenance?: ScreenOriginProvenance;
  confidence?: number;
  evidence?: ScreenOriginEvidence;
} {
  const out: { provenance?: ScreenOriginProvenance; confidence?: number; evidence?: ScreenOriginEvidence } = {};
  const provenance = str(raw.provenance) as ScreenOriginProvenance;
  if (SCREEN_ORIGIN_PROVENANCES.has(provenance)) out.provenance = provenance;
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1) {
    out.confidence = raw.confidence;
  }
  if (raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence)) {
    const e = raw.evidence as Record<string, unknown>;
    const source = str(e.source);
    if (source) {
      const evidence: ScreenOriginEvidence = { source };
      if (str(e.anchorText)) evidence.anchorText = str(e.anchorText);
      if (Array.isArray(e.diagramEvidence)) {
        const cells = e.diagramEvidence
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
          .map((item) => ({ cellId: str(item.cellId), label: str(item.label) }))
          .filter((item) => item.cellId && item.label);
        if (cells.length) evidence.diagramEvidence = cells;
      }
      out.evidence = evidence;
    }
  }
  return out;
}

/** WP24a: lọc `elements[].content` theo đúng 5 khoá {text, secondary, value,
 *  badge, items} — khoá lạ hoặc kiểu sai bị BỎ (không hard-fail), kèm cảnh
 *  báo vào `warnings`. Mỗi string trim + cắt 160 ký tự (hằng số
 *  `CONTENT_STR_MAX`); `items` tối đa 12 phần tử (hằng số `CONTENT_ITEMS_MAX`,
 *  dư thì cắt), phần tử không
 *  phải string bị bỏ lặng lẽ (khoá "items" tồn tại và đúng kiểu mảng — chỉ
 *  từng phần tử sai kiểu, không đáng một cảnh báo riêng). Trả về `undefined`
 *  khi content không phải object hoặc rỗng sau khi lọc. */
function parseElementContent(raw: unknown, id: string, warnings: string[]): ScreenElement['content'] {
  if (raw == null) return undefined;
  const label = id || '?';
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`elements[${label}].content phải là object — bỏ.`);
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const out: NonNullable<ScreenElement['content']> = {};
  for (const k of Object.keys(o)) {
    if (!CONTENT_KEYS.has(k)) {
      warnings.push(`elements[${label}].content: khoá lạ "${k}" — bỏ.`);
      continue;
    }
    if (k === 'items') {
      const v = o[k];
      if (!Array.isArray(v)) {
        warnings.push(`elements[${label}].content.items phải là mảng string — bỏ.`);
        continue;
      }
      const strs = v
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim().slice(0, CONTENT_STR_MAX))
        .filter(Boolean);
      const capped = strs.slice(0, CONTENT_ITEMS_MAX);
      if (capped.length) out.items = capped;
      continue;
    }
    const v = o[k];
    if (typeof v !== 'string') {
      warnings.push(`elements[${label}].content.${k} phải là string — bỏ.`);
      continue;
    }
    const trimmed = v.trim().slice(0, CONTENT_STR_MAX);
    if (trimmed) (out as Record<string, string>)[k] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseRoleMap(raw: string): { doc: RoleMapDoc } | { errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { errors: [`_role-map.json không phải JSON hợp lệ: ${(e as Error).message}`] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['_role-map.json phải là một object.'] };
  const o = json as Record<string, unknown>;
  const errors: string[] = [];
  const platform = str(o.platform);
  if (!PLATFORMS.has(platform)) errors.push(`"platform" phải là "mobile" | "web" (nhận "${platform}").`);
  if (!Array.isArray(o.roles) || o.roles.length === 0) errors.push('"roles" phải là mảng không rỗng.');
  const roles: RoleMapEntry[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(o.roles) ? o.roles : []) {
    if (!r || typeof r !== 'object') {
      errors.push('Một mục "roles" không phải object.');
      continue;
    }
    const e = r as Record<string, unknown>;
    const role = str(e.role);
    if (!role) {
      errors.push('Một mục "roles" thiếu "role".');
      continue;
    }
    if (seen.has(role)) errors.push(`role "${role}" bị khai hai lần.`);
    seen.add(role);
    const component = e.component == null ? null : str(e.component) || null;
    const entry: RoleMapEntry = { role, component };
    if (str(e.anchor)) entry.anchor = str(e.anchor);
    if (str(e.variant)) entry.variant = str(e.variant);
    if (str(e.when)) entry.when = str(e.when);
    if (str(e.fallback)) entry.fallback = str(e.fallback);
    roles.push(entry);
  }
  if (errors.length) return { errors };
  const doc: RoleMapDoc = { schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION, platform: platform as 'mobile' | 'web', roles };
  if (Array.isArray(o.notes)) doc.notes = o.notes.filter((n): n is string => typeof n === 'string');
  return { doc };
}

/** `catalog` = name → `criteria/components.md#anchor` (collectComponentCatalog). */
export function validateRoleMap(doc: RoleMapDoc, catalog: Map<string, string>): string[] {
  const errors: string[] = [];
  if (catalog.size === 0) {
    for (const r of doc.roles) if (r.component) errors.push(`role "${r.role}": không có danh mục DS nên "component" phải là null (nhận "${r.component}").`);
    return errors;
  }
  const anchorOf = (ruleId: string) => ruleId.slice(ruleId.indexOf('#') + 1);
  for (const r of doc.roles) {
    if (r.component == null) continue;
    const ruleId = catalog.get(r.component);
    if (!ruleId) errors.push(`role "${r.role}": component "${r.component}" không có trong criteria/components.md.`);
    else if (r.anchor && r.anchor !== anchorOf(ruleId)) errors.push(`role "${r.role}": anchor "${r.anchor}" không phải anchor của "${r.component}" ("${anchorOf(ruleId)}").`);
  }
  return errors;
}

// ── Catalogue resolution (tolerant) ────────────────────────────────────────
// The closed catalogue disambiguates duplicate Figma names by suffixing them
// ("Heading — [SDK] Web Lib (Slot) (2548:10828)"). Agents naturally write the
// bare name, or get the anchor right but retype the name. Resolve by exact
// name → anchor → unique base name; only an unknown or ambiguous name (two
// catalogue entries share the base name and no valid anchor was given) fails.

export type CatalogHit = { component: string; anchor: string; note?: string };
export type CatalogMiss = { reason: 'unknown' | 'ambiguous'; candidates: string[] };

function baseComponentName(name: string): string {
  return name
    .replace(/\s+—\s+.*$/, '')
    .replace(/\s*\(\d+:\d+\)\s*$/, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

export function resolveCatalogEntry(catalog: Map<string, string>, component: string, anchor?: string): CatalogHit | CatalogMiss {
  const anchorOf = (ruleId: string) => ruleId.slice(ruleId.indexOf('#') + 1);
  const exact = catalog.get(component);
  if (exact) {
    const canon = anchorOf(exact);
    return { component, anchor: canon, ...(anchor && anchor !== canon ? { note: `anchor "${anchor}" sửa thành "${canon}" (anchor của "${component}")` } : {}) };
  }
  if (anchor) {
    for (const [name, ruleId] of catalog) {
      if (anchorOf(ruleId) === anchor) {
        return { component: name, anchor, note: `"${component}" đọc theo anchor "${anchor}" → "${name}"` };
      }
    }
  }
  const base = baseComponentName(component);
  const candidates = base ? [...catalog.keys()].filter((name) => baseComponentName(name) === base) : [];
  if (candidates.length === 1) {
    const name = candidates[0]!;
    return { component: name, anchor: anchorOf(catalog.get(name)!), note: `"${component}" khớp tên "${name}"` };
  }
  return { reason: candidates.length > 1 ? 'ambiguous' : 'unknown', candidates };
}

function missText(component: string, miss: CatalogMiss): string {
  return miss.reason === 'ambiguous'
    ? `component "${component}" trùng ${miss.candidates.length} mục trong criteria/components.md (${miss.candidates.slice(0, 4).join(' | ')}) mà không có anchor để phân biệt`
    : `component "${component}" không có trong criteria/components.md`;
}

/** Tolerant twin of {@link validateRoleMap}: resolves every role's component
 *  against the catalogue, downgrades unknown/ambiguous ones to `null` (+
 *  fallback text) instead of failing the whole stage, and records what it
 *  changed in `warnings`. Only an empty role list is an error. */
export function normalizeRoleMap(doc: RoleMapDoc, catalog: Map<string, string>): { doc: RoleMapDoc; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const roles: RoleMapEntry[] = doc.roles.map((r) => {
    if (r.component == null) return r;
    if (catalog.size === 0) {
      warnings.push(`role "${r.role}": không có danh mục DS nên bỏ component "${r.component}".`);
      return { ...r, component: null, fallback: r.fallback ?? `Agent đề xuất "${r.component}" — không có danh mục DS để đối chiếu` };
    }
    const hit = resolveCatalogEntry(catalog, r.component, r.anchor);
    if ('reason' in hit) {
      warnings.push(`role "${r.role}": ${missText(r.component, hit)} — hạ về null.`);
      const { anchor: _drop, ...rest } = r;
      return { ...rest, component: null, fallback: r.fallback ?? `Agent đề xuất "${r.component}" — không có trong danh mục DS` };
    }
    if (hit.note) warnings.push(`role "${r.role}": ${hit.note}.`);
    return { ...r, component: hit.component, anchor: hit.anchor };
  });
  const errors: string[] = roles.length === 0 ? ['"roles" rỗng.'] : [];
  const out: RoleMapDoc = { ...doc, roles };
  if (warnings.length) out.warnings = warnings;
  return { doc: out, warnings, errors };
}

export function parseScreenComponentsDoc(raw: string): { doc: ScreenComponentsDoc } | { errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { errors: [`screen.json không phải JSON hợp lệ: ${(e as Error).message}`] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['screen.json phải là một object.'] };
  const o = json as Record<string, unknown>;
  const errors: string[] = [];
  // WP24a: cảnh báo mềm (content/layoutSource lạ) — không hard-fail, thread
  // qua doc.warnings để normalizeScreenComponentsDoc gộp thêm warning của nó.
  const parseWarnings: string[] = [];
  const key = str(o.key);
  if (!key) errors.push('Thiếu "key" (SCREEN-KEY).');
  const platform = str(o.platform);
  if (!PLATFORMS.has(platform)) errors.push(`"platform" phải là "mobile" | "web" (nhận "${platform}").`);
  if (!Array.isArray(o.elements)) errors.push('"elements" phải là mảng.');
  const elements: ScreenElement[] = [];
  const ids = new Set<string>();
  for (const [i, e] of (Array.isArray(o.elements) ? o.elements : []).entries()) {
    if (!e || typeof e !== 'object') {
      errors.push(`elements[${i}] không phải object.`);
      continue;
    }
    const el = e as Record<string, unknown>;
    const id = str(el.id);
    const label = str(el.label);
    const role = str(el.role);
    if (!id) errors.push(`elements[${i}] thiếu "id".`);
    else if (!/^[A-Za-z0-9_.-]+$/.test(id)) errors.push(`elements[${i}] "id" chỉ gồm chữ/số/_/-/. (nhận "${id}").`);
    else if (ids.has(id)) errors.push(`elements[${i}] "id" "${id}" bị trùng.`);
    ids.add(id);
    if (!label) errors.push(`elements[${i}] (${id}) thiếu "label".`);
    if (!role) errors.push(`elements[${i}] (${id}) thiếu "role".`);
    let ds: ScreenElement['ds'] = null;
    if (el.ds != null) {
      if (typeof el.ds !== 'object') errors.push(`elements[${i}] (${id}) "ds" phải là object hoặc null.`);
      else {
        const d = el.ds as Record<string, unknown>;
        const component = str(d.component);
        const anchor = str(d.anchor);
        if (!component || !anchor) errors.push(`elements[${i}] (${id}) "ds" cần cả "component" lẫn "anchor".`);
        ds = { component, anchor, ...(str(d.variant) ? { variant: str(d.variant) } : {}) };
      }
    }
    const confidence = str(el.confidence) as Confidence;
    const provenance = str(el.provenance) as Provenance;
    const entry: ScreenElement = {
      id,
      label,
      role,
      ds,
      confidence: CONFIDENCES.has(confidence) ? confidence : 'medium',
      provenance: PROVENANCES.has(provenance) ? provenance : 'text',
    };
    if (str(el.docType)) entry.docType = str(el.docType);
    if (str(el.why)) entry.why = str(el.why);
    const content = parseElementContent(el.content, id, parseWarnings);
    if (content) entry.content = content;
    elements.push(entry);
  }
  const nav: { el: string; to: string }[] = [];
  for (const [i, n] of (Array.isArray(o.nav) ? o.nav : []).entries()) {
    if (!n || typeof n !== 'object') continue;
    const nn = n as Record<string, unknown>;
    const el = str(nn.el);
    const to = str(nn.to);
    if (!el || !to) errors.push(`nav[${i}] cần "el" và "to".`);
    else if (!ids.has(el)) errors.push(`nav[${i}]: "el" "${el}" không phải id element nào của màn.`);
    else nav.push({ el, to });
  }
  if (errors.length) return { errors };
  const doc: ScreenComponentsDoc = {
    schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION,
    key,
    name: str(o.name),
    flowId: str(o.flowId),
    platform: platform as 'mobile' | 'web',
    source: str(o.source) || null,
    elements,
    nav,
    ...parseScreenOriginMetadata(o),
  };
  if (Array.isArray(o.notes)) doc.notes = o.notes.filter((n): n is string => typeof n === 'string');
  // WP24a: layoutSource là siêu dữ liệu daemon TỰ GHI ĐÈ sau normalize
  // (server.ts) — agent có khai gì ở đây cũng không quyết; giá trị lạ chỉ bị
  // bỏ + cảnh báo (không hard-fail), để tránh chặn cả màn vì một field agent
  // không cần biết.
  if (o.layoutSource != null) {
    const ls = str(o.layoutSource);
    if (LAYOUT_SOURCES.has(ls)) doc.layoutSource = ls as 'doc-image' | 'agent';
    else parseWarnings.push(`"layoutSource" phải là "doc-image" | "agent" (nhận "${ls}") — bỏ.`);
  }
  if (parseWarnings.length) doc.warnings = parseWarnings;
  return { doc };
}

export interface ValidateScreenContext {
  /** The SCREEN-KEY this run was asked to produce. */
  expectedKey: string;
  /** Every screen key of the feature (for `nav[].to`). */
  screenKeys: ReadonlySet<string>;
  /** name → `criteria/components.md#anchor`; empty when no DS. */
  catalog: Map<string, string>;
  /** Wireframe HTML the agent wrote (null = missing). */
  wireframeHtml: string | null;
}

/** All `data-comp` / `data-el` / `data-nav` values in a wireframe. */
export function scanWireframe(html: string): { screen: string | null; layout: string | null; comps: string[]; els: string[]; navs: string[]; hasScript: boolean; hasStyle: boolean } {
  const attr = (name: string) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]!.trim());
  const body = /<body\b([^>]*)>/i.exec(html)?.[1] ?? '';
  const bodyAttr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(body)?.[1]?.trim() ?? null;
  return {
    screen: bodyAttr('data-screen'),
    layout: bodyAttr('data-layout'),
    comps: attr('data-comp').filter(Boolean),
    els: attr('data-el').filter(Boolean),
    navs: attr('data-nav').filter(Boolean),
    hasScript: /<script\b/i.test(html),
    hasStyle: /<style\b/i.test(html),
  };
}

export function validateScreenComponentsDoc(doc: ScreenComponentsDoc, ctx: ValidateScreenContext): string[] {
  const errors: string[] = [];
  if (doc.key !== ctx.expectedKey) errors.push(`"key" phải là "${ctx.expectedKey}" (nhận "${doc.key}").`);
  const anchors = new Set([...ctx.catalog.values()].map((r) => r.slice(r.indexOf('#') + 1)));
  const hasCatalog = ctx.catalog.size > 0;
  for (const el of doc.elements) {
    if (!el.ds) continue;
    if (!hasCatalog) {
      errors.push(`element "${el.id}": không có danh mục DS (criteria/components.md) nên "ds" phải là null.`);
      continue;
    }
    const ruleId = ctx.catalog.get(el.ds.component);
    if (!ruleId) errors.push(`element "${el.id}": component "${el.ds.component}" không có trong criteria/components.md.`);
    else if (el.ds.anchor !== ruleId.slice(ruleId.indexOf('#') + 1)) errors.push(`element "${el.id}": anchor "${el.ds.anchor}" không phải anchor của "${el.ds.component}".`);
  }
  for (const n of doc.nav) {
    if (!ctx.screenKeys.has(n.to)) errors.push(`nav "${n.el}" → "${n.to}": không phải SCREEN-KEY nào của luồng.`);
  }
  if (ctx.wireframeHtml == null) {
    errors.push(`Thiếu wireframe "${wireframeRel(doc.key)}".`);
    return errors;
  }
  const w = scanWireframe(ctx.wireframeHtml);
  if (!/^\s*<!doctype html>/i.test(ctx.wireframeHtml)) errors.push('Wireframe phải bắt đầu bằng "<!doctype html>".');
  if (w.hasScript) errors.push('Wireframe không được chứa <script>.');
  if (!w.hasStyle) errors.push('Wireframe thiếu <style> (chép wireframes/_wireframe.css vào).');
  if (w.screen !== doc.key) errors.push(`Wireframe: <body data-screen> phải là "${doc.key}" (nhận "${w.screen ?? ''}").`);
  if (w.layout && w.layout !== doc.platform) errors.push(`Wireframe: data-layout "${w.layout}" khác "platform" trong JSON ("${doc.platform}").`);
  if (hasCatalog) for (const c of new Set(w.comps)) if (!anchors.has(c)) errors.push(`Wireframe: data-comp="${c}" không phải anchor nào trong criteria/components.md.`);
  const elIds = new Set(doc.elements.map((e) => e.id));
  for (const id of new Set(w.els)) if (!elIds.has(id)) errors.push(`Wireframe: data-el="${id}" không có trong elements[] của JSON.`);
  const missing = doc.elements.filter((e) => !w.els.includes(e.id));
  if (missing.length) errors.push(`Wireframe thiếu block data-el cho ${missing.length} element: ${missing.slice(0, 6).map((e) => e.id).join(', ')}${missing.length > 6 ? '…' : ''}.`);
  for (const t of new Set(w.navs)) if (!ctx.screenKeys.has(t)) errors.push(`Wireframe: data-nav="${t}" không phải SCREEN-KEY nào của luồng.`);
  return errors;
}

/** Tolerant twin of {@link validateScreenComponentsDoc}, used by the daemon:
 *  HARD errors only for what the viewer cannot work around (wrong key,
 *  missing wireframe, `<script>` in the wireframe). Everything else is
 *  normalised — unknown component → `ds: null` + why, wrong anchor → the
 *  catalogue's, unknown `nav.to`/`data-nav` dropped, unknown `data-comp`
 *  stripped, missing doctype prepended, `data-screen`/`data-layout` fixed —
 *  and recorded in `warnings`. Returns the doc + wireframe to write back. */
export function normalizeScreenComponentsDoc(
  doc: ScreenComponentsDoc,
  ctx: ValidateScreenContext,
): { doc: ScreenComponentsDoc; wireframeHtml: string | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  // WP24a: giữ lại warning mềm từ parseScreenComponentsDoc (content/layoutSource
  // lạ) — trước đây `out.warnings` bị GHI ĐÈ (xem cuối hàm) nên chỉ còn
  // warning của normalize; nay cộng dồn để không mất cảnh báo parse-time.
  const warnings: string[] = doc.warnings ? [...doc.warnings] : [];
  if (doc.key !== ctx.expectedKey) errors.push(`"key" phải là "${ctx.expectedKey}" (nhận "${doc.key}").`);
  const anchors = new Set([...ctx.catalog.values()].map((r) => r.slice(r.indexOf('#') + 1)));
  const hasCatalog = ctx.catalog.size > 0;
  const anchorRewrite = new Map<string, string | null>(); // data-comp value → canonical anchor | null (strip)

  const elements: ScreenElement[] = doc.elements.map((el) => {
    if (!el.ds) return el;
    if (!hasCatalog) {
      warnings.push(`element "${el.id}": không có danh mục DS — bỏ "ds" (${el.ds.component}).`);
      anchorRewrite.set(el.ds.anchor, null);
      return { ...el, ds: null, why: el.why ?? `Agent đề xuất "${el.ds.component}" — không có danh mục DS để đối chiếu` };
    }
    const hit = resolveCatalogEntry(ctx.catalog, el.ds.component, el.ds.anchor);
    if ('reason' in hit) {
      warnings.push(`element "${el.id}": ${missText(el.ds.component, hit)} — hạ "ds" về null.`);
      if (el.ds.anchor && !anchors.has(el.ds.anchor)) anchorRewrite.set(el.ds.anchor, null);
      const why = `Đề xuất "${el.ds.component}" không có trong danh mục DS.${el.why ? ` ${el.why}` : ''}`;
      return { ...el, ds: null, confidence: 'low', why };
    }
    if (hit.note) warnings.push(`element "${el.id}": ${hit.note}.`);
    if (el.ds.anchor && el.ds.anchor !== hit.anchor) anchorRewrite.set(el.ds.anchor, hit.anchor);
    return { ...el, ds: { component: hit.component, anchor: hit.anchor, ...(el.ds.variant ? { variant: el.ds.variant } : {}) } };
  });

  const nav = doc.nav.filter((n) => {
    if (ctx.screenKeys.has(n.to)) return true;
    warnings.push(`nav "${n.el}" → "${n.to}": không phải SCREEN-KEY nào của luồng — bỏ.`);
    return false;
  });

  let html = ctx.wireframeHtml;
  if (html == null) {
    errors.push(`Thiếu wireframe "${wireframeRel(doc.key)}".`);
  } else {
    if (/<script\b/i.test(html)) errors.push('Wireframe không được chứa <script>.');
    if (!/^\s*<!doctype html>/i.test(html)) {
      warnings.push('Wireframe thiếu "<!doctype html>" — daemon thêm vào.');
      html = `<!doctype html>\n${html.replace(/^\s*<!doctype[^>]*>\s*/i, '')}`;
    }
    if (!/<style\b/i.test(html)) warnings.push('Wireframe không có <style> (không chép wireframes/_wireframe.css) — hiển thị sẽ thô.');
    const w = scanWireframe(html);
    const setBodyAttr = (name: string, value: string) => {
      html = html!.replace(/<body\b([^>]*)>/i, (_m, attrs: string) => {
        const re = new RegExp(`\\s${name}="[^"]*"`, 'i');
        const next = re.test(attrs) ? attrs.replace(re, ` ${name}="${value}"`) : `${attrs} ${name}="${value}"`;
        return `<body${next}>`;
      });
    };
    if (w.screen !== doc.key) {
      warnings.push(`Wireframe: <body data-screen> là "${w.screen ?? ''}" — daemon sửa thành "${doc.key}".`);
      setBodyAttr('data-screen', doc.key);
    }
    if (w.layout !== doc.platform) {
      warnings.push(`Wireframe: data-layout "${w.layout ?? ''}" — daemon sửa thành "${doc.platform}".`);
      setBodyAttr('data-layout', doc.platform);
    }
    if (hasCatalog) {
      for (const c of new Set(w.comps)) {
        if (anchors.has(c)) continue;
        const to = anchorRewrite.get(c);
        if (to) {
          warnings.push(`Wireframe: data-comp="${c}" đổi thành "${to}".`);
          html = html.replace(new RegExp(`(\\sdata-comp=")${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(")`, 'g'), `$1${to}$2`);
        } else {
          warnings.push(`Wireframe: data-comp="${c}" không phải anchor nào trong criteria/components.md — daemon bỏ thuộc tính.`);
          html = html.replace(new RegExp(`\\sdata-comp="${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), '');
        }
      }
    } else if (w.comps.length) {
      warnings.push('Wireframe: không có danh mục DS — daemon bỏ mọi data-comp.');
      html = html.replace(/\sdata-comp="[^"]*"/g, '');
    }
    const elIds = new Set(elements.map((e) => e.id));
    const ghosts = [...new Set(w.els)].filter((id) => !elIds.has(id));
    if (ghosts.length) warnings.push(`Wireframe: data-el không có trong elements[]: ${ghosts.slice(0, 6).join(', ')}${ghosts.length > 6 ? '…' : ''}.`);
    const missing = elements.filter((e) => !w.els.includes(e.id));
    if (missing.length) warnings.push(`Wireframe thiếu block data-el cho ${missing.length} element: ${missing.slice(0, 6).map((e) => e.id).join(', ')}${missing.length > 6 ? '…' : ''}.`);
    for (const t of new Set(w.navs)) {
      if (ctx.screenKeys.has(t)) continue;
      warnings.push(`Wireframe: data-nav="${t}" không phải SCREEN-KEY nào của luồng — daemon bỏ thuộc tính.`);
      html = html.replace(new RegExp(`\\sdata-nav="${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), '');
    }
  }

  const out: ScreenComponentsDoc = { ...doc, elements, nav };
  if (warnings.length) out.warnings = warnings;
  else delete out.warnings;
  return { doc: out, wireframeHtml: html, errors, warnings };
}

// ── Merge ──────────────────────────────────────────────────────────────────

export interface ScreenComponentsIndexEntry {
  key: string;
  name: string;
  flowId: string;
  order: number;
  platform: 'mobile' | 'web';
  source: string | null;
  elements: number;
  mapped: number;
  files: { screen: string; wireframe: string };
  navOut: string[];
  /** WP24a: chép nguyên từ ScreenComponentsDoc.layoutSource — xem docblock ở đó. */
  layoutSource?: 'doc-image' | 'agent';
  provenance?: ScreenOriginProvenance;
  confidence?: number;
  evidence?: ScreenOriginEvidence;
}

export interface ScreenComponentsIndex {
  schema_version: typeof SCREEN_COMPONENTS_SCHEMA_VERSION;
  generatedAt: string;
  roleMap: string;
  screens: ScreenComponentsIndexEntry[];
  failed: { key: string; name: string; errors: string[] }[];
}

const CONF_VI: Record<Confidence, string> = { high: 'cao', medium: 'vừa', low: 'thấp' };

export function mergeScreenComponents(
  docs: ScreenComponentsDoc[],
  inputs: ScreenComponentsInputs,
  failed: { key: string; name: string; errors: string[] }[],
  generatedAt: string,
): { index: ScreenComponentsIndex; summaryMd: string } {
  const orderOf = new Map(inputs.screens.map((s) => [s.key, s.order]));
  const nameOf = new Map(inputs.screens.map((s) => [s.key, s.name]));
  const sorted = [...docs].sort((a, b) => (orderOf.get(a.key) ?? 1e9) - (orderOf.get(b.key) ?? 1e9));
  const screens: ScreenComponentsIndexEntry[] = sorted.map((d) => ({
    key: d.key,
    name: d.name || nameOf.get(d.key) || d.key,
    flowId: d.flowId,
    order: orderOf.get(d.key) ?? 1e9,
    platform: d.platform,
    source: d.source,
    elements: d.elements.length,
    mapped: d.elements.filter((e) => e.ds).length,
    files: { screen: screenDocRel(d.key), wireframe: wireframeRel(d.key) },
    navOut: [...new Set(d.nav.map((n) => n.to))],
    ...(d.layoutSource ? { layoutSource: d.layoutSource } : {}),
    ...(d.provenance ? { provenance: d.provenance } : {}),
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    ...(d.evidence ? { evidence: d.evidence } : {}),
  }));
  const index: ScreenComponentsIndex = { schema_version: SCREEN_COMPONENTS_SCHEMA_VERSION, generatedAt, roleMap: ROLE_MAP_FILE, screens, failed };

  const lines: string[] = ['# Màn hình → Component', ''];
  lines.push(`${screens.length} màn hình có đề xuất component; ${failed.length} màn chạy hỏng.`, '');
  lines.push('| # | Màn hình | Nền tảng | Element | Đã map DS | Điều hướng tới |', '|---|---|---|---|---|---|');
  screens.forEach((s, i) => lines.push(`| ${i + 1} | ${s.name} (\`${s.key}\`) | ${s.platform} | ${s.elements} | ${s.mapped} | ${s.navOut.join(', ') || '—'} |`));
  lines.push('');
  for (const d of sorted) {
    lines.push(`## ${d.name || d.key}`, '', `Wireframe: \`${wireframeRel(d.key)}\``, '');
    lines.push('| Element | Vai trò | Component DS | Biến thể | Tin cậy | Nguồn |', '|---|---|---|---|---|---|');
    for (const e of d.elements) {
      lines.push(`| ${e.label} | ${e.role} | ${e.ds ? e.ds.component : '—'} | ${e.ds?.variant ?? '—'} | ${CONF_VI[e.confidence]} | ${e.provenance}${e.docType ? ` (tài liệu khai: ${e.docType})` : ''} |`);
    }
    if (d.notes?.length) lines.push('', ...d.notes.map((n) => `- ${n}`));
    lines.push('');
  }
  if (failed.length) {
    lines.push('## Màn chạy hỏng', '');
    for (const f of failed) lines.push(`- **${f.name}** (\`${f.key}\`): ${f.errors.join('; ')}`);
    lines.push('');
  }
  return { index, summaryMd: `${lines.join('\n').trim()}\n` };
}
