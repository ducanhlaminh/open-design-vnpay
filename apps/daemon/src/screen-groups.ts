// screen-variants WP-V2 (docs/screen-variants-spec.md §3.2–3.4, T2 trong
// docs/screen-variants-subplan.md): nhóm các biến thể nền tảng (MB/IB) của
// cùng một màn nghiệp vụ theo tên chuẩn hóa. Hàm THUẦN — không I/O, không
// import screen-components.ts (tránh phụ thuộc vòng; T6 mới wire vào
// pipeline thật, sau lớp quét/extract, trước buildScreensManifest).

/** Một màn ứng viên để nhóm. `platform` null = chưa xác định theo section —
 *  KHÔNG BAO GIỜ tham gia auto-nhóm hay gợi ý (spec: "Platform null không
 *  auto-nhóm"). Type khai LOCAL (không import) theo đúng ràng buộc T2. */
export interface GroupCandidate {
  key: string;
  name: string;
  platform: 'mobile' | 'web' | null;
}

/** Cặp tên gần-giống khác platform, để agent xác nhận qua kickoff lớp 2
 *  (docs-screen-discovery) — daemon KHÔNG tự nhóm ca này. */
export interface GroupSuggestion {
  a: GroupCandidate;
  b: GroupCandidate;
  reason: string;
}

export interface AutoGroupResult {
  /** groupKey (spec §3.4: `<stem>__G-<slug>`) -> key THÀNH VIÊN đã đổi tên
   *  (hậu tố `--mb`/`--ib`). */
  groups: Record<string, string[]>;
  /** key gốc -> key mới, chỉ cho các màn đã vào một nhóm ≥2 thành viên.
   *  Màn không vào nhóm KHÔNG xuất hiện ở đây (key giữ nguyên — bảo toàn G6). */
  renamedKeys: Record<string, string>;
  /** Ca mờ: khác platform, cùng stem, tên chuẩn hóa KHÔNG trùng hệt nhưng
   *  token của tên ngắn hơn là tập con token tên dài hơn. Không tự nhóm. */
  suggestions: GroupSuggestion[];
}

// Tiền tố khai màn hay gặp — chỉ bỏ khi đứng NGAY ĐẦU chuỗi (đã chuẩn hóa về
// ASCII trước đó nên "Màn hình" và "man hinh" cùng khớp regex này).
const NAME_PREFIX_RE = /^(man hinh|popup)\s+/;

/** Chuẩn hóa tên màn để so trùng (spec §3.4): lowercase, bỏ dấu tiếng Việt
 *  (NFD strip + đ/Đ→d/D thủ công vì đ không tách dấu qua NFD), bỏ tiền tố
 *  `màn hình`/`man hinh`/`popup` (CHỈ đầu chuỗi), collapse khoảng trắng.
 *  Bỏ dấu chạy TRƯỚC bỏ tiền tố nên "Màn hình" và "man hinh" quy về cùng
 *  dạng trước khi so khớp tiền tố. */
export function normalizeScreenName(name: string): string {
  const asciiLower = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
  return asciiLower.replace(NAME_PREFIX_RE, '').replace(/\s+/g, ' ').trim();
}

/** Phần trước dấu `__` đầu tiên của key — "stem" tài liệu/flow chứa màn
 *  (spec §3.4: groupKey chỉ hợp nhất các thành viên CÙNG stem). Không có
 *  `__` → cả key là stem của chính nó (không nhóm được với ai khác trừ khi
 *  trùng key nguyên văn, việc không xảy ra vì key phải duy nhất). */
function keyStem(key: string): string {
  const i = key.indexOf('__');
  return i === -1 ? key : key.slice(0, i);
}

