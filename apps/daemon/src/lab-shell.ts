// ds-lab / lab-shell — "Khung màn" (shell): WP mới (2026-08-23, xem
// .tmp/pipeline/wp-lab-shell.yaml) thêm cho MỖI màn trong bản đồ (lab-map)
// một LOẠI khung (root/child/sheet/modal/result/fullscreen) + vai trò khung
// PHẢI dùng / NÊN dùng / TRÁNH (app-bar, tabbar, back, close, primary-cta,
// search). Loại màn → vai trò must/should/avoid là tri thức UX CHUNG (không
// phụ thuộc dự án) — sống ở bảng cố định SHELL_RULES bên dưới. Vai trò khung
// → component cụ thể trong DS/kit của MỘT dự án là việc RIÊNG (dò tự động
// theo tên trong catalog + kit, xem `detectShellBindings`) — cũng sống ở đây
// vì cùng domain "khung màn", nhưng module này KHÔNG import lab-map.ts/
// lab-audit.ts/lab-compose.ts (tránh vòng import — các module đó import
// NGƯỢC LẠI module này).
//
// Bằng chứng thật (23/08, xem .tmp/pipeline/wp-lab-shell.yaml): luật #7 cũ
// của skill lab-screen-compose ("màn CON → App Bar; màn GỐC → Tabbar") bắt
// agent TỰ ĐOÁN gốc/con MỖI LẦN CHẠY → 3 màn trần không thanh điều hướng khi
// DS đang bind là "[SDK] Web Lib" (không có App Bar), Tabbar gắn cả lên màn
// Detail, Tabbar 5 icon giống nhau lặp trên nhiều màn khác nhau. Người dùng
// muốn một "đề xuất comp phải dùng (App Bar) / nên dùng (Bottom Navigate —
// màn Detail thì không cần, chỉ cần Back)". Module này tách khung màn (WHAT —
// vai trò nào phải/nên/tránh có mặt, theo LOẠI màn) khỏi việc binding
// (component cụ thể nào trong DS/kit của dự án đáp ứng vai trò đó).
//
// Module THUẦN: không fs/network/server. lab-map.ts (deriveShellDefaults/
// resolveScreenShell/fillShellDefaults), lab-compose.ts, lab-kit.ts,
// lab-audit.ts import module này; server.ts gọi `detectShellBindings`/
// `detectShellRolesInSubtree` trực tiếp khi cần.

/** 6 LOẠI khung màn. `root`/`child` suy từ ĐỒ THỊ LUỒNG (không suy được từ
 *  tên/mục đích — xem docblock `deriveShellDefaults`, lab-map.ts); 4 loại còn
 *  lại suy được từ tên/mục đích màn (xem `SHELL_KIND_NAME_PATTERNS`):
 *  - `root`: màn home/tab chính — điểm bắt đầu, không ai trỏ vào nó.
 *  - `child`: màn con/detail/form từng bước — được một màn khác điều hướng
 *    tới.
 *  - `sheet`: bottom-sheet/drawer nổi trên màn nền.
 *  - `modal`: dialog/hộp thoại xác nhận.
 *  - `result`: màn kết quả (thành công/thất bại) của một luồng thao tác.
 *  - `fullscreen`: scanner/bản đồ/viewer chiếm toàn màn hình. */
export const SHELL_KINDS = ['root', 'child', 'sheet', 'modal', 'result', 'fullscreen'] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];

/** Vai trò khung — sự CÓ MẶT của một thành phần khung (WHAT), KHÔNG phải vị
 *  trí/bố cục (bố cục là việc của skill lab-screen-compose, luật #6/#8). */
export const SHELL_ROLES = ['app-bar', 'tabbar', 'back', 'close', 'primary-cta', 'search'] as const;
export type ShellRole = (typeof SHELL_ROLES)[number];

/** Khung của MỘT màn — `must` bắt buộc có mặt, `should` NÊN có (thiếu phải
 *  ghi lý do vào `note`, audit không soát `should`), `avoid` CẤM có mặt.
 *  `source`: `'agent'` khi chính agent lab-map ghi trong `screen-map.json`,
 *  `'derived'` khi daemon tự suy (xem `deriveShellDefaults`/
 *  `resolveScreenShell`/`fillShellDefaults`, lab-map.ts) vì agent bỏ trống. */
