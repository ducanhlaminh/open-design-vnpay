# WP10 — Gỡ KGS, chỉ giữ media-service

Ước lượng: 1.5–2 ngày (nhiều file "mixed concern" cần tách thủ công, không thể xoá nguyên file). Phụ thuộc: **chạy SAU WP8 + WP9** (cùng đụng `server.ts`). Không chạy song song với WP3.

Vùng sở hữu: toàn bộ `apps/daemon/src/kg-sync/*`, `kg-sync-routes.ts`, `cli.ts` (nhóm lệnh `od kg *`), `apps/web/src/components/KgSyncButtons.tsx`, `apps/web/src/providers/kgSync.ts`, `providers/pullConflict.ts`, phần liên quan KGS trong `app-context.ts`/`app-context-routes.ts`, `design-system-sync.ts`/`design-system-sync-routes.ts`, `project-sync-routes.ts`, `ux-kb-sync.ts`, `pipelines.ts`/`pipeline-routes.ts`, `server.ts` (invocation `push_to_kgs.py` + wiring KG khác), `skills/customer-journey-spec/scripts/push_to_kgs.py`, `skills/ux-spec/` (script + docs liên quan KG push).

## Mục tiêu

Bỏ hoàn toàn KGS (Knowledge Graph Store) khỏi runtime — chỉ giữ media-service làm nơi lưu/sync file. Không mất chức năng chạy pipeline/sinh output nào (đã xác nhận: KGS không giữ dữ liệu độc quyền nào, output luôn ghi disk + sync media trước).

## Vấn đề (đã xác minh 13/08)

- KGS = graph mirror (Neo4j-projected qua outbox), namespace `graph/<appId>/<tenant>`. Media-service = file store (MinIO/S3), độc lập hoàn toàn — không cái nào wrap cái kia. Header comment `media-client.ts:1-3`: *"the hybrid counterpart to KgsClient: GRAPH stays in KGS, FILES move here"*.
- `KgsClient`'s file-store API (`uploadFile`/`listFiles`/`downloadFile`/`setFileStatus`) đã **dead hoàn toàn** — 0 call site ngoài định nghĩa, bị thay bằng `MediaClient` từ lâu.
- **0 pipeline stage nào set `convertToGraph: true`** (`grep convertToGraph apps/daemon/src/pipelines.ts` chỉ ra type declaration/comment) → nhánh push-graph qua Python (`push_to_kgs.py`) không bao giờ chạy trong thực tế.
- Mọi lời gọi KGS hiện tại đều best-effort/`.catch()`: `loadRemoteProjects` "one being down still lists the other" (`remote-registry.ts:125-142`); `ensureWorkspace` chỉ `console.warn` khi lỗi; graph-push "never fails the run"; pull KGS files ở stage-kickoff "continuing" khi lỗi. Hard-fail chỉ tồn tại ở chính route KG-sync (`kg-pull` → 502) — sẽ bị xoá cùng route.
- `wp6-installer.md:36` (đã viết từ trước) đã coi `KGS_URL/KGS_API_KEY` là optional installer config ("thiếu thì để trống + cảnh báo 'KG sync sẽ tắt'") — xác nhận đội đã coi KGS là tính năng phụ, không phải hard dependency.
- **KHÔNG PHẢI TOÀN BỘ FILE CÓ THỂ XOÁ THẲNG** — nhiều file trộn lẫn concern KGS-graph và media-service, cần đọc kỹ và tách đúng phần, không xoá nguyên file: `push-dest.ts`, `push-plan.ts`, `remote-registry.ts` (merge listing KGS+media, chỉ bỏ nửa KGS), `app-context.ts`/`app-context-routes.ts`, `design-system-sync.ts`/`design-system-sync-routes.ts`, `project-sync-routes.ts`, `ux-kb-sync.ts`, và có thể cả `feedback.ts`/`feedback-forms.ts`/`feedback-submissions.ts`/`docs-review-feedback.ts` (cần xác minh: reference KGS ở các file feedback chỉ là gắn project-id hay có gọi API thật).

## Thiết kế

1. **PURE DELETE** (xoá thẳng, xác nhận không còn ai import trước khi xoá):
   - `apps/daemon/src/kg-sync/kgs-client.ts`.
   - `apps/daemon/src/kg-sync/persistence.ts` (bảng `kg_nodes`/`kg_edges`/`kg_sync_logs` — kiểm tra file/migration này không chứa bảng nào khác đang dùng cho việc khác).
   - `apps/daemon/src/kg-sync-routes.ts` — xoá hẳn route (không giữ endpoint trả 410 Gone, quyết định là bỏ sạch).
   - `apps/web/src/components/KgSyncButtons.tsx`, `apps/web/src/providers/kgSync.ts`, `providers/pullConflict.ts`.
   - `cli.ts` — toàn bộ nhóm lệnh `od kg pull/push/pull-all/push-all/status/app-context/diff/remote list/remote delete` (help text + dispatch).
   - `skills/customer-journey-spec/scripts/push_to_kgs.py` — đã tự nhận "[LEGACY/DISABLED]" trong docstring, an toàn xoá.
