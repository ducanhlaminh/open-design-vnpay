# WP8 — Bỏ JIRA ingest, tách credential Confluence khỏi MCP config

Ước lượng: 1–1.5 ngày. Phụ thuộc: không cứng, nhưng đụng `server.ts` — vùng nhiều WP khác (WP3, WP9, WP10) cũng muốn vào. **Chạy TUẦN TỰ với WP3/WP9/WP10 trên server.ts, không song song.**

Vùng sở hữu:
- `apps/daemon/src/server.ts` (dispatch jira/confluence — vùng quanh `runDocsDeterministic` và guard `looksLikeJiraInput`, ước lượng 13/08 sau khi WP1+WP2 merge: ~L14722-14841, ~L17252-17420 — **BẮT BUỘC verify lại bằng grep trước khi sửa**, vùng này vừa bị WP1/WP2 đụng nên có thể trôi).
- `apps/daemon/src/bas/bas-client.ts` (`resolveConfluenceCreds`, `looksLikeJiraInput`, `looksLikeConfluenceRef`).
- `apps/daemon/src/pipelines.ts` (3 def dùng `skillId: 'jira-ingest'`: `docs`, `prd-docs`, `dr-docs`).
- `apps/daemon/src/mcp-config.ts` — **CHỈ** phần `defaultMcpServers()` seed `mcp-atlassian`. KHÔNG đụng `MCP_TEMPLATES`, `McpServerConfig` type, `mcp-routes.ts`, `mcp-oauth.ts`, `mcp-tokens.ts`, `mcp-install-info.ts`, `McpClientSection.tsx` — khung MCP generic phục vụ các server khác (GitHub, Filesystem, image-gen...) không liên quan Jira, giữ nguyên 100%.
- `apps/web/src/components/pipelines/PipelineModals.tsx` (component `RunInputModal`).
- `skills/jira-ingest/` (đổi tên thư mục + viết lại nội dung).
- File/route/UI **mới** cho credential Confluence (liệt kê ở Thiết kế).

## Mục tiêu

1. Bỏ hoàn toàn nhánh nhập JIRA key/JQL (cả UI "Advanced" lẫn dispatch agent+`mcp-atlassian`) — 3 stage `docs`/`prd-docs`/`dr-docs` chỉ còn nhận Confluence URL, luôn chạy deterministic REST (không agent, không MCP).
2. Bỏ `mcp-atlassian` khỏi danh sách MCP server daemon tự seed.
3. Credential Confluence (base URL + PAT) có kho lưu trữ + UI riêng, **độc lập hoàn toàn với MCP config** — hiện tại nó đang nằm trong form generic "Settings → MCP" (user tự gõ tay vào textarea `env` của row `mcp-atlassian`), sau WP8 phải có 1 chỗ nhập rõ ràng: "Confluence Base URL" + "Personal Access Token".

## Vấn đề (đã xác minh 13/08, sau khi WP1+WP2 merge)

