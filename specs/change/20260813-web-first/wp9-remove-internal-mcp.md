# WP9 — Gỡ 2 MCP server nội bộ + OD-as-MCP-server

Ước lượng: 1 ngày. Phụ thuộc: **chạy SAU WP8** (cả hai đụng `server.ts`, tránh 2 agent cùng sửa 1 file lớn cùng lúc). Không chạy song song với WP3/WP10 (cũng đụng `server.ts`).

Vùng sở hữu:
- `apps/daemon/src/mcp-live-artifacts-server.ts`, `mcp-overview-server.ts` (xoá).
- `apps/daemon/src/runtimes/mcp.ts` (xoá), `agents.ts` (bỏ re-export liên quan, hiện ở `:17`).
- `apps/daemon/src/cli.ts` (subcommand `od mcp live-artifacts`/`od mcp overview` + bare `od mcp ...` command group phục vụ `mcp.ts`).
- `apps/daemon/src/server.ts` (spawn wiring 2 server nội bộ, ước lượng ~L11788-11800 — verify lại).
- `apps/daemon/src/mcp.ts` (1190 dòng — xoá, **có điều kiện**, xem Thiết kế bước 5).
- `apps/daemon/tests/mcp-spawn.test.ts`, `runtimes/mcp.test.ts`, `mcp-create-artifact.test.ts`, `mcp-extract-refs.test.ts`, `mcp-get-artifact.test.ts`, `mcp-get-file.test.ts`, `mcp-get-project.test.ts`, `mcp-resolve-project.test.ts`, `mcp-write-tools.test.ts`.

## Mục tiêu

Gỡ 2 MCP server nội bộ (`open-design-live-artifacts`, `open-design-overview` — hiện **không skill nào gọi tool của chúng**, xác nhận qua grep `live_artifacts_*`/`connectors_*` trong `skills/` = 0 kết quả, nên dead từ góc nhìn skill dù vẫn được wire vào mọi agent run) và toàn bộ tính năng "Open Design tự làm MCP server cho công cụ ngoài" (`apps/daemon/src/mcp.ts` — cho phép Claude Code/Cursor ở repo khác đọc project OD qua MCP; hướng hoàn toàn khác, không liên quan gì tới việc agent gọi Jira/Confluence).

## Vấn đề (đã xác minh 13/08)

- `mcp-live-artifacts-server.ts`/`mcp-overview-server.ts` mỗi tool đều tự ghi chú "POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools ...`" — bằng chứng chúng được thiết kế để MCP KHÔNG phải đường duy nhất, CLI vẫn làm được y hệt.
- `runtimes/mcp.ts` (38 dòng) build 2 builder này thành entry `mcpServers` cho ACP, gate theo `def.mcpDiscovery === 'mature-acp'`.
- `server.ts` wiring: `mcpServers = buildLiveArtifactsMcpServersForAgent(...)` rồi `.push(...buildOverviewMcpServersForAgent(...))` — **CẢNH BÁO**: biến `mcpServers` này có thể còn được dùng để build `.mcp.json`/Codex TOML cho khung MCP generic (mcp-atlassian/GitHub/Filesystem/...) ở đoạn code gần đó (~L11574-11962 theo investigation) — PHẢI đọc kỹ trước khi xoá, chỉ bỏ đúng 2 dòng build/push của live-artifacts/overview, không được xoá nhầm phần phục vụ khung generic MCP (đó là "Ngoài phạm vi" của cả WP8 lẫn WP9).
- `apps/daemon/src/mcp.ts` (OD-as-server) là surface **hoàn toàn tách biệt** khỏi khung MCP generic (`mcp-config.ts`) và khỏi 2 server nội bộ — nó có `cli.ts` bare command riêng (~L1344-1408) và test riêng (`mcp-create-artifact.test.ts` v.v.).
- **Điểm mơ hồ quan trọng phát hiện lúc viết spec này**: `apps/daemon/src/mcp-oauth.ts`, `mcp-tokens.ts`, `mcp-install-info.ts` — tên file gợi ý phục vụ khung MCP generic (OAuth cho user tự thêm MCP server ngoài, thuộc WP8 "không đụng"), NHƯNG một phần test liên quan (`mcp-oauth.test.ts`, `mcp-install-info.test.ts`, `mcp-tokens.test.ts`) lại được nhóm cùng các test của `mcp.ts` (OD-as-server) trong lần rà investigation ban đầu — **CHƯA XÁC ĐỊNH ĐƯỢC CHẮC CHẮN 2 nhóm này độc lập hay có phần chung**. TUYỆT ĐỐI không xoá 3 file `mcp-oauth.ts`/`mcp-tokens.ts`/`mcp-install-info.ts` chỉ vì tên giống — phải đọc import graph thực tế (ai import chúng: `mcp-routes.ts` hay `mcp.ts` hay cả hai) trước khi quyết định giữ/xoá/tách.

