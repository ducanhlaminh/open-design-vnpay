// ds-lab / lab-kit — "Nâng bộ comp": stage MỚI (2026-08-22, WP-kit, xem
// .tmp/pipeline/wp-kit.yaml) chen giữa lab-docs và lab-compose.
//
// Cùng tinh thần `lab-compose.ts` (đọc docblock file đó trước — module này
// NOI NGUYÊN khuôn): daemon chỉ đưa BRIEF (nguyên liệu + luật sống còn), agent
// là NGƯỜI SÁNG TÁC tự đọc tài liệu, tự phân tích chọn lọc, tự dùng Figma MCP
// để dựng, tự chụp màn hình xem lại. Khác lab-compose ở ĐỐI TƯỢNG: lab-compose
// sáng tác MÀN (frame), lab-kit nâng cấp COMPONENT (một node component đơn lẻ,
// sống trong page kit — không phải frame màn).
//
// WP-kit-regen (2026-08-22 — .tmp/pipeline/wp-kit-regen.yaml): Chạy lại
// KHÔNG còn "cập nhật tại chỗ giữ node id" — ngữ nghĩa mới là GEN LẠI TỪ ĐẦU:
// mỗi lần chạy, agent xoá TOÀN BỘ children của trang kit rồi dựng bộ comp
// mới, và daemon ghi lại `kit/kit.json` MỚI TOÀN BỘ (không merge với bản cũ).
// Hệ quả CHỦ ĐÍCH: instance ở màn cũ trỏ vào comp bị xoá sẽ mất mainComponent
// — quy trình chuẩn là Chạy lại bước sáng tác màn (lab-compose) ngay sau đó.
// Module này chỉ chứa phần THUẦN (không fs/network): dựng brief kickoff,
// parse kit-result.json agent ghi ra, và đường dẫn output. server.ts (nhánh
// daemon-orchestrated `runLabKit`) sở hữu mọi fs/DB/agent-spawn thật — xem
// docblock `runLabKit` ở đó.

/** Thư mục chứa PNG capture của từng comp phái sinh — một trong các output
 *  khai báo của `lab-kit` trong pipelines.ts (`outputs: ['kit-shots/',
 *  'kit-result.json', 'kit/kit.json']`). */
export const KIT_SHOTS_DIR_REL = 'kit-shots';

/** File kết quả agent PHẢI ghi trước khi kết thúc phiên (một dòng cho MỖI
 *  component agent vừa nâng cấp/cập nhật trong page kit). */
export const KIT_RESULT_FILE_REL = 'kit-result.json';

/** Registry của kit — agent ghi MỚI TOÀN BỘ ở mỗi lần chạy (WP-kit-regen,
 *  .tmp/pipeline/wp-kit-regen.yaml): KHÔNG còn merge với bản cũ. Từ WP này
 *  là output khai báo BÌNH THƯỜNG của `lab-kit` trong pipelines.ts — cơ chế
 *  re-run clear sẵn có dọn file này trước mỗi lần chạy, hết vòng đời "bền".
 *  Nằm dưới thư mục con `kit/` (khác `kit-shots/`, thư mục PNG) để không lẫn
 *  với các output khác. */
export const KIT_REGISTRY_FILE_REL = 'kit/kit.json';

/** Tên trang Figma cho kit — TÁCH khỏi cả `[OD Lab] …` (lab-compose, dựng
 *  màn) lẫn `[OD] …` (docs-review) để ba loại nội dung không giẫm frame/node
 *  nhau dù cùng dùng chung một file preview. */
export function labKitPageName(appFeature: string): string {
  return `[OD Lab Kit] ${appFeature}`;
}

/** Một component phái sinh đã qua validate trong `kit-result.json`. */
export interface KitResultComponent {
  key: string;
  name: string;
  /** Node id của CHÍNH component phái sinh — dạng Figma thường ("12:34"),
   *  KHÔNG BAO GIỜ là id ruột instance ("I12:34;56:78" — stale ngay khi agent
   *  set thuộc tính trên nó, cùng lý do `frameNodeId` của lab-compose.ts). */
  componentNodeId: string;
  /** Vì sao comp này được chọn nâng cấp (điểm neo thị giác nào) — ghi lại để
   *  designer đọc lại khi cân nhắc promote vào DS thật. */
  reason?: string;
  /** Tên (hoặc key) các comp base đã ghép để tạo ra bản phái sinh này. */
  baseComponents?: string[];
  notes?: string;
}

export interface ParsedKitResult {
  components: KitResultComponent[];
  /** Một dòng cho mỗi entry bị bỏ (thiếu field / id ruột instance…) — server.ts
   *  gộp vào log/warnings của stage, KHÔNG làm cả file bị coi là hỏng. */
  warnings: string[];
}

// Id node Figma "thường": <số>:<số> — xem giải thích đầy đủ ở FRAME_NODE_ID_RE
// trong lab-compose.ts (id ruột instance "I<a>;<b>" không khớp regex này).
const KIT_NODE_ID_RE = /^\d+:\d+$/;