- `resolveConfluenceCreds` (`bas-client.ts:264-280`) đọc creds theo 2 nguồn thứ tự: (1) `mcp-config.json`'s row `mcp-atlassian` (hoặc row nào match `/atlassian/i`)'s `env.CONFLUENCE_URL`/`env.CONFLUENCE_PERSONAL_TOKEN`; (2) `process.env.CONFLUENCE_URL`/`CONFLUENCE_PERSONAL_TOKEN` (fallback deploy-wide). 5 call site: `app-pool.ts:255`, `app-pool-routes.ts:86`, `server.ts:14767`, `server.ts:18494`, `server.ts:18500`.
- `skills/jira-ingest/scripts/confluence_export.py` có đường đọc creds **RIÊNG** (không qua `resolveConfluenceCreds`), tự đọc thẳng `.od/mcp-config.json` — path thứ 3 cần sửa song song, không được bỏ sót.
- JIRA chưa từng là structured `PipelineRunSource` (xem `packages/contracts/src/api/pipelines.ts:630-644` — chỉ có `'confluence'|'bas'|'app-pool'`, không có `'jira'`). JIRA chỉ là free-text input được classify qua `looksLikeJiraInput`/`looksLikeConfluenceRef` (`bas-client.ts` ~L626-661). Dispatch tại `server.ts` (verify lại vùng ~L17252-17420): input match Confluence → `runDocsDeterministic` (no agent); input match `looksLikeJiraInput` → agent + `mcp-atlassian`; input không match cả hai → fail fast.
- Web: `PipelineModals.tsx` `RunInputModal` (~L684) là radiogroup Confluence/BAS (~L900-955) **+ một link riêng** "Advanced: JIRA key / JQL" (~L1038-1041) mở panel free-text (~L879-896, hint "Pulled via the `mcp-atlassian` server"). JIRA đã bị giấu sau "Advanced", không phải option ngang hàng.
- `skills/jira-ingest/SKILL.md` (163 dòng): ~55-60% nội dung là JIRA-only (khai nguồn `mcp-atlassian`, workflow 3 bước discover-scope→ghi `docs/jira/<KEY>.md`→index, "Hard rules" nói thẳng "Source of truth is mcp-atlassian"); phần Confluence chỉ ~25% (mô tả daemon tự fetch + cách dùng `confluence_export.py` cho page-tree). Bỏ JIRA nghĩa là viết lại phần lớn doc, không phải trim nhỏ — cân nhắc đổi tên skill thành `confluence-ingest` để phản ánh đúng nội dung còn lại.
- 16 file repo-wide còn tham chiếu skillId `jira-ingest` (docs, `packages/contracts/src/api/pipelines.ts`, Dockerfile của `ui-react` sandbox, `skills/feature-analysis/SKILL.md`, CSS, `PipelinesView.tsx`, `PipelineModals.tsx`, 3 file test daemon, `agent-sandbox.ts`, `pipelines.ts`, `server.ts`, `bas-client.ts`) — không phải chỗ nào cũng cần sửa (một số chỉ là ví dụ trong docs/RFC, không phải code thực thi).

## Thiết kế

1. **Kho credential Confluence mới** — file mới `apps/daemon/src/confluence-config.ts`:
   - `type ConfluenceConfig = { base: string; token: string } | null`.
   - `configFile(dataDir)` → `<dataDir>/confluence-config.json`; `readConfluenceConfig`/`writeConfluenceConfig` — mirror đúng pattern atomic write-then-rename của `mcp-config.ts:101-103,234-274`.
   - Route mới (file mới `confluence-config-routes.ts` hoặc gộp vào route file phù hợp sẵn có, tự quyết định): `GET /api/confluence-config` → `{ base, hasToken: boolean }` (**không** trả token thật ra ngoài); `PUT /api/confluence-config` → nhận `{ base, token }`, ghi file.
   - Migration một lần khi đọc lần đầu: nếu `confluence-config.json` chưa tồn tại nhưng `mcp-config.json` có row match `/atlassian/i` với `env.CONFLUENCE_URL`+`env.CONFLUENCE_PERSONAL_TOKEN` hợp lệ → tự copy sang file mới (tránh bắt user nhập lại tay), log 1 dòng khi migrate.
