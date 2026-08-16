# WP2 — tool routes `/api/tools/figma/*`, `GET /api/figma-desktop/status`, CLI `od tools figma …`, contracts

Đọc `spec.md` cùng thư mục trước. WP1 (`figma-desktop.ts`) chạy song song —
**KHÔNG import** từ `./figma-desktop.js`; khai báo interface tối thiểu
`FigmaDesktopLike` (bên dưới) và nhận instance qua ctx. WP3 sẽ nối client thật.

## Vùng sở hữu
- TẠO `packages/contracts/src/api/figma-desktop.ts` + thêm 1 dòng
  `export * from './api/figma-desktop.js';` vào `packages/contracts/src/index.ts`
  (đặt ngay sau dòng `figma-config.js`).
- SỬA `apps/daemon/src/tool-tokens.ts`: CHỈ thêm 2 hằng export (không đổi gì khác):
  ```ts
  export const FIGMA_TOOL_ENDPOINTS = [
    '/api/tools/figma/design-context',
    '/api/tools/figma/screenshot',
    '/api/tools/figma/variable-defs',
    '/api/tools/figma/metadata',
  ] as const;
  export const FIGMA_TOOL_OPERATIONS = [
    'figma:design-context', 'figma:screenshot', 'figma:variable-defs', 'figma:metadata',
  ] as const;
  ```
- TẠO `apps/daemon/src/figma-desktop-tool-routes.ts`
- TẠO `apps/daemon/src/tools-figma-cli.ts`
- SỬA `apps/daemon/src/cli.ts`: chỉ (a) import `runFigmaToolCli`, (b) thêm nhánh
  `else if (argv[0] === 'tools' && argv[1] === 'figma')` ngay sau nhánh
  `tools design-systems` (grep `argv[1] === 'design-systems'`), giống hệt
  hình dạng nhánh đó, (c) thêm 2 dòng usage ngay dưới khối
  `od tools design-systems read …` trong help text:
  ```
    od tools figma <design-context|screenshot|variable-defs|metadata> --file <fileKey> --node <nodeId> [--json]
        Read one component from the file the App declared, through Figma Desktop (daemon-proxied).
  ```
- TẠO `apps/daemon/tests/figma-desktop-tool-routes.test.ts`, `apps/daemon/tests/tools-figma-cli.test.ts`
- KHÔNG đụng `server.ts`, `figma-desktop.ts`, web.

## Contracts (`packages/contracts/src/api/figma-desktop.ts`)
```ts
export interface FigmaDesktopStatusResponse {
  available: boolean;          // MCP :3845 trả lời initialize
  detail?: string;             // lý do VN khi không available
  activeFileTitle?: string | null;
  canSwitch: boolean;          // platform darwin|win32
  platform: string;
}
export type FigmaDesktopToolName = 'design-context' | 'screenshot' | 'variable-defs' | 'metadata';
export interface FigmaDesktopToolRequest {
  fileKey: string;
  nodeId: string;              // "10:1" hoặc "10-1"
  clientLanguages?: string;    // design-context/variable-defs/metadata; default 'unknown'
  clientFrameworks?: string;
}
export interface FigmaDesktopTextToolResponse {
  ok: true; tool: FigmaDesktopToolName; fileKey: string; nodeId: string;
  switched: 'already' | 'switched'; cached: boolean; text: string;
}
export interface FigmaDesktopScreenshotResponse {
  ok: true; tool: 'screenshot'; fileKey: string; nodeId: string;
  switched: 'already' | 'switched'; cached: boolean;
  path: string;                // tương đối cwd, vd ".figma-catalog/shots/<fileKey>/10-1.png"
  mimeType: string;
}
```