/** slug ASCII cho groupKey: thay space bằng `-`, chỉ giữ [a-z0-9-]. */
function slugify(normalized: string): string {
  return normalized
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

function isSubset(shorter: Set<string>, longer: Set<string>): boolean {
  for (const t of shorter) {
    if (!longer.has(t)) return false;
  }
  return true;
}

const PLATFORM_SUFFIX = { mobile: '--mb', web: '--ib' } as const;

/** WP-V2: auto-nhóm CHỈ KHI tên chuẩn hóa trùng HỆT + platform khác nhau +
 *  cả hai đều non-null; không bao giờ nhóm 2 màn cùng platform (kể cả trùng
 *  tên hệt). Ca tên gần-giống (token con) đẩy vào `suggestions` cho agent
 *  quyết — daemon không tự bịa nhóm ngoài danh sách gợi ý. */
export function autoGroupScreens(screens: GroupCandidate[]): AutoGroupResult {
  const groups: Record<string, string[]> = {};
  const renamedKeys: Record<string, string> = {};
  const suggestions: GroupSuggestion[] = [];

  // Chỉ màn có platform xác định mới tham gia nhóm hoặc gợi ý.
  const eligible: Array<GroupCandidate & { platform: 'mobile' | 'web' }> = [];
  for (const s of screens) {
    if (s.platform != null) eligible.push({ key: s.key, name: s.name, platform: s.platform });
  }

  const normalizedByKey = new Map<string, string>();
  // Bucket theo (stem, tên chuẩn hóa) — khác stem thì không nhóm dù trùng tên.
  const buckets = new Map<string, { mobile: GroupCandidate[]; web: GroupCandidate[] }>();
  for (const s of eligible) {
    const norm = normalizeScreenName(s.name);
    normalizedByKey.set(s.key, norm);
    const bucketKey = `${keyStem(s.key)}::${norm}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { mobile: [], web: [] };
      buckets.set(bucketKey, bucket);
    }
    bucket[s.platform].push(s);
  }

  for (const [bucketKey, bucket] of buckets) {
    // Cùng platform trùng tên (kể cả nhiều màn 1 phía) → không bao giờ nhóm.
    if (bucket.mobile.length !== 1 || bucket.web.length !== 1) continue;
    const mobileScreen = bucket.mobile[0]!;
    const webScreen = bucket.web[0]!;
    const norm = bucketKey.slice(bucketKey.indexOf('::') + 2);
    const stem = keyStem(mobileScreen.key);
    const groupKey = `${stem}__G-${slugify(norm)}`;
    const mobileNewKey = `${mobileScreen.key}${PLATFORM_SUFFIX.mobile}`;
    const webNewKey = `${webScreen.key}${PLATFORM_SUFFIX.web}`;
    groups[groupKey] = [mobileNewKey, webNewKey];
    renamedKeys[mobileScreen.key] = mobileNewKey;
    renamedKeys[webScreen.key] = webNewKey;
  }

  // Ca mờ: khác platform, cùng stem, tên KHÔNG trùng hệt, token ngắn ⊂ token dài.
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      if (a.platform === b.platform) continue;
      if (keyStem(a.key) !== keyStem(b.key)) continue;
      const normA = normalizedByKey.get(a.key)!;
      const normB = normalizedByKey.get(b.key)!;
      if (normA === normB) continue; // trùng hệt đã xử lý ở nhánh auto-nhóm trên

      const tokensA = tokenSet(normA);
      const tokensB = tokenSet(normB);
      let shorter: Set<string>;
      let shorterName: string;
      let longer: Set<string>;
      let longerName: string;
      if (tokensA.size <= tokensB.size) {
        shorter = tokensA;
        shorterName = a.name;
        longer = tokensB;
        longerName = b.name;
      } else {
        shorter = tokensB;
        shorterName = b.name;
        longer = tokensA;
        longerName = a.name;
      }
      if (shorter.size === 0 || !isSubset(shorter, longer)) continue;

      suggestions.push({
        a,
        b,
        reason: `Tên "${shorterName}" là tập con từ của "${longerName}" (khác platform, cùng nguồn) — cần agent xác nhận anchorText cả hai phía trước khi nhóm.`,
      });
    }
  }

  return { groups, renamedKeys, suggestions };
}
