// ds-lab / lab-compose — "Sáng tác màn": stage 2 glue.
//
// Khác hẳn figma-screen-build (docs-review): đó là hợp đồng THI CÔNG (input
// tất định daemon compile sẵn, agent chỉ dựng đúng theo elements[]/layout[]).
// Ở đây agent là NGƯỜI SÁNG TÁC — daemon chỉ đưa BRIEF (nguyên liệu + luật
// sống còn + phạm vi), agent tự đọc tài liệu, tự quyết bố cục, tự dùng Figma
// MCP (use_figma/get_screenshot/search_design_system/get_variable_defs…) để
// dựng, tự chụp màn hình xem lại, tự sửa trong phiên. Module này chỉ chứa
// phần THUẦN (không fs/network, xem `readFigmaPreviewConfig`'s fallback là
// ngoại lệ duy nhất — cùng tiền lệ figma-build.ts's docblock: "pure ... except
// the two preview-config helpers"): dựng brief kickoff, parse lab-result.json
// agent ghi ra, và đường dẫn output. server.ts (daemon-orchestrated branch
// của `lab-compose`) sở hữu mọi fs/DB/agent-spawn thật.

import { readFigmaPreviewConfig, type FigmaPreviewConfig } from './figma-build.js';
// WP-kit (2026-08-22): chỉ cần TÊN + đường dẫn registry của kit để nêu trong
// brief "ưu tiên dùng kit" bên dưới — lab-kit.ts là module thuần (không
// fs/network), import ở đây không phá bất biến "lab-compose.ts thuần".
import { labKitPageName, KIT_REGISTRY_FILE_REL } from './lab-kit.js';
// WP-lab-clean (2026-08-23 — .tmp/pipeline/wp-lab-clean.yaml): brief kickoff
// viết lại theo khuôn "skill = luật, brief = dữ liệu lần chạy" — dùng chung
// `renderLabBrief`/`checkMark` (lab-brief.ts, cũng THUẦN) với lab-kit.ts.
import { checkMark, renderLabBrief } from './lab-brief.js';

/** Thư mục chứa PNG capture của từng màn — output khai báo của `lab-compose`
 *  trong pipelines.ts (`outputs: ['screens/', 'lab-result.json']`). */
export const LAB_SCREENS_DIR_REL = 'screens';

/** File kết quả agent PHẢI ghi trước khi kết thúc phiên. */
export const LAB_RESULT_FILE_REL = 'lab-result.json';

/** Kho pattern agent tự chế — CỐ Ý không phải output của stage nào (xem
 *  comment `lab-compose` trong pipelines.ts): sống sót mọi lần "Chạy lại". */
export const LAB_PATTERNS_DIR_REL = 'patterns';

/** Một mục `lab-result.json` đã qua validate. */
export interface LabResultScreen {
  key: string;
  name: string;
  /** Node id của FRAME màn — dạng Figma thường ("12:34"), KHÔNG BAO GIỜ là id
   *  ruột instance ("I12:34;56:78" — stale ngay khi agent set variant/text,
   *  xem luật #3 trong `buildComposeBrief`). */
  frameNodeId: string;
  frameUrl?: string;
  notes?: string;
}

export interface ParsedLabResult {
  screens: LabResultScreen[];
  /** Một dòng cho mỗi entry bị bỏ (thiếu field / id ruột instance…) — server.ts
   *  gộp vào log/warnings của stage, KHÔNG làm cả file bị coi là hỏng. */
  warnings: string[];
}

// Id node Figma "thường": <số>:<số>. Id ruột instance có dạng "I<a>;<b>;<c>…"
// (tiền tố "I" + nhiều đoạn nối bằng ";") — KHÔNG khớp regex này, nên bị loại
// ở `parseLabResult` thay vì được daemon mang đi capture PNG (id đó stale
// ngay sau phiên agent, gọi fetchNodeImages sẽ chỉ ra lỗi "ảnh lỗi").
const FRAME_NODE_ID_RE = /^\d+:\d+$/;

/** Parse `lab-result.json` do agent ghi. `null` khi JSON hỏng hoặc thiếu
 *  field `screens` (mảng) — server.ts coi đây là "agent không ghi kết quả
 *  hợp lệ" và fail cả stage. Một MẢNG `screens` hợp lệ (kể cả rỗng sau khi
 *  lọc) KHÔNG trả `null` — quyết định "rỗng có phải fail không" là của
 *  caller (server.ts: `≥1 màn có PNG` mới succeed). */