## Routes (`figma-desktop-tool-routes.ts`)
```ts
export interface FigmaDesktopLike {
  probe(): Promise<{ ok: boolean; detail?: string; tools?: string[] }>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; images: Array<{ mimeType: string; data: string }> }>;
  activeFileTitle(): Promise<string | null>;
  ensureActiveFile(expect: { fileKey: string; name?: string; probeNodeId?: string; probeName?: string }, timeoutMs?: number): Promise<'already' | 'switched'>;
}
/** WP3 cung cấp: phạm vi Figma của project (từ App.docsReviewComponentSource + catalog đã đọc). null = project không dùng figma-links. */
export interface FigmaDesktopScope {
  cwd: string;                                             // thư mục workflow của run (nơi có .figma-catalog/)
  files: Array<{ fileKey: string; name?: string; probeNodeId?: string; probeName?: string }>;
}
export interface RegisterFigmaDesktopToolRoutesDeps {
  auth: { authorizeToolRequest: (req: Request, res: Response, operation: string) => ToolTokenGrant | null };
  http: { sendApiError: (res, status, code, message, extras?) => void; isLocalSameOrigin: (req, port) => boolean; resolvedPortRef: { current: number } };
  figma: { desktop: FigmaDesktopLike; resolveScope: (projectId: string) => Promise<FigmaDesktopScope | null>; platform?: NodeJS.Platform; now?: () => number };
}
export function registerFigmaDesktopToolRoutes(app: Express, ctx: RegisterFigmaDesktopToolRoutesDeps): void;
/** export để test: */
export function normalizeNodeId(raw: unknown): string | null;   // "10-1"→"10:1"; hợp lệ /^\d+:\d+$/ (cho phép "I…" instance id: /^[0-9I:;-]+$/ sau normalize) ; else null
```
Kiểu lỗi mượn từ WP1 theo **duck typing**: `err && typeof err === 'object' && 'kind' in err` với `kind` ∈
`unavailable|switch_timeout|switch_unsupported|tool_error|protocol`; message dùng thẳng `err.message`.

**`GET /api/figma-desktop/status`** — same-origin guard như `figma-config-routes.ts`
(`isLocalSameOrigin(req, resolvedPortRef.current)` → 403). Trả `FigmaDesktopStatusResponse`
= `probe()` + `activeFileTitle()` (chỉ gọi khi available) + `canSwitch = platform ∈ {darwin, win32}`.

**`POST /api/tools/figma/:tool`** (4 route riêng, không param động, để khớp `allowedEndpoints`):
1. `grant = authorizeToolRequest(req,res,'figma:<tool>')`; null → đã trả lỗi.
2. body: `fileKey` string khớp `/^[A-Za-z0-9]+$/`, `nodeId` qua `normalizeNodeId`; sai → 400 `INVALID_INPUT`.
3. `scope = await resolveScope(grant.projectId)`; null → 404 `FIGMA_SCOPE_NOT_FOUND`
   ("Dự án này không cấu hình nguồn Link Figma."); `fileKey ∉ scope.files` → 403 `FIGMA_FILE_DENIED`
   ("File <key> không nằm trong danh sách link Figma của App — chỉ được đọc: <keys>.").
4. Cache: key `${tool}|${fileKey}|${nodeId}|${clientLanguages}|${clientFrameworks}`; hit (TTL 30 phút, tối đa 300 mục, xoá cũ nhất) → trả `cached:true`, `switched:'already'`, KHÔNG gọi desktop. Screenshot: hit = file đích tồn tại.
5. **Mutex toàn cục** (module-level promise chain) bao trọn bước 6–7 — Figma Desktop chỉ có 1 file active nên mọi call tuần tự.
6. `switched = await desktop.ensureActiveFile(scope.files[k])`.
7. Gọi tool:
   - design-context → `callTool('get_design_context', {nodeId, clientLanguages, clientFrameworks})`
   - variable-defs → `get_variable_defs` (cùng args)
   - metadata → `get_metadata` (cùng args)
   - screenshot → `get_screenshot` `{nodeId}`; lấy `images[0]`; không có ảnh → 502 `FIGMA_TOOL_ERROR` "Figma không trả ảnh"; ghi file
     `<cwd>/.figma-catalog/shots/<fileKey>/<nodeId với ':'→'-'>.png` (mkdir -p; mimeType từ ảnh, đuôi theo mimeType: png/jpeg/webp), trả `path` tương đối.
8. Map lỗi: kind `unavailable` → 503 `FIGMA_DESKTOP_UNAVAILABLE`; `switch_timeout` → 504 `FIGMA_SWITCH_TIMEOUT`;
   `switch_unsupported` → 501 `FIGMA_SWITCH_UNSUPPORTED`; `tool_error` → 502 `FIGMA_TOOL_ERROR`; `protocol`/khác → 502 `FIGMA_PROXY_ERROR`. `message` = `err.message`.
