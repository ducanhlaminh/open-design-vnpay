export interface RedlineNavigationItem {
  id: string;
  anchored: boolean;
  dismissed?: boolean;
}

export type RedlineNavigationDirection = 'previous' | 'next';

/** Giữ nguyên thứ tự rail, chỉ loại item không có anchor hoặc đã dismissed. */
export function getAnchoredNavigationItems<T extends RedlineNavigationItem>(items: readonly T[]): T[] {
  return items.filter((item) => item.anchored && !item.dismissed);
}

/** Tìm id kề bên và wrap ở hai đầu. Nếu current không hợp lệ/chưa chọn,
 *  next bắt đầu từ đầu còn previous bắt đầu từ cuối. */
export function getAdjacentNavigationId<T extends RedlineNavigationItem>(
  items: readonly T[],
  currentId: string | null | undefined,
  direction: RedlineNavigationDirection,
): string | null {
  const anchored = getAnchoredNavigationItems(items);
  if (anchored.length === 0) return null;
  const currentIndex = currentId == null ? -1 : anchored.findIndex((item) => item.id === currentId);
  if (currentIndex < 0) return direction === 'next' ? anchored[0]!.id : anchored[anchored.length - 1]!.id;
  const delta = direction === 'next' ? 1 : -1;
  const nextIndex = (currentIndex + delta + anchored.length) % anchored.length;
  return anchored[nextIndex]!.id;
}

export interface RedlineNavigationPosition {
  /** Vị trí 1-based; null khi current không thuộc tập điều hướng. */
  current: number | null;
  total: number;
}

export function getNavigationPosition<T extends RedlineNavigationItem>(
  items: readonly T[],
  currentId: string | null | undefined,
): RedlineNavigationPosition {
  const anchored = getAnchoredNavigationItems(items);
  const index = currentId == null ? -1 : anchored.findIndex((item) => item.id === currentId);
  return { current: index < 0 ? null : index + 1, total: anchored.length };
}
