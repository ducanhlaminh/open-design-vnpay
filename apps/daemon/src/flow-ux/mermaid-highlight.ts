// WP-drreview-mmd-color-badge — sơ đồ mermaid ĐỀ XUẤT của bước "Đánh giá
// luồng UX" (dr-flow) chỉ có màu highlight (3 classDef od-added/od-modified/
// od-removed) khi AGENT tự tô — skills/docs-flow-ux/SKILL.md mục 4b bắt tô
// nhưng `finalizeFlowUx` không ép, và `docs-review-enrich` chép
// `proposed.mmd` NGUYÊN VĂN vào lát. Agent quên tô → sơ đồ mới hiện trơn y
// hệt bản cũ, người xem không biết gì đã đổi. Đối xứng với draw.io (ở đó
// DAEMON tô màu qua `patch.ts`, không phụ thuộc agent) — hàm THUẦN dưới đây
// bù màu cho mermaid theo cùng nguyên tắc: KHÔNG đọc đĩa, KHÔNG gọi mạng,
// caller ({@link ../flow-ux/index.js !finalizeFlowUx} và khối enrich dr-review
// trong server.ts) tự đọc as-is.mmd/proposed.mmd rồi truyền nội dung vào.
import { parseMermaidEdgesLoose } from './index.js';

/** 3 classDef chuẩn — PHẢI khớp patch.ts `CHANGE_STYLE` (draw.io) và
 *  skills/docs-flow-ux/SKILL.md mục 4b (mermaid) để hai loại sơ đồ dr-flow
 *  dùng chung một bảng màu, và khớp `.legendDot*` trong
 *  DocRedlinePreview.module.css để chú giải web đúng màu thật. */
const CLASS_DEFS = {
  'od-added': 'classDef od-added fill:#D5E8D4,stroke:#82B366,color:#1B4D1F',
  'od-modified': 'classDef od-modified fill:#FFF2CC,stroke:#D6B656,color:#5C4A00',
  'od-removed': 'classDef od-removed fill:#F8CECC,stroke:#B85450,stroke-dasharray:5 5,color:#5C1F1B',
} as const satisfies Record<string, string>;
type OdClassName = keyof typeof CLASS_DEFS;
const CLASS_ORDER: OdClassName[] = ['od-added', 'od-modified', 'od-removed'];

/** Dòng không phải cạnh/khai node — cùng danh sách loại trừ với
 *  `parseMermaidEdgesLoose`, mở rộng thêm `style`/`linkStyle`/`subgraph`/
 *  `end`/`direction` (những dòng dr-flow/mermaid thực sự dùng nhưng không
 *  bao giờ khai một node có nhãn). */
const EXCLUDED_LINE_RE =
  /^(%%|classDef\b|class\b|style\b|linkStyle\b|subgraph\b|end\b|direction\b|flowchart\b|graph\b)/i;

/** Một node mermaid khai nhãn: `id[Text]`, `id(Text)`, `id([Text])`,
 *  `id[[Text]]`, `id{Text}`, `id{{Text}}`, `id[/Text/]`, `id[\Text\]`. Thứ tự
 *  alternation CỐ Ý đi từ hình dạng "kép" (2 ký tự bao: `([…])`, `[[…]]`,
 *  `{{…}}`, `[/…/]`, `[\…\]`) tới hình dạng "đơn" (`[…]`, `(…)`, `{…}`) —
 *  alternation JS chọn nhánh khớp ĐẦU TIÊN theo thứ tự viết, nên nếu hình
 *  đơn đứng trước, `id([Text])` sẽ bị nhánh `\(([^)]*)\)` nuốt nhầm phần bao
 *  ngoài `([…])` thành nhãn `[Text` dở dang. Áp dụng lặp lại trên một dòng
 *  (`g`) vì một dòng cạnh có thể khai nhãn cho CẢ HAI đầu, ví dụ
 *  `A[Bắt đầu] --> B[Kết thúc]`. */
const NODE_LABEL_RE =
  /([A-Za-z0-9_-]+)(?:\(\[([^\]]*)\]\)|\[\[([^\]]*)\]\]|\{\{([^}]*)\}\}|\[\/([^/]*)\/\]|\[\\([^\\]*)\\\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})/g;

/** Dòng đã giữ được sau khi lọc `%%`/`classDef`/`class`/`style`/`linkStyle`/
 *  `subgraph`/`end`/`direction`/`flowchart`/`graph` — phần còn lại của một
 *  sơ đồ mermaid chỉ còn cạnh và khai node. */
function retainedLines(code: string): string[] {
  return code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => line && !EXCLUDED_LINE_RE.test(line));
}

/** Nhãn thô từng node id (id → nhãn CHƯA chuẩn hoá, khai báo ĐẦU TIÊN thắng
 *  khi một id được khai nhiều lần) + thứ tự id xuất hiện lần đầu trong
 *  `code` (gộp cả id chỉ xuất hiện ở đầu/cuối một cạnh không nhãn) — dùng để
 *  (a) so nhãn as-is vs proposed cho node "sửa", (b) xếp id đúng thứ tự xuất
 *  hiện khi ghi dòng `class <ids> od-…` (yêu cầu spec). */
