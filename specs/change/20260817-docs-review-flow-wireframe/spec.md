# docs-review: flow trước comp · wireframe HTML mỗi màn · preview Flow màn hình

Ngày: 2026-08-17. Chủ repo chốt: (1) dr-flow chạy TRƯỚC dr-comp — phụ thuộc THẬT;
(2) dr-comp sinh wireframe HTML mỗi màn, chỉ là khối xám có TÊN component (không
cần giống mockup, vẽ từ CHỮ, không mở ảnh); (3) preview dr-flow có tab "Flow màn
hình" theo kiểu Tab Flow của UX-spec (node = màn hình có thumbnail wireframe).

## Kết quả cuối (nhìn từ người dùng)

- Workflow docs-review liệt kê theo thứ tự: Tài liệu → **Sơ đồ luồng màn hình** →
  **Màn hình → Component** → Review → Xác nhận. Run-all chạy đúng thứ tự đó;
  re-run dr-flow có cascade thì xoá comp + review.
- Sau khi chạy dr-comp, thư mục workflow có `wireframes/<SCREEN-KEY>.html`
  (mỗi màn một file, khối xám ghi tên component).
- Mở `flows/<FLOW-ID>.flowchart.json` → 3 tab: **Kịch bản** (như cũ, thêm
  thumbnail wireframe cạnh bước có màn) · **Flow màn hình** (MỚI — node là màn
  hình có thumbnail, hình thoi quyết định, oval kết thúc, node nav xám cho bước
  ngoài feature) · **Sơ đồ đầy đủ** (như cũ).

## Hợp đồng dùng chung giữa 3 WP (đóng băng — mọi WP làm đúng như đây)

### SCREEN-KEY (khoá màn dùng chung + tên file wireframe)

`SCREEN-KEY = <file-stem>__<mã màn>` — LUÔN LUÔN, kể cả feature chỉ có 1 trang.

- `<mã màn>`: nguyên văn từ heading tài liệu (`SCR-001`, `SCR-002.1`…; regex
  `[A-Za-z0-9][A-Za-z0-9.\-]*`).
- `<file-stem>`: tên file `.md` chứa heading màn đó, bỏ đuôi `.md`, KHÔNG đổi
  gì khác (vd `docs-feature/SDK-Vien-thong/…/4.1.2.1.1.-URD-Mua-sim-thuong.md`
  → `4.1.2.1.1.-URD-Mua-sim-thuong`; `docs/confluence/2.1.1-URD-Quan-ly-nhan-vien.md`
  → `2.1.1-URD-Quan-ly-nhan-vien`).
- Ví dụ: `2.1.1-URD-Quan-ly-nhan-vien__SCR-001`.
- Lý do luôn prefix: hai agent độc lập (dr-flow một lượt, dr-comp mỗi trang một
  lượt) không cần đếm số trang để thống nhất — chỉ cần nhìn tên file mình đang
  đọc. Mã màn được đánh lại từ đầu trong từng URD nên không prefix là đụng nhau.
- dr-comp: daemon đưa thẳng prefix vào kickoff (`path.posix.basename(pg.mdPath, '.md')`).
  dr-flow: skill nêu luật, agent tự ghép.
- Viewer hiện TÊN màn (từ `flows/index.json[].screens[].name`), không hiện key.

### Flowchart: field tuỳ chọn `screen` (WP1 ghi, WP3 đọc)

```json
{ "id": "n2", "type": "action", "label": "Nhập tên đăng nhập + mật khẩu", "screen": "2.1.1-URD-Quan-ly-nhan-vien__SCR-001" }
```
- Chỉ trên node `action` (và được phép trên `start`/`end` khi node đó là một màn).
- Giá trị = SCREEN-KEY. Không có màn (bước hệ thống, bước điều hướng ngoài
  feature) → BỎ field.
- `flows/index.json` mỗi phần tử thêm `screens: [{ "key": "2.1.1-URD-Quan-ly-nhan-vien__SCR-001", "name": "Danh sách Nhân viên" }]`
  theo thứ tự xuất hiện trong luồng (chỉ màn có trong luồng).
- Viewer cũ bỏ qua field lạ → tương thích ngược.

### Wireframe HTML (WP2 ghi, WP3 đọc): `wireframes/<SCREEN-KEY>.html`

- Nằm ở GỐC thư mục workflow, ngang `comp/` và `flows/` (không lồng trong `comp/`).
- File tự chứa: `<!doctype html>`, một `<style>` copy NGUYÊN VĂN
  `skills/ux-spec/assets/wireframe.css` + tối đa vài rule layout; không
  `<script>`, không `<link>`, không ảnh.
- `<body data-screen="<SCREEN-KEY>" data-layout="web|mobile">` — `web` mặc định
  (URD backoffice); `mobile` chỉ khi tài liệu nói rõ app di động.
- Mỗi phần tử trong `elements[]` của màn = MỘT block `.wf-component` theo đúng
  thứ tự tài liệu; chữ trong block = **tên component** khi `verdict = ok`
  (`data-comp="<anchor>"`, anchor = phần sau `#` của `rule_id`), ngược lại =
  `doc_type` nguyên văn + hậu tố ` ?` (không `data-comp`).
- Cấu trúc khung: chỉ nhóm theo cụm tài liệu (dòng phân nhóm "Khối …" → một
  `.wf-card` chứa các block con); không suy bố cục từ ảnh mockup. Không màu,
  không icon, không nội dung mẫu.
- `data-nav="<SCREEN-KEY đích>"` trên block là nút/link khi `flows/*.flowchart.json`
  có cạnh từ bước trên màn này sang bước ở màn khác (đọc `screen` của node) —
  không có flow thì bỏ.
- Màn overlay (popup/dialog): `data-overlay="dialog"` + `data-overlay-of="<SCREEN-KEY cơ sở>"`
  nếu tài liệu nói popup thuộc màn nào; thân file chỉ chứa nội dung popup.

## Phân WP

| WP | Việc | Ai | Ước |
|---|---|---|---|
| WP1 | Registry: đảo thứ tự + `dr-comp.dependsOn` thêm `dr-flow`; skill dr-flow: `screen`, `screens` trong index, SCREEN-KEY; test pipelines | orchestrator | 1 h |
| WP2 | Skill dr-comp: Bước 6 wireframe; daemon: `outputs` thêm `wireframes/`, kickoff nêu đường dẫn + luật SCREEN-KEY + đọc `flows/`; test | sub-agent | 3 h |
| WP3 | Web: parse `screen`; FlowchartPreview tab "Flow màn hình" (chuyển đổi flowchart→FlowDoc, tái dùng node của SpecFlowCanvas), thumbnail trong Kịch bản; test | sub-agent | 1 ngày |

WP2 và WP3 chạy song song sau khi spec này chốt; không WP nào sửa file của WP khác.

## Không làm

- Không tạo `flows/*.flow.json` thứ hai; không đổi `type` của flowchart.
- Không cho dr-comp mở mockup để vẽ wireframe; không sinh wireframe bằng daemon.
- Không đụng SpecPreview / FileViewer tab Flow của ux (chỉ tách phần render node
  dùng chung nếu cần, giữ hành vi ux y nguyên — test cũ phải xanh).
- Không đụng dr-review, dr-confirm.
