# WP1 — `apps/daemon/src/figma-desktop.ts`: client Figma Desktop MCP + chuyển file + gate

Đọc `spec.md` cùng thư mục trước (bối cảnh + sự thật đã probe).

## Vùng sở hữu
- TẠO `apps/daemon/src/figma-desktop.ts`
- TẠO `apps/daemon/tests/figma-desktop.test.ts`
- KHÔNG đụng file khác. Không thêm dependency npm (dùng `fetch` toàn cục của
  Node 24, `node:child_process`, `node:os`). Không dùng `@modelcontextprotocol/sdk`
  client (session Streamable HTTP tự tay ~60 dòng, dễ test hơn).

## API bắt buộc (WP2/WP3 import đúng tên này)

```ts
export const FIGMA_DESKTOP_MCP_URL = 'http://127.0.0.1:3845/mcp';
export const FIGMA_DESKTOP_SWITCH_TIMEOUT_MS = 20_000;

export type FigmaDesktopErrorKind =
  | 'unavailable'      // ECONNREFUSED / timeout khi initialize → Figma Desktop chưa chạy hoặc chưa bật MCP
  | 'switch_timeout'   // đã open figma:// nhưng quá timeout vẫn không thấy đúng file
  | 'switch_unsupported' // không có cách chuyển file trên platform này (không phải darwin/win32)
  | 'tool_error'       // MCP trả isError=true (vd nodeId không tồn tại trong file đang mở)
  | 'protocol';        // response không parse được / thiếu session

export class FigmaDesktopError extends Error {
  readonly kind: FigmaDesktopErrorKind;
  constructor(kind: FigmaDesktopErrorKind, message: string);
}

/** Thông điệp tiếng Việt cho từng kind — WP2 dùng để trả về agent/UI. */
export function describeFigmaDesktopError(err: unknown): string;

export interface FigmaDesktopDeps {
  fetch?: typeof fetch;
  baseUrl?: string;                     // default FIGMA_DESKTOP_MCP_URL
  requestTimeoutMs?: number;            // default 30_000 cho tools/call, 3_000 cho probe/initialize
  /** chạy lệnh ngoài (open/osascript/cmd). Default: child_process.execFile promisified. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  platform?: NodeJS.Platform;           // default process.platform
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FigmaDesktopToolResult {
  text: string;                         // ghép mọi content[].type==='text' bằng '\n'
  images: Array<{ mimeType: string; data: string }>; // content[].type==='image' (base64)
}

export interface FigmaDesktopFileExpectation {
  fileKey: string;
  name?: string;        // tên file (từ catalog REST) — gate chính bằng tên cửa sổ
  probeNodeId?: string; // nodeId có thật trong file (vd component đầu tiên của catalog)
  probeName?: string;   // tên node đó — gate phụ khi không đọc được tên cửa sổ
}

export class FigmaDesktopClient {
  constructor(deps?: FigmaDesktopDeps);
  /** initialize (+ notifications/initialized) + tools/list. Không ném; ok=false kèm detail VN. */
  probe(): Promise<{ ok: boolean; detail?: string; tools?: string[] }>;
  /** tools/call. Tự initialize khi chưa có session; nếu server trả 404/400 "session" thì
   *  re-initialize đúng 1 lần rồi gọi lại. Ném FigmaDesktopError. */
  callTool(name: string, args: Record<string, unknown>): Promise<FigmaDesktopToolResult>;
  /** Tên cửa sổ Figma đang active. darwin: osascript System Events (lấy phần tử đầu);
   *  win32: `powershell -NoProfile -Command "(Get-Process Figma | ? MainWindowTitle | select -First 1).MainWindowTitle"`;
   *  khác / lỗi / không có quyền → null (KHÔNG ném). */
  activeFileTitle(): Promise<string | null>;
  /** Đảm bảo Figma Desktop đang active đúng file. Trả 'already' | 'switched'.
   *  Ném FigmaDesktopError('switch_timeout' | 'switch_unsupported' | 'unavailable'). */
  ensureActiveFile(expect: FigmaDesktopFileExpectation, timeoutMs?: number): Promise<'already' | 'switched'>;
}

/** So khớp tên cửa sổ với tên file: trim, bỏ khoảng trắng thừa, so sánh không phân biệt hoa thường;
 *  cửa sổ có thể có hậu tố/ tiền tố (vd " – Figma") nên dùng includes hai chiều. */
export function windowTitleMatchesFile(title: string | null | undefined, name: string | null | undefined): boolean;
```