function scanNodes(code: string): { labels: Map<string, string>; order: string[] } {
  const labels = new Map<string, string>();
  const order: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const line of retainedLines(code)) {
    NODE_LABEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NODE_LABEL_RE.exec(line))) {
      const id = m[1]!;
      const label = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9] ?? '';
      pushId(id);
      if (!labels.has(id)) labels.set(id, label);
    }
    // Tái dùng logic cạnh của flow-ux/index.ts (spec: "ưu tiên export + import
    // lại") — chỉ cần id hai đầu ở đây, nhãn (nếu có) đã bắt được ở trên.
    for (const edge of parseMermaidEdgesLoose(line)) {
      pushId(edge.from);
      pushId(edge.to);
    }
  }
  return { labels, order };
}

/** Chuẩn hoá nhãn để so as-is/proposed: trim, gộp whitespace liên tiếp
 *  thành một khoảng trắng, bỏ dấu nháy kép bao ngoài (mermaid cho phép
 *  `A["nhãn có , dấu"]` khi nhãn chứa ký tự đặc biệt — dấu nháy không phải
 *  một phần nội dung nhãn). */
function normalizeLabel(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s;
}

/** Agent ĐÃ tô: dùng `:::od-…` (cú pháp rút gọn) hoặc một dòng
 *  `class <ids> od-…` bất kỳ. */
function usesOdClass(code: string): boolean {
  return (
    /:::od-(?:added|modified|removed)\b/.test(code) ||
    /^\s*class\s+\S.*\bod-(?:added|modified|removed)\b/m.test(code)
  );
}

function hasClassDef(code: string, name: OdClassName): boolean {
  return new RegExp(`^\\s*classDef\\s+${name}\\b`, 'm').test(code);
}

/** Nối thêm `lines` vào cuối `code`, luôn kết thúc bằng ĐÚNG MỘT dòng trống
 *  cuối file — khớp quy ước ghi file mermaid khác trong flow-ux/index.ts
 *  (`writeFileSync(..., \`${code.trim()}\n\`)`). */
function appendLines(code: string, lines: string[]): string {
  return `${code.replace(/\n+$/, '')}\n${lines.join('\n')}\n`;
}

/**
 * Bù màu 3 classDef `od-added`/`od-modified`/`od-removed` lên `proposedCode`
 * khi agent dr-flow quên tô (skills/docs-flow-ux mục 4b bắt tô nhưng
 * `finalizeFlowUx` không ép — xem docblock đầu file). Hàm THUẦN.
 *
 * - Agent ĐÃ tô (đã dùng bất kỳ class `od-*`): chỉ bù các dòng `classDef`
 *   CÒN THIẾU vào cuối, không đụng gì khác — tôn trọng lựa chọn tô của
 *   agent. Đã đủ cả 3 classDef → trả nguyên văn.
 * - Agent CHƯA tô (không một `class od-*`/`:::od-*` nào): diff node id giữa
 *   as-is và proposed — id chỉ có ở proposed là "thêm" (`od-added`), id có ở
 *   cả hai nhưng đổi nhãn là "sửa" (`od-modified`) — rồi tự thêm 3 classDef
 *   + dòng `class <ids> od-…` (id theo đúng thứ tự xuất hiện trong
 *   proposed) vào cuối. Node bị XOÁ khỏi proposed không tô được (không còn
 *   node để gán class) — ngoài phạm vi hàm này, trách nhiệm của agent
 *   (giữ node + tự gán `od-removed` theo skill).
 * - Không phát hiện gì ở cả hai trường hợp trên (đã tô đủ classDef, hoặc
 *   chưa tô nhưng diff không thấy thêm/sửa) → trả `proposedCode` NGUYÊN VĂN
 *   TỪNG BYTE — bất biến quan trọng: sơ đồ không đổi không được đụng vào.
 */
export function ensureProposedMermaidHighlight(asIsCode: string, proposedCode: string): string {
  if (usesOdClass(proposedCode)) {
    const missing = CLASS_ORDER.filter((name) => !hasClassDef(proposedCode, name));
    if (missing.length === 0) return proposedCode;
    return appendLines(proposedCode, missing.map((name) => CLASS_DEFS[name]));
  }

  const asIs = scanNodes(asIsCode);
  const proposed = scanNodes(proposedCode);
  const asIsIds = new Set(asIs.order);

  const added: string[] = [];
  const modified: string[] = [];
  for (const id of proposed.order) {
    if (!asIsIds.has(id)) {
      added.push(id);
      continue;
    }
    const asIsLabel = asIs.labels.get(id);
    const proposedLabel = proposed.labels.get(id);
    if (asIsLabel != null && proposedLabel != null && normalizeLabel(asIsLabel) !== normalizeLabel(proposedLabel)) {
      modified.push(id);
    }
  }

  if (added.length === 0 && modified.length === 0) return proposedCode;

  const lines: string[] = CLASS_ORDER.map((name) => CLASS_DEFS[name]);
  if (added.length) lines.push(`class ${added.join(',')} od-added`);
  if (modified.length) lines.push(`class ${modified.join(',')} od-modified`);
  return appendLines(proposedCode, lines);
}
