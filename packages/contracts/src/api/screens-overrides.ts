// DTO cho lớp 3 của dr-comp v2 (workflow `docs-review`, kiến trúc 3 lớp đã
// duyệt 19/08): người dùng phải NHÌN THẤY máy đoán màn nào (ScreensManifest —
// mỗi màn kèm nguồn gốc `origin`) và SỬA được khi máy sai (ScreensOverrides),
// thay vì phải sửa prompt hay sửa tài liệu gốc.
//
// Hai DTO này KHÔNG đồng bộ hai chiều:
// - ScreensOverrides là nguồn sự thật do NGƯỜI DÙNG giữ (đọc/ghi tại
//   `docs-review/screens-overrides.json` — nằm NGOÀI `comp/`, cùng lý do
//   `criteria/` sống sót re-run clear vì stage này bị "Run lại" dọn sạch
//   `comp/` mỗi lần chạy).
// - ScreensManifest chỉ là ẢNH của LẦN CHẠY HIỆN TẠI (ghi ra
//   `comp/_screens.json`, bị dọn cùng `comp/` khi re-run — ĐÚNG Ý, vì nó mô
//   tả kết quả sau khi áp overrides lên danh sách máy đoán lần này, không
//   phải nơi ghi sửa đổi của người dùng).
//
// Logic parse/áp overrides (khoan dung lỗi, kèm warnings) sống ở
// apps/daemon/src/screen-overrides.ts — package `contracts` chỉ giữ hình
// dạng dữ liệu dùng chung giữa web/daemon, không phụ thuộc Node fs/daemon
// internals (xem packages/AGENTS.md).

/** Nguồn gốc một màn trong manifest: 'flow' = dr-flow gắn được (mặc định cho
 *  màn không khai origin — xem `apps/daemon/src/screen-overrides.ts`'s
 *  `buildScreensManifest`), 'doc' = quét heading tài liệu (screen-components.ts
 *  hợp nhất), 'agent' = do agent dr-comp tự đề xuất (WP14), 'user' = do
 *  người dùng thêm/sửa qua overrides. */
export type ScreenOrigin = 'flow' | 'doc' | 'agent' | 'user';

export interface ScreensManifestEntry {
  key: string;
  code: string;
  name: string;
  source: string | null;
  origin: ScreenOrigin;
  /** Dòng 1-based nơi máy/người dùng xác định được phần mô tả màn trong
   *  `source` — null khi không tìm thấy section nào. */
  line: number | null;
  hasSection: boolean;
}

export interface ScreensManifest {
  schema_version: 1;
  screens: ScreensManifestEntry[];
}

export interface ScreensOverrideAdd {
  action: 'add';
  /** Trang markdown (relative cwd) người dùng chỉ định màn thuộc về. */
  source: string;
  code: string;
  name: string;
  /** Một dòng nguyên văn trong `source` đánh dấu nơi màn được mô tả — khi có,
   *  daemon dùng nó để tính `line`/section (xem luật anchor ở
   *  `apps/daemon/src/screen-overrides.ts`). Không bắt buộc: thiếu anchor
   *  vẫn thêm được màn, chỉ là không có section. */
  anchorText?: string;
}

export interface ScreensOverrideRename {
  action: 'rename';
  key: string;
  name: string;
}

export interface ScreensOverrideRemove {
  action: 'remove';
  key: string;
}

export type ScreensOverrideEntry = ScreensOverrideAdd | ScreensOverrideRename | ScreensOverrideRemove;

export interface ScreensOverrides {
  schema_version: 1;
  overrides: ScreensOverrideEntry[];
}