## Hành vi chi tiết

**Session Streamable HTTP**
- `initialize`: `POST baseUrl` body
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"open-design","version":"1"}}}`
  headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`.
  Lấy `mcp-session-id` từ response header. Sau đó gửi
  `{"jsonrpc":"2.0","method":"notifications/initialized"}` (bỏ qua kết quả).
- Mọi request sau kèm `mcp-session-id`. Response có thể là JSON thuần hoặc SSE
  (`text/event-stream`): parse các dòng `data: {...}`; lấy object có `id`
  khớp; nếu có `error` → `FigmaDesktopError('protocol', error.message)`.
- `tools/call` result: `{ content: [{type:'text',text}|{type:'image',data,mimeType}], isError? }`.
  `isError` → `FigmaDesktopError('tool_error', <text đầu tiên hoặc 'Figma trả lỗi'>)`.
- Lỗi mạng (`ECONNREFUSED`, AbortError timeout) ở initialize/probe →
  `unavailable`. Ở tools/call sau khi đã có session: cũng map thành `unavailable`.

**ensureActiveFile(expect, timeoutMs = FIGMA_DESKTOP_SWITCH_TIMEOUT_MS)**
1. `isActive()`:
   - nếu có `expect.name` và `activeFileTitle()` trả chuỗi → kết quả =
     `windowTitleMatchesFile(title, name)` (quyết định luôn, không probe thêm).
   - ngược lại nếu có `probeNodeId`: `callTool('get_metadata',{nodeId: probeNodeId, clientLanguages:'unknown', clientFrameworks:'unknown'})`;
     `tool_error` → false; thành công → true nếu không có `probeName`, hoặc
     nếu text chứa `name="<probeName>"` (so sánh sau khi unescape `&quot;` tối thiểu; đơn giản là includes).
   - không có cả hai → coi là **không biết** → sau khi open, chờ 3 s rồi trả 'switched' (best-effort).
2. Nếu `isActive()` → 'already'.
3. Chuyển file: darwin `exec('open', ['figma://file/'+fileKey])`; win32
   `exec('cmd', ['/c','start','','figma://file/'+fileKey])`; platform khác →
   `switch_unsupported`.
4. Poll `isActive()` mỗi 1 000 ms (dùng `sleep`) tới `timeoutMs`; đạt → 'switched'; hết giờ → `switch_timeout`
   với message nêu tên file mong đợi và tên cửa sổ đang thấy (nếu có).

**describeFigmaDesktopError**: 
- unavailable → `Figma Desktop chưa chạy hoặc chưa bật Dev Mode MCP server (Figma → Preferences → Enable Dev Mode MCP server).`
- switch_timeout → message của lỗi (đã VN).
- switch_unsupported → `Không tự chuyển file Figma được trên hệ điều hành này — hãy mở file trong Figma Desktop rồi thử lại.`
- tool_error / protocol → message; lỗi khác → `String(err.message ?? err)`.

## Test (`apps/daemon/tests/figma-desktop.test.ts`, vitest, fake `fetch`/`exec`/`sleep`)
1. probe ok: initialize trả header session + tools/list → `{ok:true, tools:[...]}`; ECONNREFUSED → `{ok:false, detail:/Figma Desktop chưa chạy/}`.
2. callTool: gửi đúng header `mcp-session-id`, parse SSE `data:` lines, gom text + image; `isError` → FigmaDesktopError kind `tool_error`.
3. callTool re-initialize đúng 1 lần khi server trả 404 cho session cũ.
4. ensureActiveFile: title khớp → 'already' không exec; title lệch → exec `open figma://file/K`, sau 2 lần poll title khớp → 'switched', sleeps = [1000,1000]; không bao giờ khớp → `switch_timeout` với `now` giả tăng dần.
5. ensureActiveFile fallback nodeId khi `activeFileTitle` trả null: get_metadata isError → chưa active; sau switch trả `<component id="10:1" name="Button" …/>` khớp probeName → 'switched'.
6. platform 'linux' → `switch_unsupported`.
7. `windowTitleMatchesFile`: `('[Lib v1.0 - MB Component] NAB OMNI SME – Figma','[Lib v1.0 - MB Component] NAB OMNI SME')` → true; hoa/thường; null → false.

## Verify
```
cd apps/daemon && npx vitest run tests/figma-desktop.test.ts && pnpm --filter @open-design/daemon typecheck
```
