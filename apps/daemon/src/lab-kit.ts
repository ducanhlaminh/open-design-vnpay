// ds-lab / lab-kit — "Nâng bộ comp": stage MỚI (2026-08-22, WP-kit, xem
// .tmp/pipeline/wp-kit.yaml) chen giữa lab-docs và lab-compose.
//
// Cùng tinh thần `lab-compose.ts` (đọc docblock file đó trước — module này
// NOI NGUYÊN khuôn): daemon chỉ đưa BRIEF (nguyên liệu + luật sống còn), agent
// là NGƯỜI SÁNG TÁC tự đọc tài liệu, tự dùng Figma MCP để dựng, tự chụp màn
// hình xem lại. Khác lab-compose ở ĐỐI TƯỢNG: lab-compose sáng tác MÀN
// (frame), lab-kit nâng cấp COMPONENT (một node component đơn lẻ, sống trong
// page kit — không phải frame màn).
//
// WP-kit-regen (2026-08-22 — .tmp/pipeline/wp-kit-regen.yaml): Chạy lại
// KHÔNG còn "cập nhật tại chỗ giữ node id" — ngữ nghĩa mới là GEN LẠI TỪ ĐẦU:
// mỗi lần chạy, agent xoá TOÀN BỘ children của trang kit rồi dựng bộ comp
// mới, và daemon ghi lại `kit/kit.json` MỚI TOÀN BỘ (không merge với bản cũ).
// Hệ quả CHỦ ĐÍCH: instance ở màn cũ trỏ vào comp bị xoá sẽ mất mainComponent
// — quy trình chuẩn là Chạy lại bước sáng tác màn (lab-compose) ngay sau đó.
//
// WP-kit-plan (2026-08-22 — .tmp/pipeline/wp-kit-plan.yaml): thêm stage CỔNG
// DUYỆT "Đề xuất kit" (lab-kit-plan) đứng TRƯỚC lab-kit trong cùng workflow.
// lab-kit-plan là một phiên CHỈ ĐỌC (docs + criteria, KHÔNG tool Figma) áp
// PHÉP THỬ HAI TẦNG (mặc định KHÔNG sinh — chỉ derive khi override trên base
// không lấp được một khoảng cách CẤU TRÚC, và gap phải nêu đích danh) rồi ghi
// `kit-plan.json` (máy đọc) + `kit-plan.md` (người duyệt). lab-kit từ WP này
// KHÔNG còn tự phân tích chọn lọc — nó DỰNG ĐÚNG danh sách `decision:
// "derive"` mà NGƯỜI đã duyệt trong kit-plan.json (server.ts's runLabKit đọc
// fail-fast trước khi build brief — thiếu/hỏng/rỗng thì fail cả stage với
// thông điệp trỏ về bước "Đề xuất kit").
//
// Module này chỉ chứa phần THUẦN (không fs/network): dựng brief kickoff,
// parse kit-result.json/kit-plan.json agent ghi ra, và đường dẫn output.
// server.ts (nhánh daemon-orchestrated `runLabKit`/`runLabKitPlan`) sở hữu
// mọi fs/DB/agent-spawn thật — xem docblock các hàm đó ở đó.
//
// WP-lab-clean (2026-08-23 — .tmp/pipeline/wp-lab-clean.yaml): brief kickoff
// viết lại theo khuôn "skill = luật, brief = dữ liệu lần chạy" — dùng chung
// `renderLabBrief`/`checkMark` (lab-brief.ts, cũng THUẦN) với buildComposeBrief.

import { checkMark, renderLabBrief } from './lab-brief.js';

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

/** File đề xuất (máy đọc) do stage "Đề xuất kit" (lab-kit-plan, WP-kit-plan
 *  — .tmp/pipeline/wp-kit-plan.yaml) ghi ra — cổng duyệt của NGƯỜI. `lab-kit`
 *  đọc file này để biết ĐÚNG danh sách `decision: "derive"` cần dựng; thiếu/
 *  hỏng/rỗng → stage `lab-kit` fail-fast (xem `runLabKit` trong server.ts). */
export const KIT_PLAN_FILE_REL = 'kit-plan.json';

/** File đề xuất (người đọc) — bảng markdown "comp | quyết định | base thiếu
 *  gì | lý do" để NGƯỜI duyệt trước khi bấm chạy "Nâng bộ comp". Không phải
 *  hợp đồng máy đọc — thiếu file này KHÔNG làm stage lab-kit-plan fail
 *  (server.ts tự render một bản tối giản qua `renderKitPlanMd`). */
export const KIT_PLAN_MD_REL = 'kit-plan.md';

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

