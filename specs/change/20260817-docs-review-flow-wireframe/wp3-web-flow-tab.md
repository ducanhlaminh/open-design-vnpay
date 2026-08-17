# WP3 — FlowchartPreview: tab "Flow màn hình" + thumbnail wireframe

Đọc `spec.md` cùng thư mục trước. Hai file dữ liệu bạn đọc: `flows/<FLOW-ID>.flowchart.json`
(node có thể có `screen: <SCREEN-KEY>`) và `wireframes/<SCREEN-KEY>.html` (ngang
`flows/`; có thể CHƯA tồn tại vì dr-comp chạy sau).

## Phạm vi file (chỉ web)
- `apps/web/src/components/FlowchartPreview.tsx` (+ `.module.css`)
- `apps/web/src/components/SpecFlowCanvas.tsx` — CHỈ để tách phần render node
  (ScreenFlowNode/DecisionFlowNode/EndFlowNode/NavFlowNode + layoutFlow +
  LabeledEdge) ra thành phần dùng chung nếu cần; hành vi ux giữ y nguyên.
- Mới (tuỳ chọn): `apps/web/src/components/flowchart-to-flow.ts` (hàm thuần).
- Tests: `apps/web/tests/components/FlowchartPreview.test.tsx`, thêm
  `flowchart-to-flow.test.ts`; test cũ `DesignSystemFlow.test.tsx`,
  `UseCaseReader.test.tsx`, `flow-usecases.test.ts` phải xanh.
- KHÔNG đụng FileViewer.tsx / SpecPreview.tsx / daemon / skills.

## Việc
1. `parseFlowchartDoc`: giữ `screen` (string, trim, bỏ nếu rỗng) trên `FlowchartNode`
   (`screen?: string`). File không có `screen` → như cũ.
2. Hàm thuần `flowchartToFlowDoc(doc): { flow: FlowDoc; screens: Array<{id; name}> }`:
   - Node có `screen`: các action LIÊN TIẾP cùng `screen` (nối nhau bằng cạnh)
     gộp thành MỘT node màn `id = SCREEN-KEY`; nhãn action bên trong gộp thành
     nhãn cạnh đi ra (nếu ≥2 nhãn thì nối bằng " → "). Cạnh vào/ra của cụm giữ
     nguyên nhãn gốc nếu có.
   - `decision` → `{kind:'decision', label}`; `end` → `{kind:'end', label}`;
     `start`/`action` không `screen` → `{kind:'nav', label}` (node xám ngoài
     feature); `start` CÓ `screen` → màn, và `entry` = SCREEN-KEY đó.
   - `entry` = màn đầu tiên gặp theo BFS từ start; không có màn nào → trả `flow`
     toàn nav/decision/end (canvas vẫn vẽ được) và `screens: []`.
   - Tên màn: từ `flows/index.json[].screens[].name` nếu FlowchartPreview đọc
     được index (cùng thư mục `flows/`), fallback = SCREEN-KEY.
   - Bảo toàn: mọi cạnh của flowchart đều xuất hiện (sau gộp) — không mất nhánh.
3. FlowchartPreview: tab thứ 3 **"Flow màn hình"** đặt GIỮA "Kịch bản" và "Sơ đồ
   đầy đủ" (thứ tự tab: Kịch bản · Flow màn hình · Sơ đồ đầy đủ). Render bằng
   canvas node dùng chung với ux (thumbnail wireframe qua `WireBlocks`, decision
   hình thoi, end oval, nav xám). Wireframe: với mỗi SCREEN-KEY, `fetchProjectFileText(projectId, <dir>/wireframes/<KEY>.html)`
   trong đó `<dir>` = phần trước `flows/` của `file.name`; null → node hiện
   "(chưa có wireframe — chạy bước Màn hình → Component)". Không cần danh sách file.
   `platforms` suy từ `data-layout` trong HTML (regex), mặc định web.
4. Tab "Kịch bản": truyền `renderStepExtra` cho `UseCaseReader` giống SpecFlowCanvas
   đang làm (bước có `screen` và có wireframe → thumbnail).
5. Empty/legacy: file không có `screen` nào → tab Flow màn hình vẫn hiện, node
   toàn nav/decision/end + dòng chú thích "Sơ đồ chưa gán màn hình — chạy lại bước
   Sơ đồ luồng màn hình bản mới để có thumbnail".

## Verify
- `cd apps/web && npx tsc --noEmit -p . && npx vitest run tests/components/FlowchartPreview.test.tsx tests/components/DesignSystemFlow.test.tsx tests/components/UseCaseReader.test.tsx tests/components/flow-usecases.test.ts tests/components/flowchart-to-flow.test.ts`
- Trả về: file sửa/thêm, mô tả thuật toán gộp (5 dòng), kết quả test.
