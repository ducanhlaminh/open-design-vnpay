# App Docs Pool — fetch Confluence 1 lần ở App, chưng cất, gate trước run

Status: SPEC (2026-08-07, chốt với user). Executor: sub-agents theo Work
Packages (§WP-1…WP-6) — mỗi WP tự chứa đủ ngữ cảnh; contracts ghim ở §2 là
BẤT BIẾN, không WP nào được sửa shape mà không cập nhật spec.

## 1. Kiến trúc

- **App pool**: tạo App → import Confluence (daemon fetch deterministic →
  Markdown + ảnh, KHÔNG agent) vào `<PROJECTS_DIR>/<appId>/docs/` + manifest.
- **Chưng cất** (map-reduce theo cây, agent): `_branches/<slug>.md` per phân
  hệ + `_overview.md` toàn cục — validate bằng script deterministic.
- **GATE**: run pipeline nguồn App-pool CHỈ chạy khi 100% trang pool
  `distilled` + hash khớp. FE disable nút Chạy; BE là chốt thật (failed +
  error đếm trang).
- **Run**: bước ingest copy deterministic trang CHÍNH (đã tick) →
  `<wf>/docs/`; TOÀN BỘ pool (md-only) stage vào `.app-docs/` (dot-folder,
  khuôn `stageAppContext` — vô hình với snapshot/push/re-run-clear) + kickoff
  bắt agent đọc `_overview.md` trước, drill-down theo bản đồ, phạm vi chính
  = `docs/`.
- Bài học phải tôn trọng (từ vòng trước, xem memory/commit cfef0fe):
  run-all persist runAllConfig là FULL-REPLACE → field mới PHẢI được mọi
  writer resend hoặc BE preserve; dr-docs không bao giờ seed agent (gate
  JIRA giữ nguyên); tên file Confluence-fetch giữ dấu tiếng Việt.

## 2. CONTRACTS GHIM (mọi WP code đúng shape này)

### 2.1 Manifest — `<appId>/docs/_manifest.json`
```jsonc
{
  "version": 1,
  "pages": [{
    "pageId": "1000083499",
    "path": "2-urd-cho-website-k-ton/i-urd-ti-khon.md", // relative trong docs/
    "title": "I. URD Tài khoản",
    "branch": "2-urd-cho-website-k-ton",   // slug nhánh cấp-1 (phân hệ)
    "contentHash": "sha256:…",              // hash file md sau fetch
    "fetchedAt": 1786100000000,
    "distill": { "state": "fetched" | "distilling" | "distilled" | "stale",
                  "distilledHash": "sha256:…" | null }
  }]
}
```
`stale` = contentHash ≠ distilledHash sau re-fetch. Gate pass ⇔ mọi page
`state==='distilled' && distilledHash===contentHash`.

### 2.2 API (daemon)
- `POST /api/pipelines/apps/:appId/import-confluence` body
  `{ refs: string[], followLinks?: boolean, includeDescendants?: boolean }`
  → fetch (lõi dr-docs deterministic) vào pool, cập nhật manifest (trang
  mới `fetched`, trang re-fetch đổi hash → `stale`), trả
  `{ imported: n, updated: n, pages: ManifestPage[] }`. 404 app lạ, 502 creds/fetch.
- `GET /api/pipelines/apps/:appId/pool` →
  `{ pages: ManifestPage[], distill: { clean: boolean, pending: number,
     running: boolean, progress?: {done,total} }, overviewExists: boolean }`.
- `DELETE /api/pipelines/apps/:appId/pool/pages` body `{ pageIds: string[] }`.
- `POST /api/pipelines/apps/:appId/distill` → chạy chưng cất incremental
  (chỉ nhánh có trang ≠distilled) → `{ started: true, branches: string[] }`;
  409 nếu đang chạy.
- Run-config (PUT + run-all body): field mới
  `appPool?: { appId: string, paths: string[] }` (paths = trang CHÍNH).
  Run-all BE PRESERVE appPool khi body không nhắc key (như bài học appFiles).
- Run source per-run: `{ kind: 'app-pool', appId, paths }` trong
  PipelineRunSource (parse tại parseRunSource).

### 2.3 File chưng cất
- `_overview.md` ≤400 dòng, heading CỐ ĐỊNH đúng thứ tự: `## Cách dùng file
  này` · `## Dự án` · `## Phân hệ` (bảng Slug|Phân hệ|Phạm vi|Branch) ·
  `## Luồng nghiệp vụ xuyên trang` · `## Thuật ngữ` · `## Bản đồ trang`
  (bảng Path|Nội dung|Keywords — ĐỦ 100% trang manifest, path thật).
- `_branches/<slug>.md` ≤120 dòng: tóm tắt phân hệ, luồng nội bộ, bảng trang
  con (path|chức năng|keywords nguyên văn trong trang).
- `_index.md` CƠ HỌC (0 LLM): cây trang + title(heading) + path — sinh lại
  mỗi lần pool đổi, luôn đủ 100%.
- Validation (script node trong daemon, chạy sau distill): (a) Bản đồ trang
  đủ và path tồn tại; (b) trần dòng; (c) mọi `_branches/` được `## Phân hệ`
  tham chiếu. Fail → distill run đánh dấu failed, KHÔNG set distilled.

### 2.4 Staging vào run + kickoff
- `.app-docs/` trong run cwd: `_overview.md`, `_branches/**`, `_index.md`,
  toàn bộ `*.md` pool (KHÔNG ảnh — ảnh chỉ theo trang chính vào `docs/`).
