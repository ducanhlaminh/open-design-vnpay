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
  /** WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): bằng chứng trên màn
   *  agent đã dùng để đóng gói component này (echo lại từ kit-plan.json's
   *  `sourceNodes`, hoặc agent tự bổ sung) — đọc fail-soft, KHÔNG được validate
   *  chặt như `componentNodeId` (thiếu/hỏng không làm bỏ cả entry). */
  sourceNodes?: { screenKey: string; nodeId: string }[];
  /** Các occurrence trên màn ĐÃ ĐƯỢC swap ngược sang instance comp mới —
   *  agent tự ghi lại sau bước SWAP (xem buildKitBrief's taskLines). Đọc
   *  fail-soft, thuần thông tin (không phải hợp đồng cứng như
   *  `componentNodeId`). */
  swapped?: { screenKey: string; nodeId: string }[];
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
    // WP-lab-reorder: sourceNodes/swapped — đọc fail-soft (không validate
    // chặt như componentNodeId; phần tử hỏng bị lọc lặng lẽ, KHÔNG cảnh báo,
    // KHÔNG làm bỏ cả entry — đây là thông tin thêm, không phải hợp đồng cứng).
    const readNodeRefs = (value: unknown): { screenKey: string; nodeId: string }[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const refs = value
        .map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}))
        .filter((v) => typeof v.screenKey === 'string' && v.screenKey.trim() && typeof v.nodeId === 'string' && v.nodeId.trim())
        .map((v) => ({ screenKey: (v.screenKey as string).trim(), nodeId: (v.nodeId as string).trim() }));
      return refs.length > 0 ? refs : undefined;
    };
    const sourceNodes = readNodeRefs(e.sourceNodes);
    if (sourceNodes) component.sourceNodes = sourceNodes;
    const swapped = readNodeRefs(e.swapped);
    if (swapped) component.swapped = swapped;
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
  /** WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): bằng chứng trên MÀN
   *  ĐÃ DỰNG mà mục derive này bắt nguồn từ đó — hoặc lấy từ `occurrences`
   *  của một ứng viên trong `kit-candidates.json` (daemon tự quét), hoặc do
   *  agent tự chỉ đích danh nodeId trên màn. `decision==='derive'` mà mảng
   *  này rỗng/absent VÀ không `mustHave` → `parseKitPlan` DROP kèm warning
   *  (hợp đồng cứng mới: derive phải trỏ bằng chứng thật, không còn đoán từ
   *  docs — chỉ vai trò khung `mustHave` mới được miễn). */
  sourceNodes?: { screenKey: string; nodeId: string }[];
  /** `true` = sau khi đóng gói xong, SWAP ngược từng occurrence trong
   *  `sourceNodes` (và node cùng chữ ký trong màn nếu thấy) bằng instance
   *  comp mới — mặc định `true` khi `decision==='derive'` và có
   *  `sourceNodes` (xem `parseKitPlan`); `false` = giữ nguyên màn, chỉ đóng
   *  gói comp (ví dụ khi người duyệt muốn tự swap tay). */
  swapBack?: boolean;
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
 *  không thuộc {'derive','use-base'}; `decision==='derive'` mà THIẾU `gap`
 *  (chuỗi rỗng/absent) — `gap` là hợp đồng CỨNG của phép thử hai tầng; hoặc
 *  (WP-lab-reorder, .tmp/pipeline/wp-lab-reorder.yaml) `decision==='derive'`
 *  mà THIẾU `sourceNodes` (mảng rỗng/absent, hoặc mọi phần tử đều thiếu
 *  `screenKey`/`nodeId` string) VÀ không `mustHave` — từ WP này derive PHẢI
 *  trỏ bằng chứng thật trên màn đã dựng, chỉ vai trò khung `mustHave` (App
 *  Bar/Tabbar DS chưa có) mới được miễn. `candidates` rỗng sau khi lọc vẫn
 *  trả object (KHÔNG null) — "rỗng có phải fail không" là quyết định của
 *  caller. */
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

    const mustHave = e.mustHave === true;

    // WP-lab-reorder: sourceNodes — validate từng phần tử có screenKey+nodeId
    // là string không rỗng; phần tử hỏng bị lọc lặng lẽ (không phải lỗi của
    // cả mục), mảng rỗng sau khi lọc coi như absent.
    let sourceNodes: { screenKey: string; nodeId: string }[] | undefined;
    if (Array.isArray(e.sourceNodes)) {
      const valid: { screenKey: string; nodeId: string }[] = [];
      for (const s of e.sourceNodes) {
        if (!s || typeof s !== 'object') continue;
        const sr = s as Record<string, unknown>;
        const screenKey = typeof sr.screenKey === 'string' ? sr.screenKey.trim() : '';
        const nodeId = typeof sr.nodeId === 'string' ? sr.nodeId.trim() : '';
        if (screenKey && nodeId) valid.push({ screenKey, nodeId });
      }
      if (valid.length > 0) sourceNodes = valid;
    }

    if (rawDecision === 'derive' && (!sourceNodes || sourceNodes.length === 0) && !mustHave) {
      warnings.push(
        `Mục "${key}": decision "derive" nhưng thiếu "sourceNodes" (bằng chứng trên màn) — chỉ vai trò khung mustHave mới được derive không nguồn — bỏ qua.`,
      );
      continue;
    }

    const candidate: KitPlanCandidate = { key, name, decision: rawDecision };
    if (gap) candidate.gap = gap;
    if (Array.isArray(e.baseComponents) && e.baseComponents.every((b) => typeof b === 'string')) {
      candidate.baseComponents = (e.baseComponents as string[]).map((b) => b.trim()).filter(Boolean);
    }
    if (typeof e.reason === 'string' && e.reason.trim()) candidate.reason = e.reason.trim();
    if (mustHave) candidate.mustHave = true;
    if (sourceNodes) candidate.sourceNodes = sourceNodes;
    if (typeof e.swapBack === 'boolean') {
      candidate.swapBack = e.swapBack;
    } else if (rawDecision === 'derive' && sourceNodes) {
      candidate.swapBack = true;
    }
    candidates.push(candidate);
  }
  return { candidates, warnings };
}

