// ds-lab quality — lab-audit: daemon TỰ AUDIT tất định sau khi agent kết
// thúc phiên lab-kit/lab-compose, đọc THẲNG subtree REST (fetchNodeSubtrees)
// của node kết quả (frame màn hoặc component kit) để bắt 4 loại vi phạm MÁY
// BẮT ĐƯỢC tất định — không cần AI: (a) placeholder mặc định còn lộ (agent
// quên override/hide Title/Body/Content/...), (b) tràn biên trái/phải (kit
// comp có bề rộng tự nhiên cứng, đặt vào frame hẹp hơn bị cắt cụt mép — bằng
// chứng thật: kit comp rộng tự nhiên ~445pt đặt vào instance 358pt, render bị
// cắt cụt mép phải, SCR-02 mất luôn nút "Chọn gói", xem
// `.tmp/pipeline/wp-lab-quality.yaml`); (c) 'no-instance' — subtree KHÔNG
// chứa node INSTANCE nào (bằng chứng thật WP-lab-clean, node kit 114:14: comp
// "Order Summary Card" = 0 INSTANCE, datarow/Badge/Currency chỉ là frame+text
// đặt tên giống base, không import base thật bằng key); (d) 'no-bound-
// variable' — subtree KHÔNG node nào có `boundVariables` (REST trả field
// này khi màu/chữ được bind vào biến DS thay vì giá trị trần). (c)/(d) là
// tín hiệu CHẤT LƯỢNG (thiếu instance/bind thật), không phải lỗi cấu trúc
// như (a)/(b) — cùng nguyên tắc cảnh báo, không chặn stage (xem
// `.tmp/pipeline/wp-lab-clean.yaml`).
//
// WP-lab-reorder (2026-08-23 — .tmp/pipeline/wp-lab-reorder.yaml): (c)
// 'no-instance' SIẾT lại thành CHỈ đếm instance ở nhánh HIỂN THỊ — bằng
// chứng thật: agent import base rồi ẨN làm "tham chiếu" rồi vẽ lại ruột bằng
// frame (Order Summary Card 153:11, Plan Card 151:7); audit CŨ (đếm cả nhánh
// ẩn) vẫn coi instance ẩn đó là "đã có instance" dù trên màn người dùng chỉ
// thấy frame vẽ lại — không còn bắt được chiêu lách này. (d) 'no-bound-
// variable' GIỮ NGUYÊN đếm cả nhánh ẩn (không đổi).
//
// Module THUẦN: không import fs/network/server. server.ts (runLabKit +
// runLabCompose) là caller duy nhất — gọi `fetchNodeSubtrees` (figma-rest.ts)
// lấy `node`, gọi `auditLabSubtrees` ở đây, rồi tự ghi `_audit.md` (render
// bởi `renderLabAuditMd`) vào thư mục output đã khai của stage. Audit là
// CẢNH BÁO (người quyết sửa hay bỏ qua) — KHÔNG BAO GIỜ được làm fail stage
// (xem `non_goals` trong yaml trên).
//
// WP-lab-shell (2026-08-23 — .tmp/pipeline/wp-lab-shell.yaml): + kind
// 'shell-mismatch' — khi caller truyền `shell.must`/`shell.avoid` (khung màn
// HIỆU LỰC của MÀN đó, xem lab-map.ts's `resolveScreenShell`), dò
// `detectShellRolesInSubtree` (lab-shell.ts) rồi so: thiếu một role `must`,
// hoặc thừa một role `avoid` → violation. CHỈ soát 2 vai trò dò được tất
// định theo tên node (`AUDITABLE_SHELL_ROLES` — app-bar/tabbar); `should`
// KHÔNG audit (thiếu `should` là quyết định thẩm mỹ có thể có lý do chính
// đáng, agent ghi vào `notes` thay vì bị máy bắt lỗi).

import { AUDITABLE_SHELL_ROLES, detectShellRolesInSubtree, type ShellRole } from './lab-shell.js';

const SHELL_ROLE_LABELS: Record<ShellRole, string> = {
  'app-bar': 'App Bar',
  tabbar: 'Tabbar',
  back: 'Back',
  close: 'Close',
  'primary-cta': 'Primary CTA',
  search: 'Search',
};

