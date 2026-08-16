# Figma Desktop drill-down cho dr-comp — kế hoạch tổng (4 work package)

## Bối cảnh (đã chốt với chủ repo, 2026-08-16)

Bước dr-comp (docs-review · Màn hình → Component) với nguồn `figma-links` hiện có
**bước 1**: daemon đọc catalog component qua Figma REST + PAT
(`apps/daemon/src/figma-rest.ts`, commit `7a6b66f`) → `criteria/components.md`
+ `.figma-catalog/components.json` (mỗi file: `fileKey`, `name`, `url`,
`components[].{nodeId,name,page,description,properties}`).

Cần thêm **bước 2**: lúc chạy pipeline, agent dựa theo catalog **tự mở 1
component** và lấy *design context* (layout/màu/chữ/variants/ảnh) để phán "có
hợp để dùng không". Nguồn design context = **Figma Desktop Dev Mode MCP server**
tại `http://127.0.0.1:3845/mcp` (chủ repo KHÔNG muốn remote `mcp.figma.com`).

Sự thật đã probe trên máy chủ repo (macOS, Figma 126.x):
- MCP :3845 trả lời không cần token; tools: `get_design_context`,
  `get_metadata`, `get_variable_defs`, `get_screenshot`, `get_motion_context`,
  `get_figjam` — **tất cả chỉ nhận `nodeId`, không có `fileKey`**; đọc **file
  đang active** trong Figma Desktop.
- Streamable HTTP: `POST /mcp` `initialize` → header `mcp-session-id`; các call
  sau phải kèm header đó + `Accept: application/json, text/event-stream`;
  response là SSE (`event: message` / `data: {json}`).
- `open "figma://file/<fileKey>"` (macOS) làm Figma Desktop **chuyển sang đúng
  file** trong ≤3 s (đã test qua lại 2 file thật); MCP lập tức đọc file mới.
- Tên cửa sổ Figma đọc được từ ngoài: `osascript -e 'tell application "System
  Events" to get name of every window of process "Figma"'` → đúng tên file đang
  active (vd `[Lib v1.0 - MB Component] NAB OMNI SME`). `get_metadata` KHÔNG
  trả fileKey/tên file.

Yêu cầu bảo mật (lý do chọn kiến trúc): agent **chỉ được đọc đúng các file đã
khai trong App** (`docsReviewComponentSource.links`), không cầm token, mọi
truy cập Figma đi qua daemon và có audit.

## Kiến trúc chốt: dùng khuôn "runtime tools" sẵn có, KHÔNG dựng MCP server mới

Repo đã có: `apps/daemon/src/tool-tokens.ts` (token theo run, `allowedEndpoints`
/ `allowedOperations`), `authorizeToolRequest(req,res,operation)` (xem
`apps/daemon/src/design-system-tool-routes.ts` làm mẫu), wrapper CLI
`od tools <cap> …` (`apps/daemon/src/tools-design-systems-cli.ts`, dispatch ở
`apps/daemon/src/cli.ts` khoảng dòng 580 — grep `argv[1] === 'design-systems'`),
env `OD_DAEMON_URL`/`OD_TOOL_TOKEN`/`OD_NODE_BIN`/`OD_BIN` bơm vào run, và
sandbox rewrite `localhost → host.docker.internal` (`agent-sandbox.ts`
`rewriteUrlForContainer`).

```
agent (sandbox) ── "$OD_NODE_BIN" "$OD_BIN" tools figma design-context --file K --node N
   └─► POST /api/tools/figma/design-context  (Bearer OD_TOOL_TOKEN)
          daemon:
            1. authorizeToolRequest → grant{projectId}
            2. allow-list: K ∈ links của App gắn với project → không thì 403 FIGMA_FILE_DENIED
            3. mutex toàn cục (Figma Desktop chỉ có 1 file active)
            4. ensureActiveFile(K): nếu chưa đúng → `open figma://file/K` → poll ≤20 s
               (gate: tên cửa sổ == tên file trong catalog; fallback nodeId probe)
            5. cache (K,N,tool) → forward tools/call tới 127.0.0.1:3845
            6. audit JSONL vào cwd/.figma-catalog/desktop-audit.jsonl
```

Fail-soft: Figma Desktop không chạy / không cùng máy → dr-comp vẫn chạy như
hiện tại (chỉ catalog), kickoff nói rõ cho agent; tool trả lỗi có mã rõ ràng.

## Phân rã

| WP | Nội dung | File sở hữu | Chạy |
|---|---|---|---|
| WP1 | Client Figma Desktop MCP + chuyển file + gate (module thuần, inject deps) | `apps/daemon/src/figma-desktop.ts`, `apps/daemon/tests/figma-desktop.test.ts` | song song |
| WP2 | Tool routes `/api/tools/figma/*` + `GET /api/figma-desktop/status` + CLI `od tools figma …` + hằng tool-token + contracts | `apps/daemon/src/figma-desktop-tool-routes.ts`, `apps/daemon/src/tools-figma-cli.ts`, `apps/daemon/src/cli.ts` (chỉ thêm dispatch), `apps/daemon/src/tool-tokens.ts` (chỉ thêm hằng), `packages/contracts/src/api/figma-desktop.ts` (+ export ở `index.ts`), tests | song song |
| WP4 | Web: dòng trạng thái Figma Desktop trong `FigmaLinksPanel` | `apps/web/src/state/figma-config.ts`, `apps/web/src/components/pipelines/FigmaLinksPanel.tsx` (+css), test | song song |
| WP3 | Nối vào `server.ts` (register routes, resolver allow-list, grant mở rộng cho run dr-comp, pre-warm + kickoff) + skill `skills/docs-component-audit/SKILL.md` | `apps/daemon/src/server.ts`, `skills/docs-component-audit/SKILL.md` | SAU WP1+WP2 (orchestrator tự làm) |

Giao diện giữa các WP được cố định trong từng sub-spec (`wp1-*.md`, `wp2-*.md`,
`wp4-*.md`); sub-agent KHÔNG được đổi tên/chữ ký đã ghi trong spec — nếu thấy
bắt buộc phải đổi, ghi rõ trong report, không tự ý sửa spec của WP khác.

## Quy tắc chung cho mọi WP

- Chỉ sửa file trong "Vùng sở hữu" của WP mình. Không `git add`/commit.
- TypeScript strict + `exactOptionalPropertyTypes` (không gán `undefined` vào
  optional field — dùng spread có điều kiện).
- Contracts đổi thì phải `pnpm --filter @open-design/contracts build` trước
  khi typecheck daemon/web.
- Verify tối thiểu: `pnpm --filter @open-design/daemon typecheck` (WP1/2),
  `pnpm --filter @open-design/web typecheck` (WP4), và **chỉ chạy các file
  test của mình** (`npx vitest run tests/<file>` trong `apps/daemon` hoặc
  `apps/web`). Full suite có test đỏ sẵn từ baseline (bas-client,
  diagnostics-export, origin-validation ở daemon; McpClientSection.oauth ở
  web) — không phải việc của WP này, đừng cố sửa.
- Thông điệp cho người dùng bằng tiếng Việt, code/comment tiếng Anh hoặc Việt
  đều được, giữ style file lân cận.
- Report cuối: danh sách file đã tạo/sửa, lệnh verify + kết quả, điểm lệch
  spec (nếu có).