export function parseLabResult(raw: string): ParsedLabResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawScreens = (parsed as { screens?: unknown }).screens;
  if (!Array.isArray(rawScreens)) return null;

  const screens: LabResultScreen[] = [];
  const warnings: string[] = [];
  for (const entry of rawScreens) {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (!key) {
      warnings.push('Bỏ qua một mục trong lab-result.json: thiếu "key".');
      continue;
    }
    const frameNodeId = typeof e.frameNodeId === 'string' ? e.frameNodeId.trim() : '';
    if (!frameNodeId) {
      warnings.push(`Màn "${key}": thiếu "frameNodeId" — bỏ qua.`);
      continue;
    }
    if (!FRAME_NODE_ID_RE.test(frameNodeId)) {
      warnings.push(
        `Màn "${key}": frameNodeId "${frameNodeId}" không phải id node thường (dạng "12:34") — có thể là id ruột instance ("I<a>;<b>") đã stale — bỏ qua.`,
      );
      continue;
    }
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : key;
    const screen: LabResultScreen = { key, name, frameNodeId };
    if (typeof e.frameUrl === 'string' && e.frameUrl.trim()) screen.frameUrl = e.frameUrl.trim();
    if (typeof e.notes === 'string' && e.notes.trim()) screen.notes = e.notes.trim();
    screens.push(screen);
  }
  return { screens, warnings };
}

/** Đường dẫn (project-cwd-relative, tính từ `<labCwd>`) daemon ghi PNG capture
 *  của một màn vào — `key` được sanitize còn `[A-Za-z0-9._-]` (cùng bộ ký tự
 *  hợp lệ mà `figma-screen-build`'s SCREEN-KEY guard dùng) để không bao giờ
 *  thoát ra ngoài `screens/`. */