/** Một node kết quả cần audit — `node` là `document` subtree REST
 *  (`fetchNodeSubtrees`, figma-rest.ts) của MỘT node (frame màn hoặc
 *  component kit). `key`/`name` chỉ để gắn nhãn violation, không ảnh hưởng
 *  logic audit. */
export interface AuditSubtreeInput {
  key: string;
  name: string;
  node: unknown;
  /** WP-lab-shell: khung màn HIỆU LỰC của MÀN này (`resolveScreenShell`,
   *  lab-map.ts) — chỉ `must`/`avoid` (audit không soát `should`, xem
   *  docblock đầu file). Absent → hành vi CŨ, không có violation
   *  'shell-mismatch' nào cho input này. */
  shell?: { must: string[]; avoid: string[] };
}

export interface LabAuditViolation {
  key: string;
  kind: 'placeholder' | 'overflow' | 'no-instance' | 'no-bound-variable' | 'shell-mismatch';
  detail: string;
}

interface FigmaAuditBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FigmaAuditNode {
  type?: string;
  visible?: boolean;
  name?: string;
  characters?: string;
  absoluteBoundingBox?: FigmaAuditBBox;
  children?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readBBox(value: unknown): FigmaAuditBBox | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return null;
  }
  return { x, y, width, height };
}

// Placeholder mặc định của comp base — khớp NGUYÊN VĂN (sau trim + lowercase)
// một trong các chuỗi này thì coi là "quên override/hide" (luật #5 skill
// lab-screen-compose; bằng chứng thật đã gặp: "Title"/"Body" vẫn lộ dưới lớp
// chữ mới, "Active tab" chưa được thay bằng tên tab thật).
const PLACEHOLDER_TEXTS = new Set([
  'title',
  'body',
  'content',
  'label',
  'active tab',
  'paragraph',
  'text here',
  'lorem',
  'lorem ipsum',
]);

// Bằng chứng thật (WP-lab-quality): kit comp rộng tự nhiên cứng ~445pt đặt
// vào instance 358pt → ruột thò ra ngoài biên, render cắt cụt mép phải. Cho
// một biên dung sai nhỏ (làm tròn số/subpixel Figma) trước khi coi là vi
// phạm thật.
const OVERFLOW_TOLERANCE_PX = 2;

// WP-lab-reorder (.tmp/pipeline/wp-lab-reorder.yaml): SIẾT lại từ "duyệt cả
// nhánh ẩn" sang CHỈ nhánh ĐANG HIỂN THỊ (node hiện tại VÀ mọi tổ tiên đều
// có `visible !== false`) — bằng chứng thật (WP-lab-clean đã gặp, và bị lách
// tiếp ở WP-lab-clean's kit "Order Summary Card" 153:11 / "Plan Card" 151:7):
// agent import base thật rồi ẨN nó làm "tham chiếu", sau đó vẽ lại ruột bằng
// frame/text đặt tên giống base — audit CŨ (đếm cả nhánh ẩn) vẫn coi instance
// ẩn đó là "đã có instance" dù người dùng chỉ THẤY frame vẽ lại trên màn. Từ
// WP này: instance PHẢI HIỂN THỊ mới được tính — nhánh ẩn không còn "chứng
// minh" gì nữa (không khác gì không import).
function subtreeHasInstance(node: FigmaAuditNode, parentVisible = true): boolean {
  const visible = parentVisible && node.visible !== false;
  if (!visible) return false;
  if (node.type === 'INSTANCE') return true;
  for (const child of asArray(node.children)) {
    if (isRecord(child) && subtreeHasInstance(child as FigmaAuditNode, visible)) return true;
  }
  return false;
}

// Cùng kiểu duyệt TOÀN BỘ subtree (kể cả nhánh ẩn) — REST Figma đính field
// `boundVariables` (object khoá theo thuộc tính: fills/strokes/characters…)
// lên MỖI node có ít nhất một giá trị đang bind vào biến DS; object rỗng/
// vắng mặt nghĩa là node đó toàn giá trị trần (hex/px cứng).
function subtreeHasBoundVariable(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const bv = (node as Record<string, unknown>).boundVariables;
  if (isRecord(bv) && Object.keys(bv).length > 0) return true;
  for (const child of asArray((node as FigmaAuditNode).children)) {
    if (subtreeHasBoundVariable(child)) return true;
  }
  return false;
}