/** Render bảng markdown tối giản khi agent lab-kit-plan không tự ghi
 *  `kit-plan.md` — server.ts (runLabKitPlan) gọi hàm này làm fallback, đừng
 *  để cả stage fail chỉ vì thiếu file trình bày (`kit-plan.json` là hợp đồng
 *  máy đọc, đã đủ để `lab-kit` dùng). */
export function renderKitPlanMd(candidates: readonly KitPlanCandidate[]): string {
  const header =
    '| Comp | Quyết định | Base thiếu gì | Nguồn trên màn | Lý do |\n| --- | --- | --- | --- | --- |';
  const rows = candidates.map((c) => {
    const decision = c.decision === 'derive' ? `derive${c.mustHave ? ' (bắt buộc)' : ''}` : 'use-base';
    const gap = c.gap ?? '';
    const reason = c.reason ?? '';
    // WP-lab-reorder: "Nguồn trên màn" = số node · các màn liên quan — trống
    // khi không có sourceNodes (use-base, hoặc derive mustHave không nguồn).
    const source =
      c.sourceNodes && c.sourceNodes.length > 0
        ? `${c.sourceNodes.length} node · màn ${Array.from(new Set(c.sourceNodes.map((s) => s.screenKey))).join(', ')}`
        : '';
    return `| ${c.name} | ${decision} | ${gap} | ${source} | ${reason} |`;
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
  /** WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): màn đã dựng
   *  (`lab-result.json`, luôn có sẵn từ WP này vì "Sáng tác màn" đứng TRƯỚC
   *  "Đóng gói comp" trong thứ tự mới) — cần cho bước SWAP ngược. Absent →
   *  brief giữ Y CŨ (hành vi trước WP này, để test cũ sống). */
  screens?: { key: string; frameNodeId: string }[];
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
  /** WP-lab-shell (2026-08-23 — .tmp/pipeline/wp-lab-shell.yaml): vai trò
   *  khung (app-bar/tabbar/…) mà bản đồ màn (`screen-map.json`) yêu cầu PHẢI
   *  có ở ≥1 màn — server.ts đã đếm số màn cần mỗi role + dò `bound` (tên
   *  comp DS/kit đáp ứng, `null` khi DS/kit chưa có) qua `detectShellBindings`
   *  trước khi gọi. Rỗng/absent (chưa chạy "Bản đồ màn", hoặc không role nào
   *  must) → brief KHÔNG in dòng này (hành vi CŨ). */
  shellNeeds?: { role: string; screens: number; bound: string | null }[];
  /** WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): màn đã dựng
   *  (`lab-result.json`, "Sáng tác màn" nay đứng TRƯỚC "Đề xuất kit") — kích
   *  hoạt vai trò MỚI "quét màn đã duyệt" (brief đổi hẳn phần input/task/
   *  reminder). Absent → brief giữ Y CŨ (hành vi trước WP này, để test cũ
   *  sống). */
  screens?: { key: string; name: string }[];
  /** Ứng viên daemon TỰ QUÉT được từ subtree REST của các màn (server.ts's
   *  `runLabKitPlan` gọi `scanKitCandidates`, lab-kit-scan.ts) — tóm tắt đủ
   *  để agent trỏ `sourceNodes` mà không cần đọc lại toàn bộ
   *  `kit-candidates.json`. Rỗng/absent (kèm `candidatesUnavailableReason`)
   *  → brief nói rõ lý do không quét được, agent dựa vào PNG màn. */
  candidates?: { id: string; suggestedName: string; occurrences: number; screens: string[]; hasInstance: boolean }[];
  /** Lý do tiền-quét KHÔNG chạy được (thiếu token Figma/preview, hoặc lỗi
   *  quét) — chỉ có ý nghĩa khi `candidates` rỗng/absent; `null`/absent khi
   *  tiền-quét chạy bình thường (có thể vẫn ra 0 candidate — trường hợp đó
   *  không cần lý do). */
  candidatesUnavailableReason?: string | null;
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
  // WP-lab-reorder: khi có `screens`, mỗi mục plan in thêm "← nguồn: …" nếu
  // đã có sourceNodes (từ kit-plan.json) — agent biết NGAY node nào trên màn
  // để clone/componentize, không phải tự đi tìm lại.
  const planLines: string[] =
    opts.plan.length > 0
      ? [
          '- Danh sách đã duyệt (`kit-plan.json`):',
          ...opts.plan.map((c) => {
            const base = `  - "${c.name}" — ${c.gap ?? '(không nêu)'}${c.mustHave ? ' [bắt buộc]' : ''}`;
            if (opts.screens && c.sourceNodes && c.sourceNodes.length > 0) {
              const src = c.sourceNodes.map((s) => `${s.screenKey}:${s.nodeId}`).join(', ');
              return `${base} ← nguồn: ${src}`;
            }
            return base;
          }),
        ]
      : ['- Danh sách đã duyệt (`kit-plan.json`): (rỗng — không có mục nào để dựng)'];
  const figmaLine = `- Figma: file preview \`${opts.previewFileKey}\`, trang "${pageName}"`;
  const toolLine = `- Tool thêm: Pinterest ${checkMark(opts.hasPinterest)}`;
  const aestheticLine =
    opts.scopeHint && opts.scopeHint.trim()
      ? `- Định hướng thẩm mỹ: "${opts.scopeHint.trim()}"`
      : '- Định hướng thẩm mỹ: (chưa có — tự rút 3 nguyên tắc từ moodboard Pinterest nếu có, hoặc từ DS màu chủ đạo/radius/elevation, ghi vào notes).';

  if (opts.screens) {
    // WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): "Đóng gói comp" —
    // đóng gói phái sinh từ NODE NGUỒN trong màn (componentize-in-place) rồi
    // SWAP ngược, thay vì dựng từ base rồi để lab-compose dùng sau.
    const swapScreensLine = `- Màn để swap ngược (\`lab-result.json\`): ${opts.screens
      .map((s) => `${s.key} (frame ${s.frameNodeId})`)
      .join(', ')}`;

    return renderLabBrief({
      title: `# Đóng gói comp · ${opts.appFeature}`,
      skillId: 'lab-kit-compose',
      inputLines: [docsLine, materialsLine, ...planLines, swapScreensLine, figmaLine, toolLine, aestheticLine],
      taskLines: [
        '- Với mỗi mục: tạo COMPONENT từ bản sao node nguồn (componentize-in-place) vào trang kit, đặt tên chuẩn.',
        '- Chuẩn hoá: auto-layout, slot text, bind biến DS, resize-test 358.',
        '- SWAP: thay từng occurrence trong màn bằng instance comp mới, giữ nội dung gốc.',
        '- get_screenshot kit + màn đã swap rồi ghi kết quả.',
      ],
      reminderLines: [
        '- Mỗi comp phải chứa ≥1 instance base HIỂN THỊ (không phải tham chiếu ẩn) — cấm vẽ lại bằng frame/text (luật #9).',
        '- Màu/chữ bind biến DS qua figma.variables, cấm hex trần (luật #10).',
        '- Trước khi dọn trang kit cũ: detach instance màn đang trỏ vào comp cũ (luật #7, tránh mồ côi).',
      ],
      endingLines: [
        `- \`${KIT_RESULT_FILE_REL}\` — \`{"components":[{"key","name","componentNodeId","reason?","baseComponents?","notes?","sourceNodes?","swapped?"}]}\``,
        `- \`${KIT_REGISTRY_FILE_REL}\` — ghi mới toàn bộ, không merge với bản cũ`,
      ],
    });
  }

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
  // WP-lab-shell (2026-08-23): vai trò khung must mà bản đồ màn yêu cầu —
  // rỗng/absent (chưa chạy "Bản đồ màn", hoặc không role nào must) → KHÔNG
  // in dòng này (hành vi CŨ, brief y hệt trước WP này).
  const shellNeedsLine =
    opts.shellNeeds && opts.shellNeeds.length > 0
      ? `- Khung màn cần (bản đồ): ${opts.shellNeeds
          .map((n) => `${n.role} ×${n.screens} màn (DS: ${n.bound ? `"${n.bound}"` : 'chưa có → đề xuất derive mustHave'})`)
          .join(' · ')}`
      : null;

  if (opts.screens) {
    // WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): "Đề xuất kit" nay
    // đứng SAU "Sáng tác màn" — QUÉT MÀN ĐÃ DUYỆT thay vì đoán từ docs. Cap 6
    // màn rồi "+N" (tránh brief phình theo số màn của dự án lớn).
    const screensShown = opts.screens.slice(0, 6).map((s) => `${s.key} — ${s.name}`).join(', ');
    const screensExtra = opts.screens.length > 6 ? ` +${opts.screens.length - 6}` : '';
    const screensLine = `- Màn đã dựng (\`lab-result.json\`, PNG \`screens/\`): ${screensShown}${screensExtra}`;
    const candidatesLine =
      opts.candidates && opts.candidates.length > 0
        ? `- Ứng viên daemon quét (\`kit-candidates.json\`, crop \`kit-candidates/\`): ${opts.candidates
            .map((c) => `${c.id} "${c.suggestedName}" ×${c.occurrences} (${c.screens.join(', ')})`)
            .join(' · ')}`
        : `- Ứng viên daemon quét: (không quét được — ${opts.candidatesUnavailableReason ?? 'không rõ lý do'}; dựa vào PNG màn)`;

    return renderLabBrief({
      title: `# Đề xuất kit · ${opts.appFeature}`,
      skillId: 'lab-kit-plan',
      inputLines: [
        screensLine,
        candidatesLine,
        docsLine,
        materialsLine,
        ...(shellNeedsLine ? [shellNeedsLine] : []),
        scopeLine,
      ],
      taskLines: [
        '- Xem PNG từng màn + crop ứng viên; chỉ đề xuất cái CÓ trên màn.',
        '- Phép thử hai tầng; derive PHẢI trỏ sourceNodes + gap đích danh.',
        '- Ghi kit-plan.json + kit-plan.md.',
      ],
      reminderLines: [
        '- Mặc định không sinh — derive phải nêu gap đích danh (phép thử hai tầng, skill).',
        '- Không có nguồn trên màn thì không derive (trừ vai trò khung mustHave).',
        '- Phiên này không có tool Figma nào — đừng chờ nó xuất hiện.',
      ],
      endingLines: [
        `- \`${KIT_PLAN_FILE_REL}\` — \`{"candidates":[{"key","name","decision","baseComponents?","gap?","reason?","mustHave?","sourceNodes?","swapBack?"}]}\``,
        `- \`${KIT_PLAN_MD_REL}\` — bảng cho người duyệt`,
      ],
    });
  }

  return renderLabBrief({
    title: `# Đề xuất kit · ${opts.appFeature}`,
    skillId: 'lab-kit-plan',
    inputLines: [
      docsLine,
      materialsLine,
      ...(shellNeedsLine ? [shellNeedsLine] : []),
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
      '- Vai trò khung must mà DS chưa có (App Bar, Tabbar…) → derive + mustHave: true.',
      '- Phiên này không có tool Figma nào — đừng chờ nó xuất hiện.',
    ],
    endingLines: [
      `- \`${KIT_PLAN_FILE_REL}\` — \`{"candidates":[{"key","name","decision","baseComponents?","gap?","reason?","mustHave?"}]}\``,
      `- \`${KIT_PLAN_MD_REL}\` — bảng cho người duyệt`,
    ],
  });
}