/** Parse `kit-result.json` do agent ghi. `null` khi JSON hỏng hoặc thiếu field
 *  `components` (mảng) — server.ts coi đây là "agent không ghi kết quả hợp
 *  lệ" và fail cả stage. Validate NGUYÊN khuôn `parseLabResult`
 *  (lab-compose.ts): `key` bắt buộc (thiếu → warning + bỏ), `componentNodeId`
 *  bắt buộc + PHẢI khớp `KIT_NODE_ID_RE` (loại id ruột instance kèm warning),
 *  `name` thiếu/rỗng → fallback về `key` (không fail cả entry, giữ đúng hành
 *  vi khoan dung của `parseLabResult`). Một mảng `components` hợp lệ (kể cả
 *  rỗng sau khi lọc) KHÔNG trả `null` — "rỗng có phải fail không" là quyết
 *  định của caller (server.ts). */
export function parseKitResult(raw: string): ParsedKitResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawComponents = (parsed as { components?: unknown }).components;
  if (!Array.isArray(rawComponents)) return null;

  const components: KitResultComponent[] = [];
  const warnings: string[] = [];
  for (const entry of rawComponents) {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (!key) {
      warnings.push('Bỏ qua một mục trong kit-result.json: thiếu "key".');
      continue;
    }
    const componentNodeId = typeof e.componentNodeId === 'string' ? e.componentNodeId.trim() : '';
    if (!componentNodeId) {
      warnings.push(`Comp "${key}": thiếu "componentNodeId" — bỏ qua.`);
      continue;
    }
    if (!KIT_NODE_ID_RE.test(componentNodeId)) {
      warnings.push(
        `Comp "${key}": componentNodeId "${componentNodeId}" không phải id node thường (dạng "12:34") — có thể là id ruột instance ("I<a>;<b>") đã stale — bỏ qua.`,
      );
      continue;
    }
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : key;
    const component: KitResultComponent = { key, name, componentNodeId };
    if (typeof e.reason === 'string' && e.reason.trim()) component.reason = e.reason.trim();
    if (Array.isArray(e.baseComponents) && e.baseComponents.every((b) => typeof b === 'string')) {
      component.baseComponents = (e.baseComponents as string[]).map((b) => b.trim()).filter(Boolean);
    }
    if (typeof e.notes === 'string' && e.notes.trim()) component.notes = e.notes.trim();
    components.push(component);
  }
  return { components, warnings };
}

/** Đường dẫn (project-cwd-relative, tính từ `<labCwd>`) daemon ghi PNG capture
 *  của một comp phái sinh vào — sanitize NGUYÊN khuôn `screenPngRel`
 *  (lab-compose.ts): cùng bộ ký tự hợp lệ `[A-Za-z0-9._-]` để không bao giờ
 *  thoát ra ngoài `kit-shots/`. */
