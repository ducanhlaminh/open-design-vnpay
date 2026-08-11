# Gỡ Docker khỏi bản prod (giữ nguyên cho dev)

Trạng thái: DRAFT — chờ chốt Phase 2 và Phase 3 trước khi code.
Ngày: 2026-08-08.

## Mục tiêu

Bản đóng gói phân phối cho người dùng cuối (packaged / prod) chạy được **không cần
cài Docker**. Máy dev **giữ nguyên** đường Docker như hôm nay: sandbox agent để
kiểm thử, và `docker compose` để dựng KGS/media/postgres/NATS local.

Nguyên tắc xuyên suốt: **không xóa code Docker**. Biến nó thành một *chế độ*
(`sandbox` | `host`) chọn lúc build. Dev mặc định `sandbox`, prod mặc định `host`.
Xóa code sẽ phá dev và làm mất luôn đường lùi.

## Không thuộc phạm vi

- **Infra services (KGS, media, postgres, NATS).** Đã xong từ trước: prod bake
  `KGS_URL`/`MEDIA_URL` trỏ public (`b5.openledger.vn`) lúc đóng gói, máy người
  dùng không chạy service nào. Chỉ dev mới cần `od-local-up.sh`. Không có việc phải làm.
- **Bỏ nhánh Jira / mcp-atlassian.** Đã chốt bỏ riêng — xem §5.
- **Đổi cơ chế cách ly trên dev.** Dev vẫn dùng container.

## 1. Hiện trạng (đã kiểm chứng)

### 1.1 Docker hôm nay là runtime MẶC ĐỊNH của mọi run

`resolveSandboxConfig` — `apps/daemon/src/agent-sandbox.ts:82-88`:

```ts
let enabled = prefs?.enabled !== false;      // ⇒ MẶC ĐỊNH BẬT
if (env.OD_SANDBOX === '1') enabled = true;
else if (env.OD_SANDBOX === '0') enabled = false;
```

Mọi run claude (chat, Orbit, routines, MỌI stage pipeline) đi qua container, không
phải vì stage nào cần, mà vì đó là mặc định của fork này.

> Cạm bẫy đọc code: `validateSandbox` trong `app-config.ts:283` để `enabled: false`.
> Đó chỉ là parse prefs đã lưu, KHÔNG phải giá trị hiệu lực. Đừng nhầm hai chỗ.

### 1.2 Đường ống bake đã có sẵn, nhưng knob đã chết

`tools/pack/src/config.ts:452` đọc `OD_SANDBOX_DEFAULT` lúc đóng gói → bake vào
`open-design-config.json` → `apps/packaged/src/sidecars.ts:353-357` chuyển thành env
cho daemon:

- `sandboxDefault === '1'` → forward `OD_SANDBOX=1` (ép Docker-only).
- giá trị khác → forward `OD_SANDBOX_DEFAULT=<val>` — **mà daemon không đọc biến này
  nữa** (grep `OD_SANDBOX_DEFAULT` trong `apps/daemon/src` chỉ ra comment ở dòng 73).

Hệ quả: hôm nay **không có cách nào bake một bản prod không-Docker**. Nhưng đường ống
đã sẵn, chỉ thiếu một nhánh map.

### 1.3 Docker đang gánh 4 việc, không phải 1

| # | Việc | Bằng chứng |
|---|---|---|
| A | Chứa chính Claude CLI (image bake `@anthropic-ai/claude-code@<pin>`) | `skills/ui-react/builder/sandbox/Dockerfile`; `server.ts:6034-6072` ẩn host CLI khi sandbox "owns" Claude |
| B | Kho credential + multi-account (volume `od-claude-auth`) | `agent-sandbox.ts:415-448, 506-542, 619-632, 969-999`; usage meter `server.ts:13138-13155` |
| C | Ranh giới cách ly | mount 1 thư mục `:204`; env whitelist 3 biến `:162-171`; `--cpus/--memory/--pids-limit` `:207-209`; timeout+kill `server.ts:11823-11840`; sweep orphan `server.ts:17799-17810` |
| D | Toolkit build React | `skills/ui-react/builder/build.sh:66-87` |

### 1.4 Chỉ 2/17 bước workflow có Docker trong skill

Audit 3 workflow (`docs-to-ui` 9 bước, `docs-to-prd` 4, `docs-review` 4): chỉ
`ui-react` và `ui-react-ds` gọi docker trong `builder/build.sh`. 15 bước còn lại
sạch. `docs-to-prd`, `docs-review`, và `docs-to-ui` nhánh `ui-html` chạy được ngay
hôm nay chỉ với `OD_SANDBOX=0` + claude CLI trên host.