// ── lab-kit-plan (WP-kit-plan, .tmp/pipeline/wp-kit-plan.yaml) ─────────────
// Cổng duyệt của NGƯỜI trước "Nâng bộ comp": stage lab-kit-plan CHỈ ĐỌC
// (docs + criteria), không có tool Figma, và quyết định cho từng comp ứng
// viên theo PHÉP THỬ HAI TẦNG — mặc định KHÔNG sinh, nghĩa vụ chứng minh
// thuộc về phía sinh:
//   (1) Có phải điểm neo thị giác không? Không → dùng base, dừng lại.
//   (2) Hiệu quả màn cần có ĐẠT ĐƯỢC chỉ bằng override trên instance base
//       (đổi text, đổi màu token, ẩn/hiện phần tử, swap icon) không? ĐẠT →
//       dùng thẳng base (use-base), CẤM sinh. CHỈ derive khi cần thay đổi
//       CẤU TRÚC mà override không làm nổi (ghép nhiều base thành khối mới,
//       thêm lớp trang trí gradient/art/price-tag, bố cục khác hẳn mọi biến
//       thể sẵn có) — và `gap` PHẢI nêu ĐÍCH DANH base thiếu gì (cấm lý do
//       chung chung "cho đẹp hơn").

/** Một mục đề xuất trong `kit-plan.json` — đã qua validate của `parseKitPlan`. */
export interface KitPlanCandidate {
  key: string;
  name: string;
  /** 'derive' = cần dựng bản phái sinh (đã qua phép thử hai tầng, có `gap`
   *  đích danh); 'use-base' = dùng thẳng comp base, KHÔNG dựng gì thêm. */
  decision: 'derive' | 'use-base';
  /** Tên/key các comp base sẽ ghép (chỉ có ý nghĩa khi decision='derive'). */
  baseComponents?: string[];
  /** BẮT BUỘC khi decision='derive' — khoảng cách CẤU TRÚC cụ thể mà override
   *  trên base không lấp được (hợp đồng cứng của phép thử hai tầng; entry
   *  'derive' thiếu gap bị `parseKitPlan` drop kèm warning). */
  gap?: string;
  reason?: string;
  /** `true` = ngoại lệ App Bar bắt buộc (hoặc tương đương) — lab-kit PHẢI
   *  dựng mục này dù người dùng có bớt các mục khác. */
  mustHave?: boolean;
}

export interface ParsedKitPlan {
  candidates: KitPlanCandidate[];
  /** Một dòng cho mỗi entry bị bỏ (thiếu field / decision lạ / derive thiếu
   *  gap…) — server.ts gộp vào log/warnings của stage, KHÔNG làm cả file bị
   *  coi là hỏng. */
  warnings: string[];
}

/** Parse `kit-plan.json` do agent lab-kit-plan ghi. `null` khi JSON hỏng
 *  hoặc thiếu field `candidates` (mảng) — server.ts (runLabKitPlan) coi đây
 *  là "agent không ghi đề xuất hợp lệ" và fail cả stage. Một entry bị DROP
 *  (kèm warning, không fail cả file) khi: thiếu `key`/`name`; `decision`
 *  không thuộc {'derive','use-base'}; hoặc `decision==='derive'` mà THIẾU
 *  `gap` (chuỗi rỗng/absent) — `gap` là hợp đồng CỨNG của phép thử hai tầng,
 *  một mục derive không nêu đích danh base thiếu gì không được coi là hợp
 *  lệ. `candidates` rỗng sau khi lọc vẫn trả object (KHÔNG null) — "rỗng có
 *  phải fail không" là quyết định của caller. */
export function parseKitPlan(raw: string): ParsedKitPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawCandidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(rawCandidates)) return null;

  const candidates: KitPlanCandidate[] = [];
  const warnings: string[] = [];
  for (const entry of rawCandidates) {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    if (!key) {
      warnings.push('Bỏ qua một mục trong kit-plan.json: thiếu "key".');
      continue;
    }
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) {
      warnings.push(`Mục "${key}": thiếu "name" — bỏ qua.`);
      continue;
    }
    const rawDecision = e.decision;
    if (rawDecision !== 'derive' && rawDecision !== 'use-base') {
      warnings.push(`Mục "${key}": "decision" không hợp lệ (phải là "derive" hoặc "use-base") — bỏ qua.`);
      continue;
    }
    const gap = typeof e.gap === 'string' ? e.gap.trim() : '';
    if (rawDecision === 'derive' && !gap) {
      warnings.push(
        `Mục "${key}": decision "derive" nhưng thiếu "gap" (khoảng cách cấu trúc đích danh — hợp đồng cứng của phép thử hai tầng) — bỏ qua.`,
      );
      continue;
    }
    const candidate: KitPlanCandidate = { key, name, decision: rawDecision };
    if (gap) candidate.gap = gap;
    if (Array.isArray(e.baseComponents) && e.baseComponents.every((b) => typeof b === 'string')) {
      candidate.baseComponents = (e.baseComponents as string[]).map((b) => b.trim()).filter(Boolean);
    }
    if (typeof e.reason === 'string' && e.reason.trim()) candidate.reason = e.reason.trim();
    if (e.mustHave === true) candidate.mustHave = true;
    candidates.push(candidate);
  }
  return { candidates, warnings };
}