/** Audit TẤT ĐỊNH mảng node kết quả — placeholder còn lộ, tràn biên trái/
 *  phải quá {@link OVERFLOW_TOLERANCE_PX}px so với khung của CHÍNH node gốc
 *  (frame màn / component kit) của mỗi input, KHÔNG chứa instance base thật
 *  nào ('no-instance'), và KHÔNG có màu/chữ nào bind biến DS
 *  ('no-bound-variable'). Placeholder/tràn biên chỉ duyệt nhánh đang HIỂN
 *  THỊ (node hiện tại VÀ mọi tổ tiên đều có `visible !== false`) — nhánh ẩn
 *  không phải lỗi (agent có thể đang giữ placeholder cho biến thể dùng sau).
 *  'no-instance' (WP-lab-reorder, .tmp/pipeline/wp-lab-reorder.yaml) NAY
 *  CŨNG chỉ tính nhánh hiển thị — một instance chỉ tồn tại trong nhánh ẨN
 *  không còn được coi là "đã có instance" (bằng chứng: agent import base rồi
 *  ẨN làm "tham chiếu" rồi vẽ lại ruột bằng frame). 'no-bound-variable' VẪN
 *  duyệt CẢ nhánh ẩn — không đổi (một bind đang tạm ẩn vẫn chứng minh agent
 *  đã dùng cơ chế đúng, khác hẳn "tham chiếu ẩn rồi vẽ lại"). Node thiếu
 *  `absoluteBoundingBox` → bỏ qua kiểm tra tràn biên CHO NODE ĐÓ, không
 *  throw; node GỐC thiếu bbox → bỏ luôn kiểm tra tràn biên cho CẢ subtree đó
 *  (không có khung R để so, nhưng vẫn audit các loại khác bình thường). Chỉ
 *  so lệch TRÁI/PHẢI — tràn ĐÁY là bình thường (màn cuộn dọc), không phải
 *  lỗi. Mỗi input chỉ báo TỐI ĐA MỘT violation cho MỖI kind 'no-instance'/
 *  'no-bound-variable' (khác 'placeholder'/'overflow' — báo mọi lần gặp).
 *  Tất định: không gọi mạng/AI, cùng input luôn ra cùng kết quả theo đúng
 *  thứ tự duyệt cây. */
export function auditLabSubtrees(inputs: readonly AuditSubtreeInput[]): LabAuditViolation[] {
  const violations: LabAuditViolation[] = [];

  for (const input of inputs) {
    if (!isRecord(input.node)) continue;
    const root = input.node as FigmaAuditNode;
    const rootBox = readBBox(root.absoluteBoundingBox);

    if (!subtreeHasInstance(root)) {
      violations.push({
        key: input.key,
        kind: 'no-instance',
        detail: `"${input.name || input.key}" không chứa instance base nào — dựng lại từ đầu bằng frame/text?`,
      });
    }
    if (!subtreeHasBoundVariable(root)) {
      violations.push({
        key: input.key,
        kind: 'no-bound-variable',
        detail: `"${input.name || input.key}" mọi màu/chữ là giá trị trần, không bind biến DS.`,
      });
    }

    // WP-lab-shell: 'shell-mismatch' — CHỈ soát 2 vai trò dò được tất định
    // theo tên node (AUDITABLE_SHELL_ROLES); `should` không audit (xem
    // docblock đầu file).
    if (input.shell) {
      const present = detectShellRolesInSubtree(root);
      const label = input.name || input.key;
      for (const role of input.shell.must) {
        if (!AUDITABLE_SHELL_ROLES.includes(role as ShellRole)) continue;
        if (!present.has(role as ShellRole)) {
          violations.push({
            key: input.key,
            kind: 'shell-mismatch',
            detail: `"${label}" thiếu ${SHELL_ROLE_LABELS[role as ShellRole]} (khung màn yêu cầu phải có).`,
          });
        }
      }
      for (const role of input.shell.avoid) {
        if (!AUDITABLE_SHELL_ROLES.includes(role as ShellRole)) continue;
        if (present.has(role as ShellRole)) {
          violations.push({
            key: input.key,
            kind: 'shell-mismatch',
            detail: `"${label}" có ${SHELL_ROLE_LABELS[role as ShellRole]} dù khung màn yêu cầu tránh.`,
          });
        }
      }
    }

    const walk = (raw: unknown, parentVisible: boolean): void => {
      if (!isRecord(raw)) return;
      const node = raw as FigmaAuditNode;
      const visible = parentVisible && node.visible !== false;
      const name = str(node.name) || str(node.type) || '(không tên)';

      if (visible) {
        if (node.type === 'TEXT') {
          const rawCharacters = str(node.characters).trim();
          if (PLACEHOLDER_TEXTS.has(rawCharacters.toLowerCase())) {
            violations.push({
              key: input.key,
              kind: 'placeholder',
              detail: `Node "${name}" vẫn hiển thị placeholder mặc định "${rawCharacters}" — override chữ thật hoặc hide node này.`,
            });
          }
        }

        if (rootBox) {
          const box = readBBox(node.absoluteBoundingBox);
          if (box) {
            const overflowRight = box.x + box.width - (rootBox.x + rootBox.width);
            const overflowLeft = rootBox.x - box.x;
            if (overflowRight > OVERFLOW_TOLERANCE_PX) {
              violations.push({
                key: input.key,
                kind: 'overflow',
                detail: `Node "${name}" tràn ${Math.round(overflowRight)}px về phía PHẢI khỏi khung ${input.name || input.key}.`,
              });
            }
            if (overflowLeft > OVERFLOW_TOLERANCE_PX) {
              violations.push({
                key: input.key,
                kind: 'overflow',
                detail: `Node "${name}" tràn ${Math.round(overflowLeft)}px về phía TRÁI khỏi khung ${input.name || input.key}.`,
              });
            }
          }
        }
      }

      for (const child of asArray(node.children)) walk(child, visible);
    };

    for (const child of asArray(root.children)) walk(child, true);
  }

  return violations;
}

