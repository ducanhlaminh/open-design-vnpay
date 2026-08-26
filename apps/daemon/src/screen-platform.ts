// screen-variants WP-V1 (docs/screen-variants-spec.md §WP-V1) — suy `platform`
// của MỘT MÀN từ chuỗi heading cha của section nó thuộc về, thay vì hint
// nhị phân toàn tài liệu (MOBILE_HINT_RE trong screen-components.ts).
//
// Module THUẦN, không đụng file hiện có — T6 (Wave 2) mới wire vào
// resolveDocScreens/mergeExtractedScreens. KHÔNG import MOBILE_HINT_RE ở
// đây; fallback về hint cũ là việc của caller khi hàm này trả `null`.

/** Một mục trong bảng từ khóa: platform ứng với heading khớp `pattern`. */
export interface PlatformHeadingKeyword {
  platform: 'mobile' | 'web';
  pattern: RegExp;
}

/** Bảng từ khóa heading → platform, đúng danh sách spec §WP-V1. Thứ tự
 *  mobile trước web — không ảnh hưởng kết quả vì một heading thực tế chỉ
 *  nên khớp một phía; nếu khớp cả hai, mobile thắng theo thứ tự duyệt. */
// Nhãn CHUẨN HÓA của hệ là App (mobile) / Web — MB/IB/BO chỉ là TỪ KHÓA
// PHÁT HIỆN theo cách viết của dự án bank (Mobile/Internet Banking), giữ
// làm alias chứ không phải nhãn chuẩn.
export const PLATFORM_HEADING_KEYWORDS: PlatformHeadingKeyword[] = [
  { platform: 'mobile', pattern: /\bMB\b/ },
  { platform: 'mobile', pattern: /\bapp\b/i },
  { platform: 'mobile', pattern: /mobile/i },
  { platform: 'mobile', pattern: /app di động/i },
  { platform: 'mobile', pattern: /ứng dụng di động/i },
  { platform: 'mobile', pattern: /\biOS\b/ },
  { platform: 'mobile', pattern: /\bAndroid\b/i },
  { platform: 'mobile', pattern: /\bSDK\b/ },
  { platform: 'web', pattern: /\bIB\b/ },
  { platform: 'web', pattern: /internet banking/i },
  { platform: 'web', pattern: /\bBO\b/ },
  { platform: 'web', pattern: /backoffice/i },
  { platform: 'web', pattern: /back office/i },
  { platform: 'web', pattern: /\bweb\b/i },
  { platform: 'web', pattern: /\bCMS\b/ },
  { platform: 'web', pattern: /quản trị/i },
];

const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/;

interface HeadingNode {
  /** 0-based index vào mảng dòng. */
  line: number;
  level: number;
  text: string;
}

function collectHeadings(lines: string[]): HeadingNode[] {
  const headings: HeadingNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEADING_LINE_RE.exec(lines[i]!);
    if (m) headings.push({ line: i, level: m[1]!.length, text: m[2]!.trim() });
  }
  return headings;
}

// Heading có thể in đậm cả dòng (`## **I. Phạm vi**`) — bỏ `**` trước khi so
// khớp từ khóa. Dòng bold thuần đứng riêng (không có `#`) không được
// collectHeadings() nhặt nên không cần loại trừ riêng ở đây.
function stripBold(text: string): string {
  return text.replace(/\*\*/g, '').trim();
}

function matchPlatform(headingText: string): 'mobile' | 'web' | null {
  const clean = stripBold(headingText);
  for (const { platform, pattern } of PLATFORM_HEADING_KEYWORDS) {
    if (pattern.test(clean)) return platform;
  }
  return null;
}

/** Suy `platform` của một màn bằng cách leo NGƯỢC chuỗi heading cha của
 *  `sectionStartLine` (1-based, có thể trỏ vào chính một dòng heading hoặc
 *  vào một dòng thường/bold bên trong section). Duyệt heading gần nhất
 *  trước, xa dần theo cấp giảm dần (breadcrumb thật, bỏ qua heading anh em
 *  cùng cấp không bao section này); heading đầu tiên khớp từ khóa quyết
 *  định. Không heading nào khớp (kể cả khi nội dung BÊN TRONG section có
 *  chữ khớp từ khóa) → `null`, caller tự fallback MOBILE_HINT_RE. */
export function resolveScreenPlatform(md: string, sectionStartLine: number): 'mobile' | 'web' | null {
  const lines = md.split('\n');
  const headings = collectHeadings(lines);
  const targetLine = sectionStartLine - 1;

  const upTo = headings.filter((h) => h.line <= targetLine);
  if (upTo.length === 0) return null;

  // Dựng chuỗi cha: bắt đầu từ heading gần nhất (luôn nhận), sau đó chỉ
  // nhận heading kế tiếp (đi ngược) nếu cấp NHỎ HƠN heading vừa nhận —
  // đúng nghĩa "cha", loại các heading anh-em/cháu đứng trước nó.
  const chain: HeadingNode[] = [];
  let minLevel = Number.POSITIVE_INFINITY;
  for (let i = upTo.length - 1; i >= 0; i -= 1) {
    const h = upTo[i]!;
    if (h.level < minLevel) {
      chain.push(h);
      minLevel = h.level;
    }
  }

  for (const h of chain) {
    const platform = matchPlatform(h.text);
    if (platform) return platform;
  }
  return null;
}