export interface ScreenMapShell {
  kind: ShellKind;
  must: ShellRole[];
  should: ShellRole[];
  avoid: ShellRole[];
  note?: string;
  source?: 'agent' | 'derived';
}

/** Bảng luật CỐ ĐỊNH — tri thức UX CHUNG, không phụ thuộc dự án nào:
 *  - `root` (home/tab chính): PHẢI có Tabbar, NÊN có search, TRÁNH back (màn
 *    gốc LÀ điểm bắt đầu, không có "quay lại").
 *  - `child` (màn con/detail/form bước): PHẢI có App Bar + back, TRÁNH tabbar
 *    (bằng chứng thật: Tabbar bị gắn cả lên màn Detail).
 *  - `sheet` (bottom-sheet/drawer): NÊN có close, TRÁNH app-bar/tabbar (sheet
 *    nổi trên màn nền, không phải một màn full có khung riêng).
 *  - `modal` (dialog/xác nhận): PHẢI có close, TRÁNH app-bar/tabbar.
 *  - `result` (kết quả thành công/thất bại): PHẢI có primary-cta (hành động
 *    tiếp theo), TRÁNH back/tabbar (không cho quay lại bước vừa xong).
 *  - `fullscreen` (scanner/bản đồ/viewer chiếm toàn màn): PHẢI có close,
 *    TRÁNH tabbar. */
export const SHELL_RULES: Record<ShellKind, { must: ShellRole[]; should: ShellRole[]; avoid: ShellRole[] }> = {
  root: { must: ['tabbar'], should: ['search'], avoid: ['back'] },
  child: { must: ['app-bar', 'back'], should: [], avoid: ['tabbar'] },
  sheet: { must: [], should: ['close'], avoid: ['app-bar', 'tabbar'] },
  modal: { must: ['close'], should: [], avoid: ['app-bar', 'tabbar'] },
  result: { must: ['primary-cta'], should: [], avoid: ['back', 'tabbar'] },
  fullscreen: { must: ['close'], should: [], avoid: ['tabbar'] },
};

/** Suy `kind` từ TÊN/MỤC ĐÍCH màn — chỉ áp cho 4 loại "đặc biệt" (root/child
 *  KHÔNG suy từ tên, xem docblock `deriveShellDefaults` ở lab-map.ts — hai
 *  loại đó cần đồ thị luồng, không phải văn bản). Thứ tự phần tử = thứ tự ưu
 *  tiên khi một tên/mục đích khớp nhiều regex cùng lúc. */
export const SHELL_KIND_NAME_PATTERNS: { kind: ShellKind; re: RegExp }[] = [
  { kind: 'sheet', re: /bottom.?sheet|sheet|drawer|popup/i },
  { kind: 'modal', re: /modal|dialog|xác nhận|confirm/i },
  // "kết quả"/"result" trần CỐ Ý không khớp — "Kết quả tìm kiếm"/"Search
  // results" là màn DANH SÁCH (child), không phải màn kết quả thao tác.
  { kind: 'result', re: /(kết quả|result)\s+(thanh toán|giao dịch|đặt|mua|đăng ký|payment|transaction|order)|thành công|thất bại|hoàn tất|success|\bfailed?\b/i },
  { kind: 'fullscreen', re: /scanner|quét|camera|bản đồ|map view|viewer/i },
];

/** Dò vai trò khung THEO TÊN node Figma (INSTANCE/FRAME/COMPONENT/
 *  COMPONENT_SET/GROUP trong subtree MỘT màn đã dựng) — CHỈ 2 vai trò dò
 *  được TẤT ĐỊNH theo tên (`app-bar`, `tabbar`); `back`/`close`/
 *  `primary-cta`/`search` KHÔNG có mục ở đây vì tên node quá đa hình để dò
 *  tất định trên một subtree (một nút "Back" cũng có thể tên "Quay lại",
 *  "<", một icon trần…) — audit (lab-audit.ts) vì vậy CHỈ soát 2 vai trò này
 *  (xem `AUDITABLE_SHELL_ROLES`). */
