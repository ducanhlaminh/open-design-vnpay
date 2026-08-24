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
// WP-lab-map (2026-08-23 — .tmp/pipeline/wp-lab-map.yaml): chỉ cần TÊN
// đường dẫn `screen-map.json` để nêu trong brief "Bản đồ màn" bên dưới —
// lab-map.ts là module thuần (không fs/network), import ở đây không phá bất
// biến "lab-compose.ts thuần".
import { SCREEN_MAP_FILE_REL } from './lab-map.js';
// WP-lab-shell (2026-08-23 — .tmp/pipeline/wp-lab-shell.yaml): "Khung màn" —
// SHELL_ROLES cho thứ tự liệt kê ổn định ở dòng "Comp khung" bên dưới.
import { SHELL_ROLES, type ShellRole } from './lab-shell.js';

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
  /** WP-lab-map (2026-08-23): tóm tắt `screen-map.json` (stage "Bản đồ màn",
   *  lab-map) do server.ts đã đọc + `summarizeScreenMapForCompose` trước khi
   *  gọi — `null`/`undefined` khi stage đó chưa chạy (hoặc file hỏng/rỗng),
   *  brief rơi về hành vi CŨ (tự chọn ≤3 màn đầu luồng chính, không nhắc bản
   *  đồ). Bản đồ là ƯU TIÊN khi có, KHÔNG phải điều kiện cứng — cùng tinh
   *  thần `hasKit` ở trên. */
  map?: {
    screens: { key: string; name: string; mustHaveCount: number }[];
    mainPath: string[];
    scoped: string[];
    /** WP-lab-shell: khung màn HIỆU LỰC (agent ghi thắng, derive khi bỏ
     *  trống) cho ĐÚNG các màn trong `scoped`, theo CÙNG thứ tự — xem
     *  `summarizeScreenMapForCompose` (lab-map.ts). Rỗng/absent → không in
     *  dòng "Khung <key>" nào (hành vi CŨ, trước WP này). */
    shells?: { key: string; kind: string; must: string[]; should: string[]; avoid: string[] }[];
    /** WP-lab-shell: comp DS/kit ĐÃ dò được cho từng vai trò khung
     *  (`detectShellBindings`, lab-shell.ts) — server.ts truyền TOÀN BỘ
     *  danh sách (không lọc theo scoped, vì một vai trò có thể cần cho
     *  nhiều màn khác nhau); dòng "Comp khung" tự lọc đúng role xuất hiện
     *  trong `shells` của scoped. */
    bindings?: { role: string; name: string; key?: string; from: 'kit' | 'ds' }[];
    /** WP-lab-refs-daemon (2026-08-24 — .tmp/pipeline/wp-lab-refs-daemon.yaml):
     *  reference concept ĐÃ RÁP SẴN cho các màn scoped có `reference`
     *  (server.ts's `runLabCompose` tra lại `refs/refs.json` hiện tại theo
     *  `reference.conceptId` — xem `summarizeScreenMapForCompose`'s
     *  `references`). Rỗng/absent → không dòng nào (hành vi CŨ). */
    references?: { key: string; conceptName?: string; png: string; url: string }[];
  } | null;
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
  // Style pattern (`patterns/style-*.json`) = ngôn ngữ thị giác đã được người
  // duyệt ở lần chạy trước — tách khỏi pattern ghép comp để brief nói rõ "áp
  // lại", không để agent quay về mặc định phẳng (luật #8 skill).
  const stylePatterns = opts.patternNames.filter((n) => n.startsWith('style-'));
  const layoutPatterns = opts.patternNames.filter((n) => !n.startsWith('style-'));
  const patternLine =
    layoutPatterns.length > 0
      ? `- Pattern sẵn có: ${layoutPatterns.join(', ')} (đọc trước khi chế mới).`
      : `- Pattern sẵn có: (chưa có — chế mới thì ghi lại \`${LAB_PATTERNS_DIR_REL}/<slug>.json\`).`;
  const styleLine =
    stylePatterns.length > 0
      ? `- Style pattern đã duyệt: ${stylePatterns.join(', ')} — ÁP LẠI cho mọi màn trừ khi định hướng bên dưới nói khác.`
      : `- Style pattern đã duyệt: (chưa có — xác lập theo luật #8 rồi ghi \`${LAB_PATTERNS_DIR_REL}/style-<slug>.json\`).`;
  const figmaLine = `- Figma: file preview \`${opts.previewFileKey}\`, trang "${pageName}"`;
  const toolLine = `- Tool thêm: Pinterest ${checkMark(opts.hasPinterest)}`;
  // WP-lab-map (2026-08-23): bản đồ màn (stage "Bản đồ màn", lab-map) là ƯU
  // TIÊN khi có — key ổn định + checklist mustHave thay cho việc agent tự bịa
  // kho màn từ docs mỗi lần chạy. Chưa chạy stage đó (map undefined/null) →
  // brief nói rõ CHƯA CÓ, agent quay về hành vi cũ (tự chọn ≤3 màn đầu).
  const map = opts.map ?? null;
  const mapLine = map
    ? `- Bản đồ màn: \`${SCREEN_MAP_FILE_REL}\` — ${map.screens.length} màn; luồng chính: ${map.mainPath.length > 0 ? map.mainPath.join(' → ') : '(không có)'}; lần này dựng: ${map.scoped.length > 0 ? map.scoped.join(', ') : '(không có)'} (mustHave = checklist phải có mặt, không phải bố cục).`
    : '- Bản đồ màn: (chưa có — chạy bước Bản đồ màn để có key ổn định; tạm tự suy từ docs).';
  // WP-lab-shell (2026-08-23): một dòng "Khung <key>" cho MỖI màn scoped
  // (bỏ cụm rỗng) + một dòng "Comp khung" gộp các vai trò must/should xuất
  // hiện trong các màn đó — không có `shells` (map chưa chạy, hoặc chưa qua
  // WP này) → không dòng nào (giữ nguyên hành vi CŨ).
  const shells = map?.shells ?? [];
  const shellLines = shells.map((s) => {
    const clusters = [
      s.kind,
      s.must.length > 0 ? `phải: ${s.must.join(', ')}` : '',
      s.should.length > 0 ? `nên: ${s.should.join(', ')}` : '',
      s.avoid.length > 0 ? `tránh: ${s.avoid.join(', ')}` : '',
    ].filter(Boolean);
    return `- Khung ${s.key}: ${clusters.join(' · ')}`;
  });
  const shellRolesNeeded = new Set<ShellRole>();
  for (const s of shells) {
    for (const r of s.must) shellRolesNeeded.add(r as ShellRole);
    for (const r of s.should) shellRolesNeeded.add(r as ShellRole);
  }
  const bindings = map?.bindings ?? [];
  const compKhungLine =
    shellRolesNeeded.size > 0
      ? `- Comp khung: ${SHELL_ROLES.filter((r) => shellRolesNeeded.has(r))
          .map((role) => {
            const binding = bindings.find((b) => b.role === role);
            if (!binding) return `${role} → (DS/kit chưa có — tự dựng tối giản, ghi notes)`;
            const source = binding.from === 'kit' ? 'kit' : `key ${binding.key ?? '—'}`;
            return `${role} → "${binding.name}" (${source})`;
          })
          .join(' · ')}`
      : null;
  // Một ô nhập duy nhất của stage (pipelines.ts inputPlaceholder) gánh CẢ phạm
  // vi màn lẫn định hướng thị giác — agent tự tách; không thêm field mới.
  const scopeLine =
    opts.scopeHint && opts.scopeHint.trim()
      ? `- Phạm vi / định hướng thị giác: "${opts.scopeHint.trim()}" (≤3 màn/lần chạy).`
      : map
        ? `- Phạm vi / định hướng thị giác: (không có) — theo bản đồ: ${map.scoped.join(', ')}; style theo style pattern, không có thì luật #8.`
        : '- Phạm vi / định hướng thị giác: (không có) — tự chọn ≤3 màn đầu luồng chính; style theo style pattern, không có thì luật #8.';
  const buildLine = map
    ? '- Dựng các màn đã chọn theo bản đồ, frame tên `<key> — <tên>` (kit ưu tiên, base fallback) — không chép bố cục từ mockup.'
    : '- Dựng tối đa 3 màn từ instance (kit ưu tiên, base fallback) — không chép bố cục từ mockup.';
  const structureRuleLine = map
    ? '- Frame tên theo key bản đồ, mọi mustHave có mặt; khung đúng shell (phải có/tránh), một điểm nhấn, ba lớp (luật #2/#6/#7/#8).'
    : '- Khung màn chuẩn 390, App Bar/Tabbar, một điểm nhấn; ba lớp nhìn thấy được, listing nổi khỏi sheet, nền không che chữ (luật #6/#7/#8).';
  // WP-lab-refs-daemon (2026-08-24): một dòng "Reference <key>" cho MỖI màn
  // scoped có reference (server.ts đã ráp sẵn conceptName/png/url) — rỗng/
  // absent → không dòng nào (hành vi CŨ). renderLabBrief CHỈ giữ 3 dòng đầu
  // của `reminderLines` (`.slice(0, 3)`, lab-brief.ts — module dùng chung,
  // ngoài `touches` của WP này) nên dòng nhắc reference được ĐẶT ĐẦU để chắc
  // chắn không bị cắt — cái giá là `structureRuleLine` (dòng #4 khi có
  // reference) rơi khỏi 3 dòng hiển thị; luật đó vẫn còn trong system prompt
  // của skill, brief chỉ là nhắc lại, không phải nguồn duy nhất.
  const references = map?.references ?? [];
  const referenceLines = references.map(
    (r) => `- Reference ${r.key}: ảnh \`${r.png}\` + ${r.url} — SÁT CẤU TRÚC (xem luật reference trong skill)`,
  );
  const referenceReminderLine =
    '- Màn có reference: bố cục THEO reference (cấu trúc khối, thứ tự, tỷ lệ) — comp từ DS/kit, style theo tokens, nội dung thật từ docs; màn không reference: sáng tác như cũ.';

  return renderLabBrief({
    title: `# Sáng tác màn · ${opts.appFeature}`,
    skillId: 'lab-screen-compose',
    inputLines: [
      docsLine,
      materialsLine,
      kitLine,
      patternLine,
      styleLine,
      mapLine,
      ...shellLines,
      ...(compKhungLine ? [compKhungLine] : []),
      ...referenceLines,
      figmaLine,
      toolLine,
      scopeLine,
    ],
    taskLines: [
      '- Đọc docs để biết từng màn cần làm gì (chức năng + nội dung thật).',
      buildLine,
      '- Điền nội dung thật đúng vào slot của component.',
      '- Tự-kiểm cấu trúc + get_screenshot rồi ghi kết quả.',
    ],
    reminderLines: [
      ...(references.length > 0 ? [referenceReminderLine] : []),
      '- Chỉ file preview, nguyên tử theo lần execute-code — id ruột instance stale ngay khi call kết thúc (luật #1/#3).',
      '- Nội dung trong slot, không vẽ đè, placeholder phải override/hide (luật #5).',
      structureRuleLine,
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