- Kickoff thêm đúng đoạn: «Tài liệu App: đọc `.app-docs/_overview.md` TRƯỚC
  KHI làm việc. Cần sâu phân hệ → `.app-docs/_branches/<slug>.md`; cần chi
  tiết → mở trang theo «Bản đồ trang». Phạm vi xử lý CHÍNH của bạn chỉ là
  `docs/` — KHÔNG audit/fan-out các file trong `.app-docs/`.»

## 3. Work Packages (chạy song song trừ khi ghi depends)

### WP-1 — BE pool core (owner file MỚI: `apps/daemon/src/app-pool.ts` + `app-pool-routes.ts`)
Manifest read/write helpers (schema §2.1, atomic write), import-confluence
(TÁI DÙNG lõi fetch dr-docs — trace `runDocsDeterministic`/`fetchConfluencePages`
trong server.ts/bas-client, KHÔNG copy-paste logic: tách helper chung nếu cần),
GET pool, DELETE pages, `_index.md` generator cơ học. Đăng ký routes qua MỘT
lệnh `registerAppPoolRoutes(app, ctx)` — WP-4 sẽ gọi. Tests: manifest round-trip,
import mock (stub bas-client), state transitions fetched/stale, index generator.
KHÔNG sửa server.ts / pipeline-routes.ts.

### WP-2 — Distill runner + validation (owner: `apps/daemon/src/app-distill.ts` + script)
`POST …/distill` handler logic (export hàm, WP-4 đăng ký): chọn nhánh cần
chạy (state≠distilled), set `distilling`, chạy skill §WP-3 qua cơ chế
agent-run sẵn có ở App workspace (trace cách pipeline seed run — dùng
per-branch fan-out như prd-review-fanout), sau mỗi nhánh chạy VALIDATION
(§2.3) — pass thì set `distilled`+`distilledHash`, fail giữ nguyên + trả lỗi.
Reduce chạy cuối khi mọi nhánh distilled. Progress ghi vào manifest-side
state cho GET pool đọc. Tests: validation script các case (thiếu trang, path
bịa, quá trần), state machine, incremental chọn đúng nhánh.
KHÔNG sửa server.ts / pipeline-routes.ts.

### WP-3 — Skill chưng cất (owner: `skills/app-context-distill/` MỚI)
SKILL.md 2 mode theo kickoff: MODE=branch (đọc mọi trang 1 nhánh → viết
`_branches/<slug>.md` đúng template §2.3, keywords NGUYÊN VĂN, cấm dịch/bịa,
mỗi fact cite path) · MODE=reduce (đọc `_overview.md` cũ nếu có + mọi
`_branches/` → viết `_overview.md` đúng heading cố định, đủ 100% trang từ
`_index.md`). Kèm templates/ ví dụ + hard rules (trần dòng, không filler).
Thuần file mới — song song tuyệt đối.

### WP-4 — Tích hợp run + GATE (owner: server.ts + pipeline-routes.ts) — DEPENDS WP-1, WP-2
Đăng ký routes WP-1/WP-2. parseRunSource thêm 'app-pool'. runAllConfigFromBody
+ PUT run-config thêm appPool (+PRESERVE ở run-all như bài học). Dispatch
jira-ingest: source/saved appPool → GATE check (§2.1) — fail: status failed
+ error «N trang chưa chưng cất (…) — bấm Chưng cất tài liệu rồi chạy lại»;
pass: copy deterministic trang chính (+ảnh/attachments cùng thư mục trang)
→ `<wf>/docs/` + status như runDocsDeterministic cũ. MỌI stage của project
có App gắn pool: stage `.app-docs/` (§2.4, khuôn stageAppContext) + kickoff
directive. Contracts: PipelineRunSource + RunAllConfig.appPool. Tests: gate
pass/fail, copy, preserve, staging, kickoff chứa directive.

### WP-5 — FE màn App (owner: file MỚI `AppPoolSection.tsx` + App modals)
Tạo App: sau khi tạo xong mở luôn phần Import (search theo tên — endpoint
`GET /api/pipelines/confluence/pages?q=` sẵn có — tick nhiều trang; UX
search+tick tái dùng từ git history 7ae50bc/4f3adee nếu tiện). Sửa App:
pool view (cây + title + badge trạng thái distill), Import thêm, Xóa trang,
nút «Chưng cất tài liệu» (badge N pending, progress x/y khi chạy), xem
`_overview.md`. Typecheck sạch.

### WP-6 — FE run-config + gate UX (owner: PipelineModals.tsx + PipelinesView.tsx)
Card «Tài liệu App» trong modal Nguồn tài liệu (hiện khi App có pool): cây
pool tick TRANG CHÍNH → lưu run-config `appPool` (mọi writer resend — kiểm
buildRunAllPayloadFromConfig/hasSource/rail summary NGAY từ đầu, học bài
appFiles); «Import thêm từ Confluence» inline (gọi import-confluence rồi
refresh cây + auto-tick trang mới); nút «Chưng cất tài liệu» + nút Chạy
disabled khi `distill.clean===false` (tooltip đếm trang, progress khi đang
chạy). resolveStageRunConfig đọc appPool → source app-pool. Typecheck sạch.

### Sóng chạy
Wave 1 song song: WP-1, WP-2, WP-3, WP-5, WP-6 (WP-5/6 code theo contract
§2.2 dù BE chưa xong). Wave 2: WP-4 (sau WP-1+2). Wave 3: review chéo +
e2e tài liệu Kế toán thật + commit (coordinator làm).

## 4. Non-goals đợt này
Upload folder/zip thủ công (đã bỏ, không quay lại) · usedBy badge chống
ingest trùng (sau) · auto-refresh pool theo lịch · CLI od (follow-up ghi nợ).