export const SHELL_ROLE_NODE_PATTERNS: Partial<Record<ShellRole, RegExp>> = {
  'app-bar': /app ?bar|appbar|navigation ?bar|nav ?bar|top ?bar/i,
  tabbar: /tab ?bar|tabbar|bottom ?nav(igation)?|bottom ?bar/i,
};

/** Vai trò audit CÓ THỂ soát tất định (dò theo tên node) — dùng bởi
 *  `auditLabSubtrees` (lab-audit.ts) để giới hạn `shell.must`/`shell.avoid`
 *  còn lại đúng 2 vai trò này khi so với `present` (kết quả
 *  `detectShellRolesInSubtree`). */
export const AUDITABLE_SHELL_ROLES: ShellRole[] = ['app-bar', 'tabbar'];

/** Dò COMPONENT DS/kit theo TÊN — rộng hơn `SHELL_ROLE_NODE_PATTERNS` vì đây
 *  chỉ cần khớp MỘT LẦN để binding vai trò → comp cụ thể trong catalog/kit
 *  của dự án (không cần tất định trên một subtree kết quả như audit). Đủ cả
 *  6 vai trò — 2 vai trò đầu dùng LẠI đúng pattern audit để một comp tên
 *  "App Bar"/"Tab Bar" luôn khớp nhất quán ở cả hai nơi. */
export const SHELL_ROLE_CATALOG_PATTERNS: Record<ShellRole, RegExp> = {
  'app-bar': /app ?bar|appbar|navigation ?bar|nav ?bar|top ?bar/i,
  tabbar: /tab ?bar|tabbar|bottom ?nav(igation)?|bottom ?bar/i,
  back: /\bback\b/i,
  close: /\bclose\b/i,
  'primary-cta': /^button\b|\bbutton\b/i,
  search: /\bsearch\b/i,
};

/** Một component ĐÃ khớp một vai trò khung — `from: 'kit'` LUÔN thắng
 *  `'ds'` khi cả hai đều có (xem `detectShellBindings`). `key`/`nodeId` tuỳ
 *  nguồn: comp DS thường có `key` ổn định (import cross-file); comp kit chỉ
 *  có `nodeId` của phiên gen gần nhất (kit gen lại từ đầu mỗi lần chạy
 *  lab-kit, không có key ổn định xuyên phiên). */
export interface ShellBinding {
  role: ShellRole;
  name: string;
  key?: string;
  nodeId?: string;
  from: 'kit' | 'ds';
}

interface CatalogComponentLike {
  name: string;
  key?: string;
  nodeId: string;
}

interface CatalogLike {
  files: { components: CatalogComponentLike[] }[];
}

interface KitComponentLike {
  name: string;
  componentNodeId?: string;
}

/** Với MỖI vai trò trong `SHELL_ROLES`, tìm component ĐÁP ỨNG vai trò đó:
 *
 *  1. `kit` (registry `kit/kit.json` của stage "Nâng bộ comp") — comp đầu
 *     tiên (theo thứ tự mảng) có tên khớp `SHELL_ROLE_CATALOG_PATTERNS[role]`
 *     THẮNG tuyệt đối, kể cả khi DS cũng có một comp khớp — kit là bản phái
 *     sinh thẩm mỹ cao hơn, luôn ưu tiên (cùng tinh thần `buildComposeBrief`'s
 *     `hasKit`).
 *  2. Không có trong kit → tìm trong `catalog.files[].components[]` (đúng
 *     thứ tự files → components) — ưu tiên tên BẮT ĐẦU bằng cụm khớp hơn tên
 *     chỉ CHỨA cụm khớp ở giữa (ví dụ "App Bar / Default" thắng "Custom App
 *     Bar Wrapper" khi cả hai đều khớp cùng vai trò); giữa nhiều comp cùng
 *     hạng ưu tiên (đều bắt-đầu-bằng, hoặc đều chỉ-chứa) thì giữ mục XUẤT
 *     HIỆN ĐẦU TIÊN theo thứ tự duyệt.
 *  3. Không khớp ở cả hai nguồn → BỎ vai trò đó (không có entry trong mảng
 *     kết quả) — không phải lỗi, chỉ là "chưa có binding cho vai trò này".
 *
 *  `catalog` nhận kiểu structural TỐI THIỂU (KHÔNG import
 *  figma-component-catalog.ts) để test không cần dựng một
 *  `FigmaComponentCatalogSnapshot` đầy đủ — server.ts truyền
 *  `FigmaComponentCatalogSnapshot` thật (tương thích cấu trúc structural). */