/** Render bảng markdown tối giản khi agent lab-kit-plan không tự ghi
 *  `kit-plan.md` — server.ts (runLabKitPlan) gọi hàm này làm fallback, đừng
 *  để cả stage fail chỉ vì thiếu file trình bày (`kit-plan.json` là hợp đồng
 *  máy đọc, đã đủ để `lab-kit` dùng). */
export function renderKitPlanMd(candidates: readonly KitPlanCandidate[]): string {
  const header = '| Comp | Quyết định | Base thiếu gì | Lý do |\n| --- | --- | --- | --- |';
  const rows = candidates.map((c) => {
    const decision = c.decision === 'derive' ? `derive${c.mustHave ? ' (bắt buộc)' : ''}` : 'use-base';
    const gap = c.gap ?? '';
    const reason = c.reason ?? '';
    return `| ${c.name} | ${decision} | ${gap} | ${reason} |`;
  });
  return ['# Đề xuất kit', '', header, ...rows, ''].join('\n');
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
  /** WP-kit-plan (.tmp/pipeline/wp-kit-plan.yaml): danh sách các mục
   *  `decision === 'derive'` ĐÃ ĐƯỢC NGƯỜI DUYỆT ở `kit-plan.json` (bước "Đề
   *  xuất kit") — caller (server.ts's runLabKit) đã lọc trước khi truyền vào
   *  đây. Đây là NGUỒN DUY NHẤT quyết định lab-kit dựng comp nào; lab-kit
   *  không còn tự phân tích chọn lọc. */
  plan: readonly KitPlanCandidate[];
}

export interface BuildKitPlanBriefOptions {
  /** Tên file tài liệu (tương đối từ cwd của agent, dưới `docs/`) đáng chú ý
   *  nhất để nêu trong brief — agent tự duyệt cả thư mục `docs/` để biết các
   *  màn SẮP DỰNG cần gì. Rỗng → brief chỉ trỏ vào "docs/". */
  docsIndex: readonly string[];
  scopeHint?: string | null;
  appFeature: string;
  hasTokens: boolean;
  hasGuide: boolean;
  hasSlots: boolean;
}

/** Message kickoff cho phiên agent duy nhất của stage `lab-kit`. Thuần —
 *  không đọc đĩa/DB; server.ts đã gom mọi input (kể cả `plan`, danh sách
 *  `decision:'derive'` đã duyệt ở `kit-plan.json`) trước khi gọi. WP-kit-plan
 *  (.tmp/pipeline/wp-kit-plan.yaml): brief KHÔNG còn tự phân tích chọn lọc
 *  (quyết định đó đã chốt ở stage `lab-kit-plan`) — nhiệm vụ ở đây là DỰNG
 *  ĐÚNG danh sách plan. WP-lab-clean (.tmp/pipeline/wp-lab-clean.yaml): brief
 *  chỉ đưa DỮ LIỆU của lần chạy này (skill đã có sẵn luật/recipe trong system
 *  prompt) — dùng khuôn chung `renderLabBrief` (lab-brief.ts). */
