// Tên người dùng hiện tại cho field `by` của bình luận annotation dr-review
// (DocAnnotationComment.by — web ghi thẳng vào sidecar nên phải tự điền, khác
// bình luận cấp bước do daemon điền). Đọc `/api/auth/me` MỘT lần rồi nhớ;
// auth tắt / daemon không trả user → undefined (comment không có `by`, như
// trước 0.8.164).
import type { AuthMeResponse } from '@open-design/contracts';

let cached: Promise<string | undefined> | null = null;

export function getCurrentUserName(): Promise<string | undefined> {
  if (!cached) {
    cached = (async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (!response.ok) return undefined;
        const body = (await response.json().catch(() => null)) as Partial<AuthMeResponse> | null;
        const name = body?.user?.name?.trim();
        return name || body?.user?.email || undefined;
      } catch {
        // Không nhớ lỗi mạng — lần sau thử lại.
        cached = null;
        return undefined;
      }
    })();
  }
  return cached;
}

/** Test-only: xoá cache để mock lại `/api/auth/me`. */
export function resetCurrentUserCache(): void {
  cached = null;
}
