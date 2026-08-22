// ds-lab quality — lab-audit: daemon TỰ AUDIT tất định sau khi agent kết
// thúc phiên lab-kit/lab-compose, đọc THẲNG subtree REST (fetchNodeSubtrees)
// của node kết quả (frame màn hoặc component kit) để bắt 2 loại vi phạm MÁY
// BẮT ĐƯỢC tất định — không cần AI: (a) placeholder mặc định còn lộ (agent
// quên override/hide Title/Body/Content/...), (b) tràn biên trái/phải (kit
// comp có bề rộng tự nhiên cứng, đặt vào frame hẹp hơn bị cắt cụt mép — bằng
// chứng thật: kit comp rộng tự nhiên ~445pt đặt vào instance 358pt, render bị
// cắt cụt mép phải, SCR-02 mất luôn nút "Chọn gói", xem
// `.tmp/pipeline/wp-lab-quality.yaml`).
//
// Module THUẦN: không import fs/network/server. server.ts (runLabKit +
// runLabCompose) là caller duy nhất — gọi `fetchNodeSubtrees` (figma-rest.ts)
// lấy `node`, gọi `auditLabSubtrees` ở đây, rồi tự ghi `_audit.md` (render
// bởi `renderLabAuditMd`) vào thư mục output đã khai của stage. Audit là
// CẢNH BÁO (người quyết sửa hay bỏ qua) — KHÔNG BAO GIỜ được làm fail stage
// (xem `non_goals` trong yaml trên).

/** Một node kết quả cần audit — `node` là `document` subtree REST
 *  (`fetchNodeSubtrees`, figma-rest.ts) của MỘT node (frame màn hoặc
 *  component kit). `key`/`name` chỉ để gắn nhãn violation, không ảnh hưởng
 *  logic audit. */
export interface AuditSubtreeInput {
  key: string;
  name: string;
  node: unknown;
}

export interface LabAuditViolation {
  key: string;
  kind: 'placeholder' | 'overflow';
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

/** Audit TẤT ĐỊNH mảng node kết quả — placeholder còn lộ + tràn biên
 *  trái/phải quá {@link OVERFLOW_TOLERANCE_PX}px so với khung của CHÍNH node
 *  gốc (frame màn / component kit) của mỗi input. Chỉ duyệt nhánh đang HIỂN
 *  THỊ (node hiện tại VÀ mọi tổ tiên đều có `visible !== false`) — nhánh ẩn
 *  không phải lỗi (agent có thể đang giữ placeholder cho biến thể dùng sau).
 *  Node thiếu `absoluteBoundingBox` → bỏ qua kiểm tra tràn biên CHO NODE ĐÓ,
 *  không throw; node GỐC thiếu bbox → bỏ luôn kiểm tra tràn biên cho CẢ
 *  subtree đó (không có khung R để so, nhưng vẫn audit placeholder bình
 *  thường). Chỉ so lệch TRÁI/PHẢI — tràn ĐÁY là bình thường (màn cuộn dọc),
 *  không phải lỗi. Tất định: không gọi mạng/AI, cùng input luôn ra cùng kết
 *  quả theo đúng thứ tự duyệt cây. */
export function auditLabSubtrees(inputs: readonly AuditSubtreeInput[]): LabAuditViolation[] {
  const violations: LabAuditViolation[] = [];

  for (const input of inputs) {
    if (!isRecord(input.node)) continue;
    const root = input.node as FigmaAuditNode;
    const rootBox = readBBox(root.absoluteBoundingBox);

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
      const label = v.kind === 'placeholder' ? 'Placeholder' : 'Tràn biên';
      lines.push(`- **[${label}]** ${v.detail}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