### 1.5 Tiền lệ auto-bootstrap host toolchain đã chạy production

Ba tính năng tự cài toolchain vào thư mục riêng ngoài workspace, idempotent:
`react-demo.ts:156-190` (`ensureRunnerEnv`), `figma-capture.ts`,
`bas/drawio-render.ts:64-96` — đều `npm install playwright` + `playwright install
chromium`. Cộng `ensure-uv.ts` tự cài uv standalone. **Khuôn mẫu để seed toolkit
uireact trên host đã được chứng minh**, không phải phát minh mới.

Điểm yếu chung: chúng cần `npm` trên PATH và daemon không tự cài npm.

## 2. Thiết kế: chế độ thực thi agent

Thêm khái niệm tường minh thay cho boolean `enabled`:

```
agentExecutionMode = 'sandbox' | 'host'
```

- `sandbox` — hành vi hôm nay, không đổi một dòng. Mặc định của **dev**.
- `host` — spawn agent thẳng trên máy, kèm các biện pháp bù ở §4. Mặc định của **prod**.

Cách chọn, theo thứ tự ưu tiên:

1. `OD_SANDBOX=1|0` (escape hatch dev, giữ nguyên).
2. Prefs người dùng đã lưu (`od sandbox enable/disable`).
3. Giá trị bake lúc đóng gói.
4. Mặc định theo môi trường: dev → `sandbox`, packaged → `host`.

Giữ nguyên tên biến cũ để không phá thứ đang chạy; `mode` là lớp diễn giải bên trên.

## 3. Phase 1 — Bật được bản prod không-Docker (nhỏ, làm trước)

Mục tiêu: có một bản build chạy `host` mode, để lộ ra cái gì thật sự gãy.

1. **`apps/packaged/src/sidecars.ts:353-357`** — thêm nhánh: `sandboxDefault === '0'`
   → forward `OD_SANDBOX: '0'` (đối xứng với nhánh `'1'` đang có).
2. **`tools/pack`** — không cần sửa code; bản prod build với `OD_SANDBOX_DEFAULT=0`.
3. **Dọn comment chết** ở `agent-sandbox.ts:70-76` (nói về `OD_SANDBOX_DEFAULT` mà
   code không còn đọc) để người sau không tin nhầm.

Xong bước này: `docs-to-prd`, `docs-review`, `docs-to-ui`→`ui-html` chạy được trên máy
không Docker, với điều kiện có claude CLI trên host (§5).

## 4. Phase 2 — Bù lại các đảm bảo mất đi

Đây là phần rủi ro thật, không phải phần build.

### 4.1 Cách ly ghi — mac xong, Windows CHƯA có lời giải

macOS (cả Intel lẫn Apple Silicon): bật `OD_WRITE_ISOLATION=required`. Đã có sẵn,
kernel-enforced, `apps/daemon/src/write-isolation.ts`.

Windows: `planWriteIsolation` trả `null` với mọi platform ≠ darwin
(`write-isolation.ts:194-195`) ⇒ **không có cách ly ghi nào**. Đây là mâu thuẫn trực
tiếp với yêu cầu "chặn write". Bốn lựa chọn, xếp theo chi phí:

| # | Cách | Chi phí | Độ chắc |
|---|---|---|---|
| A | Chấp nhận: Windows không cách ly, ghi rõ trong release note | 0 | không |
| B | Deny-rule của chính agent CLI (settings `permissions.deny` chặn Write/Edit ngoài cwd) | ~0.5 ngày | yếu — agent vẫn lách được qua Bash |
| C | Chạy agent bằng **local user riêng quyền thấp** + ACL chỉ cho ghi thư mục project | 3–5 ngày | mạnh, kernel-enforced |
| D | Windows Sandbox / AppContainer | 5+ ngày | mạnh nhưng đòi Win Pro, nặng |

Đề xuất: **A cho bản đầu, C cho bản sau**. B tạo cảm giác an toàn giả, không nên dùng
một mình.

### 4.2 Cách ly đọc — CHỦ ĐỘNG BỎ (đã chốt)

Agent ở host mode đọc được toàn bộ disk và có network. Chủ dự án đã chấp nhận: chỉ cần
chặn ghi. Không làm gì thêm. Ghi lại ở đây để người sau không tưởng là sót.

### 4.3 Env curation — bắt buộc làm

Container chỉ forward 3 biến (`agent-sandbox.ts:162-171`). Host spawn hiện kế thừa
env của daemon ⇒ `KGS_API_KEY`, media creds, token Atlassian lọt vào process agent.
Phải dựng whitelist tương đương tại seam spawn host trong `server.ts`. **Không được
bỏ qua bước này** — nó rẻ và là lỗ hổng rõ ràng nhất.