export function kitShotPngRel(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${KIT_SHOTS_DIR_REL}/${safe}.png`;
}

export interface BuildKitBriefOptions {
  /** Tên file tài liệu (tương đối từ cwd của agent, dưới `docs/`) đáng chú ý
   *  nhất để nêu trong brief — agent tự duyệt cả thư mục `docs/` để biết các
   *  màn SẮP DỰNG cần điểm neo thị giác nào. Rỗng → brief chỉ trỏ vào "docs/". */
  docsIndex: readonly string[];
  scopeHint?: string | null;
  previewFileKey: string;
  appFeature: string;
  hasTokens: boolean;
  hasGuide: boolean;
  hasSlots: boolean;
  /** `true` khi user đã tự khai server MCP cộng đồng `pinterest-mcp-server`
   *  trong Cài đặt → MCP (xem `pickPinterestMcpServer`, figma-build.ts) —
   *  fail-soft: `false` → brief KHÔNG nhắc gì tới Pinterest, agent chạy như
   *  không có nó. */
  hasPinterest: boolean;
}

/** Message kickoff cho phiên agent duy nhất của stage `lab-kit`. Thuần —
 *  không đọc đĩa/DB; server.ts đã gom mọi input trước khi gọi. */
export function buildKitBrief(opts: BuildKitBriefOptions): string {
  const pageName = labKitPageName(opts.appFeature);
  const docsLine =
    opts.docsIndex.length > 0
      ? `"docs/" (đáng chú ý: ${opts.docsIndex.map((p) => `"${p}"`).join(', ')} — nhưng đọc cả thư mục, không chỉ các file này)`
      : '"docs/" (đọc mọi trang trong thư mục này)';
  const guideNote = opts.hasGuide ? ', "criteria/components-guide.md" (mô tả thêm cho từng component)' : '';
  const tokensNote = opts.hasTokens
    ? ', "criteria/tokens.md" (TOÀN BỘ màu bạn được phép dùng — kể cả khi phối gradient/alpha, xem luật token bên dưới)'
    : ' — LƯU Ý: "criteria/tokens.md" CHƯA có cho dự án này, không có bảng token nào để đối chiếu';
  const slotsNote = opts.hasSlots
    ? ', "criteria/slots.md" (hồ sơ SLOT từng component — cơ chế điền nội dung của comp base bạn đang nâng cấp)'
    : '';
  const pinterestNote = opts.hasPinterest
    ? ` Có tool "pinterest_*" (server cộng đồng pinterest-mcp-server) khả dụng — dùng "pinterest_search" để tham khảo moodboard thẩm mỹ (chỉ xem, không tải), "pinterest_search_and_download" khi thật sự cần một ảnh minh hoạ (xem "Recipe ảnh placeholder" trong skill); MỌI ảnh tải về là PLACEHOLDER phải ghi chú nguồn vào "notes" — không phải asset final. Ưu tiên TỰ DỰNG art bằng hình học + gradient token trước, ảnh chỉ cho chất liệu minh hoạ không dựng được bằng hình học.`
    : '';

  return [
    `Áp skill "lab-kit-compose". Bạn là SYSTEM DESIGNER nâng cấp bộ component — khác hẳn "lab-screen-compose" (sáng tác MÀN): việc của bạn ở đây là TỰ TẠO bộ component phái sinh thẩm mỹ cao hơn từ comp base + tokens của Design System, KHÔNG dựng màn hoàn chỉnh.`,
    `Nhiệm vụ: đọc ${docsLine} để biết CÁC MÀN SẮP DỰNG cần điểm neo thị giác nào. PHÂN TÍCH CHỌN LỌC: CHỈ những comp là ĐIỂM NEO THỊ GIÁC của các màn đó (card, list-item, hero-header, dock, promo…) mới đáng có bản phái sinh — ghi rõ LÝ DO cho từng comp bạn chọn nâng cấp. Đồ "ống nước" (radio, divider, input, checkbox…) GIỮ NGUYÊN comp base, KHÔNG tạo bản mới.`,
    `NGOẠI LỆ BẮT BUỘC của phân tích chọn lọc — App Bar: mọi màn mobile đều cần thanh điều hướng trên cùng (nút back + tiêu đề màn); nếu danh mục comp base KHÔNG có App Bar thì kit PHẢI tự dựng một comp "App Bar" phái sinh từ tokens (auto-layout, tuân luật resize-test bên dưới) để bước sáng tác màn có mà dùng; base có sẵn App Bar thì chỉ tạo bản phái sinh khi thật sự đáng nâng cấp như mọi comp khác.`,
    `Nguyên liệu: "criteria/components.md" (danh mục comp base)${guideNote}${tokensNote}${slotsNote}.`,
    `Nơi tạo: trang Figma tên đúng "${pageName}" trong file preview (fileKey "${opts.previewFileKey}") — TUYỆT ĐỐI KHÔNG ghi bất kỳ thứ gì vào file Design System NGUỒN; kit CHỈ tồn tại trong file preview, là ứng viên để designer PROMOTE về DS thật (việc đó là của người, không phải của bạn).`,
    `Luật token nới MỘT NẤC: mọi màu vẫn PHẢI lấy từ "criteria/tokens.md", nhưng ĐƯỢC phối gradient/alpha từ chính các màu đó (GRADIENT_LINEAR đã probe chạy tốt trên sandbox Figma) — cấm mọi màu gốc mới ngoài danh mục.`,
    pinterestNote,
    `GEN LẠI TỪ ĐẦU MỖI LẦN CHẠY: nếu trang kit đã có nội dung từ lần chạy trước thì XÓA TOÀN BỘ children của trang đó trước khi dựng — không giữ lại, không cập nhật tại chỗ, không để comp cũ và mới lẫn nhau. Hệ quả CHỦ ĐÍCH: instance ở các màn cũ trỏ vào comp bị xóa sẽ mất mainComponent — người dùng sẽ Chạy lại bước sáng tác màn ngay sau stage này.`,
    `MỌI comp phái sinh PHẢI dựng bằng AUTO-LAYOUT (fill/hug đúng chiều) và trước khi chốt PHẢI tự resize instance thử về bề rộng 358 (content width mobile) — comp có bề rộng tự nhiên cứng (ví dụ 445) sẽ bị cắt cụt mép phải khi đặt vào màn 390 (lỗi thật đã gặp: mất cả nút trong card).`,
    `Kết thúc: ghi ĐÚNG MỘT file "${KIT_RESULT_FILE_REL}" ở cwd của bạn — {"components":[{"key","name","componentNodeId","reason?","baseComponents?","notes?"}]} — và ghi "${KIT_REGISTRY_FILE_REL}" MỚI TOÀN BỘ (danh sách ĐÚNG bộ comp vừa dựng lần này — KHÔNG merge với bản cũ).`,
    `Lưu ý: toàn bộ nội dung skill "lab-kit-compose" ĐÃ nằm trong system prompt của bạn — ĐỪNG đi tìm file skill trong catalog cục bộ của CLI (không có ở đó, và không cần).`,
  ]
    .filter((s) => s.length > 0)
    .join(' ');
}