export function buildKitBrief(opts: BuildKitBriefOptions): string {
  const pageName = labKitPageName(opts.appFeature);
  const docsLine =
    opts.docsIndex.length > 0
      ? `- Tài liệu: \`docs/\` (đáng chú ý: ${opts.docsIndex.map((p) => `"${p}"`).join(', ')}; đọc cả thư mục)`
      : '- Tài liệu: `docs/` (đọc cả thư mục)';
  const materialsLine = `- Nguyên liệu: \`criteria/components.md\` (có dòng Key để import) · components-guide ${checkMark(opts.hasGuide)} · tokens.md ${checkMark(opts.hasTokens)} · slots.md ${checkMark(opts.hasSlots)} (grep đúng mục)`;
  const planLines: string[] =
    opts.plan.length > 0
      ? [
          '- Danh sách đã duyệt (`kit-plan.json`):',
          ...opts.plan.map((c) => `  - "${c.name}" — ${c.gap ?? '(không nêu)'}${c.mustHave ? ' [bắt buộc]' : ''}`),
        ]
      : ['- Danh sách đã duyệt (`kit-plan.json`): (rỗng — không có mục nào để dựng)'];
  const figmaLine = `- Figma: file preview \`${opts.previewFileKey}\`, trang "${pageName}"`;
  const toolLine = `- Tool thêm: Pinterest ${checkMark(opts.hasPinterest)}`;
  const aestheticLine =
    opts.scopeHint && opts.scopeHint.trim()
      ? `- Định hướng thẩm mỹ: "${opts.scopeHint.trim()}"`
      : '- Định hướng thẩm mỹ: (chưa có — tự rút 3 nguyên tắc từ moodboard Pinterest nếu có, hoặc từ DS màu chủ đạo/radius/elevation, ghi vào notes).';

  return renderLabBrief({
    title: `# Nâng bộ comp · ${opts.appFeature}`,
    skillId: 'lab-kit-compose',
    inputLines: [docsLine, materialsLine, ...planLines, figmaLine, toolLine, aestheticLine],
    taskLines: [
      '- Import từng base bằng Key qua use_figma.',
      '- Ghép thành comp phái sinh lấp đúng gap đã duyệt trong kit-plan.json.',
      '- Bind biến DS cho màu/chữ, resize-test 358.',
      '- Tự chấm checklist thẩm mỹ qua get_screenshot rồi ghi kết quả.',
    ],
    reminderLines: [
      '- Mỗi comp phải chứa ≥1 instance base import bằng key — cấm vẽ lại bằng frame/text (luật #9).',
      '- Màu/chữ bind biến DS qua figma.variables, cấm hex trần (luật #10).',
      '- Chỉ file preview, gen lại từ đầu, kit/kit.json ghi mới toàn bộ, không merge (luật #1/#7).',
    ],
    endingLines: [
      `- \`${KIT_RESULT_FILE_REL}\` — \`{"components":[{"key","name","componentNodeId","reason?","baseComponents?","notes?"}]}\``,
      `- \`${KIT_REGISTRY_FILE_REL}\` — ghi mới toàn bộ, không merge với bản cũ`,
    ],
  });
}

/** Message kickoff cho phiên agent duy nhất của stage `lab-kit-plan`. Thuần —
 *  không đọc đĩa/DB; server.ts (runLabKitPlan) đã gom mọi input trước khi
 *  gọi. Phiên này KHÔNG có tool Figma (KHÔNG MCP nào được gắn — Symbol
 *  INTERNAL_MCP_SERVER_IDS rỗng) — brief PHẢI nói rõ điều đó để agent không
 *  đi tìm/đợi tool Figma. WP-lab-clean (.tmp/pipeline/wp-lab-clean.yaml):
 *  brief chỉ đưa DỮ LIỆU của lần chạy này (phép thử hai tầng đã ở skill) —
 *  dùng khuôn chung `renderLabBrief` (lab-brief.ts). */
export function buildKitPlanBrief(opts: BuildKitPlanBriefOptions): string {
  const docsLine =
    opts.docsIndex.length > 0
      ? `- Tài liệu: \`docs/\` (đáng chú ý: ${opts.docsIndex.map((p) => `"${p}"`).join(', ')}; đọc cả thư mục)`
      : '- Tài liệu: `docs/` (đọc cả thư mục)';
  const materialsLine = `- Nguyên liệu: \`criteria/components.md\` (có dòng Key để import) · components-guide ${checkMark(opts.hasGuide)} · tokens.md ${checkMark(opts.hasTokens)} · slots.md ${checkMark(opts.hasSlots)} (grep đúng mục)`;
  const scopeLine =
    opts.scopeHint && opts.scopeHint.trim()
      ? `- Định hướng người dùng: "${opts.scopeHint.trim()}"`
      : '- Định hướng người dùng: (không có)';

  return renderLabBrief({
    title: `# Đề xuất kit · ${opts.appFeature}`,
    skillId: 'lab-kit-plan',
    inputLines: [
      docsLine,
      materialsLine,
      '- Figma: không có trong phiên này — chủ đích, đây là cổng duyệt chỉ đọc.',
      scopeLine,
    ],
    taskLines: [
      '- Đọc docs + criteria để biết từng màn sắp dựng cần gì.',
      '- Áp phép thử hai tầng cho từng comp ứng viên, quyết định use-base hay derive.',
      '- Ghi kit-plan.json + kit-plan.md cho người duyệt.',
    ],
    reminderLines: [
      '- Mặc định không sinh — derive phải nêu gap đích danh (phép thử hai tầng, skill).',
      '- App Bar bắt buộc khi criteria/components.md chưa có — đánh dấu mustHave: true.',
      '- Phiên này không có tool Figma nào — đừng chờ nó xuất hiện.',
    ],
    endingLines: [
      `- \`${KIT_PLAN_FILE_REL}\` — \`{"candidates":[{"key","name","decision","baseComponents?","gap?","reason?","mustHave?"}]}\``,
      `- \`${KIT_PLAN_MD_REL}\` — bảng cho người duyệt`,
    ],
  });
}