### 4.4 Vòng đời process

Mất `--cpus/--memory/--pids-limit` và `docker kill` một phát là sạch. Host mode phải:
kill **cả cây process** (agent spawn vite, node, MCP con), giữ timeout hiện có
(`server.ts:11823-11840`), và thay sweep orphan theo label container bằng
process-stamp (`@open-design/platform` đã có primitive).

## 5. Phase 3 — Prerequisite trên máy người dùng

Sau khi bỏ Jira/mcp-atlassian, danh sách rút xuống còn **một** thứ bắt buộc:

| Thứ | Vì sao | Cách có |
|---|---|---|
| **Claude CLI** | image không còn cung cấp | native installer (`claude.ai/install.sh`) — binary self-contained ~272MB, **đã nhúng sẵn ripgrep**, không cần Node |
| ~~ripgrep~~ | nhúng trong binary claude | — |
| ~~python3, uv/uvx~~ | chỉ phục vụ nhánh Jira + fallback Confluence | bỏ theo §5.1 |
| ~~git, jq, curl~~ | không skill nào của 3 workflow bắt buộc | — |
| `npm` | playwright/chromium cho drawio render + react demo | đã là hiện trạng, không phải nợ mới |

### 5.1 Bỏ nhánh Jira

Đường Confluence **đã deterministic ở daemon**, không agent, không python, không uvx:
`server.ts:16336-16355` → `runDocsDeterministic` → `fetchConfluencePages` (direct PAT
REST hoặc BAS gateway, `bas/bas-client.ts:1245-1303`). Chỉ JIRA key/JQL mới đi agent +
`uvx mcp-atlassian`.

Việc cần làm: không bake `OD_ATLASSIAN_*` cho prod ⇒ `mcp-config.ts:342` không seed
server ⇒ `ensureUvInstalled` không chạy (`ensure-uv.ts:68-81` chỉ cài khi có stdio
server dùng uvx). Cập nhật `skills/jira-ingest/SKILL.md` bỏ phần Jira.

### 5.2 python3 còn sót

Chỉ còn `skills/wcag-lint/scripts/wcag_lint.py` (cổng a11y của cả 3 terminal UI) và
script KB của `ux-research` (optional, có fallback). Cả hai **stdlib-only**.

Đề xuất: port sang JS chạy bằng `OD_NODE_BIN` — biến này đã được daemon bơm vào env
mọi run và `server.ts:1709` ghi rõ *"packaged desktop installs provide this even when
the user has no system node on PATH"*. ⇒ **zero dependency python**.

Lưu ý: script KB nằm ở `~/ux-knowledge-base/`, phân phối riêng — port xong phải cập
nhật cả bundle đó, không chỉ repo.

`push_to_kgs.py` không cần đụng: bản `customer-journey-spec` là LEGACY/DISABLED, bản
`ux-spec` đã có đường Node `od kg push`, và không stage nào set `convertToGraph` nên
nhánh daemon gọi `python3` (`server.ts:13798`) không bao giờ chạy.

## 6. Phase 4 — Host toolkit cho ui-react / ui-react-ds

Phần rẻ nhất, làm được độc lập.

### 6.1 Cạm bẫy resolution — ĐÃ TEST, đừng làm sai

Layout Docker là "project là thư mục **con** của toolkit" (`/work/app` dưới
`/work/node_modules`). Phản xạ tự nhiên là symlink project thành con của toolkit trên
host. **Cách đó hỏng**: Node resolve theo realpath, quay về vị trí thật của project rồi
đi lên từ đó ⇒ `ERR_MODULE_NOT_FOUND`, kể cả với `--preserve-symlinks`.

Thí nghiệm đã chạy:

| Cách | Kết quả |
|---|---|
| symlink `<project>/node_modules` → `<toolkit>/node_modules` | ✅ resolve đúng |
| symlink project thành con của toolkit | ❌ ERR_MODULE_NOT_FOUND (cả với `--preserve-symlinks`) |

### 6.1b Symlink node_modules là kênh write-amplification — repo đã từng bác

