// WP-V5 lõi (docs/screen-variants-spec.md §WP-V5, subplan T5) — "lệch biến
// thể": tài liệu CR đa nền tảng khai cùng một màn 2 lần (bảng MB + bảng IB),
// cột "Mô tả" là bullet list các thay đổi — thường copy-paste giữa 2 bảng
// nên chỗ LỆCH thực chất là lỗi tài liệu đáng báo (vd MB có "Phản hồi (bổ
// sung)" mà IB không có). Module này CHỈ so sánh 2 danh sách bullet đã được
// bóc tách sẵn — không đọc file, không parse markdown, không import module
// daemon khác (wiring vào dr-review là việc của T8, phối hợp riêng).

/** Nền tảng của một biến thể màn hình. */
export type VariantPlatform = 'mobile' | 'web';

/** Mô tả (cột "Mô tả") của một biến thể trong nhóm — mỗi phần tử của mảng là
 *  một bullet NGUYÊN VĂN (chưa chuẩn hóa) đọc từ bảng MB/IB. */
export interface VariantDescription {
  key: string;
  platform: VariantPlatform;
  descriptionBullets: string[];
}

/** Một chỗ lệch thực chất: bullet chỉ xuất hiện ở đúng một phía (mobile hoặc
 *  web) của nhóm. `bullet` giữ NGUYÊN VĂN chưa chuẩn hóa để agent/BA đọc lại
 *  đúng câu trong tài liệu; `counterpartKey` là key biến thể phía đối diện
 *  (evidence để dr-review trỏ sang bảng kia). */
export interface VariantDriftFinding {
  groupKey: string;
  onlyIn: VariantPlatform;
  bullet: string;
  counterpartKey: string;
}

/** Chuẩn hóa một bullet trước khi so trùng:
 *  - bỏ marker đầu dòng (`•`, `-`, `*`)
 *  - collapse khoảng trắng, trim
 *  - bỏ dấu câu cuối dòng (`.`, `,`, `;`, `:`, `!`, `?`, `…`)
 *  - lowercase
 *  KHÔNG bỏ dấu tiếng Việt — nội dung tiếng Việt, mất dấu đổi nghĩa. */
function normalizeBullet(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^[•\-*]\s*/, '');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/[.,;:!?…]+$/u, '');
  return text.toLowerCase().trim();
}

interface NormalizedBullet {
  key: string;
  original: string;
  normalized: string;
}

/** Gom mọi bullet của các entry thuộc một platform trong nhóm, kèm bản gốc
 *  và bản chuẩn hóa (dùng để so trùng theo TẬP HỢP, order-insensitive). */
function collectByPlatform(entries: VariantDescription[], platform: VariantPlatform): NormalizedBullet[] {
  const out: NormalizedBullet[] = [];
  for (const entry of entries) {
    if (entry.platform !== platform) continue;
    for (const bullet of entry.descriptionBullets) {
      out.push({ key: entry.key, original: bullet, normalized: normalizeBullet(bullet) });
    }
  }
  return out;
}

/** So cột "Mô tả" giữa các biến thể mobile/web của CÙNG một nhóm (`groupKey`)
 *  và trả về danh sách chỗ lệch thực chất. Hàm THUẦN — không I/O.
 *
 *  - entries < 2 phần tử, hoặc mọi entry cùng platform → [] (không có gì để
 *    so — cần ít nhất một phía mobile và một phía web).
 *  - So theo TẬP HỢP bullet đã chuẩn hóa: bullet chỉ có ở đúng một phía → 1
 *    finding cho phía đó; 2 danh sách tương đương khác thứ tự/marker/hoa-
 *    thường → không sinh finding nào cho cặp đó.
 *  - Khi có nhiều entry cùng platform trong nhóm (hiếm), bullet của chúng
 *    được gộp coi như một tập; `counterpartKey` của finding lấy key của entry
 *    ĐẦU TIÊN ở phía đối diện làm đại diện. */
export function diffVariantDescriptions(groupKey: string, entries: VariantDescription[]): VariantDriftFinding[] {
  if (entries.length < 2) return [];

  const mobile = collectByPlatform(entries, 'mobile');
  const web = collectByPlatform(entries, 'web');
  if (mobile.length === 0 || web.length === 0) return [];

  const mobileNormSet = new Set(mobile.map((b) => b.normalized));
  const webNormSet = new Set(web.map((b) => b.normalized));
  const firstMobileKey = mobile[0]!.key;
  const firstWebKey = web[0]!.key;

  const findings: VariantDriftFinding[] = [];

  const seenMobile = new Set<string>();
  for (const b of mobile) {
    if (webNormSet.has(b.normalized) || seenMobile.has(b.normalized)) continue;
    seenMobile.add(b.normalized);
    findings.push({ groupKey, onlyIn: 'mobile', bullet: b.original, counterpartKey: firstWebKey });
  }

  const seenWeb = new Set<string>();
  for (const b of web) {
    if (mobileNormSet.has(b.normalized) || seenWeb.has(b.normalized)) continue;
    seenWeb.add(b.normalized);
    findings.push({ groupKey, onlyIn: 'web', bullet: b.original, counterpartKey: firstMobileKey });
  }

  return findings;
}