9. Audit (LUÔN, kể cả lỗi/cache): append 1 dòng JSONL vào `<cwd>/.figma-catalog/desktop-audit.jsonl`
   `{ts: ISO(now), runId: grant.runId, projectId, tool, fileKey, nodeId, switched?, cached, ms, ok, error?: {code, message}}`
   (best-effort, lỗi ghi file chỉ `console.warn`). Kèm `console.info('[figma-desktop] <tool> <fileKey>#<nodeId> <ok|code> <ms>ms')`.

## CLI (`tools-figma-cli.ts`) — mirror `tools-design-systems-cli.ts`
- `export const FIGMA_TOOLS_USAGE` (theo mẫu DESIGN_SYSTEMS_USAGE, liệt kê 4 lệnh, env, ví dụ
  `"$OD_NODE_BIN" "$OD_BIN" tools figma design-context --file kvQYEli6ij2mZ65mSywnFp --node 10:1`).
- `export async function runFigmaToolCli(args: string[]): Promise<{ exitCode: number }>`.
- Lệnh: `design-context|screenshot|variable-defs|metadata`; flags `--file <key>` (bắt buộc), `--node <id>` (bắt buộc),
  `--languages <csv>`, `--frameworks <csv>`, `--json`, `-h/--help`.
- Không `--json`: text tools in **thẳng `text`** ra stdout (để agent đọc trực tiếp); screenshot in `path`.
  `--json`: in nguyên body JSON. Lỗi: stderr `{ok:false,status?,error:{code?,message,details?}}`, exit 1.
- Copy các helper `daemonUrl/toolToken/endpoint/requestJson/normalizeCliError` (không import chéo từ file design-systems để tránh đụng chủ sở hữu khác).

## Test
`figma-desktop-tool-routes.test.ts` (fake `app` gom handler theo `METHOD path`, fake `res`, fake desktop ghi lại calls, `resolveScope` giả, cwd = mkdtemp):
1. status: probe ok + title → `{available:true, activeFileTitle, canSwitch:true, platform:'darwin'}`; probe fail → `available:false, detail`; cross-origin → 403.
2. design-context: grant ok, fileKey trong scope → gọi `ensureActiveFile` với đúng entry (name/probeNodeId), rồi `callTool('get_design_context', {nodeId:'10:1', clientLanguages:'unknown', clientFrameworks:'unknown'})`; body `{ok:true, tool:'design-context', switched:'switched', cached:false, text}`; audit file có 1 dòng JSON hợp lệ với `ok:true`.
3. lần 2 cùng key → `cached:true`, desktop KHÔNG bị gọi thêm; audit thêm 1 dòng `cached:true`.
4. fileKey ngoài scope → 403 `FIGMA_FILE_DENIED`, desktop không bị gọi, audit có dòng `ok:false`. scope null → 404. nodeId "abc" → 400. `authorizeToolRequest` trả null → handler return, không ghi gì.
5. desktop ném `{kind:'unavailable'}` → 503 `FIGMA_DESKTOP_UNAVAILABLE`; `{kind:'switch_timeout'}` → 504.
6. screenshot: images[0] png → file `.figma-catalog/shots/K/10-1.png` tồn tại đúng bytes base64 → body `path` tương đối; gọi lại → `cached:true`.
7. mutex: 2 request đồng thời, desktop.ensureActiveFile của call 2 chỉ bắt đầu sau khi call 1 xong (dùng deferred promise để kiểm thứ tự).
8. `normalizeNodeId('10-1')==='10:1'`, `('10:1')`, `('I10:1;20:2')` giữ nguyên, `('x')===null`, `('')===null`.

`tools-figma-cli.test.ts`: stub `fetch` + env `OD_DAEMON_URL/OD_TOOL_TOKEN`; kiểm URL, header Bearer, body JSON; không --json in text; --json in JSON; thiếu --file → exit 1 + stderr JSON; `--help` in usage.

## Verify
```
pnpm --filter @open-design/contracts build
cd apps/daemon && npx vitest run tests/figma-desktop-tool-routes.test.ts tests/tools-figma-cli.test.ts && pnpm --filter @open-design/daemon typecheck
```