export function detectShellBindings(
  catalog: CatalogLike | null,
  kit: readonly KitComponentLike[],
): ShellBinding[] {
  const bindings: ShellBinding[] = [];

  for (const role of SHELL_ROLES) {
    const re = SHELL_ROLE_CATALOG_PATTERNS[role];

    const kitMatch = kit.find((c) => re.test(c.name));
    if (kitMatch) {
      const binding: ShellBinding = { role, name: kitMatch.name, from: 'kit' };
      if (kitMatch.componentNodeId) binding.nodeId = kitMatch.componentNodeId;
      bindings.push(binding);
      continue;
    }

    if (catalog) {
      let startsWithMatch: CatalogComponentLike | null = null;
      let containsMatch: CatalogComponentLike | null = null;
      for (const file of catalog.files) {
        for (const comp of file.components) {
          const name = comp.name.trim();
          const m = re.exec(name);
          if (!m) continue;
          if (m.index === 0) {
            if (!startsWithMatch) startsWithMatch = comp;
          } else if (!containsMatch) {
            containsMatch = comp;
          }
        }
      }
      const dsMatch = startsWithMatch ?? containsMatch;
      if (dsMatch) {
        const binding: ShellBinding = { role, name: dsMatch.name, nodeId: dsMatch.nodeId, from: 'ds' };
        if (dsMatch.key) binding.key = dsMatch.key;
        bindings.push(binding);
      }
    }
  }

  return bindings;
}

const SHELL_ROLE_SUBTREE_ROLES = Object.keys(SHELL_ROLE_NODE_PATTERNS) as ShellRole[];

const SUBTREE_ROLE_NODE_TYPES = new Set(['INSTANCE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'GROUP']);

interface ShellSubtreeNode {
  type?: string;
  visible?: boolean;
  name?: string;
  children?: unknown;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Duyệt subtree REST (`fetchNodeSubtrees`, figma-rest.ts) của MỘT màn đã
 *  dựng, chỉ nhánh ĐANG HIỂN THỊ (node hiện tại VÀ mọi tổ tiên đều có
 *  `visible !== false`) — nhánh ẩn không chứng minh gì (agent có thể đang
 *  giữ một biến thể tắt tạm, cùng nguyên tắc `auditLabSubtrees`'s
 *  placeholder/overflow ở lab-audit.ts). Node type INSTANCE/FRAME/COMPONENT/
 *  COMPONENT_SET/GROUP có `name` khớp `SHELL_ROLE_NODE_PATTERNS` → thêm vai
 *  trò tương ứng vào tập kết quả. TẤT ĐỊNH: không mạng/AI, cùng input luôn ra
 *  cùng kết quả. */
export function detectShellRolesInSubtree(node: unknown): Set<ShellRole> {
  const found = new Set<ShellRole>();

  const walk = (raw: unknown, parentVisible: boolean): void => {
    if (!isRecordLike(raw)) return;
    const n = raw as ShellSubtreeNode;
    const visible = parentVisible && n.visible !== false;

    if (visible && typeof n.type === 'string' && SUBTREE_ROLE_NODE_TYPES.has(n.type) && typeof n.name === 'string') {
      for (const role of SHELL_ROLE_SUBTREE_ROLES) {
        const re = SHELL_ROLE_NODE_PATTERNS[role];
        if (re && re.test(n.name)) found.add(role);
      }
    }

    if (Array.isArray(n.children)) {
      for (const child of n.children) walk(child, visible);
    }
  };

  walk(node, true);
  return found;
}
