# WP3 — nối vào `server.ts` + skill `docs-component-audit` (làm SAU WP1+WP2)

## Vùng sở hữu
- `apps/daemon/src/server.ts`
- `skills/docs-component-audit/SKILL.md`
- (tuỳ chọn) `apps/daemon/tests/*.test.ts` cho helper thuần tách ra.

## Việc
1. **Resolver phạm vi** — tách logic đang inline trong `runDocsComponentAuditFanout`
   (grep `let componentSource = pipelineApp?.docsReviewComponentSource`) thành
   `resolveDocsReviewComponentSourceForProject(projectId)`; dùng lại ở fanout và
   xây `resolveFigmaDesktopScope(projectId): Promise<FigmaDesktopScope|null>`:
   - mode ≠ `figma-links` → null.
   - `cwd` = projectRoot (+ wfDir của workflow docs-review — lấy từ pipeline def/wf mapping đang dùng cho dr-comp).
   - `files` = links của App; bổ sung `name`/`probeNodeId`/`probeName` từ
     `<cwd>/.figma-catalog/components.json` nếu có (file đầu tiên trong `components[]`).
2. **Register routes** ngay sau `registerFigmaConfigRoutes(app, …)`:
   `registerFigmaDesktopToolRoutes(app, { auth: authDeps, http: {...httpDeps, isLocalSameOrigin, resolvedPortRef}, figma: { desktop: new FigmaDesktopClient(), resolveScope: resolveFigmaDesktopScope } })`.
   Một instance `FigmaDesktopClient` dùng chung toàn daemon.
3. **Grant mở rộng cho run dr-comp**: `startChatRun` nhận thêm
   `toolGrantExtras?: { endpoints: readonly string[]; operations: readonly string[] }` trong chatBody;
   khi mint: `allowedEndpoints: [...CHAT_TOOL_ENDPOINTS, ...(extras?.endpoints ?? [])]`, tương tự operations.
   Chỉ `runOnePage` của dr-comp ở mode figma-links truyền `{ endpoints: FIGMA_TOOL_ENDPOINTS, operations: FIGMA_TOOL_OPERATIONS }`.
4. **Pre-warm + kickoff** (fanout, sau khi catalog xong, trước khi chạy trang):
   `desktop.probe()` → nếu ok: log dòng “Figma Desktop: sẵn sàng (đang mở “…”)” vào conversation
   chuẩn bị, `ensureActiveFile(files[0])` best-effort (lỗi chỉ log); kickoff thêm đoạn:
   > Bạn có thể mở component thật trong Figma Desktop để đối chiếu: `"$OD_NODE_BIN" "$OD_BIN" tools figma design-context --file <fileKey> --node <nodeId>` (nodeId/fileKey lấy trong ".figma-catalog/components.json"; thêm `screenshot` để có ảnh, `variable-defs` để xem token). Chỉ dùng khi map còn phân vân hoặc muốn xác nhận variant-mismatch; tối đa 8 lượt/trang; chỉ các file trong catalog mới được phép.
   Nếu probe không ok: kickoff nói “Figma Desktop không sẵn sàng (<detail>) — chấm theo catalog, đừng gọi tools figma”.
5. **Skill**: thêm “Bước 3b — mở component trong Figma Desktop” giữa Bước 3 và 4:
   khi nào gọi, lệnh, cách ghi bằng chứng vào `note` (schema JSON KHÔNG đổi — validator strict),
   giới hạn số lượt, hành xử khi tool trả lỗi (`FIGMA_DESKTOP_UNAVAILABLE`/`FIGMA_FILE_DENIED` → bỏ qua, không đoán).
6. Verify: typecheck daemon; test scoped: figma-*, tool-token, pipeline-* liên quan; chạy tay 1 lần
   với App có Link Figma + Figma Desktop mở (restart daemon trước).