export interface RenderLabAuditMdOptions {
  generatedAt: string;
  /** 'màn' cho lab-compose (frame màn), 'component' cho lab-kit — chỉ đổi
   *  cách xưng hô trong header, không đổi cấu trúc render. */
  subject: 'màn' | 'component';
}

/** Render markdown tiếng Việt `_audit.md` — CẢNH BÁO tất định máy bắt được,
 *  KHÔNG PHẢI lỗi chặn stage (người quyết sửa hay bỏ qua). Nhóm violation
 *  theo `key`, mỗi violation một bullet. `violations` rỗng → trả `''` —
 *  caller (server.ts) không ghi file khi rỗng (và xoá file `_audit.md` cũ
 *  nếu sót từ lần chạy trước, xem docblock `runLabCompose`/`runLabKit`). */
export function renderLabAuditMd(violations: readonly LabAuditViolation[], opts: RenderLabAuditMdOptions): string {
  if (violations.length === 0) return '';

  const lines: string[] = [];
  lines.push('# Máy tự soát sau run — sửa rồi Chạy lại stage');
  lines.push('');
  lines.push(
    `> Đây là kết quả TỰ SOÁT tất định của daemon ngay sau khi ${opts.subject} được render — ` +
      'KHÔNG chặn stage (bạn tự quyết định có sửa hay không), nhưng mỗi vi phạm dưới đây là ' +
      'dấu hiệu thật (placeholder còn lộ, hoặc nội dung tràn ra ngoài khung). Sửa xong thì bấm ' +
      '"Chạy lại" stage này để soát lại — file này tự sinh lại mỗi lần chạy, không chỉnh tay.',
  );
  lines.push('');
  lines.push(`Sinh lúc: \`${opts.generatedAt}\` · ${violations.length} vi phạm.`);
  lines.push('');

  const byKey = new Map<string, LabAuditViolation[]>();
  for (const v of violations) {
    const list = byKey.get(v.key) ?? [];
    list.push(v);
    byKey.set(v.key, list);
  }

  for (const [key, list] of byKey) {
    lines.push(`## ${key}`);
    lines.push('');
    for (const v of list) {
      const label =
        v.kind === 'placeholder'
          ? 'Placeholder'
          : v.kind === 'overflow'
            ? 'Tràn biên'
            : v.kind === 'no-instance'
              ? 'Không instance'
              : v.kind === 'no-bound-variable'
                ? 'Không bind biến'
                : 'Khung màn';
      lines.push(`- **[${label}]** ${v.detail}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