2. **MIXED CONCERN — tách thủ công, không xoá cả file**: `kg-sync/push-dest.ts`, `push-plan.ts`, `remote-registry.ts` (bỏ nửa KGS, giữ nửa media-service), `app-context.ts`/`app-context-routes.ts`, `design-system-sync.ts`/`design-system-sync-routes.ts`, `project-sync-routes.ts`, `ux-kb-sync.ts`. Với mỗi file: đọc kỹ từng hàm, xác định hàm nào chỉ phục vụ KGS (xoá) vs media-service (giữ) vs cả hai (tách). Với `feedback.ts`/`feedback-forms.ts`/`feedback-submissions.ts`/`docs-review-feedback.ts`: xác minh reference KGS chỉ là tagging project-id (giữ, đổi tên biến nếu cần) hay gọi API KGS thật (xoá phần đó).
3. `server.ts` — xoá invocation `push_to_kgs.py` (ước lượng ~L14560-14571, verify lại bằng grep `push_to_kgs`), xoá wiring KG trong pipeline run/status code (rà theo grep `kgs`/`KGS_` case-insensitive toàn `server.ts`), xoá seed/boot-time KGS init nếu có.
4. `pipelines.ts`/`pipeline-routes.ts` — rà theo grep, xoá field/logic liên quan KGS trong định nghĩa stage/status (không đụng field không liên quan).
5. `skills/ux-spec/` — cập nhật `SKILL.md`/`references/schema.md`/`assets/example-ux-spec.json` bỏ nhắc "Push to KG button"/`od kg push`; xoá `scripts/push_to_kgs.py`. Đây là path **đang active** (khác `customer-journey-spec` đã legacy), sửa cẩn thận để không làm hỏng phần schema/example còn lại của skill.
6. Web: rà từng chỗ KGS-liên quan trong `DesignsTab.tsx`, `SpecPreview.tsx`, `PipelinesView.tsx`, `pipeline-preview/ThemeInspectorPanel.tsx`, `pipeline-preview/theme-lab-api.ts`, `pipelines/PipelineModals.tsx`, `pipelines/newProjectForm.ts` — sửa theo nội dung thực tế đọc được lúc thực thi (investigation không đọc sâu từng chỗ này).
7. `apps/web/src/components/KgToolCards.tsx`, `apps/web/src/runtime/register-kg-renderers.ts` — nếu WP9 chưa xử lý (theo report của WP9), xử lý ở đây: xác nhận đây có phải dead code (renderer cho `sm-mcp`, không có wiring daemon-side) rồi xoá.
8. `apps/daemon/src/runtimes/host-env.ts` (WP2) — dọn comment liệt kê `KGS_*` trong nhóm "chặn mặc định" nếu còn nhắc tới KGS (không bắt buộc, ưu tiên thấp — biến không tồn tại thì không leak được nữa dù comment có sửa hay không).

## Tests

Cập nhật/xoá: `identity-registry.test.ts`, `kg-sync-hidden-project-routes.test.ts`, `kg-sync-pull-conflict-routes.test.ts`, `pull-conflict.test.ts`, `push-dest.test.ts`, `push-plan.test.ts`, `remote-registry.test.ts`, cùng các tham chiếu KG rải rác trong `agent-sandbox.test.ts`, `design-system-sync-routes.test.ts`, `docs-flow-stage.test.ts`, `docs-only-gate.test.ts`, `pipeline-app-edit-routes.test.ts`, `pipeline-apps-routes.test.ts`, `pipeline-projects-workflows-route.test.ts`, `pipeline-run-all-lean-gate.test.ts`, `pipeline-run-config-route.test.ts`, `pipeline-stage-held.test.ts`, `pipeline-status-selection.test.ts`, `pipelines.test.ts`, `project-sync-routes.test.ts`, `pulled-project-local-delete.integration.test.ts`.

`media-client.test.ts` gần như chắc chắn **giữ nguyên không đổi** (media-service không bị ảnh hưởng) — chạy để xác nhận, không sửa trừ khi thật sự cần.

## Ngoài phạm vi

- Media-service (`MediaClient`, `media-client.ts`) — **giữ nguyên 100%**, đây chính là lý do tồn tại của WP10 (bỏ KGS, giữ media).
- `mcp-atlassian`/JIRA — WP8.
- 2 MCP server nội bộ/OD-as-MCP-server — WP9.

## Acceptance & Verify

1. `pnpm guard` + `pnpm typecheck` xanh; test liên quan xanh; không tăng đỏ baseline.
2. Grep chứng minh: không còn `KGS_URL`/`KGS_API_KEY`/`KgsClient`/import `kg-sync-routes` nào trong code thực thi.
3. Test/verify chứng minh media-service không bị ảnh hưởng: `media-client.test.ts` xanh + ít nhất 1 luồng thực tế (list/upload/download qua media) vẫn hoạt động.
4. Report ghi rõ: với từng file "mixed concern" đã tách — quyết định cụ thể giữ gì/bỏ gì, kèm bằng chứng (đoạn code trước/sau).
