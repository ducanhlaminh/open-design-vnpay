/** Hai lớp annotation được xem tách biệt trong preview tài liệu. */
export type PreviewMode = 'changes' | 'notes';

const NOTE_ID_PREFIX = 'note:';
const NOTE_REF_ID_PREFIX = 'ref:note:';

/**
 * Trả về mode sở hữu một annotation id đã được gắn vào DOM.
 *
 * Change dùng id nguyên bản hoặc `ref:<changeId>:<index>`. Note dùng namespace
 * `note:`; ref của note vì vậy có dạng `ref:note:<noteId>:<index>`.
 */
export function annotationMode(id: string): PreviewMode {
  return id.startsWith(NOTE_ID_PREFIX) || id.startsWith(NOTE_REF_ID_PREFIX)
    ? 'notes'
    : 'changes';
}

/** Cho phép integrator lọc mark, ref và rail item bằng cùng một quy tắc. */
export function belongsToMode(id: string, mode: PreviewMode): boolean {
  return annotationMode(id) === mode;
}

/** Nhãn ngắn, không kèm số lượng. */
export function modeLabel(mode: PreviewMode): string {
  return mode === 'changes' ? 'Thay đổi' : 'Nhận xét';
}

/** Nhãn đầy đủ dùng cho tab và accessible name. */
export function modeCountLabel(mode: PreviewMode, count: number): string {
  return `${modeLabel(mode)} (${count})`;
}
