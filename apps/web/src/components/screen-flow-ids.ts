// screen-flow-ids — id luồng màn hình (dr-flow) + nền tảng (WP
// screen-flow-platform-split, 2026-08-28). Cùng hợp đồng với daemon
// `flow-ux/screen-flow-xml.ts`:
//   - tài liệu MỘT nền tảng → một flow `SCREEN-FLOW` (như trước);
//   - tài liệu ≥2 nền tảng → hai flow `SCREEN-FLOW--app` + `SCREEN-FLOW--web`,
//     mỗi thư mục `flows/<id>/` tự đủ.
// Web KHÔNG suy nền tảng từ nội dung — chỉ đọc từ id thư mục (agent quyết).

export const SCREEN_FLOW_ID = 'SCREEN-FLOW';
export const SCREEN_FLOW_ID_RE = /^SCREEN-FLOW(--(app|web))?$/;

export type ScreenFlowPlatform = 'app' | 'web';

/** `SCREEN-FLOW`, `SCREEN-FLOW--app`, `SCREEN-FLOW--web` → true. */
export function isScreenFlowId(id: string | null | undefined): boolean {
  return typeof id === 'string' && SCREEN_FLOW_ID_RE.test(id);
}

/** Nền tảng ghi trong id (`--app`/`--web`); flow đơn hoặc id lạ → `null`. */
export function screenFlowPlatformOf(id: string | null | undefined): ScreenFlowPlatform | null {
  if (typeof id !== 'string') return null;
  const m = SCREEN_FLOW_ID_RE.exec(id);
  return (m?.[2] as ScreenFlowPlatform | undefined) ?? null;
}

/** Id thư mục cho nền tảng; `null`/undefined → flow đơn `SCREEN-FLOW`. */
export function screenFlowIdFor(platform: ScreenFlowPlatform | null | undefined): string {
  return platform ? `${SCREEN_FLOW_ID}--${platform}` : SCREEN_FLOW_ID;
}

/** Nhãn hiển thị "App"/"Web" cho badge; flow đơn → `null` (không badge). */
export function screenFlowPlatformLabel(id: string | null | undefined): 'App' | 'Web' | null {
  const p = screenFlowPlatformOf(id);
  return p === 'app' ? 'App' : p === 'web' ? 'Web' : null;
}