`cwd-aliases.ts:9-18` ghi lại một quyết định cũ (PR #435): bản đầu dùng directory link
trỏ vào `skills/` thật và **bị reviewer bác** vì agent có quyền ghi trong cwd, nên một
lệnh `Write`/`Edit`/`Bash` vào đường dẫn qua link sẽ sửa thẳng tài nguyên gốc dùng
chung. Họ đổi sang copy per-project.

Thiết kế ở §6.1 dính đúng bẫy đó: `<project>/node_modules` → toolkit **dùng chung mọi
project**. Agent ghi xuyên qua đó là hỏng toolkit của tất cả project.

Không thể copy node_modules per-project (vài trăm MB/lần). Biện pháp:

1. **Sau khi cài toolkit, `chmod -R a-w`** toàn bộ thư mục toolkit. Docker đã làm tương
   đương (`Dockerfile`: `chmod -R a+rX`). Ghi xuyên symlink sẽ fail ở tầng OS.
2. **macOS**: profile write-isolation KHÔNG cấp quyền ghi cho thư mục toolkit ⇒ chặn
   lần hai, kernel-enforced.
3. **Windows**: `fs.chmod` chỉ bật cờ read-only, yếu hơn. Cần set ACL (`icacls`) nếu
   chọn phương án C ở §4.1.

### 6.1c Windows: builder hiện KHÔNG chạy được

`server.ts:17419` gọi `execFileBuffered('bash', [script, reactDir])`. Windows không có
`bash` (trừ khi cài Git for Windows). Nghĩa là `ui-react`/`ui-react-ds` trên Windows
**đã hỏng từ trước**, không phải nợ mới do bỏ Docker.

Vì prod nay có Windows, phải **port builder từ `build.sh` sang `builder/build.mjs`**
chạy bằng `OD_NODE_BIN`. Việc này đồng thời xóa luôn phụ thuộc `sh`, `cp`, `tr`,
`shasum`. Giữ `build.sh` cho dev nếu muốn, nhưng daemon gọi bản `.mjs`.

Tiền lệ Windows cần copy từ `bas/drawio-render.ts:74-96`:
- `npm` là `npm.cmd` ⇒ phải `shell: true` trên Windows.
- Không gọi `node_modules/.bin/<tool>` (là `.cmd` shim, `execFile` từ chối) — gọi thẳng
  file JS entry của package qua `execNodeScript`. Áp dụng cho cả `vite` và `tsc`.

### 6.2 Việc cụ thể

1. **`ensureUireactToolkit()`** ở daemon (~40 dòng, sao khuôn `ensureRunnerEnv`):
   tạo `<runtimeDataDir>/uireact-toolkit/<version>/`, copy `builder/base/package.json`
   + `pnpm-lock.yaml`, chạy `npx -y pnpm@10.33.2 install --frozen-lockfile` một lần rồi
   no-op. Dùng `npx` để khỏi đòi pnpm global.
2. **Nhánh thứ ba trong 2 file `build.sh`** (~25 dòng): khi có `UIREACT_TOOLKIT_DIR` →
   symlink `<target>/node_modules`, prepend `<toolkit>/node_modules/.bin` vào PATH,
   chạy đúng gate `tsc --noEmit && vite build` như cũ. **Giữ nguyên nhánh docker.**
3. **Truyền env**: `server.ts:17419` đã có `env: {...process.env, UIREACT_PROJECT_ID}`
   — thêm `UIREACT_TOOLKIT_DIR` là một dòng.
4. **Dọn symlink**: `react/node_modules` KHÔNG có trong `syncExclude`
   (`pipelines.ts:232`) và `dist/` thì lại CÓ sync. Hai lựa chọn: thêm
   `react/node_modules/` vào `syncExclude`, hoặc `trap` unlink ngay sau build. Đề xuất
   cách hai — không đụng contract sync.

Mất: build network-less (`--network none`), `--cap-drop ALL --user node`, giới hạn
CPU/RAM/PID. Được: hết vấn đề cross-arch (máy Intel không còn QEMU, native dep
lightningcss/esbuild luôn đúng kiến trúc) và build nhanh hơn.

## 7. Phase 5 — Auth trên host (đã rút gọn mạnh)

**Đã chốt: prod KHÔNG cần đổi tài khoản.** App chỉ cần *phát hiện* CLI có sẵn trên máy
(claude hoặc codex) và dùng luôn login của nó. Người dùng tự `claude` / `codex login`
một lần ngoài app.

Hệ quả: **bỏ toàn bộ** khối việc nặng nhất của spec bản đầu — không port kho credential,
không viết lại list/save/switch/remove/check, không embedded login, không OAuth
extraction. Ở `host` mode, các API/UI đó chỉ cần báo "không áp dụng".

Việc còn lại, nhỏ:

1. **Khôi phục host CLI detection** — `server.ts:6001-6072` hiện **ẩn** host claude khi
   sandbox "owns" Claude. Không sửa chỗ này thì UI báo "không có agent" dù đã cài CLI.
   Đây là việc bắt buộc và gần như là *tất cả* của phase này.
2. **Preflight rõ ràng**: thiếu CLI ⇒ báo tên binary + link cài, không fail mơ hồ.
   Codex CLI đã có runtime def sẵn nên detect được ngay, không cần code mới.
3. **Usage meter** (`claude-usage.ts:90-123`, `server.ts:13138-13155`) hiện đọc token từ
   volume. Ở host mode: đọc từ nguồn của CLI, hoặc **tắt hẳn meter** (đơn giản hơn, và
   không mất tính năng cốt lõi nào).

Ước lượng mới: **1–1.5 ngày** (bản cũ 3–5 ngày).

> Gotcha còn giữ giá trị: trên macOS claude CLI lưu credential trong **Keychain**
> (`Claude Code-credentials`), không phải file — nên đừng viết code đi tìm file
> credential để đoán trạng thái đăng nhập. Hãy hỏi chính CLI.

## 8. Phase 6 — Surface UI/CLI

- `InfraSetupGate.tsx` — đổi từ "check Docker + image + login volume" sang "check claude
  CLI + đã login". Với `host` mode, bỏ hẳn bước Docker.
- `SandboxSection.tsx`, `ClaudeAccountSwitcher.tsx` — theo mode.
- `sandbox-routes.ts` + `packages/contracts` — `dockerOk/imageOk/authVolumeOk` thành
  optional; thêm `hostClaudeAvailable/authStorePresent/loggedIn/version`.
- `od sandbox` (`cli.ts:5861`) — giữ nhóm lệnh cho dev; ở `host` mode báo lỗi rõ ràng
  thay vì chạy docker. Repo bắt buộc mọi capability có **cả** UI lẫn CLI (AGENTS.md).

## 9. Ma trận nền tảng prod

Prod ship 3 target: **Windows (nsis)**, **mac Intel (x64)**, **mac Apple Silicon (arm64)**.

| | mac arm64 | mac x64 | Windows |
|---|---|---|---|
| Chặn ghi | ✅ Seatbelt `required` | ✅ Seatbelt `required` | ❌ chưa có — xem §4.1 |
| Build React trên host | ✅ | ✅ | ⚠️ cần port builder sang `.mjs` (§6.1c) |
| Toolkit native deps (lightningcss/esbuild) | ✅ đúng arch tự nhiên | ✅ | ✅ |
| Đóng gói | có sẵn | có sẵn (`OD_PACK_MAC_ARCH=x64`) | có sẵn (`tools-pack win`) |

Bỏ Docker **giải quyết luôn** nỗi đau cross-arch cũ: máy Intel không còn chạy image
arm64 qua QEMU, native dep luôn khớp kiến trúc vì cài trực tiếp trên máy đích.

## 10. Thứ tự đề xuất

| Bước | Nội dung | Ước lượng | Chặn bởi |
|---|---|---|---|
| 1 | Phase 1 (nối `OD_SANDBOX=0`) + Phase 4 (host toolkit + port builder `.mjs`) | 2–3 ngày | — |
| 2 | Phase 3 (bỏ Jira, port 2 script python sang JS) | 1 ngày | — |
| 3 | Phase 2 (env curation + kill cây process + write-isolation `required`) | 2 ngày | — |
| 4 | Phase 5 (detect CLI trên host) | 1–1.5 ngày | — |
| 5 | Phase 6 (UI/CLI/contracts) + test 3 nền tảng | 2 ngày | các bước trên |

Tổng ~8–9 ngày. **Không bước nào còn chặn bởi quyết định chính sách** — cả 3 câu hỏi
của bản draft đã được chốt.

## 11. Đã chốt

1. **Multi-account**: BỎ ở prod. App chỉ detect CLI (claude / codex) trên host.
2. **Cách ly đọc**: BỎ. Chỉ chặn ghi.
3. **Nền tảng**: Windows + mac Intel + mac Apple Silicon.

Còn mở duy nhất: chọn phương án chặn ghi cho Windows (§4.1 — A trước, C sau).

## 11. Acceptance

- Máy sạch, **không cài Docker**, có claude CLI: chạy trọn `docs-to-prd`,
  `docs-review`, và `docs-to-ui` tới `ui-html` + `ui-react` (có dist build được).
- Máy dev không đổi hành vi: `OD_SANDBOX` không set ⇒ vẫn chạy container như cũ.
- `pnpm guard` + `pnpm typecheck` xanh; test daemon phủ: host login, thiếu claude CLI,
  timeout/kill cây process, toolkit seed lần đầu + no-op lần sau.
- Red spec trước khi sửa, theo `Bug follow-up workflow` trong AGENTS.md.