2. **`resolveConfluenceCreds`** (`bas-client.ts:264-280`): đổi nguồn (1) sang đọc `confluence-config.json` qua `readConfluenceConfig`; giữ nguyên thứ tự + nguồn (2) `process.env` fallback; **không đổi signature/return type** (5 call site không cần sửa gì thêm).
3. **`confluence_export.py`**: sửa đoạn đọc `.od/mcp-config.json` → đọc `.od/confluence-config.json` (field `base`/`token`).
4. **UI Settings mới**: thêm 1 section nhỏ trong `apps/web/src/components/IntegrationsView.tsx` (tự chọn vị trí hợp lý nhất — tab hiện có hoặc tab mới) đúng 2 field: "Confluence Base URL" (text) + "Personal Access Token" (password input, không hiện giá trị cũ, chỉ hiện "•••• đã lưu" nếu `hasToken=true`). Gọi GET/PUT route ở bước 1. Thêm i18n key cho đủ 19 locale (nguyên tắc chung #8 plan.md — text tiếng Anh thật ở `en.ts`, các locale khác copy y hệt, đúng convention đã áp dụng ở WP1).
5. **Gỡ `mcp-atlassian` khỏi seeding**: `mcp-config.ts` `defaultMcpServers()` (~L338-355, verify lại) — xoá nhánh seed `mcp-atlassian`. Không đổi gì khác trong file này.
6. **Bỏ nhánh JIRA khỏi dispatch** (`server.ts`, verify lại bằng grep `jira-ingest`/`looksLikeJiraInput` trước khi sửa): xoá guard `looksLikeJiraInput` + nhánh agent+`mcp-atlassian` phía sau; input không match Confluence → fail-closed với thông báo rõ ràng ("Chỉ hỗ trợ Confluence URL — JIRA đã ngừng hỗ trợ") thay vì rơi vào nhánh JIRA.
7. **Bỏ nhánh JIRA khỏi UI** (`PipelineModals.tsx` `RunInputModal`, verify lại ~L684-1041): xoá link "Advanced: JIRA key/JQL" + panel free-text JIRA; giữ nguyên radiogroup Confluence/BAS.
8. **Đổi tên skill** `skills/jira-ingest/` → `skills/confluence-ingest/` (viết lại `SKILL.md` theo hướng "Confluence là nguồn chính, daemon đã fetch sẵn — chỉ cần đọc `./docs/confluence/`"; giữ nguyên phần `confluence_export.py` cho case page-tree). Cập nhật `skillId: 'confluence-ingest'` tại 3 def trong `pipelines.ts` (`docs`, `prd-docs`, `dr-docs`) + `inputPlaceholder` (bỏ phần "or JIRA project key / JQL").
9. Rà lại 16 file tham chiếu `jira-ingest` cũ (grep repo-wide sau khi đổi tên) — sửa chỗ thực sự là code thực thi (skillId literal, test assertion, label UI), bỏ qua chỗ chỉ là ví dụ trong docs/RFC không ảnh hưởng runtime — **ghi rõ trong report chỗ nào bỏ qua và vì sao**.

## Tests

Cập nhật: `pipeline-ingest-fail-fast.test.ts` (JIRA input nay luôn fail-fast, đổi message kỳ vọng), `pipelines.test.ts` (skillId assertion → `confluence-ingest`), `agent-sandbox.test.ts` (jira-ingest skill reference), `mcp-config.test.ts` (bỏ/sửa phần liên quan seed `mcp-atlassian` nếu có), `app-pool.test.ts`, `app-pool-routes.test.ts` (set creds qua `confluence-config.json` mới thay vì mock `mcp-config`), `host-env.test.ts` (biến `CONFLUENCE_PERSONAL_TOKEN` passthrough — giữ nguyên, đây là whitelist ENV của WP2, không phải MCP config).

Viết mới (red-spec trước):
- `apps/daemon/tests/confluence-config.test.ts` — read/write roundtrip; migration một-lần từ `mcp-config.json` cũ; route GET không lộ token thật; route PUT ghi đúng file.
- Test dispatch: input JIRA-shaped bị từ chối rõ ràng, không khởi động agent, không đụng `mcp-atlassian`.
- Web: UI Settings mới hiện đúng field, không hiện lại token cũ dạng plaintext; `PipelineModals.tsx` không còn render link "Advanced: JIRA".

## Ngoài phạm vi

- Khung MCP generic (`mcp-routes.ts`, `mcp-oauth.ts`, `mcp-tokens.ts`, `mcp-install-info.ts`, `McpClientSection.tsx`, `MCP_TEMPLATES`, `McpServerConfig` type) — phục vụ các MCP server khác không liên quan Jira, giữ nguyên.
- 2 MCP server nội bộ (`open-design-live-artifacts`/`open-design-overview`) và OD-as-MCP-server (`apps/daemon/src/mcp.ts`) — thuộc WP9.
- KGS — thuộc WP10.
- Seam env whitelist (WP2, đã xong), kill/timeout process (WP3).

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` xanh; test mới + test cập nhật xanh; không tăng đỏ baseline (xem `baseline.md`).
2. Test chứng minh: input JIRA key/JQL vào `docs`/`prd-docs`/`dr-docs` → bị từ chối rõ ràng, không khởi động agent.
3. Test chứng minh: `resolveConfluenceCreds` đọc đúng từ `confluence-config.json` mới, có migration từ `mcp-config.json` cũ, không còn phụ thuộc row `mcp-atlassian`.
4. `defaultMcpServers()` không còn seed `mcp-atlassian`; test hiện có của khung MCP generic (`McpClientSection.oauth.test.tsx`, `McpJsonHelper.test.tsx`, `mcp-config.test.ts`) vẫn xanh, không bị ảnh hưởng.
5. Report ghi rõ: 16 file tham chiếu `jira-ingest` cũ — chỗ nào đã sửa, chỗ nào cố ý bỏ qua kèm lý do.
