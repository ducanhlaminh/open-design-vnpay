# WP2 — dr-comp sinh `wireframes/<SCREEN-KEY>.html`

Đọc `spec.md` cùng thư mục trước (hợp đồng SCREEN-KEY + wireframe HTML là ĐÓNG BĂNG).

## Phạm vi file
- `skills/docs-component-audit/SKILL.md` — thêm "Bước 6 — wireframe màn hình" + hard rules.
- `apps/daemon/src/pipelines.ts` — `dr-comp` `outputs: ['comp/', 'wireframes/']`
  (KHÔNG đổi `dependsOn`/thứ tự — WP1 làm; nếu thấy WP1 đã sửa thì giữ nguyên).
- `apps/daemon/src/server.ts` — trong `runDocsComponentAuditFanout` (≈ dòng 15782–16260):
  kickoff mỗi trang thêm đoạn wireframe (xem dưới). KHÔNG đụng phần Figma
  Desktop / catalog / validate JSON hiện có.
- Test: `apps/daemon/tests/pipelines*.test.ts` (outputs) + test text kickoff nếu
  đã có test tương ứng; không bắt buộc test agent.

## Kickoff (thêm vào cuối chuỗi `kickoff` mỗi trang)
Nội dung phải nêu: (1) với MỖI màn trong `screens[]` ghi thêm
`wireframes/<SCREEN-KEY>.html`; (2) SCREEN-KEY = `<prefix>__<mã màn>` với
`<prefix>` daemon tính sẵn = `path.posix.basename(pg.mdPath, '.md')` và ghi
NGUYÊN VĂN vào kickoff (agent không tự suy); (3) CSS: daemon copy
`skills/ux-spec/assets/wireframe.css` (đọc từ thư mục skills của daemon — tìm
cách server.ts resolve đường dẫn skills hiện có, vd hàm dùng cho `catalog.md`/
skill assets) vào `<cwd>/wireframes/_wireframe.css` MỘT LẦN trước fan-out (sau
bước re-run clear), và bảo agent Read file đó rồi copy nguyên văn vào `<style>`;
file `_wireframe.css` không phải màn (viewer chỉ mở `<SCREEN-KEY>.html`); (4)
`data-nav`: đọc `flows/*.flowchart.json` nếu có (dr-flow chạy trước; node có
`screen` = SCREEN-KEY) — cạnh từ bước ở màn này sang bước ở màn khác ⇒ block
nút/link tương ứng mang `data-nav`; không có flow thì bỏ; (5) verdict ≠ ok →
block ghi `doc_type` + " ?" và không `data-comp`; (6) không mở ảnh để vẽ.

## SKILL.md — Bước 6
Viết bằng tiếng Việt, cùng giọng các bước hiện có. Bắt buộc có: mục đích (khối
xám có tên component để người review nhìn ra màn có gì theo CHỮ tài liệu),
hợp đồng file (chép từ spec), ví dụ HTML ngắn 1 màn với 3 block (1 ok có
`data-comp`, 1 not-in-catalog, 1 có `data-nav`), luật "không mở ảnh để vẽ",
"chỉ ghi vào `comp/` và `wireframes/`", "một màn một file, tên = SCREEN-KEY".

## Verify
- `pnpm --filter @open-design/contracts build` không cần (không đổi contracts).
- `cd apps/daemon && npx tsc --noEmit -p . && npx vitest run tests/pipelines*.test.ts`.
- Trả về: danh sách file sửa, đoạn kickoff mới (nguyên văn), kết quả test.
