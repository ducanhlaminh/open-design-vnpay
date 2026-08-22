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
  /** Tên (hoặc slug) các pattern đã có sẵn trong `patterns/` — rỗng = chưa có
   *  pattern nào được chế trước đó. */
  patternNames: readonly string[];
}

/** Tên trang Figma cho workflow "ds-lab" — TÁCH khỏi `[OD] …` của docs-review
 *  (figma-build.ts / figma-screen-build SKILL.md) để hai workflow không giẫm
 *  frame nhau dù dùng chung một file preview. */
export function labPageName(appFeature: string): string {
  return `[OD Lab] ${appFeature}`;
}

/** Message kickoff cho phiên agent duy nhất của stage `lab-compose`. Thuần —
 *  không đọc đĩa/DB; server.ts đã gom mọi input trước khi gọi. */
export function buildComposeBrief(opts: BuildComposeBriefOptions): string {
  const pageName = labPageName(opts.appFeature);
  const scope =
    opts.scopeHint && opts.scopeHint.trim()
      ? opts.scopeHint.trim()
      : 'tự chọn tối đa 3 màn đầu của luồng chính';
  const docsLine =
    opts.docsIndex.length > 0
      ? `"docs/" (đáng chú ý: ${opts.docsIndex.map((p) => `"${p}"`).join(', ')} — nhưng đọc cả thư mục, không chỉ các file này)`
      : '"docs/" (đọc mọi trang trong thư mục này)';
  const guideNote = opts.hasGuide ? ', "criteria/components-guide.md" (mô tả thêm cho từng component)' : '';
  const tokensNote = opts.hasTokens
    ? ', "criteria/tokens.md" (style CHỈ được lấy từ đây — cấm giá trị ngoài danh mục, dùng get_variable_defs đối chiếu thêm)'
    : ' — LƯU Ý: "criteria/tokens.md" CHƯA có cho dự án này, không có bảng token nào để đối chiếu';
  const patternsNote =
    opts.patternNames.length > 0
      ? `Pattern đã chế từ trước (ĐỌC trước khi chế mới, TÁI DÙNG khi khớp nhu cầu): ${opts.patternNames.join(', ')}.`
      : 'Chưa có pattern nào được chế trước đó — chế mới thì ghi lại vào "patterns/<slug>.json".';

  return [
    `Áp skill "lab-screen-compose". Bạn là designer SÁNG TÁC màn hình mới (KHÔNG phải thi công theo hợp đồng cứng như figma-screen-build) — dùng Figma MCP toàn quyền trên file preview để dựng, tự xem lại, tự sửa trong phiên.`,
    `Nhiệm vụ: đọc tài liệu ở ${docsLine} để biết TỪNG màn LÀM GÌ (chức năng + nội dung THẬT). Ảnh mockup trong tài liệu chỉ để hiểu tính năng — **CẤM chép bố cục từ mockup**: bố cục là việc bạn tự sáng tác từ comp base.`,
    `Nguyên liệu: "criteria/components.md" (danh mục comp base hợp lệ — import bằng key qua use_figma, hoặc tra bằng search_design_system/get_libraries)${guideNote}${tokensNote}. "${LAB_PATTERNS_DIR_REL}/" chứa pattern đã chế trước.`,
    `Phạm vi lần này: ${scope} (tối đa 3 màn/lần chạy).`,
    `Dựng trong trang Figma tên đúng "${pageName}" (file preview key "${opts.previewFileKey}") — tạo nếu chưa có, tái dùng nếu có.`,
    patternsNote,
    `4 luật sống còn (Hợp đồng cứng — vi phạm là lỗi nghiêm trọng): (1) CHỈ thao tác trên file preview ("${opts.previewFileKey}") — TUYỆT ĐỐI không mở/sửa bất kỳ file Figma nào khác. (2) Page/frame đặt tên chuẩn ("${pageName}" / "<KEY> — <tên màn>") + idempotent replace-by-name: có frame trùng tên thì NHỚ vị trí {x,y}, XÓA rồi dựng lại đúng vị trí cũ — không bao giờ để hai frame cùng tên tồn tại song song. (3) NGUYÊN TỬ theo lần execute-code: TOÀN BỘ thao tác của một phần tử nằm trong CÙNG một lần gọi tool — TUYỆT ĐỐI cấm mang node id (đặc biệt id ruột instance dạng "I<a>;<b>") qua ranh giới call sau; cần dùng lại thì RE-QUERY bằng tên NGAY trong lần gọi đó. (4) Content THẬT lấy từ tài liệu (URD) — style (màu/chữ/radius/shadow/spacing) CHỈ được lấy từ "criteria/tokens.md", cấm giá trị ngoài danh mục.`,
    `Dùng get_screenshot để TỰ XEM LẠI frame vừa dựng (bố cục, phân cấp, spacing, on-brand) rồi tự sửa — tối đa vài vòng cho mỗi màn.`,
    `Kết thúc: ghi ĐÚNG MỘT file "${LAB_RESULT_FILE_REL}" ở cwd của bạn — {"screens":[{"key","name","frameNodeId","frameUrl?","notes?"}]}; "frameNodeId" LÀ id của chính FRAME màn (dạng node thường "12:34", KHÔNG PHẢI id ruột instance). Không ghi file nào khác ngoài "${LAB_RESULT_FILE_REL}" và "${LAB_PATTERNS_DIR_REL}/*.json".`,
  ].join(' ');
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
