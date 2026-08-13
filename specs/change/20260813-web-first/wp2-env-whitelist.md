# WP2 — Whitelist env tại seam spawn host

Ước lượng: 0.5–1 ngày. Phụ thuộc: WP0. Vùng sở hữu: `server.ts` (seam env), `runtimes/env.ts`, `agent-sandbox.ts` (chỉ đọc/tái dùng whitelist). **WP3 chờ WP2 xong mới đụng server.ts.**

## Vấn đề (đã xác minh 13/08)

Docker sandbox chỉ forward 3-4 biến vào container (`agent-sandbox.ts` ~L82 claude: `OD_TOOL_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`; ~L93 codex). Host spawn thì `createAgentRuntimeEnv` (`server.ts` ~L1708) **spread toàn bộ `process.env`** — nghĩa là `KGS_API_KEY`, `MEDIA_*` creds, `OD_ATLASSIAN_*` PAT, `CONFLUENCE_PERSONAL_TOKEN`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` lọt hết vào process agent. Đây là lỗ hổng rõ nhất và PHẢI đóng trước khi WP4 bật host mặc định.

## Thiết kế

Whitelist **allowlist theo tên + prefix**, áp tại seam spawn host (đường sandbox giữ nguyên — nó đã có whitelist riêng).

1. Tạo module mới `apps/daemon/src/runtimes/host-env.ts`:
   - `buildHostAgentEnv(base: NodeJS.ProcessEnv, opts): NodeJS.ProcessEnv`.
   - Cho qua (danh sách khởi điểm — RÀ LẠI bằng cách đọc kỹ những gì runtime cần trước khi chốt):
     - Hệ thống để process sống được: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TERM`, `LANG`, `LC_*` (prefix), `TZ`, `XDG_*` (prefix, Linux).
     - Node/toolchain: `NODE_OPTIONS` KHÔNG cho qua (vector injection) — ghi comment; `OD_NODE_BIN` cho qua.
     - Agent: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (giữ nguyên logic hiện có của `spawnEnvForAgent` `runtimes/env.ts` ~L31: strip `ANTHROPIC_API_KEY` khi không có `ANTHROPIC_BASE_URL`), `CLAUDE_CONFIG_DIR`, `CLAUDE_BIN`, `CLAUDE_CODE_*` (prefix), codex: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME`.
     - OD runtime cần cho tool trong run: `OD_TOOL_TOKEN`, `OD_DAEMON_URL`, `OD_DATA_DIR`, `OD_PROJECT_ID`, `OD_PROJECT_DIR`, `OD_BIN` (+ rà thêm biến `OD_*` nào được tool/skill đọc THẬT — grep `process.env.OD_` trong skills/scripts trước khi chốt; KHÔNG cho qua cả prefix `OD_*` vì `OD_ATLASSIAN_*` phải chặn).
     - Proxy nếu môi trường công ty cần: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (cả lowercase).
   - Chặn mặc định mọi thứ còn lại — nêu tên trong comment các nhóm chặn chủ đích: `KGS_*`, `MEDIA_*`, `SESSION_SECRET`, `GOOGLE_*`, `OD_ATLASSIAN_*`, `CONFLUENCE_*`, `IDENTITY_*`, `POSTHOG_*`.
   - Escape hatch dev: `OD_AGENT_ENV_PASSTHROUGH="VAR1,VAR2"` — cho qua thêm biến nêu tên tường minh (log warning một lần khi dùng).
2. Wire tại seam: `server.ts` ~L12370-12393 — sau `createAgentRuntimeEnv` và trước `applyAgentLaunchEnv`/`odMediaEnv`, khi **không** có `sandboxPlan` thì thay `process.env`-spread bằng `buildHostAgentEnv`. Giữ nguyên thứ tự pipeline env hiện tại (`spawnEnvForAgent` → `applyAgentLaunchEnv` PATH-prepend → `odMediaEnv`), chỉ đổi nguồn base.
3. **Lưu ý MCP**: server stdio trong `mcp-config.json` (vd `uvx mcp-atlassian`) nhận PAT qua field `env` riêng của server đó (daemon truyền khi spawn MCP — xác minh đường này KHÔNG đi qua seam agent; nếu có đi qua thì PAT của MCP server phải vẫn tới đúng MCP process, không tới agent).
4. Log một dòng stderr khi host run bị lọc biến có tên nằm trong nhóm chặn chủ đích mà trước đây từng hiện diện (giúp debug "sao skill không thấy biến X" — chỉ tên biến, không log giá trị).

## Tests (red-spec trước)

File mới `apps/daemon/tests/host-env.test.ts`:
- `KGS_API_KEY`/`SESSION_SECRET`/`OD_ATLASSIAN_JIRA_TOKEN` trong base → KHÔNG có trong kết quả.
- `PATH`/`HOME`/`OD_TOOL_TOKEN`/`ANTHROPIC_BASE_URL` → có.
- `ANTHROPIC_API_KEY` không kèm `ANTHROPIC_BASE_URL` → bị strip (hành vi cũ giữ nguyên).
- `OD_AGENT_ENV_PASSTHROUGH=FOO` + base có `FOO` → có.
- Sandbox path không đổi (test hiện có `agent-sandbox.test.ts` vẫn xanh).

## Ngoài phạm vi

- Đổi mặc định `OD_SANDBOX`/`OD_WRITE_ISOLATION` (WP4).
- Kill/timeout process (WP3).
- Đụng whitelist của đường Docker.

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` xanh; `host-env.test.ts` xanh; không tăng đỏ baseline.
2. Chứng minh bằng test tích hợp hoặc log thủ công: một host spawn (OD_SANDBOX=0) không còn thấy `KGS_API_KEY` trong env con.
3. Report ghi rõ danh sách biến cho-qua CUỐI CÙNG đã chốt (sau khi rà `process.env.OD_` thực tế) — đây là input cho review.