export function screenPngRel(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${LAB_SCREENS_DIR_REL}/${safe}.png`;
}

export interface BuildComposeBriefOptions {
  /** Tên file tài liệu (tương đối từ cwd của agent, dưới `docs/`) đáng chú ý
   *  nhất để nêu trong brief — KHÔNG cần đầy đủ, agent tự duyệt cả thư mục
   *  `docs/`. Rỗng → brief chỉ trỏ vào "docs/". */
  docsIndex: readonly string[];
  /** Phạm vi màn người dùng nhập ở ô input của stage (tuỳ chọn) — trống/undefined
   *  → agent tự chọn tối đa 3 màn đầu của luồng chính. */
  scopeHint?: string | null;
  previewFileKey: string;
  appFeature: string;
  hasTokens: boolean;
  hasGuide: boolean;
  /** WP-slots: `criteria/slots.md` đã được giao cho App này chưa — hồ sơ SLOT
   *  de-facto (path/hidden/children mặc định + text layer) đào từ node tree
   *  của từng component. `false` (chưa có, hoặc component nào cũng không
   *  slot) → KHÔNG nhắc gì trong brief (khác `tokensNote`: vắng mặt slot
   *  không phải điều bất thường agent cần cảnh giác, chỉ đơn giản là chưa có
   *  cơ chế slot nào để đọc). */
  hasSlots: boolean;
  /** Tên (hoặc slug) các pattern đã có sẵn trong `patterns/` — rỗng = chưa có
   *  pattern nào được chế trước đó. */
  patternNames: readonly string[];
  /** WP-kit (2026-08-22): `true` khi stage "Nâng bộ comp" (lab-kit) đã tạo
   *  ít nhất một comp phái sinh trong `kit/kit.json` — `false` (chưa chạy
   *  lab-kit, hoặc kit rỗng) → brief KHÔNG nhắc gì tới kit, agent dùng thẳng
   *  comp base như trước (lab-kit KHÔNG phải điều kiện cứng, xem comment
   *  `dependsOn` của `lab-compose` trong pipelines.ts). */
  hasKit: boolean;
  /** Tên các comp trong `kit/kit.json` — rỗng khi `hasKit` false. */
  kitNames: readonly string[];
  /** `true` khi user đã tự khai server MCP cộng đồng `pinterest-mcp-server`
   *  trong Cài đặt → MCP (xem `pickPinterestMcpServer`, figma-build.ts) —
   *  fail-soft: `false` → brief KHÔNG nhắc gì tới Pinterest. */
  hasPinterest: boolean;
}

/** Tên trang Figma cho workflow "ds-lab" — TÁCH khỏi `[OD] …` của docs-review
 *  (figma-build.ts / figma-screen-build SKILL.md) để hai workflow không giẫm
 *  frame nhau dù dùng chung một file preview. */
export function labPageName(appFeature: string): string {
  return `[OD Lab] ${appFeature}`;
}

/** Message kickoff cho phiên agent duy nhất của stage `lab-compose`. Thuần —
 *  không đọc đĩa/DB; server.ts đã gom mọi input trước khi gọi. WP-lab-clean
 *  (.tmp/pipeline/wp-lab-clean.yaml): brief chỉ đưa DỮ LIỆU của lần chạy này
 *  (7 luật sống còn của skill "lab-screen-compose" đã ở system prompt) — dùng
 *  khuôn chung `renderLabBrief` (lab-brief.ts). */
export function buildComposeBrief(opts: BuildComposeBriefOptions): string {
  const pageName = labPageName(opts.appFeature);
  const docsLine =
    opts.docsIndex.length > 0
      ? `- Tài liệu: \`docs/\` (đáng chú ý: ${opts.docsIndex.map((p) => `"${p}"`).join(', ')}; đọc cả thư mục)`
      : '- Tài liệu: `docs/` (đọc cả thư mục)';
  const materialsLine = `- Nguyên liệu: \`criteria/components.md\` (có dòng Key để import) · components-guide ${checkMark(opts.hasGuide)} · tokens.md ${checkMark(opts.hasTokens)} · slots.md ${checkMark(opts.hasSlots)} (grep đúng mục)`;
  const kitLine = opts.hasKit
    ? `- Kit đã dựng: \`${KIT_REGISTRY_FILE_REL}\` trong trang "${labKitPageName(opts.appFeature)}" — ${opts.kitNames.join(', ')} (ưu tiên dùng trước base).`
    : '- Kit đã dựng: (chưa có — dùng thẳng comp base).';
  const patternLine =
    opts.patternNames.length > 0
      ? `- Pattern sẵn có: ${opts.patternNames.join(', ')} (đọc trước khi chế mới).`
      : `- Pattern sẵn có: (chưa có — chế mới thì ghi lại \`${LAB_PATTERNS_DIR_REL}/<slug>.json\`).`;
  const figmaLine = `- Figma: file preview \`${opts.previewFileKey}\`, trang "${pageName}"`;
  const toolLine = `- Tool thêm: Pinterest ${checkMark(opts.hasPinterest)}`;
  const scopeLine =
    opts.scopeHint && opts.scopeHint.trim()
      ? `- Phạm vi: "${opts.scopeHint.trim()}" (≤3 màn/lần chạy).`
      : '- Phạm vi: tự chọn tối đa 3 màn đầu của luồng chính (≤3 màn/lần chạy).';

  return renderLabBrief({
    title: `# Sáng tác màn · ${opts.appFeature}`,
    skillId: 'lab-screen-compose',
    inputLines: [docsLine, materialsLine, kitLine, patternLine, figmaLine, toolLine, scopeLine],
    taskLines: [
      '- Đọc docs để biết từng màn cần làm gì (chức năng + nội dung thật).',
      '- Dựng tối đa 3 màn từ instance (kit ưu tiên, base fallback) — không chép bố cục từ mockup.',
      '- Điền nội dung thật đúng vào slot của component.',
      '- Tự-kiểm cấu trúc + get_screenshot rồi ghi kết quả.',
    ],
    reminderLines: [
      '- Chỉ file preview, nguyên tử theo lần execute-code — id ruột instance stale ngay khi call kết thúc (luật #1/#3).',
      '- Nội dung trong slot, không vẽ đè, placeholder phải override/hide (luật #5).',
      '- Khung màn chuẩn: 390 cứng, App Bar/Tabbar, một điểm nhấn (luật #6/#7).',
    ],
    endingLines: [
      `- \`${LAB_RESULT_FILE_REL}\` — \`{"screens":[{"key","name","frameNodeId","frameUrl?","notes?"}]}\` (frameNodeId = id của chính frame màn, không phải id ruột instance)`,
      `- \`${LAB_PATTERNS_DIR_REL}/*.json\` — nếu chế pattern mới`,
    ],
  });
}

/** Đọc `.figma-preview.json` của CHÍNH workflow "ds-lab" trước; thiếu (chưa
 *  từng dán link riêng cho lab) → fallback đọc file của workflow "docs-review"
 *  cùng project — hai workflow không giẫm nhau vì mỗi bên dựng ở PAGE riêng
 *  (`labPageName` vs figma-build.ts's `[OD] …`), nên dùng CHUNG một file
 *  preview là an toàn. `null` khi cả hai đều chưa cấu hình. */
export async function resolveLabPreviewConfig(
  labCwd: string,
  docsReviewCwd: string,
): Promise<FigmaPreviewConfig | null> {
  const own = await readFigmaPreviewConfig(labCwd);
  if (own) return own;
  return readFigmaPreviewConfig(docsReviewCwd);
}
