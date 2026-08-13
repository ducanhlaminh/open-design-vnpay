# WP1 — Hold 3 stage gen-code UI của docs-to-ui

Ước lượng: 1 ngày. Phụ thuộc: không (song song WP0/WP2). Vùng sở hữu: `pipelines.ts`, `pipeline-routes.ts`, `cli.ts` (phần pipeline), contracts pipelines, web components pipelines.

## Mục tiêu

`ui-html`, `ui-react`, `ui-react-ds` không chạy được từ mọi ngả (UI, API, CLI, run-all), hiển thị rõ "tạm hold", nhưng **output cũ giữ nguyên mọi hành vi** (attribution, syncExclude, history, clear-on-rerun). Mở lại = xóa id khỏi 1 hằng.

## BẪY QUAN TRỌNG NHẤT (đã xác minh 13/08)

**KHÔNG rút id khỏi `WORKFLOW_DEFS.pipelineIds`** (`apps/daemon/src/pipelines.ts` ~L357-382). Attribution key theo `pipelineIds`:
- `stagesForOutput` (~L506-513) — rút ra là `prototype/`, `react/`, `react-ds/` cũ thành mồ côi, không sáng stage, không được clear khi re-run (`relClearedByRegen` ~L606).
- `isSyncExcluded` (~L676-683) — rút ra là `react/dist/` MẤT syncExclude, bắt đầu bị sync bậy.
- Push sẽ gắn `stage: 'misc'` (`server.ts` ~L14419-14431).

## Thiết kế

Theo khuôn "locked for maintenance" sẵn có `BAS_SOURCE_LOCKED` (`pipeline-routes.ts` ~L340-347: cờ + message + chặn fail-closed cả 2 route + card UI disabled kèm comment cách mở lại).

1. **Registry** — `apps/daemon/src/pipelines.ts`:
   - Thêm field `heldFromRun?: true` vào interface `PipelineDef` (~L20-126), kèm docblock giải thích + cách mở lại.
   - Khai báo hằng export `HELD_STAGE_IDS = ['ui-html', 'ui-react', 'ui-react-ds'] as const` (một chỗ duy nhất quyết định danh sách hold).
   - Set `heldFromRun: true` trên 3 def (`ui-html` ~L217, `ui-react` ~L240, `ui-react-ds` ~L264) — hoặc derive từ `HELD_STAGE_IDS` khi build defs, chọn cách ít lặp nhất.
   - `selectRunStages` (~L827-852): lọc bỏ stage held khỏi mọi kế hoạch run-all (cả manual lẫn automatic đều đi qua đây — xác minh lại bằng grep `selectRunStages(`).
   - `listPipelineStatus` (~L1165-1200): phát `held: true` trên view của stage held.
2. **Contracts** — `packages/contracts/src/api/pipelines.ts`: thêm `held?: boolean` vào `PipelineView` (~L143-245). Không đổi `Workflow`.
3. **Routes fail-closed** — `apps/daemon/src/pipeline-routes.ts`:
   - `POST /api/pipelines/:id/run` (~L1627): nếu def `heldFromRun` → 503 với code `STAGE_HELD` + message tiếng Việt ("Bước sinh code UI đang tạm khóa để tập trung bản web. Mở lại: xóa id khỏi HELD_STAGE_IDS trong pipelines.ts."). Đặt NGAY sau `getPipelineDef`, trước `computeActive` — mirror đúng vị trí khuôn BAS lock (~L1664-1666).
   - `POST /api/pipelines/run-all` (~L1433): nếu payload chỉ định tường minh stage held trong `stageIds`/terminal → 400 cùng code; nếu không chỉ định thì để `selectRunStages` tự loại (không lỗi).
   - `countWorkflowProgress` (~L268-271, hook lọc per-def đang dùng `isStageSkipped`): loại stage held khỏi mẫu số (9 → 6).
4. **CLI mirror** — `apps/daemon/src/cli.ts`: `od pipeline run` (~L7745) và `od pipeline run-all` (~L7837) in lỗi rõ ràng khi đụng stage held (khuôn BAS ~L7798-7801). `od pipeline list` đánh dấu `(held)`.
5. **Web** — hiển thị + chặn:
   - `apps/web/src/components/PipelinesView.tsx`: card UI-Spec (~L2240-2329) render disabled + badge "Tạm hold" khi mọi terminal held; nút Run (~L2316-2325); picker modal (~L2861-3063) disable option held; `willRunStageIdsForRunAll` (~L365-377) loại held.
   - `apps/web/src/components/pipelines/PipelineModals.tsx`: stage picker run-config (~L1708-1720) disable held; theo khuôn card BAS disabled (~L923-949) kèm comment cách mở lại.
   - Nếu `PipelineView.held` chưa tới được component nào đó thì derive từ API response, KHÔNG hard-code danh sách id ở web (tránh thêm một bản mirror mới).
   - i18n: thêm key badge/message hold cho 19 locale (quy tắc chung #8 trong plan.md).
6. **KHÔNG đụng**: `ui-fanout.ts` (dùng chung với `ux-review`), các route `react-build`/`react-demo`/`figma-capture`/`figma-audit` (để nguyên — chúng chỉ chạy khi có output, output mới sẽ không sinh ra nữa; nút UI của chúng gate theo `succeeded` sẵn rồi), `syncExclude`, exports (`pipeline-exports.ts` tự no-op khi thiếu output).

## Tests

Cập nhật test đang pin danh sách stage/hành vi run (xác minh từng file trước khi sửa):
- daemon: `tests/pipelines.test.ts` (~L42-44, ~L319-326), `docs-only-gate.test.ts`, `pipeline-status-selection.test.ts`, `pipeline-run-all-lean-gate.test.ts`, `run-all-clear-on-launch.test.ts`, `pipeline-exports.test.ts`.
- web: `preview-targets.test.ts`, `run-stages-picker.test.tsx`, `stage-run-uses-config.test.tsx`, `WorkspacePreviewMenu.test.tsx`, `pipelines-feature-workflows.test.tsx`, `router-pipelines.test.ts`.
- Viết MỚI (red-spec trước khi code, theo Bug follow-up workflow trong AGENTS.md):
  - daemon: run stage held → 503 `STAGE_HELD`; run-all không chỉ định → plan không chứa held; run-all chỉ định tường minh held → 400; `listPipelineStatus` phát `held:true`; progress denominator = 6; output `react/` cũ vẫn attribution đúng stage + vẫn syncExcluded.
  - web: card render disabled + badge khi held.

## Ngoài phạm vi

- Xóa bất kỳ code/skill/builder nào của 3 stage. Docker của builder để nguyên (WP7 xử lý khi mở lại).
- Sửa `WORKFLOW_DEFS.pipelineIds`, `syncExclude`, `stagesForOutput`.
- Đụng `server.ts` seam spawn (vùng của WP2/WP3).

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` xanh.
2. `pnpm --filter @open-design/daemon test -- pipelines` + các file test kể trên xanh; không tăng danh sách đỏ baseline.
3. Grep chứng minh: không còn đường nào spawn được 3 stage held (run route, run-all, CLI) ngoài việc sửa `HELD_STAGE_IDS`.
4. Report nêu rõ: các vị trí line thực tế đã sửa (so với mốc trong spec).