## Thiết kế

1. Xoá `apps/daemon/src/mcp-live-artifacts-server.ts`, `mcp-overview-server.ts`.
2. Xoá `apps/daemon/src/runtimes/mcp.ts`; bỏ re-export liên quan ở `agents.ts:17`.
3. `server.ts` — đọc kỹ đoạn wiring `.mcp.json`/Codex TOML/OpenCode env (~L11574-11962) trước khi sửa; chỉ xoá 2 dòng gán/push từ `buildLiveArtifactsMcpServersForAgent`/`buildOverviewMcpServersForAgent`; nếu biến `mcpServers` khởi tạo rỗng thì giữ nguyên phần build tiếp theo cho khung generic (mcp-atlassian đã bị WP8 gỡ khỏi seed, nhưng user vẫn có thể tự thêm MCP server khác qua Settings — đường build `.mcp.json` từ danh sách server generic PHẢI còn hoạt động).
4. `cli.ts` — xoá subcommand `od mcp live-artifacts` (~L748-757), `od mcp overview` (~L759-768), dòng help text liên quan (~L829-833).
5. **Trước khi xoá `apps/daemon/src/mcp.ts`**: đọc toàn bộ import của `mcp-oauth.ts`/`mcp-tokens.ts`/`mcp-install-info.ts` (ai import file nào — `mcp.ts` hay `mcp-routes.ts`/`mcp-config.ts`/`server.ts` phần khung generic). Kết luận rõ ràng 1 trong 3 trường hợp và làm đúng trường hợp đó:
   - (a) 3 file này CHỈ phục vụ `mcp.ts` → xoá cùng `mcp.ts`.
   - (b) 3 file này CHỈ phục vụ khung generic → GIỮ NGUYÊN, không đụng (thuộc "Ngoài phạm vi" của WP8).
   - (c) Có phần dùng chung (vd cùng 1 hàm OAuth token refresh được cả 2 phía gọi) → tách phần `mcp.ts`-only ra, giữ phần dùng chung — **ghi rõ quyết định + bằng chứng import graph trong report**, đây không phải quyết định được phép đoán.
   - Sau khi quyết định, xoá `apps/daemon/src/mcp.ts`; xoá bare `od mcp ...` command group trong `cli.ts` (~L1344-1408).
6. Web: `apps/web/src/components/KgToolCards.tsx`, `apps/web/src/runtime/register-kg-renderers.ts` — investigation cho thấy đây là renderer cho `sm-mcp` "Knowledge Graph MCP server" và **không tìm thấy wiring phía daemon cho `sm-mcp` ở đâu** (có vẻ dead code, hoặc thuộc phạm vi WP10 nhiều hơn vì tên gắn "Kg"). Đọc lại lúc thực thi: nếu đây thực sự chỉ liên quan `sm-mcp`/KGS thì **để WP10 xử lý, không đụng ở WP9**; chỉ xử lý ở đây nếu xác nhận nó cũng render cho `open-design-live-artifacts`/`open-design-overview`.

## Tests

Xoá/cập nhật toàn bộ test liệt kê ở "Vùng sở hữu". Test nào chỉ test khung generic MCP (không phải 2 server nội bộ/`mcp.ts`) — vd `McpClientSection.oauth.test.tsx`, `McpJsonHelper.test.tsx`, phần `mcp-config.test.ts` không liên quan `mcp-atlassian` — **không được đụng**, phải verify chúng vẫn xanh sau khi xoá.

## Ngoài phạm vi

- `mcp-atlassian` — WP8.
- Khung MCP generic (`mcp-routes.ts`, `McpClientSection.tsx`, `MCP_TEMPLATES`, `McpServerConfig` type, và `mcp-oauth.ts`/`mcp-tokens.ts`/`mcp-install-info.ts` **trừ khi** bước 5 xác nhận chúng chỉ phục vụ `mcp.ts`).
- KGS — WP10 (kể cả nếu `KgToolCards.tsx`/`register-kg-renderers.ts` hoá ra thuộc về đây, ưu tiên để WP10 xử lý nếu không chắc).

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` xanh; test liên quan xanh; không tăng đỏ baseline.
2. Grep chứng minh: không còn reference nào tới `open-design-live-artifacts`/`open-design-overview`/`apps/daemon/src/mcp.ts` trong code thực thi (xoá sạch, không phải comment-out).
3. Test/verify chứng minh: khung MCP generic (build `.mcp.json` từ server user tự thêm qua Settings) vẫn hoạt động đúng sau khi bỏ 2 dòng wiring server nội bộ.
4. Report ghi rõ: kết luận cuối cùng (a)/(b)/(c) về `mcp-oauth.ts`/`mcp-tokens.ts`/`mcp-install-info.ts` kèm bằng chứng import graph; và quyết định `KgToolCards.tsx`/`register-kg-renderers.ts` xử lý ở WP9 hay để dành WP10.
